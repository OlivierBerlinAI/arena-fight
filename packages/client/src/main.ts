/**
 * Boot + screen state machine:
 * name → lobby → room (waiting) → countdown → playing → ended → lobby …
 * Handles disconnects at every stage: error banner + back to the name screen.
 */
import './styles.css';
import { DEFAULT_BALANCE, PROTOCOL_VERSION } from '@mech-arena-fight/shared';
import type { MechTune, MechTuneKey, PlayerIndex, RoomInfo, ServerMessage } from '@mech-arena-fight/shared';
import { Net, isTestMode, serverUrl } from './net';
import { byId } from './dom';
import { gameHook, installGameHook, resetMatchHook } from './testhook';
import type { UiPhase } from './testhook';
import { NameScreen } from './screens/name';
import { LobbyScreen } from './screens/lobby';
import { RoomScreen } from './screens/room';
import { ResultScreen } from './screens/result';
import { MatchController } from './game/match';
import { SoundEngine } from './game/audio';
import { ControlSchemeToggle, getControlScheme, onControlSchemeChange } from './controls';
import type { ControlScheme } from './controls';
import { enterFullscreen, isFullscreen, onFullscreenChange, toggleFullscreen } from './fullscreen';
import { TuningOverlay } from './tuning-overlay';

installGameHook();

/**
 * The movement tuning overlay is a dev tool. It's on for local `npm run dev`
 * (Vite dev) and for a build made with VITE_ENABLE_TUNING=1, but compiled out
 * of a normal production build. The server independently rejects tuneMech
 * unless ALLOW_TUNING is set, so production play can't be re-tuned.
 */
const TUNING_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_TUNING === '1';

const SCREEN_IDS: Record<string, string> = {
  name: 'screen-name',
  lobby: 'screen-lobby',
  room: 'screen-room',
  playing: 'game-root',
};

class App {
  private net = new Net();
  private readonly sound = new SoundEngine();
  private phase: UiPhase = 'name';
  private match: MatchController | null = null;
  private playerIndex: PlayerIndex = 0;
  private tickRate = 100; // placeholder until matchStart carries the server's rate
  private displayName = '';
  private helloSent = false;
  private errorTimer: number | null = null;
  private lastRoom: RoomInfo | null = null;

  private readonly nameScreen = new NameScreen((name) => this.handleNameSubmit(name));
  private readonly lobbyScreen = new LobbyScreen(
    (roomName) => {
      this.sound.uiClick();
      this.net.send({ type: 'createRoom', roomName, preset: isTestMode() ? 'test' : undefined });
    },
    (roomId) => {
      this.sound.uiClick();
      this.net.send({ type: 'joinRoom', roomId });
    }
  );
  private readonly roomScreen = new RoomScreen(
    (ready) => {
      this.sound.uiClick();
      // Readying up is the user gesture that leads into the match — the only
      // moment we can legally request fullscreen for a touch player.
      if (ready && getControlScheme() === 'touch') enterFullscreen();
      this.net.send({ type: 'ready', ready });
    },
    () => {
      this.sound.uiClick();
      this.net.send({ type: 'leaveRoom' });
      this.toLobby();
    }
  );
  private readonly resultScreen = new ResultScreen(
    () => {
      this.sound.uiClick();
      this.net.send({ type: 'leaveRoom' });
      this.toLobby();
    },
    () => {
      this.sound.uiClick();
      if (getControlScheme() === 'touch') enterFullscreen();
      this.net.send({ type: 'ready', ready: true });
    }
  );

  private readonly countdownOverlay = byId('countdown-overlay');
  private readonly countdownNumber = byId('countdown-number');
  private readonly resultOverlay = byId('screen-result');
  private readonly errorBanner = byId('error-banner');
  private readonly controlsBtn = byId<HTMLButtonElement>('controls-btn');
  private readonly controlsOverlay = byId('controls-overlay');
  private readonly menuBtn = byId<HTMLButtonElement>('menu-btn');
  private readonly gameMenu = byId('game-menu');
  private readonly menuFullscreenBtn = byId<HTMLButtonElement>('menu-fullscreen');

  private readonly controlsToggle = new ControlSchemeToggle(byId('controls-scheme-toggle'));
  private readonly menuSchemeToggle = new ControlSchemeToggle(byId('menu-scheme-toggle'));

  private readonly tuningOverlay: TuningOverlay | null = TUNING_ENABLED
    ? new TuningOverlay({
        onMechChange: (key: MechTuneKey, value: number) => {
          this.net.send({ type: 'tuneMech', key, value });
          this.match?.applyMechTune({ [key]: value } as Partial<MechTune>); // optimistic; server echo confirms
        },
        getMechValue: (key: MechTuneKey) => this.match?.balance.mech[key] ?? DEFAULT_BALANCE.mech[key],
      })
    : null;

  constructor() {
    this.nameScreen.focus();
    this.wireControlsHelp();
    this.wireGameMenu();
    this.wireControlScheme();
    // F2 toggles the movement tuning overlay (non-modal — driving still works).
    if (this.tuningOverlay) {
      window.addEventListener('keydown', (e) => {
        if (e.code === 'F2') {
          e.preventDefault();
          this.tuningOverlay?.toggle();
        }
      });
    }
    // Begin the menu theme right away; it stays silent until the first gesture
    // unlocks the audio context, then fades in.
    this.updateMusic(this.phase);
  }

  /**
   * Keep the document in sync with the chosen scheme: a `touch-active` body
   * class rearranges the HUD for thumbs, and a live match swaps its controls.
   */
  private wireControlScheme(): void {
    const apply = (scheme: ControlScheme): void => {
      document.body.classList.toggle('touch-active', scheme === 'touch');
      this.match?.setControlScheme(scheme);
    };
    apply(getControlScheme());
    onControlSchemeChange(apply);
  }

  /** Top-right button → modal overlay listing the keyboard shortcuts. */
  private wireControlsHelp(): void {
    const overlay = this.controlsOverlay;
    const setOpen = (open: boolean): void => {
      this.sound.uiClick();
      overlay.classList.toggle('active', open);
    };
    this.controlsBtn.addEventListener('click', () => setOpen(true));
    byId('controls-close').addEventListener('click', () => setOpen(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) setOpen(false); // click the backdrop to dismiss
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && overlay.classList.contains('active')) setOpen(false);
    });
  }

  /**
   * In-match menu (HUD button, both schemes): switch control scheme, toggle
   * fullscreen (touch only), or quit the running match back to the lobby.
   */
  private wireGameMenu(): void {
    const menu = this.gameMenu;
    const setOpen = (open: boolean): void => {
      this.sound.uiClick();
      menu.classList.toggle('active', open);
    };
    this.menuBtn.addEventListener('click', () => setOpen(true));
    byId('menu-resume').addEventListener('click', () => setOpen(false));
    menu.addEventListener('click', (e) => {
      if (e.target === menu) setOpen(false); // backdrop dismiss
    });
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') return;
      // Esc closes the menu, or opens it as a pause menu while playing.
      if (menu.classList.contains('active')) setOpen(false);
      else if (this.phase === 'playing' && !this.controlsOverlay.classList.contains('active')) {
        setOpen(true);
      }
    });

    byId('menu-quit').addEventListener('click', () => {
      setOpen(false);
      this.net.send({ type: 'leaveRoom' });
      this.toLobby();
    });

    this.menuFullscreenBtn.addEventListener('click', () => {
      this.sound.uiClick();
      toggleFullscreen();
    });
    const syncFullscreenLabel = (): void => {
      this.menuFullscreenBtn.textContent = isFullscreen() ? '⛶ EXIT FULLSCREEN' : '⛶ ENTER FULLSCREEN';
    };
    syncFullscreenLabel();
    onFullscreenChange(syncFullscreenLabel);
  }

  // ------------------------------------------------------------- phases

  private setPhase(phase: UiPhase): void {
    this.phase = phase;
    gameHook.phase = phase;

    // Base screens: countdown keeps the previous base screen behind it;
    // 'ended' keeps the game screen visible behind the result overlay.
    for (const [key, id] of Object.entries(SCREEN_IDS)) {
      const active =
        key === phase ||
        (phase === 'ended' && key === 'playing') ||
        (phase === 'countdown' && key === (this.match ? 'playing' : 'room'));
      byId(id).classList.toggle('active', active);
    }
    this.countdownOverlay.classList.toggle('active', phase === 'countdown');
    this.resultOverlay.classList.toggle('active', phase === 'ended');

    // The CONTROLS help button is in-match only — hidden on the name, lobby,
    // waiting-room and countdown screens.
    this.controlsBtn.classList.toggle('screen-hidden', phase !== 'playing' && phase !== 'ended');

    this.updateMusic(phase);
  }

  /** Pick the soundtrack for a screen: menu theme in the lobby, battle theme in-match. */
  private updateMusic(phase: UiPhase): void {
    switch (phase) {
      case 'name':
      case 'lobby':
      case 'room':
        this.sound.playMusic('lobby');
        break;
      case 'playing':
        this.sound.playMusic('game');
        break;
      case 'ended':
        // Silence under the result overlay so the victory/defeat jingle lands.
        this.sound.stopMusic();
        break;
      case 'countdown':
        // Keep whatever is already playing through the 3·2·1.
        break;
      default:
        break;
    }
  }

  private toLobby(): void {
    this.destroyMatch();
    resetMatchHook();
    this.lastRoom = null;
    this.setPhase('lobby');
  }

  private destroyMatch(): void {
    if (this.match) {
      this.match.dispose();
      this.match = null;
    }
  }

  // ------------------------------------------------------------- network

  private handleNameSubmit(name: string): void {
    this.net.dispose(); // drop any half-open previous connection
    this.displayName = name;
    this.helloSent = false;
    this.lobbyScreen.setSelfName(name);

    this.net = new Net();
    this.net.onOpen = () => {
      this.net.send({ type: 'hello', name: this.displayName });
      this.helloSent = true;
    };
    this.net.onMessage = (msg) => this.handleMessage(msg);
    this.net.onRtt = (rtt) => {
      gameHook.ping = rtt;
    };
    this.net.onClose = (reason) => this.handleDisconnect(reason);
    this.net.connect(serverUrl());
  }

  private handleDisconnect(reason: string): void {
    this.destroyMatch();
    resetMatchHook();
    gameHook.ping = null;
    this.lastRoom = null;
    this.setPhase('name');
    this.nameScreen.setStatus('');
    this.showError(reason);
  }

  private showError(text: string): void {
    this.errorBanner.textContent = text;
    this.errorBanner.classList.add('visible');
    if (this.errorTimer !== null) window.clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => {
      this.errorBanner.classList.remove('visible');
    }, 6000);
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.showError('Server protocol version mismatch — refresh the page.');
        }
        break;

      case 'lobbyState':
        this.lobbyScreen.update(msg.rooms);
        if (this.phase === 'name' && this.helloSent) {
          this.nameScreen.setStatus('');
          this.setPhase('lobby');
        }
        break;

      case 'roomState':
        this.lastRoom = msg.room;
        this.roomScreen.update(msg.room);
        if (this.phase === 'lobby') {
          this.setPhase('room');
        } else if (this.phase === 'countdown' && msg.room.status === 'waiting') {
          // countdown aborted (someone unreadied/left)
          this.setPhase(this.match ? 'ended' : 'room');
        } else if (this.phase === 'ended' && msg.room.players.length < 2) {
          // Opponent left while we sat on the result screen — a rematch can
          // no longer happen; say so instead of waiting forever.
          this.resultScreen.opponentLeft();
        }
        break;

      case 'countdown':
        this.countdownNumber.textContent = String(msg.seconds);
        this.sound.countdownTick(msg.seconds);
        if (this.phase !== 'countdown') this.setPhase('countdown');
        break;

      case 'matchStart':
        this.destroyMatch();
        resetMatchHook();
        this.playerIndex = msg.playerIndex;
        this.tickRate = msg.tickRate;
        this.setPhase('playing');
        this.sound.resume();
        this.sound.matchStart();
        try {
          this.match = new MatchController(
            this.net,
            {
              seed: msg.seed,
              playerIndex: msg.playerIndex,
              preset: msg.preset,
              tickRate: msg.tickRate,
              tickMs: msg.tickMs,
            },
            this.sound
          );
        } catch (err) {
          // e.g. WebGL unavailable — fail loudly instead of a dead screen
          console.error('[client] failed to start match renderer', err);
          this.showError('Could not start the 3D renderer (WebGL unavailable?).');
          this.net.send({ type: 'leaveRoom' });
          this.toLobby();
        }
        break;

      case 'snapshot':
        this.match?.onSnapshot(msg.snap, msg.events);
        break;

      case 'mechTuned':
        // Debug tuning echo: keep prediction + the overlay in sync with the sim.
        this.match?.applyMechTune(msg.mech);
        this.tuningOverlay?.syncMech();
        break;

      case 'matchEnd':
        this.match?.onMatchEnd(msg.winner);
        if (msg.winner === this.playerIndex) this.sound.victory();
        else this.sound.defeat();
        gameHook.winner = msg.winner;
        this.resultScreen.show(
          {
            winner: msg.winner,
            reason: msg.reason,
            durationTicks: msg.durationTicks,
            stats: msg.stats,
          },
          this.playerIndex,
          this.tickRate
        );
        this.setPhase('ended');
        break;

      case 'error':
        // already logged by Net; surface room-level failures briefly
        if (msg.code === 'roomUnavailable' || msg.code === 'noSuchRoom') {
          this.showError(msg.message);
        }
        break;

      default:
        break;
    }
  }
}

new App();

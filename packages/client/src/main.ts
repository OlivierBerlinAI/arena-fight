/**
 * Boot + screen state machine:
 * name → lobby → room (waiting) → countdown → playing → ended → lobby …
 * Handles disconnects at every stage: error banner + back to the name screen.
 */
import './styles.css';
import { PROTOCOL_VERSION } from '@precinct/shared';
import type { PlayerIndex, RoomInfo, ServerMessage } from '@precinct/shared';
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

installGameHook();

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
  private tickRate = 30;
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
      this.net.send({ type: 'ready', ready: true });
    }
  );

  private readonly countdownOverlay = byId('countdown-overlay');
  private readonly countdownNumber = byId('countdown-number');
  private readonly resultOverlay = byId('screen-result');
  private readonly errorBanner = byId('error-banner');

  constructor() {
    this.nameScreen.focus();
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

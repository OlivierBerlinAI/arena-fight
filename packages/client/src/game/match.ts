/**
 * MatchController: owns everything that lives only during a match — the
 * three.js renderer, entity views, snapshot interpolation, input, chase
 * camera, HUD, minimap and debug overlay — and keeps window.__game fresh.
 */
import { getBalance } from '@precinct/shared';
import type {
  Balance,
  BalancePresetName,
  PlayerIndex,
  SimEvent,
  Snapshot,
  UnitType,
} from '@precinct/shared';
import type { Net } from '../net';
import { gameHook } from '../testhook';
import type { GameEntityInfo } from '../testhook';
import { GameRenderer } from './renderer';
import { EntityManager } from './entities';
import { SnapshotBuffer } from './interpolation';
import { LocalMechPredictor } from './prediction';
import { InputManager } from './input';
import { ChaseCamera } from './camera';
import { Hud } from './hud';
import { Minimap } from './minimap';
import { DebugOverlay } from './debug';
import { SoundEngine } from './audio';
import { byId } from '../dom';

export interface MatchConfig {
  seed: number;
  playerIndex: PlayerIndex;
  preset: BalancePresetName;
  tickRate: number;
  tickMs: number;
}

export class MatchController {
  readonly balance: Balance;
  private readonly renderer: GameRenderer;
  private readonly entities: EntityManager;
  private readonly buffer: SnapshotBuffer;
  private readonly input: InputManager;
  private readonly chase: ChaseCamera;
  private readonly hud: Hud;
  private readonly minimap: Minimap;
  private readonly debug = new DebugOverlay();
  private readonly predictor = new LocalMechPredictor();

  private raf = 0;
  private lastFrame = performance.now();
  private fps = 60;
  private disposed = false;
  private ended = false;

  private readonly musicBtn = byId<HTMLButtonElement>('hud-audio-music');
  private readonly sfxBtn = byId<HTMLButtonElement>('hud-audio-sfx');
  private readonly onMusicClick = (): void => {
    this.sound.toggleMusicMuted();
    this.updateAudioButtons();
  };
  private readonly onSfxClick = (): void => {
    this.sound.toggleSfxMuted();
    this.updateAudioButtons();
  };

  constructor(
    private readonly net: Net,
    readonly cfg: MatchConfig,
    private readonly sound: SoundEngine
  ) {
    this.balance = getBalance(cfg.preset, cfg.tickRate);
    this.buffer = new SnapshotBuffer(cfg.tickMs);
    this.renderer = new GameRenderer(byId('canvas-root'), this.balance);
    this.entities = new EntityManager(this.renderer.scene, this.balance);
    this.chase = new ChaseCamera(this.renderer.camera);
    this.minimap = new Minimap(byId<HTMLCanvasElement>('minimap'), cfg.playerIndex);

    const sendBuild = (unit: UnitType): void => {
      this.net.send({ type: 'build', unit });
    };
    this.hud = new Hud(this.balance, cfg.playerIndex, cfg.tickRate, sendBuild);
    this.input = new InputManager({
      onBuild: sendBuild,
      onToggleDebug: () => this.debug.toggle(),
      onTransform: (mode) => this.sound.transform(mode === 'hover'),
      sendInput: (input) => this.net.send({ type: 'input', ...input }),
    });
    this.input.setPlaying(true);

    this.musicBtn.addEventListener('click', this.onMusicClick);
    this.sfxBtn.addEventListener('click', this.onSfxClick);
    this.updateAudioButtons();

    gameHook.playerIndex = cfg.playerIndex;
    gameHook.winner = null;

    this.lastFrame = performance.now();
    const loop = (): void => {
      if (this.disposed) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // ----------------------------------------------------------- net inbound

  onSnapshot(snap: Snapshot, events: SimEvent[]): void {
    const now = performance.now();
    this.buffer.push(snap, now);
    this.entities.onRawSnapshot(snap, events);
    this.hud.addEvents(events);
    this.sound.onMatchEvents(events, this.cfg.playerIndex);
    this.sound.onProjectiles(snap.projectiles);

    // test hook (serialized fresh from this snapshot)
    gameHook.tick = snap.tick;
    gameHook.credits = snap.players[this.cfg.playerIndex]?.credits ?? null;
    gameHook.winner = snap.winner >= 0 ? snap.winner : null;
    gameHook.entities = serializeEntities(snap);
  }

  onMatchEnd(winner: PlayerIndex): void {
    this.ended = true;
    this.input.setPlaying(false);
    gameHook.winner = winner;
  }

  // ----------------------------------------------------------- frame loop

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (dt > 0) this.fps = this.fps * 0.9 + (1 / dt) * 0.1;

    const view = this.buffer.sample(now);
    const latest = this.buffer.latest;
    if (view && latest) {
      const timeSec = now / 1000;
      const me = this.cfg.playerIndex;
      const mechSnap = latest.mechs[me];

      // Local mech: client-side prediction instead of the delayed interpolation
      // view. Advance the input heading first (aim projects from the predicted
      // spot), then re-derive the present pose from the freshest snapshot + the
      // current input and render that — so steering feels immediate.
      if (mechSnap) {
        const aim = this.predictor.initialized
          ? { x: this.predictor.x, z: this.predictor.z }
          : { x: mechSnap.x, z: mechSnap.z };
        this.input.update({ x: aim.x, z: aim.z, yaw: mechSnap.yaw, alive: mechSnap.alive }, dt);
        const aheadMs = (this.buffer.snapshotAge(now) ?? 0) + (this.net.rtt ?? 0) / 2;
        const myMech = this.predictor.update(
          mechSnap,
          latest.turrets,
          aheadMs,
          this.input.currentInput(),
          this.input.heading,
          this.balance,
          dt
        );
        view.mechs[me] = myMech;
        this.chase.update(myMech, dt);
      }

      this.entities.syncView(view, timeSec, dt);
      this.renderer.updateTurrets(view.turrets, timeSec);

      const player = latest.players[me];
      if (player && mechSnap) {
        this.hud.update(latest.tick, mechSnap, player, this.net.rtt);
      }

      // Minimap "view" wedge follows the fixed chase-camera direction, not the
      // mouse — the camera no longer rotates with aim.
      this.minimap.draw(latest, this.chase.groundYaw);

      gameHook.snapshotAge = this.buffer.snapshotAge(now);
      this.debug.update({
        fps: this.fps,
        ping: this.net.rtt,
        serverTick: latest.tick,
        renderTick: view.renderTick,
        snapshotAgeMs: gameHook.snapshotAge,
        units: latest.units.length,
        projectiles: latest.projectiles.length,
        turrets: latest.turrets.length,
        mech: mechSnap
          ? {
              x: mechSnap.x,
              z: mechSnap.z,
              vx: mechSnap.vx,
              vz: mechSnap.vz,
              hp: mechSnap.hp,
              heat: mechSnap.heat,
              alive: mechSnap.alive,
            }
          : null,
        credits: player?.credits ?? null,
      });
    }

    this.renderer.render();
  }

  private updateAudioButtons(): void {
    this.setAudioBtn(this.musicBtn, 'MUSIC', 'Music', this.sound.isMusicMuted);
    this.setAudioBtn(this.sfxBtn, 'SFX', 'Effects', this.sound.isSfxMuted);
  }

  private setAudioBtn(btn: HTMLButtonElement, label: string, name: string, muted: boolean): void {
    btn.textContent = `${muted ? '♪̸' : '♪'} ${label}`;
    btn.classList.toggle('muted', muted);
    btn.title = `${name} ${muted ? 'off' : 'on'}`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.musicBtn.removeEventListener('click', this.onMusicClick);
    this.sfxBtn.removeEventListener('click', this.onSfxClick);
    this.input.dispose();
    this.hud.dispose();
    this.entities.dispose();
    this.renderer.dispose();
    this.minimap.clear();
    this.debug.hide();
  }
}

function serializeEntities(snap: Snapshot): GameEntityInfo[] {
  const out: GameEntityInfo[] = [];
  for (const m of snap.mechs) {
    out.push({ kind: 'mech', id: `mech-${m.player}`, owner: m.player, x: m.x, z: m.z, hp: m.hp, alive: m.alive, mode: m.mode, yaw: m.yaw });
  }
  for (const u of snap.units) {
    out.push({ kind: 'unit', id: `unit-${u.id}`, owner: u.owner, x: u.x, z: u.z, hp: u.hp, type: u.type, alive: true });
  }
  for (const t of snap.turrets) {
    out.push({ kind: 'turret', id: `turret-${t.id}`, owner: t.owner, x: t.x, z: t.z, hp: t.hp, alive: t.alive });
  }
  for (const p of snap.projectiles) {
    out.push({ kind: 'projectile', id: `proj-${p.id}`, owner: p.owner, x: p.x, z: p.z, type: p.kind });
  }
  return out;
}

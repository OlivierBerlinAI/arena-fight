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
import { InputManager } from './input';
import { ChaseCamera } from './camera';
import { Hud } from './hud';
import { Minimap } from './minimap';
import { DebugOverlay } from './debug';
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

  private raf = 0;
  private lastFrame = performance.now();
  private fps = 60;
  private disposed = false;
  private ended = false;

  constructor(
    private readonly net: Net,
    readonly cfg: MatchConfig
  ) {
    this.balance = getBalance(cfg.preset);
    this.buffer = new SnapshotBuffer(cfg.tickMs);
    this.renderer = new GameRenderer(byId('canvas-root'), this.balance);
    this.entities = new EntityManager(this.renderer.scene, this.balance);
    this.chase = new ChaseCamera(this.renderer.camera, cfg.playerIndex);
    this.minimap = new Minimap(byId<HTMLCanvasElement>('minimap'), cfg.playerIndex);

    const sendBuild = (unit: UnitType): void => {
      this.net.send({ type: 'build', unit });
    };
    this.hud = new Hud(this.balance, cfg.playerIndex, cfg.tickRate, sendBuild);
    this.input = new InputManager(this.renderer.canvas, this.renderer.camera, {
      onBuild: sendBuild,
      onToggleDebug: () => this.debug.toggle(),
      sendInput: (input) => this.net.send({ type: 'input', ...input }),
    });
    this.input.setPlaying(true);

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
      this.entities.syncView(view, timeSec, dt);
      this.renderer.updateTurrets(view.turrets, timeSec);

      const myMech = view.mechs[this.cfg.playerIndex];
      if (myMech) {
        this.chase.update(myMech, dt);
        this.input.updateAim({ x: myMech.x + Math.cos(myMech.yaw) * 8, z: myMech.z + Math.sin(myMech.yaw) * 8 });
      }

      const player = latest.players[this.cfg.playerIndex];
      const mechSnap = latest.mechs[this.cfg.playerIndex];
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
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
    out.push({ kind: 'mech', id: `mech-${m.player}`, owner: m.player, x: m.x, z: m.z, hp: m.hp, alive: m.alive, mode: m.mode });
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

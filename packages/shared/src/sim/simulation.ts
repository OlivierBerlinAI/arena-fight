import { distSq, pointInAABB } from '../math.js';
import { DEFAULT_BALANCE } from '../balance.js';
import type { Balance } from '../balance.js';
import { GAME_MAP } from '../map.js';
import { PRNG } from '../prng.js';
import { createInitialState } from './state.js';
import type { PlayerInput, SimCommand, SimEvent, SimState, PlayerIndex } from './state.js';
import { handleBuildCommand, stepEconomy, stepFactories, aliveUnitCount } from './economy.js';
import { stepMechs } from './mech.js';
import { stepUnits } from './units.js';
import { stepTurrets } from './turrets.js';
import { stepProjectiles } from './projectiles.js';
import { separateMovers } from './collision.js';
import type { Snapshot } from '../protocol.js';

export interface SimOptions {
  seed: number;
  balance?: Balance;
}

/**
 * The authoritative, deterministic match simulation. Pure with respect to the
 * outside world: no timers, no sockets, no Date.now(), all randomness from a
 * seeded PRNG. Advance it externally via tick(); same seed + same inputs ⇒
 * identical state (verify with hash()).
 */
export class GameSimulation {
  readonly balance: Balance;
  readonly state: SimState;
  private readonly rng: PRNG;

  constructor(opts: SimOptions) {
    this.balance = opts.balance ?? DEFAULT_BALANCE;
    this.state = createInitialState(opts.seed, this.balance);
    this.rng = new PRNG(opts.seed);
  }

  /**
   * Advance one tick. `inputs` holds the most recent input per player (null =
   * no input yet); `commands` are this tick's validated build commands in
   * arrival order. Returns the events the tick produced.
   */
  tick(
    inputs: readonly (PlayerInput | null)[] = [null, null],
    commands: readonly SimCommand[] = []
  ): SimEvent[] {
    const state = this.state;
    if (state.phase === 'ended') return [];

    const events: SimEvent[] = [];
    for (const cmd of commands) {
      handleBuildCommand(state, this.balance, cmd, events);
    }
    stepEconomy(state, this.balance);
    stepFactories(state, this.balance, events);
    stepMechs(state, this.balance, inputs, this.rng, events);
    stepUnits(state, this.balance);
    separateMovers(state, this.balance);
    stepTurrets(state, this.balance, events);
    stepProjectiles(state, this.balance, events);
    this.checkWin(events);
    this.warnBaseAttacks(events);

    state.tick += 1;
    state.rngState = this.rng.getState();
    return events;
  }

  /**
   * Win condition: one of your robots stands on the opponent's core pad.
   * If both players breach on the same tick, the earlier-built robot (lower
   * entity id, array order) wins — deterministic, not player-index biased.
   */
  private checkWin(events: SimEvent[]): void {
    const state = this.state;
    for (const unit of state.units) {
      const pad = GAME_MAP.bases[1 - unit.owner].corePad;
      if (distSq(unit.pos, pad) <= pad.radius * pad.radius) {
        state.phase = 'ended';
        state.winner = unit.owner;
        events.push({ type: 'matchEnd', winner: unit.owner, byUnitId: unit.id });
        return;
      }
    }
  }

  private warnBaseAttacks(events: SimEvent[]): void {
    const state = this.state;
    const warnInterval = 5 * this.balance.tickRate;
    for (const player of state.players) {
      const zone = GAME_MAP.bases[player.index].zone;
      const intruder = state.units.some((u) => u.owner !== player.index && pointInAABB(u.pos, zone));
      if (intruder && state.tick - player.lastBaseAttackWarnTick >= warnInterval) {
        player.lastBaseAttackWarnTick = state.tick;
        events.push({ type: 'baseUnderAttack', player: player.index });
      }
    }
  }

  /** Wire-format snapshot for clients. */
  snapshot(): Snapshot {
    const state = this.state;
    const b = this.balance;
    return {
      tick: state.tick,
      phase: state.phase,
      winner: state.winner,
      mechs: state.mechs.map((m) => ({
        player: m.player,
        x: round3(m.pos.x),
        z: round3(m.pos.z),
        vx: round3(m.vel.x),
        vz: round3(m.vel.z),
        yaw: round3(m.yaw),
        mode: m.mode,
        hp: Math.ceil(m.hp),
        alive: m.alive,
        heat: Math.round(m.heat),
        overheated: state.tick < m.overheatedUntilTick,
        rocketAmmo: m.rocketAmmo,
        reloading: m.reloadEndTick > 0,
        reloadFrac:
          m.reloadEndTick > 0
            ? round3(1 - Math.max(0, m.reloadEndTick - state.tick) / b.rocket.reloadTicks)
            : 0,
        shielded: state.tick < m.protectedUntilTick,
        respawnInTicks: m.alive ? 0 : Math.max(0, m.respawnAtTick - state.tick),
      })),
      players: state.players.map((p) => ({
        credits: Math.floor(p.credits + 1e-6),
        queue: p.queue.map((q, i) => ({
          unit: q.unit,
          progress: i === 0 ? round3(1 - q.ticksLeft / q.totalTicks) : 0,
        })),
        unitsAlive: aliveUnitCount(state, p.index),
        unitCap: b.unitCap,
        stats: { ...p.stats },
      })),
      units: state.units.map((u) => ({
        id: u.id,
        owner: u.owner,
        type: u.type,
        x: round3(u.pos.x),
        z: round3(u.pos.z),
        yaw: round3(u.yaw),
        turretYaw: round3(u.turretYaw),
        hp: Math.ceil(u.hp),
      })),
      turrets: state.turrets.map((t) => ({
        id: t.id,
        x: t.pos.x,
        z: t.pos.z,
        owner: t.owner,
        hp: Math.ceil(t.hp),
        alive: t.alive,
        capOwner: t.capOwner,
        capProgress: round3(t.capProgress / b.turret.captureTicks),
        headYaw: round3(t.headYaw),
        respawnInTicks: t.alive ? 0 : Math.max(0, t.respawnAtTick - state.tick),
      })),
      projectiles: state.projectiles.map((p) => ({
        id: p.id,
        kind: p.kind,
        owner: p.owner,
        x: round3(p.pos.x),
        z: round3(p.pos.z),
        vx: round3(p.vel.x),
        vz: round3(p.vel.z),
      })),
    };
  }

  /** FNV-1a hash of the full state — for determinism tests. */
  hash(): string {
    const json = JSON.stringify(this.state);
    let h = 0x811c9dc5;
    for (let i = 0; i < json.length; i++) {
      h ^= json.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  get winner(): PlayerIndex | -1 {
    return this.state.winner;
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

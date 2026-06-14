/**
 * Shared utilities for the headless simulation test suite. Tests drive the
 * deterministic GameSimulation purely through inputs/commands; teleporting an
 * entity by writing state.*.pos directly is allowed where it keeps a test
 * focused (e.g. placing a mech next to a turret pad).
 */
import { GAME_MAP, GameSimulation, NULL_INPUT, circleIntersectsAABB } from '@mech-arena-fight/shared';
import type {
  PlayerIndex,
  PlayerInput,
  ProjectileKind,
  ProjectileState,
  SimCommand,
  SimEvent,
  UnitState,
  UnitType,
  Vec2,
} from '@mech-arena-fight/shared';

export type InputPair = readonly [PlayerInput | null, PlayerInput | null];
export type InputSource = InputPair | ((tick: number) => InputPair);
export type CommandSource = readonly SimCommand[] | ((tick: number) => readonly SimCommand[]);

export const IDLE: InputPair = [null, null];

export function makeInput(partial: Partial<PlayerInput> = {}): PlayerInput {
  return { ...NULL_INPUT, ...partial };
}

export function buildCmd(player: PlayerIndex, unit: UnitType = 'hovertank'): SimCommand {
  return { type: 'build', player, unit };
}

function inputsAt(src: InputSource, tick: number): InputPair {
  return typeof src === 'function' ? src(tick) : src;
}

function commandsAt(src: CommandSource, tick: number): readonly SimCommand[] {
  return typeof src === 'function' ? src(tick) : src;
}

/** Advance n ticks, collecting every event. */
export function tickN(
  sim: GameSimulation,
  n: number,
  inputs: InputSource = IDLE,
  commands: CommandSource = []
): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    const t = sim.state.tick;
    events.push(...sim.tick(inputsAt(inputs, t), commandsAt(commands, t)));
  }
  return events;
}

/**
 * Advance until an event of the given type is produced. Returns the event,
 * all events seen, and the number of tick() calls performed (the matching
 * tick included). Throws when maxTicks elapse without a match.
 */
export function runUntilEvent<T extends SimEvent['type']>(
  sim: GameSimulation,
  type: T,
  maxTicks: number,
  inputs: InputSource = IDLE,
  commands: CommandSource = []
): { event: Extract<SimEvent, { type: T }>; events: SimEvent[]; ticks: number } {
  const events: SimEvent[] = [];
  for (let i = 1; i <= maxTicks; i++) {
    const t = sim.state.tick;
    const tickEvents = sim.tick(inputsAt(inputs, t), commandsAt(commands, t));
    events.push(...tickEvents);
    const hit = tickEvents.find((e) => e.type === type);
    if (hit) return { event: hit as Extract<SimEvent, { type: T }>, events, ticks: i };
  }
  throw new Error(`runUntilEvent: no '${type}' event within ${maxTicks} ticks`);
}

/** Place a mech somewhere and zero its velocity (test setup shortcut). */
export function teleportMech(sim: GameSimulation, player: PlayerIndex, pos: Vec2): void {
  const mech = sim.state.mechs[player];
  mech.pos = { ...pos };
  mech.vel = { x: 0, z: 0 };
}

/** Feed real movement inputs each tick until the mech is within tol of target. */
export function driveToward(
  sim: GameSimulation,
  player: PlayerIndex,
  target: Vec2,
  opts: { tol?: number; maxTicks?: number } = {}
): number {
  const tol = opts.tol ?? 1;
  const maxTicks = opts.maxTicks ?? 600;
  for (let i = 0; i < maxTicks; i++) {
    const mech = sim.state.mechs[player];
    const dx = target.x - mech.pos.x;
    const dz = target.z - mech.pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= tol) return i;
    const input = makeInput({ mx: dx / d, mz: dz / d, aimX: target.x, aimZ: target.z });
    const pair: [PlayerInput | null, PlayerInput | null] = player === 0 ? [input, null] : [null, input];
    sim.tick(pair);
  }
  const mech = sim.state.mechs[player];
  throw new Error(
    `driveToward: mech ${player} did not reach (${target.x}, ${target.z}) within ${maxTicks} ticks ` +
      `(at ${mech.pos.x.toFixed(2)}, ${mech.pos.z.toFixed(2)})`
  );
}

/**
 * Returns a function that, when called (once per tick), yields the projectiles
 * newly spawned since the previous call, optionally filtered by kind.
 */
export function projectileTracker(
  sim: GameSimulation,
  kind?: ProjectileKind
): () => ProjectileState[] {
  const seen = new Set<number>(sim.state.projectiles.map((p) => p.id));
  return () => {
    const fresh: ProjectileState[] = [];
    for (const p of sim.state.projectiles) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (!kind || p.kind === kind) fresh.push(p);
    }
    return fresh;
  };
}

/**
 * Issue real build commands (respecting the queue limit) and tick until
 * `count` units of the given type have deployed for the player. Returns the
 * live UnitState objects.
 */
export function deployUnits(
  sim: GameSimulation,
  player: PlayerIndex,
  type: UnitType,
  count: number
): UnitState[] {
  const ids: number[] = [];
  let queued = 0;
  const buildTicks = sim.balance.units[type].buildTicks;
  const maxTicks = (count + 1) * (buildTicks + 10) + 100;
  for (let i = 0; i < maxTicks && ids.length < count; i++) {
    const cmds: SimCommand[] = [];
    if (queued < count && sim.state.players[player].queue.length < sim.balance.queueMax) {
      cmds.push(buildCmd(player, type));
      queued++;
    }
    for (const e of sim.tick(IDLE, cmds)) {
      if (e.type === 'unitDeployed' && e.player === player) ids.push(e.unitId);
      if (e.type === 'buildRejected' && e.player === player) queued--;
    }
  }
  if (ids.length < count) {
    throw new Error(`deployUnits: only ${ids.length}/${count} units deployed`);
  }
  return ids.map((id) => {
    const unit = sim.state.units.find((u) => u.id === id);
    if (!unit) throw new Error(`deployUnits: unit ${id} no longer exists`);
    return unit;
  });
}

/** True when the circle overlaps any wall AABB (shrunk by a tiny epsilon). */
export function penetratesAnyWall(pos: Vec2, radius: number): boolean {
  const r = radius - 1e-6;
  return GAME_MAP.walls.some((w) => circleIntersectsAABB(pos, r, w));
}

/** Throws when any entity has a non-finite position / velocity / hp. */
export function expectAllFinite(sim: GameSimulation): void {
  const bad: string[] = [];
  const check = (label: string, v: number): void => {
    if (!Number.isFinite(v)) bad.push(`${label}=${v}`);
  };
  sim.state.mechs.forEach((m, i) => {
    check(`mech${i}.pos.x`, m.pos.x);
    check(`mech${i}.pos.z`, m.pos.z);
    check(`mech${i}.vel.x`, m.vel.x);
    check(`mech${i}.vel.z`, m.vel.z);
    check(`mech${i}.hp`, m.hp);
    check(`mech${i}.heat`, m.heat);
  });
  for (const u of sim.state.units) {
    check(`unit${u.id}.pos.x`, u.pos.x);
    check(`unit${u.id}.pos.z`, u.pos.z);
    check(`unit${u.id}.hp`, u.hp);
  }
  for (const p of sim.state.projectiles) {
    check(`proj${p.id}.pos.x`, p.pos.x);
    check(`proj${p.id}.pos.z`, p.pos.z);
  }
  for (const t of sim.state.turrets) {
    check(`turret${t.id}.hp`, t.hp);
    check(`turret${t.id}.capProgress`, t.capProgress);
  }
  if (bad.length > 0) {
    throw new Error(`non-finite simulation values: ${bad.join(', ')}`);
  }
}

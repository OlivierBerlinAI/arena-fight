import type { Balance, UnitType } from '../balance.js';
import { GAME_MAP } from '../map.js';
import type { SimCommand, SimEvent, SimState, UnitState, PlayerIndex } from './state.js';

/** Passive income plus one extra credit/s per owned turret. */
export function stepEconomy(state: SimState, balance: Balance): void {
  for (const player of state.players) {
    let turrets = 0;
    for (const t of state.turrets) {
      if (t.alive && t.owner === player.index) turrets++;
    }
    const perSecond =
      balance.economy.passivePerSecond + turrets * balance.economy.perTurretPerSecond;
    player.credits += perSecond / balance.tickRate;
  }
}

export function aliveUnitCount(state: SimState, player: PlayerIndex): number {
  let n = 0;
  for (const u of state.units) {
    if (u.owner === player) n++;
  }
  return n;
}

/**
 * Validate and enqueue a build command. The server never trusts the client:
 * affordability, queue length and the unit cap are all enforced here.
 */
export function handleBuildCommand(
  state: SimState,
  balance: Balance,
  cmd: SimCommand,
  events: SimEvent[]
): void {
  const player = state.players[cmd.player];
  const unit = balance.units[cmd.unit];
  const reject = (reason: 'credits' | 'queueFull' | 'unitCap' | 'matchOver'): void => {
    events.push({ type: 'buildRejected', player: cmd.player, unit: cmd.unit, reason });
  };
  if (state.phase !== 'playing') return reject('matchOver');
  if (player.queue.length >= balance.queueMax) return reject('queueFull');
  if (aliveUnitCount(state, cmd.player) + player.queue.length >= balance.unitCap) {
    return reject('unitCap');
  }
  // Epsilon absorbs float drift from per-tick income accumulation (1/30 is not
  // binary-representable; without this a 200-cost unit is rejected on the
  // exact tick it nominally becomes affordable).
  if (player.credits + 1e-6 < unit.cost) return reject('credits');
  player.credits -= unit.cost;
  player.queue.push({ unit: cmd.unit, ticksLeft: unit.buildTicks, totalTicks: unit.buildTicks });
  events.push({ type: 'unitQueued', player: cmd.player, unit: cmd.unit });
}

/** Advance build queues; the head item ticks down and spawns when done. */
export function stepFactories(state: SimState, balance: Balance, events: SimEvent[]): void {
  for (const player of state.players) {
    const head = player.queue[0];
    if (!head) continue;
    head.ticksLeft -= 1;
    if (head.ticksLeft > 0) continue;
    player.queue.shift();
    spawnUnit(state, balance, player.index, head.unit, events);
  }
}

function spawnUnit(
  state: SimState,
  balance: Balance,
  owner: PlayerIndex,
  type: UnitType,
  events: SimEvent[]
): void {
  const player = state.players[owner];
  const base = GAME_MAP.bases[owner];
  const id = state.nextEntityId++;
  // Small deterministic offset so same-tick spawns do not stack exactly.
  const jitter = ((id % 3) - 1) * 0.6;
  const unit: UnitState = {
    id,
    owner,
    type,
    pos: { x: base.unitSpawn.x + jitter, z: base.unitSpawn.z + jitter * 0.5 },
    yaw: owner === 0 ? Math.PI / 4 : -Math.PI * 0.75,
    hp: balance.units[type].hp,
    lane: player.nextLane,
    waypointIndex: 0,
    fireReadyAtTick: 0,
    targetKey: null,
  };
  player.nextLane = player.nextLane === 'left' ? 'right' : 'left';
  state.units.push(unit);
  player.stats.robotsBuilt += 1;
  events.push({ type: 'unitDeployed', player: owner, unit: type, unitId: id });
}

import { segmentAABBHit, segmentCircleHit, distSq } from '../math.js';
import type { Balance } from '../balance.js';
import { GAME_MAP } from '../map.js';
import type {
  Ownership,
  PlayerIndex,
  ProjectileState,
  SimEvent,
  SimState,
  TurretState,
  UnitState,
} from './state.js';

type HitTarget =
  | { kind: 'wall' }
  | { kind: 'mech'; player: PlayerIndex }
  | { kind: 'unit'; unit: UnitState }
  | { kind: 'turret'; turret: TurretState };

/**
 * Move every projectile one tick along its segment, find the earliest hit
 * among walls / enemy mechs / enemy units / non-friendly turrets, apply
 * direct + splash damage, and expire splash projectiles at their fuse point.
 */
export function stepProjectiles(state: SimState, balance: Balance, events: SimEvent[]): void {
  const DT = 1 / balance.tickRate;
  const deadUnits = new Set<number>();
  const survivors: ProjectileState[] = [];

  for (const proj of state.projectiles) {
    const from = { ...proj.pos };
    const to = { x: proj.pos.x + proj.vel.x * DT, z: proj.pos.z + proj.vel.z * DT };

    let bestT = Infinity;
    let target: HitTarget | null = null;

    for (const w of GAME_MAP.walls) {
      const t = segmentAABBHit(from, to, w);
      if (t !== null && t < bestT) {
        bestT = t;
        target = { kind: 'wall' };
      }
    }
    for (const mech of state.mechs) {
      if (mech.player === proj.owner || !mech.alive) continue;
      if (state.tick < mech.protectedUntilTick) continue; // shots pass through protected mechs
      const t = segmentCircleHit(from, to, mech.pos, balance.mech.radius);
      if (t !== null && t < bestT) {
        bestT = t;
        target = { kind: 'mech', player: mech.player };
      }
    }
    for (const unit of state.units) {
      if (unit.owner === proj.owner || deadUnits.has(unit.id)) continue;
      const t = segmentCircleHit(from, to, unit.pos, balance.units[unit.type].radius);
      if (t !== null && t < bestT) {
        bestT = t;
        target = { kind: 'unit', unit };
      }
    }
    for (const turret of state.turrets) {
      if (!turret.alive || turret.owner === proj.owner) continue;
      const t = segmentCircleHit(from, to, turret.pos, balance.turret.radius);
      if (t !== null && t < bestT) {
        bestT = t;
        target = { kind: 'turret', turret };
      }
    }

    if (target) {
      const hx = from.x + (to.x - from.x) * bestT;
      const hz = from.z + (to.z - from.z) * bestT;
      if (target.kind === 'mech') {
        damageMech(state, balance, target.player, proj.damage, proj.owner, events);
      } else if (target.kind === 'unit') {
        damageUnit(state, balance, target.unit, proj.damage, proj.owner, events, deadUnits);
      } else if (target.kind === 'turret') {
        damageTurret(state, balance, target.turret, proj.damage, proj.owner, events);
      }
      if (proj.splashRadius > 0) {
        splash(state, balance, { x: hx, z: hz }, proj, events, deadUnits, target);
      }
      continue; // projectile consumed
    }

    proj.pos = to;
    if (state.tick >= proj.diesAtTick) {
      // Splash projectiles (rockets, heavy cannon) detonate at their fuse point.
      if (proj.splashRadius > 0) {
        splash(state, balance, proj.pos, proj, events, deadUnits, null);
      }
      continue;
    }
    survivors.push(proj);
  }

  state.projectiles = survivors;
  if (deadUnits.size > 0) {
    state.units = state.units.filter((u) => !deadUnits.has(u.id));
  }
}

/** Splash damage with linear falloff; the directly-hit entity is excluded. */
function splash(
  state: SimState,
  balance: Balance,
  center: { x: number; z: number },
  proj: ProjectileState,
  events: SimEvent[],
  deadUnits: Set<number>,
  directHit: HitTarget | null
): void {
  const r = proj.splashRadius;
  const r2 = r * r;
  const minFactor = balance.rocket.splashMinFactor;
  const falloff = (d2: number): number => {
    const d = Math.sqrt(d2);
    return Math.max(minFactor, 1 - d / r);
  };

  for (const mech of state.mechs) {
    if (mech.player === proj.owner || !mech.alive) continue;
    if (directHit?.kind === 'mech' && directHit.player === mech.player) continue;
    const d2 = distSq(center, mech.pos);
    if (d2 <= r2) {
      damageMech(state, balance, mech.player, proj.damage * falloff(d2), proj.owner, events);
    }
  }
  for (const unit of state.units) {
    if (unit.owner === proj.owner || deadUnits.has(unit.id)) continue;
    if (directHit?.kind === 'unit' && directHit.unit.id === unit.id) continue;
    const d2 = distSq(center, unit.pos);
    if (d2 <= r2) {
      damageUnit(state, balance, unit, proj.damage * falloff(d2), proj.owner, events, deadUnits);
    }
  }
  for (const turret of state.turrets) {
    if (!turret.alive || turret.owner === proj.owner) continue;
    if (directHit?.kind === 'turret' && directHit.turret.id === turret.id) continue;
    const d2 = distSq(center, turret.pos);
    if (d2 <= r2) {
      damageTurret(state, balance, turret, proj.damage * falloff(d2), proj.owner, events);
    }
  }
}

function damageMech(
  state: SimState,
  balance: Balance,
  player: PlayerIndex,
  amount: number,
  by: Ownership,
  events: SimEvent[]
): void {
  const mech = state.mechs[player];
  if (!mech.alive || state.tick < mech.protectedUntilTick) return;
  mech.hp -= amount;
  if (mech.hp > 0) return;
  mech.hp = 0;
  mech.alive = false;
  mech.respawnAtTick = state.tick + balance.mech.respawnTicks;
  state.players[player].stats.deaths += 1;
  if (by !== -1 && by !== player) {
    state.players[by].stats.kills += 1;
    state.players[by].credits += balance.economy.killBounty.mech;
  }
  events.push({ type: 'mechKilled', victim: player, byPlayer: by });
}

function damageUnit(
  state: SimState,
  balance: Balance,
  unit: UnitState,
  amount: number,
  by: Ownership,
  events: SimEvent[],
  deadUnits: Set<number>
): void {
  if (deadUnits.has(unit.id)) return;
  unit.hp -= amount;
  if (unit.hp > 0) return;
  unit.hp = 0;
  deadUnits.add(unit.id);
  state.players[unit.owner].stats.robotsLost += 1;
  if (by !== -1 && by !== unit.owner) {
    state.players[by].stats.robotsDestroyed += 1;
    state.players[by].credits += balance.economy.killBounty[unit.type];
  }
  events.push({
    type: 'unitDestroyed',
    unitId: unit.id,
    owner: unit.owner,
    unit: unit.type,
    byPlayer: by,
  });
}

function damageTurret(
  state: SimState,
  balance: Balance,
  turret: TurretState,
  amount: number,
  by: Ownership,
  events: SimEvent[]
): void {
  // Neutral turrets are indestructible — they can only be captured, not shot down.
  if (!turret.alive || turret.owner === -1) return;
  turret.hp -= amount;
  if (turret.hp > 0) return;
  const previousOwner = turret.owner;
  turret.hp = 0;
  turret.alive = false;
  turret.owner = -1;
  turret.capOwner = -1;
  turret.capProgress = 0;
  turret.respawnAtTick = state.tick + balance.turret.respawnTicks;
  events.push({
    type: 'turretDestroyed',
    turretId: turret.id,
    byPlayer: by as PlayerIndex,
    previousOwner,
  });
}

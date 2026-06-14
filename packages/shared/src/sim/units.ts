import { angleDelta, distSq, rotateToward } from '../math.js';
import type { Balance } from '../balance.js';
import { laneWaypoints } from '../map.js';
import { collideWithStatics } from './collision.js';
import { spawnProjectile } from './mech.js';
import type { SimState, UnitState } from './state.js';

const WAYPOINT_REACHED_DIST = 1.5;
/** Fire once the target is within this angle of the unit's facing (radians). */
const AIM_TOLERANCE_RAD = 0.12;
/** Drive only once facing within this angle of the travel direction (radians). */
const MOVE_ALIGN_RAD = 0.5;

type Target =
  | { kind: 'unit'; key: string; pos: { x: number; z: number } }
  | { kind: 'turret'; key: string; pos: { x: number; z: number } }
  | { kind: 'mech'; key: string; pos: { x: number; z: number } };

/**
 * Deliberately simple robot AI: follow the lane waypoints; when an enemy is in
 * range, stop and shoot it (priority: enemy robots > enemy turrets > enemy
 * mech); resume when it is gone. Reaching the enemy core pad ends the match
 * (checked in the simulation's win step).
 */
export function stepUnits(state: SimState, balance: Balance): void {
  const DT = 1 / balance.tickRate;
  for (const unit of state.units) {
    const ub = balance.units[unit.type];
    const target = acquireTarget(unit, state, ub.range);
    if (target) {
      unit.targetKey = target.key;
      const dx = target.pos.x - unit.pos.x;
      const dz = target.pos.z - unit.pos.z;
      // Rotate to face the target before firing instead of snapping onto it.
      const desired = Math.atan2(dz, dx);
      unit.yaw = rotateToward(unit.yaw, desired, ub.turnRate * DT);
      const aligned = Math.abs(angleDelta(unit.yaw, desired)) <= AIM_TOLERANCE_RAD;
      if (aligned && state.tick >= unit.fireReadyAtTick) {
        spawnProjectile(state, {
          owner: unit.owner,
          kind: unit.type === 'dreadnought' ? 'unitHeavy' : 'unitLight',
          yaw: unit.yaw,
          origin: unit,
          speed: ub.projectileSpeed,
          damage: ub.damage,
          splashRadius: ub.splashRadius,
          ttlTicks: Math.max(
            2,
            Math.ceil((Math.sqrt(dx * dx + dz * dz) / ub.projectileSpeed) * balance.tickRate) + 2
          ),
          muzzleOffset: ub.radius + 0.3,
        });
        unit.fireReadyAtTick = state.tick + ub.fireIntervalTicks;
      }
      continue; // engaged units stop moving
    }

    unit.targetKey = null;
    const waypoints = laneWaypoints(unit.owner, unit.lane);
    const wp = waypoints[Math.min(unit.waypointIndex, waypoints.length - 1)];
    const dx = wp.x - unit.pos.x;
    const dz = wp.z - unit.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < WAYPOINT_REACHED_DIST && unit.waypointIndex < waypoints.length - 1) {
      unit.waypointIndex += 1;
      continue;
    }
    if (d > 1e-6) {
      // Turn back toward the travel direction; only drive once roughly facing it
      // (so a unit that turned to shoot first swings back before moving on).
      const desired = Math.atan2(dz, dx);
      unit.yaw = rotateToward(unit.yaw, desired, ub.turnRate * DT);
      if (Math.abs(angleDelta(unit.yaw, desired)) <= MOVE_ALIGN_RAD) {
        const step = Math.min(ub.speed * DT, d);
        unit.pos.x += (dx / d) * step;
        unit.pos.z += (dz / d) * step;
      }
    }
    collideWithStatics(unit.pos, ub.radius, state, balance);
  }
}

function acquireTarget(unit: UnitState, state: SimState, range: number): Target | null {
  const r2 = range * range;
  const enemy = (1 - unit.owner) as 0 | 1;

  let best: Target | null = null;
  let bestD = Infinity;
  for (const other of state.units) {
    if (other.owner !== enemy) continue;
    const d = distSq(unit.pos, other.pos);
    if (d <= r2 && d < bestD) {
      bestD = d;
      best = { kind: 'unit', key: `unit:${other.id}`, pos: other.pos };
    }
  }
  if (best) return best;

  for (const t of state.turrets) {
    if (!t.alive || t.owner !== enemy) continue;
    const d = distSq(unit.pos, t.pos);
    if (d <= r2 && d < bestD) {
      bestD = d;
      best = { kind: 'turret', key: `turret:${t.id}`, pos: t.pos };
    }
  }
  if (best) return best;

  const mech = state.mechs[enemy];
  if (mech.alive && state.tick >= mech.protectedUntilTick) {
    const d = distSq(unit.pos, mech.pos);
    if (d <= r2) {
      return { kind: 'mech', key: `mech:${enemy}`, pos: mech.pos };
    }
  }
  return null;
}

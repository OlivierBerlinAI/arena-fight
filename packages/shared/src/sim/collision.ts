import { resolveCircleAABB, clamp } from '../math.js';
import type { Vec2 } from '../math.js';
import { GAME_MAP } from '../map.js';
import type { SimState } from './state.js';
import type { Balance } from '../balance.js';

const ARENA_LIMIT = GAME_MAP.size / 2 - 0.01;

/**
 * Push a body circle out of all static geometry: walls, factory buildings,
 * live turret towers, plus a hard clamp to the arena. Mutates and returns pos.
 */
export function collideWithStatics(pos: Vec2, radius: number, state: SimState, balance: Balance): Vec2 {
  // Two passes so corner cases (pushed out of one wall into another) settle.
  for (let pass = 0; pass < 2; pass++) {
    for (const w of GAME_MAP.walls) {
      const fixed = resolveCircleAABB(pos, radius, w);
      if (fixed) {
        pos.x = fixed.x;
        pos.z = fixed.z;
      }
    }
    for (const t of state.turrets) {
      if (!t.alive) continue;
      const minDist = radius + balance.turret.radius;
      const dx = pos.x - t.pos.x;
      const dz = pos.z - t.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < minDist * minDist && d2 > 1e-12) {
        const d = Math.sqrt(d2);
        const push = (minDist - d) / d;
        pos.x += dx * push;
        pos.z += dz * push;
      } else if (d2 <= 1e-12) {
        pos.x = t.pos.x + minDist;
      }
    }
  }
  pos.x = clamp(pos.x, -ARENA_LIMIT, ARENA_LIMIT);
  pos.z = clamp(pos.z, -ARENA_LIMIT, ARENA_LIMIT);
  return pos;
}

interface Mover {
  pos: Vec2;
  radius: number;
  /** Mechs yield to robots so the player cannot shove tanks around. */
  isMech: boolean;
}

/**
 * Pairwise separation of all moving bodies (mechs + robots) so they do not
 * stack inside each other, then a final static pass. Deterministic order.
 *
 * Mech-vs-mech and robot-vs-robot pairs split the overlap evenly. A mech
 * touching a robot, however, is shoved out the full distance on its own — the
 * robot stays put, so a player's mech cannot push tanks around.
 */
export function separateMovers(state: SimState, balance: Balance): void {
  const movers: Mover[] = [];
  for (const m of state.mechs) {
    if (m.alive) movers.push({ pos: m.pos, radius: balance.mech.radius, isMech: true });
  }
  for (const u of state.units) {
    movers.push({ pos: u.pos, radius: balance.units[u.type].radius, isMech: false });
  }
  for (let i = 0; i < movers.length; i++) {
    for (let j = i + 1; j < movers.length; j++) {
      const a = movers[i];
      const b = movers[j];
      const minDist = a.radius + b.radius;
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minDist * minDist) continue;
      let nx: number;
      let nz: number;
      let overlap: number;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        nx = dx / d;
        nz = dz / d;
        overlap = minDist - d;
      } else {
        // Perfectly stacked (e.g. same-tick factory spawns): split on a fixed axis.
        nx = 1;
        nz = 0;
        overlap = minDist;
      }
      // Even split by default; a mech meeting a robot eats the whole push so
      // the robot (tank) holds its ground.
      let wA = 0.5;
      let wB = 0.5;
      if (a.isMech !== b.isMech) {
        wA = a.isMech ? 1 : 0;
        wB = b.isMech ? 1 : 0;
      }
      a.pos.x -= nx * overlap * wA;
      a.pos.z -= nz * overlap * wA;
      b.pos.x += nx * overlap * wB;
      b.pos.z += nz * overlap * wB;
    }
  }
  for (const m of movers) {
    collideWithStatics(m.pos, m.radius, state, balance);
  }
}

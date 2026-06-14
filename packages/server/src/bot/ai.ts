/**
 * Reactive opponent AI. Pure decision helpers over a Snapshot: pick a movement
 * input (thrust + aim + fire) and decide whether to build a unit. The bot worker
 * drives the cadence; difficulty scales reaction speed, build tempo, aim error
 * and aggression. No randomness in the SIM — the bot is just an input source, so
 * Math.random here is fine (like a human's imperfect play).
 */
import { GAME_MAP, LANE_IDS, laneWaypoints, segmentAABBHit } from '@mech-arena-fight/shared';
import type {
  AABB,
  Balance,
  BotDifficulty,
  PlayerIndex,
  PlayerInput,
  Snapshot,
  UnitType,
} from '@mech-arena-fight/shared';

export interface BotTuning {
  /** how often the bot recomputes its movement input (ms) — lower = sharper */
  decideEveryMs: number;
  /** how often it tries to build a unit (ms) */
  buildEveryMs: number;
  /** aim error in radians (0 = perfect) */
  aimError: number;
  /** engage targets within this fraction of the nominal weapon range */
  reactRange: number;
  /** 0 = defensive/turtle, 1 = all-out push */
  aggression: number;
  /** whether it bothers capturing turrets for economy */
  capturesTurrets: boolean;
}

export const BOT_TUNING: Record<BotDifficulty, BotTuning> = {
  easy: { decideEveryMs: 450, buildEveryMs: 3500, aimError: 0.28, reactRange: 0.7, aggression: 0.3, capturesTurrets: false },
  normal: { decideEveryMs: 180, buildEveryMs: 1700, aimError: 0.09, reactRange: 0.9, aggression: 0.6, capturesTurrets: true },
  hard: { decideEveryMs: 70, buildEveryMs: 800, aimError: 0.0, reactRange: 1.0, aggression: 0.95, capturesTurrets: true },
};

/** Nominal mech weapon engage range (gatling/laser have no hard range; pick a feel). */
const ENGAGE_RANGE = 18;
const ARRIVE_DIST = 1.6;

interface Pt {
  x: number;
  z: number;
}
const d2 = (a: Pt, b: Pt): number => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

// --- Navigation ------------------------------------------------------------
// The bot's mech spawns in a walled compound with only a narrow diagonal gate,
// so it cannot just beeline toward a far goal — it would grind into a base wall.
// The map ships lane waypoints (own gate → edge → enemy core) that the robots
// already follow; the mech reuses them with a simple line-of-sight shortcut:
// drive straight to the goal when nothing blocks, otherwise aim at the lane
// waypoint that is both reachable and closest to the goal ("string pulling").

/** A bit less than the mech radius (1.1) so a mech resting on a wall still reads
 * as "outside" the padded box, while paths keep clear of corners. */
const PATH_PAD = 0.8;

function padded(w: AABB): AABB {
  return { minX: w.minX - PATH_PAD, minZ: w.minZ - PATH_PAD, maxX: w.maxX + PATH_PAD, maxZ: w.maxZ + PATH_PAD };
}

/** True if a straight drive from a→b would clip any collision wall. */
function pathBlocked(a: Pt, b: Pt): boolean {
  for (const w of GAME_MAP.walls) {
    const box = padded(w);
    // If we already overlap this wall (jammed), ignore it — driving on can only
    // help us escape, and it must not veto every candidate point.
    if (a.x >= box.minX && a.x <= box.maxX && a.z >= box.minZ && a.z <= box.maxZ) continue;
    if (segmentAABBHit(a, b, box) !== null) return true;
  }
  return false;
}

/** Immediate steering point toward `goal`, routed around walls via lane waypoints. */
function navTo(mech: Pt, goal: Pt, me: PlayerIndex): Pt {
  if (!pathBlocked(mech, goal)) return goal;
  // Reachable lane waypoint that gets us closest to the goal.
  let best: Pt | null = null;
  let bestScore = Infinity;
  for (const lane of LANE_IDS) {
    for (const wp of laneWaypoints(me, lane)) {
      if (pathBlocked(mech, wp)) continue;
      const score = d2(wp, goal);
      if (score < bestScore) {
        bestScore = score;
        best = { x: wp.x, z: wp.z };
      }
    }
  }
  if (best) return best;
  // Nothing in sight (wedged): head for the nearest waypoint to get back on a lane.
  let near: Pt = goal;
  let nearD = Infinity;
  for (const lane of LANE_IDS) {
    for (const wp of laneWaypoints(me, lane)) {
      const dd = d2(wp, mech);
      if (dd < nearD) {
        nearD = dd;
        near = { x: wp.x, z: wp.z };
      }
    }
  }
  return near;
}

const idleInput = (): PlayerInput => ({ mx: 0, mz: 0, aimX: 0, aimZ: 0, fire: false, alt: false, mode: 'walker' });

/** Pick the nearest capturable turret (neutral or enemy-owned) worth driving to. */
function turretGoal(snap: Snapshot, me: PlayerIndex, mech: Pt, tuning: BotTuning): Pt | null {
  if (!tuning.capturesTurrets) return null;
  let best: Pt | null = null;
  let bestD = 40 * 40; // only bother with reasonably near turrets
  for (const t of snap.turrets) {
    if (!t.alive || t.owner === me) continue; // already ours
    const dd = d2(mech, t);
    if (dd < bestD) {
      bestD = dd;
      best = { x: t.x, z: t.z };
    }
  }
  return best;
}

/** Movement + aim + fire for this decision tick. */
export function chooseInput(snap: Snapshot, me: PlayerIndex, _balance: Balance, tuning: BotTuning): PlayerInput {
  const mech = snap.mechs.find((m) => m.player === me);
  if (!mech || !mech.alive) return idleInput();
  const enemy = (1 - me) as PlayerIndex;

  // Nearest live enemy thing to shoot at.
  let target: Pt | null = null;
  let targetD2 = Infinity;
  const consider = (p: Pt): void => {
    const dd = d2(mech, p);
    if (dd < targetD2) {
      targetD2 = dd;
      target = { x: p.x, z: p.z };
    }
  };
  for (const u of snap.units) if (u.owner === enemy) consider(u);
  const enemyMech = snap.mechs.find((m) => m.player === enemy && m.alive && !m.shielded);
  if (enemyMech) consider(enemyMech);

  const engage = ENGAGE_RANGE * tuning.reactRange;
  const inRange = target !== null && targetD2 <= engage * engage;

  // Decide where to drive.
  const myCore = GAME_MAP.bases[me].corePad;
  const enemyCore = GAME_MAP.bases[enemy].corePad;
  const threat = snap.units.find((u) => u.owner === enemy && d2(u, myCore) < 26 * 26);
  let goal: Pt;
  if (threat && tuning.aggression < 0.7) {
    goal = { x: threat.x, z: threat.z }; // fall back and intercept
  } else if (target && targetD2 < engage * engage * 0.5) {
    goal = target; // already close enough — hold/strafe near the target
  } else {
    goal = turretGoal(snap, me, mech, tuning) ?? (target ?? { x: enemyCore.x, z: enemyCore.z });
  }

  // Route the straight-line goal around walls (out of our base, along a lane).
  const steer = navTo(mech, goal, me);
  let mx = steer.x - mech.x;
  let mz = steer.z - mech.z;
  const gd = Math.hypot(mx, mz);
  if (gd > ARRIVE_DIST) {
    mx /= gd;
    mz /= gd;
  } else {
    mx = 0;
    mz = 0;
  }

  // Aim: at the target (with error) if any, else look where we're going.
  let aimX: number;
  let aimZ: number;
  if (target !== null) {
    const tx = (target as Pt).x;
    const tz = (target as Pt).z;
    const dist = Math.sqrt(targetD2);
    const perp = Math.atan2(tz - mech.z, tx - mech.x) + Math.PI / 2;
    const err = (Math.random() * 2 - 1) * tuning.aimError * dist;
    aimX = tx + Math.cos(perp) * err;
    aimZ = tz + Math.sin(perp) * err;
  } else {
    aimX = mech.x + (mx || 1) * 10;
    aimZ = mech.z + mz * 10;
  }

  return { mx, mz, aimX, aimZ, fire: inRange && !mech.overheated, alt: false, mode: 'walker' };
}

/** Decide whether/what to build right now (the worker throttles the cadence). */
export function chooseBuild(snap: Snapshot, me: PlayerIndex, balance: Balance): UnitType | null {
  const p = snap.players[me];
  if (!p) return null;
  if (p.queue.length >= balance.queueMax) return null;
  if (p.unitsAlive + p.queue.length >= p.unitCap) return null;
  if (p.credits < balance.units.hovertank.cost) return null;
  if (p.credits >= balance.units.dreadnought.cost && Math.random() < 0.25) return 'dreadnought';
  return 'hovertank';
}

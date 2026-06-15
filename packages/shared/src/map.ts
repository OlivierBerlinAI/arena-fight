/**
 * The single handcrafted map: "Arena 13". Point-symmetric 120×120 arena.
 *
 * Player 0's base sits in the south-west corner, player 1's in the north-east
 * (every player-1 coordinate is the negation of the player-0 one). Two lanes
 * (left = west/north edges, right = south/east edges) connect the bases. Four
 * neutral turrets guard the lanes at the edge midpoints; the middle is open.
 * Each base also holds one neutral "last defense" turret inside its compound.
 *
 * Both server collision and client rendering are generated from this data.
 */
import type { AABB, Vec2 } from './math.js';

export type WallKind = 'boundary' | 'base' | 'building' | 'cover';

export interface Wall extends AABB {
  kind: WallKind;
  /** render-only */
  height: number;
}

export interface BaseDef {
  /** where the player mech (re)spawns */
  mechSpawn: Vec2;
  /** where freshly built robots appear */
  unitSpawn: Vec2;
  /** an enemy robot inside this circle wins the match */
  corePad: { x: number; z: number; radius: number };
  /** footprint of the factory building (also a collision wall) */
  factory: AABB;
  /** the whole walled compound; used for "base under attack" warnings */
  zone: AABB;
}

export type LaneId = 'left' | 'right';

export interface MapDef {
  /** side length of the playable square, centered on the origin */
  size: number;
  walls: Wall[];
  bases: [BaseDef, BaseDef];
  /** turret positions; index is the turret id */
  turrets: Vec2[];
  /**
   * Waypoint lanes for player 0's robots (own gate → enemy core pad).
   * Player 1 lanes are the same points negated — see laneWaypoints().
   */
  lanes: Record<LaneId, Vec2[]>;
}

const HALF = 60;

function wall(kind: WallKind, height: number, minX: number, minZ: number, maxX: number, maxZ: number): Wall {
  return { kind, height, minX, minZ, maxX, maxZ };
}

/** Mirror an AABB through the origin (point symmetry). */
function mirrorWall(w: Wall): Wall {
  return { ...w, minX: -w.maxX, maxX: -w.minX, minZ: -w.maxZ, maxZ: -w.minZ };
}

// --- Base 0 (south-west). Compound interior is x,z ∈ [-58, -34], with the
// --- gate at the inner (north-east) corner: both compound walls stop 8 units
// --- short of the corner, leaving a diagonal opening toward the lanes.
const base0NorthWall = wall('base', 3.5, -60, -34, -40, -32);
const base0EastWall = wall('base', 3.5, -34, -60, -32, -40);
const factory0: AABB = { minX: -46, minZ: -56, maxX: -39, maxZ: -49 };

const base0: BaseDef = {
  mechSpawn: { x: -53, z: -42 },
  unitSpawn: { x: -42.5, z: -45 },
  corePad: { x: -51, z: -51, radius: 4.5 },
  factory: factory0,
  zone: { minX: -60, minZ: -60, maxX: -32, maxZ: -32 },
};

const base1: BaseDef = {
  mechSpawn: { x: 53, z: 42 },
  unitSpawn: { x: 42.5, z: 45 },
  corePad: { x: 51, z: 51, radius: 4.5 },
  factory: { minX: 39, minZ: 49, maxX: 46, maxZ: 56 },
  zone: { minX: 32, minZ: 32, maxX: 60, maxZ: 60 },
};

// --- Cover blocks (point-symmetric pairs), kept clear of lane paths.
const coverCenters: Vec2[] = [
  { x: -26, z: 8 },
  { x: 26, z: -8 },
  { x: -8, z: 26 },
  { x: 8, z: -26 },
  { x: -36, z: 22 },
  { x: 36, z: -22 },
  { x: 18, z: 30 },
  { x: -18, z: -30 },
];
const COVER_HALF = 2.5;

const walls: Wall[] = [
  // Outer boundary
  wall('boundary', 5, -62, -62, -60, 62),
  wall('boundary', 5, 60, -62, 62, 62),
  wall('boundary', 5, -60, -62, 60, -60),
  wall('boundary', 5, -60, 60, 60, 62),
  // Base compounds
  base0NorthWall,
  base0EastWall,
  mirrorWall(base0NorthWall),
  mirrorWall(base0EastWall),
  // Factory buildings
  wall('building', 3, factory0.minX, factory0.minZ, factory0.maxX, factory0.maxZ),
  wall('building', 3, base1.factory.minX, base1.factory.minZ, base1.factory.maxX, base1.factory.maxZ),
  // Cover
  ...coverCenters.map((c) =>
    wall('cover', 2.2, c.x - COVER_HALF, c.z - COVER_HALF, c.x + COVER_HALF, c.z + COVER_HALF)
  ),
];

// --- Lanes for player 0's robots: own gate → around the edge → enemy gate →
// --- enemy core pad. The first waypoint is inside the own gate so freshly
// --- spawned robots leave the compound cleanly.
const leftLane: Vec2[] = [
  { x: -36, z: -36 }, // inside own gate
  { x: -28, z: -28 }, // just outside
  { x: -44, z: -16 }, // join west edge lane
  { x: -44, z: 42 }, // north-west corner
  { x: 20, z: 42 }, // along north edge
  { x: 28, z: 28 }, // approach enemy gate
  { x: 36, z: 36 }, // inside enemy gate
  { x: 51, z: 51 }, // enemy core pad
];

const rightLane: Vec2[] = [
  { x: -36, z: -36 },
  { x: -28, z: -28 },
  { x: -16, z: -44 },
  { x: 42, z: -44 },
  { x: 42, z: 20 },
  { x: 28, z: 28 },
  { x: 36, z: 36 },
  { x: 51, z: 51 },
];

export const GAME_MAP: MapDef = {
  size: HALF * 2,
  walls,
  bases: [base0, base1],
  turrets: [
    { x: -52, z: 0 },
    { x: 0, z: 52 },
    { x: 52, z: 0 },
    { x: 0, z: -52 },
    // "Last defense" turrets, one inside each base compound. Like every other
    // turret they spawn neutral and must be captured (and can be re-captured by
    // the enemy). Sit on the free side of the compound, about halfway between
    // the inner gate and the back corner, clear of the factory and spawns.
    { x: -46, z: -37.6 }, // base 0 (gate-ward of the north-west corner)
    { x: 46, z: 37.6 }, // base 1 (mirror)
  ],
  lanes: { left: leftLane, right: rightLane },
};

export const LANE_IDS: LaneId[] = ['left', 'right'];

/** Waypoints for a given player's robots. Player 1 uses the mirrored lanes. */
export function laneWaypoints(player: 0 | 1, lane: LaneId): Vec2[] {
  const pts = GAME_MAP.lanes[lane];
  if (player === 0) return pts;
  return pts.map((p) => ({ x: -p.x, z: -p.z }));
}

/** Walls that block movement and projectiles (all of them, today). */
export function collisionWalls(): Wall[] {
  return GAME_MAP.walls;
}

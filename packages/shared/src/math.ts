/** 2D math on the XZ ground plane. The Y axis (height) is render-only. */

export interface Vec2 {
  x: number;
  z: number;
}

/** Axis-aligned box on the ground plane. `height` is used only by the client renderer. */
export interface AABB {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function vec2(x: number, z: number): Vec2 {
  return { x, z };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, z: a.z + b.z };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, z: a.z * s };
}

export function len(a: Vec2): number {
  return Math.hypot(a.x, a.z);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  if (l < 1e-9) return { x: 0, z: 0 };
  return { x: a.x / l, z: a.z / l };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp a vector to a maximum length. */
export function clampLen(a: Vec2, maxLen: number): Vec2 {
  const l = len(a);
  if (l <= maxLen || l < 1e-9) return a;
  const s = maxLen / l;
  return { x: a.x * s, z: a.z * s };
}

export function angleOf(a: Vec2): number {
  return Math.atan2(a.z, a.x);
}

export function fromAngle(rad: number): Vec2 {
  return { x: Math.cos(rad), z: Math.sin(rad) };
}

export function pointInAABB(p: Vec2, box: AABB): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.z >= box.minZ && p.z <= box.maxZ;
}

export function circleIntersectsAABB(c: Vec2, r: number, box: AABB): boolean {
  const cx = clamp(c.x, box.minX, box.maxX);
  const cz = clamp(c.z, box.minZ, box.maxZ);
  const dx = c.x - cx;
  const dz = c.z - cz;
  return dx * dx + dz * dz < r * r;
}

/**
 * Resolve a circle out of an AABB. Returns the corrected center, or null when
 * there is no overlap. Pushes along the axis of least penetration; if the
 * center is inside the box it pushes out through the nearest face.
 */
export function resolveCircleAABB(c: Vec2, r: number, box: AABB): Vec2 | null {
  const nx = clamp(c.x, box.minX, box.maxX);
  const nz = clamp(c.z, box.minZ, box.maxZ);
  const dx = c.x - nx;
  const dz = c.z - nz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return null;
  if (d2 > 1e-12) {
    // Center outside the box: push away from the closest point.
    const d = Math.sqrt(d2);
    const push = (r - d) / d;
    return { x: c.x + dx * push, z: c.z + dz * push };
  }
  // Center inside the box: exit through nearest face.
  const left = c.x - box.minX;
  const right = box.maxX - c.x;
  const down = c.z - box.minZ;
  const up = box.maxZ - c.z;
  const m = Math.min(left, right, down, up);
  if (m === left) return { x: box.minX - r, z: c.z };
  if (m === right) return { x: box.maxX + r, z: c.z };
  if (m === down) return { x: c.x, z: box.minZ - r };
  return { x: c.x, z: box.maxZ + r };
}

/**
 * First intersection of segment a→b with a circle.
 * Returns t in [0,1] or null.
 */
export function segmentCircleHit(a: Vec2, b: Vec2, center: Vec2, r: number): number | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const fx = a.x - center.x;
  const fz = a.z - center.z;
  const A = dx * dx + dz * dz;
  if (A < 1e-12) {
    return fx * fx + fz * fz <= r * r ? 0 : null;
  }
  const B = 2 * (fx * dx + fz * dz);
  const C = fx * fx + fz * fz - r * r;
  if (C <= 0) return 0; // starts inside
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  if (t1 >= 0 && t1 <= 1) return t1;
  return null;
}

/**
 * First intersection of segment a→b with an AABB (slab method).
 * Returns t in [0,1] or null.
 */
export function segmentAABBHit(a: Vec2, b: Vec2, box: AABB): number | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let tmin = 0;
  let tmax = 1;

  if (Math.abs(dx) < 1e-12) {
    if (a.x < box.minX || a.x > box.maxX) return null;
  } else {
    let t1 = (box.minX - a.x) / dx;
    let t2 = (box.maxX - a.x) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (Math.abs(dz) < 1e-12) {
    if (a.z < box.minZ || a.z > box.maxZ) return null;
  } else {
    let t1 = (box.minZ - a.z) / dz;
    let t2 = (box.maxZ - a.z) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Smallest signed angle from `a` to `b`, in (-π, π]. */
export function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/** Rotate `current` toward `target` by at most `maxStep`, taking the short way. */
export function rotateToward(current: number, target: number, maxStep: number): number {
  const d = angleDelta(current, target);
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

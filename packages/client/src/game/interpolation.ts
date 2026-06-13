/**
 * Snapshot ring buffer + interpolation. Entities are rendered slightly in the
 * past: renderTick trails the freshest snapshot so there is (nearly) always a
 * pair of snapshots to interpolate between. Entities present in only one of
 * the two bracketing snapshots snap to that snapshot.
 *
 * The render delay is adaptive: it sits near MIN on a clean link for snappy
 * remote motion and grows automatically when snapshot arrivals get bursty, so a
 * network hiccup does not starve the interpolator. The local player's own mech
 * bypasses this buffer entirely via client-side prediction (see prediction.ts).
 */
import type { MechSnap, ProjectileSnap, Snapshot, TurretSnap, UnitSnap } from '@precinct/shared';

export const MIN_RENDER_DELAY_MS = 55;
export const MAX_RENDER_DELAY_MS = 140;
const MAX_BUFFER = 90;
/** how many recent snapshot inter-arrival gaps drive the jitter estimate */
const JITTER_WINDOW = 24;

export interface ViewState {
  /** fractional tick the view corresponds to */
  renderTick: number;
  mechs: MechSnap[];
  units: UnitSnap[];
  turrets: TurretSnap[];
  projectiles: ProjectileSnap[];
}

interface BufferedSnap {
  snap: Snapshot;
  arrivedAt: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class SnapshotBuffer {
  private readonly buf: BufferedSnap[] = [];
  private delayMs = MIN_RENDER_DELAY_MS;
  private readonly gaps: number[] = [];

  constructor(private readonly tickMs: number) {}

  /** current adaptive render delay, in ms (for the debug overlay) */
  get renderDelayMs(): number {
    return this.delayMs;
  }

  get latest(): Snapshot | null {
    return this.buf.length > 0 ? this.buf[this.buf.length - 1].snap : null;
  }

  get latestTick(): number | null {
    return this.latest?.tick ?? null;
  }

  /** ms since the freshest snapshot arrived */
  snapshotAge(nowMs: number): number | null {
    if (this.buf.length === 0) return null;
    return nowMs - this.buf[this.buf.length - 1].arrivedAt;
  }

  push(snap: Snapshot, nowMs: number): void {
    const last = this.buf[this.buf.length - 1];
    if (last) this.trackJitter(nowMs - last.arrivedAt);
    if (last && snap.tick <= last.snap.tick) return; // ignore stale/duplicate
    this.buf.push({ snap, arrivedAt: nowMs });
    if (this.buf.length > MAX_BUFFER) this.buf.splice(0, this.buf.length - MAX_BUFFER);
  }

  /**
   * Drive the render delay from the worst recent snapshot inter-arrival gap.
   * Grow immediately on a hiccup (avoid starving the interpolator), shrink back
   * slowly when the link calms down — clamped to [MIN, MAX].
   */
  private trackJitter(gapMs: number): void {
    this.gaps.push(gapMs);
    if (this.gaps.length > JITTER_WINDOW) this.gaps.shift();
    let worst = 0;
    for (const g of this.gaps) if (g > worst) worst = g;
    const target = Math.min(
      MAX_RENDER_DELAY_MS,
      Math.max(MIN_RENDER_DELAY_MS, worst * 1.4 + this.tickMs)
    );
    this.delayMs = target > this.delayMs ? target : this.delayMs + (target - this.delayMs) * 0.03;
  }

  /** The fractional tick the renderer should show right now. */
  renderTickAt(nowMs: number): number | null {
    if (this.buf.length === 0) return null;
    const newest = this.buf[this.buf.length - 1];
    // Estimate the server's current tick from arrival time, then step back.
    const serverTickEstimate = newest.snap.tick + (nowMs - newest.arrivedAt) / this.tickMs;
    const rt = serverTickEstimate - this.delayMs / Math.max(1, this.tickMs);
    const oldest = this.buf[0].snap.tick;
    return Math.min(Math.max(rt, oldest), newest.snap.tick);
  }

  sample(nowMs: number): ViewState | null {
    const rt = this.renderTickAt(nowMs);
    if (rt === null) return null;

    // Find the two snapshots bracketing rt.
    let i1 = this.buf.length - 1;
    for (let i = 0; i < this.buf.length; i++) {
      if (this.buf[i].snap.tick >= rt) {
        i1 = i;
        break;
      }
    }
    const i0 = Math.max(0, i1 - 1);
    const s0 = this.buf[i0].snap;
    const s1 = this.buf[i1].snap;
    const span = s1.tick - s0.tick;
    const t = span > 0 ? Math.min(1, Math.max(0, (rt - s0.tick) / span)) : 1;

    // Drop snapshots that are no longer needed (older than s0).
    if (i0 > 0) this.buf.splice(0, i0);

    return {
      renderTick: rt,
      mechs: s1.mechs.map((m1) => {
        const m0 = s0.mechs.find((m) => m.player === m1.player);
        if (!m0) return { ...m1 };
        // Respawn teleport: snap instead of gliding across the map. 10 units
        // between snapshots is far beyond any legitimate movement.
        const ddx = m1.x - m0.x;
        const ddz = m1.z - m0.z;
        if (m0.alive !== m1.alive || ddx * ddx + ddz * ddz > 100) return { ...m1 };
        return {
          ...m1,
          x: lerp(m0.x, m1.x, t),
          z: lerp(m0.z, m1.z, t),
          vx: lerp(m0.vx, m1.vx, t),
          vz: lerp(m0.vz, m1.vz, t),
          yaw: lerpAngle(m0.yaw, m1.yaw, t),
        };
      }),
      units: s1.units.map((u1) => {
        const u0 = s0.units.find((u) => u.id === u1.id);
        if (!u0) return { ...u1 }; // newly appeared: snap
        return {
          ...u1,
          x: lerp(u0.x, u1.x, t),
          z: lerp(u0.z, u1.z, t),
          yaw: lerpAngle(u0.yaw, u1.yaw, t),
        };
      }),
      turrets: s1.turrets.map((t1) => {
        const t0 = s0.turrets.find((tt) => tt.id === t1.id);
        if (!t0) return { ...t1 };
        return {
          ...t1,
          headYaw: lerpAngle(t0.headYaw, t1.headYaw, t),
          capProgress: lerp(t0.capProgress, t1.capProgress, t),
        };
      }),
      projectiles: s1.projectiles.map((p1) => {
        const p0 = s0.projectiles.find((p) => p.id === p1.id);
        if (!p0) return { ...p1 };
        return { ...p1, x: lerp(p0.x, p1.x, t), z: lerp(p0.z, p1.z, t) };
      }),
    };
  }
}

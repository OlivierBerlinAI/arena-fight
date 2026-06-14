/**
 * Client-side prediction for the local player's mech.
 *
 * Every remote entity is rendered ~1 render-delay in the past from the
 * interpolation buffer; doing the same for the OWN mech makes steering feel
 * late (the input has to round-trip to the server and back before you see it).
 *
 * Instead we re-derive the local mech's "present" pose every frame: take the
 * freshest authoritative snapshot as ground truth and advance it with the
 * current local input using the exact server movement model (same accel /
 * friction / clamp / static-collision as sim/mech.ts), then ease the rendered
 * pose toward that result so an occasional server correction (knockback, a wall
 * the client didn't predict) never pops.
 *
 * Yaw is taken straight from the input heading: the server derives the mech's
 * yaw from the same aim point we send, and the aim point sits far ahead, so the
 * local heading is authoritative-accurate and instant.
 *
 * Re-deriving from the latest snapshot each frame keeps the prediction anchored
 * and drift-free — no rollback buffer and no protocol change (no input acks).
 */
import { clampLen, collideWithStatics } from '@mech-arena-fight/shared';
import type { Balance, MechMode, MechSnap, SimState, Snapshot, Vec2 } from '@mech-arena-fight/shared';

/** Never extrapolate further than this if snapshots stall (ms). */
const MAX_AHEAD_MS = 250;
/** How fast the rendered pose eases toward the freshly predicted pose (1/s). */
const CORRECTION_RATE = 28;
/** Beyond this gap (units²) the prediction snaps instead of gliding (respawn). */
const SNAP_DIST_SQ = 100;

export class LocalMechPredictor {
  private readonly pos: Vec2 = { x: 0, z: 0 };
  private vel: Vec2 = { x: 0, z: 0 };
  private started = false;

  get initialized(): boolean {
    return this.started;
  }
  get x(): number {
    return this.pos.x;
  }
  get z(): number {
    return this.pos.z;
  }

  /**
   * @param srv     freshest authoritative snapshot mech for the local player
   * @param turrets freshest turret list (live ones push the mech, like the sim)
   * @param aheadMs how far past the snapshot to predict (≈ snapshotAge + RTT/2)
   * @param input   current local input (thrust mx/mz, locomotion mode)
   * @param heading local facing yaw (exact intended heading)
   */
  update(
    srv: MechSnap,
    turrets: Snapshot['turrets'],
    aheadMs: number,
    input: { mx: number; mz: number; mode: MechMode },
    heading: number,
    balance: Balance,
    dt: number
  ): MechSnap {
    // Dead, or first frame: hand back the server pose and re-anchor.
    if (!srv.alive || !this.started) {
      this.pos.x = srv.x;
      this.pos.z = srv.z;
      this.vel = { x: srv.vx, z: srv.vz };
      this.started = true;
      return { ...srv, yaw: srv.alive ? heading : srv.yaw };
    }

    const target = this.simulateAhead(srv, turrets, aheadMs, input, balance);
    const ddx = target.pos.x - this.pos.x;
    const ddz = target.pos.z - this.pos.z;
    if (ddx * ddx + ddz * ddz > SNAP_DIST_SQ) {
      // Respawn teleport / large correction: snap rather than glide across the map.
      this.pos.x = target.pos.x;
      this.pos.z = target.pos.z;
    } else {
      const k = 1 - Math.exp(-CORRECTION_RATE * dt);
      this.pos.x += ddx * k;
      this.pos.z += ddz * k;
    }
    this.vel = target.vel;
    return { ...srv, x: this.pos.x, z: this.pos.z, yaw: heading, vx: this.vel.x, vz: this.vel.z };
  }

  /** Advance the authoritative pose by `aheadMs` of local input (server model). */
  private simulateAhead(
    srv: MechSnap,
    turrets: Snapshot['turrets'],
    aheadMs: number,
    input: { mx: number; mz: number; mode: MechMode },
    balance: Balance
  ): { pos: Vec2; vel: Vec2 } {
    const b = balance.mech;
    const hover = input.mode === 'hover';
    const accel = hover ? b.hoverAccel : b.accel;
    const friction = hover ? b.hoverFriction : b.friction;
    const maxSpeed = hover ? b.hoverMaxSpeed : b.maxSpeed;
    const tickMs = 1000 / balance.tickRate;

    // collideWithStatics only reads GAME_MAP (internal) and live turret positions.
    const colliderState = {
      turrets: turrets
        .filter((t) => t.alive)
        .map((t) => ({ alive: true, pos: { x: t.x, z: t.z } })),
    } as unknown as SimState;

    const dir = clampLen({ x: input.mx, z: input.mz }, 1);
    const pos: Vec2 = { x: srv.x, z: srv.z };
    let vel: Vec2 = { x: srv.vx, z: srv.vz };

    let remaining = Math.max(0, Math.min(MAX_AHEAD_MS, aheadMs));
    while (remaining > 1e-3) {
      const stepDt = Math.min(tickMs, remaining) / 1000;
      vel.x += dir.x * accel * stepDt;
      vel.z += dir.z * accel * stepDt;
      const drag = Math.max(0, 1 - friction * stepDt);
      vel.x *= drag;
      vel.z *= drag;
      vel = clampLen(vel, maxSpeed);
      pos.x += vel.x * stepDt;
      pos.z += vel.z * stepDt;
      collideWithStatics(pos, b.radius, colliderState, balance);
      remaining -= Math.min(tickMs, remaining);
    }
    return { pos, vel };
  }
}

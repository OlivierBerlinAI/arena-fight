/**
 * Third-person chase camera. It sits behind and above the own mech and always
 * looks along the mech's facing direction (mech.yaw) — as the player turns with
 * A/D the whole view rotates with them. Position trails softly (a little lag,
 * never perfectly glued); the look direction tracks a touch faster so turning
 * stays responsive. The mouse is not involved at all.
 */
import * as THREE from 'three';
import type { MechSnap } from '@mech-arena-fight/shared';

const DIST = 13;
const HEIGHT = 14;
const LOOK_AHEAD = 6;
/** position follow: ~8% toward the target per 60fps frame (trailing lag) */
const POS_SMOOTH = 0.08;
/** look-direction follow: snappier so turns don't feel sluggish */
const LOOK_SMOOTH = 0.16;
/** keep the camera inside the arena so boundary walls never occlude the mech */
const ARENA_CLAMP = 56;

export class ChaseCamera {
  private readonly lookTarget = new THREE.Vector3();
  private initialized = false;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  update(mech: MechSnap, dt: number): void {
    const dirX = Math.cos(mech.yaw);
    const dirZ = Math.sin(mech.yaw);

    const desired = new THREE.Vector3(
      Math.max(-ARENA_CLAMP, Math.min(ARENA_CLAMP, mech.x - dirX * DIST)),
      HEIGHT,
      Math.max(-ARENA_CLAMP, Math.min(ARENA_CLAMP, mech.z - dirZ * DIST))
    );
    const desiredLook = new THREE.Vector3(mech.x + dirX * LOOK_AHEAD, 1.4, mech.z + dirZ * LOOK_AHEAD);

    if (!this.initialized) {
      this.camera.position.copy(desired);
      this.lookTarget.copy(desiredLook);
      this.initialized = true;
    } else {
      // frame-rate-independent smoothing equivalent to the per-frame constants at 60 fps
      const kp = 1 - Math.pow(1 - POS_SMOOTH, dt * 60);
      const kl = 1 - Math.pow(1 - LOOK_SMOOTH, dt * 60);
      this.camera.position.lerp(desired, kp);
      this.lookTarget.lerp(desiredLook, kl);
    }
    this.camera.lookAt(this.lookTarget);
  }

  /** camera yaw on the ground plane (for the minimap view marker) */
  get groundYaw(): number {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return Math.atan2(dir.z, dir.x);
  }
}

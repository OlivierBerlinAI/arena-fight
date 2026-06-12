/**
 * Third-person chase camera: behind and above the own mech, opposite its aim
 * direction, smoothed each frame, looking slightly ahead of the mech.
 */
import * as THREE from 'three';
import type { MechSnap, Vec2 } from '@precinct/shared';

const DIST = 13;
const HEIGHT = 14;
const LOOK_AHEAD = 6;
const SMOOTH = 0.08; // ~8% per frame at 60 fps
/** keep the camera inside the arena so boundary walls never occlude the mech */
const ARENA_CLAMP = 56;

export class ChaseCamera {
  private readonly lookTarget = new THREE.Vector3();
  private initialized = false;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  update(mech: MechSnap, aim: Vec2 | null, dt: number): void {
    let yaw = mech.yaw;
    if (aim) {
      const dx = aim.x - mech.x;
      const dz = aim.z - mech.z;
      if (dx * dx + dz * dz > 0.25) yaw = Math.atan2(dz, dx);
    }
    const dirX = Math.cos(yaw);
    const dirZ = Math.sin(yaw);

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
      // frame-rate-independent smoothing equivalent to ~8%/frame at 60 fps
      const k = 1 - Math.pow(1 - SMOOTH, dt * 60);
      this.camera.position.lerp(desired, k);
      this.lookTarget.lerp(desiredLook, k);
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

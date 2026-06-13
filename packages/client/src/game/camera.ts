/**
 * Third-person chase camera. It follows the own mech's position with a soft,
 * frame-rate-independent lag (close behind, never perfectly glued) from a
 * FIXED viewing direction — the mouse aims the weapon but never moves the
 * camera. The fixed direction points from the player's base toward the map
 * centre, so "forward" on screen is always toward the battlefield.
 */
import * as THREE from 'three';
import { GAME_MAP } from '@precinct/shared';
import type { MechSnap, PlayerIndex } from '@precinct/shared';

const DIST = 13;
const HEIGHT = 14;
const LOOK_AHEAD = 6;
/** soft follow: ~6.5% toward the target per 60fps frame (visible trailing lag) */
const SMOOTH = 0.065;
/** keep the camera inside the arena so boundary walls never occlude the mech */
const ARENA_CLAMP = 56;

export class ChaseCamera {
  private readonly lookTarget = new THREE.Vector3();
  private initialized = false;
  /** fixed forward direction on the ground plane (never changes during a match) */
  private readonly dirX: number;
  private readonly dirZ: number;
  private readonly viewYaw: number;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    playerIndex: PlayerIndex
  ) {
    // Face from the spawn toward the map centre (0,0).
    const spawn = GAME_MAP.bases[playerIndex].mechSpawn;
    this.viewYaw = Math.atan2(-spawn.z, -spawn.x);
    this.dirX = Math.cos(this.viewYaw);
    this.dirZ = Math.sin(this.viewYaw);
  }

  update(mech: MechSnap, dt: number): void {
    const desired = new THREE.Vector3(
      Math.max(-ARENA_CLAMP, Math.min(ARENA_CLAMP, mech.x - this.dirX * DIST)),
      HEIGHT,
      Math.max(-ARENA_CLAMP, Math.min(ARENA_CLAMP, mech.z - this.dirZ * DIST))
    );
    const desiredLook = new THREE.Vector3(
      mech.x + this.dirX * LOOK_AHEAD,
      1.4,
      mech.z + this.dirZ * LOOK_AHEAD
    );

    if (!this.initialized) {
      this.camera.position.copy(desired);
      this.lookTarget.copy(desiredLook);
      this.initialized = true;
    } else {
      // frame-rate-independent smoothing equivalent to SMOOTH per frame at 60 fps
      const k = 1 - Math.pow(1 - SMOOTH, dt * 60);
      this.camera.position.lerp(desired, k);
      this.lookTarget.lerp(desiredLook, k);
    }
    this.camera.lookAt(this.lookTarget);
  }

  /** fixed camera yaw on the ground plane (for the minimap view marker) */
  get groundYaw(): number {
    return this.viewYaw;
  }
}

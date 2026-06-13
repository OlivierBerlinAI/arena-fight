/**
 * Input: WASD relative to camera yaw, mouse-on-ground-plane aim (no pointer
 * lock), LMB fire / RMB alt, 1/2 build hotkeys, F3 debug toggle. Sends the
 * `input` message at 30 Hz while a match is running.
 */
import * as THREE from 'three';
import type { MechMode, PlayerInput, UnitType, Vec2 } from '@precinct/shared';

const SEND_INTERVAL_MS = 1000 / 30;
/** key that toggles walker ⇄ hover */
const TRANSFORM_CODE = 'KeyF';

export interface InputCallbacks {
  onBuild: (unit: UnitType) => void;
  onToggleDebug: () => void;
  /** fired when the player toggles locomotion mode (for immediate SFX) */
  onTransform: (mode: MechMode) => void;
  /** fired when the player presses the mute key */
  onToggleMute: () => void;
  sendInput: (input: PlayerInput) => void;
}

export class InputManager {
  private readonly keys = new Set<string>();
  private fire = false;
  private alt = false;
  private mode: MechMode = 'walker';
  private ndc = new THREE.Vector2(0, 0);
  private hasMouse = false;
  private sendTimer: number | null = null;
  private playing = false;

  /** world-space point on y=0 the mouse aims at (updated per frame) */
  aimPoint: Vec2 | null = null;

  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'F3') {
      e.preventDefault();
      if (!e.repeat) this.cb.onToggleDebug();
      return;
    }
    if (e.repeat) return;
    if (e.code === 'Digit1') this.cb.onBuild('hovertank');
    else if (e.code === 'Digit2') this.cb.onBuild('dreadnought');
    else if (e.code === TRANSFORM_CODE) {
      this.mode = this.mode === 'walker' ? 'hover' : 'walker';
      this.cb.onTransform(this.mode);
    } else if (e.code === 'KeyM') this.cb.onToggleMute();
    else this.keys.add(e.code);
  };
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };
  private readonly onBlur = (): void => {
    this.keys.clear();
    this.fire = false;
    this.alt = false;
  };
  private readonly onMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.hasMouse = true;
  };
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) this.fire = true;
    if (e.button === 2) this.alt = true;
  };
  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.fire = false;
    if (e.button === 2) this.alt = false;
  };
  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly cb: InputCallbacks
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('contextmenu', this.onContextMenu);

    this.sendTimer = window.setInterval(() => {
      if (!this.playing) return;
      this.cb.sendInput(this.currentInput());
    }, SEND_INTERVAL_MS);
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (!playing) this.onBlur();
  }

  /** Re-project the mouse onto the ground plane with the current camera. */
  updateAim(fallback: Vec2 | null): void {
    if (!this.hasMouse) {
      this.aimPoint = fallback;
      return;
    }
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
      this.aimPoint = { x: hit.x, z: hit.z };
    } else if (fallback) {
      this.aimPoint = fallback;
    }
  }

  currentInput(): PlayerInput {
    // camera-relative WASD
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    let fx = dir.x;
    let fz = dir.z;
    const flen = Math.hypot(fx, fz);
    if (flen > 1e-6) {
      fx /= flen;
      fz /= flen;
    } else {
      fx = 0;
      fz = -1;
    }
    // right = forward x up
    const rx = -fz;
    const rz = fx;

    const f = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const r = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    let mx = fx * f + rx * r;
    let mz = fz * f + rz * r;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1) {
      mx /= mlen;
      mz /= mlen;
    }

    const aim = this.aimPoint ?? { x: 0, z: 0 };
    return { mx, mz, aimX: aim.x, aimZ: aim.z, fire: this.fire, alt: this.alt, mode: this.mode };
  }

  dispose(): void {
    if (this.sendTimer !== null) window.clearInterval(this.sendTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('contextmenu', this.onContextMenu);
  }
}

/**
 * Player controls. Two interchangeable schemes feed one shared input model:
 *
 *   keyboard (desktop, default):
 *     W / S         drive forward / reverse along the facing direction
 *     A / D         rotate the mech left / right (this also turns the chase camera)
 *     M / left mb   energy fire (gatling as a walker, laser while hovering)
 *     N / right mb  kinetic fire (rockets — walker only)
 *     F             transform walker ⇄ hover
 *     1 / 2         build tank / heavy tank
 *     F3            debug overlay
 *
 *   Firing also accepts the mouse buttons (left = primary, right = secondary) so
 *   a cheap 2-key-rollover keyboard can still drive+turn+fire at once. The mouse
 *   never aims or moves the camera — aiming stays keyboard/facing-only.
 *
 *   touch (phone/tablet): an on-screen joystick + buttons (see ./touch.ts).
 *     The joystick's vector maps to the SAME throttle/turn axes the keys drive.
 *
 * Both schemes can be active at once (a tablet with a keyboard), and the scheme
 * can be switched live via `setScheme`. Movement and facing are converted to the
 * existing wire input: `mx,mz` is the thrust vector along the facing heading and
 * `aimX,aimZ` is a point far ahead on that heading, so the authoritative
 * simulation (unchanged) sets the mech's yaw to the heading and fires along it.
 */
import type { MechMode, PlayerInput, UnitType, Vec2 } from '@mech-arena-fight/shared';
import type { ControlScheme } from '../controls';
import { byId } from '../dom';
import { TouchControls } from './touch';

const SEND_INTERVAL_MS = 1000 / 60;
/** key that toggles walker ⇄ hover */
const TRANSFORM_CODE = 'KeyF';

/**
 * Turning uses an angular-velocity model so each mode has its own feel:
 *  - walker: high drag → snappy, direct steering, but a lower top turn rate
 *  - hover:  low drag + strong angular thrust → the turn accelerates in and
 *            glides out, mirroring the hover forward acceleration/coast
 *
 * `accel/friction` is the target (steady-state) turn rate it accelerates
 * toward; `friction` sets how fast it gets there and coasts back; `max` clamps
 * the rate. Both targets sit well above `max`, so the cap — not the integrator
 * step — bounds the rate, which keeps the feel identical at any frame rate
 * (the integrator below is the analytic, frame-rate-independent solution).
 */
const TURN = {
  walker: { accel: 42, friction: 14, max: 2.2 },
  hover: { accel: 14, friction: 2.6, max: 3.2 },
} as const;

/** reverse is a little slower than forward */
const REVERSE_THROTTLE = 0.65;
/** how far ahead to project the aim point along the heading */
const AIM_REACH = 40;

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

export interface InputCallbacks {
  onBuild: (unit: UnitType) => void;
  onToggleDebug: () => void;
  /** fired when the player toggles locomotion mode (for immediate SFX) */
  onTransform: (mode: MechMode) => void;
  sendInput: (input: PlayerInput) => void;
}

export class InputManager {
  private readonly keys = new Set<string>();
  private mode: MechMode = 'walker';
  /** left/right mouse buttons held — extra fire inputs alongside M/N */
  private mouseFire = false;
  private mouseAlt = false;
  private sendTimer: number | null = null;
  private playing = false;
  /** on-screen controls — created only while the touch scheme is active */
  private touch: TouchControls | null = null;

  /** client-side facing heading (radians); the camera and aim both follow it */
  private facingYaw = 0;
  /** angular velocity (rad/s), integrated with mode-dependent accel/drag */
  private angularVel = 0;
  private facingInit = false;
  /** world-space point ahead of the mech on the current heading */
  aimPoint: Vec2 | null = null;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'F3') {
      e.preventDefault();
      if (!e.repeat) this.cb.onToggleDebug();
      return;
    }
    if (e.repeat) return;
    if (e.code === 'Digit1') this.cb.onBuild('hovertank');
    else if (e.code === 'Digit2') this.cb.onBuild('dreadnought');
    else if (e.code === TRANSFORM_CODE) this.toggleMode();
    else this.keys.add(e.code);
  };
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };
  private readonly onBlur = (): void => {
    this.keys.clear();
    this.mouseFire = false;
    this.mouseAlt = false;
  };
  // Mouse buttons are an extra FIRE input only — they never aim or move the
  // camera. Listening on the canvas (not window) means clicks on HUD buttons
  // don't fire; mouseup/contextmenu on window catch release/menu anywhere.
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseFire = true;
    else if (e.button === 2) this.mouseAlt = true;
  };
  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseFire = false;
    else if (e.button === 2) this.mouseAlt = false;
  };
  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault(); // right-click fires rockets instead of opening the menu
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cb: InputCallbacks,
    scheme: ControlScheme
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    this.setScheme(scheme);

    this.sendTimer = window.setInterval(() => {
      if (!this.playing) return;
      this.cb.sendInput(this.currentInput());
    }, SEND_INTERVAL_MS);
  }

  /** Toggle locomotion mode — shared by the F key and the touch transform button. */
  toggleMode(): void {
    this.mode = this.mode === 'walker' ? 'hover' : 'walker';
    this.touch?.setMode(this.mode);
    this.cb.onTransform(this.mode);
  }

  /** Show or hide the on-screen controls; the keyboard stays live either way. */
  setScheme(scheme: ControlScheme): void {
    if (scheme === 'touch' && !this.touch) {
      this.touch = new TouchControls({ onTransform: () => this.toggleMode() }, byId('game-root'));
      this.touch.setMode(this.mode);
    } else if (scheme === 'keyboard' && this.touch) {
      this.touch.dispose();
      this.touch = null;
    }
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (!playing) {
      this.onBlur();
      this.touch?.reset();
    }
  }

  /** Local facing heading (rad) — the exact yaw the server will derive from aim. */
  get heading(): number {
    return this.facingYaw;
  }

  /**
   * Per-frame: integrate the facing heading from the turn axis and project the
   * aim point ahead of the mech. While dead, the heading resyncs to the mech's
   * (respawn) yaw so the player starts facing the right way again.
   */
  update(mech: { x: number; z: number; yaw: number; alive: boolean }, dt: number): void {
    if (!this.facingInit || !mech.alive) {
      this.facingYaw = mech.yaw;
      this.angularVel = 0;
      this.facingInit = true;
    } else {
      const turn = this.turnAxis();
      const t = TURN[this.mode];
      // Analytic (frame-rate-independent) approach to the steady-state rate:
      //   dω/dt = turn·accel − friction·ω  ⇒  ω(t+dt) = ω∞ + (ω − ω∞)·e^(−friction·dt)
      const target = (turn * t.accel) / t.friction;
      this.angularVel = target + (this.angularVel - target) * Math.exp(-t.friction * dt);
      this.angularVel = Math.max(-t.max, Math.min(t.max, this.angularVel));
      this.facingYaw += this.angularVel * dt;
    }
    const dx = Math.cos(this.facingYaw);
    const dz = Math.sin(this.facingYaw);
    this.aimPoint = { x: mech.x + dx * AIM_REACH, z: mech.z + dz * AIM_REACH };
  }

  /** Steering, -1 (left) .. 1 (right): D/A keys plus the joystick's x. */
  private turnAxis(): number {
    const kb = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    return clamp1(kb + (this.touch?.vector.x ?? 0));
  }

  /** Throttle, -reverse .. 1: W/S keys plus the joystick's forward (up) push. */
  private throttleAxis(): number {
    const kb = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? REVERSE_THROTTLE : 0);
    let stick = 0;
    if (this.touch) {
      const forward = -this.touch.vector.y; // joystick up = forward
      stick = forward >= 0 ? forward : forward * REVERSE_THROTTLE;
    }
    return clamp1(kb + stick);
  }

  currentInput(): PlayerInput {
    const dx = Math.cos(this.facingYaw);
    const dz = Math.sin(this.facingYaw);
    const throttle = this.throttleAxis();
    const mx = dx * throttle;
    const mz = dz * throttle;

    const aim = this.aimPoint ?? { x: dx * AIM_REACH, z: dz * AIM_REACH };
    return {
      mx,
      mz,
      aimX: aim.x,
      aimZ: aim.z,
      fire: this.keys.has('KeyM') || this.mouseFire || (this.touch?.firePressed ?? false),
      alt: this.keys.has('KeyN') || this.mouseAlt || (this.touch?.altPressed ?? false),
      mode: this.mode,
    };
  }

  dispose(): void {
    if (this.sendTimer !== null) window.clearInterval(this.sendTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.touch?.dispose();
    this.touch = null;
  }
}

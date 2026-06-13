/**
 * Keyboard-only controls (the mouse is intentionally unused for gameplay):
 *   W / S  drive forward / reverse along the facing direction
 *   A / D  rotate the mech left / right (this also turns the chase camera)
 *   M      primary fire (gatling as a walker, laser while hovering)
 *   N      secondary fire (rockets — walker only)
 *   F      transform walker ⇄ hover
 *   1 / 2  build hovertank / dreadnought
 *   F3     debug overlay
 *
 * Movement and facing are converted to the existing wire input: `mx,mz` is the
 * thrust vector along the facing heading and `aimX,aimZ` is a point far ahead
 * on that heading, so the authoritative simulation (unchanged) sets the mech's
 * yaw to the heading and fires along it.
 */
import type { MechMode, PlayerInput, UnitType, Vec2 } from '@precinct/shared';

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
  private sendTimer: number | null = null;
  private playing = false;

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
    else if (e.code === TRANSFORM_CODE) {
      this.mode = this.mode === 'walker' ? 'hover' : 'walker';
      this.cb.onTransform(this.mode);
    } else this.keys.add(e.code);
  };
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };
  private readonly onBlur = (): void => {
    this.keys.clear();
  };

  constructor(private readonly cb: InputCallbacks) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.sendTimer = window.setInterval(() => {
      if (!this.playing) return;
      this.cb.sendInput(this.currentInput());
    }, SEND_INTERVAL_MS);
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (!playing) this.onBlur();
  }

  /** Local facing heading (rad) — the exact yaw the server will derive from aim. */
  get heading(): number {
    return this.facingYaw;
  }

  /**
   * Per-frame: integrate the facing heading from the turn keys and project the
   * aim point ahead of the mech. While dead, the heading resyncs to the mech's
   * (respawn) yaw so the player starts facing the right way again.
   */
  update(mech: { x: number; z: number; yaw: number; alive: boolean }, dt: number): void {
    if (!this.facingInit || !mech.alive) {
      this.facingYaw = mech.yaw;
      this.angularVel = 0;
      this.facingInit = true;
    } else {
      const turn = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
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

  currentInput(): PlayerInput {
    const dx = Math.cos(this.facingYaw);
    const dz = Math.sin(this.facingYaw);
    const throttle =
      (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? REVERSE_THROTTLE : 0);
    const mx = dx * throttle;
    const mz = dz * throttle;

    const aim = this.aimPoint ?? { x: dx * AIM_REACH, z: dz * AIM_REACH };
    return {
      mx,
      mz,
      aimX: aim.x,
      aimZ: aim.z,
      fire: this.keys.has('KeyM'),
      alt: this.keys.has('KeyN'),
      mode: this.mode,
    };
  }

  dispose(): void {
    if (this.sendTimer !== null) window.clearInterval(this.sendTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}

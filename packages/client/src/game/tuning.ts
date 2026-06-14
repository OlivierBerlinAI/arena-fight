/**
 * Live-tunable client turn constants. The in-match tuning overlay edits these
 * in place; because turning is integrated client-side (the facing heading feeds
 * the aim point we send), changes take effect immediately for the local mech.
 *
 * Turning uses an angular-velocity model so each mode has its own feel:
 *  - walker: high drag → snappy, direct steering, but a lower top turn rate
 *  - hover:  low drag + strong angular thrust → the turn accelerates in and
 *            glides out, mirroring the hover forward acceleration/coast
 *
 * `accel/friction` is the target (steady-state) turn rate it accelerates
 * toward; `friction` sets how fast it gets there and coasts back; `max` clamps
 * the rate. Both targets sit well above `max`, so the cap — not the integrator
 * step — bounds the rate, which keeps the feel identical at any frame rate.
 *
 * `brakeFactor` multiplies the friction while the turn is decelerating (the key
 * is released, or you steer against the current spin), so the rotation brakes
 * harder than it builds up — e.g. 1.5 = stops 50% faster than it accelerates.
 *
 * Mech *movement* (max speed / accel / drag) is server-authoritative and tuned
 * over the wire via the `tuneMech` message, not here.
 */
export interface TurnTune {
  accel: number;
  friction: number;
  max: number;
  brakeFactor: number;
}

export const TURN: Record<'walker' | 'hover', TurnTune> = {
  walker: { accel: 7, friction: 5, max: 2.5, brakeFactor: 1.5 },
  hover: { accel: 14, friction: 2.6, max: 1.3, brakeFactor: 1.5 },
};

/**
 * Advance the angular velocity one step (rad/s). `turn` is the steering axis
 * (-1..1). Uses a frame-rate-independent analytic step toward the steady-state
 * rate `turn·accel/friction`, with the drag boosted by `brakeFactor` whenever
 * the turn is decelerating (no input, or steering against the current spin) so
 * the rotation brakes harder than it accelerates. Clamped to ±max.
 */
export function stepTurn(angularVel: number, turn: number, t: TurnTune, dt: number): number {
  // Braking = no steering input, or steering against an existing spin. Starting
  // from rest (ω = 0) counts as accelerating, not braking.
  const braking = turn === 0 || (angularVel !== 0 && Math.sign(turn) !== Math.sign(angularVel));
  const friction = braking ? t.friction * t.brakeFactor : t.friction;
  const target = (turn * t.accel) / friction;
  const next = target + (angularVel - target) * Math.exp(-friction * dt);
  return Math.max(-t.max, Math.min(t.max, next));
}

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
 * Mech *movement* (max speed / accel / drag) is server-authoritative and tuned
 * over the wire via the `tuneMech` message, not here.
 */
export interface TurnTune {
  accel: number;
  friction: number;
  max: number;
}

export const TURN: Record<'walker' | 'hover', TurnTune> = {
  walker: { accel: 7, friction: 5, max: 2.5 },
  hover: { accel: 14, friction: 2.6, max: 1.3 },
};

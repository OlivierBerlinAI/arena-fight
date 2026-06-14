import { describe, expect, it } from 'vitest';
import { TURN, stepTurn } from '../src/game/tuning';
import type { TurnTune } from '../src/game/tuning';

const T: TurnTune = { accel: 7, friction: 5, max: 2.5, brakeFactor: 1.5 };
const DT = 0.1;

describe('turn integration', () => {
  it('accelerating (input drives the spin) uses the plain friction', () => {
    // From rest, steer right: approaches steady state at the base friction.
    const next = stepTurn(0, 1, T, DT);
    const target = (1 * T.accel) / T.friction;
    expect(next).toBeCloseTo(target + (0 - target) * Math.exp(-T.friction * DT), 9);
  });

  it('releasing the keys brakes with friction × brakeFactor', () => {
    const w0 = 2.0;
    const next = stepTurn(w0, 0, T, DT);
    // Pure decay toward 0 at the boosted drag.
    expect(next).toBeCloseTo(w0 * Math.exp(-T.friction * T.brakeFactor * DT), 9);
    // And it sheds more than the un-boosted drag would.
    expect(next).toBeLessThan(w0 * Math.exp(-T.friction * DT));
  });

  it('steering against the current spin also brakes harder', () => {
    const w0 = 2.0; // spinning right, now steer left
    const braked = stepTurn(w0, -1, T, DT);
    const plain = (() => {
      const target = (-1 * T.accel) / T.friction;
      return target + (w0 - target) * Math.exp(-T.friction * DT);
    })();
    expect(braked).toBeLessThan(plain); // closer to zero / past it sooner
  });

  it('brakes ~50% faster than it builds to the same rate (default 1.5×)', () => {
    expect(TURN.walker.brakeFactor).toBe(1.5);
    expect(TURN.hover.brakeFactor).toBe(1.5);
    // Time constant of decay is 1/(friction·brakeFactor) vs spin-up 1/friction.
    const spinUpTau = 1 / T.friction;
    const brakeTau = 1 / (T.friction * T.brakeFactor);
    expect(spinUpTau / brakeTau).toBeCloseTo(1.5, 9);
  });

  it('never exceeds the max turn rate (the cap bounds a high steady state)', () => {
    const capped: TurnTune = { accel: 50, friction: 5, max: 2.5, brakeFactor: 1.5 }; // target 10 ≫ max
    let w = 0;
    for (let i = 0; i < 200; i++) w = stepTurn(w, 1, capped, DT);
    expect(w).toBeLessThanOrEqual(capped.max + 1e-9);
    expect(w).toBeCloseTo(capped.max, 6); // saturates at the cap
  });
});

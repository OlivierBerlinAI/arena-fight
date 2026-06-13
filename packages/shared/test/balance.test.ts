import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BALANCE,
  GameSimulation,
  SIM_TICK_RATE,
  TEST_BALANCE,
  getBalance,
  makeBalance,
} from '@precinct/shared';
import { tickN } from './helpers';

describe('tick-rate scaling', () => {
  it('returns the cached presets at the reference rate', () => {
    expect(getBalance('default')).toBe(DEFAULT_BALANCE);
    expect(getBalance('default', SIM_TICK_RATE)).toBe(DEFAULT_BALANCE);
    expect(getBalance('test', SIM_TICK_RATE)).toBe(TEST_BALANCE);
    expect(DEFAULT_BALANCE.tickRate).toBe(SIM_TICK_RATE);
  });

  it('carries the requested rate and rebuilds for non-default rates', () => {
    const b = getBalance('default', 100);
    expect(b.tickRate).toBe(100);
    expect(b).not.toBe(DEFAULT_BALANCE);
  });

  it('scales every tick-based duration so the game feel in seconds is invariant', () => {
    const lo = makeBalance('default', 30);
    const hi = makeBalance('default', 100);

    // Durations expressed in seconds are identical at any tick rate.
    const seconds = (ticks: number, rate: number): number => ticks / rate;
    expect(seconds(hi.mech.respawnTicks, 100)).toBeCloseTo(seconds(lo.mech.respawnTicks, 30), 9);
    expect(seconds(hi.units.hovertank.buildTicks, 100)).toBeCloseTo(
      seconds(lo.units.hovertank.buildTicks, 30),
      9
    );
    expect(seconds(hi.turret.captureTicks, 100)).toBeCloseTo(seconds(lo.turret.captureTicks, 30), 9);
    expect(seconds(hi.rocket.reloadTicks, 100)).toBeCloseTo(seconds(lo.rocket.reloadTicks, 30), 9);

    // coolPerTick is a per-tick rate → cooling per second is invariant.
    expect(hi.gatling.coolPerTick * 100).toBeCloseTo(lo.gatling.coolPerTick * 30, 9);

    // Rate-independent fields (costs, speeds in units/s, hp, caps) are unchanged.
    expect(hi.units.hovertank.cost).toBe(lo.units.hovertank.cost);
    expect(hi.mech.maxSpeed).toBe(lo.mech.maxSpeed);
    expect(hi.unitCap).toBe(lo.unitCap);
  });

  it('the simulation honours the balance tick rate (passive income per second)', () => {
    for (const rate of [30, 50, 100]) {
      const sim = new GameSimulation({ seed: 7, balance: makeBalance('default', rate) });
      const start = sim.balance.economy.startingCredits;
      tickN(sim, rate); // exactly one simulated second
      expect(sim.state.players[0].credits).toBeCloseTo(start + 1, 9);
    }
  });
});

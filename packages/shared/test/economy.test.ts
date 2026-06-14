import { describe, expect, it } from 'vitest';
import { GameSimulation, SIM_TICK_RATE, TEST_BALANCE, aliveUnitCount } from '@mech-arena-fight/shared';
import { IDLE, buildCmd, tickN } from './helpers';

describe('economy', () => {
  it('starts with the configured credits', () => {
    const sim = new GameSimulation({ seed: 31 });
    expect(sim.state.players[0].credits).toBe(sim.balance.economy.startingCredits);
    expect(sim.state.players[1].credits).toBe(sim.balance.economy.startingCredits);
    const testSim = new GameSimulation({ seed: 31, balance: TEST_BALANCE });
    expect(testSim.state.players[0].credits).toBe(TEST_BALANCE.economy.startingCredits);
  });

  it('passive income is exactly +1 credit per simulated second', () => {
    const sim = new GameSimulation({ seed: 32 });
    const start = sim.balance.economy.startingCredits;
    tickN(sim, SIM_TICK_RATE); // one second
    expect(sim.state.players[0].credits).toBeCloseTo(start + 1, 9);
    expect(sim.state.players[1].credits).toBeCloseTo(start + 1, 9);
    tickN(sim, 9 * SIM_TICK_RATE); // nine more
    expect(sim.state.players[0].credits).toBeCloseTo(start + 10, 9);
  });

  it('a build deducts the unit cost and queues it', () => {
    const sim = new GameSimulation({ seed: 33 });
    const cost = sim.balance.units.hovertank.cost;
    const start = sim.balance.economy.startingCredits;
    const events = sim.tick(IDLE, [buildCmd(0, 'hovertank')]);
    expect(events).toContainEqual({ type: 'unitQueued', player: 0, unit: 'hovertank' });
    // Income for this tick is added after the deduction.
    expect(sim.state.players[0].credits).toBeCloseTo(start - cost + 1 / SIM_TICK_RATE, 9);
    expect(sim.state.players[0].queue).toHaveLength(1);
    expect(sim.state.players[0].queue[0].unit).toBe('hovertank');
  });

  it('an unaffordable build is rejected with no deduction', () => {
    const sim = new GameSimulation({ seed: 34 });
    const start = sim.balance.economy.startingCredits;
    expect(sim.balance.units.dreadnought.cost).toBeGreaterThan(start);
    const events = sim.tick(IDLE, [buildCmd(0, 'dreadnought')]);
    expect(events).toContainEqual({
      type: 'buildRejected',
      player: 0,
      unit: 'dreadnought',
      reason: 'credits',
    });
    expect(sim.state.players[0].credits).toBeCloseTo(start + 1 / SIM_TICK_RATE, 9);
    expect(sim.state.players[0].queue).toHaveLength(0);
  });

  it('the queue holds at most 3 items', () => {
    const sim = new GameSimulation({ seed: 35, balance: TEST_BALANCE });
    const cmds = [buildCmd(0), buildCmd(0), buildCmd(0), buildCmd(0)];
    const events = sim.tick(IDLE, cmds);
    expect(events.filter((e) => e.type === 'unitQueued')).toHaveLength(3);
    expect(events).toContainEqual({
      type: 'buildRejected',
      player: 0,
      unit: 'hovertank',
      reason: 'queueFull',
    });
    expect(sim.state.players[0].queue).toHaveLength(sim.balance.queueMax);
  });

  it('alive + queued units are capped at 8', () => {
    const sim = new GameSimulation({ seed: 36, balance: TEST_BALANCE });
    const cap = sim.balance.unitCap;
    let capRejected = false;
    let accepted = 0;
    for (let i = 0; i < 300 && !capRejected; i++) {
      const events = sim.tick(IDLE, [buildCmd(0, 'hovertank')]);
      for (const e of events) {
        if (e.type === 'unitQueued') accepted++;
        if (e.type === 'buildRejected' && e.reason === 'unitCap') capRejected = true;
      }
      const inFlight = aliveUnitCount(sim.state, 0) + sim.state.players[0].queue.length;
      expect(inFlight).toBeLessThanOrEqual(cap);
    }
    expect(capRejected).toBe(true);
    expect(accepted).toBe(cap);
    expect(aliveUnitCount(sim.state, 0) + sim.state.players[0].queue.length).toBe(cap);
  });
});

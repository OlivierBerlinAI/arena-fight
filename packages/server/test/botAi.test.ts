import { describe, expect, it } from 'vitest';
import { GameSimulation, TEST_BALANCE } from '@mech-arena-fight/shared';
import { BOT_TUNING, chooseBuild, chooseInput } from '../src/bot/ai';

describe('bot ai', () => {
  it('builds a unit when it can afford one', () => {
    const sim = new GameSimulation({ seed: 1, balance: TEST_BALANCE });
    const unit = chooseBuild(sim.snapshot(), 1, sim.balance);
    expect(unit === 'hovertank' || unit === 'dreadnought').toBe(true); // rich test preset
  });

  it('does not build while the queue is full', () => {
    const sim = new GameSimulation({ seed: 1, balance: TEST_BALANCE });
    sim.state.players[1].queue = Array.from({ length: sim.balance.queueMax }, () => ({
      unit: 'hovertank' as const,
      ticksLeft: 10,
      totalTicks: 10,
    }));
    expect(chooseBuild(sim.snapshot(), 1, sim.balance)).toBeNull();
  });

  it('returns idle input while dead', () => {
    const sim = new GameSimulation({ seed: 2, balance: TEST_BALANCE });
    sim.state.mechs[1].alive = false;
    const input = chooseInput(sim.snapshot(), 1, sim.balance, BOT_TUNING.normal);
    expect(input.mx).toBe(0);
    expect(input.mz).toBe(0);
    expect(input.fire).toBe(false);
  });

  it('fires at and faces an enemy mech in range', () => {
    const sim = new GameSimulation({ seed: 3, balance: TEST_BALANCE });
    for (let i = 0; i < sim.balance.mech.spawnProtectionTicks + 1; i++) sim.tick();
    sim.state.mechs[1].pos = { x: 0, z: 0 };
    sim.state.mechs[0].pos = { x: 6, z: 0 }; // enemy 6 units east, within engage range
    const input = chooseInput(sim.snapshot(), 1, sim.balance, BOT_TUNING.hard);
    expect(input.fire).toBe(true);
    expect(input.aimX).toBeGreaterThan(1); // hard aims exactly at the enemy (+x)
  });

  it('drives toward an objective when no target is near', () => {
    const sim = new GameSimulation({ seed: 4, balance: TEST_BALANCE });
    sim.state.mechs[0].pos = { x: 200, z: 200 }; // enemy far away
    const input = chooseInput(sim.snapshot(), 1, sim.balance, BOT_TUNING.normal);
    expect(Math.hypot(input.mx, input.mz)).toBeGreaterThan(0.5); // moving somewhere
  });
});

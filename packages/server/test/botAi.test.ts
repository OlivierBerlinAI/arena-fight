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

  it('lobs rockets at a target in range (normal/hard) but not on easy', () => {
    const sim = new GameSimulation({ seed: 6, balance: TEST_BALANCE });
    for (let i = 0; i < sim.balance.mech.spawnProtectionTicks + 1; i++) sim.tick();
    sim.state.mechs[1].pos = { x: 0, z: 0 };
    sim.state.mechs[0].pos = { x: 8, z: 0 }; // enemy 8 units away — within rocket range
    const hard = chooseInput(sim.snapshot(), 1, sim.balance, BOT_TUNING.hard);
    expect(hard.alt).toBe(true);
    expect(hard.mode).toBe('walker'); // walker so rockets are usable
    const easy = chooseInput(sim.snapshot(), 1, sim.balance, BOT_TUNING.easy);
    expect(easy.alt).toBe(false);
  });

  it('glides in hover toward a distant goal when nothing is near (normal/hard only)', () => {
    const sim = new GameSimulation({ seed: 7, balance: TEST_BALANCE });
    sim.state.mechs[0].pos = { x: 200, z: 200 }; // enemy far → long travel to the objective
    // The bot already owns its in-base "last defense" turret, so the only goals
    // left are far away — otherwise it would just step over to capture it.
    for (const t of sim.state.turrets) {
      if (t.pos.x === 40 && t.pos.z === 40) t.owner = 1;
    }
    const hard = chooseInput(sim.snapshot(), 1, sim.balance, BOT_TUNING.hard);
    expect(hard.mode).toBe('hover');
    const easy = chooseInput(sim.snapshot(), 1, sim.balance, BOT_TUNING.easy);
    expect(easy.mode).toBe('walker'); // easy never hovers
  });

  it('navigates its mech out of the walled base instead of into a wall', () => {
    const sim = new GameSimulation({ seed: 5, balance: TEST_BALANCE });
    for (let i = 0; i < sim.balance.mech.spawnProtectionTicks + 1; i++) sim.tick();
    // Player 0 idles in its base; only the bot (player 1) drives.
    const start = { ...sim.state.mechs[1].pos };
    let escaped = false;
    for (let i = 0; i < 1500 && !escaped; i++) {
      const input = chooseInput(sim.snapshot(), 1, sim.balance, BOT_TUNING.hard);
      sim.tick([null, input]);
      const p = sim.state.mechs[1].pos;
      // Out through the inner gate and clear of the base zone (x,z ∈ [32,60]).
      escaped = p.x < 30 && p.z < 30;
    }
    const end = sim.state.mechs[1].pos;
    expect(escaped).toBe(true);
    // And it actually travelled (didn't just jitter against the wall).
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeGreaterThan(20);
  });
});

import { describe, expect, it } from 'vitest';
import { GameSimulation, TEST_BALANCE, aliveUnitCount } from '@precinct/shared';
import type { SimCommand } from '@precinct/shared';
import { buildCmd, expectAllFinite, makeInput } from './helpers';

describe('stability at maximum entity count', () => {
  it('survives hundreds of ticks with both players at the unit cap and both mechs firing', () => {
    const sim = new GameSimulation({ seed: 99, balance: TEST_BALANCE });
    const cap = sim.balance.unitCap;
    let maxUnitsSeen = 0;

    for (let i = 0; i < 600; i++) {
      const t = sim.state.tick;
      const m0 = sim.state.mechs[0];
      const m1 = sim.state.mechs[1];
      // Both mechs roam and unload both weapons at each other.
      const in0 = makeInput({
        mx: Math.sin(t / 17),
        mz: Math.cos(t / 23),
        aimX: m1.pos.x,
        aimZ: m1.pos.z,
        fire: true,
        alt: t % 90 < 45,
      });
      const in1 = makeInput({
        mx: -Math.sin(t / 19),
        mz: -Math.cos(t / 29),
        aimX: m0.pos.x,
        aimZ: m0.pos.z,
        fire: true,
        alt: t % 70 < 35,
      });
      // Both factories keep building toward the cap (rejections are fine).
      const cmds: SimCommand[] =
        t % 5 === 0
          ? [buildCmd(0, t % 2 === 0 ? 'dreadnought' : 'hovertank'), buildCmd(1, 'hovertank')]
          : [];

      sim.tick([in0, in1], cmds);

      maxUnitsSeen = Math.max(maxUnitsSeen, sim.state.units.length);
      for (const p of [0, 1] as const) {
        expect(aliveUnitCount(sim.state, p) + sim.state.players[p].queue.length).toBeLessThanOrEqual(cap);
      }
      if (i % 25 === 0) expectAllFinite(sim);
    }

    expectAllFinite(sim);
    // The field really filled up with robots while the projectile count stayed bounded.
    expect(maxUnitsSeen).toBeGreaterThan(cap);
    expect(sim.state.units.length).toBeLessThanOrEqual(2 * cap);
    expect(sim.state.projectiles.length).toBeLessThan(1000);
  });
});

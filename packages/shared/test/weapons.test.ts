import { describe, expect, it } from 'vitest';
import { GameSimulation, TEST_BALANCE } from '@precinct/shared';
import { deployUnits, makeInput, projectileTracker, teleportMech, tickN } from './helpers';

describe('gatling', () => {
  it('fires at the configured cadence, overheats, locks out, and resumes', () => {
    const sim = new GameSimulation({ seed: 7 });
    const g = sim.balance.gatling;
    teleportMech(sim, 0, { x: 0, z: 0 });
    const fresh = projectileTracker(sim, 'gatling');
    const firing = makeInput({ fire: true, aimX: 10, aimZ: 10 });

    // Hold fire until the gatling overheats.
    const spawnTicks: number[] = [];
    let locked = false;
    let peakHeat = 0;
    for (let i = 0; i < 1000 && !locked; i++) {
      const t = sim.state.tick;
      sim.tick([firing, null]);
      if (fresh().length > 0) spawnTicks.push(t);
      peakHeat = Math.max(peakHeat, sim.state.mechs[0].heat);
      locked = sim.state.mechs[0].overheatedUntilTick > sim.state.tick;
    }
    expect(locked).toBe(true);
    expect(spawnTicks.length).toBeGreaterThan(10);
    for (let i = 1; i < spawnTicks.length; i++) {
      expect(spawnTicks[i] - spawnTicks[i - 1]).toBe(g.intervalTicks);
    }
    expect(peakHeat).toBeGreaterThanOrEqual(g.overheatAt);
    const lockUntil = sim.state.mechs[0].overheatedUntilTick;
    expect(lockUntil - spawnTicks[spawnTicks.length - 1]).toBe(g.overheatLockTicks);

    // During the lockout no projectiles spawn even though fire is held...
    const heatAtLock = sim.state.mechs[0].heat;
    while (sim.state.tick < lockUntil) {
      sim.tick([firing, null]);
      expect(fresh()).toHaveLength(0);
    }
    // ...heat cooled down meanwhile...
    const heatAfterLock = sim.state.mechs[0].heat;
    expect(heatAfterLock).toBeLessThan(heatAtLock);
    // ...and firing resumes on the first unlocked tick, heat rising again.
    sim.tick([firing, null]);
    expect(fresh()).toHaveLength(1);
    expect(sim.state.mechs[0].heat).toBeGreaterThan(heatAfterLock);
  });

  it('cools back to zero while not firing', () => {
    const sim = new GameSimulation({ seed: 8 });
    teleportMech(sim, 0, { x: 0, z: 0 });
    const firing = makeInput({ fire: true, aimX: 10, aimZ: 10 });
    tickN(sim, 15, [firing, null]);
    const heatAfterBurst = sim.state.mechs[0].heat;
    expect(heatAfterBurst).toBeGreaterThan(0);
    tickN(sim, 30); // idle
    expect(sim.state.mechs[0].heat).toBe(0);
  });
});

describe('rockets', () => {
  it('fires a 3-rocket magazine with cooldown, then reloads', () => {
    const sim = new GameSimulation({ seed: 9 });
    const r = sim.balance.rocket;
    expect(sim.state.mechs[0].rocketAmmo).toBe(r.magazine);
    teleportMech(sim, 0, { x: 0, z: 0 });
    const fresh = projectileTracker(sim, 'rocket');
    const firing = makeInput({ alt: true, aimX: 30, aimZ: 0 });

    const spawnTicks: number[] = [];
    const total = r.cooldownTicks * 3 + r.reloadTicks + 20;
    for (let i = 0; i < total; i++) {
      const t = sim.state.tick;
      sim.tick([firing, null]);
      if (fresh().length > 0) spawnTicks.push(t);
    }
    expect(spawnTicks.length).toBeGreaterThanOrEqual(5);
    // Magazine of 3 with cooldown spacing...
    expect(spawnTicks[1] - spawnTicks[0]).toBe(r.cooldownTicks);
    expect(spawnTicks[2] - spawnTicks[1]).toBe(r.cooldownTicks);
    // ...then the launcher reloads (reloadTicks > cooldownTicks)...
    expect(spawnTicks[3] - spawnTicks[2]).toBe(r.reloadTicks);
    // ...and the next magazine fires at cooldown cadence again.
    expect(spawnTicks[4] - spawnTicks[3]).toBe(r.cooldownTicks);
  });

  it('right-fire spawns exactly one rocket per press', () => {
    const sim = new GameSimulation({ seed: 10 });
    teleportMech(sim, 0, { x: 0, z: 0 });
    const fresh = projectileTracker(sim, 'rocket');
    sim.tick([makeInput({ alt: true, aimX: 30, aimZ: 0 }), null]);
    expect(fresh()).toHaveLength(1);
    expect(sim.state.mechs[0].rocketAmmo).toBe(sim.balance.rocket.magazine - 1);
    tickN(sim, 10); // alt released
    expect(fresh()).toHaveLength(0);
  });

  it('applies splash damage with falloff: direct > nearby > 0, none outside radius', () => {
    const sim = new GameSimulation({ seed: 11, balance: TEST_BALANCE });
    const r = sim.balance.rocket;
    const unitHp = sim.balance.units.hovertank.hp;
    const unitRadius = sim.balance.units.hovertank.radius;

    // Three real enemy hovertanks, built through the factory.
    const [a, b, c] = deployUnits(sim, 1, 'hovertank', 3);
    // Let mech 0's spawn protection expire so the units engage it and stand still.
    while (sim.state.tick <= sim.state.mechs[0].protectedUntilTick) sim.tick();

    teleportMech(sim, 0, { x: 0, z: 0 });
    a.pos = { x: 4, z: 0 }; // direct hit
    b.pos = { x: 6, z: 0 }; // inside splash radius of the detonation
    c.pos = { x: 0, z: 7 }; // outside splash radius, still in the units' own range

    // One rocket aimed straight at unit A.
    sim.tick([makeInput({ alt: true, aimX: 4, aimZ: 0 }), null]);
    tickN(sim, 6);

    // Direct hit: full damage, no extra splash on the same entity.
    expect(a.hp).toBe(unitHp - r.damage);

    // Detonation point is A's near edge at x = 4 - unitRadius.
    const hitX = 4 - unitRadius;
    const dB = 6 - hitX;
    expect(dB).toBeLessThan(r.splashRadius);
    const expectedB = r.damage * Math.max(r.splashMinFactor, 1 - dB / r.splashRadius);
    expect(unitHp - b.hp).toBeCloseTo(expectedB, 5);
    expect(unitHp - b.hp).toBeGreaterThan(0);
    expect(unitHp - b.hp).toBeLessThan(unitHp - a.hp); // falloff: less than direct

    // Outside the splash radius: untouched.
    expect(c.hp).toBe(unitHp);
  });
});

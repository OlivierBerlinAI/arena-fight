import { describe, expect, it } from 'vitest';
import { DEFAULT_BALANCE, GameSimulation } from '@mech-arena-fight/shared';
import type { ProjectileKind } from '@mech-arena-fight/shared';
import { tickN } from './helpers';

// The west turret sits at (-52, 0) with a body radius of 1.3.
const TURRET_POS = { x: -52, z: 0 };

/** Fire one projectile of `kind` (damage 10) into an enemy-owned turret and
 *  return how much HP it lost after the hit resolves. */
function turretDamageFrom(kind: ProjectileKind): number {
  const sim = new GameSimulation({ seed: 11 });
  tickN(sim, sim.balance.mech.spawnProtectionTicks + 1);
  const turret = sim.state.turrets[0];
  turret.owner = 1; // owned by player 1 → destructible, and an enemy of player 0
  const before = turret.hp;
  // A point-blank shot from player 0 that crosses the tower this tick.
  sim.state.projectiles.push({
    id: 9999,
    owner: 0,
    kind,
    pos: { x: TURRET_POS.x + 1.7, z: 0 },
    vel: { x: -30, z: 0 },
    damage: 10,
    splashRadius: 0,
    diesAtTick: sim.state.tick + 100,
  });
  sim.tick();
  return before - sim.state.turrets[0].hp;
}

describe('per-weapon damage modifiers', () => {
  it('resolves the config into a full weapon×target grid defaulting to 1', () => {
    const m = DEFAULT_BALANCE.damageModifiers;
    expect(m.laser.turret).toBe(0.5); // the one configured exception
    expect(m.laser.mech).toBe(1);
    expect(m.laser.unit).toBe(1);
    expect(m.gatling.turret).toBe(1);
    expect(m.rocket.turret).toBe(1);
  });

  it('a laser does half damage to turrets; a gatling does full', () => {
    expect(turretDamageFrom('laser')).toBeCloseTo(5, 9); // 10 × 0.5
    expect(turretDamageFrom('gatling')).toBeCloseTo(10, 9); // 10 × 1
  });
});

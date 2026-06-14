import { describe, expect, it } from 'vitest';
import { GameSimulation } from '@mech-arena-fight/shared';
import {
  driveToward,
  projectileTracker,
  runUntilEvent,
  teleportMech,
  tickN,
} from './helpers';

// Turret 0 sits at (-52, 0); (-49, 0) is on its capture pad (padRadius 3.5)
// but outside its body collision radius.
const PAD_SPOT = { x: -49, z: 0 };

describe('turret capture', () => {
  it('mech driven out of its base onto the pad captures the turret', () => {
    const sim = new GameSimulation({ seed: 21 });
    // Real inputs: out through the own gate, then to the west turret pad.
    driveToward(sim, 0, { x: -30, z: -30 }, { tol: 2, maxTicks: 600 });
    driveToward(sim, 0, PAD_SPOT, { tol: 1, maxTicks: 600 });
    const { event } = runUntilEvent(sim, 'turretCaptured', sim.balance.turret.captureTicks + 90);
    expect(event.turretId).toBe(0);
    expect(event.player).toBe(0);
    expect(sim.state.turrets[0].owner).toBe(0);
    expect(sim.state.players[0].stats.turretCaptures).toBe(1);
  });

  it('accumulates 1 progress per tick and flips exactly at captureTicks', () => {
    const sim = new GameSimulation({ seed: 22 });
    const captureTicks = sim.balance.turret.captureTicks;
    teleportMech(sim, 0, PAD_SPOT);
    const events = tickN(sim, captureTicks - 1);
    expect(events.some((e) => e.type === 'turretCaptured')).toBe(false);
    expect(sim.state.turrets[0].capProgress).toBe(captureTicks - 1);
    expect(sim.state.turrets[0].capOwner).toBe(0);
    expect(sim.state.turrets[0].owner).toBe(-1);
    const last = sim.tick();
    expect(last).toContainEqual({ type: 'turretCaptured', turretId: 0, player: 0 });
    expect(sim.state.turrets[0].owner).toBe(0);
  });

  it('leaving the pad early decays progress — interruption means no capture', () => {
    const sim = new GameSimulation({ seed: 23 });
    teleportMech(sim, 0, PAD_SPOT);
    tickN(sim, 45);
    expect(sim.state.turrets[0].capProgress).toBe(45);
    teleportMech(sim, 0, { x: 0, z: 0 }); // step off
    const events = tickN(sim, 23); // decays at 2/tick
    expect(sim.state.turrets[0].capProgress).toBe(0);
    expect(sim.state.turrets[0].capOwner).toBe(-1);
    const later = tickN(sim, 30);
    expect([...events, ...later].some((e) => e.type === 'turretCaptured')).toBe(false);
    expect(sim.state.turrets[0].owner).toBe(-1);
  });

  it('enemy drains an owned turret to neutral, then captures it', () => {
    const sim = new GameSimulation({ seed: 24 });
    const captureTicks = sim.balance.turret.captureTicks;
    teleportMech(sim, 0, PAD_SPOT);
    runUntilEvent(sim, 'turretCaptured', captureTicks + 5);
    expect(sim.state.turrets[0].owner).toBe(0);

    // Player 0 leaves; player 1 stands on the now-owned pad.
    teleportMech(sim, 0, { x: -53, z: -42 });
    teleportMech(sim, 1, PAD_SPOT);

    const drained = runUntilEvent(sim, 'turretNeutralized', captureTicks + 10);
    expect(drained.event.turretId).toBe(0);
    expect(drained.event.byPlayer).toBe(1);
    expect(drained.ticks).toBe(captureTicks); // drains 1/tick from full hold
    expect(sim.state.turrets[0].owner).toBe(-1);

    const captured = runUntilEvent(sim, 'turretCaptured', captureTicks + 10);
    expect(captured.event.player).toBe(1);
    expect(captured.ticks).toBe(captureTicks);
    expect(sim.state.turrets[0].owner).toBe(1);
    // The defending turret shot at the capturing mech but could not kill it in time.
    expect(sim.state.mechs[1].alive).toBe(true);
    expect(sim.state.mechs[1].hp).toBeLessThan(sim.balance.mech.maxHp);
  });

  it('both mechs on the pad pauses capture progress', () => {
    const sim = new GameSimulation({ seed: 25 });
    teleportMech(sim, 0, PAD_SPOT);
    tickN(sim, 45);
    expect(sim.state.turrets[0].capProgress).toBe(45);

    teleportMech(sim, 1, { x: -52, z: 3 }); // also on the pad, clear of mech 0
    const contested = tickN(sim, 30);
    expect(sim.state.turrets[0].capProgress).toBe(45); // frozen
    expect(sim.state.turrets[0].capOwner).toBe(0);
    expect(contested.some((e) => e.type === 'turretCaptured' || e.type === 'turretNeutralized')).toBe(false);

    teleportMech(sim, 1, { x: 0, z: 0 }); // contester leaves, progress resumes
    const { ticks } = runUntilEvent(sim, 'turretCaptured', 50);
    expect(ticks).toBe(45);
    expect(sim.state.turrets[0].owner).toBe(0);
  });

  it('an owned turret pays +1 credit per second extra', () => {
    const sim = new GameSimulation({ seed: 26 });
    sim.state.turrets[0].owner = 0;
    const before0 = sim.state.players[0].credits;
    const before1 = sim.state.players[1].credits;
    tickN(sim, 300); // 10 simulated seconds
    const eco = sim.balance.economy;
    expect(sim.state.players[0].credits - before0).toBeCloseTo(
      10 * (eco.passivePerSecond + eco.perTurretPerSecond),
      6
    );
    expect(sim.state.players[1].credits - before1).toBeCloseTo(10 * eco.passivePerSecond, 6);
  });

  it('an owned turret fires at an enemy mech in range', () => {
    const sim = new GameSimulation({ seed: 27 });
    // Let spawn protection expire first.
    tickN(sim, sim.balance.mech.spawnProtectionTicks + 1);
    sim.state.turrets[0].owner = 0;
    teleportMech(sim, 1, { x: -42, z: 0 }); // 10 units away, range is 17
    const fresh = projectileTracker(sim, 'turret');
    let shots = 0;
    for (let i = 0; i < 60; i++) {
      sim.tick();
      shots += fresh().length;
    }
    expect(shots).toBeGreaterThanOrEqual(2);
    expect(sim.state.mechs[1].hp).toBeLessThan(sim.balance.mech.maxHp);
  });
});

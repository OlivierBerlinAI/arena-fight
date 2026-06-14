import { describe, expect, it } from 'vitest';
import { GAME_MAP, GameSimulation, len } from '@mech-arena-fight/shared';
import { makeInput, penetratesAnyWall, teleportMech } from './helpers';

describe('mech movement', () => {
  it('moves with input and never exceeds maxSpeed', () => {
    const sim = new GameSimulation({ seed: 1 });
    teleportMech(sim, 0, { x: 0, z: 0 });
    const input = makeInput({ mx: 1 });
    let topSpeed = 0;
    for (let i = 0; i < 60; i++) {
      sim.tick([input, null]);
      topSpeed = Math.max(topSpeed, len(sim.state.mechs[0].vel));
    }
    const mech = sim.state.mechs[0];
    expect(mech.pos.x).toBeGreaterThan(10); // it actually went somewhere
    expect(Math.abs(mech.pos.z)).toBeLessThan(1e-9); // straight line
    expect(topSpeed).toBeGreaterThan(5);
    expect(topSpeed).toBeLessThanOrEqual(sim.balance.mech.maxSpeed + 1e-9);
  });

  it('stays put without input', () => {
    const sim = new GameSimulation({ seed: 2 });
    teleportMech(sim, 0, { x: 5, z: -5 });
    for (let i = 0; i < 30; i++) sim.tick();
    expect(sim.state.mechs[0].pos.x).toBeCloseTo(5, 9);
    expect(sim.state.mechs[0].pos.z).toBeCloseTo(-5, 9);
  });

  it('driving into a cover block never penetrates it', () => {
    const sim = new GameSimulation({ seed: 3 });
    const r = sim.balance.mech.radius;
    // Cover block centered at (-26, 8) spans z in [5.5, 10.5].
    teleportMech(sim, 0, { x: -26, z: 0 });
    const north = makeInput({ mz: 1 });
    for (let i = 0; i < 150; i++) {
      sim.tick([north, null]);
      expect(penetratesAnyWall(sim.state.mechs[0].pos, r)).toBe(false);
    }
    const pos = sim.state.mechs[0].pos;
    expect(pos.z).toBeLessThanOrEqual(5.5 - r + 1e-6); // pinned against the face
    expect(pos.z).toBeGreaterThan(4.0); // ...and actually reached it
    expect(pos.x).toBeCloseTo(-26, 6);
  });

  it('cannot leave the arena through the boundary wall', () => {
    const sim = new GameSimulation({ seed: 4 });
    const r = sim.balance.mech.radius;
    const limit = GAME_MAP.size / 2 - r; // 58.9 with the boundary wall at x = -60
    teleportMech(sim, 0, { x: 0, z: 14 });
    const west = makeInput({ mx: -1 });
    for (let i = 0; i < 300; i++) {
      sim.tick([west, null]);
      expect(sim.state.mechs[0].pos.x).toBeGreaterThanOrEqual(-limit - 1e-6);
      expect(penetratesAnyWall(sim.state.mechs[0].pos, r)).toBe(false);
    }
    expect(sim.state.mechs[0].pos.x).toBeLessThan(-58); // reached the wall and stopped
  });

  it('never penetrates any wall while roaming in all directions', () => {
    const sim = new GameSimulation({ seed: 5 });
    const r = sim.balance.mech.radius;
    const dirs: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    for (const [mx, mz] of dirs) {
      teleportMech(sim, 0, { x: 0, z: 0 });
      const input = makeInput({ mx, mz });
      for (let i = 0; i < 200; i++) {
        sim.tick([input, null]);
        const pos = sim.state.mechs[0].pos;
        expect(penetratesAnyWall(pos, r)).toBe(false);
        expect(Math.abs(pos.x)).toBeLessThanOrEqual(GAME_MAP.size / 2 - r + 1e-6);
        expect(Math.abs(pos.z)).toBeLessThanOrEqual(GAME_MAP.size / 2 - r + 1e-6);
      }
    }
  });
});

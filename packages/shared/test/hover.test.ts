import { describe, expect, it } from 'vitest';
import { GameSimulation, len } from '@mech-arena-fight/shared';
import type { PlayerInput } from '@mech-arena-fight/shared';
import { makeInput, projectileTracker, teleportMech, tickN } from './helpers';

describe('hover mode — movement', () => {
  it('glides faster than the walker and stays under the hover cap', () => {
    const walkerTop = topSpeed(makeInput({ mx: 1, mode: 'walker' }));
    const hoverTop = topSpeed(makeInput({ mx: 1, mode: 'hover' }));

    const b = new GameSimulation({ seed: 1 }).balance.mech;
    // walker tops out at its own cap...
    expect(walkerTop).toBeLessThanOrEqual(b.maxSpeed + 1e-6);
    // ...hover glides meaningfully faster, bounded by the hover cap.
    expect(hoverTop).toBeGreaterThan(b.maxSpeed + 0.5);
    expect(hoverTop).toBeLessThanOrEqual(b.hoverMaxSpeed + 1e-6);
    expect(hoverTop).toBeGreaterThan(walkerTop + 1);
  });

  it('low hover drag keeps the mech gliding after input stops', () => {
    const sim = new GameSimulation({ seed: 2 });
    teleportMech(sim, 0, { x: 0, z: -10 });
    // build up speed hovering north, then release the movement keys
    tickN(sim, 25, [makeInput({ mz: 1, mode: 'hover' }), null]);
    const movingSpeed = len(sim.state.mechs[0].vel);
    expect(movingSpeed).toBeGreaterThan(8);

    // One coasting tick (no input) in hover retains far more momentum than the
    // walker's friction would (drag only touches velocity, so this holds even
    // if the glide brushes a wall).
    sim.tick([makeInput({ mode: 'hover' }), null]);
    const hoverRetain = len(sim.state.mechs[0].vel) / movingSpeed;

    const walkerSim = new GameSimulation({ seed: 2 });
    teleportMech(walkerSim, 0, { x: 0, z: -10 });
    tickN(walkerSim, 25, [makeInput({ mz: 1, mode: 'walker' }), null]);
    const walkerMoving = len(walkerSim.state.mechs[0].vel);
    walkerSim.tick([makeInput({ mode: 'walker' }), null]);
    const walkerRetain = len(walkerSim.state.mechs[0].vel) / walkerMoving;

    expect(hoverRetain).toBeGreaterThan(walkerRetain + 0.03);
    expect(hoverRetain).toBeGreaterThan(0.88);
  });
});

describe('hover mode — weapons', () => {
  it('fires the laser (not the gatling) as its primary', () => {
    const sim = new GameSimulation({ seed: 7 });
    teleportMech(sim, 0, { x: 0, z: 0 });
    const lasers = projectileTracker(sim, 'laser');
    const gatlings = projectileTracker(sim, 'gatling');
    const firing = makeInput({ fire: true, aimX: 10, aimZ: 10, mode: 'hover' });

    let laserCount = 0;
    let gatlingCount = 0;
    for (let i = 0; i < 30; i++) {
      sim.tick([firing, null]);
      laserCount += lasers().length;
      gatlingCount += gatlings().length;
    }
    expect(laserCount).toBeGreaterThan(3);
    expect(gatlingCount).toBe(0);
    // shares the heat meter, so sustained fire still heats up
    expect(sim.state.mechs[0].heat).toBeGreaterThan(0);
  });

  it('fires the gatling (not the laser) in walker mode', () => {
    const sim = new GameSimulation({ seed: 8 });
    teleportMech(sim, 0, { x: 0, z: 0 });
    const lasers = projectileTracker(sim, 'laser');
    const gatlings = projectileTracker(sim, 'gatling');
    const firing = makeInput({ fire: true, aimX: 10, aimZ: 10, mode: 'walker' });

    let laserCount = 0;
    let gatlingCount = 0;
    for (let i = 0; i < 30; i++) {
      sim.tick([firing, null]);
      laserCount += lasers().length;
      gatlingCount += gatlings().length;
    }
    expect(gatlingCount).toBeGreaterThan(3);
    expect(laserCount).toBe(0);
  });

  it('locks rockets while hovering, then allows them again as a walker', () => {
    const sim = new GameSimulation({ seed: 9 });
    teleportMech(sim, 0, { x: 0, z: 0 });
    const rockets = projectileTracker(sim, 'rocket');
    const startAmmo = sim.state.mechs[0].rocketAmmo;

    // Hold the rocket button in hover: nothing should launch and ammo is intact.
    let launched = 0;
    for (let i = 0; i < 12; i++) {
      sim.tick([makeInput({ alt: true, aimX: 30, aimZ: 0, mode: 'hover' }), null]);
      launched += rockets().length;
    }
    expect(launched).toBe(0);
    expect(sim.state.mechs[0].rocketAmmo).toBe(startAmmo);

    // Drop to walker and the very next press launches a rocket.
    sim.tick([makeInput({ alt: true, aimX: 30, aimZ: 0, mode: 'walker' }), null]);
    expect(rockets().length).toBe(1);
    expect(sim.state.mechs[0].rocketAmmo).toBe(startAmmo - 1);
  });
});

describe('hover mode — state plumbing', () => {
  it('round-trips the mode through the wire snapshot', () => {
    const sim = new GameSimulation({ seed: 10 });
    sim.tick([makeInput({ mode: 'hover' }), makeInput({ mode: 'walker' })]);
    const snap = sim.snapshot();
    expect(snap.mechs[0].mode).toBe('hover');
    expect(snap.mechs[1].mode).toBe('walker');
    // toggling back is reflected next tick
    sim.tick([makeInput({ mode: 'walker' }), null]);
    expect(sim.snapshot().mechs[0].mode).toBe('walker');
  });

  it('stays deterministic when the script toggles modes', () => {
    const script = (t: number): [PlayerInput, PlayerInput] => [
      makeInput({
        mx: Math.sin(t / 11),
        mz: Math.cos(t / 9),
        fire: t % 6 < 3,
        alt: t % 20 < 4,
        mode: t % 40 < 20 ? 'hover' : 'walker',
      }),
      makeInput({ mx: -Math.cos(t / 13), mode: t % 30 < 15 ? 'hover' : 'walker', fire: t % 5 < 2 }),
    ];
    const run = (): string => {
      const sim = new GameSimulation({ seed: 4242 });
      for (let i = 0; i < 600; i++) sim.tick(script(sim.state.tick));
      return sim.hash();
    };
    expect(run()).toBe(run());
  });
});

function topSpeed(input: PlayerInput): number {
  const sim = new GameSimulation({ seed: 1 });
  teleportMech(sim, 0, { x: 0, z: 0 });
  let top = 0;
  for (let i = 0; i < 40; i++) {
    sim.tick([input, null]);
    top = Math.max(top, len(sim.state.mechs[0].vel));
  }
  return top;
}

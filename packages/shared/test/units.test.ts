import { describe, expect, it } from 'vitest';
import { GAME_MAP, GameSimulation, TEST_BALANCE, dist, laneWaypoints } from '@mech-arena-fight/shared';
import type { SimEvent } from '@mech-arena-fight/shared';
import {
  IDLE,
  buildCmd,
  deployUnits,
  makeInput,
  projectileTracker,
  runUntilEvent,
  teleportMech,
  tickN,
} from './helpers';

describe('factory and units', () => {
  it('build queues the unit and deploys it at the unit spawn after buildTicks', () => {
    const sim = new GameSimulation({ seed: 41, balance: TEST_BALANCE });
    const buildTicks = sim.balance.units.hovertank.buildTicks;
    const first = sim.tick(IDLE, [buildCmd(0, 'hovertank')]);
    expect(first).toContainEqual({ type: 'unitQueued', player: 0, unit: 'hovertank' });

    // The command tick already advanced the build by one tick.
    const { event, ticks } = runUntilEvent(sim, 'unitDeployed', buildTicks + 5);
    expect(ticks).toBe(buildTicks - 1);
    expect(event.player).toBe(0);
    expect(event.unit).toBe('hovertank');

    expect(sim.state.units).toHaveLength(1);
    const unit = sim.state.units[0];
    expect(unit.id).toBe(event.unitId);
    expect(unit.owner).toBe(0);
    expect(unit.hp).toBe(sim.balance.units.hovertank.hp);
    expect(dist(unit.pos, GAME_MAP.bases[0].unitSpawn)).toBeLessThan(2);
    expect(sim.state.players[0].queue).toHaveLength(0);
  });

  it('a hovertank follows its lane and wins by reaching the enemy core pad', () => {
    const sim = new GameSimulation({ seed: 42, balance: TEST_BALANCE });
    teleportMech(sim, 1, { x: 40, z: -40 }); // keep the enemy mech off the lane
    sim.tick(IDLE, [buildCmd(0, 'hovertank')]);
    const { event: deployed } = runUntilEvent(sim, 'unitDeployed', 100);

    const waypoints = laneWaypoints(0, 'left'); // first build takes the left lane
    const minDist = waypoints.map(() => Infinity);
    let endEvent: Extract<SimEvent, { type: 'matchEnd' }> | null = null;
    for (let i = 0; i < 2000 && sim.state.phase === 'playing'; i++) {
      const events = sim.tick();
      const unit = sim.state.units.find((u) => u.id === deployed.unitId);
      if (unit) {
        for (let w = 0; w < waypoints.length; w++) {
          minDist[w] = Math.min(minDist[w], dist(unit.pos, waypoints[w]));
        }
      }
      const end = events.find((e) => e.type === 'matchEnd');
      if (end) endEvent = end;
    }

    expect(endEvent).not.toBeNull();
    expect(endEvent!.winner).toBe(0);
    expect(endEvent!.byUnitId).toBe(deployed.unitId);
    expect(sim.state.phase).toBe('ended');
    expect(sim.state.winner).toBe(0);
    // It passed close to every intermediate waypoint, in lane order.
    for (let w = 0; w < waypoints.length - 1; w++) {
      expect(minDist[w]).toBeLessThan(1.6);
    }
    // The final waypoint is the core pad itself; reaching its radius wins.
    expect(minDist[waypoints.length - 1]).toBeLessThanOrEqual(GAME_MAP.bases[1].corePad.radius);
  });

  it('the win condition fires exactly once and the sim freezes afterwards', () => {
    const sim = new GameSimulation({ seed: 43, balance: TEST_BALANCE });
    teleportMech(sim, 1, { x: 40, z: -40 });
    sim.tick(IDLE, [buildCmd(0, 'hovertank')]);
    runUntilEvent(sim, 'matchEnd', 2000);

    const tickAtEnd = sim.state.tick;
    const busyInput = makeInput({ mx: 1, fire: true, alt: true, aimX: 10, aimZ: 10 });
    for (let i = 0; i < 50; i++) {
      const events = sim.tick([busyInput, busyInput], [buildCmd(0), buildCmd(1)]);
      expect(events).toHaveLength(0); // no events ever again, matchEnd included
    }
    expect(sim.state.tick).toBe(tickAtEnd);
    expect(sim.state.phase).toBe('ended');
    expect(sim.state.winner).toBe(0);
  });

  it('a mech standing on the enemy core pad does NOT win — robots only', () => {
    const sim = new GameSimulation({ seed: 44 });
    const pad1 = GAME_MAP.bases[1].corePad;
    const pad0 = GAME_MAP.bases[0].corePad;
    teleportMech(sim, 0, { x: pad1.x, z: pad1.z });
    teleportMech(sim, 1, { x: pad0.x, z: pad0.z });
    const events = tickN(sim, 300);
    expect(events.some((e) => e.type === 'matchEnd')).toBe(false);
    expect(sim.state.phase).toBe('playing');
    expect(sim.state.winner).toBe(-1);
    // Both mechs really are on the pads the whole time.
    expect(dist(sim.state.mechs[0].pos, pad1)).toBeLessThan(pad1.radius);
    expect(dist(sim.state.mechs[1].pos, pad0)).toBeLessThan(pad0.radius);
  });
});

describe('unit AI', () => {
  it('engages enemy robots before the enemy mech, stopping to shoot', () => {
    const sim = new GameSimulation({ seed: 45, balance: TEST_BALANCE });
    const [enemyUnit] = deployUnits(sim, 1, 'hovertank', 1);
    const [ownUnit] = deployUnits(sim, 0, 'hovertank', 1);
    // Mech 0 must be a legal target (spawn protection expired) for the
    // priority order to be meaningful.
    while (sim.state.tick <= sim.state.mechs[0].protectedUntilTick) sim.tick();

    ownUnit.pos = { x: 0, z: 0 };
    enemyUnit.pos = { x: 5, z: 0 };
    teleportMech(sim, 0, { x: 4, z: 4 }); // closer to the enemy unit than ownUnit is

    const mechHpBefore = sim.state.mechs[0].hp;
    const unitHp = sim.balance.units.hovertank.hp;
    const fresh = projectileTracker(sim, 'unitLight');
    let enemyShots = 0;
    for (let i = 0; i < 30; i++) {
      sim.tick();
      enemyShots += fresh().filter((p) => p.owner === 1).length;
      // Engaged units stop moving.
      expect(enemyUnit.pos.x).toBeCloseTo(5, 6);
      expect(enemyUnit.pos.z).toBeCloseTo(0, 6);
    }
    expect(enemyShots).toBeGreaterThan(0);
    expect(enemyUnit.targetKey).toBe(`unit:${ownUnit.id}`);
    expect(ownUnit.hp).toBeLessThan(unitHp); // the robot got shot...
    expect(sim.state.mechs[0].hp).toBe(mechHpBefore); // ...the closer mech did not
  });
});

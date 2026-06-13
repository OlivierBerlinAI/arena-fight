import { describe, expect, it } from 'vitest';
import { GAME_MAP, getBalance } from '@precinct/shared';
import type { MechSnap } from '@precinct/shared';
import { LocalMechPredictor } from '../src/game/prediction';

const BALANCE = getBalance('default'); // reference tick rate
const FORWARD = { mx: 1, mz: 0, mode: 'walker' as const };
const IDLE = { mx: 0, mz: 0, mode: 'walker' as const };
const DT = 1 / 60;

function makeMech(over: Partial<MechSnap> = {}): MechSnap {
  return {
    player: 0,
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    yaw: 0,
    mode: 'walker',
    hp: 100,
    alive: true,
    heat: 0,
    overheated: false,
    rocketAmmo: 3,
    reloading: false,
    reloadFrac: 0,
    shielded: false,
    respawnInTicks: 0,
    ...over,
  };
}

describe('LocalMechPredictor', () => {
  it('takes yaw straight from the input heading (instant, exact)', () => {
    const p = new LocalMechPredictor();
    const srv = makeMech({ yaw: 0 });
    // facing heading the server has not seen yet
    const out = p.update(srv, [], 60, { mx: 0, mz: 0, mode: 'walker' }, 1.234, BALANCE, DT);
    expect(out.yaw).toBe(1.234);
  });

  it('predicts forward motion along the heading from an open spot', () => {
    const p = new LocalMechPredictor();
    let out = makeMech();
    // (0,0) is open (the turret tests park mechs there); push +x for a while.
    for (let i = 0; i < 25; i++) {
      out = p.update(makeMech({ x: 0, z: 0 }), [], 120, FORWARD, 0, BALANCE, DT);
    }
    expect(out.x).toBeGreaterThan(0.15); // advanced east of the server pose
    expect(Math.abs(out.z)).toBeLessThan(1e-9); // heading 0 ⇒ no lateral drift
    expect(out.alive).toBe(true);
  });

  it('hands back the authoritative pose while dead (no prediction)', () => {
    const p = new LocalMechPredictor();
    const dead = makeMech({ x: 5, z: -3, yaw: 1.2, alive: false });
    const out = p.update(dead, [], 100, FORWARD, 0, BALANCE, DT);
    expect(out.x).toBe(5);
    expect(out.z).toBe(-3);
    expect(out.yaw).toBe(1.2); // dead ⇒ server yaw, not the input heading
    expect(out.alive).toBe(false);
  });

  it('does not drift when idle', () => {
    const p = new LocalMechPredictor();
    const srv = makeMech({ x: 2, z: 2 });
    p.update(srv, [], 100, IDLE, 0.7, BALANCE, DT); // init
    let out = srv;
    for (let i = 0; i < 10; i++) out = p.update(srv, [], 100, IDLE, 0.7, BALANCE, DT);
    expect(out.x).toBeCloseTo(2, 6);
    expect(out.z).toBeCloseTo(2, 6);
  });

  it('respects the arena bound (static collision is wired in)', () => {
    const p = new LocalMechPredictor();
    const limit = GAME_MAP.size / 2 - 0.01;
    let out = makeMech();
    // Park near the +x boundary and shove outward: the predicted pose must stay
    // inside the arena, proving collideWithStatics runs during prediction.
    for (let i = 0; i < 40; i++) {
      out = p.update(makeMech({ x: limit - 0.5, z: 0 }), [], 150, FORWARD, 0, BALANCE, DT);
    }
    expect(out.x).toBeLessThanOrEqual(limit + 1e-6);
    expect(Number.isFinite(out.x)).toBe(true);
  });
});

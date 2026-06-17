import { describe, expect, it } from 'vitest';
import type { MechSnap, Snapshot } from '@mech-arena-fight/shared';
import { MAX_EXTRAP_MS, SnapshotBuffer } from '../src/game/interpolation';

const TICK_MS = 10; // 100 Hz

function makeMech(x: number): MechSnap {
  return {
    player: 0,
    x,
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
  };
}

function snap(tick: number, x: number): Snapshot {
  return { tick, phase: 'playing', winner: -1, mechs: [makeMech(x)], players: [], units: [], turrets: [], projectiles: [] };
}

/** A buffer with two snapshots: mech at x=0 (tick 0) and x=2 (tick 2). */
function twoSnapshots(): SnapshotBuffer {
  const buf = new SnapshotBuffer(TICK_MS);
  buf.push(snap(0, 0), 1000);
  buf.push(snap(2, 2), 1020); // 20 ms gap keeps the adaptive delay at its 55 ms floor
  return buf;
}

describe('SnapshotBuffer', () => {
  it('interpolates linearly between the two bracketing snapshots', () => {
    const buf = twoSnapshots();
    // rt = 2 + (1065-1020)/10 - 55/10 = 1.0 → halfway between x=0 and x=2.
    const view = buf.sample(1065);
    expect(view).not.toBeNull();
    expect(view!.mechs[0].x).toBeCloseTo(1, 5);
  });

  it('extrapolates past the freshest snapshot when it arrives late (no freeze)', () => {
    const buf = twoSnapshots();
    // rt = 2 + (1100-1020)/10 - 5.5 = 4.5 → 2.5 ticks past the newest snapshot.
    const view = buf.sample(1100);
    // Continuing the +1/tick trend, x should be carried beyond the last x=2.
    expect(view!.mechs[0].x).toBeGreaterThan(2);
    expect(view!.mechs[0].x).toBeCloseTo(4.5, 5);
  });

  it('bounds extrapolation so a long stall holds instead of flinging entities away', () => {
    const buf = twoSnapshots();
    const farFuture = buf.sample(1_000_000);
    // Capped at newest.tick + MAX_EXTRAP_MS/tickMs = 2 + 12 = 14 ticks → x=14.
    const maxX = 2 + (MAX_EXTRAP_MS / TICK_MS); // matches the slope of 1 unit/tick
    expect(farFuture!.mechs[0].x).toBeCloseTo(maxX, 5);
    // And never runs away beyond that bound no matter how long the stall.
    expect(farFuture!.mechs[0].x).toBeLessThanOrEqual(maxX + 1e-6);
  });
});

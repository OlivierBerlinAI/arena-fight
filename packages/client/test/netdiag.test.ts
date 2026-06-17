import { describe, expect, it, vi } from 'vitest';
import { NetDiag } from '../src/game/netdiag';
import type { RttSample } from '../src/net';

const QUIET = { frameMaxMs: 16, snapshotAgeMs: 5, renderDelayMs: 60 };

function sample(rtt: number, srvLagMs: number | null = 0): RttSample {
  return { at: 0, rtt, srvLagMs };
}

/** Feed a steady baseline so the median is well established before a spike. */
function baseline(diag: NetDiag, rtt = 50, n = 8): void {
  for (let i = 0; i < n; i++) diag.record(sample(rtt), QUIET);
}

describe('NetDiag', () => {
  it('stableRttMs rejects transient spikes (median, not latest)', () => {
    const diag = new NetDiag();
    for (let i = 0; i < 10; i++) diag.record(sample(50), QUIET);
    diag.record(sample(300), QUIET); // one big spike
    expect(diag.stableRttMs()).toBeCloseTo(50, 5);
  });

  it('attributes a spike with high server lag to the server', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const diag = new NetDiag();
    baseline(diag);
    const entry = diag.record(sample(200, 160), QUIET);
    expect(entry.spike).toBe('server');
    expect(diag.spikeCounts.server).toBe(1);
  });

  it('attributes a spike coinciding with a long client frame to the client', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const diag = new NetDiag();
    baseline(diag);
    const entry = diag.record(sample(200, 0), { ...QUIET, frameMaxMs: 160 });
    expect(entry.spike).toBe('client');
  });

  it('attributes an otherwise-unexplained spike to the network', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const diag = new NetDiag();
    baseline(diag);
    const entry = diag.record(sample(200, 2), QUIET);
    expect(entry.spike).toBe('network');
  });

  it('does not flag samples near the median', () => {
    const diag = new NetDiag();
    baseline(diag);
    const entry = diag.record(sample(60), QUIET);
    expect(entry.spike).toBeNull();
  });
});

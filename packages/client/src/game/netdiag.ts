/**
 * Network diagnostics: turns the stream of RTT samples into an attributed
 * picture of *where* a ping spike came from.
 *
 * The measured RTT is a client-only clock difference and bundles four things
 * that can each spike on their own:
 *   1. network out
 *   2. the server event loop sitting busy before it echoes the pong
 *   3. network back
 *   4. the client main thread sitting busy before onmessage runs
 *
 * For every pong we already know (2) — the server stamps its event-loop lag
 * into the pong (`srvLagMs`). The match loop hands us (4) as the worst frame
 * gap seen just before the pong (`frameMaxMs`): if requestAnimationFrame was
 * blocked for 80 ms, the pong waited in the queue that long and the RTT is
 * inflated by roughly that much with no network involvement. Whatever excess
 * over the recent-median RTT is left unexplained by (2) and (4) is attributed
 * to the transport (network jitter / TCP head-of-line blocking). The snapshot
 * delivery delay at spike time is recorded alongside so a spike that hits RTT
 * *and* snapshot arrival together reads clearly as a shared-transport stall.
 *
 * This is observability only — nothing here feeds the simulation or rendering.
 * Open the live site, play, and watch the console; `window.__net.dump()`
 * returns the full ring for export.
 */
import type { RttSample } from '../net';

export type SpikeCause = 'server' | 'client' | 'network';

export type SpikeCounts = Record<SpikeCause, number>;

export interface DiagSample {
  /** performance.now() at the pong */
  at: number;
  rtt: number;
  srvLagMs: number | null;
  /** worst frame gap (ms) on the client in the window before this pong */
  frameMaxMs: number;
  /** snapshot age (ms) when this pong landed — was snapshot delivery also late? */
  snapshotAgeMs: number | null;
  /** adaptive interpolation render delay (ms) — rises when snapshots get bursty */
  renderDelayMs: number;
  /** rolling median RTT at the time of this sample */
  medianRtt: number;
  /** set when this sample was flagged as a spike */
  spike: SpikeCause | null;
}

/** how many recent samples define the baseline / are kept for export */
const WINDOW = 240;
/** how many recent samples define the "stable" RTT fed to the predictor */
const STABLE_WINDOW = 16;
/** a sample counts as a spike when it exceeds the median by both of these */
const SPIKE_ABS_MS = 40;
const SPIKE_REL = 1.8;
/** a component "explains" the excess once it covers this fraction of it */
const EXPLAIN_FRAC = 0.5;

export interface DiagContext {
  frameMaxMs: number;
  snapshotAgeMs: number | null;
  renderDelayMs: number;
}

export class NetDiag {
  private readonly ring: DiagSample[] = [];
  private readonly rtts: number[] = [];
  /** running spike tally by cause, for a quick at-a-glance summary */
  readonly spikeCounts: SpikeCounts = { server: 0, client: 0, network: 0 };

  /** Ingest one RTT sample plus the client/snapshot context around it. */
  record(sample: RttSample, ctx: DiagContext): DiagSample {
    this.rtts.push(sample.rtt);
    if (this.rtts.length > WINDOW) this.rtts.shift();
    const median = this.median();

    const excess = sample.rtt - median;
    const isSpike = excess >= SPIKE_ABS_MS && sample.rtt >= median * SPIKE_REL && this.rtts.length >= 6;
    let cause: SpikeCause | null = null;
    if (isSpike) {
      const srv = sample.srvLagMs ?? 0;
      const frame = ctx.frameMaxMs;
      // Attribute to whichever local factor best explains the excess; if neither
      // server lag nor a client stall accounts for it, it is the transport.
      if (srv >= excess * EXPLAIN_FRAC && srv >= frame) cause = 'server';
      else if (frame >= excess * EXPLAIN_FRAC) cause = 'client';
      else cause = 'network';
      this.spikeCounts[cause] += 1;
    }

    const entry: DiagSample = {
      at: sample.at,
      rtt: sample.rtt,
      srvLagMs: sample.srvLagMs,
      frameMaxMs: Math.round(ctx.frameMaxMs),
      snapshotAgeMs: ctx.snapshotAgeMs === null ? null : Math.round(ctx.snapshotAgeMs),
      renderDelayMs: Math.round(ctx.renderDelayMs),
      medianRtt: Math.round(median),
      spike: cause,
    };
    this.ring.push(entry);
    if (this.ring.length > WINDOW) this.ring.shift();

    if (cause) {
      // eslint-disable-next-line no-console
      console.warn(
        `[net] ping spike ${sample.rtt}ms (median ${Math.round(median)}ms, +${Math.round(excess)}ms) → ${cause}` +
          ` | srvLag=${sample.srvLagMs ?? '?'}ms frameMax=${Math.round(ctx.frameMaxMs)}ms` +
          ` snapAge=${ctx.snapshotAgeMs === null ? '?' : Math.round(ctx.snapshotAgeMs)}ms renderDelay=${Math.round(ctx.renderDelayMs)}ms`
      );
    }
    return entry;
  }

  /** Rolling median RTT — the spike baseline; robust to the spikes themselves. */
  median(): number {
    if (this.rtts.length === 0) return 0;
    const sorted = [...this.rtts].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Spike-resistant RTT for client-side prediction: the median of the most
   * recent samples. Feeding the raw latest RTT into the predictor's look-ahead
   * makes the local mech lurch forward and rubber-band back on every transport
   * spike; the median rejects those while still tracking a genuine baseline
   * shift within a few seconds.
   */
  stableRttMs(): number {
    const n = this.rtts.length;
    if (n === 0) return 0;
    const recent = this.rtts.slice(Math.max(0, n - STABLE_WINDOW)).sort((a, b) => a - b);
    const mid = recent.length >> 1;
    return recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2;
  }

  /** Jitter = how far the worst recent RTT sits above the median (p100 − median). */
  jitterMs(): number {
    if (this.rtts.length === 0) return 0;
    let worst = 0;
    for (const r of this.rtts) if (r > worst) worst = r;
    return Math.max(0, worst - this.median());
  }

  /** Snapshot of the full ring + summary for console export. */
  dump(): { median: number; jitter: number; spikeCounts: SpikeCounts; samples: DiagSample[] } {
    return {
      median: Math.round(this.median()),
      jitter: Math.round(this.jitterMs()),
      spikeCounts: { ...this.spikeCounts },
      samples: [...this.ring],
    };
  }
}

/** Install `window.__net` so the live site can inspect/export diagnostics from the console. */
export function installNetDiag(diag: NetDiag): void {
  (window as unknown as { __net: { dump: () => unknown } }).__net = { dump: () => diag.dump() };
}

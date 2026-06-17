/**
 * Event-loop lag monitor.
 *
 * A single recurring timer that measures how late it fires versus when it was
 * scheduled. That delay IS the event-loop lag: the time the loop spent blocked
 * on something else (a fat JSON.stringify of a snapshot, a GC pause, a burst of
 * socket work) before it could run our callback. It is NOT CPU saturation — a
 * one-off 40 ms stringify spikes lag without moving average CPU, which is
 * exactly the "server never reaches its limits but pings spike" symptom.
 *
 * The current value is stamped into every pong (see lobby ping handler) so the
 * client can attribute an RTT spike to the server loop vs. the network vs. its
 * own main thread.
 */
const INTERVAL_MS = 200;
/** sliding window of samples kept for the recent-max readout (~5 s) */
const WINDOW = 25;

export class EventLoopLagMonitor {
  private timer: NodeJS.Timeout | null = null;
  private current = 0;
  private readonly samples: number[] = [];

  start(): void {
    if (this.timer !== null) return;
    const schedule = (): void => {
      const expected = performance.now() + INTERVAL_MS;
      this.timer = setTimeout(() => {
        const lag = Math.max(0, performance.now() - expected);
        this.current = lag;
        this.samples.push(lag);
        if (this.samples.length > WINDOW) this.samples.shift();
        schedule();
      }, INTERVAL_MS);
      // Never keep the process alive just for diagnostics.
      this.timer.unref?.();
    };
    schedule();
  }

  /** Most recent lag sample, in ms. */
  get currentMs(): number {
    return this.current;
  }

  /** Worst lag over the recent window, in ms. */
  get recentMaxMs(): number {
    let m = 0;
    for (const s of this.samples) if (s > m) m = s;
    return m;
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

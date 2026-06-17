/**
 * Server load probe — reproduces and measures server-side stutter locally.
 *
 * Boots the real server in-process at REAL-TIME pacing (100 Hz, default
 * balance), runs back-to-back bot-vs-bot matches under heavy load (both bots
 * build to the unit cap and fire continuously), and samples the server's
 * event-loop delay every 500 ms with perf_hooks.monitorEventLoopDelay (the
 * gold standard). A loopback ping each interval cross-checks what a real client
 * would observe. Prints a spike timeline + percentiles at the end.
 *
 *   npx tsx packages/server/scripts/loadprobe.ts
 *   PROBE_SECONDS=120 npx tsx packages/server/scripts/loadprobe.ts
 *   NODE_OPTIONS=--trace-gc npx tsx packages/server/scripts/loadprobe.ts   # correlate GC pauses
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { getBalance } from '@mech-arena-fight/shared';
import { startServer } from '../src/server';
import { BotClient } from '../test/botClient';

const DURATION_MS = (Number(process.env.PROBE_SECONDS) || 90) * 1000;
const SAMPLE_MS = 500;
const SPIKE_MS = 15; // log any interval whose worst event-loop delay exceeds this

const ns2ms = (ns: number): number => ns / 1e6;

async function main(): Promise<void> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();

  const server = await startServer({
    port: 0,
    tickRate: 100,
    tickMs: 10, // real-time pacing (1000/100)
    logLevel: 'error',
    balancePreset: 'default',
    countdownSecondMs: 100,
  });
  const url = `ws://127.0.0.1:${server.port}`;
  console.log(`[loadprobe] server up on :${server.port} — 100Hz, default balance, ${DURATION_MS / 1000}s`);

  const a = await BotClient.connect(url, 'BotA');
  const b = await BotClient.connect(url, 'BotB');
  const balance = getBalance('default');
  const tankCost = balance.units.hovertank.cost;

  // Both bots: build whenever affordable + hold fire, so the sim runs at a
  // realistic heavy load (units near the cap, projectiles in flight).
  function driveBuild(bot: BotClient): () => void {
    const t = setInterval(() => {
      const snap = bot.lastSnapshot;
      if (!snap || bot.playerIndex < 0) return;
      const me = snap.players[bot.playerIndex];
      if (me && me.credits >= tankCost && me.queue.length < balance.queueMax && me.unitsAlive + me.queue.length < me.unitCap) {
        bot.build('hovertank');
      }
    }, 40);
    return () => clearInterval(t);
  }
  function driveFire(bot: BotClient): () => void {
    const t = setInterval(() => {
      if (bot.playerIndex < 0) return;
      // Roam forward and hold primary fire toward the far side of the map.
      bot.sendInput({ mx: 0, mz: 1, aimX: 0, aimZ: bot.playerIndex === 0 ? 60 : -60, fire: true, mode: 'walker' });
    }, 100);
    return () => clearInterval(t);
  }

  const intervalMaxMs: number[] = [];
  const pingMs: number[] = [];
  const spikes: { tSec: number; loopMs: number; ping: number }[] = [];
  const t0 = performance.now();

  const sampler = setInterval(() => {
    const loopMax = ns2ms(h.max);
    h.reset();
    intervalMaxMs.push(loopMax);
    const tSec = (performance.now() - t0) / 1000;
    void a
      .ping(2000)
      .then((rtt) => {
        pingMs.push(rtt);
        if (loopMax > SPIKE_MS) {
          spikes.push({ tSec, loopMs: loopMax, ping: rtt });
          console.log(`[loadprobe] t=${tSec.toFixed(1)}s  loopDelayMax=${loopMax.toFixed(1)}ms  loopbackPing=${rtt.toFixed(1)}ms`);
        }
      })
      .catch(() => {});
  }, SAMPLE_MS);

  const room = await a.createRoom({ roomName: 'loadprobe', preset: 'default' });
  await b.joinRoom(room.id);

  let matches = 0;
  const endAt = performance.now() + DURATION_MS;
  while (performance.now() < endAt) {
    try {
      a.ready();
      b.ready();
      await a.waitForMatchStart(10_000);
      await b.waitForMatchStart(10_000);
      const stops = [driveBuild(a), driveBuild(b), driveFire(a), driveFire(b)];
      try {
        // A default-balance match may never end (stalemate) — that is fine, it
        // just means one long continuous load window. Cap the wait at the
        // remaining probe time so we stop cleanly and print the summary.
        await a.waitForMatchEnd(Math.max(2_000, endAt - performance.now()));
      } finally {
        for (const s of stops) s();
      }
      matches++;
    } catch {
      break; // match-end timeout (stalemate) or duration elapsed — stop cleanly
    }
  }

  clearInterval(sampler);
  await a.close();
  await b.close();
  await server.close();
  h.disable();

  const sorted = [...intervalMaxMs].sort((x, y) => x - y);
  const q = (p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN);
  const pingsSorted = [...pingMs].sort((x, y) => x - y);
  const pq = (p: number): number => (pingsSorted.length ? pingsSorted[Math.min(pingsSorted.length - 1, Math.floor(p * pingsSorted.length))] : NaN);
  console.log('---');
  console.log(`[loadprobe] matches played: ${matches}, intervals sampled: ${intervalMaxMs.length}`);
  console.log(
    `[loadprobe] event-loop delay max per 500ms (ms): p50=${q(0.5).toFixed(1)} p90=${q(0.9).toFixed(1)} p99=${q(0.99).toFixed(1)} max=${Math.max(...intervalMaxMs).toFixed(1)}`
  );
  console.log(
    `[loadprobe] loopback ping (ms): p50=${pq(0.5).toFixed(1)} p90=${pq(0.9).toFixed(1)} p99=${pq(0.99).toFixed(1)} max=${Math.max(...pingMs).toFixed(1)}`
  );
  console.log(`[loadprobe] intervals with loopDelay > ${SPIKE_MS}ms: ${spikes.length}/${intervalMaxMs.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[loadprobe] FAILED:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });

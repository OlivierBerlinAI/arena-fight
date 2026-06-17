/**
 * AI-vs-AI server-responsiveness harness.
 *
 * Boots the real server in-process at real-time pacing (100 Hz, default
 * balance) and keeps N concurrent AI-vs-AI matches running — two real opponent
 * AIs (packages/server/src/bot) fighting each other per room. While they play
 * it samples the server's event-loop delay with perf_hooks.monitorEventLoopDelay
 * and prints a verdict: that delay adds directly to every client's ping, so it
 * is the truest measure of whether THIS host keeps the server responsive enough.
 *
 *   npm run botmatch                       # 2 matches, 60s, normal AI
 *   MATCHES=6 PROBE_SECONDS=120 npm run botmatch
 *   DIFFICULTY=hard npm run botmatch
 *
 * Run it ON the server host to answer "is this box good enough to host?".
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { BotDifficulty } from '@mech-arena-fight/shared';
import { startServer } from '../src/server';

const DURATION_MS = (Number(process.env.PROBE_SECONDS) || 60) * 1000;
const MATCHES = Math.max(1, Number(process.env.MATCHES) || 2);
const DIFFICULTY = (process.env.DIFFICULTY || 'normal') as BotDifficulty;
const SAMPLE_MS = 500;

const ns2ms = (ns: number): number => ns / 1e6;

async function main(): Promise<void> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();

  const server = await startServer({
    port: 0,
    tickRate: 100,
    tickMs: 10, // real-time pacing
    logLevel: 'error',
    balancePreset: 'default',
    countdownSecondMs: 100,
  });
  console.log(
    `[botmatch] server up on :${server.port} — keeping ${MATCHES} concurrent AI-vs-AI match(es) (${DIFFICULTY}), ${DURATION_MS / 1000}s`
  );

  const fill = (): void => {
    while (server.lobby.roomCount() < MATCHES) {
      if (server.lobby.createBotMatch(DIFFICULTY) === null) break;
    }
  };
  fill();

  const intervalMaxMs: number[] = [];
  const t0 = performance.now();
  let spikes = 0;
  const sampler = setInterval(() => {
    const loopMax = ns2ms(h.max);
    h.reset();
    intervalMaxMs.push(loopMax);
    if (loopMax > 20) {
      spikes++;
      console.log(`[botmatch] t=${((performance.now() - t0) / 1000).toFixed(1)}s  loopDelayMax=${loopMax.toFixed(1)}ms  rooms=${server.lobby.roomCount()}`);
    }
    fill(); // refill matches that have ended
  }, SAMPLE_MS);

  await new Promise((r) => setTimeout(r, DURATION_MS));
  clearInterval(sampler);
  await server.close();
  h.disable();

  const sorted = [...intervalMaxMs].sort((a, b) => a - b);
  const q = (p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN);
  const p99 = q(0.99);
  const max = Math.max(...intervalMaxMs);
  const verdict =
    p99 < 25 && max < 60
      ? 'GOOD — server stays responsive under this load'
      : p99 < 50 && max < 150
        ? 'MARGINAL — occasional hitches; ok for casual play, watch the host load'
        : 'POOR — host too busy; players will feel stutter (free up CPU or use another host)';
  console.log('---');
  console.log(`[botmatch] intervals sampled: ${intervalMaxMs.length}, intervals with loopDelay > 20ms: ${spikes}`);
  console.log(
    `[botmatch] event-loop delay max per ${SAMPLE_MS}ms (ms): p50=${q(0.5).toFixed(1)} p90=${q(0.9).toFixed(1)} p99=${p99.toFixed(1)} max=${max.toFixed(1)}`
  );
  console.log(`[botmatch] verdict: ${verdict}`);
  console.log('[botmatch] (event-loop delay adds to every client\'s ping; target p99 <~25ms, max <~60ms. ~12ms baseline = the 10ms tick.)');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[botmatch] FAILED:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });

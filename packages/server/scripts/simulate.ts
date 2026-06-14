/**
 * Headless scripted match — the agent's fastest smoke test.
 *
 * Boots the real server in-process on an ephemeral port (accelerated pacing),
 * connects two protocol-level bot clients with scripted strategies:
 *   RushBot  — aggressive hovertank rush (builds whenever affordable)
 *   DreadBot — builds exactly one dreadnought, then idles
 * Runs the full match over real WebSockets, prints one line per sim event,
 * then the outcome, duration and final stats. Exits 0 on a clean matchEnd and
 * non-zero on any timeout, protocol error or crash.
 *
 * Run from the repo root: npm run simulate
 */
import { getBalance } from '@mech-arena-fight/shared';
import type { SimEvent } from '@mech-arena-fight/shared';
import { isLogLevel } from '../src/logger';
import { startServer } from '../src/server';
import { BotClient } from '../test/botClient';

const MATCH_TIMEOUT_MS = 45_000;

function fmtPlayer(names: readonly string[], p: number): string {
  return `${names[p] ?? '?'} (p${p})`;
}

function fmtEvent(e: SimEvent, names: readonly string[]): string {
  switch (e.type) {
    case 'unitQueued':
      return `${fmtPlayer(names, e.player)} queued a ${e.unit}`;
    case 'unitDeployed':
      return `${fmtPlayer(names, e.player)} deployed ${e.unit} #${e.unitId}`;
    case 'unitDestroyed':
      return `${e.unit} #${e.unitId} of ${fmtPlayer(names, e.owner)} destroyed by ${
        e.byPlayer === -1 ? 'the arena' : fmtPlayer(names, e.byPlayer)
      }`;
    case 'buildRejected':
      return `${fmtPlayer(names, e.player)} build ${e.unit} rejected (${e.reason})`;
    case 'turretCaptured':
      return `turret ${e.turretId} captured by ${fmtPlayer(names, e.player)}`;
    case 'turretDestroyed':
      return `turret ${e.turretId} destroyed by ${fmtPlayer(names, e.byPlayer)}`;
    case 'turretRespawned':
      return `turret ${e.turretId} respawned (neutral)`;
    case 'mechKilled':
      return `mech of ${fmtPlayer(names, e.victim)} killed by ${
        e.byPlayer === -1 ? 'the arena' : fmtPlayer(names, e.byPlayer)
      }`;
    case 'mechRespawned':
      return `mech of ${fmtPlayer(names, e.player)} respawned`;
    case 'baseUnderAttack':
      return `${fmtPlayer(names, e.player)}'s base is under attack!`;
    case 'matchEnd':
      return `MATCH END — ${fmtPlayer(names, e.winner)} wins by core capture (unit #${e.byUnitId})`;
  }
}

async function main(): Promise<void> {
  const wallStart = Date.now();
  const envLevel = process.env.LOG_LEVEL;
  const server = await startServer({
    port: 0,
    tickMs: 4,
    logLevel: isLogLevel(envLevel) ? envLevel : 'warn',
    countdownSecondMs: 150,
  });
  const url = `ws://127.0.0.1:${server.port}`;
  console.log(`[simulate] server up on port ${server.port} (tickMs=4, preset=test)`);

  const a = await BotClient.connect(url, 'RushBot');
  const b = await BotClient.connect(url, 'DreadBot');
  let stopRush: (() => void) | null = null;

  try {
    const room = await a.createRoom({ roomName: 'simulated-duel', preset: 'test' });
    await b.joinRoom(room.id);
    console.log(`[simulate] room ${room.id} created, both bots joined`);

    const startA = a.waitForMatchStart(10_000);
    const startB = b.waitForMatchStart(10_000);
    a.ready();
    b.ready();
    const [ma] = await Promise.all([startA, startB]);

    const names: [string, string] = ma.playerIndex === 0 ? ['RushBot', 'DreadBot'] : ['DreadBot', 'RushBot'];
    console.log(
      `[simulate] match started: seed=${ma.seed} preset=${ma.preset} tickRate=${ma.tickRate} ` +
        `RushBot=p${ma.playerIndex} DreadBot=p${1 - ma.playerIndex}`
    );

    // One line per sim event, with the tick it was reported at.
    a.onMessage = (msg) => {
      if (msg.type !== 'snapshot') return;
      for (const e of msg.events) {
        console.log(`[tick ${String(msg.snap.tick).padStart(5)}] ${fmtEvent(e, names)}`);
      }
    };

    // RushBot: queue a hovertank whenever it looks affordable.
    const balance = getBalance('test');
    const tankCost = balance.units.hovertank.cost;
    const rushTimer = setInterval(() => {
      const snap = a.lastSnapshot;
      if (!snap || a.playerIndex < 0) return;
      const me = snap.players[a.playerIndex];
      if (
        me &&
        me.credits >= tankCost &&
        me.queue.length < balance.queueMax &&
        me.unitsAlive + me.queue.length < me.unitCap
      ) {
        a.build('hovertank');
      }
    }, 30);
    stopRush = () => clearInterval(rushTimer);

    // DreadBot: exactly one dreadnought (affordable from starting credits), then idle.
    b.build('dreadnought');

    const end = await a.waitForMatchEnd(MATCH_TIMEOUT_MS);
    stopRush();

    const winnerName = names[end.winner];
    const wallSeconds = ((Date.now() - wallStart) / 1000).toFixed(1);
    const simSeconds = (end.durationTicks / ma.tickRate).toFixed(1);
    console.log('---');
    console.log(`[simulate] outcome: ${winnerName} (p${end.winner}) wins — reason=${end.reason}`);
    console.log(
      `[simulate] duration: ${end.durationTicks} ticks = ${simSeconds} sim-seconds (${wallSeconds}s wall clock)`
    );
    for (const p of [0, 1] as const) {
      const s = end.stats[p];
      console.log(
        `[simulate] ${fmtPlayer(names, p)} stats: built=${s.robotsBuilt} destroyed=${s.robotsDestroyed} ` +
          `lost=${s.robotsLost} turretCaptures=${s.turretCaptures} kills=${s.kills} deaths=${s.deaths}`
      );
    }
    if (end.reason !== 'core') {
      throw new Error(`expected a core-capture victory, got reason='${end.reason}'`);
    }
    console.log('[simulate] OK');
  } finally {
    if (stopRush) stopRush();
    await a.close();
    await b.close();
    await server.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[simulate] FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });

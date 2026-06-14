/**
 * Shared plumbing for the protocol integration tests: boot the real server
 * in-process on an ephemeral port with accelerated pacing, connect bot pairs,
 * and run scripted build strategies.
 */
import { getBalance } from '@mech-arena-fight/shared';
import type { BalancePresetName, UnitType } from '@mech-arena-fight/shared';
import { startServer } from '../src/server';
import type { StartServerOptions } from '../src/server';
import { BotClient } from './botClient';

export interface TestServer {
  port: number;
  /** ws:// URL */
  url: string;
  /** http:// URL for /health and /debug/state */
  httpUrl: string;
  close(): Promise<void>;
}

/** Ephemeral port, 4 ms ticks, 25 ms countdown "seconds", silent logs. */
export async function bootTestServer(overrides: StartServerOptions = {}): Promise<TestServer> {
  const srv = await startServer({
    port: 0,
    tickMs: 4,
    logLevel: 'silent',
    countdownSecondMs: 25,
    ...overrides,
  });
  return {
    port: srv.port,
    url: `ws://127.0.0.1:${srv.port}`,
    httpUrl: `http://127.0.0.1:${srv.port}`,
    close: () => srv.close(),
  };
}

/** Connect two bots, create+join a room and ready both into a running match. */
export async function startMatchedPair(
  url: string,
  preset: BalancePresetName
): Promise<{ a: BotClient; b: BotClient; roomId: string }> {
  const a = await BotClient.connect(url, 'BotA');
  const b = await BotClient.connect(url, 'BotB');
  const room = await a.createRoom({ roomName: 'test-arena', preset });
  await b.joinRoom(room.id);
  const startA = a.waitForMatchStart();
  const startB = b.waitForMatchStart();
  a.ready();
  b.ready();
  await Promise.all([startA, startB]);
  return { a, b, roomId: room.id };
}

/** Keep queueing `unit` whenever it looks affordable; returns a stop function. */
export function spamBuilds(
  bot: BotClient,
  unit: UnitType = 'hovertank',
  preset: BalancePresetName = 'test'
): () => void {
  const balance = getBalance(preset);
  const cost = balance.units[unit].cost;
  const timer = setInterval(() => {
    const snap = bot.lastSnapshot;
    if (!snap || bot.playerIndex < 0) return;
    const me = snap.players[bot.playerIndex];
    if (
      me &&
      me.credits >= cost &&
      me.queue.length < balance.queueMax &&
      me.unitsAlive + me.queue.length < me.unitCap
    ) {
      bot.build(unit);
    }
  }, 25);
  return () => clearInterval(timer);
}

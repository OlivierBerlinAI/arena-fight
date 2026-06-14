import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotClient } from './botClient';
import { bootTestServer } from './helpers';
import type { TestServer } from './helpers';

describe('lobby flow', () => {
  let server: TestServer;
  const bots: BotClient[] = [];

  beforeEach(async () => {
    server = await bootTestServer();
  });

  afterEach(async () => {
    await Promise.all(bots.splice(0).map((b) => b.close()));
    await server.close();
  });

  async function connect(name: string): Promise<BotClient> {
    const bot = await BotClient.connect(server.url, name);
    bots.push(bot);
    return bot;
  }

  it('create → join → ready → countdown → matchStart with complementary player indices', async () => {
    const a = await connect('Alice');
    const b = await connect('Bob');
    expect(a.clientId).not.toBe('');
    expect(b.clientId).not.toBe(a.clientId);
    expect(b.getRooms()).toHaveLength(0);

    // A creates a room and lands in it as seat 0.
    const room = await a.createRoom({ roomName: 'the-pit', preset: 'default' });
    expect(room.name).toBe('the-pit');
    expect(room.youIndex).toBe(0);
    expect(room.status).toBe('waiting');
    expect(room.players).toEqual([{ name: 'Alice', ready: false }]);

    // The room shows up in B's live lobby list.
    const rooms = await b.waitForRoomCount(1);
    expect(rooms[0].name).toBe('the-pit');
    expect(rooms[0].host).toBe('Alice');
    expect(rooms[0].playerCount).toBe(1);
    expect(rooms[0].maxPlayers).toBe(2);
    expect(rooms[0].status).toBe('waiting');

    // B joins as seat 1.
    const joined = await b.joinRoom(rooms[0].id);
    expect(joined.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);
    expect(joined.youIndex).toBe(1);

    // Both ready → full 3..2..1 countdown → matchStart for both.
    const countdown3 = a.waitForMessage('countdown', (m) => m.seconds === 3);
    const countdown1 = b.waitForMessage('countdown', (m) => m.seconds === 1);
    const startA = a.waitForMatchStart();
    const startB = b.waitForMatchStart();
    a.ready();
    b.ready();
    await countdown3;
    await countdown1;
    const [ma, mb] = await Promise.all([startA, startB]);

    expect(ma.seed).toBe(mb.seed);
    expect(ma.preset).toBe('default');
    expect(ma.tickRate).toBe(100); // server default (TICK_RATE)
    expect(ma.tickMs).toBeGreaterThan(0);
    expect(new Set([ma.playerIndex, mb.playerIndex])).toEqual(new Set([0, 1]));

    // ping/pong round trip still works mid-match.
    const rtt = await a.ping();
    expect(rtt).toBeGreaterThanOrEqual(0);
  });

  it('unreadying during the countdown cancels it and the room returns to waiting', async () => {
    const a = await connect('Alice');
    const b = await connect('Bob');
    const room = await a.createRoom({ roomName: 'cold-feet' });
    await b.joinRoom(room.id);

    const countdownStarted = a.waitForMessage('countdown', (m) => m.seconds === 3);
    a.ready();
    b.ready();
    await countdownStarted;

    const backToWaiting = a.waitForMessage(
      'roomState',
      (m) => m.room.status === 'waiting' && m.room.players.some((p) => !p.ready)
    );
    b.ready(false);
    await backToWaiting;

    // Re-readying restarts the countdown and the match eventually starts.
    const start = a.waitForMatchStart();
    a.ready();
    b.ready();
    await expect(start).resolves.toMatchObject({ type: 'matchStart' });
  });

  it('serves a configurable tick rate (opts.tickRate / TICK_RATE) in matchStart', async () => {
    // A dedicated server overrides the default 100 Hz with 50 Hz.
    const slow = await bootTestServer({ tickRate: 50 });
    const a = await BotClient.connect(slow.url, 'Ada');
    const b = await BotClient.connect(slow.url, 'Bo');
    try {
      const room = await a.createRoom({ roomName: 'rate-test', preset: 'default' });
      await b.joinRoom(room.id);
      const startA = a.waitForMatchStart();
      a.ready();
      b.ready();
      const ma = await startA;
      expect(ma.tickRate).toBe(50);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await slow.close();
    }
  });
});

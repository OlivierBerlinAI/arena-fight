import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage } from '@precinct/shared';
import { BotClient } from './botClient';
import { bootTestServer, startMatchedPair } from './helpers';
import type { TestServer } from './helpers';

/** A bare socket that bypasses BotClient's hello handshake. */
async function openRaw(url: string): Promise<{
  ws: WebSocket;
  waitFor: (pred: (m: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
}> {
  const ws = new WebSocket(url);
  const messages: ServerMessage[] = [];
  let cursor = 0;
  ws.on('message', (data) => {
    try {
      messages.push(JSON.parse(String(data)) as ServerMessage);
    } catch {
      /* ignore */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const waitFor = async (
    pred: (m: ServerMessage) => boolean,
    timeoutMs = 5000
  ): Promise<ServerMessage> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (cursor < messages.length) {
        const msg = messages[cursor++];
        if (pred(msg)) return msg;
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for raw message');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { ws, waitFor };
}

describe('protocol validation', () => {
  let server: TestServer;
  const bots: BotClient[] = [];
  const rawSockets: WebSocket[] = [];

  beforeEach(async () => {
    server = await bootTestServer();
  });

  afterEach(async () => {
    for (const ws of rawSockets.splice(0)) ws.terminate();
    await Promise.all(bots.splice(0).map((b) => b.close()));
    await server.close();
  });

  it('malformed and invalid messages are rejected while the match keeps running', async () => {
    const { a, b } = await startMatchedPair(server.url, 'default');
    bots.push(a, b);

    // Malformed JSON frame → error, no crash.
    const err1 = a.waitForMessage('error');
    a.sendRaw('this is not json{');
    expect((await err1).code).toBe('badMessage');

    // Unknown message type → error.
    const err2 = a.waitForMessage('error', (m) => m.message.includes('unknown type'));
    a.sendRaw(JSON.stringify({ type: 'frobnicate', payload: 1 }));
    await err2;

    // Bad field types → error.
    const err3 = a.waitForMessage('error');
    a.sendRaw(JSON.stringify({ type: 'input', mx: 'NaN', mz: 0, aimX: 0, aimZ: 0, fire: 1, alt: 0 }));
    await err3;

    // Unaffordable build (default preset: 100 credits < 200 dreadnought cost)
    // → the simulation rejects it and reports a buildRejected event.
    const rejected = a.waitForMessage('snapshot', (m) =>
      m.events.some((e) => e.type === 'buildRejected' && e.reason === 'credits')
    );
    a.build('dreadnought');
    await rejected;

    // The match is unaffected: ticks keep advancing for both players.
    const t1 = (await a.waitForMessage('snapshot')).snap.tick;
    const later = await b.waitForMessage('snapshot', (m) => m.snap.tick > t1 + 5);
    expect(later.snap.tick).toBeGreaterThan(t1);
    expect(later.snap.phase).toBe('playing');
  });

  it('requires hello first, rejects oversized names, and keeps serving afterwards', async () => {
    const raw = await openRaw(server.url);
    rawSockets.push(raw.ws);

    await raw.waitFor((m) => m.type === 'welcome');

    // Any message before hello is refused.
    raw.ws.send(JSON.stringify({ type: 'build', unit: 'hovertank' }));
    const err1 = await raw.waitFor((m) => m.type === 'error');
    if (err1.type !== 'error') throw new Error('expected error');
    expect(err1.code).toBe('helloRequired');

    // Oversized name fails validation.
    raw.ws.send(JSON.stringify({ type: 'hello', name: 'x'.repeat(100) }));
    const err2 = await raw.waitFor((m) => m.type === 'error');
    if (err2.type !== 'error') throw new Error('expected error');
    expect(err2.code).toBe('badMessage');

    // Same socket recovers with a valid hello and can create a room.
    raw.ws.send(JSON.stringify({ type: 'hello', name: 'Recovered' }));
    await raw.waitFor((m) => m.type === 'lobbyState');
    raw.ws.send(JSON.stringify({ type: 'createRoom', roomName: 'post-recovery' }));
    const rs = await raw.waitFor((m) => m.type === 'roomState');
    if (rs.type !== 'roomState') throw new Error('expected roomState');
    expect(rs.room.name).toBe('post-recovery');

    // The server still accepts brand-new clients.
    const c = await BotClient.connect(server.url, 'Newcomer');
    bots.push(c);
    expect(c.getRooms().some((r) => r.name === 'post-recovery')).toBe(true);
  });

  it('joining a nonexistent or full room yields an error', async () => {
    const a = await BotClient.connect(server.url, 'A');
    const b = await BotClient.connect(server.url, 'B');
    const c = await BotClient.connect(server.url, 'C');
    bots.push(a, b, c);

    const errNoRoom = c.waitForMessage('error', (m) => m.code === 'noSuchRoom');
    c.send({ type: 'joinRoom', roomId: 'doesnotexist' });
    await errNoRoom;

    const room = await a.createRoom();
    await b.joinRoom(room.id);
    const errFull = c.waitForMessage('error', (m) => m.code === 'roomUnavailable');
    c.send({ type: 'joinRoom', roomId: room.id });
    await errFull;
  });
});

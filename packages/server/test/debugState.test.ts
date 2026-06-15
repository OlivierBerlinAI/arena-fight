import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotClient } from './botClient';
import { bootTestServer, startMatchedPair } from './helpers';
import type { TestServer } from './helpers';

interface DebugRoom {
  id: string;
  name: string;
  status: string;
  preset: string;
  players: { name: string; ready: boolean }[];
  tick: number | null;
  phase: string | null;
  economy: { credits: number; queue: string[] }[] | null;
  snapshot: { tick: number; mechs: unknown[]; turrets: unknown[] } | null;
}

interface DebugState {
  clients: number;
  lobbyClients: number;
  rooms: DebugRoom[];
}

describe('debug & health endpoints', () => {
  let server: TestServer;
  const bots: BotClient[] = [];

  beforeEach(async () => {
    server = await bootTestServer();
  });

  afterEach(async () => {
    await Promise.all(bots.splice(0).map((b) => b.close()));
    await server.close();
  });

  it('GET /health responds ok', async () => {
    const res = await fetch(`${server.httpUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('unknown routes 404', async () => {
    const res = await fetch(`${server.httpUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it('GET /debug/state exposes the live room state mid-match', async () => {
    const { a, b, roomId } = await startMatchedPair(server.url, 'default');
    bots.push(a, b);
    await a.waitForMessage('snapshot', (m) => m.snap.tick > 0);

    const res = await fetch(`${server.httpUrl}/debug/state`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as DebugState;

    expect(state.clients).toBe(2);
    expect(state.lobbyClients).toBe(0);
    expect(state.rooms).toHaveLength(1);

    const room = state.rooms[0];
    expect(room.id).toBe(roomId);
    expect(room.status).toBe('playing');
    expect(room.preset).toBe('default');
    expect(room.players).toHaveLength(2);
    expect(room.players.map((p) => p.name).sort()).toEqual(['BotA', 'BotB']);
    expect(room.tick).toBeGreaterThan(0);
    expect(room.phase).toBe('playing');

    // Economy and full snapshot are present.
    expect(room.economy).toHaveLength(2);
    expect(room.economy?.[0].credits).toBeGreaterThanOrEqual(0);
    expect(room.snapshot?.mechs).toHaveLength(2);
    expect(room.snapshot?.turrets).toHaveLength(6);
    expect(room.snapshot?.tick).toBeGreaterThan(0);
  });
});

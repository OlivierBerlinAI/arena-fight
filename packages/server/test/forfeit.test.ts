import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotClient } from './botClient';
import { bootTestServer, startMatchedPair } from './helpers';
import type { TestServer } from './helpers';

interface DebugRoom {
  id: string;
  status: string;
  players: unknown[];
}

interface DebugState {
  rooms: DebugRoom[];
  clients: number;
  lobbyClients: number;
}

describe('forfeit handling', () => {
  let server: TestServer;
  const bots: BotClient[] = [];

  beforeEach(async () => {
    server = await bootTestServer();
  });

  afterEach(async () => {
    await Promise.all(bots.splice(0).map((b) => b.close()));
    await server.close();
  });

  it('mid-match disconnect awards the win by forfeit, returns the survivor to the lobby and removes the room', async () => {
    const { a, b, roomId } = await startMatchedPair(server.url, 'default');
    bots.push(a, b);

    // Make sure the match is actually running before pulling the plug.
    await a.waitForMessage('snapshot', (m) => m.snap.tick > 0);

    // Per spec, the survivor is returned to the lobby: a fresh lobbyState
    // without the dissolved room must arrive.
    const backInLobby = a.waitForMessage(
      'lobbyState',
      (m) => !m.rooms.some((r) => r.id === roomId)
    );
    b.terminate();

    const end = await a.waitForMatchEnd(10_000);
    expect(end.reason).toBe('forfeit');
    expect(end.winner).toBe(a.playerIndex);

    // The room does not outlive the forfeit.
    await backInLobby;
    const after = (await (await fetch(`${server.httpUrl}/debug/state`)).json()) as DebugState;
    expect(after.rooms).toHaveLength(0);

    // The survivor is free to start a new room immediately on the same socket.
    const info = await a.createRoom({ roomName: 'after-forfeit' });
    expect(info.players).toHaveLength(1);
  });

  it('leaveRoom mid-match also counts as forfeit', async () => {
    const { a, b } = await startMatchedPair(server.url, 'default');
    bots.push(a, b);
    await a.waitForMessage('snapshot', (m) => m.snap.tick > 0);

    const endPromise = a.waitForMatchEnd(10_000);
    await b.leaveRoom();
    const end = await endPromise;
    expect(end.reason).toBe('forfeit');
    expect(end.winner).toBe(a.playerIndex);
  });
});

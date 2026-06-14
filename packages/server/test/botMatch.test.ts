import { afterEach, describe, expect, it } from 'vitest';
import { bootTestServer } from './helpers';
import type { TestServer } from './helpers';
import { BotClient } from './botClient';
import { runBot } from '../src/bot/runner';

/**
 * Drives the real bot connection (runBot) in-process against a live server — the
 * worker-thread wrapper is just a launcher and is exercised by the e2e (which
 * runs under tsx, where worker threads can load TypeScript).
 */
describe('vs-AI match', () => {
  let server: TestServer | null = null;
  let human: BotClient | null = null;
  let stopBot: (() => void) | null = null;

  afterEach(async () => {
    stopBot?.();
    await human?.close();
    await server?.close();
    server = null;
    human = null;
    stopBot = null;
  });

  it('the AI joins, builds units and beats an idle human', async () => {
    server = await bootTestServer();
    human = await BotClient.connect(server.url, 'Human');
    const room = await human.createRoom({ preset: 'test' });

    stopBot = runBot({ url: server.url, roomId: room.id, name: 'AI', difficulty: 'hard' });
    human.ready(true); // the bot readies on join; once both are ready the match starts

    const start = await human.waitForMatchStart(8000);
    // The human does nothing; the AI should build, rush and breach the human's core.
    const end = await human.waitForMatchEnd(60_000);
    expect(end.winner).not.toBe(start.playerIndex); // the AI (other seat) won
    expect(end.reason).toBe('core');
  });
});

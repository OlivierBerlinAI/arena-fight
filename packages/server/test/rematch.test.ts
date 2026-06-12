import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotClient } from './botClient';
import { bootTestServer, spamBuilds, startMatchedPair } from './helpers';
import type { TestServer } from './helpers';

describe('rematch', () => {
  let server: TestServer;
  const bots: BotClient[] = [];

  beforeEach(async () => {
    server = await bootTestServer();
  });

  afterEach(async () => {
    await Promise.all(bots.splice(0).map((b) => b.close()));
    await server.close();
  });

  it(
    're-readying after a core victory starts a fresh match on a fresh simulation',
    async () => {
      const { a, b } = await startMatchedPair(server.url, 'test');
      bots.push(a, b);

      // Match 1: A rushes hovertanks and wins by core capture.
      const stop1 = spamBuilds(a, 'hovertank', 'test');
      let firstEnd;
      try {
        firstEnd = await a.waitForMatchEnd(20_000);
      } finally {
        stop1();
      }
      expect(firstEnd.reason).toBe('core');
      const firstDuration = firstEnd.durationTicks;
      await b.waitForMatchEnd(5_000);

      // Both players re-ready in the same room → fresh matchStart.
      const start2a = a.waitForMatchStart(15_000);
      const start2b = b.waitForMatchStart(15_000);
      a.ready();
      b.ready();
      const [m2a, m2b] = await Promise.all([start2a, start2b]);
      expect(m2a.seed).toBe(m2b.seed);
      expect(new Set([m2a.playerIndex, m2b.playerIndex])).toEqual(new Set([0, 1]));

      // The new simulation starts from tick ~0 with zeroed stats.
      const snap = await a.waitForMessage('snapshot');
      expect(snap.snap.tick).toBeLessThanOrEqual(75);
      expect(snap.snap.tick).toBeLessThan(firstDuration);
      expect(snap.snap.phase).toBe('playing');
      expect(snap.snap.players[0].stats.robotsBuilt).toBe(0);
      expect(snap.snap.players[1].stats.robotsBuilt).toBe(0);
      expect(snap.snap.units).toHaveLength(0);

      // The rematch is fully playable: A wins again.
      const stop2 = spamBuilds(a, 'hovertank', 'test');
      try {
        const end2 = await a.waitForMatchEnd(20_000);
        expect(end2.reason).toBe('core');
        expect(end2.winner).toBe(a.playerIndex);
      } finally {
        stop2();
      }
    },
    60_000
  );
});

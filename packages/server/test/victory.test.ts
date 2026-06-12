import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotClient } from './botClient';
import { bootTestServer, spamBuilds, startMatchedPair } from './helpers';
import type { TestServer } from './helpers';

describe('scripted victory', () => {
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
    'a hovertank rush wins by core capture against an idle opponent',
    async () => {
      const { a, b } = await startMatchedPair(server.url, 'test');
      bots.push(a, b);

      // Track how far A's robots travel from where they were first seen.
      const firstSeen = new Map<number, { x: number; z: number }>();
      let maxTravelSq = 0;
      a.onMessage = (msg) => {
        if (msg.type !== 'snapshot') return;
        for (const u of msg.snap.units) {
          if (u.owner !== a.playerIndex) continue;
          const start = firstSeen.get(u.id);
          if (!start) {
            firstSeen.set(u.id, { x: u.x, z: u.z });
            continue;
          }
          const dx = u.x - start.x;
          const dz = u.z - start.z;
          maxTravelSq = Math.max(maxTravelSq, dx * dx + dz * dz);
        }
      };

      const stop = spamBuilds(a, 'hovertank', 'test');
      try {
        const end = await a.waitForMatchEnd(20_000);
        expect(end.reason).toBe('core');
        expect(end.winner).toBe(a.playerIndex);
        expect(end.durationTicks).toBeGreaterThan(0);
        expect(end.stats[end.winner].robotsBuilt).toBeGreaterThan(0);

        // The idle opponent gets the same verdict.
        const endB = await b.waitForMatchEnd(5_000);
        expect(endB.winner).toBe(a.playerIndex);
        expect(endB.reason).toBe('core');

        // Robots actually crossed the map rather than idling at the factory.
        expect(Math.sqrt(maxTravelSq)).toBeGreaterThan(60);
        expect(a.allEvents.some((e) => e.type === 'unitDeployed')).toBe(true);
        expect(a.allEvents.some((e) => e.type === 'matchEnd')).toBe(true);
      } finally {
        stop();
      }
    },
    25_000
  );
});

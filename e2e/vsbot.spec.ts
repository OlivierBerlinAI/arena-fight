/**
 * Play vs AI: the lobby button spins up a server-side bot worker that joins and
 * plays. Runs under tsx (unlike vitest), so it exercises the real worker thread.
 */
import { expect, test } from '@playwright/test';
import { enterName, waitPhase } from './helpers';
import type { GameHook } from './helpers';

test('lobby "Play vs AI" starts a match where the bot plays', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
  const page = await ctx.newPage();
  try {
    await page.goto('/?test=1&norender=1');
    await enterName(page, 'Solo');
    await expect(page.getByTestId('lobby-screen')).toBeVisible();

    await page.getByTestId('vs-ai-hard').click();
    // auto-readied + bot joins → countdown → match
    await waitPhase(page, 'playing', 15_000);

    // The AI opponent (the other seat) builds units — they appear as enemy units.
    await page.waitForFunction(
      () => {
        const g = (window as unknown as { __game?: GameHook }).__game;
        return !!g && g.entities.some((e) => e.kind === 'unit' && e.owner !== g.playerIndex);
      },
      undefined,
      { timeout: 20_000, polling: 100 }
    );
  } finally {
    await ctx.close();
  }
});

/**
 * Full victory flow on the accelerated test preset.
 *
 * Player A (creator, index 0) continuously builds hovertanks while B idles;
 * A's robots breach B's core in roughly 10-20 s of wall clock. Covers the
 * VICTORY/DEFEAT result screens, the stats table, returning to the lobby
 * plus a brand-new match on the same server, and the rematch-in-the-same-room
 * path where both players press REMATCH and a fresh simulation starts.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  buildSpam,
  closeAll,
  createTwoPlayers,
  enterName,
  gameState,
  startMatch,
  uniqueRoomName,
  waitPhase,
  type TwoPlayers,
} from './helpers';

/** Drive the running match to a core-breach win for A (B idles). */
async function winMatchAsA(pageA: Page, pageB: Page): Promise<void> {
  const stopSpam = buildSpam(pageA, '1', 300);
  try {
    await waitPhase(pageA, 'ended', 75_000);
    await waitPhase(pageB, 'ended', 20_000);
  } finally {
    stopSpam();
  }
}

test.describe('victory flow', () => {
  let players: TwoPlayers | null = null;

  test.afterEach(async () => {
    if (players) await closeAll(players.contexts);
    players = null;
  });

  test('hovertank rush wins by core breach: VICTORY/DEFEAT screens, stats, back to lobby, and a second match on the same server', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    players = await createTwoPlayers(browser, { test: true });
    const { pageA, pageB } = players;
    await enterName(pageA, 'Rusher');
    await enterName(pageB, 'Sitting Duck');
    await startMatch(pageA, pageB, uniqueRoomName('e2e-victory'));

    await winMatchAsA(pageA, pageB);

    // --- result screens: winner sees VICTORY, loser sees DEFEAT
    await expect(pageA.getByTestId('result-screen')).toBeVisible();
    await expect(pageB.getByTestId('result-screen')).toBeVisible();
    await expect(pageA.getByTestId('result-title')).toHaveText('VICTORY');
    await expect(pageB.getByTestId('result-title')).toHaveText('DEFEAT');

    const [stateA, stateB] = await Promise.all([gameState(pageA), gameState(pageB)]);
    expect(stateA.winner).toBe(0);
    expect(stateB.winner).toBe(0);

    // --- stats table is shown and reflects A's production
    await expect(pageA.getByTestId('result-stats')).toBeVisible();
    const robotsBuiltRow = pageA
      .locator('[data-testid="result-stats"] tr')
      .filter({ hasText: 'Robots built' });
    await expect(robotsBuiltRow).toHaveCount(1);
    const robotsBuilt = Number(await robotsBuiltRow.locator('td.you-col').innerText());
    expect(robotsBuilt).toBeGreaterThan(0);

    // --- both players return to the lobby
    await pageA.getByTestId('back-to-lobby-btn').click();
    await pageB.getByTestId('back-to-lobby-btn').click();
    await waitPhase(pageA, 'lobby');
    await waitPhase(pageB, 'lobby');
    await expect(pageA.getByTestId('lobby-screen')).toBeVisible();
    await expect(pageB.getByTestId('lobby-screen')).toBeVisible();

    // --- the same server supports a brand-new room + match without restart
    await startMatch(pageA, pageB, uniqueRoomName('e2e-vic2'));
    const [againA, againB] = await Promise.all([gameState(pageA), gameState(pageB)]);
    expect(againA.phase).toBe('playing');
    expect(againB.phase).toBe('playing');
  });

  test('after a victory both players press REMATCH and a fresh match starts in the same room', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    players = await createTwoPlayers(browser, { test: true });
    const { pageA, pageB } = players;
    await enterName(pageA, 'RematchHost');
    await enterName(pageB, 'RematchFoe');
    await startMatch(pageA, pageB, uniqueRoomName('e2e-rematch'));

    await winMatchAsA(pageA, pageB);
    await expect(pageA.getByTestId('result-title')).toHaveText('VICTORY');

    // remember how far the first simulation ran (last snapshot tick)
    const endState = await gameState(pageA);
    expect(endState.tick).not.toBeNull();
    expect(endState.tick!).toBeGreaterThan(100); // the win takes several seconds

    // --- both press rematch on the result screen
    await pageA.getByTestId('rematch-btn').click();
    await pageB.getByTestId('rematch-btn').click();

    // countdown runs again, then a FRESH match starts in the same room
    await Promise.all([
      expect(pageA.getByTestId('countdown-overlay')).toBeVisible({ timeout: 15_000 }),
      expect(pageB.getByTestId('countdown-overlay')).toBeVisible({ timeout: 15_000 }),
    ]);
    await Promise.all([waitPhase(pageA, 'playing', 25_000), waitPhase(pageB, 'playing', 25_000)]);

    // fresh simulation: winner cleared, tick restarted far below the old match
    await pageA.waitForFunction(
      (prevTick) => {
        const g = (window as unknown as { __game?: import('./helpers').GameHook }).__game;
        return (
          g !== undefined &&
          g.phase === 'playing' &&
          g.winner === null &&
          g.tick !== null &&
          g.tick < prevTick
        );
      },
      endState.tick!,
      { timeout: 15_000, polling: 100 }
    );
    const [freshA, freshB] = await Promise.all([gameState(pageA), gameState(pageB)]);
    expect(freshA.winner).toBeNull();
    expect(freshB.winner).toBeNull();
    expect(freshB.phase).toBe('playing');
    expect(freshA.playerIndex).toBe(0);
    expect(freshB.playerIndex).toBe(1);
  });
});

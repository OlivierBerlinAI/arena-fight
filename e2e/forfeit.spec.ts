/**
 * Disconnect handling: the opponent's browser context closes mid-match,
 * the remaining player wins by forfeit and can return to the lobby and
 * create a fresh room without reconnecting.
 */
import { expect, test } from '@playwright/test';
import {
  closeAll,
  createRoom,
  createTwoPlayers,
  enterName,
  gameState,
  startMatch,
  uniqueRoomName,
  waitPhase,
  type TwoPlayers,
} from './helpers';

test.describe('forfeit on opponent disconnect', () => {
  let players: TwoPlayers | null = null;

  test.afterEach(async () => {
    if (players) await closeAll(players.contexts);
    players = null;
  });

  test('closing the opponent mid-match gives the remaining player a forfeit win and a clean path back to the lobby', async ({
    browser,
  }) => {
    players = await createTwoPlayers(browser, { test: true });
    const { pageA, pageB, contexts } = players;
    await enterName(pageA, 'Survivor');
    await enterName(pageB, 'Quitter');
    await startMatch(pageA, pageB, uniqueRoomName('e2e-forfeit'));

    // make sure the match is actually running (snapshots flowing) before the drop
    await pageA.waitForFunction(
      () => {
        const g = (window as unknown as { __game?: { tick: number | null } }).__game;
        return g !== undefined && g.tick !== null && g.tick > 0;
      },
      undefined,
      { timeout: 15_000, polling: 100 }
    );

    // --- B vanishes: close the whole context (socket drops)
    await contexts[1].close();

    // --- A gets the result screen with a forfeit win
    await waitPhase(pageA, 'ended', 20_000);
    await expect(pageA.getByTestId('result-screen')).toBeVisible();
    await expect(pageA.getByTestId('result-title')).toHaveText('VICTORY');
    await expect(pageA.locator('#result-reason')).toContainText(/forfeit/i);
    const state = await gameState(pageA);
    expect(state.winner).toBe(0);

    // --- A returns to the lobby cleanly...
    await pageA.getByTestId('back-to-lobby-btn').click();
    await waitPhase(pageA, 'lobby');
    await expect(pageA.getByTestId('lobby-screen')).toBeVisible();

    // ...and can immediately host a new room on the same connection
    await createRoom(pageA, uniqueRoomName('e2e-ff2'));
    await expect(pageA.getByTestId('room-screen')).toBeVisible();
    await expect(pageA.getByTestId('player-list')).toContainText('Survivor');
  });
});

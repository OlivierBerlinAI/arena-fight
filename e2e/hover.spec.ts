/**
 * Walker ⇄ hover transform, verified end-to-end through the real stack:
 * a key press on the client toggles the locomotion mode, the input frame
 * carries it to the authoritative server, and the next snapshot reflects the
 * new mode back into window.__game (and the HUD mode tag).
 *
 * The mode is exposed on each mech entity in window.__game (testhook), so the
 * round-trip is assertable without reading canvas pixels.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  closeAll,
  collectPageErrors,
  createTwoPlayers,
  enterName,
  startMatch,
  uniqueRoomName,
  type GameHook,
  type TwoPlayers,
} from './helpers';

/** Wait until this player's own mech reports the expected locomotion mode. */
async function waitOwnMode(page: Page, mode: 'walker' | 'hover'): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const g = (window as unknown as { __game?: GameHook }).__game;
      if (!g || g.playerIndex === null) return false;
      const mech = g.entities.find((e) => e.kind === 'mech' && e.owner === g.playerIndex);
      return mech !== undefined && (mech as { mode?: string }).mode === expected;
    },
    mode,
    { timeout: 15_000, polling: 100 }
  );
}

test.describe('walker ⇄ hover transform', () => {
  let players: TwoPlayers | null = null;

  test.afterEach(async () => {
    if (players) await closeAll(players.contexts);
    players = null;
  });

  test('the transform key flips the mech between walker and hover through the server', async ({
    browser,
  }) => {
    players = await createTwoPlayers(browser, { test: true });
    const { pageA, pageB } = players;
    const errors = collectPageErrors(pageA);
    await enterName(pageA, 'Pilot');
    await enterName(pageB, 'Idler');
    await startMatch(pageA, pageB, uniqueRoomName('e2e-hover'));

    // Mechs start grounded.
    await waitOwnMode(pageA, 'walker');
    expect(await pageA.getByTestId('hud-mode').textContent()).toBe('WALKER');

    // Press F → the snapshot comes back in hover, and the HUD tag updates.
    await pageA.keyboard.press('f');
    await waitOwnMode(pageA, 'hover');
    await expect(pageA.getByTestId('hud-mode')).toHaveText('HOVER');

    // Press F again → back to walker.
    await pageA.keyboard.press('f');
    await waitOwnMode(pageA, 'walker');
    await expect(pageA.getByTestId('hud-mode')).toHaveText('WALKER');

    // The toggle is per-player: the idle opponent never left walker.
    const opponentMode = await pageB.evaluate(() => {
      const g = (window as unknown as { __game?: GameHook }).__game;
      const mech = g?.entities.find((e) => e.kind === 'mech' && e.owner === g.playerIndex);
      return (mech as { mode?: string } | undefined)?.mode;
    });
    expect(opponentMode).toBe('walker');

    expect(errors).toEqual([]);
  });
});

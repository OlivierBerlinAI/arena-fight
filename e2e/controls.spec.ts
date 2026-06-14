/**
 * Keyboard-only controls, end-to-end through the real client → server →
 * snapshot path: driving, turning (walker and hover), firing, and the
 * top-right CONTROLS overlay. The mouse is never used for gameplay.
 *
 * Mech yaw and mode are exposed on window.__game (testhook), so steering and
 * the transform are assertable without reading canvas pixels.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  closeAll,
  collectPageErrors,
  createTwoPlayers,
  dist,
  enterName,
  startMatch,
  uniqueRoomName,
  type GameHook,
  type TwoPlayers,
} from './helpers';

async function ownMech(page: Page): Promise<{ x: number; z: number; yaw: number; mode: string }> {
  return page.evaluate(() => {
    const g = (window as unknown as { __game?: GameHook }).__game!;
    const m = g.entities.find((e) => e.kind === 'mech' && e.owner === g.playerIndex) as
      | { x: number; z: number; yaw?: number; mode?: string }
      | undefined;
    if (!m) throw new Error('no own mech');
    return { x: m.x, z: m.z, yaw: m.yaw ?? 0, mode: m.mode ?? 'walker' };
  });
}

function angleDiff(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

/** Hold a key for `ms`, then read the own mech. */
async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await page.waitForTimeout(150);
}

test.describe('keyboard controls', () => {
  let players: TwoPlayers | null = null;

  test.afterEach(async () => {
    if (players) await closeAll(players.contexts);
    players = null;
  });

  test('drive, turn (walker + hover), fire, and the controls overlay', async ({ browser }) => {
    players = await createTwoPlayers(browser, { test: true });
    const { pageA, pageB } = players;
    const errors = collectPageErrors(pageA);
    await enterName(pageA, 'Driver');
    await enterName(pageB, 'Idle');
    await startMatch(pageA, pageB, uniqueRoomName('e2e-controls'));
    await pageA.waitForTimeout(500);

    const start = await ownMech(pageA);

    // W drives forward (toward the open centre) — position changes.
    await holdKey(pageA, 'w', 900);
    const moved = await ownMech(pageA);
    expect(dist(moved, start)).toBeGreaterThan(3);

    // Helper: wait until this player has a live projectile (optionally of a kind).
    const waitOwnProjectile = (kind?: string): Promise<unknown> =>
      pageA.waitForFunction(
        (k) => {
          const g = (window as unknown as { __game?: GameHook }).__game;
          return (
            !!g &&
            g.entities.some(
              (e) => e.kind === 'projectile' && e.owner === g.playerIndex && (!k || e.type === k)
            )
          );
        },
        kind,
        { timeout: 5000, polling: 50 }
      );
    const waitNoOwnProjectile = (): Promise<unknown> =>
      pageA.waitForFunction(
        () => {
          const g = (window as unknown as { __game?: GameHook }).__game;
          return !!g && !g.entities.some((e) => e.kind === 'projectile' && e.owner === g.playerIndex);
        },
        undefined,
        { timeout: 5000, polling: 50 }
      );

    // M fires the primary — a projectile owned by this player appears (facing
    // the open centre after moving, so bolts clear the base walls).
    await pageA.keyboard.down('m');
    await waitOwnProjectile();
    await pageA.keyboard.up('m');
    await waitNoOwnProjectile(); // let the gatling tracers expire to isolate the next check

    // Left mouse button is an additional primary-fire input (for 2-key-rollover
    // keyboards). Click on the canvas (not a HUD button) and a bolt appears.
    const canvas = pageA.locator('#canvas-root canvas');
    const box = (await canvas.boundingBox())!;
    await pageA.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pageA.mouse.down(); // left button
    await waitOwnProjectile();
    await pageA.mouse.up();

    // Right mouse button fires rockets (walker only).
    await pageA.mouse.down({ button: 'right' });
    await waitOwnProjectile('rocket');
    await pageA.mouse.up({ button: 'right' });

    // A turns the mech (walker) — yaw changes by a clear margin.
    const beforeWalkerTurn = await ownMech(pageA);
    await holdKey(pageA, 'a', 700);
    const afterWalkerTurn = await ownMech(pageA);
    expect(angleDiff(afterWalkerTurn.yaw, beforeWalkerTurn.yaw)).toBeGreaterThan(0.5);

    // F transforms to hover; turning still works in hover mode.
    await pageA.keyboard.press('f');
    await pageA.waitForFunction(
      () => {
        const g = (window as unknown as { __game?: GameHook }).__game;
        const m = g?.entities.find((e) => e.kind === 'mech' && e.owner === g.playerIndex) as
          | { mode?: string }
          | undefined;
        return m?.mode === 'hover';
      },
      undefined,
      { timeout: 8000, polling: 100 }
    );
    const beforeHoverTurn = await ownMech(pageA);
    await holdKey(pageA, 'd', 700);
    const afterHoverTurn = await ownMech(pageA);
    expect(afterHoverTurn.mode).toBe('hover');
    expect(angleDiff(afterHoverTurn.yaw, beforeHoverTurn.yaw)).toBeGreaterThan(0.5);

    // The CONTROLS button (top-right) opens the shortcuts overlay; CLOSE hides it.
    await expect(pageA.getByTestId('controls-overlay')).toBeHidden();
    await pageA.getByTestId('controls-btn').click();
    await expect(pageA.getByTestId('controls-overlay')).toBeVisible();
    await expect(pageA.getByTestId('controls-overlay')).toContainText('Drive forward');
    await pageA.getByTestId('controls-close').click();
    await expect(pageA.getByTestId('controls-overlay')).toBeHidden();

    expect(errors).toEqual([]);
  });
});

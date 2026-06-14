/**
 * Touch controls, end-to-end through the real client → server → snapshot path.
 *
 * The start-screen toggle switches the client into touch mode; the on-screen
 * joystick and buttons then drive, transform and fire with no keyboard at all.
 * They are built on Pointer Events, so Playwright's mouse drives them directly.
 *
 * A second test pins the contract that keyboard mode (the desktop default) is
 * untouched: no on-screen controls are injected.
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

async function ownMech(page: Page): Promise<{ x: number; z: number; mode: string }> {
  return page.evaluate(() => {
    const g = (window as unknown as { __game?: GameHook }).__game!;
    const m = g.entities.find((e) => e.kind === 'mech' && e.owner === g.playerIndex) as
      | { x: number; z: number; mode?: string }
      | undefined;
    if (!m) throw new Error('no own mech');
    return { x: m.x, z: m.z, mode: m.mode ?? 'walker' };
  });
}

/** Press the floating joystick and push it in (dx, dy) screen-fraction, holding `ms`. */
async function driveStick(page: Page, dx: number, dy: number, ms: number): Promise<void> {
  const box = await page.locator('#touch-stick-zone').boundingBox();
  if (!box) throw new Error('joystick zone not present');
  const ox = box.x + box.width * 0.5;
  const oy = box.y + box.height * 0.7; // lower part of the zone, like a resting thumb
  await page.mouse.move(ox, oy);
  await page.mouse.down();
  // 70px > the joystick radius, so a full push clamps to full deflection
  await page.mouse.move(ox + dx * 70, oy + dy * 70, { steps: 5 });
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

async function buttonCenter(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} not present`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('touch controls', () => {
  let players: TwoPlayers | null = null;

  test.afterEach(async () => {
    if (players) await closeAll(players.contexts);
    players = null;
  });

  test('toggle → joystick drives, transform button hovers, FIRE shoots', async ({ browser }) => {
    players = await createTwoPlayers(browser, { test: true });
    const { pageA, pageB } = players;
    const errors = collectPageErrors(pageA);

    // Pick touch on the start screen, then play with no keyboard at all.
    await pageA.locator('#name-control-toggle [data-scheme="touch"]').click();
    await enterName(pageA, 'Thumbs');
    await enterName(pageB, 'Idle');
    await startMatch(pageA, pageB, uniqueRoomName('e2e-touch'));
    await pageA.waitForTimeout(500);

    // The on-screen controls are present in touch mode.
    await expect(pageA.locator('#touch-controls')).toBeAttached();
    await expect(pageA.locator('#touch-fire')).toBeVisible();
    await expect(pageA.locator('#touch-stick-zone')).toBeVisible();

    // Push the stick forward (up) — the mech drives out of its base.
    const start = await ownMech(pageA);
    await driveStick(pageA, 0, -1, 900);
    const moved = await ownMech(pageA);
    expect(dist(moved, start)).toBeGreaterThan(3);

    // The transform button flips walker → hover.
    await pageA.locator('#touch-mode').click();
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
    expect((await ownMech(pageA)).mode).toBe('hover');

    // Holding FIRE emits a projectile owned by this player (laser while hovering).
    const fire = await buttonCenter(pageA, '#touch-fire');
    await pageA.mouse.move(fire.x, fire.y);
    await pageA.mouse.down();
    await pageA.waitForFunction(
      () => {
        const g = (window as unknown as { __game?: GameHook }).__game;
        return !!g && g.entities.some((e) => e.kind === 'projectile' && e.owner === g.playerIndex);
      },
      undefined,
      { timeout: 6000, polling: 50 }
    );
    await pageA.mouse.up();

    expect(errors).toEqual([]);
  });

  test('keyboard mode (the desktop default) injects no on-screen controls', async ({ browser }) => {
    players = await createTwoPlayers(browser, { test: true });
    const { pageA, pageB } = players;
    await enterName(pageA, 'Desktop');
    await enterName(pageB, 'Idle');
    await startMatch(pageA, pageB, uniqueRoomName('e2e-nokbd'));

    await expect(pageA.locator('#touch-controls')).toHaveCount(0);
    await expect(pageA.locator('body')).not.toHaveClass(/touch-active/);
  });
});

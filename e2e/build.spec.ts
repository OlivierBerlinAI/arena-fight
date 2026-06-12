/**
 * Build flow inside a running test-preset match.
 *
 * Test preset: 500 starting credits, +10/s income, hovertank costs 50 and
 * builds in ~0.5 s, dreadnought costs 200 and builds in ~1.5 s.
 *
 * Two timing realities shape these tests:
 *  - The credits dip and the queue chips are short-lived, so assertions read
 *    MutationObserver watchers installed in the page BEFORE the hotkey is
 *    pressed (installBuildWatch) instead of racing round-trip polls against
 *    the income refill.
 *  - Robot movement is captured by an in-page 100 ms sampler
 *    (installUnitTracker) because CDP round trips under software WebGL can
 *    lag by hundreds of ms, and player 0's left lane runs a long leg along
 *    the west map edge where a naive "x increases" check would flicker.
 */
import { expect, test } from '@playwright/test';
import {
  closeAll,
  createTwoPlayers,
  dist,
  enterName,
  installBuildWatch,
  installUnitTracker,
  readBuildWatch,
  readUnitTrail,
  startMatch,
  uniqueRoomName,
  type BuildWatch,
  type TwoPlayers,
  type UnitTrail,
} from './helpers';

const HOVERTANK_COST = 50;

/** Wait until the HUD credits readout is live and shows at least `min`. */
async function waitForCredits(page: import('@playwright/test').Page, min: number): Promise<void> {
  await page.waitForFunction(
    (threshold) => {
      const el = document.querySelector('[data-testid="hud-credits"]');
      return el !== null && Number(el.textContent) >= threshold;
    },
    min,
    { timeout: 30_000, polling: 100 }
  );
}

test.describe('build flow', () => {
  let players: TwoPlayers | null = null;

  test.afterEach(async () => {
    if (players) await closeAll(players.contexts);
    players = null;
  });

  test('pressing hotkey 1 spends the hovertank cost, queues the build, and the robot drives toward the enemy base', async ({
    browser,
  }) => {
    players = await createTwoPlayers(browser, { test: true });
    const { pageA, pageB } = players;
    await enterName(pageA, 'Builder');
    await enterName(pageB, 'Bystander');
    await startMatch(pageA, pageB, uniqueRoomName('e2e-build'));

    // first snapshot has arrived once the HUD shows the 500 starting credits
    await waitForCredits(pageA, 50);

    // --- build one hovertank via hotkey, with both in-page watchers armed first
    await installBuildWatch(pageA);
    await installUnitTracker(pageA);
    await pageA.keyboard.press('1');

    // the HUD credits readout drops by the hovertank cost in a single update,
    // and a queue chip shows up while the build is in progress
    await pageA.waitForFunction(
      (cost) => {
        const w = (window as unknown as { __buildWatch?: BuildWatch }).__buildWatch;
        return w !== undefined && w.maxCreditDrop >= cost - 10 && w.maxQueue >= 1;
      },
      HOVERTANK_COST,
      { timeout: 10_000, polling: 100 }
    );
    const watch = await readBuildWatch(pageA);
    // exactly one hovertank deduction: income only ever adds credits (so a
    // skipped HUD update can shrink the apparent drop by ~10/s of income at
    // most), and a dreadnought (200) or a double-build would show a far
    // larger drop
    expect(watch.maxCreditDrop).toBeGreaterThanOrEqual(HOVERTANK_COST - 10);
    expect(watch.maxCreditDrop).toBeLessThanOrEqual(HOVERTANK_COST + 5);
    expect(watch.maxQueue).toBe(1);

    // --- the finished robot shows up in window.__game owned by this player,
    // and the tracker collects two samples at least 1.5 s apart
    await pageA.waitForFunction(
      () => {
        const w = (window as unknown as { __unitTrail?: UnitTrail }).__unitTrail;
        if (!w || w.trail.length < 2) return false;
        return w.trail[w.trail.length - 1].t - w.trail[0].t >= 1_500;
      },
      undefined,
      { timeout: 20_000, polling: 100 }
    );
    let { enemyBase, trail } = await readUnitTrail(pageA);
    const first = trail[0];
    expect(first.type).toBe('hovertank');

    // sampled twice ~1.5 s apart, it has clearly moved (test-preset speed 22/s)
    const later = trail.find((s) => s.t - first.t >= 1_500)!;
    expect(later.id).toBe(first.id);
    expect(dist(first, later)).toBeGreaterThan(10);

    // --- and it travels TOWARD the enemy base: within its ~10 s lane journey
    // its distance to the enemy mech's starting spot shrinks by a wide margin
    await pageA.waitForFunction(
      () => {
        const w = (window as unknown as { __unitTrail?: UnitTrail }).__unitTrail;
        if (!w || w.trail.length < 2) return false;
        const d = (s: { x: number; z: number }) =>
          Math.hypot(s.x - w.enemyBase.x, s.z - w.enemyBase.z);
        return d(w.trail[w.trail.length - 1]) < d(w.trail[0]) - 30;
      },
      undefined,
      { timeout: 45_000, polling: 100 }
    );
    ({ enemyBase, trail } = await readUnitTrail(pageA));
    const closest = Math.min(...trail.map((s) => dist(s, enemyBase)));
    expect(closest).toBeLessThan(dist(trail[0], enemyBase) - 30);
  });

  test('the build queue holds at most 3 robots no matter how fast the player spams the hotkey', async ({
    browser,
  }) => {
    players = await createTwoPlayers(browser, { test: true });
    const { pageA, pageB } = players;
    await enterName(pageA, 'Spammer');
    await enterName(pageB, 'Idler');
    await startMatch(pageA, pageB, uniqueRoomName('e2e-queue'));

    // Spam DREADNOUGHTS (1.5 s build) rather than hovertanks (0.5 s) so the
    // queue fills faster than its head drains. Wait until three are
    // affordable up front (3 × 200, plus a couple of income ticks of margin).
    await waitForCredits(pageA, 620);

    // Arm the queue watcher, then fire all 8 hotkey presses as one in-page
    // burst. Individual CDP key presses can arrive hundreds of ms apart under
    // software WebGL — slowly enough for the queue head to finish between
    // presses, which would mask the cap. (The genuine keyboard path is
    // already covered by the hovertank test above.)
    await installBuildWatch(pageA);
    await pageA.evaluate(() => {
      for (let i = 0; i < 8; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', key: '2' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit2', key: '2' }));
      }
    });

    // the queue visibly fills to the cap of 3...
    await pageA.waitForFunction(
      () => {
        const w = (window as unknown as { __buildWatch?: BuildWatch }).__buildWatch;
        return w !== undefined && w.maxQueue >= 3;
      },
      undefined,
      { timeout: 10_000, polling: 100 }
    );

    // ...and across every DOM update while the queue keeps draining, it never
    // shows more than 3 chips (the MutationObserver saw every rendered state)
    await pageA.waitForTimeout(1_500);
    const watch = await readBuildWatch(pageA);
    expect(watch.maxQueue).toBe(3);
  });
});

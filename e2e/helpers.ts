/**
 * Shared helpers for the Precinct Duel Playwright suite.
 *
 * All tests drive TWO browser contexts against the single shared dev server
 * (workers: 1). Every test must create its own uniquely named room and close
 * its contexts when done so the server can clean the room up.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export type UiPhase = 'name' | 'lobby' | 'room' | 'countdown' | 'playing' | 'ended';

export interface GameEntityInfo {
  kind: 'mech' | 'unit' | 'turret' | 'projectile';
  id: string;
  owner: number;
  x: number;
  z: number;
  hp?: number;
  type?: string;
  alive?: boolean;
  /** mechs only: 'walker' | 'hover' */
  mode?: string;
  /** mechs only: facing direction in radians */
  yaw?: number;
}

export interface GameHook {
  phase: UiPhase;
  tick: number | null;
  ping: number | null;
  credits: number | null;
  snapshotAge: number | null;
  playerIndex: 0 | 1 | null;
  winner: number | null;
  entities: GameEntityInfo[];
}

export interface TwoPlayers {
  pageA: Page;
  pageB: Page;
  contexts: BrowserContext[];
}

/**
 * Two WebGL scenes render through SwiftShader on the CPU in this environment;
 * a small viewport keeps both pages responsive (rendering cost scales with
 * pixel count and an overloaded main thread starves polling and the HUD).
 */
const VIEWPORT = { width: 800, height: 500 };

/**
 * Open two independent browser contexts on the client. With `test: true`
 * (the default) the pages load `/?test=1`, so rooms created from them use
 * the accelerated 'test' balance preset.
 */
export async function createTwoPlayers(
  browser: Browser,
  opts: { test?: boolean } = {}
): Promise<TwoPlayers> {
  const url = opts.test === false ? '/' : '/?test=1';
  const ctxA = await browser.newContext({ viewport: VIEWPORT });
  const ctxB = await browser.newContext({ viewport: VIEWPORT });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await Promise.all([pageA.goto(url), pageB.goto(url)]);
  return { pageA, pageB, contexts: [ctxA, ctxB] };
}

/** Close all contexts, swallowing "already closed" errors. */
export async function closeAll(contexts: BrowserContext[]): Promise<void> {
  await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
}

/**
 * Unique room name so each test only ever interacts with its own room.
 * The room-name input has maxlength=32 — the result must stay below that
 * or the lobby entry would show a truncated name and lookups would fail.
 */
export function uniqueRoomName(prefix: string): string {
  const name = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (name.length > 32) throw new Error(`room name too long (max 32): ${name}`);
  return name;
}

/** Enter a display name and wait until the lobby is reached. */
export async function enterName(page: Page, name: string): Promise<void> {
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId('name-submit').click();
  await waitPhase(page, 'lobby');
}

/**
 * Poll window.__game.phase until it equals `phase`. Interval polling instead
 * of the rAF default: under software-WebGL load rAF callbacks can starve.
 */
export async function waitPhase(page: Page, phase: UiPhase, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const g = (window as unknown as { __game?: GameHook }).__game;
      return g !== undefined && g.phase === expected;
    },
    phase,
    { timeout, polling: 100 }
  );
}

/** Snapshot the live window.__game object. */
export function gameState(page: Page): Promise<GameHook> {
  return page.evaluate(() => (window as unknown as { __game: GameHook }).__game);
}

/** Create a room with an explicit name and wait for the waiting-room screen. */
export async function createRoom(page: Page, roomName: string): Promise<void> {
  await page.locator('#create-room-name').fill(roomName);
  await page.getByTestId('create-room-btn').click();
  await waitPhase(page, 'room');
}

/** Locator for the lobby room-list entry whose text contains `roomName`. */
export function roomItemByName(page: Page, roomName: string) {
  return page.getByTestId('room-item').filter({ hasText: roomName });
}

/**
 * From the lobby, wait for the entry of the named room to show up in the
 * live room list, click its JOIN button, and wait for the waiting room.
 */
export async function joinRoomByName(page: Page, roomName: string): Promise<void> {
  const item = roomItemByName(page, roomName);
  await expect(item).toHaveCount(1, { timeout: 15_000 });
  await item.getByTestId('room-join-btn').click();
  await waitPhase(page, 'room');
}

/** pageA creates the named room, pageB joins it from the live lobby list. */
export async function joinSameRoom(pageA: Page, pageB: Page, roomName: string): Promise<void> {
  await createRoom(pageA, roomName);
  await joinRoomByName(pageB, roomName);
}

/** Both players press READY (single click each — the button toggles). */
export async function bothReady(pageA: Page, pageB: Page): Promise<void> {
  await pageA.getByTestId('ready-btn').click();
  await pageB.getByTestId('ready-btn').click();
}

/**
 * Full match bootstrap: both pages must already be in the lobby. Creates the
 * room from pageA (=> playerIndex 0), joins from pageB (=> playerIndex 1),
 * readies both and waits through the real 3 s countdown until both report
 * phase 'playing'.
 */
export async function startMatch(pageA: Page, pageB: Page, roomName: string): Promise<void> {
  await joinSameRoom(pageA, pageB, roomName);
  await bothReady(pageA, pageB);
  await Promise.all([waitPhase(pageA, 'playing', 25_000), waitPhase(pageB, 'playing', 25_000)]);
}

/**
 * Repeatedly press a build hotkey on a Node-side interval. Returns a disposer;
 * always call it (e.g. in finally) before closing the page's context.
 */
export function buildSpam(page: Page, key = '1', intervalMs = 300): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    page.keyboard.press(key).catch(() => {
      // page may be navigating or closed — spam is best-effort by design
    });
  }, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Start collecting console errors and uncaught page errors. Returns the live
 * array; assert on it at the end of a test that expects a clean console.
 */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

export interface BuildWatch {
  /** largest credits decrease between two consecutive HUD updates */
  maxCreditDrop: number;
  /** highest number of queue chips ever rendered */
  maxQueue: number;
}

/**
 * Install MutationObservers on the HUD credits readout and the build queue
 * BEFORE issuing build commands. The credits dip and the queue chips only
 * exist for a fraction of a second on the accelerated preset (income refills
 * at 10/s, builds finish in ~0.5 s), so round-trip polling from the test
 * runner can miss them — observers inside the page cannot.
 */
export async function installBuildWatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const credEl = document.querySelector('[data-testid="hud-credits"]');
    const queueEl = document.querySelector('[data-testid="build-queue"]');
    if (!credEl || !queueEl) throw new Error('HUD not present — match not running?');
    const watch = { maxCreditDrop: 0, maxQueue: 0 };
    (window as unknown as { __buildWatch: typeof watch }).__buildWatch = watch;

    let lastCredits = Number(credEl.textContent);
    new MutationObserver(() => {
      const v = Number(credEl.textContent);
      if (!Number.isFinite(v)) return;
      const drop = lastCredits - v;
      if (drop > watch.maxCreditDrop) watch.maxCreditDrop = drop;
      lastCredits = v;
    }).observe(credEl, { childList: true, characterData: true, subtree: true });

    const countQueue = (): void => {
      const n = queueEl.querySelectorAll('[data-testid="queue-item"]').length;
      if (n > watch.maxQueue) watch.maxQueue = n;
    };
    countQueue();
    new MutationObserver(countQueue).observe(queueEl, { childList: true, subtree: true });
  });
}

/** Read back the watcher installed by installBuildWatch. */
export function readBuildWatch(page: Page): Promise<BuildWatch> {
  return page.evaluate(() => (window as unknown as { __buildWatch: BuildWatch }).__buildWatch);
}

export interface UnitTrailSample {
  /** ms since the tracker was armed */
  t: number;
  x: number;
  z: number;
  id: string;
  type?: string;
}

export interface UnitTrail {
  /** where the enemy mech stood when the tracker was armed (≈ enemy base) */
  enemyBase: { x: number; z: number };
  trail: UnitTrailSample[];
}

/**
 * Arm an in-page tracker (BEFORE building) that samples this player's first
 * own robot every 100 ms. Sampling inside the page is immune to the CDP
 * round-trip latency of this software-WebGL environment, so the first sample
 * lands near the factory and the trail captures the whole journey.
 *
 * Direction is asserted against the ENEMY MECH's starting position: the idle
 * opponent never moves out of their base, so "distance to it shrinks" is
 * exactly "the robot drives toward the enemy base" — without hardcoding map
 * coordinates. (Plain "x increases" would be wrong: player 0's left lane runs
 * a long leg along the west edge where x stays ≈ constant.)
 */
export async function installUnitTracker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as unknown as { __game?: GameHook }).__game;
    if (!g || g.playerIndex === null) throw new Error('no live match — cannot arm unit tracker');
    const enemy = g.entities.find((e) => e.kind === 'mech' && e.owner !== g.playerIndex);
    if (!enemy) throw new Error('enemy mech not in snapshot yet — cannot arm unit tracker');
    const watch: UnitTrail = { enemyBase: { x: enemy.x, z: enemy.z }, trail: [] };
    (window as unknown as { __unitTrail: UnitTrail }).__unitTrail = watch;
    const t0 = Date.now();
    const timer = setInterval(() => {
      const live = (window as unknown as { __game?: GameHook }).__game;
      if (!live || live.playerIndex === null) return;
      const u = live.entities.find((e) => e.kind === 'unit' && e.owner === live.playerIndex);
      if (u) watch.trail.push({ t: Date.now() - t0, x: u.x, z: u.z, id: u.id, type: u.type });
      if (watch.trail.length > 1200) clearInterval(timer); // safety stop after ~2 min
    }, 100);
  });
}

/** Read back the tracker installed by installUnitTracker. */
export function readUnitTrail(page: Page): Promise<UnitTrail> {
  return page.evaluate(() => (window as unknown as { __unitTrail: UnitTrail }).__unitTrail);
}

export function dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

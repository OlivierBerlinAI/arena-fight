/**
 * Lobby flow — two real browser contexts sharing one server.
 *
 * Covers: name entry, room creation, the live room list seen by the other
 * player (name / host / player count), joining, both players readying up,
 * the 3 s countdown overlay, the transition into a running match with
 * complementary player indices, and room removal when the creator leaves.
 */
import { expect, test } from '@playwright/test';
import {
  bothReady,
  closeAll,
  collectPageErrors,
  createRoom,
  createTwoPlayers,
  enterName,
  gameState,
  roomItemByName,
  uniqueRoomName,
  waitPhase,
  type TwoPlayers,
} from './helpers';

test.describe('lobby flow', () => {
  let players: TwoPlayers | null = null;

  test.afterEach(async () => {
    if (players) await closeAll(players.contexts);
    players = null;
  });

  test('two players go from name entry through room creation, join, ready and countdown into a running match', async ({
    browser,
  }) => {
    players = await createTwoPlayers(browser, { test: true });
    const { pageA, pageB } = players;
    const errorsA = collectPageErrors(pageA);
    const errorsB = collectPageErrors(pageB);

    // --- name entry → lobby
    await enterName(pageA, 'HostAlpha');
    await enterName(pageB, 'JoinBravo');
    await expect(pageA.getByTestId('lobby-screen')).toBeVisible();
    await expect(pageB.getByTestId('lobby-screen')).toBeVisible();

    // --- A creates a uniquely named room and lands in the waiting room
    const roomName = uniqueRoomName('e2e-lobby');
    await createRoom(pageA, roomName);
    await expect(pageA.getByTestId('room-screen')).toBeVisible();

    // --- B's live room list shows the room with name, host and player count
    const item = roomItemByName(pageB, roomName);
    await expect(item).toHaveCount(1, { timeout: 15_000 });
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-room-id', /.+/);
    await expect(item).toContainText(roomName);
    await expect(item).toContainText('HostAlpha'); // host name
    await expect(item).toContainText('1/2'); // player count before joining

    // --- B joins that specific room (never `.first()` on the list)
    await item.getByTestId('room-join-btn').click();
    await waitPhase(pageB, 'room');
    await expect(pageB.getByTestId('room-screen')).toBeVisible();

    // both players are listed in the waiting room (creator's view)
    await expect(pageA.getByTestId('player-list')).toContainText('HostAlpha', { timeout: 10_000 });
    await expect(pageA.getByTestId('player-list')).toContainText('JoinBravo');

    // --- both ready → countdown overlay appears in BOTH contexts (real 3 s window)
    await bothReady(pageA, pageB);
    await Promise.all([
      expect(pageA.getByTestId('countdown-overlay')).toBeVisible({ timeout: 10_000 }),
      expect(pageB.getByTestId('countdown-overlay')).toBeVisible({ timeout: 10_000 }),
    ]);

    // --- match starts in both contexts
    await Promise.all([waitPhase(pageA, 'playing', 25_000), waitPhase(pageB, 'playing', 25_000)]);
    const [stateA, stateB] = await Promise.all([gameState(pageA), gameState(pageB)]);
    expect(stateA.phase).toBe('playing');
    expect(stateB.phase).toBe('playing');
    expect(stateA.playerIndex).toBe(0); // creator
    expect(stateB.playerIndex).toBe(1); // joiner
    await expect(pageA.getByTestId('game-screen')).toBeVisible();
    await expect(pageB.getByTestId('game-screen')).toBeVisible();

    // --- the whole connect/hello/lobby/match-start flow must be console-clean
    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
  });

  test('a room disappears from the live lobby list of other players when its creator leaves', async ({
    browser,
  }) => {
    players = await createTwoPlayers(browser, { test: true });
    const { pageA, pageB } = players;

    await enterName(pageA, 'GhostHost');
    await enterName(pageB, 'Watcher');

    const roomName = uniqueRoomName('e2e-vanish');
    await createRoom(pageA, roomName);

    // B sees the room appear...
    const item = roomItemByName(pageB, roomName);
    await expect(item).toHaveCount(1, { timeout: 15_000 });

    // ...then the creator leaves before anyone joins
    await pageA.getByTestId('leave-room-btn').click();
    await waitPhase(pageA, 'lobby');
    await expect(pageA.getByTestId('lobby-screen')).toBeVisible();

    // ...and the room vanishes from B's live list
    await expect(item).toHaveCount(0, { timeout: 15_000 });
  });
});

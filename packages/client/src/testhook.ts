/**
 * The read-only `window.__game` object the Playwright e2e suite asserts
 * against. Installed at page load; mutated in place by the screen state
 * machine and the match controller. Entities are plain serialized data from
 * the latest snapshot — never live three.js objects.
 */

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

export const gameHook: GameHook = {
  phase: 'name',
  tick: null,
  ping: null,
  credits: null,
  snapshotAge: null,
  playerIndex: null,
  winner: null,
  entities: [],
};

/** Reset all match-related fields (entering the lobby / leaving a room). */
export function resetMatchHook(): void {
  gameHook.tick = null;
  gameHook.credits = null;
  gameHook.snapshotAge = null;
  gameHook.playerIndex = null;
  gameHook.winner = null;
  gameHook.entities = [];
}

export function installGameHook(): void {
  (window as unknown as { __game: GameHook }).__game = gameHook;
}

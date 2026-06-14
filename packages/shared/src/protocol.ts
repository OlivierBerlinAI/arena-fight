/**
 * The complete WebSocket wire protocol: discriminated-union message types for
 * both directions plus server-side validation of untrusted client input.
 * JSON over WebSocket; no `any` anywhere in this layer.
 */
import { isBalancePresetName } from './balance.js';
import type { BalancePresetName, UnitType } from './balance.js';
import type {
  MatchPhase,
  MechMode,
  Ownership,
  PlayerIndex,
  PlayerStats,
  ProjectileKind,
  SimEvent,
} from './sim/state.js';

export const PROTOCOL_VERSION = 1;
export const MAX_NAME_LENGTH = 24;
export const MAX_ROOM_NAME_LENGTH = 32;

// ---------------------------------------------------------------------------
// Snapshot wire format
// ---------------------------------------------------------------------------

export interface MechSnap {
  player: PlayerIndex;
  x: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  mode: MechMode;
  hp: number;
  alive: boolean;
  heat: number;
  overheated: boolean;
  rocketAmmo: number;
  reloading: boolean;
  reloadFrac: number;
  /** spawn protection active */
  shielded: boolean;
  respawnInTicks: number;
}

export interface PlayerSnap {
  credits: number;
  queue: { unit: UnitType; progress: number }[];
  unitsAlive: number;
  unitCap: number;
  stats: PlayerStats;
}

export interface UnitSnap {
  id: number;
  owner: PlayerIndex;
  type: UnitType;
  x: number;
  z: number;
  yaw: number;
  hp: number;
}

export interface TurretSnap {
  id: number;
  x: number;
  z: number;
  owner: Ownership;
  hp: number;
  alive: boolean;
  capOwner: Ownership;
  /** 0..1 */
  capProgress: number;
  headYaw: number;
  respawnInTicks: number;
}

export interface ProjectileSnap {
  id: number;
  kind: ProjectileKind;
  owner: PlayerIndex;
  x: number;
  z: number;
  vx: number;
  vz: number;
}

export interface Snapshot {
  tick: number;
  phase: MatchPhase;
  winner: Ownership;
  mechs: MechSnap[];
  players: PlayerSnap[];
  units: UnitSnap[];
  turrets: TurretSnap[];
  projectiles: ProjectileSnap[];
}

// ---------------------------------------------------------------------------
// Lobby / room wire format
// ---------------------------------------------------------------------------

export type RoomStatus = 'waiting' | 'countdown' | 'playing';

export interface RoomSummary {
  id: string;
  name: string;
  host: string;
  playerCount: number;
  maxPlayers: number;
  status: RoomStatus;
}

export interface RoomInfo {
  id: string;
  name: string;
  preset: BalancePresetName;
  status: RoomStatus;
  players: { name: string; ready: boolean }[];
  /** your seat in the room (and your PlayerIndex once the match starts) */
  youIndex: number;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'hello'; name: string }
  | { type: 'createRoom'; roomName?: string; preset?: BalancePresetName }
  | { type: 'joinRoom'; roomId: string }
  | { type: 'leaveRoom' }
  | { type: 'ready'; ready: boolean }
  | { type: 'input'; mx: number; mz: number; aimX: number; aimZ: number; fire: boolean; alt: boolean; mode: MechMode }
  | { type: 'build'; unit: UnitType }
  | { type: 'ping'; t: number };

export type MatchEndReason = 'core' | 'forfeit';

/** Every error code the server can emit — a closed union so the client cannot drift. */
export type ServerErrorCode =
  | 'badMessage'
  | 'helloRequired'
  | 'alreadyInRoom'
  | 'noSuchRoom'
  | 'roomUnavailable'
  | 'notInRoom'
  | 'buildUnavailable'
  | 'internal';

export type ServerMessage =
  | { type: 'welcome'; clientId: string; protocolVersion: number }
  | { type: 'lobbyState'; rooms: RoomSummary[] }
  | { type: 'roomState'; room: RoomInfo }
  | { type: 'countdown'; seconds: number }
  | {
      type: 'matchStart';
      seed: number;
      playerIndex: PlayerIndex;
      preset: BalancePresetName;
      tickRate: number;
      tickMs: number;
    }
  | { type: 'snapshot'; snap: Snapshot; events: SimEvent[] }
  | {
      type: 'matchEnd';
      winner: PlayerIndex;
      reason: MatchEndReason;
      durationTicks: number;
      stats: [PlayerStats, PlayerStats];
    }
  | { type: 'error'; code: ServerErrorCode; message: string }
  | { type: 'pong'; t: number };

// ---------------------------------------------------------------------------
// Validation — the server never trusts a client message.
// ---------------------------------------------------------------------------

export type ValidationResult = { ok: true; msg: ClientMessage } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function cleanString(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  // strip control characters
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (s.length === 0 || s.length > maxLen) return null;
  return s;
}

function isUnitType(v: unknown): v is UnitType {
  return v === 'hovertank' || v === 'dreadnought';
}

function isMechMode(v: unknown): v is MechMode {
  return v === 'walker' || v === 'hover';
}

/** Parse raw socket data (string) into a validated ClientMessage. */
export function parseClientMessage(raw: unknown): ValidationResult {
  if (typeof raw !== 'string') return { ok: false, error: 'non-string frame' };
  if (raw.length > 4096) return { ok: false, error: 'frame too large' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'malformed JSON' };
  }
  return validateClientMessage(data);
}

export function validateClientMessage(data: unknown): ValidationResult {
  if (!isRecord(data)) return { ok: false, error: 'message is not an object' };
  const type = data.type;
  if (typeof type !== 'string') return { ok: false, error: 'missing type' };

  switch (type) {
    case 'hello': {
      const name = cleanString(data.name, MAX_NAME_LENGTH);
      if (!name) return { ok: false, error: 'hello: invalid name' };
      return { ok: true, msg: { type, name } };
    }
    case 'createRoom': {
      let roomName: string | undefined;
      if (data.roomName !== undefined) {
        const cleaned = cleanString(data.roomName, MAX_ROOM_NAME_LENGTH);
        if (!cleaned) return { ok: false, error: 'createRoom: invalid roomName' };
        roomName = cleaned;
      }
      let preset: BalancePresetName | undefined;
      if (data.preset !== undefined) {
        if (!isBalancePresetName(data.preset)) {
          return { ok: false, error: 'createRoom: invalid preset' };
        }
        preset = data.preset;
      }
      return { ok: true, msg: { type, roomName, preset } };
    }
    case 'joinRoom': {
      const roomId = cleanString(data.roomId, 64);
      if (!roomId) return { ok: false, error: 'joinRoom: invalid roomId' };
      return { ok: true, msg: { type, roomId } };
    }
    case 'leaveRoom':
      return { ok: true, msg: { type } };
    case 'ready': {
      if (typeof data.ready !== 'boolean') return { ok: false, error: 'ready: invalid flag' };
      return { ok: true, msg: { type, ready: data.ready } };
    }
    case 'input': {
      const { mx, mz, aimX, aimZ, fire, alt } = data;
      if (!isFiniteNumber(mx) || !isFiniteNumber(mz) || !isFiniteNumber(aimX) || !isFiniteNumber(aimZ)) {
        return { ok: false, error: 'input: invalid numbers' };
      }
      if (typeof fire !== 'boolean' || typeof alt !== 'boolean') {
        return { ok: false, error: 'input: invalid flags' };
      }
      // `mode` is optional for backward compatibility: absent → walker.
      let mode: MechMode = 'walker';
      if (data.mode !== undefined) {
        if (!isMechMode(data.mode)) return { ok: false, error: 'input: invalid mode' };
        mode = data.mode;
      }
      return { ok: true, msg: { type, mx, mz, aimX, aimZ, fire, alt, mode } };
    }
    case 'build': {
      if (!isUnitType(data.unit)) return { ok: false, error: 'build: invalid unit' };
      return { ok: true, msg: { type, unit: data.unit } };
    }
    case 'ping': {
      if (!isFiniteNumber(data.t)) return { ok: false, error: 'ping: invalid timestamp' };
      return { ok: true, msg: { type, t: data.t } };
    }
    default:
      return { ok: false, error: `unknown type: ${type}` };
  }
}

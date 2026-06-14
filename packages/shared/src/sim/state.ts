import type { Vec2 } from '../math.js';
import type { Balance, UnitType } from '../balance.js';
import { GAME_MAP } from '../map.js';
import type { LaneId } from '../map.js';

export type PlayerIndex = 0 | 1;
/** -1 = neutral / nobody */
export type Ownership = PlayerIndex | -1;

/**
 * Locomotion mode. `walker`: grounded, slower, both weapons. `hover`: glides
 * faster with low drag, fires the laser instead of the gatling, rockets locked.
 */
export type MechMode = 'walker' | 'hover';

export interface MechState {
  player: PlayerIndex;
  pos: Vec2;
  vel: Vec2;
  /** torso/aim direction in radians (atan2 on the XZ plane) */
  yaw: number;
  /** current locomotion mode (set from player input each living tick) */
  mode: MechMode;
  hp: number;
  alive: boolean;
  /** tick at which a dead mech respawns */
  respawnAtTick: number;
  /** spawn protection: invulnerable until this tick */
  protectedUntilTick: number;
  heat: number;
  /** > current tick means the gatling is locked out from overheating */
  overheatedUntilTick: number;
  /** next tick the gatling may fire */
  gatlingReadyAtTick: number;
  rocketAmmo: number;
  /** next tick a rocket may fire */
  rocketReadyAtTick: number;
  /** while > current tick, the launcher is reloading; ammo refills when it elapses */
  reloadEndTick: number;
}

export interface QueueItem {
  unit: UnitType;
  ticksLeft: number;
  totalTicks: number;
}

export interface PlayerStats {
  robotsBuilt: number;
  robotsDestroyed: number;
  robotsLost: number;
  turretCaptures: number;
  kills: number;
  deaths: number;
}

export interface PlayerState {
  index: PlayerIndex;
  credits: number;
  queue: QueueItem[];
  /** alternates which lane the next robot takes */
  nextLane: LaneId;
  stats: PlayerStats;
  /** throttles the "base under attack" warning */
  lastBaseAttackWarnTick: number;
}

export interface UnitState {
  id: number;
  owner: PlayerIndex;
  type: UnitType;
  pos: Vec2;
  yaw: number;
  /** facing of the aiming turret (Heavy Tank aims this independently of body) */
  turretYaw: number;
  hp: number;
  lane: LaneId;
  waypointIndex: number;
  fireReadyAtTick: number;
  /** id of current target entity, render hint only */
  targetKey: string | null;
}

export interface TurretState {
  id: number;
  pos: Vec2;
  owner: Ownership;
  hp: number;
  alive: boolean;
  /** when destroyed: tick at which it respawns neutral */
  respawnAtTick: number;
  /** which player the current capture progress belongs to */
  capOwner: Ownership;
  /** 0..captureTicks */
  capProgress: number;
  /** render hint: which way the head points */
  headYaw: number;
  fireReadyAtTick: number;
}

export type ProjectileKind = 'gatling' | 'laser' | 'rocket' | 'unitLight' | 'unitHeavy' | 'turret';

export interface ProjectileState {
  id: number;
  /** player credited with damage; turret projectiles use the turret owner */
  owner: PlayerIndex;
  kind: ProjectileKind;
  pos: Vec2;
  vel: Vec2;
  damage: number;
  /** 0 = no splash */
  splashRadius: number;
  /** tick at which the projectile expires (splash kinds detonate) */
  diesAtTick: number;
}

export type MatchPhase = 'playing' | 'ended';

export interface SimState {
  tick: number;
  phase: MatchPhase;
  winner: Ownership;
  seed: number;
  rngState: number;
  mechs: [MechState, MechState];
  players: [PlayerState, PlayerState];
  units: UnitState[];
  turrets: TurretState[];
  projectiles: ProjectileState[];
  nextEntityId: number;
}

// ---------------------------------------------------------------------------

export type SimEvent =
  | { type: 'matchEnd'; winner: PlayerIndex; byUnitId: number }
  | { type: 'turretCaptured'; turretId: number; player: PlayerIndex }
  | { type: 'turretDestroyed'; turretId: number; byPlayer: PlayerIndex; previousOwner: Ownership }
  | { type: 'turretRespawned'; turretId: number }
  | { type: 'unitQueued'; player: PlayerIndex; unit: UnitType }
  | { type: 'unitDeployed'; player: PlayerIndex; unit: UnitType; unitId: number }
  | { type: 'unitDestroyed'; unitId: number; owner: PlayerIndex; unit: UnitType; byPlayer: Ownership }
  | { type: 'buildRejected'; player: PlayerIndex; unit: UnitType; reason: 'credits' | 'queueFull' | 'unitCap' | 'matchOver' }
  | { type: 'mechKilled'; victim: PlayerIndex; byPlayer: Ownership }
  | { type: 'mechRespawned'; player: PlayerIndex }
  | { type: 'baseUnderAttack'; player: PlayerIndex };

export interface PlayerInput {
  /** desired world-space move direction, clamped to length 1 by the sim */
  mx: number;
  mz: number;
  /** world-space ground point the mouse aims at */
  aimX: number;
  aimZ: number;
  /** primary fire held (gatling) */
  fire: boolean;
  /** secondary fire held (rockets) */
  alt: boolean;
  /** desired locomotion mode (the client holds the toggle and resends it) */
  mode: MechMode;
}

export type SimCommand = { type: 'build'; player: PlayerIndex; unit: UnitType };

export const NULL_INPUT: PlayerInput = { mx: 0, mz: 0, aimX: 0, aimZ: 0, fire: false, alt: false, mode: 'walker' };

// ---------------------------------------------------------------------------

function createMech(player: PlayerIndex, balance: Balance): MechState {
  const spawn = GAME_MAP.bases[player].mechSpawn;
  return {
    player,
    pos: { ...spawn },
    vel: { x: 0, z: 0 },
    yaw: player === 0 ? Math.PI / 4 : -Math.PI * 0.75, // face map center
    mode: 'walker',
    hp: balance.mech.maxHp,
    alive: true,
    respawnAtTick: 0,
    protectedUntilTick: balance.mech.spawnProtectionTicks,
    heat: 0,
    overheatedUntilTick: 0,
    gatlingReadyAtTick: 0,
    rocketAmmo: balance.rocket.magazine,
    rocketReadyAtTick: 0,
    reloadEndTick: 0,
  };
}

function createPlayer(index: PlayerIndex, balance: Balance): PlayerState {
  return {
    index,
    credits: balance.economy.startingCredits,
    queue: [],
    nextLane: 'left',
    stats: {
      robotsBuilt: 0,
      robotsDestroyed: 0,
      robotsLost: 0,
      turretCaptures: 0,
      kills: 0,
      deaths: 0,
    },
    lastBaseAttackWarnTick: -100000,
  };
}

export function createInitialState(seed: number, balance: Balance): SimState {
  return {
    tick: 0,
    phase: 'playing',
    winner: -1,
    seed,
    rngState: seed >>> 0,
    mechs: [createMech(0, balance), createMech(1, balance)],
    players: [createPlayer(0, balance), createPlayer(1, balance)],
    units: [],
    turrets: GAME_MAP.turrets.map((pos, id) => ({
      id,
      pos: { ...pos },
      owner: -1 as Ownership,
      hp: balance.turret.hp,
      alive: true,
      respawnAtTick: 0,
      capOwner: -1 as Ownership,
      capProgress: 0,
      headYaw: 0,
      fireReadyAtTick: 0,
    })),
    projectiles: [],
    nextEntityId: 1,
  };
}

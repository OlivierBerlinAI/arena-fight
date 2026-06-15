/**
 * Resolves the editable gameplay config (see balance.config.ts) into the
 * tick-scaled `Balance` the simulation consumes.
 *
 * Durations in the config are expressed in seconds; here they are converted to
 * simulation ticks at a configurable tick rate (ticks per simulated second)
 * carried on each Balance as `tickRate`. Because every tick-based field is
 * `seconds * tickRate`, the game feel — expressed in seconds — is identical at
 * any tick rate; only the simulation fidelity changes.
 *
 * SIM_TICK_RATE is the reference rate the exported DEFAULT_BALANCE / TEST_BALANCE
 * are scaled for (and the default for makeBalance / getBalance). The standalone
 * server picks its own rate via the TICK_RATE env var (default 100, see
 * startServer), rescales the balance with getBalance(preset, rate) and sends it
 * to clients in matchStart. The server's TICK_MS env var changes wall-clock
 * pacing only — it never changes simulation semantics.
 *
 * To change gameplay numbers, edit balance.config.ts — not this file.
 */
import type { ProjectileKind } from './sim/state.js';
import type {
  BalanceConfig,
  DamageModifierConfig,
  DamageTargetClass,
  UnitConfig,
} from './balance.config.js';
import { BALANCE_CONFIG, TEST_CONFIG_OVERRIDES } from './balance.config.js';

export const SIM_TICK_RATE = 30;
export const DEFAULT_TICK_MS = 1000 / SIM_TICK_RATE;
/** Snapshots are broadcast every Nth tick (2 → 15 Hz at SIM_TICK_RATE). */
export const SNAPSHOT_EVERY_TICKS = 2;

export type UnitType = 'hovertank' | 'dreadnought';
export type BalancePresetName = 'default' | 'test';

export interface UnitBalance {
  cost: number;
  buildTicks: number;
  /** units per second */
  speed: number;
  hp: number;
  radius: number;
  damage: number;
  /** 0 = no splash */
  splashRadius: number;
  range: number;
  fireIntervalTicks: number;
  projectileSpeed: number;
  /** how fast the unit rotates to aim at a target, radians per second */
  turnRate: number;
}

export interface Balance {
  /** simulation ticks per simulated second this balance is scaled for */
  tickRate: number;
  mech: {
    maxHp: number;
    radius: number;
    /** units per second^2 (walker mode) */
    accel: number;
    /** units per second (walker mode) */
    maxSpeed: number;
    /** exponential friction factor per second (walker mode) */
    friction: number;
    /** units per second^2 while in hover mode */
    hoverAccel: number;
    /** units per second while in hover mode (faster glide) */
    hoverMaxSpeed: number;
    /** lower friction in hover mode → momentum/gliding */
    hoverFriction: number;
    respawnTicks: number;
    spawnProtectionTicks: number;
  };
  gatling: {
    damage: number;
    intervalTicks: number;
    /** max aim deviation in radians */
    spread: number;
    projectileSpeed: number;
    projectileTtlTicks: number;
    heatPerShot: number;
    /** heat lost per tick while not firing */
    coolPerTick: number;
    overheatAt: number;
    overheatLockTicks: number;
  };
  /**
   * Hover-mode primary weapon. Replaces the gatling while hovering; rockets are
   * disabled in hover. Shares the gatling's heat meter (overheatAt / coolPerTick
   * / overheatLockTicks) so there is a single heat system regardless of mode.
   */
  laser: {
    damage: number;
    intervalTicks: number;
    /** max aim deviation in radians (0 = pinpoint) */
    spread: number;
    projectileSpeed: number;
    projectileTtlTicks: number;
    heatPerShot: number;
  };
  rocket: {
    damage: number;
    splashRadius: number;
    /** damage multiplier at the edge of the splash radius */
    splashMinFactor: number;
    projectileSpeed: number;
    projectileTtlTicks: number;
    cooldownTicks: number;
    magazine: number;
    reloadTicks: number;
  };
  economy: {
    startingCredits: number;
    passivePerSecond: number;
    perTurretPerSecond: number;
    /** one-off credit reward to the killer: enemy mech, or a destroyed enemy unit */
    killBounty: { mech: number } & Record<UnitType, number>;
  };
  units: Record<UnitType, UnitBalance>;
  unitCap: number;
  queueMax: number;
  turret: {
    hp: number;
    captureTicks: number;
    respawnTicks: number;
    range: number;
    damage: number;
    fireIntervalTicks: number;
    projectileSpeed: number;
    /** how fast the head rotates to aim at a target, radians per second */
    turnRate: number;
    /** collision/body radius of the tower */
    radius: number;
    /** radius of the capture pad around the tower */
    padRadius: number;
  };
  /**
   * Per-weapon damage multipliers vs each target class (1 = full damage),
   * resolved from balance.config.ts into a complete table so the sim can look
   * up `damageModifiers[weaponKind][targetClass]` without any defaulting.
   */
  damageModifiers: Record<ProjectileKind, Record<DamageTargetClass, number>>;
}

/** Round a duration expressed in seconds to whole simulation ticks. */
function ticks(seconds: number, T: number): number {
  return Math.round(seconds * T);
}

function scaleUnit(u: UnitConfig, T: number): UnitBalance {
  return {
    cost: u.cost,
    buildTicks: ticks(u.buildSeconds, T),
    speed: u.speed,
    hp: u.hp,
    radius: u.radius,
    damage: u.damage,
    splashRadius: u.splashRadius,
    range: u.range,
    fireIntervalTicks: ticks(u.fireIntervalSeconds, T),
    projectileSpeed: u.projectileSpeed,
    turnRate: u.turnRate,
  };
}

// Every weapon kind and target class, so the resolved modifier table is total.
// Keep in sync with ProjectileKind (sim/state.ts) and DamageTargetClass.
const ALL_PROJECTILE_KINDS: readonly ProjectileKind[] = [
  'gatling',
  'laser',
  'rocket',
  'unitLight',
  'unitHeavy',
  'turret',
];
const ALL_TARGET_CLASSES: readonly DamageTargetClass[] = ['mech', 'unit', 'turret'];

/** Expand the sparse config table to a full weapon×target grid, defaulting to 1. */
function resolveDamageModifiers(
  cfg: DamageModifierConfig
): Record<ProjectileKind, Record<DamageTargetClass, number>> {
  const out = {} as Record<ProjectileKind, Record<DamageTargetClass, number>>;
  for (const kind of ALL_PROJECTILE_KINDS) {
    out[kind] = { mech: 1, unit: 1, turret: 1 };
    const over = cfg[kind];
    if (!over) continue;
    for (const tc of ALL_TARGET_CLASSES) {
      const v = over[tc];
      if (typeof v === 'number') out[kind][tc] = v;
    }
  }
  return out;
}

/** Turn the human-edited config into a tick-scaled Balance for tick rate `T`. */
function scaleConfig(c: BalanceConfig, T: number): Balance {
  return {
    tickRate: T,
    mech: {
      maxHp: c.mech.maxHp,
      radius: c.mech.radius,
      accel: c.mech.accel,
      maxSpeed: c.mech.maxSpeed,
      friction: c.mech.friction,
      hoverAccel: c.mech.hoverAccel,
      hoverMaxSpeed: c.mech.hoverMaxSpeed,
      hoverFriction: c.mech.hoverFriction,
      respawnTicks: ticks(c.mech.respawnSeconds, T),
      spawnProtectionTicks: ticks(c.mech.spawnProtectionSeconds, T),
    },
    gatling: {
      damage: c.gatling.damage,
      intervalTicks: ticks(c.gatling.fireIntervalSeconds, T),
      spread: c.gatling.spread,
      projectileSpeed: c.gatling.projectileSpeed,
      projectileTtlTicks: ticks(c.gatling.projectileTtlSeconds, T),
      heatPerShot: c.gatling.heatPerShot,
      coolPerTick: c.gatling.coolPerSecond / T,
      overheatAt: c.gatling.overheatAt,
      overheatLockTicks: ticks(c.gatling.overheatLockSeconds, T),
    },
    laser: {
      damage: c.laser.damage,
      intervalTicks: ticks(c.laser.fireIntervalSeconds, T),
      spread: c.laser.spread,
      projectileSpeed: c.laser.projectileSpeed,
      projectileTtlTicks: ticks(c.laser.projectileTtlSeconds, T),
      heatPerShot: c.laser.heatPerShot,
    },
    rocket: {
      damage: c.rocket.damage,
      splashRadius: c.rocket.splashRadius,
      splashMinFactor: c.rocket.splashMinFactor,
      projectileSpeed: c.rocket.projectileSpeed,
      projectileTtlTicks: ticks(c.rocket.projectileTtlSeconds, T),
      cooldownTicks: ticks(c.rocket.cooldownSeconds, T),
      magazine: c.rocket.magazine,
      reloadTicks: ticks(c.rocket.reloadSeconds, T),
    },
    economy: {
      startingCredits: c.economy.startingCredits,
      passivePerSecond: c.economy.passivePerSecond,
      perTurretPerSecond: c.economy.perTurretPerSecond,
      killBounty: { ...c.economy.killBounty },
    },
    units: {
      hovertank: scaleUnit(c.units.hovertank, T),
      dreadnought: scaleUnit(c.units.dreadnought, T),
    },
    unitCap: c.unitCap,
    queueMax: c.queueMax,
    turret: {
      hp: c.turret.hp,
      captureTicks: ticks(c.turret.captureSeconds, T),
      respawnTicks: ticks(c.turret.respawnSeconds, T),
      range: c.turret.range,
      damage: c.turret.damage,
      fireIntervalTicks: ticks(c.turret.fireIntervalSeconds, T),
      projectileSpeed: c.turret.projectileSpeed,
      turnRate: c.turret.turnRate,
      radius: c.turret.radius,
      padRadius: c.turret.padRadius,
    },
    damageModifiers: resolveDamageModifiers(c.damageModifiers),
  };
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Overlay a sparse set of overrides onto a base config (used for the test preset). */
function mergeConfig<T>(base: T, over: DeepPartial<T>): T {
  const out: T = Array.isArray(base) ? ([...(base as unknown[])] as T) : { ...base };
  for (const key of Object.keys(over) as (keyof T)[]) {
    const ov = over[key];
    if (ov === undefined) continue;
    const bv = base[key];
    if (
      bv &&
      typeof bv === 'object' &&
      !Array.isArray(bv) &&
      ov &&
      typeof ov === 'object' &&
      !Array.isArray(ov)
    ) {
      out[key] = mergeConfig(bv, ov as DeepPartial<typeof bv>);
    } else {
      out[key] = ov as T[keyof T];
    }
  }
  return out;
}

const TEST_BALANCE_CONFIG: BalanceConfig = mergeConfig(BALANCE_CONFIG, TEST_CONFIG_OVERRIDES);

/** Build a preset's balance scaled to `tickRate` ticks per simulated second. */
export function makeBalance(name: BalancePresetName, tickRate: number = SIM_TICK_RATE): Balance {
  return scaleConfig(name === 'test' ? TEST_BALANCE_CONFIG : BALANCE_CONFIG, tickRate);
}

export const DEFAULT_BALANCE: Balance = makeBalance('default');
export const TEST_BALANCE: Balance = makeBalance('test');

/**
 * Resolve a preset to its balance. At the default tick rate the cached presets
 * are returned; a custom rate (server TICK_RATE) builds a freshly scaled copy.
 */
export function getBalance(name: BalancePresetName, tickRate: number = SIM_TICK_RATE): Balance {
  if (tickRate === SIM_TICK_RATE) return name === 'test' ? TEST_BALANCE : DEFAULT_BALANCE;
  return makeBalance(name, tickRate);
}

export function isBalancePresetName(v: unknown): v is BalancePresetName {
  return v === 'default' || v === 'test';
}

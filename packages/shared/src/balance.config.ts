/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  GAMEPLAY BALANCE — edit me!                                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * This is the single place to tweak every gameplay number: weapon stats, unit
 * stats, the economy, turrets and the per-weapon damage effects. Change a value,
 * rebuild (`docker compose up -d --build`, or restart `npm run dev`), and both
 * the server and the client pick it up.
 *
 * Units & conventions, so you never have to guess:
 *   • Durations are in SECONDS (e.g. `respawnSeconds: 4`). The engine converts
 *     them to simulation ticks for you, so the feel is identical at any tick rate.
 *   • Rates are PER SECOND (`coolPerSecond`, `passivePerSecond`, fire cadence is
 *     `fireIntervalSeconds` = seconds between shots; 0.1 → 10 shots/s).
 *   • Everything else is absolute: damage (HP), distances/speeds (world units &
 *     units/second), credits, radians, etc.
 *
 * The TEST preset (accelerated, for automated tests / `?test=1`) only lists the
 * handful of fields it overrides — see TEST_CONFIG_OVERRIDES at the bottom.
 */
import type { ProjectileKind } from './sim/state.js';

/** Target classes a shot can land on, for the damage-modifier table below. */
export type DamageTargetClass = 'mech' | 'unit' | 'turret';

/**
 * Per-weapon damage multipliers against each target class. 1 = full damage.
 * Anything you omit defaults to 1, so you only list the exceptions.
 *
 * Weapon kinds: 'gatling' (mech walker), 'laser' (mech hover), 'rocket' (mech),
 * 'unitLight' (hovertank), 'unitHeavy' (dreadnought), 'turret'.
 */
export type DamageModifierConfig = Partial<
  Record<ProjectileKind, Partial<Record<DamageTargetClass, number>>>
>;

export interface UnitConfig {
  cost: number;
  buildSeconds: number;
  /** units per second */
  speed: number;
  hp: number;
  radius: number;
  damage: number;
  /** 0 = no splash */
  splashRadius: number;
  range: number;
  /** seconds between shots */
  fireIntervalSeconds: number;
  projectileSpeed: number;
  /** how fast it rotates to aim, radians per second */
  turnRate: number;
}

export interface BalanceConfig {
  mech: {
    maxHp: number;
    radius: number;
    /** units per second^2 (walker mode) */
    accel: number;
    /** units per second (walker mode) */
    maxSpeed: number;
    /** exponential friction factor per second (walker mode) */
    friction: number;
    hoverAccel: number;
    hoverMaxSpeed: number;
    hoverFriction: number;
    respawnSeconds: number;
    spawnProtectionSeconds: number;
  };
  gatling: {
    damage: number;
    /** seconds between shots (0.1 → 10 shots/s) */
    fireIntervalSeconds: number;
    /** max aim deviation in radians */
    spread: number;
    projectileSpeed: number;
    projectileTtlSeconds: number;
    heatPerShot: number;
    /** heat shed per second while not firing */
    coolPerSecond: number;
    overheatAt: number;
    overheatLockSeconds: number;
  };
  laser: {
    damage: number;
    fireIntervalSeconds: number;
    /** max aim deviation in radians (0 = pinpoint) */
    spread: number;
    projectileSpeed: number;
    projectileTtlSeconds: number;
    heatPerShot: number;
  };
  rocket: {
    damage: number;
    splashRadius: number;
    /** damage multiplier at the edge of the splash radius */
    splashMinFactor: number;
    projectileSpeed: number;
    projectileTtlSeconds: number;
    cooldownSeconds: number;
    magazine: number;
    reloadSeconds: number;
  };
  economy: {
    startingCredits: number;
    passivePerSecond: number;
    perTurretPerSecond: number;
    /** one-off credit reward to the killer */
    killBounty: { mech: number; hovertank: number; dreadnought: number };
  };
  units: {
    hovertank: UnitConfig;
    dreadnought: UnitConfig;
  };
  /** max live units a player can field at once */
  unitCap: number;
  /** max units queued for production at once */
  queueMax: number;
  turret: {
    hp: number;
    captureSeconds: number;
    respawnSeconds: number;
    range: number;
    damage: number;
    fireIntervalSeconds: number;
    projectileSpeed: number;
    turnRate: number;
    /** collision/body radius of the tower */
    radius: number;
    /** radius of the capture pad around the tower */
    padRadius: number;
  };
  damageModifiers: DamageModifierConfig;
}

/** The live game's balance. This is the one you'll usually edit. */
export const BALANCE_CONFIG: BalanceConfig = {
  mech: {
    maxHp: 100,
    radius: 1.1,
    accel: 55,
    maxSpeed: 11,
    friction: 5,
    hoverAccel: 58,
    hoverMaxSpeed: 20, // glides noticeably faster than the walker's 11
    hoverFriction: 2.6, // low drag → drifting/gliding feel
    respawnSeconds: 4,
    spawnProtectionSeconds: 2,
  },
  gatling: {
    damage: 3,
    fireIntervalSeconds: 0.1, // 10 shots/s → 30 dps
    spread: 0.04,
    projectileSpeed: 70,
    projectileTtlSeconds: 1,
    heatPerShot: 5.5, // ~18 shots ≈ 1.8 s sustained before overheat
    coolPerSecond: 45,
    overheatAt: 100,
    overheatLockSeconds: 2,
  },
  laser: {
    damage: 4, // sole hover weapon (no rockets) → slightly above gatling's 3
    fireIntervalSeconds: 1 / 7.5, // 7.5 shots/s → ~30 dps, same ballpark as the gatling
    spread: 0, // pinpoint energy bolt
    projectileSpeed: 120, // beam-fast
    projectileTtlSeconds: 0.5,
    heatPerShot: 6.5, // overheats on a similar timescale to the gatling
  },
  rocket: {
    damage: 45,
    splashRadius: 4,
    splashMinFactor: 0.25,
    projectileSpeed: 26,
    projectileTtlSeconds: 4,
    cooldownSeconds: 1.5,
    magazine: 3,
    reloadSeconds: 3,
  },
  economy: {
    startingCredits: 100,
    passivePerSecond: 1,
    perTurretPerSecond: 1,
    killBounty: { mech: 50, dreadnought: 40, hovertank: 10 },
  },
  units: {
    hovertank: {
      cost: 50,
      buildSeconds: 5,
      speed: 5.5,
      hp: 80,
      radius: 0.9,
      damage: 6,
      splashRadius: 0,
      range: 11,
      fireIntervalSeconds: 0.8,
      projectileSpeed: 45,
      turnRate: 3.5, // nimble: swings its gun around quickly
    },
    dreadnought: {
      cost: 400,
      buildSeconds: 15,
      speed: 2.6,
      hp: 400,
      radius: 1.6,
      damage: 28,
      splashRadius: 3.5,
      range: 13,
      fireIntervalSeconds: 1.6,
      projectileSpeed: 30,
      turnRate: 1.6, // body/travel turn rate; its turret aims separately
    },
  },
  unitCap: 8,
  queueMax: 3,
  turret: {
    hp: 300,
    captureSeconds: 3,
    respawnSeconds: 30,
    range: 17,
    damage: 8,
    fireIntervalSeconds: 0.6,
    projectileSpeed: 55,
    turnRate: 2.4, // sweeps its head around to track a target
    radius: 1.3,
    padRadius: 3.5,
  },

  // ── Damage effects by weapon vs target ─────────────────────────────────────
  // 1 = full damage; omit a target to leave it at 1. Examples to play with:
  //   rocket:  { mech: 1.5 }            // rockets hit mechs 50% harder
  //   gatling: { turret: 0.25 }         // bullets barely scratch towers
  damageModifiers: {
    laser: { turret: 0.5 }, // energy bolts do half damage to turrets
  },
};

/**
 * Overrides for the accelerated TEST preset — only the fields that differ from
 * BALANCE_CONFIG above. Anything not listed here inherits the live value.
 */
export const TEST_CONFIG_OVERRIDES = {
  mech: { respawnSeconds: 1, spawnProtectionSeconds: 1 },
  economy: { startingCredits: 500, passivePerSecond: 10, perTurretPerSecond: 10 },
  units: {
    hovertank: { buildSeconds: 0.5, speed: 22 },
    // Cheaper than the live game's 400 so accelerated tests can queue a few up
    // front without inflating starting credits.
    dreadnought: { cost: 200, buildSeconds: 1.5, speed: 12 },
  },
  turret: { captureSeconds: 1, respawnSeconds: 5 },
};

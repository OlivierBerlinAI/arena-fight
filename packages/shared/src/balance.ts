/**
 * Every tunable gameplay number lives here. Durations are expressed in
 * simulation ticks; the simulation runs at a configurable tick rate (ticks per
 * simulated second) carried on each Balance as `tickRate`. Every tick-based
 * field is derived from that rate, so the game feel — expressed in seconds — is
 * identical at any tick rate; only the simulation fidelity changes.
 *
 * SIM_TICK_RATE is the reference rate the exported DEFAULT_BALANCE / TEST_BALANCE
 * are scaled for (and the default for makeBalance / getBalance). The standalone
 * server picks its own rate via the TICK_RATE env var (default 100, see
 * startServer), rescales the balance with getBalance(preset, rate) and sends it
 * to clients in matchStart. The server's TICK_MS env var changes wall-clock
 * pacing only — it never changes simulation semantics.
 */

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
    /** collision/body radius of the tower */
    radius: number;
    /** radius of the capture pad around the tower */
    padRadius: number;
  };
}

/**
 * Build the default preset scaled to `T` ticks per simulated second. Every
 * tick-based field is `seconds * T`, so the same balance in seconds holds at
 * any tick rate; coolPerTick is a per-tick rate so it divides by T.
 */
function buildDefault(T: number): Balance {
  return {
    tickRate: T,
    mech: {
      maxHp: 100,
      radius: 1.1,
      accel: 55,
      maxSpeed: 11,
      friction: 5,
      hoverAccel: 58,
      hoverMaxSpeed: 16, // glides noticeably faster than the walker's 11
      hoverFriction: 2.6, // low drag → drifting/gliding feel
      respawnTicks: 4 * T,
      spawnProtectionTicks: 2 * T,
    },
    gatling: {
      damage: 3,
      intervalTicks: Math.round(0.1 * T), // 10 shots/s → 30 dps
      spread: 0.04,
      projectileSpeed: 70,
      projectileTtlTicks: 1 * T,
      heatPerShot: 5.5, // ~18 shots ≈ 1.8 s sustained before overheat
      coolPerTick: 45 / T,
      overheatAt: 100,
      overheatLockTicks: 2 * T,
    },
    laser: {
      damage: 4, // sole hover weapon (no rockets) → slightly above gatling's 3
      intervalTicks: Math.round((1 / 7.5) * T), // 7.5 shots/s → 30 dps, same ballpark as the gatling
      spread: 0, // pinpoint energy bolt
      projectileSpeed: 120, // beam-fast
      projectileTtlTicks: Math.round(0.5 * T),
      heatPerShot: 6.5, // overheats on a similar timescale to the gatling
    },
    rocket: {
      damage: 45,
      splashRadius: 4,
      splashMinFactor: 0.25,
      projectileSpeed: 26,
      projectileTtlTicks: 4 * T,
      cooldownTicks: Math.round(1.5 * T),
      magazine: 3,
      reloadTicks: 3 * T,
    },
    economy: {
      startingCredits: 100,
      passivePerSecond: 1,
      perTurretPerSecond: 1,
    },
    units: {
      hovertank: {
        cost: 50,
        buildTicks: 5 * T,
        speed: 5.5,
        hp: 80,
        radius: 0.9,
        damage: 6,
        splashRadius: 0,
        range: 11,
        fireIntervalTicks: Math.round(0.8 * T),
        projectileSpeed: 45,
      },
      dreadnought: {
        cost: 400,
        buildTicks: 15 * T,
        speed: 2.6,
        hp: 400,
        radius: 1.6,
        damage: 28,
        splashRadius: 3.5,
        range: 13,
        fireIntervalTicks: Math.round(1.6 * T),
        projectileSpeed: 30,
      },
    },
    unitCap: 8,
    queueMax: 3,
    turret: {
      hp: 300,
      captureTicks: 3 * T,
      respawnTicks: 30 * T,
      range: 17,
      damage: 8,
      fireIntervalTicks: Math.round(0.6 * T),
      projectileSpeed: 55,
      radius: 1.3,
      padRadius: 3.5,
    },
  };
}

/**
 * Accelerated preset for tests: cheap, near-instant builds, very fast units,
 * fast captures and respawns, rich economy. Activated per room (client uses
 * ?test=1) or via the BALANCE_PRESET env var on the server.
 */
function buildTest(T: number): Balance {
  const base = buildDefault(T);
  return {
    ...base,
    mech: {
      ...base.mech,
      respawnTicks: 1 * T,
      spawnProtectionTicks: 1 * T,
    },
    economy: {
      startingCredits: 500,
      passivePerSecond: 10,
      perTurretPerSecond: 10,
    },
    units: {
      hovertank: {
        ...base.units.hovertank,
        buildTicks: Math.round(0.5 * T),
        speed: 22,
      },
      dreadnought: {
        ...base.units.dreadnought,
        // Cheaper than the live game's 400 so accelerated tests can queue a few
        // up front without inflating starting credits (which would overload the
        // winner's client in the full-match e2e).
        cost: 200,
        buildTicks: Math.round(1.5 * T),
        speed: 12,
      },
    },
    turret: {
      ...base.turret,
      captureTicks: 1 * T,
      respawnTicks: 5 * T,
    },
  };
}

/** Build a preset's balance scaled to `tickRate` ticks per simulated second. */
export function makeBalance(name: BalancePresetName, tickRate: number = SIM_TICK_RATE): Balance {
  return name === 'test' ? buildTest(tickRate) : buildDefault(tickRate);
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

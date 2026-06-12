/**
 * Every tunable gameplay number lives here. Durations are expressed in
 * simulation ticks; the simulation always runs at SIM_TICK_RATE ticks per
 * simulated second. The server's TICK_MS env var changes wall-clock pacing
 * only — it never changes simulation semantics.
 */

export const SIM_TICK_RATE = 30;
export const DEFAULT_TICK_MS = 1000 / SIM_TICK_RATE;
/** Snapshots are broadcast every Nth tick (2 → 15 Hz). */
export const SNAPSHOT_EVERY_TICKS = 2;

const T = SIM_TICK_RATE; // ticks per simulated second

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
  mech: {
    maxHp: number;
    radius: number;
    /** units per second^2 */
    accel: number;
    /** units per second */
    maxSpeed: number;
    /** exponential friction factor per second */
    friction: number;
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

export const DEFAULT_BALANCE: Balance = {
  mech: {
    maxHp: 100,
    radius: 1.1,
    accel: 55,
    maxSpeed: 11,
    friction: 5,
    respawnTicks: 4 * T,
    spawnProtectionTicks: 2 * T,
  },
  gatling: {
    damage: 3,
    intervalTicks: 3, // 10 shots/s → 30 dps
    spread: 0.04,
    projectileSpeed: 70,
    projectileTtlTicks: 1 * T,
    heatPerShot: 5.5, // ~18 shots ≈ 1.8 s sustained before overheat
    coolPerTick: 45 / T,
    overheatAt: 100,
    overheatLockTicks: 2 * T,
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
      cost: 200,
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

/**
 * Accelerated preset for tests: cheap, near-instant builds, very fast units,
 * fast captures and respawns, rich economy. Activated per room (client uses
 * ?test=1) or via the BALANCE_PRESET env var on the server.
 */
export const TEST_BALANCE: Balance = {
  ...DEFAULT_BALANCE,
  mech: {
    ...DEFAULT_BALANCE.mech,
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
      ...DEFAULT_BALANCE.units.hovertank,
      buildTicks: Math.round(0.5 * T),
      speed: 22,
    },
    dreadnought: {
      ...DEFAULT_BALANCE.units.dreadnought,
      buildTicks: Math.round(1.5 * T),
      speed: 12,
    },
  },
  turret: {
    ...DEFAULT_BALANCE.turret,
    captureTicks: 1 * T,
    respawnTicks: 5 * T,
  },
};

export const BALANCE_PRESETS: Record<BalancePresetName, Balance> = {
  default: DEFAULT_BALANCE,
  test: TEST_BALANCE,
};

export function getBalance(name: BalancePresetName): Balance {
  return BALANCE_PRESETS[name];
}

export function isBalancePresetName(v: unknown): v is BalancePresetName {
  return v === 'default' || v === 'test';
}

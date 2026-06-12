import { clampLen, fromAngle } from '../math.js';
import { SIM_TICK_RATE } from '../balance.js';
import type { Balance } from '../balance.js';
import { GAME_MAP } from '../map.js';
import type { PRNG } from '../prng.js';
import { collideWithStatics } from './collision.js';
import { NULL_INPUT } from './state.js';
import type { MechState, PlayerInput, ProjectileState, SimEvent, SimState } from './state.js';

const DT = 1 / SIM_TICK_RATE;

export function stepMechs(
  state: SimState,
  balance: Balance,
  inputs: readonly (PlayerInput | null)[],
  rng: PRNG,
  events: SimEvent[]
): void {
  for (const mech of state.mechs) {
    if (!mech.alive) {
      if (state.tick >= mech.respawnAtTick) respawn(mech, state, balance, events);
      continue;
    }
    const input = inputs[mech.player] ?? NULL_INPUT;
    move(mech, input, state, balance);
    aim(mech, input);
    weapons(mech, input, state, balance, rng);
  }
}

function respawn(mech: MechState, state: SimState, balance: Balance, events: SimEvent[]): void {
  const spawn = GAME_MAP.bases[mech.player].mechSpawn;
  mech.pos = { ...spawn };
  mech.vel = { x: 0, z: 0 };
  mech.hp = balance.mech.maxHp;
  mech.alive = true;
  mech.protectedUntilTick = state.tick + balance.mech.spawnProtectionTicks;
  mech.heat = 0;
  mech.overheatedUntilTick = 0;
  mech.rocketAmmo = balance.rocket.magazine;
  mech.rocketReadyAtTick = 0;
  mech.reloadEndTick = 0;
  events.push({ type: 'mechRespawned', player: mech.player });
}

function move(mech: MechState, input: PlayerInput, state: SimState, balance: Balance): void {
  const b = balance.mech;
  const dir = clampLen({ x: numberOr0(input.mx), z: numberOr0(input.mz) }, 1);
  mech.vel.x += dir.x * b.accel * DT;
  mech.vel.z += dir.z * b.accel * DT;
  const drag = Math.max(0, 1 - b.friction * DT);
  mech.vel.x *= drag;
  mech.vel.z *= drag;
  mech.vel = clampLen(mech.vel, b.maxSpeed);
  mech.pos.x += mech.vel.x * DT;
  mech.pos.z += mech.vel.z * DT;
  collideWithStatics(mech.pos, b.radius, state, balance);
}

function aim(mech: MechState, input: PlayerInput): void {
  const dx = numberOr0(input.aimX) - mech.pos.x;
  const dz = numberOr0(input.aimZ) - mech.pos.z;
  if (dx * dx + dz * dz > 0.04) {
    mech.yaw = Math.atan2(dz, dx);
  }
}

function weapons(
  mech: MechState,
  input: PlayerInput,
  state: SimState,
  balance: Balance,
  rng: PRNG
): void {
  const tick = state.tick;

  // --- Gatling (primary) ---
  const g = balance.gatling;
  let firedGatling = false;
  if (input.fire && tick >= mech.gatlingReadyAtTick && tick >= mech.overheatedUntilTick) {
    const yaw = mech.yaw + rng.range(-g.spread, g.spread);
    spawnProjectile(state, {
      owner: mech.player,
      kind: 'gatling',
      yaw,
      origin: mech,
      speed: g.projectileSpeed,
      damage: g.damage,
      splashRadius: 0,
      ttlTicks: g.projectileTtlTicks,
      muzzleOffset: balance.mech.radius + 0.4,
    });
    mech.gatlingReadyAtTick = tick + g.intervalTicks;
    mech.heat += g.heatPerShot;
    firedGatling = true;
    if (mech.heat >= g.overheatAt) {
      mech.heat = g.overheatAt;
      mech.overheatedUntilTick = tick + g.overheatLockTicks;
    }
  }
  if (!firedGatling) {
    mech.heat = Math.max(0, mech.heat - g.coolPerTick);
  }

  // --- Rockets (secondary) ---
  const r = balance.rocket;
  if (mech.reloadEndTick > 0 && tick >= mech.reloadEndTick) {
    mech.rocketAmmo = r.magazine;
    mech.reloadEndTick = 0;
  }
  if (input.alt && mech.rocketAmmo > 0 && mech.reloadEndTick === 0 && tick >= mech.rocketReadyAtTick) {
    const dx = numberOr0(input.aimX) - mech.pos.x;
    const dz = numberOr0(input.aimZ) - mech.pos.z;
    const aimDist = Math.hypot(dx, dz);
    // Rockets detonate when they reach the aimed ground point (or on impact).
    const flightTicks = Math.max(
      2,
      Math.min(r.projectileTtlTicks, Math.ceil((aimDist / r.projectileSpeed) * SIM_TICK_RATE))
    );
    spawnProjectile(state, {
      owner: mech.player,
      kind: 'rocket',
      yaw: mech.yaw,
      origin: mech,
      speed: r.projectileSpeed,
      damage: r.damage,
      splashRadius: r.splashRadius,
      ttlTicks: flightTicks,
      muzzleOffset: balance.mech.radius + 0.5,
    });
    mech.rocketAmmo -= 1;
    mech.rocketReadyAtTick = tick + r.cooldownTicks;
    if (mech.rocketAmmo === 0) {
      mech.reloadEndTick = tick + r.reloadTicks;
    }
  }
}

interface SpawnSpec {
  owner: 0 | 1;
  kind: ProjectileState['kind'];
  yaw: number;
  origin: { pos: { x: number; z: number } };
  speed: number;
  damage: number;
  splashRadius: number;
  ttlTicks: number;
  muzzleOffset: number;
}

export function spawnProjectile(state: SimState, spec: SpawnSpec): ProjectileState {
  const dir = fromAngle(spec.yaw);
  const proj: ProjectileState = {
    id: state.nextEntityId++,
    owner: spec.owner,
    kind: spec.kind,
    pos: {
      x: spec.origin.pos.x + dir.x * spec.muzzleOffset,
      z: spec.origin.pos.z + dir.z * spec.muzzleOffset,
    },
    vel: { x: dir.x * spec.speed, z: dir.z * spec.speed },
    damage: spec.damage,
    splashRadius: spec.splashRadius,
    diesAtTick: state.tick + spec.ttlTicks,
  };
  state.projectiles.push(proj);
  return proj;
}

function numberOr0(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

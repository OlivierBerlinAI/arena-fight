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
    mech.mode = input.mode === 'hover' ? 'hover' : 'walker';
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
  // mode is intentionally NOT reset here: it is authoritative from input every
  // living tick (see stepMechs) and the client holds the toggle, so a player
  // who chose hover keeps hovering after respawning rather than silently
  // snapping back for a single tick.
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
  const hover = mech.mode === 'hover';
  const accel = hover ? b.hoverAccel : b.accel;
  const friction = hover ? b.hoverFriction : b.friction;
  const maxSpeed = hover ? b.hoverMaxSpeed : b.maxSpeed;
  const dir = clampLen({ x: numberOr0(input.mx), z: numberOr0(input.mz) }, 1);
  mech.vel.x += dir.x * accel * DT;
  mech.vel.z += dir.z * accel * DT;
  const drag = Math.max(0, 1 - friction * DT);
  mech.vel.x *= drag;
  mech.vel.z *= drag;
  mech.vel = clampLen(mech.vel, maxSpeed);
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
  const hover = mech.mode === 'hover';

  // --- Primary: gatling (walker) or laser (hover) ---
  // Both feed the same heat meter so the overheat behaviour is mode-agnostic.
  const g = balance.gatling;
  const primary = hover
    ? {
        kind: 'laser' as const,
        damage: balance.laser.damage,
        interval: balance.laser.intervalTicks,
        spread: balance.laser.spread,
        speed: balance.laser.projectileSpeed,
        ttl: balance.laser.projectileTtlTicks,
        heatPerShot: balance.laser.heatPerShot,
      }
    : {
        kind: 'gatling' as const,
        damage: g.damage,
        interval: g.intervalTicks,
        spread: g.spread,
        speed: g.projectileSpeed,
        ttl: g.projectileTtlTicks,
        heatPerShot: g.heatPerShot,
      };
  let firedPrimary = false;
  if (input.fire && tick >= mech.gatlingReadyAtTick && tick >= mech.overheatedUntilTick) {
    const yaw = primary.spread > 0 ? mech.yaw + rng.range(-primary.spread, primary.spread) : mech.yaw;
    spawnProjectile(state, {
      owner: mech.player,
      kind: primary.kind,
      yaw,
      origin: mech,
      speed: primary.speed,
      damage: primary.damage,
      splashRadius: 0,
      ttlTicks: primary.ttl,
      muzzleOffset: balance.mech.radius + 0.4,
    });
    mech.gatlingReadyAtTick = tick + primary.interval;
    mech.heat += primary.heatPerShot;
    firedPrimary = true;
    if (mech.heat >= g.overheatAt) {
      mech.heat = g.overheatAt;
      mech.overheatedUntilTick = tick + g.overheatLockTicks;
    }
  }
  if (!firedPrimary) {
    mech.heat = Math.max(0, mech.heat - g.coolPerTick);
  }

  // --- Rockets (secondary, walker only) ---
  // Ammo still reloads in hover so the magazine is full again on landing.
  const r = balance.rocket;
  if (mech.reloadEndTick > 0 && tick >= mech.reloadEndTick) {
    mech.rocketAmmo = r.magazine;
    mech.reloadEndTick = 0;
  }
  if (!hover && input.alt && mech.rocketAmmo > 0 && mech.reloadEndTick === 0 && tick >= mech.rocketReadyAtTick) {
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

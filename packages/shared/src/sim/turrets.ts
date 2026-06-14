import { distSq } from '../math.js';
import type { Balance } from '../balance.js';
import { spawnProjectile } from './mech.js';
import type { SimEvent, SimState, TurretState, PlayerIndex } from './state.js';

/**
 * Neutral turret towers: mech-only capture via the pad at their foot, then
 * they shoot enemies and pay +1 credit/s. Capturing an enemy-owned turret
 * drains it to neutral first, then flips it. Destroyed turrets respawn
 * neutral after a delay.
 */
export function stepTurrets(state: SimState, balance: Balance, events: SimEvent[]): void {
  for (const turret of state.turrets) {
    if (!turret.alive) {
      if (state.tick >= turret.respawnAtTick) {
        turret.alive = true;
        turret.owner = -1;
        turret.hp = balance.turret.hp;
        turret.capOwner = -1;
        turret.capProgress = 0;
        turret.fireReadyAtTick = 0;
        events.push({ type: 'turretRespawned', turretId: turret.id });
      }
      continue;
    }
    stepCapture(turret, state, balance, events);
    stepFire(turret, state, balance);
  }
}

function stepCapture(
  turret: TurretState,
  state: SimState,
  balance: Balance,
  events: SimEvent[]
): void {
  const padR2 = balance.turret.padRadius * balance.turret.padRadius;
  const onPad: PlayerIndex[] = [];
  for (const mech of state.mechs) {
    if (mech.alive && distSq(mech.pos, turret.pos) <= padR2) onPad.push(mech.player);
  }

  if (onPad.length > 1) {
    // Both mechs contest the pad: capture progress pauses.
    return;
  }
  if (onPad.length === 0) {
    // Empty pad: progress relaxes back toward its resting state
    // (full for an owned turret, zero for a neutral one) at double speed.
    if (turret.owner !== -1) {
      turret.capOwner = turret.owner;
      turret.capProgress = Math.min(balance.turret.captureTicks, turret.capProgress + 2);
    } else if (turret.capProgress > 0) {
      turret.capProgress = Math.max(0, turret.capProgress - 2);
      if (turret.capProgress === 0) turret.capOwner = -1;
    }
    return;
  }

  const p = onPad[0];
  if (turret.owner === p) {
    turret.capOwner = p;
    turret.capProgress = Math.min(balance.turret.captureTicks, turret.capProgress + 2);
    return;
  }

  if (turret.owner !== -1) {
    // Enemy stands on an owned turret: drain the owner's hold toward neutral.
    turret.capOwner = turret.owner;
    turret.capProgress -= 1;
    if (turret.capProgress <= 0) {
      const previousOwner = turret.owner as PlayerIndex;
      turret.owner = -1;
      turret.capOwner = p;
      turret.capProgress = 0;
      events.push({ type: 'turretNeutralized', turretId: turret.id, byPlayer: p });
      void previousOwner;
    }
    return;
  }

  // Neutral turret.
  if (turret.capOwner !== p && turret.capProgress > 0) {
    // Someone else's partial progress drains first.
    turret.capProgress -= 1;
    if (turret.capProgress <= 0) {
      turret.capOwner = p;
      turret.capProgress = 0;
    }
    return;
  }
  turret.capOwner = p;
  turret.capProgress += 1;
  if (turret.capProgress >= balance.turret.captureTicks) {
    turret.owner = p;
    turret.capProgress = balance.turret.captureTicks;
    state.players[p].stats.turretCaptures += 1;
    events.push({ type: 'turretCaptured', turretId: turret.id, player: p });
  }
}

function stepFire(turret: TurretState, state: SimState, balance: Balance): void {
  if (turret.owner === -1) {
    turret.headYaw += 0.01; // idle scan, cosmetic
    return;
  }
  const tb = balance.turret;
  const enemy = (1 - turret.owner) as PlayerIndex;
  const r2 = tb.range * tb.range;

  let targetPos: { x: number; z: number } | null = null;
  let bestD = Infinity;
  for (const u of state.units) {
    if (u.owner !== enemy) continue;
    const d = distSq(turret.pos, u.pos);
    if (d <= r2 && d < bestD) {
      bestD = d;
      targetPos = u.pos;
    }
  }
  const mech = state.mechs[enemy];
  if (mech.alive && state.tick >= mech.protectedUntilTick) {
    const d = distSq(turret.pos, mech.pos);
    if (d <= r2 && d < bestD) {
      bestD = d;
      targetPos = mech.pos;
    }
  }
  if (!targetPos) return;

  turret.headYaw = Math.atan2(targetPos.z - turret.pos.z, targetPos.x - turret.pos.x);
  if (state.tick >= turret.fireReadyAtTick) {
    spawnProjectile(state, {
      owner: turret.owner,
      kind: 'turret',
      yaw: turret.headYaw,
      origin: turret,
      speed: tb.projectileSpeed,
      damage: tb.damage,
      splashRadius: 0,
      ttlTicks: Math.max(2, Math.ceil((tb.range / tb.projectileSpeed) * balance.tickRate) + 2),
      muzzleOffset: tb.radius + 0.4,
    });
    turret.fireReadyAtTick = state.tick + tb.fireIntervalTicks;
  }
}

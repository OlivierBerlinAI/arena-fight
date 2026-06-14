/**
 * Dynamic entities: the two mechs, robots, projectiles, HP bars and cheap
 * particle effects. Everything is built from three.js primitives — no assets.
 */
import * as THREE from 'three';
import { GAME_MAP } from '@mech-arena-fight/shared';
import type {
  Balance,
  MechSnap,
  PlayerIndex,
  ProjectileSnap,
  SimEvent,
  Snapshot,
  UnitSnap,
  UnitType,
} from '@mech-arena-fight/shared';
import type { ViewState } from './interpolation';
import { TEAM_HEX, teamHex } from './colors';
import { HpBar } from './hpbar';

// ---------------------------------------------------------------------------
// Particles: one pooled THREE.Points system with additive blending
// ---------------------------------------------------------------------------

const MAX_PARTICLES = 700;

class ParticleSystem {
  readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseColor: Float32Array;
  private cursor = 0;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.PointsMaterial;

  constructor() {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.vel = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.maxLife = new Float32Array(MAX_PARTICLES);
    this.baseColor = new Float32Array(MAX_PARTICLES * 3);
    this.positions.fill(0);
    for (let i = 0; i < MAX_PARTICLES; i++) this.positions[i * 3 + 1] = -1000;

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.mat = new THREE.PointsMaterial({
      size: 0.45,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  burst(x: number, y: number, z: number, count: number, colorHex: number, speed: number, lifeSec: number): void {
    const c = new THREE.Color(colorHex);
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const a = Math.random() * Math.PI * 2;
      const elev = Math.random() * Math.PI - Math.PI / 2;
      const sp = speed * (0.35 + Math.random() * 0.8);
      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
      this.vel[i * 3] = Math.cos(a) * Math.cos(elev) * sp;
      this.vel[i * 3 + 1] = Math.abs(Math.sin(elev)) * sp * 0.9 + speed * 0.15;
      this.vel[i * 3 + 2] = Math.sin(a) * Math.cos(elev) * sp;
      this.life[i] = lifeSec * (0.6 + Math.random() * 0.6);
      this.maxLife[i] = this.life[i];
      this.baseColor[i * 3] = c.r;
      this.baseColor[i * 3 + 1] = c.g;
      this.baseColor[i * 3 + 2] = c.b;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.positions[i * 3 + 1] = -1000;
        this.colors[i * 3] = 0;
        this.colors[i * 3 + 1] = 0;
        this.colors[i * 3 + 2] = 0;
        continue;
      }
      this.positions[i * 3] += this.vel[i * 3] * dt;
      this.positions[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 9.5 * dt; // gravity
      if (this.positions[i * 3 + 1] < 0.05) {
        this.positions[i * 3 + 1] = 0.05;
        this.vel[i * 3 + 1] *= -0.3;
      }
      const f = this.life[i] / this.maxLife[i];
      this.colors[i * 3] = this.baseColor[i * 3] * f;
      this.colors[i * 3 + 1] = this.baseColor[i * 3 + 1] * f;
      this.colors[i * 3 + 2] = this.baseColor[i * 3 + 2] * f;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// Mesh factories
// ---------------------------------------------------------------------------

function std(color: number, opts: { emissive?: number; ei?: number; rough?: number } = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.ei ?? 0,
    roughness: opts.rough ?? 0.6,
    metalness: 0.35,
  });
}

/** leg-swing phase gained per world-unit travelled */
const STRIDE_RATE = 0.9;
/** peak fore/aft leg swing (radians) at full walking speed */
const SWING_AMP = 0.55;
/** how much turning (rad/s) counts toward the walk gait, so the legs also step
 *  while the walker rotates in place */
const TURN_GAIT = 3.0;

interface MechView {
  group: THREE.Group;
  hull: THREE.Group;
  legs: [THREE.Group, THREE.Group];
  hoverGlow: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  shield: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  hpBar: HpBar;
  bobPhase: number;
  /** accumulated leg-swing phase (advances with ground speed) */
  stridePhase: number;
  /** 0 = walker, 1 = hover; lerps for a smooth transform */
  hoverBlend: number;
  /** previous rendered yaw, for deriving the visual turn rate */
  prevYaw: number;
  /** false until prevYaw has been seeded (also reset on death) */
  poseInit: boolean;
}

/** Low-poly mech: two animated legs, torso, twin gun arms, team accents. */
function buildMech(owner: PlayerIndex): MechView {
  const team = TEAM_HEX[owner];
  const group = new THREE.Group();
  const hull = new THREE.Group();
  group.add(hull);

  const body = std(0x2b3445, { rough: 0.55 });
  const accent = std(0x1a2230, { emissive: team, ei: 1.0 });
  const dark = std(0x1a212e);

  // legs (reverse-jointed) — each in a hip-pivot group so it can swing/retract
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(0, 0.95, side * 0.6); // hip pivot
    const hip = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.7, 6), dark);
    hip.position.set(-0.15, -0.1, side * -0.05);
    hip.rotation.x = side * 0.18;
    leg.add(hip);
    const shin = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 0.3), body);
    shin.position.set(0.05, -0.53, side * 0.08);
    leg.add(shin);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.18, 0.45), dark);
    foot.position.set(0.1, -0.83, side * 0.08);
    leg.add(foot);
    hull.add(leg);
    legs.push(leg);
  }

  // torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.85, 1.1), body);
  torso.position.y = 1.55;
  hull.add(torso);
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.66), accent);
  cockpit.position.set(0.55, 1.85, 0);
  hull.add(cockpit);
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.8), dark);
  spine.position.set(-0.6, 1.8, 0);
  hull.add(spine);

  // twin gun arms
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.4), dark);
    shoulder.position.set(0, 1.62, side * 0.78);
    hull.add(shoulder);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.3, 0.3), body);
    gun.position.set(0.55, 1.58, side * 0.82);
    hull.add(gun);
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 6), accent);
    muzzle.rotation.z = Math.PI / 2;
    muzzle.position.set(1.3, 1.58, side * 0.82);
    hull.add(muzzle);
  }

  // team glow strip
  const strip = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.12), accent);
  strip.position.set(0, 1.16, 0);
  hull.add(strip);

  // hover thruster wash on the ground (only visible while hovering)
  const hoverGlow = new THREE.Mesh(
    new THREE.CircleGeometry(1.7, 24),
    new THREE.MeshBasicMaterial({
      color: team,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  hoverGlow.rotation.x = -Math.PI / 2;
  hoverGlow.visible = false;
  group.add(hoverGlow);

  // spawn-protection shield
  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(1.9, 18, 12),
    new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.16, depthWrite: false })
  );
  shield.position.y = 1.4;
  group.add(shield);

  const hpBar = new HpBar(2.2);
  hpBar.group.position.y = 3.2;
  group.add(hpBar.group);

  return {
    group,
    hull,
    legs: [legs[0], legs[1]],
    hoverGlow,
    shield,
    hpBar,
    bobPhase: owner * 1.7,
    stridePhase: 0,
    hoverBlend: 0,
    prevYaw: 0,
    poseInit: false,
  };
}

interface UnitView {
  group: THREE.Group;
  hpBar: HpBar;
  type: UnitType;
  maxHp: number;
}

/** Hovertank: a flat wedge. Dreadnought: a bulky multi-part hull. */
function buildUnit(owner: PlayerIndex, type: UnitType, maxHp: number): UnitView {
  const team = TEAM_HEX[owner];
  const group = new THREE.Group();
  const body = std(0x2b3445, { rough: 0.55 });
  const accent = std(0x141b27, { emissive: team, ei: 1.1 });
  const dark = std(0x1a212e);

  if (type === 'hovertank') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.34, 1.25), body);
    base.position.y = 0.42;
    group.add(base);
    // sloped nose plate
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.26, 1.0), dark);
    nose.position.set(0.95, 0.5, 0);
    nose.rotation.z = -0.45;
    group.add(nose);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.12), accent);
    fin.position.set(-0.7, 0.68, 0);
    group.add(fin);
    const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 6), accent);
    gun.rotation.z = Math.PI / 2;
    gun.position.set(0.8, 0.62, 0);
    group.add(gun);
    const hpBar = new HpBar(1.5, 0.14);
    hpBar.group.position.y = 1.5;
    group.add(hpBar.group);
    return { group, hpBar, type, maxHp };
  }

  // dreadnought
  const lower = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.8, 2.3), body);
  lower.position.y = 0.65;
  group.add(lower);
  const upper = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.7, 1.6), dark);
  upper.position.set(-0.2, 1.4, 0);
  group.add(upper);
  const turret = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.55, 0.9), body);
  turret.position.set(0.5, 1.95, 0);
  group.add(turret);
  const cannon = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 2.0, 8), dark);
  cannon.rotation.z = Math.PI / 2;
  cannon.position.set(1.6, 1.95, 0);
  group.add(cannon);
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.45), accent);
    pod.position.set(-0.3, 1.0, side * 1.35);
    group.add(pod);
  }
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), accent);
  beacon.position.set(-1.1, 1.85, 0);
  group.add(beacon);

  const hpBar = new HpBar(2.4, 0.16);
  hpBar.group.position.y = 2.9;
  group.add(hpBar.group);
  return { group, hpBar, type, maxHp };
}

const PROJECTILE_STYLE: Record<ProjectileSnap['kind'], { radius: number; y: number }> = {
  gatling: { radius: 0.11, y: 1.55 },
  laser: { radius: 0.13, y: 1.55 },
  rocket: { radius: 0.3, y: 1.4 },
  unitLight: { radius: 0.14, y: 0.7 },
  unitHeavy: { radius: 0.26, y: 1.6 },
  turret: { radius: 0.17, y: 3.0 },
};

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const mat = obj.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// EntityManager
// ---------------------------------------------------------------------------

export class EntityManager {
  private readonly mechs: [MechView, MechView];
  private readonly units = new Map<number, UnitView>();
  private readonly projectiles = new Map<number, THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>>();
  private readonly particles = new ParticleSystem();
  private prevSnap: Snapshot | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly balance: Balance
  ) {
    this.mechs = [buildMech(0), buildMech(1)];
    scene.add(this.mechs[0].group, this.mechs[1].group);
    scene.add(this.particles.points);
  }

  // ------------------------------------------------ per-frame view updates

  syncView(view: ViewState, timeSec: number, dt: number): void {
    this.syncMechs(view.mechs, timeSec, dt);
    this.syncUnits(view.units);
    this.syncProjectiles(view.projectiles, dt);
    this.particles.update(dt);
  }

  private syncMechs(mechs: MechSnap[], timeSec: number, dt: number): void {
    const walkerMax = this.balance.mech.maxSpeed;
    for (const m of mechs) {
      const view = this.mechs[m.player];
      view.group.visible = m.alive;
      if (!m.alive) {
        // Keep the pose state in sync while hidden so the mech reappears in the
        // correct mode (no one-frame hover-pose pop when respawning).
        view.hoverBlend = m.mode === 'hover' ? 1 : 0;
        view.stridePhase = 0;
        view.poseInit = false;
        continue;
      }

      const speed = Math.hypot(m.vx, m.vz);

      // Visual turn rate (rad/s) from the change in rendered yaw.
      if (!view.poseInit) {
        view.prevYaw = m.yaw;
        view.poseInit = true;
      }
      let yawDelta = m.yaw - view.prevYaw;
      yawDelta = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta));
      view.prevYaw = m.yaw;
      const yawRate = dt > 1e-4 ? Math.abs(yawDelta) / dt : 0;

      // Gait drives the walk cycle from BOTH moving and turning in place.
      const gait = speed + yawRate * TURN_GAIT;
      const gaitFrac = Math.min(1, gait / walkerMax);

      // Smoothly blend between walker (0) and hover (1) for the transform.
      const target = m.mode === 'hover' ? 1 : 0;
      view.hoverBlend += (target - view.hoverBlend) * Math.min(1, dt * 8);
      const hb = view.hoverBlend;

      // Walk cycle: advance the stride by the gait; legs swing in antiphase.
      view.stridePhase = (view.stridePhase + gait * dt * STRIDE_RATE) % (Math.PI * 2);
      const swing = Math.sin(view.stridePhase) * SWING_AMP * gaitFrac;
      for (let i = 0; i < 2; i++) {
        const walkZ = i === 0 ? swing : -swing;
        const hoverZ = -1.5; // legs fold fully back, tucked together, while hovering
        view.legs[i].rotation.z = walkZ * (1 - hb) + hoverZ * hb;
        view.legs[i].rotation.x = 0;
      }

      // Body height: grounded step-bob (walker) ↔ hover hugs the ground LOWER.
      const idleBob = Math.sin(timeSec * 3.1 + view.bobPhase) * 0.09;
      const stepBob = Math.abs(Math.sin(view.stridePhase)) * 0.06 * gaitFrac;
      const walkerY = 0.25 + stepBob + idleBob * 0.4;
      const hoverY = -0.15 + idleBob * 0.5;
      const groupY = walkerY * (1 - hb) + hoverY * hb;
      view.group.position.set(m.x, groupY, m.z);
      view.group.rotation.y = -m.yaw;

      // Lean with velocity (computed in mech-local space).
      const fx = Math.cos(m.yaw);
      const fz = Math.sin(m.yaw);
      const fwd = m.vx * fx + m.vz * fz;
      const side = m.vx * -fz + m.vz * fx;
      view.hull.rotation.z = -fwd * 0.012;
      view.hull.rotation.x = -side * 0.012;

      // Hover thruster wash, pinned to the ground beneath the floating mech.
      const glow = view.hoverGlow;
      glow.visible = hb > 0.02;
      if (glow.visible) {
        glow.position.y = 0.07 - groupY;
        glow.material.opacity = hb * (0.3 + 0.12 * Math.sin(timeSec * 9));
      }

      view.shield.visible = m.shielded;
      if (m.shielded) {
        view.shield.material.opacity = 0.1 + 0.08 * Math.sin(timeSec * 8);
      }
      view.hpBar.set(m.hp / this.balance.mech.maxHp);
    }
  }

  private syncUnits(units: UnitSnap[]): void {
    const seen = new Set<number>();
    for (const u of units) {
      seen.add(u.id);
      let view = this.units.get(u.id);
      if (!view) {
        // Defensive: an unknown unit type (newer server) must degrade, not crash.
        const unitBalance = this.balance.units[u.type] ?? this.balance.units.hovertank;
        view = buildUnit(u.owner, u.type, unitBalance.hp);
        this.units.set(u.id, view);
        this.scene.add(view.group);
      }
      const hover = u.type === 'hovertank' ? 0.18 : 0.05;
      view.group.position.set(u.x, hover, u.z);
      view.group.rotation.y = -u.yaw;
      view.hpBar.set(u.hp / view.maxHp);
    }
    for (const [id, view] of this.units) {
      if (!seen.has(id)) {
        this.scene.remove(view.group);
        view.hpBar.dispose();
        disposeObject(view.group);
        this.units.delete(id);
      }
    }
  }

  private syncProjectiles(projs: ProjectileSnap[], dt: number): void {
    const seen = new Set<number>();
    for (const p of projs) {
      seen.add(p.id);
      let mesh = this.projectiles.get(p.id);
      if (!mesh) {
        // Defensive: unknown projectile kinds (newer server) fall back to a tracer.
        const style = PROJECTILE_STYLE[p.kind] ?? PROJECTILE_STYLE.gatling;
        const color =
          p.kind === 'gatling'
            ? 0xfff3c4
            : p.kind === 'laser'
              ? 0x9fe8ff
              : p.kind === 'rocket'
                ? 0xffb454
                : teamHex(p.owner);
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(style.radius, 8, 6),
          new THREE.MeshBasicMaterial({ color })
        );
        mesh.position.set(p.x, style.y, p.z);
        if (p.kind === 'laser') {
          // stretch the bolt into a streak aligned with its travel direction
          mesh.scale.set(5, 1, 1);
          mesh.rotation.y = -Math.atan2(p.vz, p.vx);
        }
        this.projectiles.set(p.id, mesh);
        this.scene.add(mesh);
        if (p.kind === 'gatling') {
          // muzzle flash at the projectile's first known position
          this.particles.burst(p.x, style.y, p.z, 2, 0xffe9a8, 2.5, 0.12);
        } else if (p.kind === 'laser') {
          this.particles.burst(p.x, style.y, p.z, 2, 0x9fe8ff, 3, 0.12);
        }
      }
      mesh.position.x = p.x;
      mesh.position.z = p.z;
      if (p.kind === 'rocket' && Math.random() < dt * 90) {
        // simple smoke/flame trail
        this.particles.burst(p.x, PROJECTILE_STYLE.rocket.y, p.z, 1, 0xff8c3a, 0.8, 0.35);
      } else if (p.kind === 'laser' && Math.random() < dt * 45) {
        this.particles.burst(p.x, PROJECTILE_STYLE.laser.y, p.z, 1, 0x9fe8ff, 0.6, 0.16);
      }
    }
    for (const [id, mesh] of this.projectiles) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        this.projectiles.delete(id);
      }
    }
  }

  // ------------------------------------------------ snapshot-edge effects

  /** Called once per arriving snapshot (raw, uninterpolated) for effects. */
  onRawSnapshot(snap: Snapshot, events: SimEvent[]): void {
    const prev = this.prevSnap;
    if (prev) {
      // detonations: projectiles that existed before and are now gone
      const liveIds = new Set(snap.projectiles.map((p) => p.id));
      for (const p of prev.projectiles) {
        if (liveIds.has(p.id)) continue;
        if (p.kind === 'rocket') {
          this.particles.burst(p.x, 1.0, p.z, 26, 0xffa040, 9, 0.6);
          this.particles.burst(p.x, 1.0, p.z, 10, 0xfff0c0, 5, 0.35);
        } else if (p.kind === 'unitHeavy') {
          this.particles.burst(p.x, 1.0, p.z, 14, 0xffa860, 6, 0.45);
        } else if (p.kind === 'gatling') {
          this.particles.burst(p.x, 1.2, p.z, 1, 0xffe9a8, 2, 0.15);
        } else if (p.kind === 'laser') {
          this.particles.burst(p.x, 1.4, p.z, 3, 0x9fe8ff, 3.2, 0.14);
        } else {
          this.particles.burst(p.x, 0.9, p.z, 2, teamHex(p.owner), 2.5, 0.2);
        }
      }
    }

    for (const ev of events) {
      switch (ev.type) {
        case 'unitDestroyed': {
          const u = prev?.units.find((x) => x.id === ev.unitId) ?? snap.units.find((x) => x.id === ev.unitId);
          if (u) {
            const big = u.type === 'dreadnought';
            this.particles.burst(u.x, 1.0, u.z, big ? 40 : 22, 0xff9038, big ? 11 : 8, big ? 0.9 : 0.6);
            this.particles.burst(u.x, 1.2, u.z, 10, teamHex(u.owner), 5, 0.5);
          }
          break;
        }
        case 'mechKilled': {
          const m = (prev ?? snap).mechs.find((x) => x.player === ev.victim);
          if (m) {
            this.particles.burst(m.x, 1.4, m.z, 46, 0xffb050, 12, 1.0);
            this.particles.burst(m.x, 1.4, m.z, 16, teamHex(ev.victim), 7, 0.7);
          }
          break;
        }
        case 'turretDestroyed': {
          const pos = GAME_MAP.turrets[ev.turretId];
          if (pos) {
            this.particles.burst(pos.x, 2.2, pos.z, 38, 0xffa040, 10, 0.9);
            this.particles.burst(pos.x, 2.2, pos.z, 12, 0xc7d2e0, 6, 0.7);
          }
          break;
        }
        default:
          break;
      }
    }
    this.prevSnap = snap;
  }

  dispose(): void {
    for (const view of this.mechs) {
      this.scene.remove(view.group);
      view.hpBar.dispose();
      disposeObject(view.group);
    }
    for (const [, view] of this.units) {
      this.scene.remove(view.group);
      view.hpBar.dispose();
      disposeObject(view.group);
    }
    this.units.clear();
    for (const [, mesh] of this.projectiles) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.projectiles.clear();
    this.scene.remove(this.particles.points);
    this.particles.dispose();
  }
}

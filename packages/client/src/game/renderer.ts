/**
 * Three.js scene generated from GAME_MAP: ground + grid, fog, lights, every
 * wall AABB as a box, core pads, lane hints, and the four capturable turret
 * towers (rotating heads, owner-colored emissives, in-world capture rings,
 * rubble while destroyed).
 */
import * as THREE from 'three';
import { GAME_MAP, laneWaypoints } from '@mech-arena-fight/shared';
import type { Balance, Ownership, TurretSnap, Wall } from '@mech-arena-fight/shared';
import { GRID_CENTER_HEX, GRID_HEX, GROUND_HEX, NEUTRAL_HEX, TEAM_HEX, teamHex } from './colors';

const WALL_COLORS: Record<Wall['kind'], number> = {
  boundary: 0x222c3a,
  base: 0x2a3547,
  building: 0x303b50,
  cover: 0x232d3c,
};

interface TurretView {
  group: THREE.Group;
  head: THREE.Group;
  headMat: THREE.MeshStandardMaterial;
  baseMat: THREE.MeshStandardMaterial;
  lampMat: THREE.MeshStandardMaterial;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  ringProgress: number;
  padR: number;
  rubble: THREE.Group;
  tower: THREE.Group;
}

export class GameRenderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;

  private readonly turretViews: TurretView[] = [];
  private corePadRings: THREE.Mesh[] = [];
  private readonly onResizeBound = (): void => this.onResize();
  private readonly turretMaxHp: number;

  constructor(private readonly container: HTMLElement, balance: Balance) {
    this.turretMaxHp = balance.turret.hp;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.canvas = this.renderer.domElement;
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(
      60,
      (container.clientWidth || window.innerWidth) / (container.clientHeight || window.innerHeight),
      0.1,
      400
    );
    this.camera.position.set(0, 40, 60);

    this.scene.background = new THREE.Color(GROUND_HEX);
    this.scene.fog = new THREE.Fog(GROUND_HEX, 90, 240);

    this.buildLights();
    this.buildGround();
    this.buildWalls();
    this.buildBases();
    this.buildLaneHints();
    this.buildTurrets(balance);

    window.addEventListener('resize', this.onResizeBound);
  }

  // ---------------------------------------------------------------- statics

  private buildLights(): void {
    // Spec recipe: one directional light + ambient.
    this.scene.add(new THREE.AmbientLight(0x707e96, 1.0));
    const sun = new THREE.DirectionalLight(0xdfe8ff, 1.45);
    sun.position.set(45, 90, -35);
    this.scene.add(sun);
  }

  private buildGround(): void {
    const size = GAME_MAP.size + 8;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshLambertMaterial({ color: 0x0c1118 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(GAME_MAP.size, GAME_MAP.size / 4, GRID_CENTER_HEX, GRID_HEX);
    grid.position.y = 0.0;
    this.scene.add(grid);
  }

  private buildWalls(): void {
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x3a4a61 });
    for (const wall of GAME_MAP.walls) {
      const sx = wall.maxX - wall.minX;
      const sz = wall.maxZ - wall.minZ;
      const geo = new THREE.BoxGeometry(sx, wall.height, sz);
      let color = WALL_COLORS[wall.kind];
      let emissive = 0x000000;
      let emissiveIntensity = 0;
      if (wall.kind === 'base') {
        // Tint compound walls toward the owning team.
        const owner = wall.minX + wall.maxX < 0 ? 0 : 1;
        emissive = TEAM_HEX[owner];
        emissiveIntensity = 0.08;
      }
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive,
        emissiveIntensity,
        roughness: 0.85,
        metalness: 0.25,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((wall.minX + wall.maxX) / 2, wall.height / 2, (wall.minZ + wall.maxZ) / 2);
      this.scene.add(mesh);

      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      edges.position.copy(mesh.position);
      this.scene.add(edges);

      if (wall.kind === 'building') {
        // Mark factories distinctly: emissive roof strip + antenna mast.
        const owner = wall.minX + wall.maxX < 0 ? 0 : 1;
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(sx * 0.7, 0.25, sz * 0.25),
          new THREE.MeshStandardMaterial({
            color: TEAM_HEX[owner],
            emissive: TEAM_HEX[owner],
            emissiveIntensity: 0.9,
          })
        );
        strip.position.set(mesh.position.x, wall.height + 0.12, mesh.position.z);
        this.scene.add(strip);
        const mast = new THREE.Mesh(
          new THREE.CylinderGeometry(0.1, 0.14, 2.6, 6),
          new THREE.MeshStandardMaterial({ color: 0x4a5870, roughness: 0.6 })
        );
        mast.position.set(mesh.position.x + sx * 0.28, wall.height + 1.3, mesh.position.z - sz * 0.28);
        this.scene.add(mast);
      }
    }
  }

  private buildBases(): void {
    GAME_MAP.bases.forEach((base, player) => {
      const pad = base.corePad;
      const color = TEAM_HEX[player];
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(pad.radius, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22 })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(pad.x, 0.04, pad.z);
      this.scene.add(disc);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(pad.radius - 0.35, pad.radius, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pad.x, 0.06, pad.z);
      this.scene.add(ring);
      this.corePadRings.push(ring);

      // Core pylon in the middle of the pad.
      const pylon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.8, 2.6, 8),
        new THREE.MeshStandardMaterial({
          color: 0x1c2534,
          emissive: color,
          emissiveIntensity: 0.7,
          roughness: 0.4,
        })
      );
      pylon.position.set(pad.x, 1.3, pad.z);
      this.scene.add(pylon);
    });
  }

  private buildLaneHints(): void {
    const mat = new THREE.LineBasicMaterial({ color: GRID_HEX, transparent: true, opacity: 0.6 });
    for (const player of [0, 1] as const) {
      for (const lane of ['left', 'right'] as const) {
        const pts = laneWaypoints(player, lane).map((p) => new THREE.Vector3(p.x, 0.03, p.z));
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        this.scene.add(new THREE.Line(geo, mat));
      }
    }
  }

  private buildTurrets(balance: Balance): void {
    const padR = balance.turret.padRadius;
    GAME_MAP.turrets.forEach((pos) => {
      const group = new THREE.Group();
      group.position.set(pos.x, 0, pos.z);

      const tower = new THREE.Group();
      const baseMat = new THREE.MeshStandardMaterial({ color: 0x39455c, roughness: 0.7, metalness: 0.3 });
      const column = new THREE.Mesh(
        new THREE.CylinderGeometry(balance.turret.radius * 0.7, balance.turret.radius * 1.05, 2.6, 10),
        baseMat
      );
      column.position.y = 1.3;
      tower.add(column);

      // Rotating head: box + barrel, both share the owner-emissive material.
      const headMat = new THREE.MeshStandardMaterial({
        color: 0x222b3a,
        emissive: NEUTRAL_HEX,
        emissiveIntensity: 0.45,
        roughness: 0.5,
        metalness: 0.4,
      });
      const head = new THREE.Group();
      const headBox = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.85, 1.15), headMat);
      head.add(headBox);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.9, 8), headMat);
      barrel.rotation.z = Math.PI / 2;
      barrel.position.set(1.5, 0.08, 0);
      head.add(barrel);
      head.position.y = 3.0;
      tower.add(head);

      // Ownership lamp on top.
      const lampMat = new THREE.MeshStandardMaterial({
        color: 0x10151f,
        emissive: NEUTRAL_HEX,
        emissiveIntensity: 1.0,
      });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), lampMat);
      lamp.position.y = 3.7;
      tower.add(lamp);
      group.add(tower);

      // Capture pad outline on the ground.
      const padOutline = new THREE.Mesh(
        new THREE.RingGeometry(padR - 0.12, padR, 48),
        new THREE.MeshBasicMaterial({ color: 0x33425a, transparent: true, opacity: 0.8 })
      );
      padOutline.rotation.x = -Math.PI / 2;
      padOutline.position.y = 0.05;
      group.add(padOutline);

      // Capture progress arc (geometry rebuilt as progress changes).
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(padR - 0.55, padR - 0.18, 48, 1, -Math.PI / 2, 0.001),
        new THREE.MeshBasicMaterial({ color: NEUTRAL_HEX, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.08;
      ring.visible = false;
      group.add(ring);

      // Rubble shown while the turret is destroyed.
      const rubble = new THREE.Group();
      const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x161c27, roughness: 1 });
      const chunks: [number, number, number, number][] = [
        [0.9, 0.7, 1.1, 0.3],
        [-0.7, 0.45, 0.8, 1.1],
        [0.2, 0.55, 0.9, -0.8],
        [-0.3, 0.35, 0.7, 0.2],
      ];
      for (const [dx, h, s, dz] of chunks) {
        const chunk = new THREE.Mesh(new THREE.BoxGeometry(s, h, s * 0.8), rubbleMat);
        chunk.position.set(dx, h / 2, dz);
        chunk.rotation.y = dx * 2.1 + dz;
        rubble.add(chunk);
      }
      rubble.visible = false;
      group.add(rubble);

      this.scene.add(group);
      this.turretViews.push({ group, head, headMat, baseMat, lampMat, ring, ringProgress: 0, padR, rubble, tower });
    });
  }

  // ---------------------------------------------------------------- updates

  updateTurrets(turrets: TurretSnap[], timeSec: number): void {
    for (const t of turrets) {
      const view = this.turretViews[t.id];
      if (!view) continue;
      view.tower.visible = t.alive;
      view.rubble.visible = !t.alive;
      view.head.rotation.y = -t.headYaw;

      const ownerColor = teamHex(t.owner);
      view.headMat.emissive.setHex(ownerColor);
      view.headMat.emissiveIntensity = t.owner === -1 ? 0.35 : 0.85;
      view.lampMat.emissive.setHex(ownerColor);

      // Damage feedback: the tower darkens as it loses HP (base color 0x39455c).
      const hpFrac = Math.max(0, Math.min(1, t.hp / this.turretMaxHp));
      const dim = 0.35 + 0.65 * hpFrac;
      view.baseMat.color.setHex(0x39455c).multiplyScalar(dim);

      // capture progress arc
      const p = t.capProgress;
      if (t.alive && p > 0.005 && p < 0.995) {
        view.ring.visible = true;
        view.ring.material.color.setHex(teamHex(t.capOwner));
        if (Math.abs(p - view.ringProgress) > 0.01) {
          view.ring.geometry.dispose();
          const padR = view.padR;
          view.ring.geometry = new THREE.RingGeometry(
            padR - 0.55,
            padR - 0.18,
            48,
            1,
            -Math.PI / 2,
            Math.max(0.001, p * Math.PI * 2)
          );
          view.ringProgress = p;
        }
      } else {
        view.ring.visible = false;
        view.ringProgress = 0;
      }
    }
    // gentle pulse on core pad rings
    const pulse = 0.75 + 0.25 * Math.sin(timeSec * 2.4);
    for (const ring of this.corePadRings) {
      const mat = ring.material as THREE.MeshBasicMaterial;
      mat.opacity = pulse;
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private onResize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResizeBound);
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.Points) {
        obj.geometry?.dispose();
        const mat = obj.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      }
      if (obj instanceof THREE.Sprite) {
        obj.material.dispose();
      }
    });
    // dispose() alone does not release the GL context; without forceContextLoss
    // repeated rematches can exhaust the browser's live-context limit.
    this.renderer.forceContextLoss();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

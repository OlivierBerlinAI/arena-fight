/**
 * 2D canvas minimap: walls, base zones + core pads, lane hints, turrets as
 * owner-colored triangles, robots as dots, mechs as larger dots, own view
 * marker. Redrawn every frame from the latest snapshot (~30 entities).
 */
import { GAME_MAP, laneWaypoints } from '@mech-arena-fight/shared';
import type { PlayerIndex, Snapshot, Wall } from '@mech-arena-fight/shared';
import { teamCss, TEAM_CSS } from './colors';

const WALL_CSS: Record<Wall['kind'], string> = {
  boundary: '#2b3645',
  base: '#33405a',
  building: '#3c4a66',
  cover: '#26303f',
};

export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly w: number;
  private readonly h: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly me: PlayerIndex
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('minimap: 2d context unavailable');
    this.ctx = ctx;
    this.w = canvas.width;
    this.h = canvas.height;
  }

  private sx(x: number): number {
    return ((x + GAME_MAP.size / 2) / GAME_MAP.size) * this.w;
  }
  private sz(z: number): number {
    return ((z + GAME_MAP.size / 2) / GAME_MAP.size) * this.h;
  }

  draw(snap: Snapshot, viewYaw: number | null): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = 'rgba(5,8,12,0.95)';
    ctx.fillRect(0, 0, this.w, this.h);

    // base zones
    for (const player of [0, 1] as const) {
      const zone = GAME_MAP.bases[player].zone;
      ctx.fillStyle = player === 0 ? 'rgba(34,211,238,0.10)' : 'rgba(249,115,22,0.10)';
      ctx.fillRect(
        this.sx(zone.minX),
        this.sz(zone.minZ),
        this.sx(zone.maxX) - this.sx(zone.minX),
        this.sz(zone.maxZ) - this.sz(zone.minZ)
      );
    }

    // lane hints
    ctx.strokeStyle = 'rgba(60,76,98,0.4)';
    ctx.lineWidth = 1;
    for (const player of [0, 1] as const) {
      for (const lane of ['left', 'right'] as const) {
        const pts = laneWaypoints(player, lane);
        ctx.beginPath();
        pts.forEach((p, i) => {
          if (i === 0) ctx.moveTo(this.sx(p.x), this.sz(p.z));
          else ctx.lineTo(this.sx(p.x), this.sz(p.z));
        });
        ctx.stroke();
      }
    }

    // walls
    for (const wall of GAME_MAP.walls) {
      ctx.fillStyle = WALL_CSS[wall.kind];
      ctx.fillRect(
        this.sx(wall.minX),
        this.sz(wall.minZ),
        Math.max(1, this.sx(wall.maxX) - this.sx(wall.minX)),
        Math.max(1, this.sz(wall.maxZ) - this.sz(wall.minZ))
      );
    }

    // core pads
    for (const player of [0, 1] as const) {
      const pad = GAME_MAP.bases[player].corePad;
      ctx.beginPath();
      ctx.arc(this.sx(pad.x), this.sz(pad.z), (pad.radius / GAME_MAP.size) * this.w, 0, Math.PI * 2);
      ctx.strokeStyle = TEAM_CSS[player];
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // turrets: triangles colored by owner
    for (const t of snap.turrets) {
      const x = this.sx(t.x);
      const y = this.sz(t.z);
      const r = 5;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.87, y + r * 0.5);
      ctx.lineTo(x - r * 0.87, y + r * 0.5);
      ctx.closePath();
      ctx.fillStyle = t.alive ? teamCss(t.owner) : '#3a4150';
      ctx.fill();
      if (!t.alive) {
        ctx.strokeStyle = '#555f70';
        ctx.stroke();
      }
      // capture in progress (or an owned turret being drained): progress ring
      // colored by whoever the progress belongs to — the HUD-level view the
      // spec requires alongside the in-world ring
      if (t.alive && t.capProgress > 0.001 && t.capProgress < 0.999) {
        ctx.beginPath();
        ctx.arc(x, y, 8, -Math.PI / 2, -Math.PI / 2 + t.capProgress * Math.PI * 2);
        ctx.strokeStyle = teamCss(t.capOwner);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // robots
    for (const u of snap.units) {
      ctx.fillStyle = teamCss(u.owner);
      const s = u.type === 'dreadnought' ? 3 : 2;
      ctx.fillRect(this.sx(u.x) - s / 2, this.sz(u.z) - s / 2, s, s);
    }

    // mechs
    for (const m of snap.mechs) {
      if (!m.alive) continue;
      const x = this.sx(m.x);
      const y = this.sz(m.z);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = teamCss(m.player);
      ctx.fill();
      if (m.player === this.me) {
        // own view marker: facing wedge from the camera/aim yaw
        const yaw = viewYaw ?? m.yaw;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, 11, yaw - 0.45, yaw + 0.45);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 5.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }
}

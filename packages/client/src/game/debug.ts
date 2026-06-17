/** F3 debug overlay: fps, ping, ticks, snapshot age, entity counts, mech state. */
import { byId } from '../dom';

export interface DebugInfo {
  fps: number;
  ping: number | null;
  /** rolling median RTT (ms) — the spike baseline */
  pingMedian: number;
  /** worst recent RTT above the median (ms) */
  pingJitterMs: number;
  /** server event-loop lag (ms) from the latest pong */
  serverLagMs: number | null;
  /** worst client frame gap (ms) in the recent window — main-thread stalls */
  maxFrameMs: number;
  /** adaptive interpolation render delay (ms) — rises when snapshots get bursty */
  renderDelayMs: number;
  serverTick: number | null;
  renderTick: number | null;
  snapshotAgeMs: number | null;
  units: number;
  projectiles: number;
  turrets: number;
  mech: { x: number; z: number; vx: number; vz: number; hp: number; heat: number; alive: boolean } | null;
  credits: number | null;
}

/** One plotted latency reading (one pong). */
export interface LatencyPoint {
  /** performance.now() when the pong arrived */
  at: number;
  /** round-trip time in ms */
  rtt: number;
  /** classified as a spike */
  spike: boolean;
}

export class DebugOverlay {
  private readonly root = byId('debug-overlay');
  private readonly text = byId('debug-text');
  private readonly canvas = byId<HTMLCanvasElement>('debug-graph');
  private readonly ctx = this.canvas.getContext('2d');
  private dpr = 0;
  private visible = false;

  toggle(): void {
    this.visible = !this.visible;
    this.root.classList.toggle('visible', this.visible);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /**
   * Scrolling latency graph: one point per pong over the trailing `windowMs`
   * (30 s). Time maps right-edge = now, so points scroll left and off-screen as
   * they age out. Y auto-scales; spikes are drawn red.
   */
  drawLatency(points: readonly LatencyPoint[], now: number, windowMs: number): void {
    const ctx = this.ctx;
    if (!ctx) return;

    // Size the backing store to device pixels once (crisp lines/text on HiDPI).
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || 240;
    const cssH = this.canvas.clientHeight || 64;
    if (this.dpr !== dpr || this.canvas.width !== Math.round(cssW * dpr)) {
      this.dpr = dpr;
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Auto-scale Y to the worst latency in view, floored so a calm link is flat.
    let maxRtt = 0;
    for (const p of points) if (p.rtt > maxRtt) maxRtt = p.rtt;
    const maxY = Math.max(100, Math.ceil(maxRtt / 50) * 50);
    const xOf = (at: number): number => cssW * (1 - (now - at) / windowMs);
    const yOf = (rtt: number): number => cssH - Math.min(1, rtt / maxY) * cssH;

    // Reference grid: top = maxY, faint mid-line.
    ctx.strokeStyle = 'rgba(159, 232, 245, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yOf(maxY / 2));
    ctx.lineTo(cssW, yOf(maxY / 2));
    ctx.stroke();

    // Latency trace.
    ctx.strokeStyle = '#9fe8f5';
    ctx.lineWidth = 1;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xOf(p.at);
      const y = yOf(p.rtt);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Per-pong dots; spikes in red.
    for (const p of points) {
      ctx.fillStyle = p.spike ? '#ff5a5a' : '#9fe8f5';
      ctx.beginPath();
      ctx.arc(xOf(p.at), yOf(p.rtt), p.spike ? 2 : 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Scale labels.
    ctx.fillStyle = 'rgba(159, 232, 245, 0.65)';
    ctx.font = '9px monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(`${maxY}ms`, 2, 1);
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${(windowMs / 1000) | 0}s`, 2, cssH - 1);
    if (points.length > 0) {
      const last = points[points.length - 1];
      ctx.fillStyle = last.spike ? '#ff5a5a' : '#9fe8f5';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`${Math.round(last.rtt)}ms`, cssW - 2, 1);
      ctx.textAlign = 'left';
    }
  }

  update(info: DebugInfo): void {
    if (!this.visible) return;
    const m = info.mech;
    const fmt = (v: number): string => v.toFixed(1);
    this.text.textContent = [
      `fps        ${info.fps.toFixed(0)}`,
      `ping       ${info.ping === null ? '--' : `${info.ping}ms`} (med ${info.pingMedian.toFixed(0)} jit ${info.pingJitterMs.toFixed(0)})`,
      `srv lag    ${info.serverLagMs === null ? '--' : `${info.serverLagMs}ms`}`,
      `frame max  ${info.maxFrameMs.toFixed(0)}ms`,
      `rdr delay  ${info.renderDelayMs.toFixed(0)}ms`,
      `srv tick   ${info.serverTick ?? '--'}`,
      `rnd tick   ${info.renderTick === null ? '--' : info.renderTick.toFixed(1)}`,
      `snap age   ${info.snapshotAgeMs === null ? '--' : `${info.snapshotAgeMs.toFixed(0)}ms`}`,
      `entities   units=${info.units} proj=${info.projectiles} turrets=${info.turrets}`,
      m
        ? `mech       pos=(${fmt(m.x)},${fmt(m.z)}) vel=(${fmt(m.vx)},${fmt(m.vz)})`
        : 'mech       --',
      m ? `           hp=${m.hp} heat=${fmt(m.heat)} alive=${m.alive}` : '',
      `credits    ${info.credits ?? '--'}`,
    ].join('\n');
  }

  hide(): void {
    this.visible = false;
    this.root.classList.remove('visible');
  }
}

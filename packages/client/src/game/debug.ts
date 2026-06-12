/** F3 debug overlay: fps, ping, ticks, snapshot age, entity counts, mech state. */
import { byId } from '../dom';

export interface DebugInfo {
  fps: number;
  ping: number | null;
  serverTick: number | null;
  renderTick: number | null;
  snapshotAgeMs: number | null;
  units: number;
  projectiles: number;
  turrets: number;
  mech: { x: number; z: number; vx: number; vz: number; hp: number; heat: number; alive: boolean } | null;
  credits: number | null;
}

export class DebugOverlay {
  private readonly root = byId('debug-overlay');
  private visible = false;

  toggle(): void {
    this.visible = !this.visible;
    this.root.classList.toggle('visible', this.visible);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  update(info: DebugInfo): void {
    if (!this.visible) return;
    const m = info.mech;
    const fmt = (v: number): string => v.toFixed(1);
    this.root.textContent = [
      `fps        ${info.fps.toFixed(0)}`,
      `ping       ${info.ping === null ? '--' : `${info.ping}ms`}`,
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

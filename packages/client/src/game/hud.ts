/**
 * DOM HUD: health/heat/rockets, credits, timer, ping, unit cap, the build bar
 * (costs and build times from the active balance preset), the build queue and
 * the event feed (phrased from the local player's perspective).
 */
import type { Balance, MechSnap, PlayerIndex, PlayerSnap, SimEvent, UnitType } from '@mech-arena-fight/shared';
import { byId, el, formatTime } from '../dom';

const MAX_FEED_ITEMS = 4;
const FEED_ITEM_TTL_MS = 6000;

const UNIT_LABEL: Record<UnitType, string> = { hovertank: 'Tank', dreadnought: 'Heavy Tank' };

export class Hud {
  private readonly healthRoot = byId('hud-health');
  private readonly healthFill = byId('hud-health-fill');
  private readonly healthText = byId('hud-health-text');
  private readonly heatRoot = byId('hud-heat');
  private readonly heatFill = byId('hud-heat-fill');
  private readonly heatText = byId('hud-heat-text');
  private readonly rocketsRoot = byId('hud-rockets');
  private readonly reloadFill = byId('hud-reload-fill');
  private readonly modeTag = byId('hud-mode');
  private readonly credits = byId('hud-credits');
  private readonly timer = byId('hud-timer');
  private readonly ping = byId('hud-ping');
  private readonly unitcap = byId('hud-unitcap');
  private readonly btnHover = byId<HTMLButtonElement>('build-hovertank');
  private readonly btnDread = byId<HTMLButtonElement>('build-dreadnought');
  private readonly queueRoot = byId('build-queue');
  private readonly feed = byId('event-feed');
  private readonly respawnOverlay = byId('respawn-overlay');
  private readonly respawnSeconds = byId('respawn-seconds');

  private readonly clickHover = (): void => this.onBuild('hovertank');
  private readonly clickDread = (): void => this.onBuild('dreadnought');

  constructor(
    private readonly balance: Balance,
    private readonly me: PlayerIndex,
    private readonly tickRate: number,
    private readonly onBuild: (unit: UnitType) => void
  ) {
    const fmt = (unit: UnitType): string => {
      const u = balance.units[unit];
      return `${u.cost}¢ · ${Math.round((u.buildTicks / balance.tickRate) * 10) / 10}s`;
    };
    byId('build-hovertank-info').textContent = fmt('hovertank');
    byId('build-dreadnought-info').textContent = fmt('dreadnought');
    this.btnHover.addEventListener('click', this.clickHover);
    this.btnDread.addEventListener('click', this.clickDread);
    this.feed.replaceChildren();
    this.queueRoot.replaceChildren();
    // Pip count derives from balance — the magazine size is tunable in one place.
    for (const pip of this.rocketsRoot.querySelectorAll('.pip')) pip.remove();
    for (let i = 0; i < balance.rocket.magazine; i++) {
      this.rocketsRoot.prepend(el('span', { className: 'pip' }));
    }
  }

  /** per-frame update from the latest snapshot data */
  update(tick: number, mech: MechSnap, player: PlayerSnap, rtt: number | null): void {
    // locomotion mode (hover locks rockets, fires the laser)
    const hover = mech.mode === 'hover';
    this.modeTag.textContent = hover ? 'HOVER' : 'WALKER';
    this.modeTag.classList.toggle('hover', hover);
    this.rocketsRoot.classList.toggle('locked', hover);

    // health
    const hpFrac = Math.max(0, mech.hp) / this.balance.mech.maxHp;
    this.healthFill.style.width = `${hpFrac * 100}%`;
    const respawnSecs = Math.ceil(mech.respawnInTicks / this.tickRate);
    this.healthText.textContent = mech.alive ? `${Math.max(0, mech.hp)}` : `RESPAWN ${respawnSecs}s`;
    this.healthRoot.classList.toggle('dead', !mech.alive);

    // center respawn countdown while dead
    this.respawnOverlay.classList.toggle('active', !mech.alive);
    if (!mech.alive) this.respawnSeconds.textContent = String(respawnSecs);

    // heat
    const heatFrac = Math.min(1, mech.heat / this.balance.gatling.overheatAt);
    this.heatFill.style.width = `${heatFrac * 100}%`;
    this.heatRoot.classList.toggle('overheated', mech.overheated);
    this.heatText.textContent = mech.overheated ? 'OVERHEATED' : '';

    // rockets
    const pips = this.rocketsRoot.querySelectorAll<HTMLElement>('.pip');
    pips.forEach((pip, i) => pip.classList.toggle('full', i < mech.rocketAmmo));
    this.reloadFill.style.width = mech.reloading ? `${mech.reloadFrac * 100}%` : '0%';

    // economy / status
    this.credits.textContent = String(player.credits);
    this.timer.textContent = formatTime(tick / this.tickRate);
    this.ping.textContent = rtt === null ? '--' : `${rtt}ms`;
    this.unitcap.textContent = `${player.unitsAlive}/${player.unitCap}`;

    // build availability
    for (const unit of ['hovertank', 'dreadnought'] as const) {
      const btn = unit === 'hovertank' ? this.btnHover : this.btnDread;
      const cost = this.balance.units[unit].cost;
      const blocked =
        player.credits < cost ||
        player.queue.length >= this.balance.queueMax ||
        player.unitsAlive + player.queue.length >= player.unitCap;
      btn.classList.toggle('unavailable', blocked);
    }

    this.updateQueue(player);
  }

  private updateQueue(player: PlayerSnap): void {
    // Rebuild chips (≤3, cheap) — head chip shows the build progress fill.
    this.queueRoot.replaceChildren();
    player.queue.forEach((item, i) => {
      const fill = el('div', { className: 'q-fill' });
      fill.style.height = `${i === 0 ? item.progress * 100 : 0}%`;
      const chip = el('div', { className: 'queue-item', testid: 'queue-item' }, [
        fill,
        el('div', { className: 'q-label', text: item.unit === 'hovertank' ? 'TK' : 'HV' }),
      ]);
      this.queueRoot.appendChild(chip);
    });
  }

  // ------------------------------------------------------------ event feed

  addEvents(events: SimEvent[]): void {
    for (const ev of events) {
      const entry = this.phrase(ev);
      if (entry) this.pushFeed(entry.text, entry.tone);
    }
  }

  private phrase(ev: SimEvent): { text: string; tone: 'good' | 'bad' | 'warn' | 'plain' } | null {
    const me = this.me;
    switch (ev.type) {
      case 'turretCaptured':
        return ev.player === me
          ? { text: 'Turret captured', tone: 'good' }
          : { text: 'Enemy captured a turret', tone: 'bad' };
      case 'turretDestroyed':
        if (ev.byPlayer === me) return { text: 'You destroyed a turret', tone: 'good' };
        if (ev.previousOwner === me) return { text: 'Your turret was destroyed', tone: 'bad' };
        return { text: 'Enemy destroyed a turret', tone: 'plain' };
      case 'turretRespawned':
        return { text: 'Turret back online', tone: 'plain' };
      case 'unitDeployed':
        return ev.player === me
          ? { text: `${UNIT_LABEL[ev.unit]} deployed`, tone: 'good' }
          : { text: `Enemy ${UNIT_LABEL[ev.unit]} deployed`, tone: 'bad' };
      case 'unitDestroyed':
        return ev.owner === me
          ? { text: `Your ${UNIT_LABEL[ev.unit]} was destroyed`, tone: 'bad' }
          : { text: `Enemy ${UNIT_LABEL[ev.unit]} destroyed`, tone: 'good' };
      case 'mechKilled':
        return ev.victim === me
          ? { text: 'You were destroyed', tone: 'warn' }
          : { text: 'Enemy mech destroyed', tone: 'good' };
      case 'mechRespawned':
        return ev.player === me ? { text: 'Mech redeployed', tone: 'plain' } : null;
      case 'baseUnderAttack':
        return ev.player === me
          ? { text: 'Your base is under attack!', tone: 'warn' }
          : { text: 'Enemy base under attack', tone: 'good' };
      case 'buildRejected': {
        if (ev.player !== me) return null;
        const reason =
          ev.reason === 'credits'
            ? 'not enough credits'
            : ev.reason === 'queueFull'
              ? 'queue full'
              : ev.reason === 'unitCap'
                ? 'unit cap reached'
                : 'match over';
        return { text: `Build rejected — ${reason}`, tone: 'bad' };
      }
      case 'unitQueued':
      case 'matchEnd':
        return null;
      default:
        return null;
    }
  }

  private pushFeed(text: string, tone: 'good' | 'bad' | 'warn' | 'plain'): void {
    const item = el('div', {
      className: `event-item${tone === 'plain' ? '' : ` ${tone}`}`,
      text,
      testid: 'event-item',
    });
    this.feed.appendChild(item);
    while (this.feed.children.length > MAX_FEED_ITEMS) {
      this.feed.removeChild(this.feed.children[0]);
    }
    window.setTimeout(() => {
      if (item.parentElement === this.feed) this.feed.removeChild(item);
    }, FEED_ITEM_TTL_MS);
  }

  dispose(): void {
    this.btnHover.removeEventListener('click', this.clickHover);
    this.btnDread.removeEventListener('click', this.clickDread);
    this.feed.replaceChildren();
    this.queueRoot.replaceChildren();
  }
}

import type { MatchEndReason, PlayerIndex, PlayerStats } from '@mech-arena-fight/shared';
import { byId, el, formatTime } from '../dom';

export interface MatchResult {
  winner: PlayerIndex;
  reason: MatchEndReason;
  durationTicks: number;
  stats: [PlayerStats, PlayerStats];
}

const STAT_ROWS: { label: string; key: keyof PlayerStats }[] = [
  { label: 'Robots built', key: 'robotsBuilt' },
  { label: 'Robots destroyed', key: 'robotsDestroyed' },
  { label: 'Turret captures', key: 'turretCaptures' },
  { label: 'Kills', key: 'kills' },
];

export class ResultScreen {
  private readonly title = byId('result-title');
  private readonly reason = byId('result-reason');
  private readonly duration = byId('result-duration');
  private readonly stats = byId<HTMLTableElement>('result-stats');
  private readonly backBtn = byId<HTMLButtonElement>('back-to-lobby-btn');
  private readonly rematchBtn = byId<HTMLButtonElement>('rematch-btn');
  private readonly status = byId('result-status');

  constructor(onBackToLobby: () => void, onRematch: () => void) {
    this.backBtn.addEventListener('click', onBackToLobby);
    this.rematchBtn.addEventListener('click', () => {
      this.rematchBtn.disabled = true;
      this.status.textContent = 'Waiting for opponent…';
      onRematch();
    });
  }

  show(result: MatchResult, me: PlayerIndex, tickRate: number): void {
    const won = result.winner === me;
    this.title.textContent = won ? 'VICTORY' : 'DEFEAT';
    this.title.classList.toggle('victory', won);
    this.title.classList.toggle('defeat', !won);

    if (result.reason === 'forfeit') {
      this.reason.textContent = won ? 'Opponent left the match — win by forfeit.' : 'Match forfeited.';
    } else {
      this.reason.textContent = won
        ? 'Your robot breached the enemy core.'
        : 'An enemy robot breached your core.';
    }
    this.duration.textContent = `Match duration ${formatTime(result.durationTicks / tickRate)}`;

    const enemy = (1 - me) as PlayerIndex;
    this.stats.replaceChildren();
    const head = el('tr', {}, [
      el('th', { text: '' }),
      el('th', { className: 'you-col', text: 'YOU' }),
      el('th', { className: 'enemy-col', text: 'ENEMY' }),
    ]);
    this.stats.appendChild(head);
    for (const row of STAT_ROWS) {
      this.stats.appendChild(
        el('tr', {}, [
          el('td', { className: 'stat-name', text: row.label }),
          el('td', { className: 'you-col', text: String(result.stats[me][row.key]) }),
          el('td', { className: 'enemy-col', text: String(result.stats[enemy][row.key]) }),
        ])
      );
    }

    // After a forfeit the server has already dissolved the room — there is no
    // opponent left to rematch against.
    this.rematchBtn.hidden = result.reason === 'forfeit';
    this.rematchBtn.disabled = false;
    this.status.textContent = '';
  }

  /** Called when the opponent leaves the room while we sit on this screen. */
  opponentLeft(): void {
    this.rematchBtn.hidden = true;
    this.status.textContent = 'Opponent left the room — rematch unavailable.';
  }
}

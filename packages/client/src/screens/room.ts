import type { RoomInfo } from '@mech-arena-fight/shared';
import { byId, el } from '../dom';

export class RoomScreen {
  private readonly title = byId('room-title');
  private readonly preset = byId('room-preset');
  private readonly playerList = byId('player-list');
  private readonly readyBtn = byId<HTMLButtonElement>('ready-btn');
  private readonly leaveBtn = byId<HTMLButtonElement>('leave-room-btn');
  private readonly status = byId('room-status');
  private ready = false;

  constructor(onReadyToggle: (ready: boolean) => void, onLeave: () => void) {
    this.readyBtn.addEventListener('click', () => {
      onReadyToggle(!this.ready);
    });
    this.leaveBtn.addEventListener('click', onLeave);
  }

  update(room: RoomInfo): void {
    this.title.textContent = room.name.toUpperCase();
    this.preset.textContent = `balance preset: ${room.preset}`;
    this.playerList.replaceChildren();

    room.players.forEach((p, i) => {
      const isYou = i === room.youIndex;
      const row = el('div', { className: `player-item${isYou ? ' you' : ''}`, testid: 'player-item' }, [
        el('span', { className: 'p-name', text: `${p.name}${isYou ? ' (you)' : ''}` }),
        el('span', {
          className: `p-ready${p.ready ? ' is-ready' : ''}`,
          text: p.ready ? 'READY' : 'NOT READY',
        }),
      ]);
      this.playerList.appendChild(row);
    });
    if (room.players.length < 2) {
      this.playerList.appendChild(
        el('div', { className: 'player-item', testid: 'player-item' }, [
          el('span', { className: 'p-name dim', text: '— waiting for opponent —' }),
        ])
      );
    }

    const you = room.players[room.youIndex];
    this.ready = you?.ready ?? false;
    this.readyBtn.textContent = this.ready ? 'UNREADY' : 'READY';
    this.readyBtn.classList.toggle('armed', this.ready);
    this.status.textContent =
      room.players.length < 2
        ? 'Share the lobby — another pilot must join.'
        : room.players.every((p) => p.ready)
          ? 'All ready…'
          : 'Both players must ready up to start.';
  }
}

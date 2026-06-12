import type { RoomSummary } from '@precinct/shared';
import { byId, el } from '../dom';

export class LobbyScreen {
  private readonly list = byId('room-list');
  private readonly empty = byId('lobby-empty');
  private readonly createBtn = byId<HTMLButtonElement>('create-room-btn');
  private readonly roomNameInput = byId<HTMLInputElement>('create-room-name');
  private readonly selfLabel = byId('lobby-self');

  constructor(
    onCreate: (roomName: string | undefined) => void,
    private readonly onJoin: (roomId: string) => void
  ) {
    this.createBtn.addEventListener('click', () => {
      const raw = this.roomNameInput.value.trim().slice(0, 32);
      onCreate(raw.length > 0 ? raw : undefined);
    });
  }

  setSelfName(name: string): void {
    this.selfLabel.textContent = `LOGGED IN AS ${name.toUpperCase()}`;
  }

  update(rooms: RoomSummary[]): void {
    this.list.replaceChildren();
    this.empty.classList.toggle('hidden', rooms.length > 0);
    for (const room of rooms) {
      const joinable = room.status === 'waiting' && room.playerCount < room.maxPlayers;
      const joinBtn = el('button', {
        className: 'btn primary',
        text: 'JOIN',
        testid: 'room-join-btn',
      });
      joinBtn.disabled = !joinable;
      joinBtn.addEventListener('click', () => this.onJoin(room.id));

      const row = el(
        'div',
        { className: 'room-item', testid: 'room-item', attrs: { 'data-room-id': room.id } },
        [
          el('span', { className: 'room-name', text: room.name }),
          el('span', {
            className: 'room-meta',
            text: `host ${room.host} · ${room.playerCount}/${room.maxPlayers} · ${room.status}`,
          }),
          joinBtn,
        ]
      );
      this.list.appendChild(row);
    }
  }
}

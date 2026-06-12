/**
 * BotClient: a reusable Node-side client that speaks the real WebSocket
 * protocol — join lobby, create/join rooms, ready up, send inputs, build
 * units, receive snapshots. Used by the protocol integration tests and the
 * headless `npm run simulate` script.
 */
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { NULL_INPUT } from '@precinct/shared';
import type {
  BalancePresetName,
  ClientMessage,
  PlayerInput,
  RoomInfo,
  RoomSummary,
  ServerMessage,
  SimEvent,
  Snapshot,
  UnitType,
} from '@precinct/shared';

type ServerMessageType = ServerMessage['type'];
type MsgOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;

interface Waiter {
  type: ServerMessageType;
  predicate: ((msg: ServerMessage) => boolean) | undefined;
  resolve: (msg: ServerMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class BotClient {
  readonly name: string;
  clientId = '';
  /** seat in the current match; -1 before the first matchStart */
  playerIndex = -1;
  lastSnapshot: Snapshot | null = null;
  /** sim events accumulated from snapshot messages since the last matchStart */
  allEvents: SimEvent[] = [];
  /** latest roomState, if in a room */
  room: RoomInfo | null = null;
  lastMatchEnd: MsgOf<'matchEnd'> | null = null;
  /** every protocol error the server sent us */
  errors: MsgOf<'error'>[] = [];
  /** optional tap on every inbound message (event logging in simulate.ts) */
  onMessage: ((msg: ServerMessage) => void) | null = null;

  private rooms: RoomSummary[] = [];
  private readonly ws: WebSocket;
  private waiters: Waiter[] = [];
  private closed = false;
  private socketError: Error | null = null;

  private constructor(url: string, name: string) {
    this.name = name;
    this.ws = new WebSocket(url);
    this.ws.on('message', (data: RawData) => this.handleRaw(data.toString()));
    this.ws.on('close', () => this.handleClose());
    this.ws.on('error', (err: Error) => {
      this.socketError = err;
    });
  }

  /** Open the socket, wait for welcome, perform hello, wait for the lobby list. */
  static async connect(url: string, name: string, timeoutMs = 5000): Promise<BotClient> {
    const bot = new BotClient(url, name);
    await bot.waitForMessage('welcome', undefined, timeoutMs);
    bot.send({ type: 'hello', name });
    await bot.waitForMessage('lobbyState', undefined, timeoutMs);
    return bot;
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Send a raw (possibly invalid) frame — for protocol validation tests. */
  sendRaw(data: string): void {
    this.ws.send(data);
  }

  async createRoom(
    opts: { roomName?: string; preset?: BalancePresetName } = {},
    timeoutMs = 5000
  ): Promise<RoomInfo> {
    const p = this.waitForMessage('roomState', undefined, timeoutMs);
    this.send({ type: 'createRoom', roomName: opts.roomName, preset: opts.preset });
    return (await p).room;
  }

  async joinRoom(roomId: string, timeoutMs = 5000): Promise<RoomInfo> {
    const p = this.waitForMessage('roomState', (m) => m.room.id === roomId, timeoutMs);
    this.send({ type: 'joinRoom', roomId });
    return (await p).room;
  }

  async leaveRoom(timeoutMs = 5000): Promise<void> {
    const p = this.waitForMessage('lobbyState', undefined, timeoutMs);
    this.send({ type: 'leaveRoom' });
    await p;
    this.room = null;
  }

  ready(flag = true): void {
    this.send({ type: 'ready', ready: flag });
  }

  /** Send an input frame; unspecified fields fall back to NULL_INPUT. */
  sendInput(partial: Partial<PlayerInput> = {}): void {
    this.send({ type: 'input', ...NULL_INPUT, ...partial });
  }

  build(unit: UnitType): void {
    this.send({ type: 'build', unit });
  }

  /** Measured round-trip time in ms via ping/pong. */
  async ping(timeoutMs = 5000): Promise<number> {
    const t = performance.now();
    const p = this.waitForMessage('pong', (m) => m.t === t, timeoutMs);
    this.send({ type: 'ping', t });
    await p;
    return performance.now() - t;
  }

  // -------------------------------------------------------------------------
  // State & waiting
  // -------------------------------------------------------------------------

  /** Latest lobbyState room list. */
  getRooms(): RoomSummary[] {
    return this.rooms;
  }

  async waitForRoomCount(n: number, timeoutMs = 5000): Promise<RoomSummary[]> {
    if (this.rooms.length === n) return this.rooms;
    const msg = await this.waitForMessage('lobbyState', (m) => m.rooms.length === n, timeoutMs);
    return msg.rooms;
  }

  waitForMatchStart(timeoutMs = 10_000): Promise<MsgOf<'matchStart'>> {
    return this.waitForMessage('matchStart', undefined, timeoutMs);
  }

  /** Resolves with the matchEnd of the current match (cached if already over). */
  async waitForMatchEnd(timeoutMs = 20_000): Promise<MsgOf<'matchEnd'>> {
    if (this.lastMatchEnd) return this.lastMatchEnd;
    return this.waitForMessage('matchEnd', undefined, timeoutMs);
  }

  /**
   * Wait for the next message of the given type (optionally also matching the
   * predicate). Rejects with a descriptive error on timeout or socket close.
   */
  waitForMessage<T extends ServerMessageType>(
    type: T,
    predicate?: (msg: MsgOf<T>) => boolean,
    timeoutMs = 5000
  ): Promise<MsgOf<T>> {
    return new Promise<MsgOf<T>>((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`[bot ${this.name}] cannot wait for '${type}': socket already closed`));
        return;
      }
      const waiter: Waiter = {
        type,
        predicate: predicate as ((msg: ServerMessage) => boolean) | undefined,
        resolve: resolve as (msg: ServerMessage) => void,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error(`[bot ${this.name}] timed out after ${timeoutMs}ms waiting for '${type}'`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Graceful close; resolves once the socket is fully closed. */
  close(): Promise<void> {
    if (this.closed || this.ws.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  /** Abrupt disconnect (no close handshake) — simulates a dropped connection. */
  terminate(): void {
    this.ws.terminate();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private handleRaw(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return; // the server never sends invalid JSON; ignore defensively
    }
    this.track(msg);
    if (this.onMessage) this.onMessage(msg);
    const matched = this.waiters.filter(
      (w) => w.type === msg.type && (w.predicate === undefined || w.predicate(msg))
    );
    if (matched.length > 0) {
      this.waiters = this.waiters.filter((w) => !matched.includes(w));
      for (const w of matched) {
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  }

  private track(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        this.clientId = msg.clientId;
        break;
      case 'lobbyState':
        this.rooms = msg.rooms;
        break;
      case 'roomState':
        this.room = msg.room;
        break;
      case 'matchStart':
        this.playerIndex = msg.playerIndex;
        this.lastSnapshot = null;
        this.allEvents = [];
        this.lastMatchEnd = null;
        break;
      case 'snapshot':
        this.lastSnapshot = msg.snap;
        this.allEvents.push(...msg.events);
        break;
      case 'matchEnd':
        this.lastMatchEnd = msg;
        break;
      case 'error':
        this.errors.push(msg);
        break;
      default:
        break;
    }
  }

  private handleClose(): void {
    this.closed = true;
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) {
      clearTimeout(w.timer);
      const cause = this.socketError ? `: ${this.socketError.message}` : '';
      w.reject(new Error(`[bot ${this.name}] socket closed while waiting for '${w.type}'${cause}`));
    }
  }
}

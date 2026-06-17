/**
 * LobbyManager: tracks every connected client, owns the room map, routes
 * validated client messages by the client's current location (lobby vs room)
 * and broadcasts the room list to everyone who is not in a live match
 * whenever rooms change.
 */
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@mech-arena-fight/shared';
import type {
  BalancePresetName,
  BotDifficulty,
  ClientMessage,
  RoomSummary,
  ServerErrorCode,
} from '@mech-arena-fight/shared';
import { send } from './connection';
import type { ClientConn } from './connection';
import type { Logger } from './logger';
import { Room } from './room';

export interface LobbyOptions {
  logger: Logger;
  /** simulation ticks per second (Hz) — scales the balance for every room */
  tickRate: number;
  /** wall-clock ms per simulation tick */
  tickMs: number;
  /** wall-clock ms per countdown second */
  countdownSecondMs: number;
  /** when set (BALANCE_PRESET env), every room is forced to this preset */
  forcedPreset?: BalancePresetName | undefined;
  /** allow the debug tuning overlay's tuneMech messages (dev only) */
  allowTuning: boolean;
  /** current event-loop lag in ms, stamped into pongs for client diagnostics */
  getEventLoopLagMs?: () => number;
}

export class LobbyManager {
  readonly logger: Logger;
  private readonly tickRate: number;
  private readonly tickMs: number;
  private readonly countdownSecondMs: number;
  private readonly forcedPreset: BalancePresetName | undefined;
  private readonly allowTuning: boolean;
  private readonly getEventLoopLagMs: () => number;
  /** ws:// the bot workers dial back into; set once the server is listening. */
  private botConnectUrl: string | null = null;
  /** live bot worker threads, keyed by their room id, so we can stop them. */
  private readonly botWorkers = new Map<string, Worker>();
  private readonly clients = new Map<string, ClientConn>();
  private readonly rooms = new Map<string, Room>();

  constructor(opts: LobbyOptions) {
    this.logger = opts.logger;
    this.tickRate = opts.tickRate;
    this.tickMs = opts.tickMs;
    this.countdownSecondMs = opts.countdownSecondMs;
    this.forcedPreset = opts.forcedPreset;
    this.allowTuning = opts.allowTuning;
    this.getEventLoopLagMs = opts.getEventLoopLagMs ?? (() => 0);
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  register(ws: WebSocket): ClientConn {
    const client: ClientConn = { id: randomBytes(6).toString('hex'), ws, name: null, roomId: null };
    this.clients.set(client.id, client);
    this.logger.info('client connected', { clientId: client.id });
    send(client, { type: 'welcome', clientId: client.id, protocolVersion: PROTOCOL_VERSION });
    return client;
  }

  handleDisconnect(client: ClientConn): void {
    this.clients.delete(client.id);
    this.logger.info('client disconnected', { clientId: client.id, name: client.name });
    const room = this.roomOf(client);
    if (room) room.removeClient(client, 'disconnect');
  }

  // -------------------------------------------------------------------------
  // Message routing (messages are already protocol-validated)
  // -------------------------------------------------------------------------

  handleMessage(client: ClientConn, msg: ClientMessage): void {
    switch (msg.type) {
      case 'hello': {
        client.name = msg.name;
        this.logger.info('client hello', { clientId: client.id, name: msg.name });
        const room = this.roomOf(client);
        if (room) {
          room.broadcastRoomState();
        } else {
          send(client, { type: 'lobbyState', rooms: this.roomSummaries() });
        }
        return;
      }
      case 'ping':
        send(client, { type: 'pong', t: msg.t, srvLagMs: Math.round(this.getEventLoopLagMs()) });
        return;
      case 'createRoom': {
        if (client.roomId !== null) {
          return this.sendError(client, 'alreadyInRoom', 'leave your current room first');
        }
        const preset = this.forcedPreset ?? msg.preset ?? 'default';
        const room = new Room({
          id: this.newRoomId(),
          name: msg.roomName ?? `${client.name ?? 'someone'}'s room`,
          preset,
          tickRate: this.tickRate,
          tickMs: this.tickMs,
          countdownSecondMs: this.countdownSecondMs,
          logger: this.logger,
          onRoomsChanged: () => this.broadcastLobby(),
          onEmpty: (r) => this.removeRoom(r),
        });
        this.rooms.set(room.id, room);
        this.logger.info('room created', {
          roomId: room.id,
          name: room.name,
          preset,
          host: client.name,
        });
        room.addClient(client);
        return;
      }
      case 'playVsBot': {
        if (client.roomId !== null) {
          return this.sendError(client, 'alreadyInRoom', 'leave your current room first');
        }
        if (this.botConnectUrl === null) {
          return this.sendError(client, 'internal', 'AI opponent unavailable');
        }
        const preset = this.forcedPreset ?? 'default';
        const room = new Room({
          id: this.newRoomId(),
          name: `${client.name ?? 'someone'} vs AI`,
          preset,
          tickRate: this.tickRate,
          tickMs: this.tickMs,
          countdownSecondMs: this.countdownSecondMs,
          logger: this.logger,
          onRoomsChanged: () => this.broadcastLobby(),
          onEmpty: (r) => this.removeRoom(r),
        });
        this.rooms.set(room.id, room);
        room.addClient(client);
        room.setReady(client, true); // human is auto-readied; the bot readies on join
        const name = `AI (${msg.difficulty})`;
        const worker = new Worker(new URL('./bot/worker.ts', import.meta.url), {
          workerData: { url: this.botConnectUrl, roomId: room.id, name, difficulty: msg.difficulty },
        });
        worker.on('error', (e) => this.logger.error('bot worker error', { error: e.message }));
        worker.on('exit', () => this.botWorkers.delete(room.id));
        this.botWorkers.set(room.id, worker);
        this.logger.info('vs-AI match created', { roomId: room.id, difficulty: msg.difficulty });
        return;
      }
      case 'joinRoom': {
        if (client.roomId !== null) {
          return this.sendError(client, 'alreadyInRoom', 'leave your current room first');
        }
        const room = this.rooms.get(msg.roomId);
        if (!room) {
          return this.sendError(client, 'noSuchRoom', `room ${msg.roomId} does not exist`);
        }
        if (!room.addClient(client)) {
          return this.sendError(client, 'roomUnavailable', 'room is full or already playing');
        }
        this.logger.info('player joined room', {
          roomId: room.id,
          clientId: client.id,
          name: client.name,
        });
        return;
      }
      case 'leaveRoom': {
        const room = this.roomOf(client);
        // Not an error: after a forfeit the server already ejected the client,
        // and their "back to lobby" click may still send leaveRoom.
        if (!room) return send(client, { type: 'lobbyState', rooms: this.roomSummaries() });
        room.removeClient(client, 'leave');
        return;
      }
      case 'ready': {
        const room = this.roomOf(client);
        if (!room) return this.sendError(client, 'notInRoom', 'you are not in a room');
        room.setReady(client, msg.ready);
        return;
      }
      case 'input': {
        const room = this.roomOf(client);
        if (!room) {
          // Input frames arrive at high frequency; replying with errors would
          // just flood the socket. Log at debug instead.
          this.logger.debug('input ignored: not in a room', { clientId: client.id });
          return;
        }
        room.handleInput(client, {
          mx: msg.mx,
          mz: msg.mz,
          aimX: msg.aimX,
          aimZ: msg.aimZ,
          fire: msg.fire,
          alt: msg.alt,
          mode: msg.mode,
        });
        return;
      }
      case 'build': {
        const room = this.roomOf(client);
        const error = room ? room.handleBuild(client, msg.unit) : 'you are not in a room';
        if (error !== null) this.sendError(client, 'buildUnavailable', error);
        return;
      }
      case 'tuneMech': {
        if (!this.allowTuning) return; // dev-only; ignored in production
        this.roomOf(client)?.tuneMech(msg.key, msg.value);
        return;
      }
      default: {
        // Exhaustiveness guard — parseClientMessage cannot produce this.
        const never: never = msg;
        this.logger.error('unhandled message type', { msg: never });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lobby broadcast & room management
  // -------------------------------------------------------------------------

  /** Send the room list to every named client that is not in a live match. */
  broadcastLobby(): void {
    const rooms = this.roomSummaries();
    for (const client of this.clients.values()) {
      if (client.name === null) continue;
      const room = this.roomOf(client);
      if (room && room.status === 'playing') continue;
      send(client, { type: 'lobbyState', rooms });
    }
  }

  private roomSummaries(): RoomSummary[] {
    return [...this.rooms.values()].map((r) => r.summary());
  }

  private roomOf(client: ClientConn): Room | undefined {
    return client.roomId !== null ? this.rooms.get(client.roomId) : undefined;
  }

  /** Tell the lobby where bot workers should dial in (called once listening). */
  setBotConnectUrl(url: string): void {
    this.botConnectUrl = url;
  }

  private removeRoom(room: Room): void {
    this.rooms.delete(room.id);
    this.botWorkers.get(room.id)?.postMessage('stop'); // stop its AI worker, if any
    room.dispose();
    this.logger.info('room removed', { roomId: room.id, name: room.name });
    this.broadcastLobby();
  }

  private newRoomId(): string {
    for (;;) {
      const id = randomBytes(3).toString('hex');
      if (!this.rooms.has(id)) return id;
    }
  }

  private sendError(client: ClientConn, code: ServerErrorCode, message: string): void {
    this.logger.warn('rejected client message', { clientId: client.id, code, reason: message });
    send(client, { type: 'error', code, message });
  }

  // -------------------------------------------------------------------------
  // Inspection & shutdown
  // -------------------------------------------------------------------------

  /** JSON dump for GET /debug/state. */
  debugState(): Record<string, unknown> {
    let lobbyClients = 0;
    for (const c of this.clients.values()) {
      if (c.roomId === null) lobbyClients++;
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      clients: this.clients.size,
      lobbyClients,
      rooms: [...this.rooms.values()].map((r) => r.debugInfo()),
    };
  }

  /** Tear everything down: all room timers cleared, all sockets terminated. */
  closeAll(): void {
    for (const w of this.botWorkers.values()) void w.terminate();
    this.botWorkers.clear();
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
    for (const client of this.clients.values()) client.ws.terminate();
    this.clients.clear();
  }
}

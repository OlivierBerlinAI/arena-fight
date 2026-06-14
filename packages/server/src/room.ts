/**
 * A game room: max 2 players, its own deterministic GameSimulation and a
 * wall-clock tick loop that only runs while a match is playing.
 *
 * Lifecycle: waiting → (both ready) countdown 3..2..1 → playing → matchEnd
 * (core win or forfeit) → back to waiting with both players un-readied, so
 * re-readying starts an instant rematch on a fresh simulation.
 */
import { GameSimulation, getBalance, SNAPSHOT_EVERY_TICKS } from '@mech-arena-fight/shared';
import type {
  BalancePresetName,
  MatchEndReason,
  PlayerIndex,
  PlayerInput,
  PlayerStats,
  RoomInfo,
  RoomStatus,
  RoomSummary,
  ServerMessage,
  SimCommand,
  SimEvent,
  UnitType,
} from '@mech-arena-fight/shared';
import { send } from './connection';
import type { ClientConn } from './connection';
import type { Logger } from './logger';

export const MAX_PLAYERS = 2;
const COUNTDOWN_SECONDS = 3;

export interface RoomOptions {
  id: string;
  name: string;
  preset: BalancePresetName;
  /** simulation ticks per second (Hz) — the balance is scaled to this rate */
  tickRate: number;
  /** wall-clock ms between simulation ticks (pacing only) */
  tickMs: number;
  /** wall-clock ms per countdown second (tests shrink this) */
  countdownSecondMs: number;
  logger: Logger;
  /** called whenever the lobby room list should be re-broadcast */
  onRoomsChanged: () => void;
  /** called when the last client leaves; the lobby deletes the room */
  onEmpty: (room: Room) => void;
}

export class Room {
  readonly id: string;
  readonly name: string;
  readonly preset: BalancePresetName;
  status: RoomStatus = 'waiting';
  readonly clients: ClientConn[] = [];

  private readonly tickRate: number;
  private readonly tickMs: number;
  private readonly countdownSecondMs: number;
  private readonly logger: Logger;
  private readonly onRoomsChanged: () => void;
  private readonly onEmpty: (room: Room) => void;

  private readonly readyFlags = new Map<string, boolean>();
  /** clientId → PlayerIndex for the match currently in progress */
  private readonly matchSeat = new Map<string, PlayerIndex>();
  private sim: GameSimulation | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  private inputs: [PlayerInput | null, PlayerInput | null] = [null, null];
  private pendingCommands: SimCommand[] = [];
  private eventsSinceSnapshot: SimEvent[] = [];

  constructor(opts: RoomOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.preset = opts.preset;
    this.tickRate = opts.tickRate;
    this.tickMs = opts.tickMs;
    this.countdownSecondMs = opts.countdownSecondMs;
    this.logger = opts.logger;
    this.onRoomsChanged = opts.onRoomsChanged;
    this.onEmpty = opts.onEmpty;
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  /** Add a client; returns false when the room is full or a match is underway. */
  addClient(client: ClientConn): boolean {
    if (this.status !== 'waiting' || this.clients.length >= MAX_PLAYERS) return false;
    this.clients.push(client);
    this.readyFlags.set(client.id, false);
    client.roomId = this.id;
    this.broadcastRoomState();
    this.onRoomsChanged();
    return true;
  }

  removeClient(client: ClientConn, cause: 'leave' | 'disconnect'): void {
    const idx = this.clients.indexOf(client);
    if (idx === -1) return;
    this.clients.splice(idx, 1);
    this.readyFlags.delete(client.id);
    client.roomId = null;
    this.logger.info('player left room', {
      roomId: this.id,
      clientId: client.id,
      name: client.name,
      cause,
      during: this.status,
    });

    if (this.status === 'countdown') {
      this.cancelCountdown('player left');
    }
    if (this.status === 'playing') {
      const remaining = this.clients[0];
      if (remaining !== undefined) {
        // Mid-match departure = forfeit; the remaining player wins and is
        // returned to the lobby — the room does not outlive the match.
        const winner = this.matchSeat.get(remaining.id) ?? 0;
        this.finishMatch(winner, 'forfeit');
        while (this.clients.length > 0) {
          const c = this.clients.pop()!;
          this.readyFlags.delete(c.id);
          c.roomId = null;
        }
      } else {
        this.stopMatchLoop();
        this.sim = null;
        this.matchSeat.clear();
        this.status = 'waiting';
      }
    }

    for (const c of this.clients) this.readyFlags.set(c.id, false);
    if (this.clients.length === 0) {
      this.onEmpty(this);
    } else {
      this.broadcastRoomState();
      this.onRoomsChanged();
    }
  }

  // -------------------------------------------------------------------------
  // Ready / countdown
  // -------------------------------------------------------------------------

  setReady(client: ClientConn, ready: boolean): void {
    if (!this.clients.includes(client) || this.status === 'playing') return;
    this.readyFlags.set(client.id, ready);
    if (this.status === 'countdown' && !ready) {
      this.cancelCountdown('player unreadied');
    }
    this.broadcastRoomState();
    if (
      this.status === 'waiting' &&
      this.clients.length === MAX_PLAYERS &&
      this.clients.every((c) => this.readyFlags.get(c.id) === true)
    ) {
      this.beginCountdown();
    }
  }

  private beginCountdown(): void {
    this.status = 'countdown';
    this.logger.info('countdown started', { roomId: this.id });
    this.broadcastRoomState();
    this.onRoomsChanged();
    let remaining = COUNTDOWN_SECONDS;
    this.broadcast({ type: 'countdown', seconds: remaining });
    this.countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        this.clearCountdownTimer();
        this.startMatch();
      } else {
        this.broadcast({ type: 'countdown', seconds: remaining });
      }
    }, this.countdownSecondMs);
  }

  private cancelCountdown(reason: string): void {
    this.clearCountdownTimer();
    this.status = 'waiting';
    this.logger.info('countdown cancelled', { roomId: this.id, reason });
    this.onRoomsChanged();
  }

  // -------------------------------------------------------------------------
  // Match loop
  // -------------------------------------------------------------------------

  private startMatch(): void {
    const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.sim = new GameSimulation({ seed, balance: getBalance(this.preset, this.tickRate) });
    this.status = 'playing';
    this.inputs = [null, null];
    this.pendingCommands = [];
    this.eventsSinceSnapshot = [];
    this.matchSeat.clear();
    this.clients.forEach((c, i) => this.matchSeat.set(c.id, i as PlayerIndex));
    this.logger.info('match started', {
      roomId: this.id,
      seed,
      preset: this.preset,
      tickMs: this.tickMs,
      players: this.clients.map((c) => c.name),
    });
    this.clients.forEach((c, i) => {
      send(c, {
        type: 'matchStart',
        seed,
        playerIndex: i as PlayerIndex,
        preset: this.preset,
        tickRate: this.tickRate,
        tickMs: this.tickMs,
      });
    });
    // Tick-0 baseline snapshot so clients can render immediately.
    this.broadcastSnapshot();
    this.startMatchLoop();
    this.onRoomsChanged();
  }

  /**
   * Drift-compensated tick loop: each tick is scheduled against an absolute
   * target time, so fractional tickMs (33.33) and event-loop stalls do not
   * accumulate error the way a raw setInterval would.
   */
  private startMatchLoop(): void {
    let target = performance.now() + this.tickMs;
    const loop = (): void => {
      this.runTick();
      if (this.tickTimer === null) return; // match ended inside runTick
      const now = performance.now();
      target += this.tickMs;
      if (target < now - 1000) target = now; // suspended >1s: skip, don't burst
      this.tickTimer = setTimeout(loop, Math.max(0, target - now));
    };
    this.tickTimer = setTimeout(loop, this.tickMs);
  }

  private runTick(): void {
    const sim = this.sim;
    if (!sim) return;
    const events = sim.tick(this.inputs, this.pendingCommands);
    this.pendingCommands = [];
    this.logger.debug('tick', {
      roomId: this.id,
      tick: sim.state.tick,
      units: sim.state.units.length,
      projectiles: sim.state.projectiles.length,
      credits: [Math.floor(sim.state.players[0].credits), Math.floor(sim.state.players[1].credits)],
      phase: sim.state.phase,
    });
    if (events.length > 0) {
      this.eventsSinceSnapshot.push(...events);
      this.logSimEvents(events, sim.state.tick);
    }
    const end = events.find(
      (e): e is Extract<SimEvent, { type: 'matchEnd' }> => e.type === 'matchEnd'
    );
    if (end) {
      // Final snapshot carries the matchEnd sim event, then the protocol-level
      // matchEnd message ends the match.
      this.broadcastSnapshot();
      this.finishMatch(end.winner, 'core');
      return;
    }
    if (sim.state.tick % SNAPSHOT_EVERY_TICKS === 0) this.broadcastSnapshot();
  }

  private finishMatch(winner: PlayerIndex, reason: MatchEndReason): void {
    const sim = this.sim;
    if (!sim) return;
    this.stopMatchLoop();
    const durationTicks = sim.state.tick;
    const stats: [PlayerStats, PlayerStats] = [
      { ...sim.state.players[0].stats },
      { ...sim.state.players[1].stats },
    ];
    this.sim = null;
    this.matchSeat.clear();
    this.status = 'waiting';
    for (const c of this.clients) this.readyFlags.set(c.id, false);
    this.logger.info('match ended', { roomId: this.id, winner, reason, durationTicks });
    this.broadcast({ type: 'matchEnd', winner, reason, durationTicks, stats });
    this.broadcastRoomState();
    this.onRoomsChanged();
  }

  private stopMatchLoop(): void {
    if (this.tickTimer !== null) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private clearCountdownTimer(): void {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // In-match client messages (already protocol-validated; the sim re-validates
  // build commands — affordability, queue and unit caps — every tick)
  // -------------------------------------------------------------------------

  handleInput(client: ClientConn, input: PlayerInput): void {
    if (this.status !== 'playing') return;
    const seat = this.matchSeat.get(client.id);
    if (seat === undefined) return;
    this.inputs[seat] = input;
  }

  /** Returns an error string when the build cannot even be queued. */
  handleBuild(client: ClientConn, unit: UnitType): string | null {
    if (this.status !== 'playing' || this.sim === null) return 'no match in progress';
    const seat = this.matchSeat.get(client.id);
    if (seat === undefined) return 'not a player in this match';
    // Flood guard: more pending commands than the build queue can ever accept
    // in one tick is abuse, not gameplay.
    let pendingForSeat = 0;
    for (const cmd of this.pendingCommands) {
      if (cmd.player === seat) pendingForSeat++;
    }
    if (pendingForSeat >= 8) return 'too many build commands this tick';
    this.pendingCommands.push({ type: 'build', player: seat, unit });
    return null;
  }

  // -------------------------------------------------------------------------
  // Wire helpers
  // -------------------------------------------------------------------------

  summary(): RoomSummary {
    return {
      id: this.id,
      name: this.name,
      host: this.clients[0]?.name ?? '?',
      playerCount: this.clients.length,
      maxPlayers: MAX_PLAYERS,
      status: this.status,
    };
  }

  infoFor(client: ClientConn): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      preset: this.preset,
      status: this.status,
      players: this.clients.map((c) => ({
        name: c.name ?? 'anonymous',
        ready: this.readyFlags.get(c.id) === true,
      })),
      youIndex: this.clients.indexOf(client),
    };
  }

  broadcastRoomState(): void {
    for (const c of this.clients) send(c, { type: 'roomState', room: this.infoFor(c) });
  }

  private broadcast(msg: ServerMessage): void {
    for (const c of this.clients) send(c, msg);
  }

  private broadcastSnapshot(): void {
    const sim = this.sim;
    if (!sim) return;
    const events = this.eventsSinceSnapshot;
    this.eventsSinceSnapshot = [];
    const msg: ServerMessage = { type: 'snapshot', snap: sim.snapshot(), events };
    for (const c of this.clients) {
      // Backpressure: a stalled-but-open socket should not buffer snapshots
      // without bound. Skipped snapshots are fine — the next one supersedes
      // them — except when they carry events, which must not be lost.
      if (events.length === 0 && c.ws.bufferedAmount > 256 * 1024) continue;
      send(c, msg);
    }
  }

  /** Full inspection dump for GET /debug/state. */
  debugInfo(): Record<string, unknown> {
    const sim = this.sim;
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      preset: this.preset,
      players: this.clients.map((c) => ({
        id: c.id,
        name: c.name,
        ready: this.readyFlags.get(c.id) === true,
      })),
      tick: sim ? sim.state.tick : null,
      phase: sim ? sim.state.phase : null,
      economy: sim
        ? sim.state.players.map((p) => ({
            credits: Math.floor(p.credits),
            queue: p.queue.map((q) => q.unit),
            stats: { ...p.stats },
          }))
        : null,
      snapshot: sim ? sim.snapshot() : null,
    };
  }

  /** Stop all timers; called when the room is deleted or the server closes. */
  dispose(): void {
    this.stopMatchLoop();
    this.clearCountdownTimer();
    this.sim = null;
  }

  private logSimEvents(events: SimEvent[], tick: number): void {
    for (const e of events) {
      switch (e.type) {
        case 'matchEnd':
          this.logger.info('base captured — match end', {
            roomId: this.id,
            tick,
            winner: e.winner,
            byUnitId: e.byUnitId,
          });
          break;
        case 'turretCaptured':
          this.logger.info('turret captured', {
            roomId: this.id,
            tick,
            turretId: e.turretId,
            player: e.player,
          });
          break;
        case 'turretNeutralized':
          this.logger.info('turret neutralized', {
            roomId: this.id,
            tick,
            turretId: e.turretId,
            byPlayer: e.byPlayer,
          });
          break;
        case 'turretDestroyed':
          this.logger.info('turret destroyed', {
            roomId: this.id,
            tick,
            turretId: e.turretId,
            byPlayer: e.byPlayer,
          });
          break;
        case 'unitDeployed':
          this.logger.info('unit built', {
            roomId: this.id,
            tick,
            player: e.player,
            unit: e.unit,
            unitId: e.unitId,
          });
          break;
        case 'buildRejected':
          this.logger.info('build rejected by simulation', {
            roomId: this.id,
            tick,
            player: e.player,
            unit: e.unit,
            reason: e.reason,
          });
          break;
        case 'mechKilled':
          this.logger.info('mech killed', {
            roomId: this.id,
            tick,
            victim: e.victim,
            byPlayer: e.byPlayer,
          });
          break;
        default:
          this.logger.debug('sim event', { roomId: this.id, tick, event: e });
          break;
      }
    }
  }
}

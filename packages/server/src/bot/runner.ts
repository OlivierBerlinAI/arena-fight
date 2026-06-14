/**
 * Bot connection runner — the actual opponent-AI logic, decoupled from the
 * worker thread so it can also run in-process (tests). Connects to the server
 * like a normal player (hello → join the room → ready), then drives its mech and
 * builds units via the reactive policy in ./ai. Returns a `stop()` handle.
 */
import { WebSocket } from 'ws';
import { getBalance } from '@mech-arena-fight/shared';
import type {
  Balance,
  BotDifficulty,
  ClientMessage,
  PlayerIndex,
  ServerMessage,
  Snapshot,
} from '@mech-arena-fight/shared';
import { BOT_TUNING, chooseBuild, chooseInput } from './ai.js';

export interface BotConfig {
  url: string;
  roomId: string;
  name: string;
  difficulty: BotDifficulty;
}

/** Start a bot. Calls `onDone` once it has finished (match over / disconnected). */
export function runBot(cfg: BotConfig, onDone: () => void = () => {}): () => void {
  const tuning = BOT_TUNING[cfg.difficulty];
  const ws = new WebSocket(cfg.url);

  let me: PlayerIndex = 1;
  let balance: Balance | null = null;
  let snap: Snapshot | null = null;
  let joined = false;
  let readied = false;
  let decideTimer: ReturnType<typeof setInterval> | null = null;
  let buildTimer: ReturnType<typeof setInterval> | null = null;
  let done = false;

  const send = (msg: ClientMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const cleanup = (): void => {
    if (done) return;
    done = true;
    if (decideTimer) clearInterval(decideTimer);
    if (buildTimer) clearInterval(buildTimer);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    onDone();
  };

  const startPlaying = (): void => {
    if (decideTimer) return;
    decideTimer = setInterval(() => {
      if (snap && balance) send({ type: 'input', ...chooseInput(snap, me, balance, tuning) });
    }, tuning.decideEveryMs);
    buildTimer = setInterval(() => {
      if (!snap || !balance) return;
      const unit = chooseBuild(snap, me, balance);
      if (unit) send({ type: 'build', unit });
    }, tuning.buildEveryMs);
  };

  ws.on('open', () => send({ type: 'hello', name: cfg.name }));
  ws.on('close', () => cleanup());
  ws.on('error', () => cleanup());
  ws.on('message', (data: Buffer) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data.toString()) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'lobbyState':
        if (!joined) {
          joined = true;
          send({ type: 'joinRoom', roomId: cfg.roomId });
        }
        break;
      case 'roomState':
        if (!readied) {
          readied = true;
          send({ type: 'ready', ready: true });
        } else if (msg.room.players.length < 2 && msg.room.status !== 'playing') {
          cleanup(); // the human left the waiting room
        }
        break;
      case 'matchStart':
        me = msg.playerIndex;
        balance = getBalance(msg.preset, msg.tickRate);
        startPlaying();
        break;
      case 'snapshot':
        snap = msg.snap;
        break;
      case 'matchEnd':
      case 'error':
        cleanup();
        break;
      default:
        break;
    }
  });

  return cleanup;
}

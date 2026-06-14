/**
 * startServer(): one HTTP server + one WebSocketServer on the same port.
 *
 * HTTP routes:
 *   GET /health       → "ok"
 *   GET /debug/state  → JSON dump of all rooms (players, tick, phase, latest
 *                       snapshot, economy) and the lobby client count.
 *
 * Env overrides (opts always win): PORT, TICK_MS (wall-clock pacing only),
 * LOG_LEVEL, BALANCE_PRESET (forces every room to that preset).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { DEFAULT_TICK_MS, isBalancePresetName } from '@precinct/shared';
import type { BalancePresetName } from '@precinct/shared';
import { attachConnection } from './connection';
import { LobbyManager } from './lobby';
import { createLogger, logLevelFromEnv } from './logger';
import type { Logger, LogLevel } from './logger';

export interface StartServerOptions {
  /** listen port; 0 = ephemeral (tests). Default: PORT env or 8080. */
  port?: number;
  /** wall-clock ms per simulation tick — pacing only. Default: TICK_MS env or ~33.3. */
  tickMs?: number;
  /** Default: LOG_LEVEL env or 'info'. */
  logLevel?: LogLevel;
  /** force every room to this preset. Default: BALANCE_PRESET env, else per-room. */
  balancePreset?: BalancePresetName;
  /** wall-clock ms per countdown second (tests shrink this). Default 1000. */
  countdownSecondMs?: number;
  /** max concurrent WebSocket connections; 0 = unlimited. Default: MAX_CONNECTIONS env or 0. */
  maxConnections?: number;
  /** expose GET /debug/state. Default: DEBUG_STATE env (default true). */
  debugState?: boolean;
}

export interface RunningServer {
  port: number;
  lobby: LobbyManager;
  logger: Logger;
  close(): Promise<void>;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function envBool(name: string, dflt: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const v = raw.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envPreset(logger: Logger): BalancePresetName | undefined {
  const raw = process.env.BALANCE_PRESET;
  if (raw === undefined || raw === '') return undefined;
  if (isBalancePresetName(raw)) return raw;
  logger.warn('ignoring invalid BALANCE_PRESET', { value: raw });
  return undefined;
}

export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const logger = createLogger(opts.logLevel ?? logLevelFromEnv());
  const tickMs = opts.tickMs ?? envNumber('TICK_MS') ?? DEFAULT_TICK_MS;
  const forcedPreset = opts.balancePreset ?? envPreset(logger);
  const debugStateEnabled = opts.debugState ?? envBool('DEBUG_STATE', true);
  const maxConnections = opts.maxConnections ?? envNumber('MAX_CONNECTIONS') ?? 0;
  const lobby = new LobbyManager({
    logger,
    tickMs,
    countdownSecondMs: opts.countdownSecondMs ?? 1000,
    forcedPreset,
  });

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && path === '/debug/state') {
      if (!debugStateEnabled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(lobby.debugState()));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  // maxPayload caps frames at the ws layer before our 4 KiB app-level check,
  // so an oversized frame can never be buffered into memory first.
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 });
  wss.on('connection', (ws) => {
    if (maxConnections > 0 && wss.clients.size > maxConnections) {
      ws.close(1013, 'server at capacity');
      return;
    }
    const live = ws as WebSocket & { isAlive: boolean };
    live.isAlive = true;
    ws.on('pong', () => {
      live.isAlive = true;
    });
    attachConnection(lobby, ws);
  });

  // Heartbeat: terminate sockets that stop answering pings, so dead/half-open
  // connections don't pile up on an internet-facing server.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const live = ws as WebSocket & { isAlive?: boolean };
      if (live.isAlive === false) {
        ws.terminate();
        continue;
      }
      if (ws.readyState !== WebSocket.OPEN) continue;
      live.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  const requestedPort = opts.port ?? envNumber('PORT') ?? 8080;
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  const port = (httpServer.address() as AddressInfo).port;
  logger.info('server listening', {
    port,
    tickMs,
    forcedPreset: forcedPreset ?? null,
    debugState: debugStateEnabled,
    maxConnections,
  });

  let closed = false;
  return {
    port,
    lobby,
    logger,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      lobby.closeAll();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      logger.info('server closed', { port });
    },
  };
}

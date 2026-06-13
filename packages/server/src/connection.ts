/**
 * Per-socket message pump. Every inbound frame is run through the shared
 * parseClientMessage() validator; invalid frames produce an `error` reply and
 * a structured log line — they never crash the server. A client must send a
 * valid `hello` before any other message is routed.
 */
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { parseClientMessage } from '@precinct/shared';
import type { ServerMessage } from '@precinct/shared';
import type { LobbyManager } from './lobby';

export interface ClientConn {
  id: string;
  ws: WebSocket;
  /** display name; null until a valid hello has been received */
  name: string | null;
  /** id of the room the client is currently in, if any */
  roomId: string | null;
}

/** Serialize and send a server message; silently drops if the socket is gone. */
export function send(client: ClientConn, msg: ServerMessage): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(msg));
  }
}

/** Drop a connection that never sends a valid hello (it just holds a socket). */
const HELLO_TIMEOUT_MS = 15_000;

export function attachConnection(lobby: LobbyManager, ws: WebSocket): void {
  const client = lobby.register(ws);

  const helloTimer = setTimeout(() => {
    if (client.name === null) {
      lobby.logger.warn('hello timeout — closing idle connection', { clientId: client.id });
      ws.close(1008, 'hello required');
    }
  }, HELLO_TIMEOUT_MS);
  if (typeof helloTimer.unref === 'function') helloTimer.unref();

  ws.on('message', (data: RawData, isBinary: boolean) => {
    // parseClientMessage rejects anything that is not a JSON text frame.
    const raw: unknown = isBinary ? data : data.toString();
    const result = parseClientMessage(raw);
    if (!result.ok) {
      lobby.logger.warn('rejected client message', {
        clientId: client.id,
        name: client.name,
        reason: result.error,
      });
      send(client, { type: 'error', code: 'badMessage', message: result.error });
      return;
    }
    const msg = result.msg;
    // Pings are harmless liveness traffic — allowed even before hello.
    if (client.name === null && msg.type !== 'hello' && msg.type !== 'ping') {
      lobby.logger.warn('rejected client message', {
        clientId: client.id,
        reason: 'hello required before other messages',
        msgType: msg.type,
      });
      send(client, { type: 'error', code: 'helloRequired', message: 'send hello first' });
      return;
    }
    try {
      const hadName = client.name !== null;
      lobby.handleMessage(client, msg);
      if (!hadName && client.name !== null) clearTimeout(helloTimer);
    } catch (err) {
      // Defensive: a handler bug must never take the process down.
      lobby.logger.error('message handler error', {
        clientId: client.id,
        msgType: msg.type,
        error: err instanceof Error ? err.message : String(err),
      });
      send(client, { type: 'error', code: 'internal', message: 'internal server error' });
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    lobby.handleDisconnect(client);
  });
  ws.on('error', (err: Error) => {
    lobby.logger.warn('socket error', { clientId: client.id, error: err.message });
  });
}

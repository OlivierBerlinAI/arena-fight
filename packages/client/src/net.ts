/**
 * Typed WebSocket wrapper. Sends ClientMessage, receives ServerMessage,
 * pings every 2 s to measure RTT, and logs every protocol error message.
 */
import type { ClientMessage, ServerMessage } from '@precinct/shared';

const PING_INTERVAL_MS = 2000;

/** ws://host:8080 by default; override with ?server=host:port. */
export function serverUrl(): string {
  const params = new URLSearchParams(location.search);
  const override = params.get('server');
  if (override) return /^wss?:\/\//i.test(override) ? override : `ws://${override}`;
  // Vite dev server (npm run dev) talks directly to the standalone server.
  if (location.port === '5273') return `ws://${location.hostname || 'localhost'}:8080`;
  // Production / containerized: same-origin, reverse-proxied under /ws — wss
  // when the page itself was served over TLS by the front nginx.
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

export function isTestMode(): boolean {
  return new URLSearchParams(location.search).get('test') === '1';
}

export class Net {
  private socket: WebSocket | null = null;
  private pingTimer: number | null = null;
  private closed = false;

  /** latest measured round-trip time in ms, null before the first pong */
  rtt: number | null = null;

  onOpen: (() => void) | null = null;
  onMessage: ((msg: ServerMessage) => void) | null = null;
  /** fired once when the connection drops or fails */
  onClose: ((reason: string) => void) | null = null;
  onRtt: ((rtt: number) => void) | null = null;

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  connect(url: string): void {
    this.dispose();
    this.closed = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.error('[net] failed to open socket', err);
      this.emitClose('Could not open a connection to the server.');
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      // onOpen sends hello; pings must not reach the server before it.
      this.onOpen?.();
      this.pingTimer = window.setInterval(() => this.sendPing(), PING_INTERVAL_MS);
      this.sendPing();
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        console.error('[net] non-JSON frame from server', ev.data);
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
        console.error('[net] malformed server message', parsed);
        return;
      }
      const msg = parsed as ServerMessage;
      if (msg.type === 'pong') {
        this.rtt = Math.max(0, Math.round(performance.now() - msg.t));
        this.onRtt?.(this.rtt);
        return;
      }
      if (msg.type === 'error') {
        console.error(`[server error] ${msg.code}: ${msg.message}`);
      }
      this.onMessage?.(msg);
    };

    socket.onclose = () => {
      this.emitClose('Connection to the server was lost.');
    };
    socket.onerror = () => {
      // onclose always follows; nothing extra to do here.
    };
  }

  send(msg: ClientMessage): void {
    if (!this.connected) return;
    this.socket?.send(JSON.stringify(msg));
  }

  private sendPing(): void {
    this.send({ type: 'ping', t: performance.now() });
  }

  private emitClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    const cb = this.onClose;
    this.socket = null;
    cb?.(reason);
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Tear down without firing onClose (used before reconnecting). */
  dispose(): void {
    this.closed = true;
    this.clearTimers();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.onopen = null;
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }
}

/**
 * Cloudflare Worker + Durable Object Signal Relay
 * Implements AGENTS.md §1 & §7:
 * "Signal relay (CF Worker + DO rooms) carries when; pull() carries what; epoch-guarded"
 * Zero customer data, zero PII, minimal WebSocket signaling payload.
 *
 * Patches applied (v1.7.0):
 * - F-11: 25-second server-side keepalive ping to prevent Cloudflare 30s idle disconnect.
 * - F-12: 10 msgs/sec sliding-window rate limit per session to prevent thundering herd.
 */

export interface Env {
  MERCHANT_ROOM: DurableObjectNamespace;
}

export interface SignalMessage {
  type: 'db:changed' | 'log_appended' | 'ping' | 'pong';
  epoch: number;
  deviceId: string;
  table?: string;
  maxHlc?: string;
  server_ts?: number;
}

export class MerchantRoom {
  state: DurableObjectState;
  sessions: Set<WebSocket>;
  currentEpoch: number;
  rateLimits: Map<WebSocket, number[]>;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sessions = new Set();
    this.currentEpoch = 1;
    this.rateLimits = new Map();
  }

  private ensureHeartbeat() {
    if (this.pingInterval || this.sessions.size === 0) return;
    // F-11: 25s keepalive ping interval (Cloudflare drops idle sockets after 30s)
    this.pingInterval = setInterval(() => {
      if (this.sessions.size === 0) {
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        return;
      }
      const pingMsg = JSON.stringify({ type: 'ping', server_ts: Date.now() });
      for (const session of Array.from(this.sessions)) {
        try {
          session.send(pingMsg);
        } catch {
          this.sessions.delete(session);
          this.rateLimits.delete(session);
        }
      }
    }, 25_000);
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();
    this.sessions.add(server);
    this.ensureHeartbeat();

    server.addEventListener('message', (event: MessageEvent) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : '';
        if (!raw) return;

        const msg = JSON.parse(raw) as SignalMessage;

        if (msg.type === 'ping') {
          server.send(JSON.stringify({ type: 'pong', epoch: this.currentEpoch, server_ts: Date.now() }));
          return;
        }

        if (msg.type === 'db:changed' || msg.type === 'log_appended') {
          // F-12: Rate limiting - 10 broadcasts/sec max per session (sliding window)
          const now = Date.now();
          let timestamps = this.rateLimits.get(server);
          if (!timestamps) {
            timestamps = [];
            this.rateLimits.set(server, timestamps);
          }
          // Retain events in the last 1000ms window
          timestamps = timestamps.filter((t) => now - t < 1000);
          if (timestamps.length >= 10) {
            // Exceeded rate limit: silently drop excess broadcast
            return;
          }
          timestamps.push(now);
          this.rateLimits.set(server, timestamps);

          // Increment epoch counter
          this.currentEpoch = Math.max(this.currentEpoch + 1, (msg.epoch || 0) + 1);

          const outbound = JSON.stringify({
            type: msg.type,
            epoch: this.currentEpoch,
            deviceId: msg.deviceId,
            table: msg.table,
            maxHlc: msg.maxHlc,
          });

          // Broadcast to all other devices in the merchant room
          for (const session of this.sessions) {
            if (session !== server) {
              try {
                session.send(outbound);
              } catch {
                this.sessions.delete(session);
                this.rateLimits.delete(session);
              }
            }
          }
        }
      } catch {
        // Ignore malformed signals
      }
    });

    const closeHandler = () => {
      this.sessions.delete(server);
      this.rateLimits.delete(server);
      if (this.sessions.size === 0 && this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
    };

    server.addEventListener('close', closeHandler);
    server.addEventListener('error', closeHandler);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route: /room/:merchantId
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'room' && parts[1]) {
      const merchantId = parts[1];
      const id = env.MERCHANT_ROOM.idFromName(merchantId);
      const room = env.MERCHANT_ROOM.get(id);
      return room.fetch(request);
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', time: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('MobiPOS Signal Relay - WebSocket required at /room/:merchantId', {
      status: 404,
    });
  },
};

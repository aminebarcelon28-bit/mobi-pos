/**
 * Cloudflare Worker + Durable Object Signal Relay
 * Implements AGENTS.md §1 & §7:
 * "Signal relay (CF Worker + DO rooms) carries when; pull() carries what; epoch-guarded"
 * Zero customer data, zero PII, minimal WebSocket signaling payload.
 */

export interface Env {
  MERCHANT_ROOM: DurableObjectNamespace;
}

export interface SignalMessage {
  type: 'db:changed' | 'ping' | 'pong';
  epoch: number;
  deviceId: string;
  table?: string;
}

export class MerchantRoom {
  state: DurableObjectState;
  sessions: Set<WebSocket>;
  currentEpoch: number;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sessions = new Set();
    this.currentEpoch = 1;
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

    server.addEventListener('message', (event: MessageEvent) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : '';
        if (!raw) return;

        const msg = JSON.parse(raw) as SignalMessage;

        if (msg.type === 'ping') {
          server.send(JSON.stringify({ type: 'pong', epoch: this.currentEpoch }));
          return;
        }

        if (msg.type === 'db:changed') {
          // Increment epoch counter
          this.currentEpoch = Math.max(this.currentEpoch + 1, (msg.epoch || 0) + 1);

          const outbound = JSON.stringify({
            type: 'db:changed',
            epoch: this.currentEpoch,
            deviceId: msg.deviceId,
            table: msg.table,
          });

          // Broadcast to all other devices in the merchant room
          for (const session of this.sessions) {
            if (session !== server) {
              try {
                session.send(outbound);
              } catch {
                this.sessions.delete(session);
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

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
  /**
   * B-042: shared secret required on device registry routes
   * (GET /room/:m/devices, POST /room/:m/devices/:d/revoke).
   * Set via `wrangler secret put ADMIN_SECRET`. Empty string = routes disabled.
   */
  ADMIN_SECRET?: string;
}

export interface SignalMessage {
  type: 'db:changed' | 'log_appended' | 'ping' | 'pong' | 'hello' | 'welcome' | 'device-revoked';
  epoch: number;
  deviceId: string;
  table?: string;
  maxHlc?: string;
  server_ts?: number;
  deviceName?: string;
  platform?: string;
  revoked?: boolean;
}

export interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  platform: string;
  firstSeen: number;
  lastSeen: number;
  revoked: boolean;
  revokedAt?: number;
}

export class MerchantRoom {
  state: DurableObjectState;
  sessions: Set<WebSocket>;
  // Socket -> claimed stable device id (set on 'hello').
  sessionDevices: Map<WebSocket, string>;
  currentEpoch: number;
  rateLimits: Map<WebSocket, number[]>;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  // Burst coalescing: over-limit broadcasts collapse into ONE trailing
  // generic signal instead of being silently dropped (a post-reconnect
  // flush can legitimately burst past 10/sec; dropping it only widens the
  // stale-stock oversell window until the next poll).
  private coalescedFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sessions = new Set();
    this.sessionDevices = new Map();
    this.currentEpoch = 1;
    this.rateLimits = new Map();
  }

  private async readDevices(): Promise<Record<string, DeviceRecord>> {
    try {
      return (await this.state.storage.get<Record<string, DeviceRecord>>('devices')) ?? {};
    } catch {
      return {};
    }
  }

  private async writeDevices(devices: Record<string, DeviceRecord>): Promise<void> {
    try {
      await this.state.storage.put('devices', devices);
    } catch {
      // Best-effort registry — signaling must never break over storage.
    }
  }

  private closeSession(session: WebSocket) {
    this.sessions.delete(session);
    this.sessionDevices.delete(session);
    this.rateLimits.delete(session);
    try { session.close(4000, 'device-revoked'); } catch { /* already closed */ }
  }

  /** Flush one coalesced catch-all signal for broadcasts collapsed above. */
  private flushCoalescedBroadcast() {
    this.coalescedFlushTimer = null;
    if (this.sessions.size === 0) return;
    this.currentEpoch += 1;
    // Table-less by design: every client treats any foreign db:changed as a
    // pull trigger, so one generic signal converges all collapsed tables.
    const outbound = JSON.stringify({
      type: 'db:changed',
      epoch: this.currentEpoch,
      deviceId: 'relay-coalesced',
    });
    for (const session of Array.from(this.sessions)) {
      try {
        session.send(outbound);
      } catch {
        this.forgetSession(session);
      }
    }
  }

  private scheduleCoalescedFlush() {
    if (this.coalescedFlushTimer) return;
    this.coalescedFlushTimer = setTimeout(() => this.flushCoalescedBroadcast(), 1200);
  }

  /** B-054: single forget path — send failures must drop all three maps. */
  private forgetSession(session: WebSocket) {
    this.sessions.delete(session);
    this.sessionDevices.delete(session);
    this.rateLimits.delete(session);
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
          this.forgetSession(session);
        }
      }
    }, 25_000);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Internal registry routes (rewritten by the top-level fetch above).
    if (url.pathname === '/__devices' && request.method === 'GET') {
      const devices = await this.readDevices();
      const list = Object.values(devices)
        .map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, platform: d.platform, firstSeen: d.firstSeen, lastSeen: d.lastSeen, revoked: d.revoked }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
      return new Response(JSON.stringify({ devices: list }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/__revoke' && request.method === 'POST') {
      const target = (url.searchParams.get('deviceId') || '').slice(0, 128);
      const revoked = url.searchParams.get('revoked') !== 'false';
      if (!target) return new Response('Missing deviceId', { status: 400 });
      const devices = await this.readDevices();
      const now = Date.now();
      const prev = devices[target];
      devices[target] = {
        deviceId: target,
        deviceName: prev?.deviceName ?? 'Appareil',
        platform: prev?.platform ?? 'unknown',
        firstSeen: prev?.firstSeen ?? now,
        lastSeen: prev?.lastSeen ?? now,
        revoked,
        ...(revoked ? { revokedAt: now } : {}),
      };
      await this.writeDevices(devices);
      // Kick live sockets of the (un)revoked device and tell peers.
      for (const [session, deviceId] of Array.from(this.sessionDevices)) {
        if (deviceId === target) {
          try {
            session.send(JSON.stringify({ type: 'device-revoked', epoch: this.currentEpoch, deviceId: target, revoked }));
          } catch { /* ignore */ }
          if (revoked) this.closeSession(session);
        }
      }
      if (!revoked) {
        const outbound = JSON.stringify({ type: 'device-revoked', epoch: this.currentEpoch, deviceId: target, revoked: false });
        for (const session of this.sessions) {
          try { session.send(outbound); } catch { /* ignore */ }
        }
      }
      return new Response(JSON.stringify({ deviceId: target, revoked }), { headers: { 'Content-Type': 'application/json' } });
    }

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

        // Device registration: every client identifies with its stable device
        // id on connect. Revoked devices are told immediately and dropped —
        // they receive no further signals from this room.
        if (msg.type === 'hello') {
          const deviceId = String(msg.deviceId || '').slice(0, 128);
          if (!deviceId) return;
          void (async () => {
            const devices = await this.readDevices();
            const now = Date.now();
            const existing = devices[deviceId];
            if (existing?.revoked) {
              try {
                server.send(JSON.stringify({ type: 'device-revoked', epoch: this.currentEpoch, deviceId }));
              } catch { /* ignore */ }
              this.closeSession(server);
              return;
            }
            devices[deviceId] = {
              deviceId,
              deviceName: String(msg.deviceName || existing?.deviceName || 'Appareil').slice(0, 80),
              platform: String(msg.platform || existing?.platform || 'unknown').slice(0, 32),
              firstSeen: existing?.firstSeen ?? now,
              lastSeen: now,
              revoked: false,
            };
            await this.writeDevices(devices);
            this.sessionDevices.set(server, deviceId);
            try {
              server.send(JSON.stringify({ type: 'welcome', epoch: this.currentEpoch, deviceId, server_ts: now }));
            } catch { /* ignore */ }
          })();
          return;
        }

        // Drop anything from sessions whose device has since been revoked.
        const senderDevice = this.sessionDevices.get(server);
        if (senderDevice) {
          void this.readDevices().then((devices) => {
            if (devices[senderDevice]?.revoked) this.closeSession(server);
          });
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
            // Over rate limit: collapse into ONE trailing generic signal
            // (see scheduleCoalescedFlush) instead of silently dropping —
            // a dropped burst is a widened stale-stock oversell window.
            this.scheduleCoalescedFlush();
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
                this.forgetSession(session);
              }
            }
          }
        }
      } catch {
        // Ignore malformed signals
      }
    });

    const closeHandler = () => {
      this.forgetSession(server);
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

      // Device registry (B-042: admin secret required — any room holder must
      // NOT be able to list/revoke devices):
      //   GET  /room/:m/devices              -> [{deviceId, ...}]   (Authorization: Bearer ADMIN_SECRET)
      //   POST /room/:m/devices/:d/revoke    -> {revoked: ...}      (same)
      // Revoking kicks the device's live sockets and broadcasts
      // `device-revoked` so peers update their device lists.
      if (parts[2] === 'devices' && request.headers.get('Upgrade') !== 'websocket') {
        const adminSecret = env.ADMIN_SECRET ?? '';
        if (!adminSecret) {
          return new Response(JSON.stringify({ error: 'admin routes disabled' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const auth = request.headers.get('Authorization') || '';
        const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
        if (presented !== adminSecret) {
          return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (request.method === 'GET' && parts.length === 3) {
          return room.fetch(new Request(new URL('/__devices', request.url), { method: 'GET' }));
        }
        if ((request.method === 'POST' || request.method === 'PUT') && parts.length === 5 && parts[4] === 'revoke') {
          const target = new URL('/__revoke', request.url);
          target.searchParams.set('deviceId', parts[3]);
          const body = await request.text().catch(() => '');
          target.searchParams.set('revoked', body.includes('false') ? 'false' : 'true');
          return room.fetch(new Request(target, { method: 'POST' }));
        }
        return new Response('Not found', { status: 404 });
      }

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

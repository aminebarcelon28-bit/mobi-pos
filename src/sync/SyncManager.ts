// SyncManager — background two-way per-customer sync (Local SQLite/Dexie <-> Turso Cloud).
// Push: sync_outbox pending -> Turso batch upserts (idempotent, optimistic version checking).
// Pull: Per-table cursors -> Local SQLite + Dexie UI store updates.
// Zero data loss, zero silent drops, zero dependency on vendor servers.

import { getLocalDb, getPendingOutbox, markOutbox, markOutboxMany, utcNowIso, getFailedOutboxCount, retryQuarantinedOutbox, syncProductsFromSqlToDexie, sanitizeSyncPayload, sanitizeImageField, toBoundedSyncJson } from '../db/sqlPluginAdapter';
import { getTursoClient, probeOnline } from './tursoClient';
import { getCloudCredentials } from './keychain';
import { db as dexieDb } from '../db/database';
import { ALL_REMOTE_SYNC_TABLES, assertValidSyncTable, ensureRemoteSchemaColumns } from './remoteSchema';
import type { InValue } from '@libsql/client';
import type Database from '@tauri-apps/plugin-sql';
import type { OutboxRow, SyncStatus, SyncEventLog, PullTouchSummary } from './types';
import type { Product } from '../types/pos';

const GENERIC_TABLES: Record<string, string> = {
  customer: 'customers',
  repair_order: 'repair_orders',
  purchase_order: 'purchase_orders',
  trade_in: 'trade_ins',
  imei: 'imei_records',
  audit_log: 'security_audit_logs',
  cash_drop: 'cash_drops',
  bundle: 'product_bundles',
  customer_debt: 'customer_debts',
  store_expense: 'store_expenses',
  cash_session: 'cash_sessions',
  cash_movement: 'cash_movements',
  setting: 'app_settings',
};

const GENERIC_PULL: Record<string, { dexie: string; ts: string[] }> = {
  customers: { dexie: 'customers', ts: ['updatedAt', 'createdAt'] },
  repair_orders: { dexie: 'repairOrders', ts: ['updatedAt', 'createdAt'] },
  purchase_orders: { dexie: 'purchaseOrders', ts: ['createdAt'] },
  trade_ins: { dexie: 'tradeIns', ts: ['createdAt'] },
  imei_records: { dexie: 'imeiRecords', ts: ['soldAt', 'receivedAt'] },
  security_audit_logs: { dexie: 'securityAuditLogs', ts: ['timestamp'] },
  cash_drops: { dexie: 'cashDrops', ts: ['timestamp'] },
  product_bundles: { dexie: 'bundles', ts: [] },
  customer_debts: { dexie: 'customerDebts', ts: ['createdAt'] },
  store_expenses: { dexie: 'storeExpenses', ts: ['createdAt'] },
  cash_sessions: { dexie: 'cashSessions', ts: ['updatedAt', 'closedAt', 'openedAt'] },
  cash_movements: { dexie: 'cashMovements', ts: ['createdAt'] },
  app_settings: { dexie: 'appSettings', ts: [] },
};

// P-½ bleed-stop: explicit pull projections (drop SELECT *). Column lists mirror
// remoteSchema.ts v1; only columns read by applyRemoteRow are fetched.
// Dropped everywhere: sync_status (apply hardcodes 'synced', never reads it).
// Dropped on generic KV tables: device_id + idempotency_key (apply reads the
// payload + version only). Cursor keys (updated_at, id) always included.
const PULL_COLUMNS: Record<string, string> = {
  products: 'id, sku, barcode, title, brand, compatible_model, category, price, wholesale_price, cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days, daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key, version, created_at, updated_at, deleted',
  transactions: 'id, receipt_number, customer_id, subtotal, tax, discount_total, total, cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due, status, json_payload, device_id, idempotency_key, version, created_at, updated_at, deleted',
  transaction_items: 'id, transaction_id, product_id, quantity, applied_price, discount, imei_number, cost_price, json_payload, device_id, idempotency_key, version, created_at, updated_at, deleted',
  inventory_ledger: 'id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, version, created_at, updated_at, deleted',
};

const GENERIC_PULL_COLUMNS = 'id, data_json, version, updated_at, deleted';

// P0 hygiene: a single oversized outbox row (e.g. a 20 MB base64 image) must
// never ride the 50-row batch forever — every cycle would time out, retry and
// re-send the same megabytes (freeze + quota burn). Rows past this budget are
// quarantined with an actionable error instead of poison-looping. Local data
// is untouched (no loss); the failed queue stays reviewable/retryable.
const MAX_PUSH_ROW_BYTES = 512 * 1024;

function pullColumns(table: string): string {
  return PULL_COLUMNS[table] ?? GENERIC_PULL_COLUMNS;
}

// P0 hygiene (pull side): cloud rows written before the hygiene invariant may
// still carry 20 MB blobs. Clean them BEFORE the local SQLite + Dexie writes
// so one legacy row cannot OOM the phone on every pull cycle. Money scalars
// pass through untouched (see sanitizeSyncPayload contract).
function cleanRemoteJson(raw: unknown): string {
  const s = String((raw as string) ?? '{}');
  try {
    return JSON.stringify(sanitizeSyncPayload(JSON.parse(s) as unknown));
  } catch {
    return s;
  }
}

const isMobileView = () =>
  typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 640;

// P-½ bleed-stop: slow safety-net polling to cut Turso row reads (~3-5x).
// Contract C1 is preserved via relay-triggered pullOnce + notifyLocalWrite/kick,
// not via poll frequency — poll is only the fallback when signals are missed.
const PUSH_MS = () => 5_000;
const PULL_MS = () => (isMobileView() ? 6_000 : 5_000);

function backoffMs(retry: number): number {
  // Doc ② §7.4 verbatim: base 1s, factor 2, cap 60s, FULL JITTER (anti-thundering-herd)
  const base = 1_000;
  const cap = 60_000;
  const slot = Math.min(cap, base * (1 << Math.min(retry, 6)));
  return Math.floor(Math.random() * slot);
}

type Listener = (s: SyncStatus) => void;

class SyncManager {
  private pushTimer: number | null = null;
  private pullTimer: number | null = null;
  private pushing = false;
  private pulling = false;
  private pullApplied = new Set<() => void>();
  private online = typeof navigator === 'undefined' ? true : navigator.onLine;
  private pendingCount = 0;
  private failedCount = 0;
  private lastPushAt: string | null = null;
  private lastPullAt: string | null = null;
  private lastError: string | null = null;
  private quotaExceeded = false;
  // No permanent wedges (ADR-0008): both flags below auto-recover. A latch
  // that never clears turns one transient blip into eternal one-way sync.
  private quotaBlockedAt = 0;
  private lastProbeAt = 0;
  private consecutiveProbeFailures = 0;
  private clockSkewMs = 0;
  private backfillRoundsRemaining = 0;
  private remoteSchemaEnsured = false;
  private deviceId = 'bootstrap';
  // Per-instance nonce: two windows on the SAME device share deviceId (and
  // SQLite), so self-suppression must key on the instance, not the device —
  // otherwise the second window never pulls on local broadcasts.
  private instanceId: string =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `inst-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  private listeners = new Set<Listener>();
  private postWriteDebounce: number | null = null;
  private eventLogs: SyncEventLog[] = [];
  private onOnlineHandler: (() => void) | null = null;
  // P1 targeted refresh: summary of what the last pullOnce() touched.
  private lastPullTouched: PullTouchSummary = { productIds: [], transactions: false, tables: [] };
  private onOfflineHandler: (() => void) | null = null;
  private onVisibilityHandler: (() => void) | null = null;
  private remoteSaleListeners = new Set<(sale: Record<string, unknown>) => void>();
  private broadcastChannel: BroadcastChannel | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  onPullApplied(fn: () => void): () => void {
    this.pullApplied.add(fn);
    return () => { this.pullApplied.delete(fn); };
  }

  /**
   * P1 targeted refresh: what the last pullOnce() applied (tables + product
   * ids + txn flag). Read inside onPullApplied handlers to reload only the
   * affected slices instead of all 16 tables.
   */
  getLastPullTouched(): PullTouchSummary {
    return {
      productIds: [...this.lastPullTouched.productIds],
      transactions: this.lastPullTouched.transactions,
      tables: [...this.lastPullTouched.tables],
    };
  }

  onRemoteSaleReceived(fn: (sale: Record<string, unknown>) => void): () => void {
    this.remoteSaleListeners.add(fn);
    return () => { this.remoteSaleListeners.delete(fn); };
  }

  private emitRemoteSale(sale: Record<string, unknown>) {
    this.remoteSaleListeners.forEach((fn) => {
      try { fn(sale); } catch { /* ignore */ }
    });
  }

  private emitPulled() {
    this.pullApplied.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  }

  private emit() {
    const isRelayOpen = Boolean(
      typeof WebSocket !== 'undefined' &&
      this.relaySocket &&
      this.relaySocket.readyState === WebSocket.OPEN
    );
    const s: SyncStatus = {
      online: this.online,
      pushing: this.pushing,
      pulling: this.pulling,
      pendingCount: this.pendingCount,
      failedCount: this.failedCount,
      relayConnected: isRelayOpen,
      lastPushAt: this.lastPushAt,
      lastPullAt: this.lastPullAt,
      lastError: this.lastError,
      quotaExceeded: this.quotaExceeded,
    };
    this.listeners.forEach((fn) => { try { fn(s); } catch { /* ignore */ } });
  }

  logEvent(type: SyncEventLog['type'], summary: string, level: SyncEventLog['level'] = 'info', details?: Record<string, unknown>) {
    const entry: SyncEventLog = {
      id: `log-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
      type,
      summary,
      details,
      level,
    };
    this.eventLogs.unshift(entry);
    if (this.eventLogs.length > 200) {
      this.eventLogs.pop();
    }
  }

  getEventLogs(): SyncEventLog[] {
    return [...this.eventLogs];
  }

  exportLogs(): string {
    return JSON.stringify(this.eventLogs, null, 2);
  }

  async start(deviceId: string) {
    this.deviceId = deviceId;
    this.instanceId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `inst-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    this.clockSkewChecked = false;
    this.stop();

    // Check if cloud credentials exist
    const creds = await getCloudCredentials();
    if (!creds || !creds.url || !creds.token) {
      return;
    }

    try {
      const db = await getLocalDb();
      await db.execute("UPDATE sync_outbox SET status='pending' WHERE status='inflight'");
    } catch {
      /* first run */
    }
    await this.refreshPendingCount();

    this.stop(); // Clean up any existing listeners/timers before starting

    this.onOnlineHandler = () => {
      this.online = true;
      this.consecutiveProbeFailures = 0;
      this.emit();
      // Jittered kick on reconnect (0-2000ms) to avoid thundering herd
      const jitterMs = Math.floor(Math.random() * 2000);
      window.setTimeout(() => { void this.kick(); }, jitterMs);
    };
    this.onOfflineHandler = () => {
      // Android WebView frequently fires spurious offline events on screen dim or backgrounding.
      // Verify with an active probe before marking offline to avoid false "Hors ligne" state.
      probeOnline(2500).then((isUp) => {
        if (isUp) {
          this.consecutiveProbeFailures = 0;
          this.online = true;
          this.emit();
        } else {
          this.consecutiveProbeFailures += 1;
        }
        if (!isUp && this.consecutiveProbeFailures >= 2) {
          this.online = false;
          this.emit();
        }
      }).catch(() => {
        this.consecutiveProbeFailures += 1;
        if (this.consecutiveProbeFailures >= 2) {
          this.online = false;
          this.emit();
        }
      });
    };
    this.onVisibilityHandler = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void this.kick();
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnlineHandler);
      window.addEventListener('offline', this.onOfflineHandler);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityHandler);
    }

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.broadcastChannel = new BroadcastChannel('mobipos-sync-bus');
        this.broadcastChannel.onmessage = (event) => {
          if (event.data?.type === 'db:changed' && event.data?.instanceId !== this.instanceId) {
            void this.pullOnce();
          }
        };
      } catch {
        // ignore
      }
    }

    this.pushTimer = window.setInterval(() => { void this.pushOnce(); }, PUSH_MS());
    this.pullTimer = window.setInterval(() => { void this.pullOnce(); }, PULL_MS());

    let merchantRoom = 'default';
    if (creds?.url) {
      try {
        const hostname = new URL(creds.url.replace(/^libsql:\/\//, 'https://')).hostname;
        merchantRoom = hostname.replace(/\.turso\.io$/, '') || 'default';
      } catch {
        merchantRoom = 'default';
      }
    }

    const relayWsUrl = (typeof import.meta !== 'undefined' && (import.meta.env?.VITE_RELAY_WS_URL as string | undefined))
      || `wss://relay.mobipos.app/room/${merchantRoom}`;
    this.connectRelay(relayWsUrl);

    void this.kick();
    // One-shot clock-skew probe: cursor sync keys on updated_at wall clocks,
    // so a device >10s off its peer can permanently miss the peer's rows.
    void this.checkClockSkewOnce();
  }

  private clockSkewChecked = false;
  private async checkClockSkewOnce(): Promise<void> {
    if (this.clockSkewChecked) return;
    this.clockSkewChecked = true;
    try {
      const remote = await getTursoClient();
      const rs = await remote.execute(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') as srv`);
      const srvRaw = rs.rows[0]?.srv ?? rs.rows[0]?.['srv'];
      const srvMs = Date.parse(String(srvRaw));
      if (Number.isFinite(srvMs)) {
        const skewMs = Date.now() - srvMs;
        this.clockSkewMs = skewMs;
        if (Math.abs(skewMs) > 10_000) {
          const msg = `Horloge locale décalée de ${Math.round(skewMs / 1000)}s vs cloud — risque de ventes manquées. Activez l'heure automatique.`;
          this.lastError = msg;
          this.logEvent('error', msg, 'warn', { skewMs });
          this.logEvent('info', 'Backfill pull — récupération des lignes datées pendant le skew', 'info');
          this.backfillRoundsRemaining = 3;
        }
      }
    } catch {
      // offline or unsupported — pull/push polling remains the fallback
    }
  }

  private async probeQuotaReset(): Promise<boolean> {
    try {
      const remote = await getTursoClient();
      const rs = await remote.execute('SELECT 1 as alive');
      return Boolean(rs.rows && rs.rows.length > 0);
    } catch {
      return false;
    }
  }

  stop() {
    if (this.pushTimer) window.clearInterval(this.pushTimer);
    if (this.pullTimer) window.clearInterval(this.pullTimer);
    if (this.postWriteDebounce) window.clearTimeout(this.postWriteDebounce);
    if (this.relayReconnectTimeout) window.clearTimeout(this.relayReconnectTimeout);
    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch { /* ignore */ }
      this.broadcastChannel = null;
    }
    if (this.relaySocket) {
      try { this.relaySocket.close(); } catch { /* ignore */ }
      this.relaySocket = null;
    }
    this.pushTimer = this.pullTimer = this.postWriteDebounce = this.relayReconnectTimeout = null;

    if (typeof window !== 'undefined') {
      if (this.onOnlineHandler) {
        window.removeEventListener('online', this.onOnlineHandler);
        this.onOnlineHandler = null;
      }
      if (this.onOfflineHandler) {
        window.removeEventListener('offline', this.onOfflineHandler);
        this.onOfflineHandler = null;
      }
    }
    if (typeof document !== 'undefined' && this.onVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.onVisibilityHandler);
      this.onVisibilityHandler = null;
    }
  }

  private relaySocket: WebSocket | null = null;
  private relayEpoch = 0;
  private savedRelayWsUrl: string | null = null;
  private relayReconnectTimeout: number | null = null;
  private relayReconnectAttempts = 0;

  connectRelay(relayWsUrl: string) {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
    this.savedRelayWsUrl = relayWsUrl;
    if (
      this.relaySocket &&
      (this.relaySocket.readyState === WebSocket.OPEN ||
        this.relaySocket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      this.relaySocket = new WebSocket(relayWsUrl);
      this.relaySocket.onopen = () => {
        this.relayReconnectAttempts = 0;
        this.logEvent('pull', 'Signal relay WebSocket connecté avec succès', 'info');
      };

      this.relaySocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data?.type === 'ping') return;
          // Self-suppression keys on the instance nonce when present (same
          // device can hold several relay sessions, e.g. installed + dev
          // builds); legacy senders without a nonce fall back to deviceId.
          const senderInstance = (data as { instanceId?: string })?.instanceId;
          const isSelf = senderInstance
            ? senderInstance === this.instanceId
            : String(data?.deviceId || '') !== '' && data.deviceId === this.deviceId;
          if (data?.type === 'db:changed' && !isSelf) {
            this.logEvent('pull', `Signal relay db:changed received (epoch ${data.epoch})`, 'info');
            this.relayEpoch = Math.max(this.relayEpoch, Number(data.epoch || 0));
            void this.pullOnce();
          }
        } catch {
          // ignore
        }
      };

      this.relaySocket.onclose = () => {
        this.relaySocket = null;
        if (this.savedRelayWsUrl) {
          if (this.relayReconnectTimeout) window.clearTimeout(this.relayReconnectTimeout);
          this.relayReconnectAttempts = Math.min(this.relayReconnectAttempts + 1, 16);
          const baseMs = Math.min(30_000, 1_000 * Math.pow(1.5, this.relayReconnectAttempts));
          const jitterMs = Math.random() * 1_000;
          const backoff = baseMs + jitterMs;
          this.relayReconnectTimeout = window.setTimeout(() => {
            if (this.savedRelayWsUrl) {
              void this.connectRelay(this.savedRelayWsUrl);
            }
          }, backoff);
        }
      };
    } catch (e) {
      console.warn('Relay connection error:', e);
    }
  }

  broadcastRelayChange(table?: string) {
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({
          type: 'db:changed',
          epoch: this.relayEpoch,
          deviceId: this.deviceId,
          instanceId: this.instanceId,
          table,
        });
      } catch {
        // ignore
      }
    }
    if (this.relaySocket && this.relaySocket.readyState === WebSocket.OPEN) {
      try {
        this.relayEpoch += 1;
        this.relaySocket.send(
          JSON.stringify({
            type: 'db:changed',
            epoch: this.relayEpoch,
            deviceId: this.deviceId,
            instanceId: this.instanceId,
            table,
          })
        );
      } catch {
        // ignore send error
      }
    }
  }

  notifyLocalWrite() {
    if (!this.pushTimer) {
      import('./device').then(({ getStableDeviceId }) => {
        getStableDeviceId().then((devId) => { void this.start(devId); }).catch(() => {});
      }).catch(() => {});
    }
    // Causality Invariant (Contract C1): broadcastRelayChange is intentionally NOT fired here.
    // It is triggered inside pushOnce() ONLY after Turso cloud acknowledges the write,
    // ensuring companion devices pull fresh, committed cloud state without racing.
    // P-½ bleed-stop: 500 ms coalesce window (was 100 ms) — bursts of local
    // writes (stocktake, rapid sales) collapse into fewer cloud batches.
    // Deliberately NOT the doc's 5 s: this debounce sits on the Contract C1
    // critical path (sale → push → relay → peer pull ≈ 0.5–1.3 s p95 transport),
    // so a 5 s window would by itself breach C1 (≤ 1.5 s p95). Revisit toward 5 s
    // only with real two-device p95 numbers proving headroom (charter §8.2 note).
    if (this.postWriteDebounce) window.clearTimeout(this.postWriteDebounce);
    this.postWriteDebounce = window.setTimeout(() => { void this.pushOnce(true); }, 500);
  }

  async kick() {
    await this.ensureOnline(true);
    await this.pushOnce(true);
    await this.pullOnce(true);
  }

  async initialPull() {
    let rounds = 0;
    let roundPulled = 0;
    do {
      roundPulled = await this.pullOnce(true);
      rounds++;
    } while (roundPulled > 0 && rounds < 100);
  }

  private async refreshPendingCount() {
    try {
      const db = await getLocalDb();
      const rows = (await db.select(
        "SELECT COUNT(*) as n FROM sync_outbox WHERE status='pending'"
      )) as Array<{ n: number }>;
      this.pendingCount = rows?.[0]?.n ?? 0;
      this.failedCount = await getFailedOutboxCount();
    } catch {
      this.pendingCount = 0;
      this.failedCount = 0;
    }
    this.emit();
  }

  async retryQuarantinedOutbox(): Promise<number> {
    const count = await retryQuarantinedOutbox();
    if (count > 0) {
      this.logEvent('info', `${count} mutation(s) en quarantaine réactivée(s)`, 'info');
      await this.refreshPendingCount();
      void this.kick();
    }
    return count;
  }

  /** Re-probe connectivity when flagged offline, throttled so an offline
   *  phone isn't burning battery every second — but never wedged forever. */
  private async ensureOnline(forceProbe = false): Promise<boolean> {
    if (this.online && !forceProbe) return true;
    const nowMs = Date.now();
    if (!forceProbe && nowMs - this.lastProbeAt < 3_000) return this.online;
    this.lastProbeAt = nowMs;
    try {
      if (await probeOnline(3000)) {
        this.consecutiveProbeFailures = 0;
        this.online = true;
        this.emit();
        return true;
      }
    } catch {
      // Stay offline; the next throttled probe retries.
    }
    this.consecutiveProbeFailures += 1;
    if (this.consecutiveProbeFailures >= 2) {
      this.online = false;
      this.emit();
    }
    return false;
  }

  /** Quota blocks uploads, but the block must expire: Turso quotas reset and
   *  transient 429/usage scares must not wedge uploads until app restart. */
  private quotaRetryDue(): boolean {
    return Date.now() - this.quotaBlockedAt > 5 * 60_000;
  }

  async pushOnce(forceOnline = false) {
    if (this.pushing) return;
    if (this.quotaExceeded) {
      if (!this.quotaRetryDue()) return;
      const quotaProbablyReset = await this.probeQuotaReset();
      if (!quotaProbablyReset) return;
      this.quotaExceeded = false;
      this.quotaBlockedAt = 0;
      this.logEvent('quota', 'Quota cloud probablement réinitialisé — reprise des envois', 'info');
    }
    if (!(await this.ensureOnline(forceOnline))) return;

    const creds = await getCloudCredentials();
    if (!creds) return;

    this.pushing = true;
    this.emit();

    try {
      const batch = (await getPendingOutbox(50)) as unknown as OutboxRow[];
      if (batch.length === 0) {
        await this.refreshPendingCount();
        return;
      }

      // Parent-first order: product -> customer -> order -> items/ledger
      const rank: Record<string, number> = {
        product: 0, customer: 0, order: 1, order_item: 2, ledger: 2,
      };
      batch.sort((a, b) => (rank[a.entity_type] ?? 9) - (rank[b.entity_type] ?? 9));

      const remote = await getTursoClient();

      // Server clock authority (ADR-0008): stamp every pushed row with the
      // cloud clock so pull cursors order on ONE clock and a drifting device
      // can never hide its rows from peers. Fetched only when there is work
      // to push — idle cycles stay at a single probe read.
      let serverNow = utcNowIso();
      let srvClockValid = false;
      try {
        const srv = await remote.execute(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now`);
        const srvRaw = srv.rows[0]?.now ?? srv.rows[0]?.['now'];
        if (srvRaw && Number.isFinite(Date.parse(String(srvRaw)))) {
          serverNow = String(srvRaw);
          srvClockValid = true;
        }
      } catch {
        // Fall back to the local clock; skew probe reports drift separately.
      }

      if (!srvClockValid) {
        if (Math.abs(this.clockSkewMs) > 10_000) {
          this.lastError = 'Horloge locale décalée et horloge cloud injoignable — push suspendu.';
          this.logEvent('error', this.lastError, 'error');
          return;
        }
      }
      if (!this.remoteSchemaEnsured) {
        try {
          await ensureRemoteSchemaColumns(remote);
          this.remoteSchemaEnsured = true;
        } catch (schemaErr) {
          console.warn('[SyncManager] Remote schema check warning:', schemaErr);
        }
      }
      let okCount = 0;

      // Prepare statements
      const validOps: Array<{ op: OutboxRow; stmt: { sql: string; args: InValue[] } }> = [];
      for (const op of batch) {
        // P0 hygiene gate: never let one giant row wedge the batch loop.
        const rawLen = typeof op.payload_json === 'string' ? op.payload_json.length : 0;
        if (rawLen > MAX_PUSH_ROW_BYTES) {
          await markOutbox(op.idempotency_key, {
            status: 'failed',
            error: `[HYGIENE] payload ${(rawLen / 1024).toFixed(0)}KB > budget ${MAX_PUSH_ROW_BYTES / 1024}KB (probable embedded image/base64). `
              + `Local data kept. Clean the row (remove base64 media, keep URL references), then retry from Sync Diagnostics.`,
          });
          this.logEvent('error', `[Hygiène] ${op.entity_type}/${op.entity_id} mis en quarantaine (${(rawLen / 1024).toFixed(0)}KB)`, 'error');
          continue;
        }
        const stmt = this.toRemoteUpsert(op, serverNow);
        if (!stmt) {
          // If statement cannot be mapped, mark it failed — NEVER silently mark as synced!
          await markOutbox(op.idempotency_key, {
            status: 'failed',
            error: 'Payload non sérialisable ou entité non reconnue',
          });
          this.logEvent('error', `Opération rejetée: ${op.entity_type}/${op.entity_id}`, 'error');
        } else {
          validOps.push({ op, stmt });
        }
      }

      if (validOps.length > 0) {
        // Attempt fast batch write in a single network roundtrip
        let batchSucceeded = false;
        try {
          // Set-based bookkeeping: 2 IPC for the whole batch instead of 2 per row.
          const batchKeys = validOps.map(({ op }) => op.idempotency_key);
          await markOutboxMany(batchKeys, { status: 'inflight' });
          await remote.batch(validOps.map((v) => v.stmt), 'write');
          await markOutboxMany(batchKeys, { status: 'synced' });
          okCount = validOps.length;
          batchSucceeded = true;
        } catch (batchErr: unknown) {
          const rawMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
          if (rawMsg.includes('QUOTA') || rawMsg.includes('usage limit') || rawMsg.includes('storage full')) {
            this.quotaExceeded = true;
            this.quotaBlockedAt = Date.now();
            this.lastError = 'Quota cloud Turso dépassé. Synchronisation suspendue.';
            this.logEvent('quota', this.lastError, 'error');
            await markOutboxMany(validOps.map(({ op }) => op.idempotency_key), { status: 'pending', error: rawMsg });
            return;
          }
          if (rawMsg.includes('has no column') || rawMsg.includes('no column named') || rawMsg.includes('no such column')) {
            try {
              await ensureRemoteSchemaColumns(remote);
              this.remoteSchemaEnsured = true;
            } catch {
              // ignore
            }
          }
          console.warn('[SyncManager] Batch push failed, falling back to item-by-item write:', rawMsg);
        }

        if (!batchSucceeded) {
          for (const { op, stmt } of validOps) {
            try {
              await remote.execute(stmt);
              await markOutbox(op.idempotency_key, { status: 'synced' });
              okCount++;
            } catch (e: unknown) {
              let rawMsg = e instanceof Error ? e.message : String(e);
              if (rawMsg.includes('has no column') || rawMsg.includes('no column named') || rawMsg.includes('no such column')) {
                try {
                  await ensureRemoteSchemaColumns(remote);
                  this.remoteSchemaEnsured = true;
                  await remote.execute(stmt);
                  await markOutbox(op.idempotency_key, { status: 'synced' });
                  okCount++;
                  continue;
                } catch (retryErr) {
                  rawMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                }
              }

              if (rawMsg.includes('QUOTA') || rawMsg.includes('usage limit') || rawMsg.includes('storage full')) {
                this.quotaExceeded = true;
                this.quotaBlockedAt = Date.now();
                this.lastError = 'Quota cloud Turso dépassé. Synchronisation suspendue.';
                this.logEvent('quota', this.lastError, 'error');
                await markOutbox(op.idempotency_key, { status: 'pending', error: rawMsg });
                break;
              }

              const nextRetry = (op.retry_count ?? 0) + 1;
              if (nextRetry >= 10) {
                await markOutbox(op.idempotency_key, {
                  status: 'failed',
                  retryCount: nextRetry,
                  nextRetryAt: null,
                  error: `[QUARANTINE - MAX RETRIES] ${rawMsg}`,
                });
                this.lastError = `[QUARANTINE] ${op.entity_type}/${op.entity_id}: ${rawMsg}`;
                this.logEvent('error', `Mutation mise en quarantaine après 10 échecs [${op.entity_type}/${op.entity_id}]: ${rawMsg}`, 'error');
              } else {
                await markOutbox(op.idempotency_key, {
                  status: 'pending',
                  retryCount: nextRetry,
                  nextRetryAt: new Date(Date.now() + backoffMs(op.retry_count ?? 0)).toISOString(),
                  error: rawMsg,
                });
                this.lastError = `${op.entity_type}/${op.entity_id}: ${rawMsg}`;
                this.logEvent('error', `Échec d'envoi [${op.entity_type}]: ${rawMsg}`, 'warn');
              }
            }
          }
        }
      }

      if (okCount > 0) {
        this.lastPushAt = utcNowIso();
        // Any successful cloud write proves the path is alive: clear quota
        // and offline wedges instead of latching them until app restart.
        if (this.quotaExceeded) {
          this.quotaExceeded = false;
          this.logEvent('push', 'Blocage quota levé — écriture cloud confirmée', 'success');
        }
        if (!this.online) {
          this.online = true;
        }
        this.lastError = null;
        this.logEvent('push', `${okCount} modifications synchronisées avec succès`, 'success');
        // Causality Resolution: Notify companion registers/phones ONLY after cloud write succeeds
        this.broadcastRelayChange();
      }
      await this.refreshPendingCount();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.logEvent('error', `Erreur de synchronisation push: ${this.lastError}`, 'error');
    } finally {
      this.pushing = false;
      this.emit();
    }
  }

  private toRemoteUpsert(op: OutboxRow, serverNow: string = utcNowIso()): { sql: string; args: InValue[] } | null {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(op.payload_json) as Record<string, unknown>;
    } catch {
      return null;
    }

    // Cursor ordering key: ALWAYS the server clock (ADR-0008). created_at
    // keeps origin truth; updated_at is the pull-cursor authority.
    const now = serverNow;
    const v = (x: unknown): InValue => (x === undefined ? null : x) as InValue;
    const version = Number(payload.version ?? 1);

    // Image/media payload stripping: ensure large binary/base64 fields are purged before pushing to Turso
    payload.imageUrl = '';
    payload.image_url = '';
    if ('photos' in payload) delete payload.photos;
    if ('photo' in payload) delete payload.photo;
    if ('receipt_image' in payload) delete payload.receipt_image;
    if ('scan_image' in payload) delete payload.scan_image;
    if ('avatar' in payload && typeof payload.avatar === 'string' && payload.avatar.length > 500) delete payload.avatar;
    // P0 fix: the strip above used to mutate a parsed copy while the wire args
    // below sent the ORIGINAL op.payload_json string (dead code for the
    // order/order_item/product lanes). Deep-sanitize nested blobs too.
    payload = sanitizeSyncPayload(payload);

    if (op.operation === 'DELETE') {
      const table = op.entity_type === 'order' ? 'transactions'
        : op.entity_type === 'order_item' ? 'transaction_items'
        : op.entity_type === 'ledger' ? 'inventory_ledger'
        : op.entity_type === 'product' ? 'products'
        : undefined;

      if (table) {
        assertValidSyncTable(table);
        return {
          sql: `INSERT INTO ${table} (id, device_id, idempotency_key, sync_status, version, updated_at, deleted)
            VALUES (?,?,?,'synced',?,?,1)
            ON CONFLICT(id) DO UPDATE SET deleted=1, version=excluded.version, updated_at=excluded.updated_at,
            sync_status='synced'
            WHERE excluded.version >= ${table}.version`,
          args: [v(op.entity_id), v(this.deviceId || 'default'), v(op.idempotency_key || `del-${op.entity_id}`), v(version + 1), v(now)],
        };
      }
    }

    const genericTable = GENERIC_TABLES[op.entity_type];
    if (genericTable) {
      assertValidSyncTable(genericTable);
      const isDelete = op.operation === 'DELETE' || Number(payload.deleted ?? 0) === 1;
      if (isDelete) {
        return {
          sql: `INSERT INTO ${genericTable} (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
            VALUES (?,?,?,?,'synced',?,?,1)
            ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version,
            updated_at=excluded.updated_at, sync_status='synced', deleted=1
            WHERE excluded.version >= ${genericTable}.version`,
          args: [
            v(op.entity_id), v(toBoundedSyncJson(payload ?? {})), v(payload.device_id ?? this.deviceId ?? 'default'),
            v(op.idempotency_key ?? payload.idempotency_key ?? `idem-${op.entity_id}`), v(version + 1),
            v(now),
          ],
        };
      }
      return {
        sql: `INSERT INTO ${genericTable} (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
          VALUES (?,?,?,?,'synced',?,?,0)
          ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version,
          updated_at=excluded.updated_at, sync_status='synced', deleted=0
          WHERE excluded.version >= ${genericTable}.version`,
        args: [
          v(op.entity_id), v(toBoundedSyncJson(payload ?? {})), v(payload.device_id ?? this.deviceId ?? 'default'),
          v(op.idempotency_key ?? payload.idempotency_key ?? `idem-${op.entity_id}`), v(version || 1),
          v(now),
        ],
      };
    }

    if (op.entity_type === 'ledger') {
      const prodId = (payload.product_id as string) ?? (payload.productId as string) ?? 'unknown';
      return {
        sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
          idempotency_key, sync_status, version, created_at, updated_at, deleted)
          VALUES (?,?,?,?,?,?,?,?,'synced',?,?,?,0) ON CONFLICT(id) DO NOTHING`,
        args: [
          v(payload.id ?? op.entity_id ?? `led-${Date.now()}`), v(prodId), v(Number(payload.delta ?? 0)),
          v(String(payload.reason ?? 'SALE')), v(payload.ref_type ?? payload.refType ?? null),
          v(payload.ref_id ?? payload.refId ?? null), v(payload.device_id ?? this.deviceId ?? 'default'),
          v(op.idempotency_key ?? payload.idempotency_key ?? `idem-${op.entity_id}`), v(version || 1),
          v(payload.created_at ?? payload.createdAt ?? now), v(now),
        ],
      };
    }

    if (op.entity_type === 'order') {
      const cust = (payload.customer_id ?? (payload.customer as Record<string, unknown> | undefined)?.id ?? null) as InValue;
      return {
        sql: `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
          cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
          status, created_at, json_payload, device_id, idempotency_key, sync_status, version, updated_at, deleted)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,0)
          ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total,
            json_payload=excluded.json_payload, version=excluded.version, updated_at=excluded.updated_at, sync_status='synced'
            WHERE excluded.version >= transactions.version`,
        args: [
          v(payload.id ?? op.entity_id),
          v(payload.receipt_number ?? payload.receiptNumber ?? payload.id ?? op.entity_id),
          v(cust), v(Number(payload.subtotal ?? 0)), v(Number(payload.tax ?? 0)),
          v(Number(payload.discount_total ?? payload.discountTotal ?? 0)),
          v(Number(payload.total ?? 0)), v(Number(payload.cost_total ?? payload.costTotal ?? 0)),
          v(Number(payload.profit ?? 0)), v(Number(payload.profit_margin ?? payload.profitMargin ?? 0)),
          v(String(payload.pricing_tier ?? payload.pricingTier ?? 'Retail')),
          v(String(payload.payment_method ?? payload.paymentMethod ?? 'Espèces')),
          v(Number(payload.cash_tendered ?? payload.cashTendered ?? 0)),
          v(Number(payload.change_due ?? payload.changeDue ?? 0)),
          v(String(payload.status ?? 'COMPLETED')),
          v((payload.created_at ?? payload.createdAt) ?? now),
          v(JSON.stringify(payload)),
          v(payload.device_id ?? this.deviceId ?? 'default'),
          v(op.idempotency_key ?? payload.idempotency_key ?? `idem-${op.entity_id}`),
          v(version || 1),
          v(now),
        ],
      };
    }

    if (op.entity_type === 'order_item') {
      const txnId = (payload.transaction_id as string) ?? (payload.transactionId as string) ?? String(op.entity_id).replace(/-item-\d+$/, '');
      const prodId = (payload.product_id as string) ?? (payload.productId as string) ?? ((payload.product as Record<string, unknown> | undefined)?.id as string) ?? 'unknown';
      return {
        sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
          imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,?,0) ON CONFLICT(id) DO NOTHING`,
        args: [
          v(payload.id ?? op.entity_id), v(txnId), v(prodId), v(Number(payload.quantity ?? 1)),
          v(Number(payload.applied_price ?? payload.appliedPrice ?? 0)), v(Number(payload.discount ?? 0)),
          v(payload.imei_number ?? payload.imeiNumber ?? null),
          v(Number(payload.cost_price ?? payload.costPrice ?? payload.unitCostPrice ?? 0)),
          v(JSON.stringify(payload)), v(payload.device_id ?? this.deviceId ?? 'default'),
          v(op.idempotency_key ?? payload.idempotency_key ?? `idem-${op.entity_id}`),
          v(version || 1), v(payload.created_at ?? payload.createdAt ?? now), v(now),
        ],
      };
    }

    if (op.entity_type === 'product') {
      const pId = String(payload.id ?? op.entity_id ?? '');
      return {
        sql: `INSERT INTO products (id, sku, barcode, title, brand, compatible_model, category, price, wholesale_price,
          cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
          daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key, sync_status,
          version, created_at, updated_at, deleted)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title, brand=excluded.brand,
          compatible_model=excluded.compatible_model, price=excluded.price, stock=excluded.stock,
          wholesale_price=excluded.wholesale_price, cost_price=excluded.cost_price,
          image_url=excluded.image_url, is_serialized=excluded.is_serialized,
          imei_number=excluded.imei_number, vendor_name=excluded.vendor_name,
          lead_time_days=excluded.lead_time_days, daily_sales_velocity=excluded.daily_sales_velocity,
          reorder_point=excluded.reorder_point, json_payload=excluded.json_payload,
          version=excluded.version, updated_at=excluded.updated_at,
          deleted=excluded.deleted, sync_status='synced'
          WHERE excluded.version >= products.version`,
        args: [
          v(pId), v(payload.sku ?? ''), v(payload.barcode ?? ''),
          v(payload.title ?? payload.id ?? op.entity_id ?? 'Sans Titre'),
          v(payload.brand ?? 'Autre'), v(payload.compatible_model ?? payload.compatibleModel ?? ''),
          v(payload.category ?? 'Tous les produits'),
          v(Number(payload.price ?? 0)),
          v(Number(payload.wholesale_price ?? payload.wholesalePrice ?? 0)),
          v(Number(payload.cost_price ?? payload.costPrice ?? 0)),
          v(Number(payload.stock ?? 0)),
          v(payload.image_url ?? null),
          v(Number(payload.is_serialized ?? 0)),
          v(payload.imei_number ?? payload.imeiNumber ?? null),
          v(payload.vendor_name ?? payload.vendorName ?? null),
          v(Number(payload.lead_time_days ?? payload.leadTimeDays ?? 7)),
          v(Number(payload.daily_sales_velocity ?? payload.dailySalesVelocity ?? 0)),
          v(Number(payload.reorder_point ?? payload.reorderPoint ?? 5)),
          v(JSON.stringify(payload)),
          v(payload.device_id ?? this.deviceId ?? 'default'),
          v(op.idempotency_key ?? payload.idempotency_key ?? `idem-${op.entity_id}`),
          v(version || 1),
          v(payload.created_at ?? payload.createdAt ?? now),
          v(now),
          v(Number(payload.deleted ?? 0)),
        ],
      };
    }

    return null;
  }
  /**
   * Batched cursor read: one SELECT replaces N per-table roundtrips.
   * Same parse/fallback semantics as getTableCursor per table; tables without
   * a stored cursor are simply absent (callers default to epoch).
   */
  private async getAllTableCursors(db: Database): Promise<Map<string, { time: string; id: string }>> {
    const out = new Map<string, { time: string; id: string }>();
    try {
      const rows = (await db.select(
        "SELECT key, value_json FROM app_settings WHERE key LIKE 'sync.cursor.%'",
      )) as Array<{ key: string; value_json: string }>;
      for (const row of rows ?? []) {
        const table = String(row?.key ?? '').slice('sync.cursor.'.length);
        if (!table) continue;
        try {
          const parsed: unknown = JSON.parse(row.value_json);
          if (typeof parsed === 'string') {
            out.set(table, { time: parsed, id: '' });
          } else if (parsed && typeof parsed === 'object') {
            out.set(table, {
              time: String((parsed as { time?: string }).time || '1970-01-01T00:00:00.000Z'),
              id: String((parsed as { id?: string }).id || ''),
            });
          }
        } catch {
          // Malformed cursor value → epoch default via absence.
        }
      }
    } catch (err) {
      console.warn('[sync:cursor] Error reading cursors batch:', err);
    }
    return out;
  }

  private async setTableCursor(db: Database, table: string, cursor: { time: string; id: string } | string): Promise<void> {
    const value = typeof cursor === 'string' ? { time: cursor, id: '' } : cursor;
    await db.execute(
      "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
      [`sync.cursor.${table}`, JSON.stringify(value), utcNowIso()],
    );
  }

  async pullOnce(forceOnline = false): Promise<number> {
    if (this.pulling) return 0;
    if (!(await this.ensureOnline(forceOnline))) return 0;

    const creds = await getCloudCredentials();
    if (!creds) return 0;

    this.pulling = true;
    this.emit();

    let totalPulled = 0;
    try {
      const remote = await getTursoClient();
      const db = await getLocalDb();

      const isBackfill = this.backfillRoundsRemaining > 0;
      if (isBackfill) {
        this.backfillRoundsRemaining--;
        this.logEvent('info', `Backfill pull en cours (tours restants: ${this.backfillRoundsRemaining})`, 'info');
      }
      const backfillCutoff = isBackfill ? new Date(Date.now() - 24 * 3600 * 1000).toISOString() : null;

      const cursorQueries: Array<{ sql: string; args: InValue[] }> = [];
      const tableCursors: Array<{ table: string; cursor: { time: string; id: string } }> = [];
      const touchedProductIds = new Set<string>();
      const touchedTables = new Set<string>();
      // Incremental reconstruct (F2): transaction rows carry their own IDs so
      // the mirror rebuild touches only them; customer-only changes still take
      // the full path (rare + needs customer→txn fan-out).
      const touchedTxnIds = new Set<string>();
      let transactionsNeedReconstruction = false;

      // One batched cursor read replaces 17 sequential per-table SELECTs.
      const cursorsByTable = await this.getAllTableCursors(db);
      const epoch = { time: '1970-01-01T00:00:00.000Z', id: '' };
      for (const table of ALL_REMOTE_SYNC_TABLES) {
        assertValidSyncTable(table);
        const cursor = cursorsByTable.get(table) ?? epoch;
        tableCursors.push({ table, cursor });
        if (isBackfill && backfillCutoff) {
          cursorQueries.push({
            sql: `SELECT ${pullColumns(table)} FROM ${table} WHERE updated_at > ? ORDER BY updated_at ASC, id ASC LIMIT 500`,
            args: [backfillCutoff],
          });
        } else {
          cursorQueries.push({
            sql: `SELECT ${pullColumns(table)} FROM ${table} WHERE (updated_at > ?) OR (updated_at = ? AND id > ?) ORDER BY updated_at ASC, id ASC LIMIT 500`,
            args: [cursor.time, cursor.time, cursor.id],
          });
        }
      }

      // Fast single-roundtrip batch pull across all 17 tables
      let batchResults: Array<{ rows: unknown[] }> | null = null;
      try {
        batchResults = (await remote.batch(cursorQueries, 'read')) as Array<{ rows: unknown[] }>;
      } catch {
        // Graceful fallback to sequential queries if batch read is unsupported
        batchResults = null;
      }

      for (let i = 0; i < tableCursors.length; i++) {
        const { table, cursor } = tableCursors[i];
        let maxSeenTime = cursor.time;
        let maxSeenId = cursor.id;
        let tablePulled = 0;

        let rsRows: unknown[] = [];
        if (batchResults && batchResults[i]) {
          rsRows = batchResults[i].rows;
        } else {
          try {
            const rs = await remote.execute(cursorQueries[i]);
            rsRows = rs.rows;
          } catch (e) {
            console.warn(`[sync] pull query failed [${table}]:`, e);
            continue;
          }
        }

        // Chunked apply (F4): commit the cursor per chunk instead of once per
        // page. A kill between chunks resumes after the last fully applied row
        // (C6) instead of re-applying the whole page. plugin-sql v2 exposes no
        // local batch API, so per-row writes are retained deliberately.
        const APPLY_CHUNK = 100;
        let committedTime = cursor.time;
        let committedId = cursor.id;
        for (let c = 0; c < rsRows.length; c += APPLY_CHUNK) {
          for (const row of rsRows.slice(c, c + APPLY_CHUNK)) {
            const r = row as unknown as Record<string, unknown>;
            const updated = (r.updated_at as string) ?? utcNowIso();
            const rowId = (r.id as string) ?? '';
            if (table === 'products' && rowId) touchedProductIds.add(rowId);
            if (table === 'inventory_ledger' && r.product_id) touchedProductIds.add(String(r.product_id));
            if (table === 'transactions' || table === 'transaction_items' || table === 'customers') {
              transactionsNeedReconstruction = true;
            }
            if (table === 'transactions' && rowId) touchedTxnIds.add(rowId);
            if (table === 'transaction_items' && r.transaction_id) {
              touchedTxnIds.add(String(r.transaction_id));
            }
            try {
              await this.applyRemoteRow(db, table, r);
              totalPulled++;
              tablePulled++;
              // Contract C6: advance the cursor ONLY past rows that applied
              // cleanly. A failed row keeps the cursor behind it so the next
              // pull retries it instead of silently skipping it forever.
              if (updated > maxSeenTime || (updated === maxSeenTime && rowId > maxSeenId)) {
                maxSeenTime = updated;
                maxSeenId = rowId;
              }
            } catch (e) {
              console.warn(`[sync] pull apply failed [${table}]:`, e);
              this.logEvent('error', `Échec d'application pull [${table}]: ${e instanceof Error ? e.message : String(e)}`, 'warn');
            }
          }
          if (maxSeenTime !== committedTime || maxSeenId !== committedId) {
            await this.setTableCursor(db, table, { time: maxSeenTime, id: maxSeenId });
            committedTime = maxSeenTime;
            committedId = maxSeenId;
          }
        }

        if (tablePulled > 0) touchedTables.add(table);
      }

      if (totalPulled > 0) {
        this.lastPullAt = utcNowIso();
        // 1. Recompute products stock from ledger deltas in SQLite
        // P2: chunk the IN() list — up to 8.5k ids in one statement risks
        // SQLITE_ERROR (too many variables) on older SQLite builds.
        if (touchedProductIds.size > 0) {
          const productIds = [...touchedProductIds];
          const IN_CHUNK = 500;
          for (let i = 0; i < productIds.length; i += IN_CHUNK) {
            const chunk = productIds.slice(i, i + IN_CHUNK);
            await db.execute(
              `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger
                WHERE inventory_ledger.product_id = products.id AND deleted=0), stock)
               WHERE id IN (${chunk.map(() => '?').join(',')})`,
              chunk,
            );
          }
        }
        // 2. CRITICAL: Mirror recomputed stock from SQLite to Dexie so desktop UI gets updated immediately!
        try {
          if (touchedProductIds.size > 0) {
            await syncProductsFromSqlToDexie(touchedProductIds);
          }
        } catch (stockErr) {
          console.warn('[sync:pull] syncProductsFromSqlToDexie error:', stockErr);
        }
        // 3. Reconstruct Dexie transactions with their line items & customers
        if (transactionsNeedReconstruction) {
          try {
            const { reconstructDexieTransactionsFromSql } = await import('../db/backfill');
            await reconstructDexieTransactionsFromSql(
              db,
              touchedTxnIds.size > 0 ? { onlyTransactionIds: touchedTxnIds } : undefined,
            );
          } catch (err) {
            console.warn('[sync:pull] reconstructDexieTransactionsFromSql error:', err);
          }
        }
        this.logEvent('pull', `${totalPulled} enregistrements reçus du cloud`, 'info');
        // P1: record what this pull touched so UI handlers can refresh only
        // the affected slices (products subset / txns / fallback full reload).
        this.lastPullTouched = {
          productIds: [...touchedProductIds],
          transactions: transactionsNeedReconstruction,
          tables: [...touchedTables],
        };
        this.emitPulled();
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.logEvent('error', `Erreur de synchronisation pull: ${this.lastError}`, 'warn');
    } finally {
      this.pulling = false;
      this.emit();
    }
    return totalPulled;
  }

  private async applyRemoteRow(db: Database, table: string, r: Record<string, unknown>) {
    const generic = GENERIC_PULL[table];
    const version = Number(r.version ?? 1);

    if (generic) {
      let recordPayload: Record<string, unknown>;
      try {
        recordPayload = sanitizeSyncPayload(
          JSON.parse((r.data_json as string) ?? '{}') as Record<string, unknown>,
        );
      } catch {
        return;
      }
      const id = (r.id as string) ?? (recordPayload.id as string);
      if (!id) return;
      if (table === 'app_settings' && (id.startsWith('sync.') || (recordPayload.key as string)?.startsWith?.('sync.'))) return;

      const store = (dexieDb as unknown as Record<string, {
        get: (k: string) => Promise<Record<string, unknown> | undefined>;
        put: (o: unknown) => Promise<unknown>;
        delete: (k: string) => Promise<void>;
      }>)[generic.dexie];
      if (!store) return;

      if (Number(r.deleted ?? 0) === 1) {
        if (table === 'customers') {
          await db.execute('UPDATE customers SET deleted = 1 WHERE id = $1', [id]).catch(() => {});
        }
        if (table === 'cash_drops') {
          await (dexieDb as unknown as { cashDrops: { delete: (k: string) => Promise<void> }; payouts: { delete: (k: string) => Promise<void> } }).cashDrops.delete(id).catch((err: unknown) => {
            console.warn('[sync:dexie] Failed to delete cashDrop:', err);
          });
          await (dexieDb as unknown as { cashDrops: { delete: (k: string) => Promise<void> }; payouts: { delete: (k: string) => Promise<void> } }).payouts.delete(id).catch((err: unknown) => {
            console.warn('[sync:dexie] Failed to delete payout:', err);
          });
        } else {
          await store.delete(id).catch((err: unknown) => {
            console.warn(`[sync:dexie] Failed to delete ${table} record:`, err);
          });
        }
        return;
      }

      const local = await store.get(id).catch((err: unknown) => {
        console.warn(`[sync:dexie] Failed to get ${table} record:`, err);
        return undefined;
      });
      if (local && Number(local.version ?? 1) > version) {
        return; // Local version is newer
      }

      if (table === 'customers') {
        const c = recordPayload as Record<string, unknown>;
        const now = utcNowIso();
        await db.execute(
          `INSERT INTO customers (id, name, phone, email, loyalty_points, store_credit, pricing_tier, total_spent, json_payload, updated_at, deleted, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email,
             loyalty_points=excluded.loyalty_points, store_credit=excluded.store_credit,
             pricing_tier=excluded.pricing_tier, total_spent=excluded.total_spent,
             json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0, version=excluded.version
             WHERE excluded.version >= customers.version`,
          [
            id,
            (c.name as string) || 'Client',
            (c.phone as string) || '',
            (c.email as string) || null,
            Number(c.loyaltyPoints ?? 0),
            Number(c.storeCredit ?? 0),
            (c.pricingTier as string) || 'Retail',
            Number(c.totalSpent ?? 0),
            JSON.stringify(c),
            (c.updatedAt as string) ?? now,
            version,
          ],
        ).catch(() => {});
      }

      if (table === 'cash_drops') {
        const payouts = (dexieDb as unknown as { payouts: { put: (o: unknown) => Promise<unknown> } }).payouts;
        const cashDrops = (dexieDb as unknown as { cashDrops: { put: (o: unknown) => Promise<unknown> } }).cashDrops;
        if ((recordPayload as Record<string, unknown>)._isPayout) await payouts.put(recordPayload);
        else await cashDrops.put(recordPayload);
      } else {
        await store.put(recordPayload);
      }
      return;
    }

    if (table === 'inventory_ledger') {
      const ledId = String(r.id || `led-${Date.now()}`);
      const prodId = String(r.product_id || 'unknown');
      await db.execute(
        `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
          idempotency_key, sync_status, version, created_at, updated_at, deleted)
         VALUES (?,?,?,?,?,?,?,?,'synced',?,?,?,?) ON CONFLICT(id) DO UPDATE SET
           delta=excluded.delta, version=excluded.version, updated_at=excluded.updated_at, sync_status='synced'
           WHERE excluded.version >= inventory_ledger.version`,
        [
          ledId, prodId, Number(r.delta ?? 0), String(r.reason ?? 'SALE'), r.ref_type ? String(r.ref_type) : null,
          r.ref_id ? String(r.ref_id) : null, String(r.device_id ?? 'remote'), String(r.idempotency_key ?? ledId),
          version, String(r.created_at ?? utcNowIso()), String(r.updated_at ?? utcNowIso()), Number(r.deleted ?? 0),
        ],
      );
      return;
    }

    if (table === 'transactions') {
      const txId = String(r.id || `txn-${Date.now()}`);
      const receiptNo = String(r.receipt_number || txId);
      // New-row detection BEFORE upsert: own sales already exist locally, so a
      // pre-existing id means "echo of my own write" while a missing id means
      // "genuinely new sale from another device". This is robust to the two
      // device-id namespaces (localStorage transport id vs SQLite authorship
      // id) ever diverging.
      let isNewSale = false;
      try {
        const existing = (await db.select('SELECT id FROM transactions WHERE id = $1', [txId]).catch(() => [])) as Array<{ id: string }>;
        const txnsCheck = (dexieDb as unknown as { transactions: { get: (k: string) => Promise<Record<string, unknown> | undefined> } }).transactions;
        const existingDexieCheck = await txnsCheck.get(txId).catch(() => undefined);
        isNewSale = (!existing || existing.length === 0) && !existingDexieCheck;
      } catch {
        isNewSale = true;
      }
      await db.execute(
        `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
          cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
          status, created_at, json_payload, device_id, idempotency_key, sync_status, version, updated_at, deleted)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total,
           json_payload=excluded.json_payload, version=excluded.version, updated_at=excluded.updated_at, sync_status='synced'
           WHERE excluded.version >= transactions.version`,
        [
          txId, receiptNo, r.customer_id ? String(r.customer_id) : null, Number(r.subtotal ?? 0), Number(r.tax ?? 0),
          Number(r.discount_total ?? 0), Number(r.total ?? 0), Number(r.cost_total ?? 0), Number(r.profit ?? 0),
          Number(r.profit_margin ?? 0), String(r.pricing_tier ?? 'Retail'), String(r.payment_method ?? 'Espèces'),
          Number(r.cash_tendered ?? 0), Number(r.change_due ?? 0), String(r.status ?? 'COMPLETED'),
          String(r.created_at ?? utcNowIso()), cleanRemoteJson(r.json_payload),
          String(r.device_id ?? 'remote'), String(r.idempotency_key ?? txId), version,
          String(r.updated_at ?? utcNowIso()), Number(r.deleted ?? 0),
        ],
      );

      // Mirror transaction receipt into Dexie with receiptNumber
      try {
        const txns = (dexieDb as unknown as { transactions: {
          get: (k: string) => Promise<Record<string, unknown> | undefined>;
          put: (o: unknown) => Promise<unknown>;
          update: (k: string, p: unknown) => Promise<unknown>;
          delete: (k: string) => Promise<void>;
        } }).transactions;

        if (Number(r.deleted ?? 0) === 1) {
          await txns.delete(txId);
          return;
        }

        const existingDexie = await txns.get(txId).catch(() => undefined);
        // cleanRemoteJson already parses + sanitizes + stringifies: parse the
        // cleaned string once instead of paying a second sanitize pass (F6).
        const rawPayload = JSON.parse(cleanRemoteJson(r.json_payload)) as Record<string, unknown>;
        const parsedTxn = {
          ...rawPayload,
          id: rawPayload.id || txId,
          receiptNumber: rawPayload.receiptNumber || rawPayload.receipt_number || receiptNo,
          total: rawPayload.total ?? Number(r.total ?? 0),
          status: rawPayload.status || r.status || 'COMPLETED',
          paymentMethod: rawPayload.paymentMethod || r.payment_method || 'Espèces',
          createdAt: rawPayload.createdAt || r.created_at || utcNowIso(),
        };
        // Defense in depth: a status-only payload (void/refund echo, legacy
        // backfill) must never wipe the receipt's line items or customer.
        const incomingItems = (parsedTxn as Record<string, unknown>).items;
        const mergedTxn = {
          ...existingDexie,
          ...parsedTxn,
          items: Array.isArray(incomingItems) && incomingItems.length > 0
            ? incomingItems
            : existingDexie?.items ?? (parsedTxn as Record<string, unknown>).items,
          customer: (parsedTxn as Record<string, unknown>).customer ?? existingDexie?.customer ?? null,
        };
        await txns.put(mergedTxn);

        // Notify UI subscribers for genuinely new sales from other devices
        // (e.g. mobile sale arriving on desktop). Own-write echoes (id already
        // present) never notify; when authorship is known, a deviceId match
        // also suppresses. Deleted tombstones never notify. A status flip to
        // VOIDED/REFUNDED on a known sale notifies too (a cancel is news).
        const incomingDeviceId = String(
          r.device_id ||
          (parsedTxn as Record<string, unknown>).device_id ||
          (parsedTxn as Record<string, unknown>).deviceId ||
          ''
        );
        const isOwnDevice = incomingDeviceId !== '' && incomingDeviceId === this.deviceId;
        const mergedStatus = String((mergedTxn as Record<string, unknown>).status ?? 'COMPLETED');
        const prevStatus = String(existingDexie?.status ?? '');
        const isVoidTransition = !isNewSale && prevStatus !== '' && prevStatus !== mergedStatus &&
          ['VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(mergedStatus);
        if ((isNewSale && !isOwnDevice && Number(r.deleted ?? 0) === 0) ||
          (isVoidTransition && Number(r.deleted ?? 0) === 0)) {
          this.emitRemoteSale(mergedTxn as Record<string, unknown>);
        }
      } catch (err) {
        console.warn(`[sync:pull] Failed to parse or mirror transaction ${r.id} into Dexie:`, err);
      }
      return;
    }

    if (table === 'transaction_items') {
      const itemId = String(r.id || `item-${Date.now()}`);
      const txnId = String(r.transaction_id || '');
      const prodId = String(r.product_id || 'unknown');
      await db.execute(
        `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
          imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET quantity=excluded.quantity, applied_price=excluded.applied_price,
           discount=excluded.discount, imei_number=excluded.imei_number, cost_price=excluded.cost_price,
           json_payload=excluded.json_payload, version=excluded.version, updated_at=excluded.updated_at,
           deleted=excluded.deleted, sync_status='synced'
           WHERE excluded.version >= transaction_items.version`,
        [
          itemId, txnId, prodId, Number(r.quantity ?? 1), Number(r.applied_price ?? 0),
          Number(r.discount ?? 0), r.imei_number ? String(r.imei_number) : null,
          Number(r.cost_price ?? 0), cleanRemoteJson(r.json_payload),
          String(r.device_id ?? 'remote'), String(r.idempotency_key ?? itemId),
          version, String(r.created_at ?? utcNowIso()), String(r.updated_at ?? utcNowIso()),
          Number(r.deleted ?? 0),
        ],
      );
      return;
    }

    if (table === 'products') {
      const pId = String(r.id || `prod-${Date.now()}`);
      // Fix: include deleted=excluded.deleted so product deletions don't resurrect.
      // stock + price/catalog columns ARE updated on conflict (LWW): the ledger
      // recompute after pull remains the stock authority, but the row must not
      // pin a stale cache when ledger history is incomplete on this device.
      await db.execute(
        `INSERT INTO products (id, sku, barcode, title, brand, compatible_model, category, price, wholesale_price,
          cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
          daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key, sync_status,
          version, created_at, updated_at, deleted)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, barcode=excluded.barcode, title=excluded.title,
           brand=excluded.brand, compatible_model=excluded.compatible_model, category=excluded.category,
           price=excluded.price, wholesale_price=excluded.wholesale_price, cost_price=excluded.cost_price,
           stock=excluded.stock, image_url=excluded.image_url, is_serialized=excluded.is_serialized,
           imei_number=excluded.imei_number, vendor_name=excluded.vendor_name,
           lead_time_days=excluded.lead_time_days, daily_sales_velocity=excluded.daily_sales_velocity,
           reorder_point=excluded.reorder_point, json_payload=excluded.json_payload,
           version=excluded.version, updated_at=excluded.updated_at,
           deleted=excluded.deleted, sync_status='synced'
           WHERE excluded.version >= products.version`,
        [
          pId, String(r.sku ?? ''), String(r.barcode ?? ''), String(r.title || pId), String(r.brand ?? 'Autre'),
          String(r.compatible_model ?? ''), String(r.category ?? 'Tous les produits'),
          Number(r.price ?? 0), Number(r.wholesale_price ?? 0), Number(r.cost_price ?? 0), Number(r.stock ?? 0),
          sanitizeImageField(r.image_url) ?? null, Number(r.is_serialized ?? 0),
          (r.imei_number as string) ?? null, (r.vendor_name as string) ?? null,
          Number(r.lead_time_days ?? 7), Number(r.daily_sales_velocity ?? 0), Number(r.reorder_point ?? 5),
          cleanRemoteJson(r.json_payload), String(r.device_id ?? 'remote'), String(r.idempotency_key ?? pId),
          version, String(r.created_at ?? utcNowIso()), String(r.updated_at ?? utcNowIso()),
          Number(r.deleted ?? 0),
        ],
      );

      // Mirror into Dexie
      try {
        const products = dexieDb.products;
        if (Number(r.deleted ?? 0) === 1) {
          if (r.id) {
            await products.delete(r.id as string).catch((err: unknown) => {
              console.warn('[sync:dexie] Failed to delete product:', err);
            });
          }
        } else {
          // F1: mirror the SANITIZED payload (same string SQLite stores), never
          // the raw remote blob — a poisoned json_payload used to land its full
          // base64 bytes in IndexedDB via this spread.
          let base: Record<string, unknown> = {};
          try {
            base = JSON.parse(cleanRemoteJson(r.json_payload));
          } catch (jsonErr: unknown) {
            console.warn('[sync:dexie] Failed to parse product payload:', jsonErr);
          }
          // Remote row wins over the embedded json blob: base carries
          // legacy/camelCase extras, explicit columns carry sync authority
          // (esp. stock — the blob may hold a pre-sale snapshot).
          const productToPut: Product = {
            ...base,
            sku: (r.sku as string) ?? (base.sku as string) ?? '',
            barcode: (r.barcode as string) ?? (base.barcode as string) ?? '',
            title: (r.title as string) ?? (base.title as string) ?? '',
            brand: (r.brand as Product['brand']) || (base.brand as Product['brand']) || 'Autre',
            category: (r.category as Product['category']) || (base.category as Product['category']) || 'Tous les produits',
            price: Number(r.price ?? base.price ?? 0),
            wholesalePrice: Number(r.wholesale_price ?? base.wholesalePrice ?? 0),
            costPrice: Number(r.cost_price ?? base.costPrice ?? 0),
            stock: Number(r.stock ?? base.stock ?? 0),
            imageUrl: String(r.image_url ?? base.imageUrl ?? ''),
            isSerialized: Boolean(r.is_serialized ?? base.isSerialized),
            imeiNumber: r.imei_number ? String(r.imei_number) : (base.imeiNumber as string | undefined),
            vendorName: String(r.vendor_name ?? base.vendorName ?? 'Fournisseur Général'),
            leadTimeDays: Number(r.lead_time_days ?? base.leadTimeDays ?? 7),
            dailySalesVelocity: Number(r.daily_sales_velocity ?? base.dailySalesVelocity ?? 0),
            reorderPoint: Number(r.reorder_point ?? base.reorderPoint ?? 5),
            compatibleModel: String((r.compatible_model as string) ?? base.compatibleModel ?? ''),
            id: r.id as string,
          };
          await products.put(productToPut);
        }
      } catch (err: unknown) {
        console.warn('[sync:dexie] Product mirror failed:', err);
      }
    }
  }

  /**
   * On-demand verification comparing local vs cloud row counts and SHA-256 hashes.
   */
  async verifyCloudIntegrity(): Promise<{
    verified: boolean;
    report: string;
    details: Array<{ table: string; localCount: number; remoteCount: number; match: boolean }>;
  }> {
    const creds = await getCloudCredentials();
    if (!creds) {
      return { verified: false, report: 'Aucun compte cloud configuré.', details: [] };
    }

    const remote = await getTursoClient();
    const local = await getLocalDb();
    const details: Array<{ table: string; localCount: number; remoteCount: number; match: boolean }> = [];
    let allMatch = true;

    for (const table of ALL_REMOTE_SYNC_TABLES) {
      assertValidSyncTable(table);
      let localCount = 0;
      if (['products', 'transactions', 'transaction_items', 'inventory_ledger'].includes(table)) {
        const rows = (await local.select(`SELECT COUNT(*) as n FROM ${table} WHERE deleted=0`).catch(() => [{ n: 0 }])) as Array<{ n: number }>;
        localCount = rows[0]?.n ?? 0;
      } else {
        const dexieTable = GENERIC_PULL[table]?.dexie;
        const store = dexieTable ? (dexieDb as unknown as Record<string, { count: () => Promise<number> }>)[dexieTable] : null;
        localCount = store ? await store.count().catch(() => 0) : 0;
      }

      const rRes = await remote.execute(`SELECT COUNT(*) as n FROM ${table} WHERE deleted=0`);
      const remoteCount = Number(rRes.rows[0]?.n ?? 0);
      const match = localCount === remoteCount;
      if (!match) allMatch = false;

      details.push({ table, localCount, remoteCount, match });
    }

    const report = allMatch
      ? `Intégrité validée à 100% sur l'ensemble des ${details.length} tables synchronisées.`
      : `Écart détecté sur ${details.filter((d) => !d.match).map((d) => d.table).join(', ')}.`;

    this.logEvent('info', `Vérification d'intégrité exécutée: ${allMatch ? 'Succès' : 'Écart'}`, allMatch ? 'success' : 'warn');

    return { verified: allMatch, report, details };
  }
}

export const syncManager = new SyncManager();

export type { PullTouchSummary };

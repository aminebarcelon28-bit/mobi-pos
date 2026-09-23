// SyncManager — background two-way per-customer sync (Local SQLite/Dexie <-> Turso Cloud).
// Push: sync_outbox pending -> Turso batch upserts (idempotent, optimistic version checking).
// Pull: Per-table cursors -> Local SQLite + Dexie UI store updates.
// Zero data loss, zero silent drops, zero dependency on vendor servers.

import { getLocalDb, getPendingOutbox, markOutbox, markOutboxMany, utcNowIso, getFailedOutboxCount, retryQuarantinedOutbox, syncProductsFromSqlToDexie, sanitizeSyncPayload, sanitizeImageField, toBoundedSyncJson } from '../db/sqlPluginAdapter';
import { getTursoClient, probeOnline } from './tursoClient';
import { getCloudCredentials } from './keychain';
import { db as dexieDb } from '../db/database';
import { ALL_REMOTE_SYNC_TABLES, assertValidSyncTable, applyRemoteMigrations } from './remoteSchema';
import { applyGenericRemoteRow } from './genericApply';
import { resetStaleInflightOutbox } from './outboxFlusher';
import type { Client, InValue } from '@libsql/client';
import type Database from '@tauri-apps/plugin-sql';
import type { OutboxRow, SyncStatus, SyncEventLog, PullTouchSummary } from './types';
import type { Product } from '../types/pos';
import { newId } from '../utils/ids';
import { withWriteLock } from '../db/writeMutex';
import { withBusyRetry } from '../db/busyRetry';

/**
 * Additive sync-visibility extension (SyncStatus itself lives in
 * sync/types.ts, owned by another agent, so it is extended — never edited).
 * `attentionCount` (failed + inflight) is the number the status badge reads
 * for silent divergence; `pendingCount` keeps its pending-only semantics.
 */
export interface SyncStatusExt extends SyncStatus {
  attentionCount: number;
  inflightCount: number;
  enqueueFailedCount: number;
  /** Last relay WebSocket failure (DNS/CONN/refused) — empty when connected. */
  relayLastError?: string;
  /** Tables whose pull cursor has stalled on repeated apply failures (C6). */
  stuckTables?: string[];
}

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
  credit_voucher: 'credit_vouchers',
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
  credit_vouchers: { dexie: 'creditVouchers', ts: ['createdAt', 'updatedAt'] },
  // FIFO batches are pulled (ALL_REMOTE_SYNC_TABLES) and applied through the
  // shared generic path (applyGenericRemoteRow mirrors SQLite + Dexie + clock).
  // Without this entry applyRemoteRow fell through with no write while the
  // cursor still advanced past the row — peer depletions never converged (C6).
  stock_batches: { dexie: 'stockBatches', ts: ['updatedAt'] },
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

/** Best-effort version stamp of an outbox payload for diagnostics (never throws). */
function payloadVersionOf(op: { payload_json?: unknown }): number | string {
  try {
    const p = typeof op.payload_json === 'string' ? JSON.parse(op.payload_json) : op.payload_json;
    const v = (p as Record<string, unknown> | null)?.version;
    return typeof v === 'number' ? v : '?';
  } catch {
    return '?';
  }
}

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
// Adaptive: while the outbox is idle and the last cycle was clean, stretch the
// poll (fewer Turso reads, same C1 path via notifyLocalWrite's 500ms debounce).
// Any pending row or error snaps the interval back to the 5s/6s baseline.
const PUSH_MS_BASE = 5_000;
const PULL_MS_BASE = () => (isMobileView() ? 6_000 : 5_000);
const PUSH_MS_IDLE = 15_000;
const PULL_MS_IDLE = 15_000;
const PUSH_MS = () => PUSH_MS_BASE;
const PULL_MS = () => PULL_MS_BASE();

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
  private inflightCount = 0;
  private enqueueFailureCount = 0;
  /** table → consecutive pull apply failures; ≥3 = cursor stall (surfaced). */
  private applyFailStreak = new Map<string, number>();
  /** Keys this pushOnce cycle claimed as inflight (rescued in finally on abort). */
  private claimedInflightKeys: string[] = [];
  // Start-generation counter: every start() mints a new generation and every
  // async continuation bails when it is stale, so a slow earlier start can
  // never stop() — and kill — a newer start's timers/relay/listeners.
  private startGeneration = 0;
  private lastPushAt: string | null = null;
  private lastPullAt: string | null = null;
  private lastError: string | null = null;
  private quotaExceeded = false;
  // Device registry / revocation (ad.md §15): the merchant can revoke a lost
  // device from any other device. Revocation is enforced three ways — the
  // relay drops the socket and withholds signals, and THIS client suspends
  // its own push/pull and persists the flag so a restart cannot resurrect it.
  // Local sales data is never wiped; queued outbox rows stay pending.
  private deviceRevoked = false;
  private merchantRoomName = 'default';
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
      : newId('inst');
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
    const s: SyncStatusExt = {
      online: this.online,
      pushing: this.pushing,
      pulling: this.pulling,
      pendingCount: this.pendingCount,
      failedCount: this.failedCount,
      // Silent-divergence visibility: quarantined (failed) + stuck-inflight
      // rows that pendingCount alone would hide from the badge.
      attentionCount: this.failedCount + this.inflightCount,
      inflightCount: this.inflightCount,
      enqueueFailedCount: this.enqueueFailureCount,
      stuckTables: [...this.applyFailStreak.entries()]
        .filter(([, n]) => n >= 3)
        .map(([t]) => t),
      relayConnected: isRelayOpen,
      relayLastError: this.relayLastError || (
        Date.now() < this.relayCircuitOpenUntil
          ? `relay DNS en pause — reconnexion dans ${Math.max(0, Math.ceil((this.relayCircuitOpenUntil - Date.now()) / 60_000))} min`
          : ''
      ),
      lastPushAt: this.lastPushAt,
      lastPullAt: this.lastPullAt,
      lastError: this.lastError,
      quotaExceeded: this.quotaExceeded,
      deviceRevoked: this.deviceRevoked,
    };
    this.listeners.forEach((fn) => { try { fn(s); } catch { /* ignore */ } });
  }

  /**
   * Records a fire-and-forget sync-enqueue failure (base.ts fireSync lane).
   * Previously these vanished into console.warn — now they surface in the
   * emitted status (enqueueFailedCount) and the diagnostics log.
   */
  noteEnqueueFailure(entity: string, id: string, error: unknown): void {
    this.enqueueFailureCount += 1;
    const msg = `Sync enqueue failed [${entity}/${id}]: ${error instanceof Error ? error.message : String(error)}`;
    this.lastError = msg;
    this.logEvent('error', msg, 'warn', { entity, id });
    this.emit();
  }

  logEvent(type: SyncEventLog['type'], summary: string, level: SyncEventLog['level'] = 'info', details?: Record<string, unknown>) {
    const entry: SyncEventLog = {
      id: newId('log'),
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
    // Generation gate: a stale start's async continuations must never run the
    // stop()/timer/relay setup below after a newer start took over.
    const gen = ++this.startGeneration;
    this.deviceId = deviceId;
    this.instanceId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : newId('inst');
    this.clockSkewChecked = false;
    this.stop();

    // B-022 / C6: rescue orphaned inflight rows BEFORE the creds gate —
    // a crashed push must re-queue even when cloud credentials are absent
    // (offline first boot, token cleared). Blanket reset covers age-0 rows
    // left by a just-killed process; stale >30min rows are the same class.
    try {
      const bootDb = await getLocalDb();
      await bootDb.execute("UPDATE sync_outbox SET status='pending' WHERE status='inflight'");
    } catch {
      /* first run / db not ready yet */
    }
    if (gen !== this.startGeneration) return;

    // Check if cloud credentials exist
    const creds = await getCloudCredentials();
    if (gen !== this.startGeneration) return;
    if (!creds || !creds.url || !creds.token) {
      return;
    }

    await this.refreshPendingCount();
    if (gen !== this.startGeneration) return;

    this.stop(); // Clean up any existing listeners/timers before starting

    this.onOnlineHandler = () => {
      this.online = true;
      this.consecutiveProbeFailures = 0;
      this.emit();
      // B-062b: network flapped — DNS may work now; reopen relay circuit early.
      this.resetRelayDnsCircuit('online');
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
        // B-062b: user-facing focus is a good moment to re-probe a paused relay.
        this.resetRelayDnsCircuit('visible');
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
    this.merchantRoomName = merchantRoom;

    const relayWsUrl = (typeof import.meta !== 'undefined' && (import.meta.env?.VITE_RELAY_WS_URL as string | undefined))
      || `wss://relay.mobipos.app/room/${merchantRoom}`;
    // B-062: skip relay WebSocket if the host is dead — avoids
    // the first 3 never-OPEN attempts that would log ERR_NAME_NOT_RESOLVED.
    if (await this.relayHostResolves(relayWsUrl)) {
      this.connectRelay(relayWsUrl);
    } else {
      this.relayLastError = 'relay DNS unreachable — polling mode';
      this.emit();
    }

    // Re-check a persisted revocation (a revoked device must not resume sync
    // silently) and converge with the room registry when reachable.
    await this.loadPersistedRevocation();
    if (gen !== this.startGeneration) return;
    void this.checkRevocation();

    void this.kick();
    // One-shot clock-skew probe: cursor sync keys on updated_at wall clocks,
    // so a device >10s off its peer can permanently miss the peer's rows.
    void this.checkClockSkewOnce();
  }

  private clockSkewChecked = false;
  /**
   * Adaptive poll: stretch idle cycles to 15s (fewer Turso reads) and snap
   * back to the 5s/6s baseline whenever there is work or a recent error.
   * C1 is unaffected — notifyLocalWrite still debounces 500ms → pushOnce.
   */
  private async rearmTimersIfNeeded(): Promise<void> {
    if (!this.pushTimer && !this.pullTimer) return;
    try {
      await this.refreshPendingCount();
    } catch { /* keep current intervals */ }
    const busy = this.pendingCount > 0 || this.failedCount > 0 || this.inflightCount > 0
      || Boolean(this.lastError) || this.quotaExceeded;
    const pushMs = busy ? PUSH_MS_BASE : PUSH_MS_IDLE;
    const pullMs = busy ? PULL_MS_BASE() : PULL_MS_IDLE;
    if (this.pushTimer) {
      window.clearInterval(this.pushTimer);
      this.pushTimer = window.setInterval(() => { void this.pushOnce(); }, pushMs);
    }
    if (this.pullTimer) {
      window.clearInterval(this.pullTimer);
      this.pullTimer = window.setInterval(() => { void this.pullOnce(); }, pullMs);
    }
  }

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
    if (this.relayCircuitTimer !== null) window.clearTimeout(this.relayCircuitTimer);
    this.relayCircuitTimer = null;
    this.relayCircuitOpenUntil = 0;
    this.relayNeverOpenedStreak = 0;
    this.relayCircuitLogged = false;
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
  /** B-062: last relay failure message (DNS/CONN) for honest badge text. */
  private relayLastError: string = '';
  /** B-062: throttle diagnostics spam — one event every Nth consecutive failure. */
  private relayFailCount = 0;
  private readonly RELAY_LOG_EVERY = 8;
  /**
   * B-062b: consecutive connect failures that never reached OPEN
   * (classic ERR_NAME_NOT_RESOLVED / refused). After this many, stop
   * calling `new WebSocket()` — the browser itself logs every attempt to
   * the DevTools console and no app-level throttle can suppress that.
   */
  private relayNeverOpenedStreak = 0;
  private readonly RELAY_DNS_STREAK_LIMIT = 3;
  /** While Date.now() < this, connectRelay is a no-op (DNS circuit open). */
  private relayCircuitOpenUntil = 0;
  private readonly RELAY_DNS_PAUSE_MS = 5 * 60_000;
  private relayCircuitLogged = false;
  /** Timer that reopens the DNS circuit when the pause expires (no online/visibility event). */
  private relayCircuitTimer: number | null = null;

  /**
   * B-062b: DNS preflight — if the relay host does not resolve,
   * skip the WebSocket entirely on boot so the browser never logs
   * ERR_NAME_NOT_RESOLVED. Polling (Turso) stays active.
   */
  private async relayHostResolves(url: string): Promise<boolean> {
    try {
      const host = new URL(url).hostname;
      if (!host || host === 'localhost') return true;
      const ctrl = new AbortController();
      const tid = window.setTimeout(() => ctrl.abort(), 3_000);
      await fetch(`https://${host}/`, {
        method: 'HEAD',
        mode: 'no-cors',
        signal: ctrl.signal,
      });
      window.clearTimeout(tid);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * B-062b: reopen the DNS circuit on network return / tab focus so a
   * redeployed relay or fixed DNS is picked up without waiting the full pause.
   */
  private resetRelayDnsCircuit(reason: string): void {
    if (this.relayCircuitOpenUntil === 0 && !this.relayCircuitLogged) return;
    const wasOpen = this.relayCircuitOpenUntil > Date.now();
    this.relayCircuitOpenUntil = 0;
    this.relayNeverOpenedStreak = 0;
    this.relayCircuitLogged = false;
    if (this.relayCircuitTimer !== null) {
      window.clearTimeout(this.relayCircuitTimer);
      this.relayCircuitTimer = null;
    }
    if (wasOpen) {
      this.logEvent('pull', `Relay circuit réouvert (${reason}) — nouvelle tentative`, 'info');
      this.emit();
      if (this.savedRelayWsUrl) {
        void this.connectRelay(this.savedRelayWsUrl);
      }
    }
  }

  /** Open the DNS circuit for RELAY_DNS_PAUSE_MS and arm the reopen timer. */
  private openRelayDnsCircuit(gen: number): void {
    this.relayCircuitOpenUntil = Date.now() + this.RELAY_DNS_PAUSE_MS;
    this.relayLastError = `relay DNS unreachable — pause ${Math.round(this.RELAY_DNS_PAUSE_MS / 60_000)} min (polling actif)`;
    if (!this.relayCircuitLogged) {
      this.relayCircuitLogged = true;
      this.logEvent(
        'pull',
        `Signal relay injoignable (DNS) après ${this.relayNeverOpenedStreak} tentatives — reconnexion dans ${Math.round(this.RELAY_DNS_PAUSE_MS / 60_000)} min. Déployer workers/relay ou définir VITE_RELAY_WS_URL. Polling Turso reste actif.`,
        'warn'
      );
    }
    if (this.relayCircuitTimer !== null) window.clearTimeout(this.relayCircuitTimer);
    this.relayCircuitTimer = window.setTimeout(() => {
      this.relayCircuitTimer = null;
      if (gen !== this.startGeneration) return;
      this.relayCircuitOpenUntil = 0;
      this.relayNeverOpenedStreak = 0;
      this.relayCircuitLogged = false;
      if (this.savedRelayWsUrl) {
        this.logEvent('pull', 'Relay circuit expiré — nouvelle tentative', 'info');
        this.emit();
        void this.connectRelay(this.savedRelayWsUrl);
      }
    }, this.RELAY_DNS_PAUSE_MS + Math.random() * 5_000);
    this.emit();
  }

  connectRelay(relayWsUrl: string) {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
    // B-062b: DNS circuit open — do not construct WebSocket (browser would
    // log ERR_NAME_NOT_RESOLVED again). Polling continues in the background.
    if (Date.now() < this.relayCircuitOpenUntil) return;
    // Pin the reconnect loop to this start-generation so a stale socket's
    // backoff cannot resurrect a relay session after a newer start stopped it.
    const gen = this.startGeneration;
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
        this.relayFailCount = 0;
        this.relayNeverOpenedStreak = 0;
        this.relayCircuitOpenUntil = 0;
        const wasCircuit = this.relayCircuitLogged;
        this.relayCircuitLogged = false;
        const wasFailing = this.relayLastError !== '';
        this.relayLastError = '';
        if (wasCircuit || wasFailing) {
          this.logEvent('pull', 'Signal relay WebSocket reconnecté', 'info');
        } else {
          this.logEvent('pull', 'Signal relay WebSocket connecté avec succès', 'info');
        }
        this.emit();
        // Register this device in the merchant room registry (name/platform
        // for the merchant's device list; the room replies `welcome`, or
        // `device-revoked` when this device was revoked).
        try {
          this.relaySocket?.send(JSON.stringify({
            type: 'hello',
            epoch: this.relayEpoch,
            deviceId: this.deviceId,
            instanceId: this.instanceId,
            deviceName: this.localDeviceLabel(),
            platform: this.localDevicePlatform(),
          }));
        } catch { /* hello is best-effort; polling still works */ }
      };

      this.relaySocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data?.type === 'ping') return;
          if (data?.type === 'welcome') {
            this.relayEpoch = Math.max(this.relayEpoch, Number(data?.epoch || 0));
            return;
          }
          if (data?.type === 'device-revoked') {
            void this.handleDeviceRevoked(data);
            return;
          }
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

      // B-003: explicit onerror — without it browser default logging fires
      // and no epoch-guarded reconnect bookkeeping runs before onclose.
      // B-062: DNS failure (ERR_NAME_NOT_RESOLVED) fires onerror then onclose
      // on every attempt; log only every Nth consecutive failure so a missing
      // relay host cannot flood the 200-entry diagnostics ring.
      this.relaySocket.onerror = () => {
        this.relayFailCount += 1;
        this.relayLastError = 'relay unreachable (DNS/network)';
        if (this.relayFailCount === 1 || this.relayFailCount % this.RELAY_LOG_EVERY === 0) {
          this.logEvent(
            'pull',
            `Signal relay WebSocket error (attempt ${this.relayFailCount}) — polling active`,
            'warn'
          );
          this.emit();
        }
      };

      this.relaySocket.onclose = (ev) => {
        this.relaySocket = null;
        this.relayFailCount += 1;
        // Prefer the CloseEvent reason when present (Worker may send one).
        if (ev && typeof ev.reason === 'string' && ev.reason) {
          this.relayLastError = ev.reason.slice(0, 160);
        }
        // B-062b: closed before ever OPEN → DNS/refused. After a short streak
        // open the circuit so the browser stops logging ERR_NAME_NOT_RESOLVED
        // every reconnect (no app-level throttle can suppress that log).
        this.relayNeverOpenedStreak += 1;
        if (this.relayNeverOpenedStreak >= this.RELAY_DNS_STREAK_LIMIT) {
          this.openRelayDnsCircuit(gen);
          return;
        }
        if (this.savedRelayWsUrl) {
          if (this.relayReconnectTimeout) window.clearTimeout(this.relayReconnectTimeout);
          this.relayReconnectAttempts = Math.min(this.relayReconnectAttempts + 1, 16);
          // B-062: DNS-level failures (ERR_NAME_NOT_RESOLVED / host not
          // deployed) do not heal by retrying fast — stretch the backoff
          // harder after the first few misses, still capped at 60s so a
          // redeployed relay is picked up within a minute.
          const baseMs = Math.min(
            60_000,
            2_000 * Math.pow(1.6, this.relayReconnectAttempts)
          );
          const jitterMs = Math.random() * 1_500;
          const backoff = baseMs + jitterMs;
          if (
            this.relayFailCount === 1 ||
            this.relayFailCount % this.RELAY_LOG_EVERY === 0
          ) {
            this.logEvent(
              'pull',
              `Signal relay fermé — reconnexion dans ${Math.round(backoff / 1000)}s (polling actif)`,
              'warn'
            );
            this.emit();
          }
          this.relayReconnectTimeout = window.setTimeout(() => {
            if (gen !== this.startGeneration) return;
            if (this.savedRelayWsUrl) {
              void this.connectRelay(this.savedRelayWsUrl);
            }
          }, backoff);
        }
      };
    } catch (e) {
      this.relayLastError = e instanceof Error ? e.message : String(e);
      console.warn('Relay connection error:', e);
      this.emit();
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
      // Stuck-inflight rows (push killed mid-batch) are silent divergence:
      // pendingCount keeps its pending-only semantics, attentionCount carries
      // failed + inflight to the badge.
      const inflightRows = (await db.select(
        "SELECT COUNT(*) as n FROM sync_outbox WHERE status='inflight'"
      ).catch(() => [{ n: 0 }])) as Array<{ n: number }>;
      this.inflightCount = inflightRows?.[0]?.n ?? 0;
    } catch {
      this.pendingCount = 0;
      this.failedCount = 0;
      this.inflightCount = 0;
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

  // ── Merchant device registry / revocation (ad.md §15) ──────────────
  // The room URL itself is the bearer secret (same model as the signal room);
  // the registry answers "which devices exist" and "which are revoked".

  private localDeviceLabel(): string {
    try {
      if (typeof navigator !== 'undefined') {
        const ua = String(navigator.userAgent || '');
        if (/Android/i.test(ua)) return 'Android';
        if (/iPhone|iPad/i.test(ua)) return 'iPhone/iPad';
        if (/Windows/i.test(ua)) return 'Windows';
        if (/Mac/i.test(ua)) return 'Mac';
        if (/Linux/i.test(ua)) return 'Linux';
      }
    } catch { /* ignore */ }
    return 'Caisse';
  }

  private localDevicePlatform(): string {
    try {
      if (typeof navigator !== 'undefined') {
        const ua = String(navigator.userAgent || '');
        if (/Android/i.test(ua)) return 'android';
        if (/iPhone|iPad/i.test(ua)) return 'ios';
        if (/Windows/i.test(ua)) return 'windows';
        if (/Mac/i.test(ua)) return 'macos';
        if (/Linux/i.test(ua)) return 'linux';
      }
    } catch { /* ignore */ }
    return 'unknown';
  }

  private relayHttpBase(): string | null {
    const ws = this.savedRelayWsUrl
      || (typeof import.meta !== 'undefined' && (import.meta.env?.VITE_RELAY_WS_URL as string | undefined))
      || null;
    if (!ws) return `https://relay.mobipos.app/room/${this.merchantRoomName}`;
    try {
      const u = new URL(ws);
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
      u.pathname = `/room/${this.merchantRoomName}`;
      u.search = '';
      return u.toString().replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  /**
   * B-042: admin secret for device registry routes. Mirrors the Worker's
   * `ADMIN_SECRET` (wrangler secret). Missing secret → routes return 503.
   */
  private relayAdminHeaders(): Record<string, string> {
    const secret = (typeof import.meta !== 'undefined' && (import.meta.env?.VITE_RELAY_ADMIN_SECRET as string | undefined)) || '';
    if (!secret) return {};
    return { Authorization: `Bearer ${secret}` };
  }

  /** Merchant device list for the Diagnostics screen (revoked flags included). */
  async listMerchantDevices(): Promise<Array<{ deviceId: string; deviceName: string; platform: string; firstSeen: number; lastSeen: number; revoked: boolean }>> {
    const base = this.relayHttpBase();
    if (!base) return [];
    try {
      const res = await fetch(`${base}/devices`, { headers: this.relayAdminHeaders() });
      if (!res.ok) return [];
      const body = (await res.json()) as { devices?: Array<{ deviceId: string; deviceName: string; platform: string; firstSeen: number; lastSeen: number; revoked: boolean }> };
      return Array.isArray(body?.devices) ? body.devices : [];
    } catch {
      return [];
    }
  }

  /** Revoke (or re-admit) a device. Takes effect on next signal + next check. */
  async setDeviceRevoked(deviceId: string, revoked: boolean): Promise<boolean> {
    const base = this.relayHttpBase();
    const id = String(deviceId || '');
    if (!base || !id) return false;
    try {
      const res = await fetch(`${base}/devices/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.relayAdminHeaders() },
        body: JSON.stringify({ revoked }),
      });
      if (!res.ok) return false;
      this.logEvent('info', `Appareil ${id} ${revoked ? 'révoqué' : 'réadmis'}`, 'info');
      return true;
    } catch {
      return false;
    }
  }
  private async loadPersistedRevocation(): Promise<void> {
    try {
      const db = await getLocalDb();
      const rows = (await db.select(
        "SELECT value_json FROM app_settings WHERE key = 'sync.device_revoked'"
      ).catch(() => [])) as Array<{ value_json: string }>;
      if (rows?.[0]?.value_json) {
        const flag = JSON.parse(rows[0].value_json) as { revoked?: boolean };
        if (flag?.revoked === true) {
          this.deviceRevoked = true;
          this.lastError = 'Cet appareil a été révoqué par le gérant — synchronisation suspendue.';
        }
      }
    } catch { /* first run */ }
    this.emit();
  }

  private async persistRevocation(revoked: boolean): Promise<void> {
    try {
      const db = await getLocalDb();
      await db.execute(
        "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES ('sync.device_revoked', ?, ?)",
        [JSON.stringify({ revoked, at: utcNowIso() }), utcNowIso()],
      ).catch(() => {});
    } catch { /* persistence best-effort; the in-memory flag still enforced */ }
  }

  /** Room → this device: enforce a revocation (or clear it on un-revoke). */
  private async handleDeviceRevoked(msg: { deviceId?: string; revoked?: boolean }): Promise<void> {
    const target = String(msg?.deviceId || '');
    const revoked = msg?.revoked !== false;
    if (target && target !== this.deviceId) {
      // Peer event — surfaces in the merchant device list on next fetch.
      this.logEvent('info', `Appareil ${target} ${revoked ? 'révoqué' : 'réadmis'} par le gérant`, 'info');
      return;
    }
    if (!revoked) {
      if (!this.deviceRevoked) return;
      this.deviceRevoked = false;
      await this.persistRevocation(false);
      this.lastError = null;
      this.logEvent('push', 'Cet appareil a été réadmis — reprise de la synchronisation', 'success');
      this.emit();
      void this.kick();
      return;
    }
    if (this.deviceRevoked) return;
    this.deviceRevoked = true;
    await this.persistRevocation(true);
    this.lastError = 'Cet appareil a été révoqué par le gérant — synchronisation suspendue. Les ventes locales restent disponibles.';
    this.logEvent('error', this.lastError, 'error');
    // Drop the signal channel without reconnecting; queued outbox rows stay
    // pending locally (never wiped, never pushed).
    this.savedRelayWsUrl = null;
    if (this.relayReconnectTimeout) window.clearTimeout(this.relayReconnectTimeout);
    this.relayReconnectTimeout = null;
    if (this.relaySocket) {
      try { this.relaySocket.close(); } catch { /* ignore */ }
      this.relaySocket = null;
    }
    await this.refreshPendingCount();
    this.emit();
  }

  /** Converge local revocation state with the room registry (boot + manual). */
  async checkRevocation(): Promise<void> {
    try {
      const devices = await this.listMerchantDevices();
      const mine = devices.find((d) => d.deviceId === this.deviceId);
      if (!mine) return;
      if (mine.revoked && !this.deviceRevoked) {
        await this.handleDeviceRevoked({ deviceId: this.deviceId, revoked: true });
      } else if (!mine.revoked && this.deviceRevoked) {
        await this.handleDeviceRevoked({ deviceId: this.deviceId, revoked: false });
      }
    } catch { /* offline — revocation state stays as-is */ }
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

  /**
   * One-shot remote migration per session. Devices paired before a lane
   * existed (stock_batches, credit_vouchers, …) carry a cloud DB without
   * those tables, and every pull/push for them failed forever with
   * `no such table`. Version-tracked server-side (schema_migrations), so
   * steady-state cost is two cheap reads; ends with the column backfill.
   * Failures retry at most once a minute so a sick cloud doesn't spam
   * migrations (or console warnings) on every 10s sync cycle.
   */
  private remoteSchemaRetryAt = 0;
  private async ensureRemoteSchemaOnce(remote: Client): Promise<void> {
    if (this.remoteSchemaEnsured) return;
    if (Date.now() < this.remoteSchemaRetryAt) return;
    try {
      await applyRemoteMigrations(remote);
      this.remoteSchemaEnsured = true;
    } catch (err) {
      this.remoteSchemaRetryAt = Date.now() + 60_000;
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[SyncManager] Remote migration deferred, retry in 60s: ${detail}`);
      throw err;
    }
  }

  async pushOnce(forceOnline = false) {
    if (this.pushing) return;
    // Revoked devices neither push nor pull (ad.md §15). Local writes keep
    // queueing in sync_outbox; they ship if the merchant re-admits the device.
    if (this.deviceRevoked) return;
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
    this.claimedInflightKeys = [];
    this.emit();

    try {
      // Mid-session C6 rescue: a previous pushOnce that died between
      // markOutboxMany(inflight) and its finally leaves rows invisible to
      // getPendingOutbox forever (only pending is selectable). Boot already
      // blanket-resets; this runs every cycle so a mid-session crash heals
      // without restart. Age 0 = any inflight row older than "just claimed
      // by THIS cycle" — claimedInflightKeys is empty on entry, so anything
      // still inflight is orphaned.
      const rescued = await resetStaleInflightOutbox(0);
      if (rescued > 0) {
        this.logEvent('push', `Rescued ${rescued} orphaned inflight outbox row(s)`, 'warn');
      }

      const batch = (await getPendingOutbox(50)) as unknown as OutboxRow[];
      if (batch.length === 0) {
        await this.refreshPendingCount();
        return;
      }

      // Parent-first order: product -> customer -> order -> items/ledger.
      // Within a rank, FIFO by created_at (rowid tiebreak) so a sale row
      // always pushes before its later refund-status update regardless of
      // fetch order. A refund applied before its sale exists would orphan
      // the peer's ledger — ordering here is the choke point that prevents it.
      const rank: Record<string, number> = {
        product: 0, customer: 0, order: 1, order_item: 2, ledger: 2,
      };
      batch.sort(
        (a, b) =>
          (rank[a.entity_type] ?? 9) - (rank[b.entity_type] ?? 9) ||
          (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.rowid ?? 0) - (b.rowid ?? 0))
      );

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
          await this.ensureRemoteSchemaOnce(remote);
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
          this.claimedInflightKeys = batchKeys;
          const batchResults = (await remote.batch(validOps.map((v) => v.stmt), 'write')) as Array<{ rowsAffected?: number }>;
          // Guarded-upsert truth (C6): a `WHERE excluded.version >= X.version`
          // upsert that matches 0 rows is a REJECTED stale edit, not a success.
          // The old code marked it synced and deleted it — silent loss. Stale
          // rows stay pending with an actionable error (quarantined after 10
          // retries like any other failure) and trigger a pull so the device
          // converges to the winning version instead of diverging quietly.
          // `DO NOTHING` lanes (ledger/order_item replays) legitimately affect
          // 0 rows on duplicates, so only guarded statements are checked.
          const syncedKeys: string[] = [];
          let guardStale = 0;
          for (let i = 0; i < validOps.length; i++) {
            const { op, stmt } = validOps[i];
            const guarded = stmt.sql.includes('WHERE excluded.version');
            const affected = Number(batchResults?.[i]?.rowsAffected ?? 1);
            if (guarded && affected === 0) {
              guardStale++;
              await markOutbox(op.idempotency_key, {
                status: 'pending',
                retryCount: (op.retry_count ?? 0) + 1,
                error: `[GUARD-STALE] ${op.entity_type}/${op.entity_id}: remote is newer (local v${payloadVersionOf(op)} rejected). Pulled latest — review in Sync Diagnostics.`,
              });
            } else {
              syncedKeys.push(op.idempotency_key);
            }
          }
          if (syncedKeys.length > 0) {
            await markOutboxMany(syncedKeys, { status: 'synced' });
          }
          okCount = syncedKeys.length;
          if (guardStale > 0) {
            this.logEvent('push', `${guardStale} modification(s) rejetée(s) par le garde de version — convergence tirée du cloud`, 'warn');
            void this.pullOnce();
          }
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
              await this.ensureRemoteSchemaOnce(remote);
            } catch {
              // ignore
            }
          }
          console.warn('[SyncManager] Batch push failed, falling back to item-by-item write:', rawMsg);
        }

        if (!batchSucceeded) {
          let fallbackStale = 0;
          for (const { op, stmt } of validOps) {
            try {
              const res = (await remote.execute(stmt)) as unknown as { rowsAffected?: number };
              // Same guard-reject rule as the batch path: a guarded upsert
              // matching 0 rows stays pending with an actionable error.
              if (stmt.sql.includes('WHERE excluded.version') && Number(res?.rowsAffected ?? 1) === 0) {
                fallbackStale++;
                await markOutbox(op.idempotency_key, {
                  status: 'pending',
                  retryCount: (op.retry_count ?? 0) + 1,
                  error: `[GUARD-STALE] ${op.entity_type}/${op.entity_id}: remote is newer (local v${payloadVersionOf(op)} rejected). Pulled latest — review in Sync Diagnostics.`,
                });
                continue;
              }
              await markOutbox(op.idempotency_key, { status: 'synced' });
              okCount++;
            } catch (e: unknown) {
              let rawMsg = e instanceof Error ? e.message : String(e);
              if (rawMsg.includes('has no column') || rawMsg.includes('no column named') || rawMsg.includes('no such column')) {
                try {
                  await this.ensureRemoteSchemaOnce(remote);
                  const healRes = (await remote.execute(stmt)) as unknown as { rowsAffected?: number };
                  if (stmt.sql.includes('WHERE excluded.version') && Number(healRes?.rowsAffected ?? 1) === 0) {
                    fallbackStale++;
                    await markOutbox(op.idempotency_key, {
                      status: 'pending',
                      retryCount: (op.retry_count ?? 0) + 1,
                      error: `[GUARD-STALE] ${op.entity_type}/${op.entity_id}: remote is newer (local v${payloadVersionOf(op)} rejected). Pulled latest — review in Sync Diagnostics.`,
                    });
                    continue;
                  }
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
          if (fallbackStale > 0) {
            this.logEvent('push', `${fallbackStale} modification(s) rejetée(s) par le garde de version — convergence tirée du cloud`, 'warn');
            void this.pullOnce();
          }
        }
        // Batch/fallback resolved every claimed key (synced/pending/failed).
        // Clear the claim list so finally does not re-queue already-resolved work.
        this.claimedInflightKeys = [];
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
      // C6: keys this cycle claimed that are STILL inflight after the run
      // (aborted mid-batch) must return to pending — getPendingOutbox only
      // selects pending, so a stuck inflight row is invisible until reboot.
      // WHERE status='inflight' keeps rows already resolved to pending/
      // failed/synced untouched (backoff + quarantine preserved).
      if (this.claimedInflightKeys.length > 0) {
        try {
          const still = this.claimedInflightKeys;
          this.claimedInflightKeys = [];
          const db = await getLocalDb();
          const now = utcNowIso();
          const err = `push aborted: ${this.lastError ?? 'unknown'}`;
          for (let i = 0; i < still.length; i += 500) {
            const chunk = still.slice(i, i + 500);
            const ph = chunk.map(() => '?').join(',');
            await db.execute(
              `UPDATE sync_outbox SET status='pending', last_error=?, updated_at=?
               WHERE status='inflight' AND idempotency_key IN (${ph})`,
              [err, now, ...chunk],
            );
          }
          this.logEvent('push', `Re-queued still-inflight rows after push abort`, 'warn');
        } catch {
          // Next cycle's resetStaleInflightOutbox(0) is the safety net.
        }
      }
      this.pushing = false;
      this.emit();
      void this.rearmTimersIfNeeded();
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

    // H27: stock_batches is a first-class sync table whose remote shape is
    // BOTH the generic KV pair AND real FIFO columns. The generic branch
    // below CANNOT handle it: the remote table declares
    // `product_id TEXT NOT NULL` with no default and the KV path writes no
    // real columns (proven: NOT NULL constraint failed). It also conflicts
    // on `ON CONFLICT(id)` and v6's `id` has no UNIQUE constraint. So
    // conflict on the real PK `batch_id`, write both the real columns and
    // the KV pair, and keep the version guard so isGuardedUpsert()
    // classifies this statement (H14 re-queue on rowsAffected === 0).
    if (op.entity_type === 'stock_batches') {
      assertValidSyncTable('stock_batches');
      const batchId = String(payload.batch_id ?? payload.batchId ?? op.entity_id ?? '');
      return {
        sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
          received_at, purchase_order_id, device_id, idempotency_key, sync_status, version,
          created_at, updated_at, id, data_json, deleted)
          VALUES (?,?,?,?,?,?,?,?,'synced',?,?,?,?,?,?)
          ON CONFLICT(batch_id) DO UPDATE SET
            product_id=excluded.product_id, quantity_remaining=excluded.quantity_remaining,
            unit_cost=excluded.unit_cost, received_at=excluded.received_at,
            purchase_order_id=excluded.purchase_order_id, device_id=excluded.device_id,
            idempotency_key=excluded.idempotency_key, sync_status='synced',
            version=excluded.version, updated_at=excluded.updated_at,
            deleted=excluded.deleted, id=excluded.id, data_json=excluded.data_json
            WHERE excluded.version >= stock_batches.version`,
        args: [
          v(batchId),
          v(payload.product_id ?? payload.productId ?? 'unknown'),
          v(Number(payload.quantity_remaining ?? payload.quantityRemaining ?? 0)),
          v(Number(payload.unit_cost ?? payload.unitCost ?? 0)),
          v(payload.received_at ?? payload.receivedAt ?? now),
          v(payload.purchase_order_id ?? payload.purchaseOrderId ?? null),
          v(payload.device_id ?? this.deviceId ?? 'default'),
          v(op.idempotency_key ?? payload.idempotency_key ?? payload.idempotencyKey ?? `idem-${batchId}`),
          v(version || 1),
          v(payload.created_at ?? payload.createdAt ?? now),
          v(now),
          v(batchId),
          v(toBoundedSyncJson(payload ?? {})),
          v(Number(payload.deleted ?? 0)),
        ],
      };
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
          v(payload.id ?? op.entity_id ?? newId('led')), v(prodId), v(Number(payload.delta ?? 0)),
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
    if (this.deviceRevoked) return 0;
    if (!(await this.ensureOnline(forceOnline))) return 0;

    const creds = await getCloudCredentials();
    if (!creds) return 0;

    this.pulling = true;
    this.emit();

    let totalPulled = 0;
    try {
      const remote = await getTursoClient();
      const db = await getLocalDb();

      // The schema gate must also run on the pull path: a device with an
      // empty outbox returns from pushOnce before migrating, and would
      // otherwise fail these queries forever on pre-lane cloud DBs.
      if (!this.remoteSchemaEnsured) {
        try {
          await this.ensureRemoteSchemaOnce(remote);
        } catch (schemaErr) {
          console.warn('[SyncManager] Remote schema check warning (pull):', schemaErr);
        }
      }

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
          const chunk = rsRows.slice(c, c + APPLY_CHUNK);
          // Serialized with sales (then retried on BUSY): a pull chunk must
          // not interleave its row writes with a checkout's multi-statement
          // write on the pooled connection, or the sale fails SQLITE_BUSY.
          // Re-application is idempotent (version guards + idempotency keys).
          await withBusyRetry(
            () =>
              withWriteLock(async () => {
                for (const row of chunk) {
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
                    // A clean apply clears the stall streak for this table.
                    if ((this.applyFailStreak.get(table) ?? 0) > 0) {
                      this.applyFailStreak.delete(table);
                    }
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
                    // Cursor-stall detection (C6): three consecutive apply
                    // failures on the same table means the cursor is wedged
                    // behind a poison row — surface it on the status badge
                    // instead of silently never advancing that table again.
                    const streak = (this.applyFailStreak.get(table) ?? 0) + 1;
                    this.applyFailStreak.set(table, streak);
                    if (streak === 3) {
                      this.logEvent('error', `Pull bloqué sur ${table} (${streak} échecs d'application) — curseur non avancé`, 'error');
                      this.lastError = `Pull bloqué sur ${table} — voir Sync Diagnostics`;
                    }
                  }
                }
                if (maxSeenTime !== committedTime || maxSeenId !== committedId) {
                  await this.setTableCursor(db, table, { time: maxSeenTime, id: maxSeenId });
                  committedTime = maxSeenTime;
                  committedId = maxSeenId;
                }
              }),
            { attempts: 4, baseDelayMs: 60, label: `pull-${table}` }
          );
        }

        if (tablePulled > 0) touchedTables.add(table);
      }

      if (totalPulled > 0) {
        this.lastPullAt = utcNowIso();
        // Same-window serializer: the stock recompute + Dexie mirror must not
        // interleave with a concurrent checkout's ledger writes, or the cached
        // products.stock can land between the sale's deltas and its recompute.
        // (Cross-tab serialization is BEGIN IMMEDIATE's job inside the
        // writers; see db/writeMutex.)
        // Retried on BUSY: a collision with a sale in flight delays the
        // mirror, never fails the sale nor drops the pull.
        await withBusyRetry(
          () =>
            withWriteLock(async () => {
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
          // 2b. Debt display convergence: the paid/owed number the merchant
          // sees derives from the customer_debts LEDGER, not from whichever
          // customer row won the last version race. Recompute it from the
          // just-pulled ledger so "paid on PC" reads paid here too — even if
          // the companion customer row is still converging.
          try {
            if (touchedTables.has('customer_debts')) {
              const { reconcileCustomerDebtFromLedger } = await import('../db/sqlPluginAdapter');
              await reconcileCustomerDebtFromLedger();
            }
          } catch (debtErr) {
            console.warn('[sync:pull] reconcileCustomerDebtFromLedger error:', debtErr);
          }
            }),
          { attempts: 4, baseDelayMs: 60, label: 'pull-recompute' },
        );
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
      void this.rearmTimersIfNeeded();
    }
    return totalPulled;
  }

  private async applyRemoteRow(db: Database, table: string, r: Record<string, unknown>) {
    const generic = GENERIC_PULL[table];
    const version = Number(r.version ?? 1);

    if (generic) {
      // H25/H29: generic KV tables go through the ONE shared apply path
      // (SQLite authority + Dexie replica + version clock), exactly like
      // restoreManager. The old inline copy wrote the Dexie replica ONLY and
      // never advanced `entity_keys`, so a row pulled on device B existed in
      // the UI replica but not in the SQLite authority, and the next local
      // edit pushed a version-2 row against a remote version-5 row: the
      // guarded upsert matched 0 rows, the batch still reported success and
      // the outbox row was marked synced — silent loss (C6). A throw here is
      // the desired behaviour: the pull loop catches per-row and holds the
      // cursor behind a failed row instead of advancing past it.
      await applyGenericRemoteRow(db, table, r);
      return;
    }

    if (table === 'inventory_ledger') {
      const ledId = String(r.id || newId('led'));
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
      const txId = String(r.id || newId('txn'));
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
            json_payload=excluded.json_payload, version=excluded.version, updated_at=excluded.updated_at, sync_status='synced',
            deleted=excluded.deleted
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
      const itemId = String(r.id || newId('item'));
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
      const pId = String(r.id || newId('prod'));
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
   * On-demand verification comparing local vs cloud row counts AND content
   * hashes (SHA-256 over sorted id/version/updated_at triples per table).
   * Counts alone can match while rows diverge — the hash catches that.
   */
  async verifyCloudIntegrity(): Promise<{
    verified: boolean;
    report: string;
    details: Array<{ table: string; localCount: number; remoteCount: number; match: boolean; hashMatch?: boolean }>;
  }> {
    const creds = await getCloudCredentials();
    if (!creds) {
      return { verified: false, report: 'Aucun compte cloud configuré.', details: [] };
    }

    const remote = await getTursoClient();
    const local = await getLocalDb();
    const details: Array<{ table: string; localCount: number; remoteCount: number; match: boolean; hashMatch?: boolean }> = [];
    let allMatch = true;

    const digest = async (rows: Array<Record<string, unknown>>): Promise<string> => {
      const sorted = rows
        .map((r) => `${String(r.id ?? r.key ?? '')}|${String(r.version ?? '')}|${String(r.updated_at ?? '')}`)
        .sort()
        .join('\n');
      const enc = new TextEncoder().encode(sorted);
      const buf = await crypto.subtle.digest('SHA-256', enc);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    };

    for (const table of ALL_REMOTE_SYNC_TABLES) {
      assertValidSyncTable(table);
      let localCount = 0;
      let localHash = '';
      if (['products', 'transactions', 'transaction_items', 'inventory_ledger', 'stock_batches'].includes(table)) {
        const idCol = table === 'stock_batches' ? 'batch_id' : 'id';
        const rows = (await local.select(
          `SELECT ${idCol} as id, version, updated_at FROM ${table} WHERE deleted=0 ORDER BY ${idCol}`,
        ).catch(() => [])) as Array<Record<string, unknown>>;
        localCount = rows.length;
        localHash = await digest(rows);
      } else {
        const dexieTable = GENERIC_PULL[table]?.dexie;
        const store = dexieTable ? (dexieDb as unknown as Record<string, { toArray?: () => Promise<Array<Record<string, unknown>>> }>)[dexieTable] : null;
        const rows = store?.toArray ? await store.toArray().catch(() => []) : [];
        localCount = rows.length;
        localHash = await digest(rows.map((r) => ({ id: r.id ?? r.key, version: r.version, updated_at: r.updated_at ?? r.updatedAt })));
      }

      const rRes = await remote.execute(
        `SELECT id, version, updated_at FROM ${table} WHERE deleted=0 ORDER BY id`,
      );
      const remoteRows = rRes.rows.map((r) => r as unknown as Record<string, unknown>);
      const remoteCount = remoteRows.length;
      const remoteHash = await digest(remoteRows);
      const countMatch = localCount === remoteCount;
      const hashMatch = localHash === remoteHash;
      const match = countMatch && hashMatch;
      if (!match) allMatch = false;

      details.push({ table, localCount, remoteCount, match, hashMatch });
    }

    const mismatched = details.filter((d) => !d.match);
    const report = allMatch
      ? `Intégrité validée (counts + SHA-256) sur l'ensemble des ${details.length} tables synchronisées.`
      : `Écart détecté sur ${mismatched.map((d) => d.table).join(', ')}${mismatched.some((d) => d.localCount === d.remoteCount && !d.hashMatch) ? ' (hash divergent malgré counts égaux)' : ''}.`;

    this.logEvent('info', `Vérification d'intégrité exécutée: ${allMatch ? 'Succès' : 'Écart'}`, allMatch ? 'success' : 'warn');

    return { verified: allMatch, report, details };
  }
}

export const syncManager = new SyncManager();

export type { PullTouchSummary };

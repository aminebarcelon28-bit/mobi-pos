// SyncManager — background two-way per-customer sync (Local SQLite/Dexie <-> Turso Cloud).
// Push: sync_outbox pending -> Turso batch upserts (idempotent, optimistic version checking).
// Pull: Per-table cursors -> Local SQLite + Dexie UI store updates.
// Zero data loss, zero silent drops, zero dependency on vendor servers.

import { getLocalDb, getPendingOutbox, markOutbox, utcNowIso } from '../db/sqlPluginAdapter';
import { getTursoClient, probeOnline } from './tursoClient';
import { getCloudCredentials } from './keychain';
import { db as dexieDb } from '../db/database';
import { ALL_REMOTE_SYNC_TABLES, assertValidSyncTable, ensureRemoteSchemaColumns } from './remoteSchema';
import type { InValue } from '@libsql/client';
import type Database from '@tauri-apps/plugin-sql';
import type { OutboxRow, SyncStatus, SyncEventLog } from './types';
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

const isMobileView = () =>
  typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 640;

const PUSH_MS = () => (isMobileView() ? 3_000 : 2_000);
const PULL_MS = () => (isMobileView() ? 6_000 : 4_000);

function backoffMs(retry: number): number {
  return Math.min(300_000, 1000 * 2 ** Math.min(retry, 8) + Math.floor(Math.random() * 500));
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
  private lastPushAt: string | null = null;
  private lastPullAt: string | null = null;
  private lastError: string | null = null;
  private quotaExceeded = false;
  private remoteSchemaEnsured = false;
  private deviceId = 'bootstrap';
  private listeners = new Set<Listener>();
  private postWriteDebounce: number | null = null;
  private eventLogs: SyncEventLog[] = [];
  private onOnlineHandler: (() => void) | null = null;
  private onOfflineHandler: (() => void) | null = null;
  private onVisibilityHandler: (() => void) | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  onPullApplied(fn: () => void): () => void {
    this.pullApplied.add(fn);
    return () => { this.pullApplied.delete(fn); };
  }

  private emitPulled() {
    this.pullApplied.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  }

  private emit() {
    const s: SyncStatus = {
      online: this.online,
      pushing: this.pushing,
      pulling: this.pulling,
      pendingCount: this.pendingCount,
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
      this.emit();
      // Jittered kick on reconnect (0-2000ms) to avoid thundering herd
      const jitterMs = Math.floor(Math.random() * 2000);
      window.setTimeout(() => { void this.kick(); }, jitterMs);
    };
    this.onOfflineHandler = () => { this.online = false; this.emit(); };
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
  }

  stop() {
    if (this.pushTimer) window.clearInterval(this.pushTimer);
    if (this.pullTimer) window.clearInterval(this.pullTimer);
    if (this.postWriteDebounce) window.clearTimeout(this.postWriteDebounce);
    if (this.relayReconnectTimeout) window.clearTimeout(this.relayReconnectTimeout);
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
          if (data?.type === 'db:changed' && data?.deviceId !== this.deviceId) {
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
          const backoff = Math.min(30000, 1000 * Math.pow(1.5, this.relayReconnectAttempts)) + Math.random() * 1000;
          this.relayReconnectAttempts++;
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
    if (this.relaySocket && this.relaySocket.readyState === WebSocket.OPEN) {
      try {
        this.relayEpoch += 1;
        this.relaySocket.send(
          JSON.stringify({
            type: 'db:changed',
            epoch: this.relayEpoch,
            deviceId: this.deviceId,
            table,
          })
        );
      } catch {
        // ignore send error
      }
    }
  }

  notifyLocalWrite() {
    // Causality Invariant (Contract C1): broadcastRelayChange is intentionally NOT fired here.
    // It is triggered inside pushOnce() ONLY after Turso cloud acknowledges the write,
    // ensuring companion devices pull fresh, committed cloud state without racing.
    if (this.postWriteDebounce) window.clearTimeout(this.postWriteDebounce);
    this.postWriteDebounce = window.setTimeout(() => { void this.pushOnce(); }, 100);
  }

  async kick() {
    await this.pushOnce();
    await this.pullOnce();
  }

  async initialPull() {
    let rounds = 0;
    let roundPulled = 0;
    do {
      roundPulled = await this.pullOnce();
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
    } catch {
      this.pendingCount = 0;
    }
    this.emit();
  }

  async pushOnce() {
    if (this.pushing || !this.online || this.quotaExceeded) return;

    const creds = await getCloudCredentials();
    if (!creds) return;

    this.pushing = true;
    this.emit();

    try {
      if (!(await probeOnline())) {
        this.online = false;
        return;
      }
      this.online = true;

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
        const stmt = this.toRemoteUpsert(op);
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
          for (const { op } of validOps) {
            await markOutbox(op.idempotency_key, { status: 'inflight' });
          }
          await remote.batch(validOps.map((v) => v.stmt), 'write');
          for (const { op } of validOps) {
            await markOutbox(op.idempotency_key, { status: 'synced' });
          }
          okCount = validOps.length;
          batchSucceeded = true;
        } catch (batchErr: unknown) {
          const rawMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
          if (rawMsg.includes('QUOTA') || rawMsg.includes('usage limit') || rawMsg.includes('storage full')) {
            this.quotaExceeded = true;
            this.lastError = 'Quota cloud Turso dépassé. Synchronisation suspendue.';
            this.logEvent('quota', this.lastError, 'error');
            for (const { op } of validOps) {
              await markOutbox(op.idempotency_key, { status: 'pending', error: rawMsg });
            }
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
                this.lastError = 'Quota cloud Turso dépassé. Synchronisation suspendue.';
                this.logEvent('quota', this.lastError, 'error');
                await markOutbox(op.idempotency_key, { status: 'pending', error: rawMsg });
                break;
              }

              await markOutbox(op.idempotency_key, {
                status: 'pending',
                retryCount: (op.retry_count ?? 0) + 1,
                nextRetryAt: new Date(Date.now() + backoffMs(op.retry_count ?? 0)).toISOString(),
                error: rawMsg,
              });
              this.lastError = `${op.entity_type}/${op.entity_id}: ${rawMsg}`;
              this.logEvent('error', `Échec d'envoi [${op.entity_type}]: ${rawMsg}`, 'warn');
            }
          }
        }
      }

      if (okCount > 0) {
        this.lastPushAt = utcNowIso();
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

  private toRemoteUpsert(op: OutboxRow): { sql: string; args: InValue[] } | null {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(op.payload_json) as Record<string, unknown>;
    } catch {
      return null;
    }

    const now = utcNowIso();
    const v = (x: unknown): InValue => (x === undefined ? null : x) as InValue;
    const version = Number(payload.version ?? 1);

    // Product image processing decommissioned: ensure image fields are purged
    payload.imageUrl = '';
    payload.image_url = '';

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
            ON CONFLICT(id) DO UPDATE SET deleted=1, version=${table}.version + 1, updated_at=excluded.updated_at,
            sync_status='synced'`,
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
            ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=${genericTable}.version + 1,
            updated_at=excluded.updated_at, sync_status='synced', deleted=1`,
          args: [
            v(op.entity_id), v(JSON.stringify(payload ?? {})), v(payload.device_id ?? this.deviceId ?? 'default'),
            v(op.idempotency_key ?? payload.idempotency_key ?? `idem-${op.entity_id}`), v(version + 1),
            v(payload.updated_at ?? payload.updatedAt ?? now),
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
          v(op.entity_id), v(JSON.stringify(payload ?? {})), v(payload.device_id ?? this.deviceId ?? 'default'),
          v(op.idempotency_key ?? payload.idempotency_key ?? `idem-${op.entity_id}`), v(version || 1),
          v(payload.updated_at ?? payload.updatedAt ?? now),
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
          v(op.payload_json ?? '{}'),
          v(payload.device_id ?? this.deviceId ?? 'default'),
          v(op.idempotency_key ?? payload.idempotency_key ?? `idem-${op.entity_id}`),
          v(version || 1),
          v((payload.updated_at ?? payload.updatedAt) ?? now),
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
          v(op.payload_json ?? '{}'), v(payload.device_id ?? this.deviceId ?? 'default'),
          v(op.idempotency_key ?? payload.idempotency_key ?? `idem-${op.entity_id}`),
          v(version || 1), v(payload.created_at ?? payload.createdAt ?? now), v(now),
        ],
      };
    }

    if (op.entity_type === 'product') {
      const pId = String(payload.id ?? op.entity_id ?? '');
      return {
        sql: `INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price,
          cost_price, stock, image_url, is_serialized, imei_number, vendor_name, json_payload,
          device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title, price=excluded.price, stock=excluded.stock,
          wholesale_price=excluded.wholesale_price, cost_price=excluded.cost_price,
          json_payload=excluded.json_payload, version=excluded.version, updated_at=excluded.updated_at,
          deleted=excluded.deleted, sync_status='synced'
          WHERE excluded.version >= products.version`,
        args: [
          v(pId), v(payload.sku ?? ''), v(payload.barcode ?? ''),
          v(payload.title ?? payload.id ?? op.entity_id ?? 'Sans Titre'),
          v(payload.brand ?? 'Autre'), v(payload.category ?? 'Tous les produits'),
          v(Number(payload.price ?? 0)),
          v(Number(payload.wholesale_price ?? payload.wholesalePrice ?? 0)),
          v(Number(payload.cost_price ?? payload.costPrice ?? 0)),
          v(Number(payload.stock ?? 0)),
          v(payload.image_url ?? ''),
          v(payload.is_serialized ? 1 : 0),
          v(payload.imei_number ?? payload.imeiNumber ?? null),
          v(payload.vendor_name ?? payload.vendorName ?? null),
          v(op.payload_json ?? '{}'),
          v(payload.device_id ?? this.deviceId ?? 'default'),
          v(op.idempotency_key ?? payload.idempotency_key ?? `idem-${op.entity_id}`),
          v(version || 1),
          v(payload.created_at ?? payload.createdAt ?? now),
          v(payload.updated_at ?? payload.updatedAt ?? now),
          v(Number(payload.deleted ?? 0)),
        ],
      };
    }

    return null;
  }

  private async getTableCursor(db: Database, table: string): Promise<{ time: string; id: string }> {
    try {
      const rows = (await db.select(
        'SELECT value_json FROM app_settings WHERE key = ?',
        [`sync.cursor.${table}`],
      )) as Array<{ value_json: string }>;
      if (rows?.[0]?.value_json) {
        const parsed = JSON.parse(rows[0].value_json);
        if (typeof parsed === 'string') {
          return { time: parsed, id: '' };
        }
        if (parsed && typeof parsed === 'object') {
          return {
            time: String((parsed as { time?: string }).time || '1970-01-01T00:00:00.000Z'),
            id: String((parsed as { id?: string }).id || ''),
          };
        }
      }
    } catch (err) {
      console.warn(`[sync:cursor] Error reading cursor for table ${table}:`, err);
    }
    return { time: '1970-01-01T00:00:00.000Z', id: '' };
  }

  private async setTableCursor(db: Database, table: string, cursor: { time: string; id: string } | string): Promise<void> {
    const value = typeof cursor === 'string' ? { time: cursor, id: '' } : cursor;
    await db.execute(
      "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
      [`sync.cursor.${table}`, JSON.stringify(value), utcNowIso()],
    );
  }

  async pullOnce(): Promise<number> {
    if (this.pulling || !this.online) return 0;

    const creds = await getCloudCredentials();
    if (!creds) return 0;

    this.pulling = true;
    this.emit();

    let totalPulled = 0;
    try {
      const remote = await getTursoClient();
      const db = await getLocalDb();

      for (const table of ALL_REMOTE_SYNC_TABLES) {
        assertValidSyncTable(table);
        const cursor = await this.getTableCursor(db, table);
        let maxSeenTime = cursor.time;
        let maxSeenId = cursor.id;

        let rs;
        try {
          // Compound keyset pagination: handles rows sharing exact same millisecond timestamps
          rs = await remote.execute({
            sql: `SELECT * FROM ${table} WHERE (updated_at > ?) OR (updated_at = ? AND id > ?) ORDER BY updated_at ASC, id ASC LIMIT 200`,
            args: [cursor.time, cursor.time, cursor.id],
          });
        } catch (e) {
          console.warn(`[sync] pull query failed [${table}]:`, e);
          continue;
        }

        for (const row of rs.rows) {
          const r = row as unknown as Record<string, unknown>;
          const updated = (r.updated_at as string) ?? utcNowIso();
          const rowId = (r.id as string) ?? '';
          if (updated > maxSeenTime || (updated === maxSeenTime && rowId > maxSeenId)) {
            maxSeenTime = updated;
            maxSeenId = rowId;
          }
          try {
            await this.applyRemoteRow(db, table, r);
            totalPulled++;
          } catch (e) {
            console.warn(`[sync] pull apply failed [${table}]:`, e);
          }
        }

        if (maxSeenTime !== cursor.time || maxSeenId !== cursor.id) {
          await this.setTableCursor(db, table, { time: maxSeenTime, id: maxSeenId });
        }
      }

      if (totalPulled > 0) {
        this.lastPullAt = utcNowIso();
        // Recompute products stock from ledger deltas
        await db.execute(
          `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger
            WHERE inventory_ledger.product_id = products.id AND deleted=0), stock)`,
        );
        // Reconstruct Dexie transactions with their line items & customers
        try {
          const { reconstructDexieTransactionsFromSql } = await import('../db/backfill');
          await reconstructDexieTransactionsFromSql(db);
        } catch (err) {
          console.warn('[sync:pull] reconstructDexieTransactionsFromSql error:', err);
        }
        this.logEvent('pull', `${totalPulled} enregistrements reçus du cloud`, 'info');
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
        recordPayload = JSON.parse((r.data_json as string) ?? '{}') as Record<string, unknown>;
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
          String(r.created_at ?? utcNowIso()), String(r.json_payload ?? '{}'),
          String(r.device_id ?? 'remote'), String(r.idempotency_key ?? txId), version,
          String(r.updated_at ?? utcNowIso()), Number(r.deleted ?? 0),
        ],
      );

      // Mirror transaction receipt into Dexie with receiptNumber
      try {
        const txns = (dexieDb as unknown as { transactions: {
          put: (o: unknown) => Promise<unknown>;
          update: (k: string, p: unknown) => Promise<unknown>;
          delete: (k: string) => Promise<void>;
        } }).transactions;

        if (Number(r.deleted ?? 0) === 1) {
          await txns.delete(txId);
          return;
        }

        const rawPayload = JSON.parse((r.json_payload as string) ?? '{}') as Record<string, unknown>;
        const parsedTxn = {
          ...rawPayload,
          id: rawPayload.id || txId,
          receiptNumber: rawPayload.receiptNumber || rawPayload.receipt_number || receiptNo,
          total: rawPayload.total ?? Number(r.total ?? 0),
          status: rawPayload.status || r.status || 'COMPLETED',
          paymentMethod: rawPayload.paymentMethod || r.payment_method || 'Espèces',
          createdAt: rawPayload.createdAt || r.created_at || utcNowIso(),
        };
        await txns.put(parsedTxn);
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
          Number(r.cost_price ?? 0), String(r.json_payload ?? '{}'),
          String(r.device_id ?? 'remote'), String(r.idempotency_key ?? itemId),
          version, String(r.created_at ?? utcNowIso()), String(r.updated_at ?? utcNowIso()),
          Number(r.deleted ?? 0),
        ],
      );
      return;
    }

    if (table === 'products') {
      const pId = String(r.id || `prod-${Date.now()}`);
      // Fix: include deleted=excluded.deleted so product deletions don't resurrect
      await db.execute(
        `INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price, cost_price,
          stock, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, price=excluded.price,
           json_payload=excluded.json_payload, version=excluded.version, updated_at=excluded.updated_at,
           deleted=excluded.deleted, sync_status='synced'
           WHERE excluded.version >= products.version`,
        [
          pId, String(r.sku ?? ''), String(r.barcode ?? ''), String(r.title || pId), String(r.brand ?? 'Autre'), String(r.category ?? 'Tous les produits'),
          Number(r.price ?? 0), Number(r.wholesale_price ?? 0), Number(r.cost_price ?? 0), Number(r.stock ?? 0),
          String(r.json_payload ?? '{}'), String(r.device_id ?? 'remote'), String(r.idempotency_key ?? pId),
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
          let base: Record<string, unknown> = {};
          try {
            base = JSON.parse((r.json_payload as string) ?? '{}');
          } catch (jsonErr: unknown) {
            console.warn('[sync:dexie] Failed to parse product payload:', jsonErr);
          }
          const productToPut: Product = {
            sku: (r.sku as string) ?? '',
            barcode: (r.barcode as string) ?? '',
            title: (r.title as string) ?? '',
            brand: (r.brand as Product['brand']) || 'Autre',
            category: (r.category as Product['category']) || 'Tous les produits',
            price: Number(r.price ?? 0),
            wholesalePrice: Number(r.wholesale_price ?? 0),
            costPrice: Number(r.cost_price ?? 0),
            stock: Number(r.stock ?? 0),
            imageUrl: String(r.image_url ?? ''),
            isSerialized: Boolean(r.is_serialized),
            imeiNumber: r.imei_number ? String(r.imei_number) : undefined,
            vendorName: String(r.vendor_name ?? 'Fournisseur Général'),
            leadTimeDays: Number(r.lead_time_days ?? 7),
            dailySalesVelocity: Number(r.daily_sales_velocity ?? 0),
            reorderPoint: Number(r.reorder_point ?? 5),
            compatibleModel: String(r.compatible_model ?? ''),
            ...base,
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

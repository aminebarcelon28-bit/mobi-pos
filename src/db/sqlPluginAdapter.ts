// Local SQLite access via @tauri-apps/plugin-sql (all platforms incl. mobile).
// Path MUST match lib.rs: add_migrations("sqlite:mobi_pos.db", ...).
// Checkout code must use these helpers inside a single transaction:
//   order + items + ledger deltas + outbox rows + cached stock update.

import Database from '@tauri-apps/plugin-sql';
import { recordShadowEvent, initClock } from '../sync/eventInterceptor.ts';
import { backfillExistingProducts } from '../sync/snapshotBackfill.ts';
import type { Product } from '../types/pos';
import { newId, normalizeImeiKey } from '../utils/ids';
import { toLocalDayKey } from '../utils/dateUtils';
import { withWriteLock } from './writeMutex';
// Phase 4.5 WP2c: NO static import of './benchHook' — it must stay out of
// release bundles entirely (bundle-inspected by test_bench_hook.mjs). Timing
// marks go through devBenchMark below: a DEV-guarded lazy import that Vite
// erases from production builds (`import.meta.env.DEV` compiles to `false`
// and the minifier drops the branch, dynamic import included). Marks resolve
// on a microtask — fine for shape-only dev benches, never on the hot path.
function devBenchMark(label: string): void {
  try {
    if (import.meta.env.DEV) {
      void import('./benchHook').then(
        (m) => m.benchMark(label),
        () => {}
      );
    }
  } catch {
    // Timing must never break production flows.
  }
}
import { withBusyRetry, isBusyError, isStaleTxnError, isRetryableDbError, BeginUnavailableError } from './busyRetry';
export { isRetryableDbError, isBusyError, isStaleTxnError, withBusyRetry };
import { CUSTOMER_DEBTS_COLUMN_HEAL_SQL, CUSTOMER_DEBTS_HEAL_PROBE_SQL } from './schemaHeal';
import { markBoot } from '../utils/bootTimings';

const DB_PATH = 'sqlite:mobi_pos.db';

let cached: Database | null = null;
let columnsEnsured = false;

export async function ensureLocalSyncColumns(db: Database): Promise<void> {
  // v103 self-heal (checkout PERSISTENCE_FAILED fix): Rust migrations < 103
  // created sync_outbox with CHECK(entity_type IN (...)) that omits
  // 'stock_batches' (FIFO depletion) and 'credit_voucher' (voucher lane).
  // Any sale depleting a FIFO batch then aborts the whole atomic checkout
  // transaction with SQLITE_CONSTRAINT and the UI reports "Erreur d'écriture
  // base de données. Vente non enregistrée." This rebuild drops the
  // entity_type CHECK (operation/status guards stay) so future lanes can
  // never break checkout again. Mirrors Rust migration v103; idempotent.
  await healSyncOutboxEntityCheck(db).catch((e: unknown) => {
    console.warn('[db:sync-outbox] entity_type CHECK heal skipped:', e);
  });
  // Fast path (boot gate): a migrated DB already carries every column below.
  // Two probe SELECTs replace 22 doomed ALTERs per boot on established DBs
  // (measured: 22 of 36 boot IPC ops failed with "duplicate column").
  // Fresh/partial DBs fail a probe and fall through to the full pass.
  // PROBE COMPLETENESS LAW: every column WRITTEN on a hot path must be
  // probed — a kill between sequential ALTERs leaves e.g. unit_cost_at_sale
  // present but line_profit missing; a single-column probe would pass boot
  // and every later checkout would abort with "no such column". Probes are
  // grouped by table (one LIMIT-0 round-trip per table) to keep boot IPC
  // flat while covering all four costing columns and the other hot writers.
  try {
    await db.select('SELECT version FROM products LIMIT 0;');
    await db.select('SELECT last_error, error FROM sync_outbox LIMIT 0;');
    await db.select(
      'SELECT unit_price_charged, unit_cost_at_sale, discount_amount, line_profit, version FROM transaction_items LIMIT 0;'
    );
    // FIFO reconcile writes transactions.version / transaction_items.version on
    // every invoice receipt — a DB missing either column would fail there with
    // (code: 1299) instead of healing here at boot.
    await db.select('SELECT version, ledger_cogs_total, shift_id FROM transactions LIMIT 0;');
    await db.select('SELECT batch_id, shadow_sale_id FROM stock_batches LIMIT 0;');
    // v104 STRICT FIFO ALLOCATION LEDGER: frozen per-batch COGS written at
    // checkout inside the same txn that depletes stock_batches. The Sales &
    // Net Profit report sums ONLY this table — never products.costPrice or
    // live stock_batches. Missing table forces the full pass below.
    await db.select('SELECT sale_id FROM sale_batch_allocations LIMIT 0;');
    await db.select('SELECT version FROM inventory_ledger LIMIT 0;');
    await db.select('SELECT version FROM customers LIMIT 0;');
    // Every version-clocked lane (bumpEntityVersion on invoice/PO/trade/IMEI/
    // drops/bundles/debts/expenses writes) hard-fails with 1299 on a half
    // heal that has the table but not the clock — probe each clock.
    await db.select('SELECT version FROM repair_orders LIMIT 0;');
    await db.select('SELECT version FROM purchase_orders LIMIT 0;');
    await db.select('SELECT version FROM trade_ins LIMIT 0;');
    await db.select('SELECT version FROM imei_records LIMIT 0;');
    await db.select('SELECT version FROM cash_drops LIMIT 0;');
    await db.select('SELECT version FROM product_bundles LIMIT 0;');
    await db.select('SELECT version FROM store_expenses LIMIT 0;');
    await db.select('SELECT version FROM customer_debts LIMIT 0;');
    await db.select('SELECT version, device_id, ip_address FROM security_audit_logs LIMIT 0;');
    await db.select('SELECT version, device_id, terminal_name FROM cash_sessions LIMIT 0;');
    await db.select('SELECT version FROM cash_movements LIMIT 0;');
    await db.select('SELECT key, value_json FROM app_settings LIMIT 0;');
    await db.select('SELECT key, value_json, version FROM app_settings LIMIT 0;');
    await db.select(CUSTOMER_DEBTS_HEAL_PROBE_SQL);
    return;
  } catch (probeErr) {
    // B-009: BUSY is transient lock contention, NOT a missing column —
    // never swallow it into the full DML heal (DELETE/UPDATE service stock).
    if (isBusyError(probeErr)) throw probeErr;
    // Column (or table) missing — run the full idempotent pass below.
  }
  const statements = [
    `CREATE TABLE IF NOT EXISTS sale_batch_allocations (
      id TEXT PRIMARY KEY NOT NULL,
      sale_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      qty_consumed INTEGER NOT NULL CHECK (qty_consumed > 0),
      unit_cost_at_sale REAL NOT NULL CHECK (unit_cost_at_sale >= 0),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      product_id TEXT,
      sale_item_id TEXT,
      device_id TEXT NOT NULL DEFAULT 'local',
      idempotency_key TEXT NOT NULL UNIQUE,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      deleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(batch_id) REFERENCES stock_batches(batch_id)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_alloc_sale ON sale_batch_allocations(sale_id);`,
    `CREATE INDEX IF NOT EXISTS idx_alloc_batch ON sale_batch_allocations(batch_id);`,
    `CREATE INDEX IF NOT EXISTS idx_alloc_product ON sale_batch_allocations(product_id);`,
    'ALTER TABLE transactions ADD COLUMN ledger_cogs_total REAL;',
    // Owning cash session, stamped at checkout. Closes scope by window with
    // this id as the attribution tiebreak (gap sales stay visible).
    'ALTER TABLE transactions ADD COLUMN shift_id TEXT;',
    // Belt-and-braces mirror of Rust v109 (DB-002): the refund linkage
    // column writers stamp at insert. Duplicate-safe like every entry here.
    'ALTER TABLE transactions ADD COLUMN original_transaction_id TEXT;',
    'CREATE INDEX IF NOT EXISTS idx_transactions_orig_txn ON transactions(original_transaction_id);',
    'CREATE INDEX IF NOT EXISTS idx_txn_items_txn_deleted ON transaction_items(transaction_id, deleted);',
    'CREATE INDEX IF NOT EXISTS idx_txn_items_prod_deleted ON transaction_items(product_id, deleted);',
    'ALTER TABLE transaction_items ADD COLUMN unit_price_charged REAL DEFAULT 0;',
    'ALTER TABLE transaction_items ADD COLUMN unit_cost_at_sale REAL DEFAULT 0;',
    'ALTER TABLE transaction_items ADD COLUMN discount_amount REAL DEFAULT 0;',
    'ALTER TABLE transaction_items ADD COLUMN line_profit REAL DEFAULT 0;',
    'ALTER TABLE stock_batches ADD COLUMN shadow_sale_id TEXT;',
    'ALTER TABLE stock_batches ADD COLUMN shadow_item_id TEXT;',
    'ALTER TABLE stock_batches ADD COLUMN shadow_qty REAL NOT NULL DEFAULT 0;',
    'ALTER TABLE stock_batches ADD COLUMN shadow_resolved INTEGER NOT NULL DEFAULT 0;',
    `CREATE TABLE IF NOT EXISTS stock_batches (
      batch_id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
      unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
      received_at TEXT NOT NULL,
      purchase_order_id TEXT,
      device_id TEXT NOT NULL DEFAULT 'local',
      idempotency_key TEXT NOT NULL UNIQUE,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      deleted INTEGER NOT NULL DEFAULT 0
    );`,
    'CREATE INDEX IF NOT EXISTS idx_stock_batches_fifo ON stock_batches(product_id, received_at) WHERE quantity_remaining > 0 AND deleted = 0;',
    'CREATE INDEX IF NOT EXISTS idx_stock_batches_updated ON stock_batches(updated_at, batch_id);',
    'CREATE INDEX IF NOT EXISTS idx_stock_batches_po ON stock_batches(purchase_order_id);',
    'ALTER TABLE transaction_items ADD COLUMN unit_price_charged REAL DEFAULT 0;',
    'ALTER TABLE transaction_items ADD COLUMN unit_cost_at_sale REAL DEFAULT 0;',
    'ALTER TABLE transaction_items ADD COLUMN discount_amount REAL DEFAULT 0;',
    'ALTER TABLE transaction_items ADD COLUMN line_profit REAL DEFAULT 0;',
    'ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE transactions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE transaction_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE inventory_ledger ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE customers ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE security_audit_logs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE security_audit_logs ADD COLUMN device_id TEXT;',
    'ALTER TABLE security_audit_logs ADD COLUMN ip_address TEXT;',
    // FT-06/C provenance: existing rows read back as 'local' via the default
    // (SQLite fills pre-existing rows with the column default). Native
    // appends omit the column and inherit the default; only the backup merge
    // writes 'imported' explicitly. Duplicate-tolerant like the rest here.
    "ALTER TABLE security_audit_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'local';",
    'ALTER TABLE repair_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE purchase_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE trade_ins ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE imei_records ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE cash_drops ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE product_bundles ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE customer_debts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    ...CUSTOMER_DEBTS_COLUMN_HEAL_SQL,
    'ALTER TABLE store_expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE cash_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE cash_sessions ADD COLUMN device_id TEXT;',
    'ALTER TABLE cash_sessions ADD COLUMN terminal_name TEXT;',
    `CREATE TABLE IF NOT EXISTS credit_vouchers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      initial_amount REAL NOT NULL CHECK (initial_amount >= 0),
      remaining_amount REAL NOT NULL CHECK (remaining_amount >= 0),
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      customer_name TEXT,
      customer_phone TEXT,
      notes TEXT,
      device_id TEXT NOT NULL DEFAULT 'local',
      idempotency_key TEXT NOT NULL UNIQUE,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT,
      deleted INTEGER NOT NULL DEFAULT 0
    );`,
    'CREATE INDEX IF NOT EXISTS idx_credit_vouchers_code ON credit_vouchers(code);',
    'CREATE INDEX IF NOT EXISTS idx_credit_vouchers_status ON credit_vouchers(status);',
    'ALTER TABLE cash_movements ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE app_settings ADD COLUMN key TEXT;',
    'ALTER TABLE app_settings ADD COLUMN value_json TEXT;',
    'ALTER TABLE app_settings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE sync_outbox ADD COLUMN last_error TEXT;',
    'ALTER TABLE sync_outbox ADD COLUMN error TEXT;',
    'UPDATE app_settings SET key = id WHERE key IS NULL AND id IS NOT NULL;',
    'UPDATE app_settings SET value_json = data_json WHERE value_json IS NULL AND data_json IS NOT NULL;',
  ];
  // B-021: destructive service-ledger/stock DML gated behind a one-shot
  // app_settings flag — a failed probe for an unrelated reason must never
  // rewrite inventory on every boot.
  const healFlagRows = (await db
    .select("SELECT value_json FROM app_settings WHERE key='schema.heal.v103_services.done' LIMIT 1;")
    .catch(() => [])) as Array<{ value_json?: string | null }>;
  const healAlreadyDone = Array.isArray(healFlagRows) && healFlagRows.length > 0;
  if (!healAlreadyDone) {
    statements.push(
      "DELETE FROM inventory_ledger WHERE product_id LIKE 'qt-%' OR product_id LIKE 'prod-misc-%';",
      "UPDATE products SET stock = 999999, category = 'Services' WHERE (id LIKE 'qt-%' OR id LIKE 'prod-misc-%' OR category = 'Services') AND stock < 999999;",
    );
  }
  for (const sql of statements) {
    try {
      await db.execute(sql);
    } catch (stmtErr) {
      // B-009: BUSY is never "expected if column already exists" — rethrow
      // so the boot path does not silently skip the rest of the heal.
      if (isBusyError(stmtErr)) throw stmtErr;
      // Expected if column already exists on upgraded database
    }
  }
  if (!healAlreadyDone) {
    await db
      .execute(
        "INSERT INTO app_settings (id, key, value_json, updated_at, version) VALUES ('schema.heal.v103_services', 'schema.heal.v103_services.done', 'true', $1, 1) ON CONFLICT(id) DO UPDATE SET value_json='true', updated_at=excluded.updated_at;",
        [new Date().toISOString()]
      )
      .catch(async () => {
        // Cross-shape latch: DBs created by the Rust lane carry app_settings
        // as (key PK, value_json, updated_at) with NO `id` column, so the
        // statement above always throws there and the flag never latches
        // (the idempotent service DML re-runs every boot). Retry key-only;
        // whichever shape lands first wins, both are best-effort.
        await db
          .execute(
            "INSERT INTO app_settings (key, value_json, updated_at, version) VALUES ('schema.heal.v103_services.done', 'true', $1, 1) ON CONFLICT(key) DO UPDATE SET value_json='true', updated_at=excluded.updated_at;",
            [new Date().toISOString()]
          )
          .catch((e: unknown) => console.warn('[heal] flag write skipped:', e));
      });
  }
  // Re-run the v103 heal after the full pass: a fresh DB created by the
  // column pass (or an old plugin-sql path) may still carry the narrow CHECK.
  await healSyncOutboxEntityCheck(db).catch(() => {});
  // Costing backfill (relocated from Rust v102: a static migration cannot
  // ALTER-or-backfill transaction_items because upgrade DBs already carry the
  // columns via this heal — plain ALTERs would abort boot with "duplicate
  // column name", and the UPDATE needs the columns to exist on fresh DBs
  // where migrate runs before this heal). Always-run + best-effort: the full
  // pass above guarantees the columns when probes fail; on probe-pass DBs
  // they already exist. Idempotent (only touches 0-rows; legit 0-price lines
  // rewrite identical values). BUSY-aware: withBusyRetry owns retries, but a
  // stale/missing column here must never fail boot — the sale path computes
  // these per item on every write.
  await db
    .execute(
      `UPDATE transaction_items
       SET unit_price_charged = applied_price,
           unit_cost_at_sale = cost_price,
           discount_amount = discount,
           line_profit = (applied_price - cost_price) * quantity
       WHERE unit_price_charged = 0`,
    )
    .catch(() => {});
  try { await backfillSaleAllocationsFromItemsWithDb(db).catch(() => 0); } catch {}
  try { await mirrorSaleAllocationsToDexie(db).catch(() => 0); } catch {}
}

/**
 * Full sync_outbox schema (CREATE IF NOT EXISTS belt-and-suspenders for B-010:
 * after a mid-heal kill, probe finds no table / no CHECK and returns early —
 * this restores a usable outbox before anything tries to insert).
 */
const SYNC_OUTBOX_CREATE_SQL = `CREATE TABLE IF NOT EXISTS sync_outbox (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('UPSERT','DELETE')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','inflight','synced','failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT, last_error TEXT, error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`;

/**
 * Rebuilds sync_outbox without the narrow entity_type CHECK when present.
 * Idempotent: no-op when the table is missing or already healed.
 * B-010: (1) finish an orphan sync_outbox_new RENAME from a prior kill,
 * (2) run DROP+RENAME inside BEGIN IMMEDIATE so the pair is atomic,
 * (3) CREATE IF NOT EXISTS if the table vanished entirely.
 */
async function healSyncOutboxEntityCheck(db: Database): Promise<void> {
  // Crash recovery: prior kill left sync_outbox_new but never renamed.
  const orphan = (await db
    .select("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_outbox_new'")
    .catch(() => [])) as Array<{ name?: string }>;
  const hasOutbox = (await db
    .select("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_outbox'")
    .catch(() => [])) as Array<{ name?: string }>;
  if (orphan?.length && !hasOutbox?.length) {
    await db.execute('ALTER TABLE sync_outbox_new RENAME TO sync_outbox;').catch(() => {});
  } else if (orphan?.length && hasOutbox?.length) {
    // Both exist: new table was fully populated but DROP never ran — drop orphan.
    await db.execute('DROP TABLE sync_outbox_new;').catch(() => {});
  }

  const master = (await db
    .select("SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_outbox'")
    .catch(() => [])) as Array<{ sql?: string }>;
  const ddl = String(master?.[0]?.sql ?? '');
  if (!ddl) {
    // Table missing entirely (post-kill): restore schema, no copy needed.
    await db.execute(SYNC_OUTBOX_CREATE_SQL);
    return;
  }
  if (!/entity_type\s+IN\s*\(/i.test(ddl)) return;

  await db.execute(SYNC_OUTBOX_CREATE_SQL.replace('IF NOT EXISTS sync_outbox (', 'IF NOT EXISTS sync_outbox_new ('));
  const cols = (await db
    .select("SELECT name FROM pragma_table_info('sync_outbox')")
    .catch(() => [])) as Array<{ name?: string }>;
  const names = new Set((cols ?? []).map((c) => String(c?.name ?? '')));
  const colList = ['rowid', 'idempotency_key', 'entity_type', 'entity_id', 'operation', 'payload_json', 'status', 'retry_count', 'next_retry_at', 'last_error', 'created_at', 'updated_at'];
  if (names.has('error')) colList.push('error');
  const list = colList.join(', ');
  // Atomic rebuild: a kill between DROP and RENAME would orphan data (B-010).
  // beginImmediate recovers stale pooled txns instead of going sequential.
  const began = await beginImmediate(db, 'heal:sync_outbox');
  try {
    await db.execute(
      `INSERT OR IGNORE INTO sync_outbox_new (${list}) SELECT ${list} FROM sync_outbox;`,
    );
    await db.execute('DROP TABLE sync_outbox;');
    await db.execute('ALTER TABLE sync_outbox_new RENAME TO sync_outbox;');
    if (began) await db.execute('COMMIT;');
  } catch (e) {
    if (began) await db.execute('ROLLBACK;').catch(() => {});
    throw e;
  }
  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_outbox_status ON sync_outbox(status, next_retry_at, rowid);',
  );
  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_outbox_entity ON sync_outbox(entity_type, entity_id);',
  );
}

let dbInitPromise: Promise<Database> | null = null;

/**
 * B-001 FIX-1: re-issue PRAGMA busy_timeout on whatever pooled connection
 * the next IPC lands on. sqlx Pool has no session pinning — a boot-time
 * pragma only covers the connection that ran it. Cheap no-op on failure.
 */
export async function ensureBusyTimeout(db: Database, ms = 15000): Promise<void> {
  try {
    await db.execute(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(ms))};`);
  } catch {
    // Best-effort — withBusyRetry still covers residual BUSY.
  }
}

/**
 * Shared BEGIN IMMEDIATE with stale-txn recovery (2026-09-23 console fix).
 *
 * tauri-plugin-sql pools connections WITHOUT session pinning: a prior
 * BEGIN…COMMIT can split across pool members, leaving conn A with an abandoned
 * write transaction. The next BEGIN that lands on A fails with code 1
 * "cannot start a transaction within a transaction" — which is NOT BUSY, so
 * the old catch fell into the non-atomic sequential path while A still held
 * locks (cascading SQLITE_BUSY on every later checkout that reused A).
 *
 * Recovery: spray ROLLBACK across the pool (each IPC may hit a different
 * member — cheap no-ops when no txn is active), then retry BEGIN once.
 * Returns true when a transaction is open on "some" pool connection for this
 * critical section (best-effort under multiplexing — same model the rest of
 * the adapter uses). Throws BUSY/stale-txn so withBusyRetry re-runs the
 * whole section. Genuine capability failures throw BeginUnavailableError
 * instead of degrading to sequential autocommit writes (IPC-008): a
 * half-written sale (order without items/ledger/outbox) is worse than a
 * loud failure, and every caller already funnels errors through
 * withBusyRetry or an explicit catch. Callers keep their `if (useTxn)`
 * guards untouched — they are now statically always-true.
 */
export async function beginImmediate(db: Database, label = 'db'): Promise<true> {
  await ensureBusyTimeout(db, 15000);
  try {
    await db.execute('BEGIN IMMEDIATE;');
    return true;
  } catch (beginErr) {
    // BUSY = racing lane holds the write lock → outer withBusyRetry.
    if (isBusyError(beginErr)) throw beginErr;
    if (!isStaleTxnError(beginErr)) {
      throw new BeginUnavailableError(label, beginErr);
    }
    // Stale pooled txn: spray ROLLBACK (pool may hand us different members),
    // then retry BEGIN once. Still stale → throw so withBusyRetry re-runs.
    console.warn(`[${label}] stale pooled transaction — spraying ROLLBACK then retrying BEGIN:`, beginErr);
    for (let i = 0; i < 8; i += 1) {
      await db.execute('ROLLBACK;').catch(() => {});
    }
    try {
      await db.execute('BEGIN IMMEDIATE;');
      return true;
    } catch (retryErr) {
      if (isRetryableDbError(retryErr)) throw retryErr;
      throw new BeginUnavailableError(label, retryErr);
    }
  }
}

export function getLocalDb(): Promise<Database> {
  // B-008: single shared init promise — concurrent first-boot callers await
  // the same load+pragma+heal sequence instead of racing columnsEnsured.
  if (dbInitPromise) return dbInitPromise;
  dbInitPromise = (async () => {
    markBoot('db:start');
    if (!cached) {
      cached = await Database.load(DB_PATH);
      markBoot('db:load');
      await cached.execute('PRAGMA journal_mode = WAL;');
      await cached.execute('PRAGMA synchronous = NORMAL;');
      // B-001 FIX-1: single busy_timeout (last wins was 15000; drop the
      // duplicate 5000 that only confused readers). Note: sqlx Pool may
      // hand subsequent IPC to a different connection — writers still rely
      // on withWriteLock + withBusyRetry as the real defense.
      await cached.execute('PRAGMA busy_timeout = 15000;');
      await cached.execute('PRAGMA foreign_keys = ON;');
      await cached.execute('PRAGMA auto_vacuum = INCREMENTAL;').catch(() => {});
      await cached.execute("DELETE FROM sync_outbox WHERE status = 'synced';").catch(() => {});
    }
    if (!columnsEnsured) {
      await ensureLocalSyncColumns(cached);
      columnsEnsured = true;
      markBoot('db:heal');
      // LCP: monthly WAL-checkpoint + incremental vacuum moved OUT of the
      // boot critical path (App.tsx idle-schedules
      // checkAndRunScheduledDbMaintenance post-paint). On a 100MB+ file with
      // a deep WAL it stalls boot for seconds when it fires.
      const devId = (await getOrCreateDeviceId(cached)) || 'default';
      initClock(devId);
      await backfillExistingProducts(cached, devId).catch(() => {});
      // DB-002 linkage backfill (flagged one-shot, cheap after first run).
      try {
        const { backfillOriginalTransactionIds } = await import('./backfill');
        await backfillOriginalTransactionIds(cached).catch(() => {});
      } catch {
        // Never fail boot over a backfill.
      }
      markBoot('db:ready');
    }
    return cached;
  })().catch((err) => {
    dbInitPromise = null; // allow retry after a failed boot
    throw err;
  });
  return dbInitPromise;
}

/**
 * Executes database hygiene: WAL truncation checkpoint + incremental vacuum.
 * Reclaims disk space and bounds SQLite file growth (ES-LFP §18.1).
 */
export async function runDbMaintenance(
  db?: Database,
): Promise<{ checkpoint: unknown; vacuum: unknown; fkViolations: number }> {
  const targetDb = db || (await getLocalDb());
  const checkpoint = await targetDb.execute('PRAGMA wal_checkpoint(TRUNCATE);').catch((e: unknown) => {
    console.warn('[DB Maintenance] WAL checkpoint warning:', e);
    return null;
  });
  const vacuum = await targetDb.execute('PRAGMA incremental_vacuum(256);').catch((e: unknown) => {
    console.warn('[DB Maintenance] Incremental vacuum warning:', e);
    return null;
  });
  // DB-015 detection control: PRAGMA foreign_keys is per-connection on the
  // unpinned pool, so enforcement cannot be guaranteed from the TS lane
  // (the native lane sets it per connection). foreign_key_check scans for
  // violations the pragma may have missed and reports them loudly instead
  // of letting orphan rows accumulate silently. Detection-backed, matching
  // this repo's posture for pool-uncertain guarantees.
  let fkViolations = 0;
  try {
    const rows = (await targetDb
      .select('PRAGMA foreign_key_check;')
      .catch(() => [])) as Array<{ table?: unknown; rowid?: unknown; fkid?: unknown }>;
    fkViolations = Array.isArray(rows) ? rows.length : 0;
    if (fkViolations > 0) {
      console.warn(
        '[DB Maintenance] foreign_key_check found violations (orphan rows FK enforcement missed):',
        rows.slice(0, 10),
      );
    }
  } catch (err) {
    console.warn('[DB Maintenance] foreign_key_check unavailable:', err);
  }
  return { checkpoint, vacuum, fkViolations };
}

export async function checkAndRunScheduledDbMaintenance(db: Database): Promise<void> {
  try {
    const currentMonth = toLocalDayKey(new Date()).slice(0, 7); // e.g. "2026-09" (shop-local month, not UTC)
    const rows = (await db.select(
      "SELECT value_json FROM app_settings WHERE key = 'sync.maintenance.last_month'"
    ).catch(() => [])) as Array<{ value_json: string }>;

    let lastMonth = '';
    if (rows?.[0]?.value_json) {
      try {
        lastMonth = JSON.parse(rows[0].value_json);
      } catch {
        lastMonth = rows[0].value_json;
      }
    }

    if (lastMonth !== currentMonth) {
      await runDbMaintenance(db);
      await db.execute(
        "INSERT INTO app_settings (key, value_json, version, updated_at) VALUES ('sync.maintenance.last_month', ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at;",
        [JSON.stringify(currentMonth), utcNowIso()]
      ).catch(() => {});
    }
  } catch (err) {
    console.warn('[DB Maintenance] Scheduled check non-fatal error:', err);
  }
}

export function utcNowIso(): string {
  return new Date().toISOString();
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return newId('idem');
}

/**
 * P0 payload-hygiene invariant (mobile freeze/crash fix, 2026-09-17).
 * Canonical implementation lives in the dependency-free
 * `../sync/payloadHygiene` module (importable from tests); re-exported here
 * so existing `sqlPluginAdapter` import sites keep working.
 */
export {
  MAX_SYNC_IMAGE_FIELD_BYTES,
  MAX_SYNC_BLOB_STRING_BYTES,
  MAX_SYNC_PAYLOAD_BYTES,
  sanitizeSyncPayload,
  sanitizeImageField,
  toBoundedSyncJson,
} from '../sync/payloadHygiene';
import { sanitizeImageField, toBoundedSyncJson } from '../sync/payloadHygiene';

/**
 * Stable per-device authorship id for the sync protocol (single identity,
 * ADR-0008). Never throws — returns null when SQLite is unavailable (plain
 * web preview), letting callers fall back to the transport id.
 */
export async function getSyncDeviceId(): Promise<string | null> {
  try {
    const db = await getLocalDb();
    return (await getOrCreateDeviceId(db)) || null;
  } catch {
    return null;
  }
}

async function getOrCreateDeviceId(db: Database): Promise<string> {
  const rows = (await db.select('SELECT value_json FROM app_settings WHERE key = \'sync.device_id\'')
    .catch(() => [])) as Array<{ value_json: string }>;
  if (rows?.[0]?.value_json) {
    try {
      const parsed: unknown = JSON.parse(rows[0].value_json as string);
      if (typeof parsed === 'string' && parsed.length > 0) return parsed;
      // Legacy Dexie-port envelope ({_ported_from, value_json_text}) was stored
      // raw by older builds; unwrapping keeps the stable UUID instead of
      // coercing the object into a "[object Object]"/JSON blob device_id.
      const inner = (parsed as { value_json_text?: unknown } | null)?.value_json_text;
      const repair = async (clean: string) => {
        await db.execute(
          "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES ('sync.device_id', ?, ?)",
          [JSON.stringify(clean), utcNowIso()],
        ).catch(() => {});
        return clean;
      };
      if (typeof inner === 'string') {
        try {
          const innerParsed: unknown = JSON.parse(inner);
          if (typeof innerParsed === 'string' && innerParsed.length > 0) {
            return await repair(innerParsed);
          }
        } catch {
          // inner is a bare id, handled below
        }
        if (inner.length > 0 && inner.length < 100 && !inner.startsWith('{')) {
          return await repair(inner);
        }
      }
      console.warn('[db:deviceId] Unrecognized device ID shape, regenerating');
    } catch (err) {
      console.warn('[db:deviceId] Malformed device ID JSON, regenerating:', err);
    }
  }
  const id = newIdempotencyKey();
  await db.execute(
    "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES ('sync.device_id', ?, ?)",
    [JSON.stringify(id), utcNowIso()],
  );
  return id;
}

export interface LedgerDeltaInput {
  productId: string;
  delta: number;
  reason: 'SALE' | 'VOID' | 'REFUND' | 'RECEIVE' | 'ADJUST' | 'SEED';
  refType: string;
  refId: string;
  /**
   * Optional deterministic identity for cross-device idempotency (void/refund
   * compensation). When two devices compensate the SAME logical operation
   * they pass the same id/key, so the second insert converges via the
   * ON CONFLICT DO NOTHING paths instead of double-counting. When omitted a
   * fresh random key is minted (sales, manual adjustments).
   */
  id?: string;
  idempotencyKey?: string;
}

export interface CheckoutWriteInput {
  orderRow: Record<string, unknown> & { id: string };
  items: Array<Record<string, unknown> & { id: string; product_id: string }>;
  deltas: LedgerDeltaInput[];
  /** Full SaleTransaction (with items carrying product objects + tenders).
   * Stored as the canonical receipt JSON locally, in the outbox, and remotely
   * so a fresh laptop can restore complete receipts from the cloud. */
  fullTx?: Record<string, unknown>;
  /** Minimal product snapshots so ledger FK + pull cache never dangle when the
   *  legacy seed path only reached Dexie (plugin-sql migrations run fresh). */
  productSnapshots?: Array<{
    id: string; sku?: string; barcode?: string; title?: string;
    brand?: string; category?: string; price?: number;
  }>;
}

/**
 * Atomic local checkout write (OFFLINE-FIRST — never touches network):
 *  - UPSERT order + items
 *  - INSERT ledger deltas (append-only, never UPDATE stock directly)
 *  - Recompute cached products.stock = SUM(ledger) per touched product
 *  - Enqueue one sync_outbox row per entity with shared idempotency keys
 *
 * FIFO authority: for SALE receipts the resolved per-line COGS
 * (fifoItems) and order totals (fifoCostTotal/fifoProfit) are the durable
 * truth — callers must adopt them for their in-memory/Dexie mirrors so
 * Desktop and Mobile never display different margins for the same sale.
 * Null when FIFO did not resolve (refund receipts, catalog fallback path).
 */
interface FifoBatchRow {
  batch_id: string;
  quantity_remaining: number;
  unit_cost: number;
  received_at?: string;
  purchase_order_id?: string | null;
  created_at?: string;
}

interface DepleteCtx {
  prodId: string;
  deviceId: string;
  now: string;
  txId: string;
}

function toFiniteNumber(v: unknown, fallback: number = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
const defaultNumber = toFiniteNumber;

async function lastKnownPurchaseCost(
  db: { select: (sql: string, args?: unknown[]) => Promise<unknown> },
  prodId: string,
  fallbackCost: number
): Promise<number> {
  try {
    const rows = (await db
      .select(
        `SELECT unit_cost FROM stock_batches
         WHERE product_id = $1 AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW') AND deleted = 0
         ORDER BY received_at DESC, created_at DESC LIMIT 1`,
        [prodId]
      )
      .catch(() => [])) as Array<{ unit_cost: number }>;
    if (rows?.[0] && Number.isFinite(Number(rows[0].unit_cost)) && Number(rows[0].unit_cost) > 0) {
      return Number(rows[0].unit_cost);
    }
  } catch {}
  return Math.max(0, Number(fallbackCost) || 0);
}

export interface CheckoutWriteResult {
  deviceId: string;
  fifoCostTotal: number | null;
  fifoProfit: number | null;
  ledgerCogsTotal?: number | null;
  fifoItems: Array<{
    id?: string;
    itemId?: string;
    unitCostAtSale?: number;
    lineProfit?: number;
    fifoAllocations?: Array<{ batchId: string; quantity: number; unitCost: number }>;
  }>;
}

export function writeCheckoutAtomic(
  input: CheckoutWriteInput,
  opts?: { flightOwner?: string },
): Promise<CheckoutWriteResult> {
  // Retry OUTSIDE the mutex: every attempt re-acquires the lock fresh, so a
  // BUSY collision with a racing sync lane becomes a short wait, not a lost
  // sale. Idempotency keys keep re-execution safe (INSERT … ON CONFLICT).
  // flightOwner threads the checkout-flight owner (processPayment /
  // boot-replay / refund-write) into the retry heartbeat so only the lane
  // holding the flight renews it (IPC-007).
  return withBusyRetry(() => withWriteLock(() => writeCheckoutAtomicInner(input)), {
    attempts: 8,
    baseDelayMs: 120,
    label: 'checkout',
    flightOwner: opts?.flightOwner,
    // B-001 FIX-3: on exhausted BUSY, surface a coded reason so processPayment
    // can distinguish "still retryable later" from a hard schema/disk error.
    // No return preserves the historical rethrow (B-004 recovery intent still
    // catches it upstream).
    onExhausted: (err) => {
      console.error('[writeCheckoutAtomic] SQLITE_BUSY exhausted after retries:', err);
    },
  }).then(async (result) => {
    // Receipt-time shadow reconcile: the sale is durable and the write lock
    // above is RELEASED, so reconcile may acquire it fresh here. Placing this
    // inside the inner txn/lock would self-deadlock (writeMutex is explicitly
    // NOT re-entrant). Resolves previously-booked SHADOW batches for the
    // products just sold — purchase stock may have landed since the shadow
    // was written. Best-effort per product: reconcile must never fail a
    // durable sale. The pull path also triggers reconcile for batches
    // arriving from peers.
    //
    // The Dexie batch mirror below is the third valuation sync point
    // (checkout / restitution / reconcile). `reconcileShadowBatches` only
    // mirrors when it actually resolved a shadow (`if (reconciledCount > 0)`),
    // so a sale that consumed real batches mirrored nothing and left the Dexie
    // `stockBatches` mirror stale — which is exactly what the SQLite → Dexie →
    // legacy valuation fallback reads. It runs AFTER reconcile so it observes
    // the resolved state, and strictly OUTSIDE the transaction/lock.
    try {
      const seen = new Set<string>();
      const soldProductIds: string[] = [];
      for (const item of result?.fifoItems ?? []) {
        const productId = item?.itemId;
        if (!productId || seen.has(productId)) continue;
        seen.add(productId);
        soldProductIds.push(productId);
        const batch = { productId };
        try {
          await reconcileShadowBatches(batch.productId);
        } catch (reconErr) {
          console.warn('[writeCheckoutAtomic] receipt-time reconcile skipped:', reconErr);
        }
      }
      if (soldProductIds.length > 0) {
        try {
          const db = await getLocalDb();
          await mirrorStockBatchesToDexie(db, soldProductIds);
        } catch (mirrorErr) {
          // NEVER fail a durable sale on a mirror failure: SQLite is the
          // authority and the Dexie copy is a derived fallback lane.
          console.warn('[writeCheckoutAtomic] Dexie batch mirror skipped:', mirrorErr);
        }
      }
    } catch (reconOuterErr) {
      console.warn('[writeCheckoutAtomic] receipt-time reconcile skipped:', reconOuterErr);
    }
    return result;
  });
}

/** Round to whole units (never NaN, preserves sign for signed quantities). */
function toIntMoney(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) ? v : 0;
}

const ORDER_MONEY_KEYS = [
  'subtotal', 'tax', 'discount_total', 'discountTotal', 'total',
  'cost_total', 'costTotal', 'profit', 'cash_tendered', 'cashTendered',
  'change_due', 'changeDue',
];
const ITEM_MONEY_KEYS = [
  'applied_price', 'appliedPrice', 'unit_price_charged', 'unitPriceCharged',
  'default_price', 'defaultPrice', 'discount_amount', 'discountAmount',
  'discount', 'cost_price', 'costPrice', 'unit_cost_at_sale', 'unitCostAtSale',
  'line_profit', 'lineProfit',
];

/**
 * Canonical integer-DA normalization for the atomic checkout write. Mutates
 * the per-call input object (constructed fresh by every caller).
 */
function normalizeMoneyInput(input: CheckoutWriteInput): void {
  try {
    const row = input.orderRow as Record<string, unknown>;
    for (const k of ORDER_MONEY_KEYS) {
      if (row[k] !== undefined && row[k] !== null) row[k] = toIntMoney(row[k]);
    }
    for (const it of input.items ?? []) {
      const r = it as Record<string, unknown>;
      for (const k of ITEM_MONEY_KEYS) {
        if (r[k] !== undefined && r[k] !== null) r[k] = toIntMoney(r[k]);
      }
    }
  } catch {
    // Normalization is best-effort — never fail a sale over rounding.
  }
}

async function writeCheckoutAtomicInner(input: CheckoutWriteInput): Promise<CheckoutWriteResult> {
  devBenchMark('checkout:start');
  const db = await getLocalDb();
  const deviceId = (await getOrCreateDeviceId(db)) || 'default';
  const now = utcNowIso();

  // Single-writer SQLite transaction: order + items + ledger + outbox commit
  // atomically, so a kill or a racing lane can never leave a half-sale behind.
  // BEGIN IMMEDIATE (not DEFERRED) takes the write lock up-front, which is
  // what serializes cross-tab writers; the same-window chain (withWriteLock
  // above) only orders callers inside this window. beginImmediate recovers
  // stale pooled txns (code 1) and only returns false on capability doubt —
  // never on BUSY/stale (those throw to withBusyRetry).
  // Defense layers (do not remove one without the others):
  //   (1) PRAGMA busy_timeout re-issued before critical BEGIN (beginImmediate)
  //   (2) withWriteLock serializes same-window writers
  //   (3) withBusyRetry re-runs the whole section on residual BUSY/stale-txn
  // Idempotency keys on all mutations make re-execution safe.
  const useTxn = await beginImmediate(db, 'writeCheckoutAtomic');

  // Monotonic version clock for the transactions lane. Local status writes must
  // bump `version`, otherwise applyRemoteRow's `WHERE excluded.version >=
  // transactions.version` guard cannot tell a stale echo (e.g. a queued
  // pre-void COMPLETED row) from a newer local state and silently un-voids a
  // sale. One source of truth: nextVersion feeds both the column and the
  // receipt payload so the push lane (toRemoteUpsert reads payload.version)
  // carries the same clock to the cloud.
  const txId = String(input.orderRow.id || newId('TXN'));
    const fin = (v: unknown): number | null => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? n : null;
    };
    const replayRows = (await db
      .select('SELECT cost_total, profit, ledger_cogs_total FROM transactions WHERE id = $1', [txId])
      .catch(() => [])) as Array<{ cost_total?: unknown; profit?: unknown; ledger_cogs_total?: unknown }>;
    const replayRow = replayRows?.[0];
    if (replayRow && replayRow.cost_total !== undefined) {
      let storedItems: Array<{ id: string; unitCostAtSale?: number; lineProfit?: number }> = [];
      try {
        const itemRows = (await db
          .select('SELECT id, unit_cost_at_sale, line_profit FROM transaction_items WHERE transaction_id = $1', [txId])
          .catch(() => [])) as Array<{ id: string; unit_cost_at_sale?: number; line_profit?: number }>;
        storedItems = itemRows.map((r) => ({
          id: String(r.id),
          unitCostAtSale: fin(r.unit_cost_at_sale) ?? undefined,
          lineProfit: fin(r.line_profit) ?? undefined,
        }));
      } catch {
        storedItems = [];
      }
      console.warn(
        `[writeCheckoutAtomic] replay-after-commit for ${txId}: sale already durable — returning stored materialization, no re-depletion.`
      );
      // The BEGIN above is still open and this return skips the owning
      // try/commit below (oversell path rolls back; this one must too) —
      // otherwise the pooled connection keeps an open write txn and every
      // later BEGIN on it fails into the stale-txn spray.
      if (useTxn) {
        await db.execute('ROLLBACK;').catch(() => {});
      }
      return {
        deviceId,
        fifoCostTotal: fin(replayRow.cost_total),
        fifoProfit: fin(replayRow.profit),
        ledgerCogsTotal:
          replayRow.ledger_cogs_total === null || replayRow.ledger_cogs_total === undefined
            ? null
            : fin(replayRow.ledger_cogs_total),
        fifoItems: storedItems,
      };
    }
  const receiptNo = String(input.orderRow.receipt_number || input.orderRow.receiptNumber || txId);
  // F0: idempotency keys are DERIVED from the sale id, never minted per
  // attempt. withBusyRetry re-executes this whole function (and boot replay
  // re-runs the saved payload) — fresh random keys per execution would
  // double-insert ledger deltas (double stock decrement) and duplicate
  // outbox rows. Derived keys + ON CONFLICT guards make re-execution safe.
  // Explicit caller keys (void/refund compensation identity) always win.
  const orderKey = String(input.orderRow.idempotency_key || `order-${txId}`);
  const existingVerRows = (await db
    .select('SELECT version FROM transactions WHERE id=$1', [txId])
    .catch((e: unknown) => {
      // BUSY must retry (outer withBusyRetry), not silently reset to version 1.
      if (isBusyError(e)) throw e;
      return [];
    })) as Array<{ version: number }>;
  const nextVersion = Number(existingVerRows?.[0]?.version ?? 0) + 1;

  // FIFO resolution accumulators (function scope: populated inside the write
  // try-block below, returned after commit). fifoOrderCostTotal/Profit stay
  // null when FIFO did not resolve (refund receipts, catalog-fallback path).
  let fifoOrderCostTotal: number | null = null;
  let fifoOrderProfit: number | null = null;
  let fifoLedgerCogsTotal: number | null = null;
  const fifoItemResolutions: Array<{
    id?: string;
    itemId: string;
    unitCostAtSale: number;
    lineProfit: number;
    fifoAllocations: Array<{ batchId: string; quantity: number; unitCost: number }>;
  }> = [];

  // Oversell guard. The cart's stock check (createCartSlice) validates against
  // the Zustand copy, which is stale the moment another lane sells the same
  // SKU — a second till, a synced remote sale, or a double-tap on "Encaisser"
  // between render and click. The ledger is the only authoritative stock, so
  // re-check it here, at the write boundary, before any row is persisted.
  // Refunds pass deltas:[] and restock via appendInventoryDeltas, so only
  // SALE deltas are bounded. Products with no ledger row at all (catalog never
  // opened / seeded only into Dexie) are treated as untracked and allowed.
  const saleDeltas = input.deltas.filter((d) => {
    const pid = String(d.productId || '');
    const isService = pid.startsWith('qt-') || pid.startsWith('prod-misc-');
    return !isService && String(d.reason ?? 'SALE') === 'SALE';
  });
  if (saleDeltas.length > 0) {
    for (const d of saleDeltas) {
      const pid = String(d.productId || '');
      if (!pid || pid.startsWith('qt-') || pid.startsWith('prod-misc-')) continue;
      const prodRows = (await db
        .select('SELECT category FROM products WHERE id=$1', [pid])
        .catch((e: unknown) => {
          if (isBusyError(e)) throw e;
          return [];
        })) as Array<{ category: string }>;
      if (prodRows?.[0]?.category === 'Services') continue;

      const avail = (await db
        .select(
          'SELECT COUNT(*) AS n, COALESCE(SUM(delta),0) AS s FROM inventory_ledger WHERE product_id=$1 AND deleted=0',
          [pid],
        )
        .catch((e: unknown) => {
          // BUSY here must retry — returning [] would fake rowCount=0
          // (untracked) and bypass the oversell guard.
          if (isBusyError(e)) throw e;
          return [];
        })) as Array<{ n: number; s: number }>;
      const rowCount = Number(avail?.[0]?.n ?? 0);
      const ledgerSum = Number(avail?.[0]?.s ?? 0);
      if (rowCount > 0) {
        const take = Math.abs(Number(d.delta ?? 0));
        if (ledgerSum - take < 0) {
          // Guard throws BEFORE the write try-block below, so roll back the
          // already-open transaction here — otherwise the connection keeps an
          // abandoned write txn (and its lock) for every later statement.
          if (useTxn) {
            await db.execute('ROLLBACK;').catch(() => {});
          }
          throw new Error(
            `INSUFFICIENT_STOCK:${pid}: ledger=${ledgerSum} requested=${take}`,
          );
        }
      }
    }
  }

  // Services-category parity set for the ledger insert + recompute below:
  // the oversell guard above skips the whole Services category (not just
  // terminal prefixes). A guarded-as-unstocked product must not accumulate
  // SALE ledger deltas — sales would decrement a stock nothing bounds,
  // driving the ledger negative and the recompute into clamp-inducing small
  // numbers. One batched category lookup (same pattern as the guard).
  const unstockedCategoryIds = new Set<string>();
  try {
    // Snapshots first: stub rows are inserted later inside the write block,
    // so a first-time Services product would be invisible to the table
    // lookup below — its snapshot category is known up front.
    for (const p of input.productSnapshots ?? []) {
      const pId = String((p as { id?: unknown })?.id ?? '');
      if (pId && (p as { category?: unknown })?.category === 'Services') unstockedCategoryIds.add(pId);
    }
    const pidList = [...new Set((input.deltas ?? []).map((d) => String(d.productId || '')).filter(Boolean))].filter(
      (pid) => !pid.startsWith('qt-') && !pid.startsWith('prod-misc-') && !unstockedCategoryIds.has(pid)
    );
    if (pidList.length > 0) {
      const catRows = (await db
        .select(`SELECT id FROM products WHERE id IN (${pidList.map(() => '?').join(',')}) AND category = 'Services'`, pidList)
        .catch(() => [])) as Array<{ id?: string }>;
      for (const r of catRows ?? []) {
        if (r?.id) unstockedCategoryIds.add(String(r.id));
      }
    }
  } catch {
    // Category lookup unavailable — prefix rule still applies below.
  }

  try {
    // Integer-DA invariant (ad.md §8): money persists as whole dinars ONLY.
    // computeCartTotals/computeTax/debt paths already round, but profit, costs
    // and refund/void call sites can still hand floats (e.g. 189.81 VAT-style
    // math, blended FIFO unit costs). Two devices storing 189.81 vs 190 for
    // the same logical sale diverge forever (REAL columns). Canonicalize once
    // here — the single durable write choke every sale/refund funnels through —
    // so stored + synced money is always integer-safe regardless of caller.
    // NOTE: profit_margin is a ratio, not money — left untouched.
    normalizeMoneyInput(input);
    // Ensure referenced products exist locally (stub if seed only hit Dexie).
    // MUST run before order_items (FK product_id -> products).
    for (const p of input.productSnapshots ?? []) {
      const pId = String(p.id || newId('prod'));
      const isService = pId.startsWith('qt-') || pId.startsWith('prod-misc-') || p.category === 'Services';
      const initialStock = isService ? 999999 : 0;
      await db.execute(
        `INSERT OR IGNORE INTO products (id, sku, barcode, title, brand, category, price,
          wholesale_price, cost_price, stock, json_payload, device_id, idempotency_key,
          sync_status, created_at, updated_at, deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,$8,$9,$10,$11,'pending',$12,$12,0)`,
        [
          pId, p.sku ?? '', p.barcode ?? '', p.title || pId || 'Article', p.brand || 'Autre',
          p.category || (isService ? 'Services' : 'Tous les produits'), Number(p.price ?? 0),
          initialStock, JSON.stringify(p), deviceId, `stub-${pId}`, now,
        ],
      );
      if (isService) {
        await db.execute(
          `UPDATE products SET stock = 999999, category = 'Services' WHERE id = $1 AND stock < 999999`,
          [pId],
        ).catch(() => {});
      }
    }

    // (Product snapshots are refreshed in step 7 after the ledger inserts, so the
    // outbox payload carries post-sale stock and rowids stay parent-first.)
    const touchedIds = [...new Set([
      ...(input.productSnapshots ?? []).map((p) => String(p.id || '')).filter(Boolean),
      ...input.deltas.map((d) => String(d.productId || '')).filter(Boolean),
    ])];

    const orderSync = 'pending';

    // 1. Resolve FIFO batch depletions and freeze sale_batch_allocations BEFORE
    // inserting transactions or transaction_items.
    // FIFO authority (single source of truth for COGS): for SALE receipts the
    // per-line unit cost MUST come from FIFO batch depletion resolved here,
    // inside the same SQLite write transaction — never from the caller's
    // catalog snapshot (costPrice / 50%-of-price estimate), which varies per
    // device and would make margin/profit diverge between Desktop and Mobile
    // for the same physical stock. Refund/voucher receipts (isRefund) carry
    // no COGS: depletion is skipped so a refund can never phantom-deplete
    // the oldest batch (restitution owns the stock movement via deltas).
    const fullTxKind = (input.fullTx ?? {}) as Record<string, unknown>;
    const isRefundReceipt = Boolean(fullTxKind.isRefund);
    let fifoCostTotalAccum = 0;
    let fifoResolvedAny = false;
    let allocLedgerTotal = 0;
    let allocLedgerAvailable = true;
    let preAllocSum = 0;

    const terminalProductIds = new Set<string>();
    for (const s of (input.productSnapshots ?? []) as Array<{ id?: unknown; category?: unknown }>) {
      const sid = String(s?.id ?? '');
      if (!sid) continue;
      const category = String(s?.category ?? '');
      if (
        sid.startsWith('qt-') ||
        sid.startsWith('prod-misc-') ||
        sid.startsWith('prod-trade') ||
        category === 'Services' ||
        category === "Téléphones d'Occasion (Reprise)"
      ) {
        terminalProductIds.add(sid);
      }
    }

    let hasReturnLines = false;
    try {
      const pre = (await db
        .select(
          `SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS s
           FROM sale_batch_allocations WHERE sale_id = $1 AND deleted = 0`,
          [txId],
        )
        .catch(rethrowBusy)) as Array<{ s: number }>;
      preAllocSum = Math.max(0, Math.round(Number(pre?.[0]?.s ?? 0)));
    } catch (e) {
      if (isBusyError(e)) throw e;
      preAllocSum = 0;
    }

    type PreparedItem = {
      itemId: string;
      itemKey: string;
      prodId: string;
      qtySold: number;
      appliedPrice: number;
      discount: number;
      imeiNum: string;
      fallbackCost: number;
      unitPriceCharged: number;
      unitCostAtSale: number;
      discountAmount: number;
      lineProfit: number;
      enrichedPayload: string;
      isReturnLine: boolean;
      /** Months captured on the order line at sale — the point-in-time term. */
      warrantyMonthsAtSale?: number;
      rawItem: Record<string, unknown>;
    };
    const preparedItems: PreparedItem[] = [];

    for (const [idx, it] of input.items.entries()) {
      const itemId = String(it.id || `${txId}-item-${idx}`);
      const prodId = String(it.product_id || it.productId || 'unknown');
      const itemKey = String(it.idempotency_key || `${txId}-itemkey-${idx}`);

      const qtySold = Number(it.quantity ?? 1);
      const appliedPrice = Number(it.applied_price ?? it.appliedPrice ?? 0);
      const unitPriceCharged = Number(it.unit_price_charged ?? it.unitPriceCharged ?? appliedPrice);
      const defaultPrice = Number(it.default_price ?? it.defaultPrice ?? (it.applied_price ?? it.appliedPrice ?? 0));
      const discountAmount = Number(it.discount_amount ?? it.discountAmount ?? Math.max(0, defaultPrice - unitPriceCharged));
      const fallbackCost = Number(it.cost_price ?? it.costPrice ?? 0);

      let blendedUnitCost = fallbackCost;
      let fifoAuthoritativeCost: number | null = null;
      const fifoAllocations: Array<{ batchId: string; quantity: number; unitCost: number }> = [];
      const isReturnLine = Boolean(it.is_return ?? it.isReturn);
      const isTerminalLine =
        terminalProductIds.has(prodId) ||
        prodId.startsWith('qt-') ||
        prodId.startsWith('prod-misc-') ||
        prodId.startsWith('prod-trade');
      if (isReturnLine) hasReturnLines = true;

      if (!isRefundReceipt && isReturnLine) {
        try {
          const lineQty = Math.abs(Math.round(Number(qtySold) || 0));
          const lineCost = toIntMoney(fallbackCost);
          if (lineQty > 0) {
            const earliest = (await db
              .select(
                `SELECT batch_id, quantity_remaining, unit_cost, received_at, purchase_order_id, created_at
                 FROM stock_batches
                 WHERE product_id = $1 AND quantity_remaining > 0 AND deleted = 0
                   AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
                 ORDER BY received_at ASC, batch_id ASC LIMIT 1`,
                [prodId]
              )
              .catch(rethrowBusy)) as FifoBatchRow[];
            if (earliest?.[0]) {
              const target = earliest[0];
              await db.execute(
                `UPDATE stock_batches
                 SET quantity_remaining = quantity_remaining + $1,
                     version = version + 1,
                     updated_at = $2,
                     sync_status = 'pending'
                 WHERE batch_id = $3`,
                [lineQty, now, target.batch_id]
              );
              const bumped = (await db
                .select('SELECT quantity_remaining, version FROM stock_batches WHERE batch_id = $1', [target.batch_id])
                .catch(rethrowBusy)) as Array<{ quantity_remaining: number; version: number }>;
              const exKey = `sb-${target.batch_id}-${txId}`;
              await db.execute(
                `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
                 VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
                [
                  exKey,
                  target.batch_id,
                  JSON.stringify({
                    version: toFiniteNumber(bumped?.[0]?.version, 1),
                    batch_id: target.batch_id,
                    product_id: prodId,
                    quantity_remaining: toFiniteNumber(bumped?.[0]?.quantity_remaining, toFiniteNumber(target.quantity_remaining, 0) + lineQty),
                    unit_cost: toFiniteNumber(target.unit_cost, 0),
                    received_at: target.received_at,
                    purchase_order_id: target.purchase_order_id ?? null,
                    created_at: target.created_at ?? target.received_at,
                    device_id: deviceId,
                    updated_at: now,
                  }),
                  now,
                ]
              );
              fifoAllocations.push({ batchId: target.batch_id, quantity: lineQty, unitCost: toFiniteNumber(target.unit_cost, 0) });
            } else {
              const exBatchId = newId('batch-exchange');
              const exKey = newIdempotencyKey();
              await db.execute(
                `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
                  purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
                 VALUES ($1, $2, $3, $4, $5, 'EXCHANGE', $6, $7, 'pending', 1, $5, $5, 0)`,
                [exBatchId, prodId, lineQty, lineCost, now, deviceId, exKey]
              );
              await db.execute(
                `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
                 VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
                [
                  exKey,
                  exBatchId,
                  JSON.stringify({
                    version: 1, batch_id: exBatchId, product_id: prodId,
                    quantity_remaining: lineQty, unit_cost: lineCost, received_at: now,
                    purchase_order_id: 'EXCHANGE', device_id: deviceId,
                    idempotency_key: exKey, created_at: now, updated_at: now,
                  }),
                  now,
                ]
              );
              fifoAllocations.push({ batchId: exBatchId, quantity: lineQty, unitCost: lineCost });
            }
          }
          fifoAuthoritativeCost = toIntMoney(fallbackCost);
        } catch (batchErr) {
          if (isBusyError(batchErr)) throw batchErr;
          console.warn('[FIFO] Exchange restock fallback to catalog cost:', batchErr);
          fifoAuthoritativeCost = null;
        }
      } else if (!isRefundReceipt) {
        try {
          const availableBatches = (await db
            .select(
              `SELECT batch_id, quantity_remaining, unit_cost, received_at, purchase_order_id, created_at
               FROM stock_batches
               WHERE product_id = $1 AND quantity_remaining > 0 AND deleted = 0
                 AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
               ORDER BY received_at ASC, batch_id ASC`,
              [prodId]
            )
            .catch((e: unknown) => {
              if (isBusyError(e)) throw e;
              return [];
            })) as FifoBatchRow[];

          let needed = qtySold;
          let totalCostAccum = 0;
          let totalAllocatedQty = 0;
          const ctx: DepleteCtx = { prodId, deviceId, now, txId };

          for (const batch of availableBatches) {
            if (needed <= 0) break;
            const avail = Math.max(0, Math.floor(Number(batch.quantity_remaining) || 0));
            const want = Math.min(avail, needed);
            if (want <= 0) continue;
            let take = 0;
            const first = await depleteBatchGuarded(db, { ...batch, quantity_remaining: avail }, want, ctx);
            if (first.taken > 0) {
              take = first.taken;
            } else {
              const fresh = (await db
                .select('SELECT quantity_remaining FROM stock_batches WHERE batch_id = $1', [batch.batch_id])
                .catch(rethrowBusy)) as Array<{ quantity_remaining: number }>;
              const left = Math.max(0, Math.floor(Number(fresh?.[0]?.quantity_remaining ?? 0)));
              const want2 = Math.min(left, needed);
              if (want2 <= 0) continue;
              const second = await depleteBatchGuarded(db, { ...batch, quantity_remaining: left }, want2, ctx);
              if (second.taken <= 0) continue;
              take = second.taken;
            }
            needed -= take;
            totalAllocatedQty += take;
            totalCostAccum += take * Number(batch.unit_cost);
            fifoAllocations.push({
              batchId: batch.batch_id,
              quantity: take,
              unitCost: Number(batch.unit_cost),
            });
          }

          if (needed > 0) {
            const shadowCost = await lastKnownPurchaseCost(db, prodId, fallbackCost);
            const shadowId = `shadow-${txId}-${idx}`;
            const shadowKey = `sb-${shadowId}`;
            const terminalService = isTerminalLine;
            try {
              await db.execute(
                `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
                  purchase_order_id, device_id, idempotency_key, sync_status, version,
                  created_at, updated_at, deleted, shadow_sale_id, shadow_item_id, shadow_qty, shadow_resolved)
                 VALUES ($1, $2, 0, $3, $4, 'SHADOW', $5, $6, 'pending', 1, $4, $4, 0, $7, $8, $9, $10)
                 ON CONFLICT(batch_id) DO NOTHING`,
                [shadowId, prodId, shadowCost, now, deviceId, shadowKey, terminalService ? null : txId, terminalService ? null : itemId, needed, terminalService ? 1 : 0]
              );
              await db.execute(
                `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
                 VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
                [
                  shadowKey,
                  shadowId,
                  JSON.stringify({
                    version: 1, batch_id: shadowId, product_id: prodId,
                    quantity_remaining: 0, unit_cost: shadowCost, received_at: now,
                    purchase_order_id: 'SHADOW', device_id: deviceId,
                    idempotency_key: shadowKey, created_at: now, updated_at: now,
                    shadow_sale_id: terminalService ? null : txId, shadow_item_id: terminalService ? null : itemId,
                    shadow_qty: needed, shadow_resolved: terminalService ? 1 : 0,
                  }),
                  now,
                ]
              );
            } catch (shadowErr) {
              if (isBusyError(shadowErr)) throw shadowErr;
              console.warn('[FIFO] Shadow batch persist skipped (schema pre-heal):', shadowErr);
            }
            totalCostAccum += needed * shadowCost;
            totalAllocatedQty += needed;
            fifoAllocations.push({ batchId: shadowId, quantity: needed, unitCost: shadowCost });
          }

          if (totalAllocatedQty > 0) {
            blendedUnitCost = totalCostAccum / totalAllocatedQty;
          }
          fifoAuthoritativeCost = toIntMoney(blendedUnitCost);
        } catch (batchErr) {
          if (isBusyError(batchErr)) throw batchErr;
          console.warn('[FIFO] Batch depletion fallback to catalog cost:', batchErr);
          blendedUnitCost = fallbackCost;
          fifoAuthoritativeCost = null;
        }
      }

      const callerUnitCost = Number(it.unit_cost_at_sale ?? it.unitCostAtSale ?? blendedUnitCost);
      const unitCostAtSale = fifoAuthoritativeCost ?? callerUnitCost;
      const signedQty = isReturnLine ? -Math.abs(qtySold) : Math.abs(qtySold);
      const lineProfit = (unitPriceCharged - unitCostAtSale) * signedQty;
      if (fifoAuthoritativeCost !== null) {
        fifoResolvedAny = true;
      }
      fifoCostTotalAccum += unitCostAtSale * signedQty;
      fifoItemResolutions.push({
        id: itemId,
        itemId,
        unitCostAtSale,
        lineProfit,
        fifoAllocations: fifoAllocations.map((a) => ({ ...a })),
      });

      if (!isRefundReceipt && !isReturnLine && fifoAllocations.length > 0) {
        for (const alloc of fifoAllocations) {
          const takeQty = Math.max(0, Math.floor(Number(alloc.quantity ?? 0)));
          const frozenUnitCost = Math.max(0, toIntMoney(alloc.unitCost ?? 0));
          if (!(takeQty > 0)) continue;
          const allocId = `alloc-${txId}-${idx}-${String(alloc.batchId)}`;
          try {
            await db.execute(
              `INSERT INTO sale_batch_allocations
                 (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
                  created_at, product_id, sale_item_id,
                  device_id, idempotency_key, sync_status, version, updated_at, deleted)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',1,$6,0)
               ON CONFLICT(id) DO UPDATE SET
                 qty_consumed = sale_batch_allocations.qty_consumed + excluded.qty_consumed,
                 updated_at = excluded.updated_at, sync_status = 'pending'`,
              [
                allocId, txId, String(alloc.batchId), takeQty, frozenUnitCost,
                now, prodId, itemId, deviceId, allocId,
              ],
            );
            allocLedgerTotal += takeQty * frozenUnitCost;
          } catch (allocErr) {
            if (isBusyError(allocErr)) throw allocErr;
            const msg = String((allocErr as { message?: unknown })?.message ?? allocErr);
            if (/no such table/i.test(msg)) {
              console.warn('[FIFO-ledger] sale_batch_allocations missing (pre-v104 heal), sale still durable via lines:', msg);
              allocLedgerAvailable = false;
              break;
            }
            throw allocErr;
          }
        }
      }

      const imeiNum = String((it.imei_number as string) ?? (it.imeiNumber as string) ?? '').trim();
      const enrichedPayload = toBoundedSyncJson({
        ...it,
        id: itemId,
        transaction_id: txId,
        product_id: prodId,
        unit_price_charged: unitPriceCharged,
        unit_cost_at_sale: unitCostAtSale,
        discount_amount: discountAmount,
        line_profit: lineProfit,
        fifo_allocations: fifoAllocations,
      });

      preparedItems.push({
        itemId,
        itemKey,
        prodId,
        qtySold,
        appliedPrice,
        discount: Number(it.discount ?? 0),
        imeiNum,
        fallbackCost,
        unitPriceCharged,
        unitCostAtSale,
        discountAmount,
        lineProfit,
        enrichedPayload,
        isReturnLine,
        warrantyMonthsAtSale: Number(
          (it.warranty_months_at_sale ?? (it as Record<string, unknown>).warrantyMonthsAtSale ?? 0) || 0
        ),
        rawItem: it as Record<string, unknown>,
      });
    }

    // 2. Order-level FIFO calculation:
    // Determine the exact cost_total, profit, profit_margin and ledger_cogs_total
    // BEFORE inserting the sales row.
    const orderTotal = toIntMoney(input.orderRow.total ?? 0);
    if (!isRefundReceipt && fifoResolvedAny) {
      fifoOrderCostTotal = toIntMoney(fifoCostTotalAccum);
      fifoOrderProfit = orderTotal - fifoOrderCostTotal;
      fifoLedgerCogsTotal = toIntMoney(preAllocSum + allocLedgerTotal);
    }

    const finalCostTotal = fifoOrderCostTotal !== null
      ? fifoOrderCostTotal
      : toIntMoney(input.orderRow.cost_total ?? input.orderRow.costTotal ?? 0);
    const finalProfit = fifoOrderProfit !== null
      ? fifoOrderProfit
      : toIntMoney(input.orderRow.profit ?? 0);
    const finalProfitMargin = fifoOrderCostTotal !== null
      ? (orderTotal > 0 ? Number(((finalProfit / orderTotal) * 100).toFixed(1)) : 0)
      : Number(input.orderRow.profit_margin ?? input.orderRow.profitMargin ?? 0);
    const finalLedgerCogsTotal = fifoLedgerCogsTotal;

    // Canonical receipt JSON: full transaction carrying the exact FIFO totals and item costs
    const rawTx = (input.fullTx ?? input.orderRow ?? { id: txId }) as Record<string, unknown>;
    const parsedReceipt: Record<string, unknown> = {
      ...rawTx,
      id: txId,
      receiptNumber: receiptNo,
      receipt_number: receiptNo,
      deviceId,
      device_id: deviceId,
      version: nextVersion,
      costTotal: finalCostTotal,
      cost_total: finalCostTotal,
      profit: finalProfit,
      profitMargin: finalProfitMargin,
      profit_margin: finalProfitMargin,
    };
    if (finalLedgerCogsTotal !== null) {
      parsedReceipt.ledgerCogsTotal = finalLedgerCogsTotal;
      parsedReceipt.ledger_cogs_total = finalLedgerCogsTotal;
    }
    if (Array.isArray(parsedReceipt.items)) {
      parsedReceipt.items = parsedReceipt.items.map((ri, riIdx) => {
        const res = fifoItemResolutions[riIdx];
        if (!res || typeof ri !== 'object' || ri === null) return ri;
        return {
          ...ri,
          unitCostAtSale: res.unitCostAtSale,
          unitCostPrice: res.unitCostAtSale,
          unit_cost_at_sale: res.unitCostAtSale,
          lineProfit: res.lineProfit,
          line_profit: res.lineProfit,
        };
      });
    }
    const receiptJson = toBoundedSyncJson(parsedReceipt);

    // 3. Atomically write the sales record into SQLite with the exact FIFO COGS hardcoded.
    const txnParamsWithLedger = [
      txId,
      receiptNo,
      (input.orderRow.customer_id as string) ?? (input.orderRow.customerId as string) ?? null,
      Number(input.orderRow.subtotal ?? 0),
      Number(input.orderRow.tax ?? 0),
      Number(input.orderRow.discount_total ?? input.orderRow.discountTotal ?? 0),
      Number(input.orderRow.total ?? 0),
      finalCostTotal,
      finalProfit,
      finalProfitMargin,
      String(input.orderRow.pricing_tier ?? input.orderRow.pricingTier ?? 'Retail'),
      String(input.orderRow.payment_method ?? input.orderRow.paymentMethod ?? 'Espèces'),
      Number(input.orderRow.cash_tendered ?? input.orderRow.cashTendered ?? 0),
      Number(input.orderRow.change_due ?? input.orderRow.changeDue ?? 0),
      String(input.orderRow.status ?? 'COMPLETED'),
      String(input.orderRow.created_at ?? input.orderRow.createdAt ?? now),
      receiptJson,
      deviceId,
      orderKey,
      orderSync,
      now,
      nextVersion,
      finalLedgerCogsTotal,
    ];

    try {
      const shiftVal =
        (input.orderRow.shift_id as string | null) ??
        ((input.orderRow as { shiftId?: unknown }).shiftId as string | null) ??
        null;
      // Refund linkage for the indexed over-refund bound (DB-002): sales
      // carry null, refund receipts carry their original's id.
      const origTxnId =
        (input.orderRow.original_transaction_id as string | null) ??
        ((input.orderRow as { originalTransactionId?: unknown }).originalTransactionId as string | null) ??
        null;
      await db.execute(
        `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
          cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
          status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, version, deleted, ledger_cogs_total, shift_id, original_transaction_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,0,$23,$24,$25)
         ON CONFLICT(id) DO UPDATE SET receipt_number=excluded.receipt_number, total=excluded.total,
           cost_total=excluded.cost_total, profit=excluded.profit, profit_margin=excluded.profit_margin,
           ledger_cogs_total=excluded.ledger_cogs_total, shift_id=excluded.shift_id,
           original_transaction_id=excluded.original_transaction_id,
           status=excluded.status, json_payload=excluded.json_payload, updated_at=excluded.updated_at,
           sync_status='pending', idempotency_key=excluded.idempotency_key, version=excluded.version`,
        [...txnParamsWithLedger, shiftVal, origTxnId],
      );
    } catch (insertErr) {
      if (isBusyError(insertErr)) throw insertErr;
      const msg = String((insertErr as { message?: unknown })?.message ?? insertErr);
      // Pre-linkage schema (heal raced the write): the shift-statement below
      // also omits the new column. The sale/refund still records; the
      // flagged one-shot backfill covers the linkage once the column
      // exists. Same for a missing shift_id (pre-existing behavior).
      const missShift =
        /no column named shift_id/i.test(msg) || /no column named original_transaction_id/i.test(msg);
      const missLedger = /no column named ledger_cogs_total/i.test(msg);
      if (missShift && !missLedger) {
        // Pre-shift_id schema (heal raced the write): same statement minus
        // the new column. The sale still records; attribution falls back to
        // the createdAt window at close.
        await db.execute(
          `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
            cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
            status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, version, deleted, ledger_cogs_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,0,$23)
           ON CONFLICT(id) DO UPDATE SET receipt_number=excluded.receipt_number, total=excluded.total,
             cost_total=excluded.cost_total, profit=excluded.profit, profit_margin=excluded.profit_margin,
             ledger_cogs_total=excluded.ledger_cogs_total,
             status=excluded.status, json_payload=excluded.json_payload, updated_at=excluded.updated_at,
             sync_status='pending', idempotency_key=excluded.idempotency_key, version=excluded.version`,
          txnParamsWithLedger,
        );
      } else if (missLedger) {
        await db.execute(
          `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
            cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
            status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, version, deleted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,0)
           ON CONFLICT(id) DO UPDATE SET receipt_number=excluded.receipt_number, total=excluded.total,
             cost_total=excluded.cost_total, profit=excluded.profit, profit_margin=excluded.profit_margin,
             status=excluded.status, json_payload=excluded.json_payload, updated_at=excluded.updated_at,
             sync_status='pending', idempotency_key=excluded.idempotency_key, version=excluded.version`,
          txnParamsWithLedger.slice(0, 22),
        );
      } else {
        throw insertErr;
      }
    }

    // 4. Enqueue customer UPSERT if present in transaction (Strict Parent-First)
    const attachedCustomer = (input.fullTx as Record<string, unknown> | undefined)?.customer as Record<string, unknown> | undefined;
    if (attachedCustomer && attachedCustomer.id) {
      const custId = String(attachedCustomer.id);
      const custKey = await stableEntityKey(db, 'customer', custId);
      const custVersion = await bumpEntityVersion(db, 'customer', custId);
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'customer',$2,'UPSERT',$3,'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
        [custKey, custId, toBoundedSyncJson({ ...attachedCustomer, version: custVersion }), now],
      );
    }

    // 5. Enqueue product UPSERTs
    for (const pid of touchedIds) {
      const rows = (await db.select('SELECT * FROM products WHERE id=$1', [pid]).catch(() => [])) as Array<Record<string, unknown>>;
      const prow = rows?.[0];
      if (!prow) continue;
      const pkey = (prow.idempotency_key as string) || `stub-${pid}`;
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'product',$2,'UPSERT',$3,'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
        [pkey, pid, toBoundedSyncJson(prow), now],
      );
    }

    // 6. Enqueue order (Parent of items & ledger)
    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1,'order',$2,'UPSERT',$3,'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
      [orderKey, txId, receiptJson, now],
    );

    // 7. Enqueue order items & IMEI ownership
    for (const pit of preparedItems) {
      await db.execute(
        `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
          imei_number, cost_price, unit_price_charged, unit_cost_at_sale, discount_amount, line_profit,
          json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$16,$16,0)
         ON CONFLICT(id) DO UPDATE SET quantity=excluded.quantity, applied_price=excluded.applied_price,
           unit_price_charged=excluded.unit_price_charged, unit_cost_at_sale=excluded.unit_cost_at_sale,
           discount_amount=excluded.discount_amount, line_profit=excluded.line_profit,
           json_payload=excluded.json_payload, updated_at=excluded.updated_at, sync_status='pending'`,
        [
          pit.itemId,
          txId,
          pit.prodId,
          pit.qtySold,
          pit.appliedPrice,
          pit.discount,
          pit.imeiNum || null,
          pit.fallbackCost,
          pit.unitPriceCharged,
          pit.unitCostAtSale,
          pit.discountAmount,
          pit.lineProfit,
          pit.enrichedPayload,
          deviceId,
          pit.itemKey,
          now,
        ],
      );
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'order_item',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
        [pit.itemKey, pit.itemId, pit.enrichedPayload],
      );

      if (pit.imeiNum) {
        const takesOwnership = !isRefundReceipt && !pit.isReturnLine;
        if (takesOwnership) {
          const linkedTxnIsRefund = async (linkedId: string): Promise<boolean> => {
            try {
              const t = (await db
                .select('SELECT json_payload FROM transactions WHERE id = $1', [linkedId])
                .catch(rethrowBusy)) as Array<{ json_payload?: string | null }>;
              const raw = t?.[0]?.json_payload;
              if (!raw) return false;
              try {
                const p = JSON.parse(String(raw)) as { isRefund?: unknown };
                return Boolean(p?.isRefund);
              } catch {
                return false;
              }
            } catch (e) {
              if (isBusyError(e)) throw e;
              return false;
            }
          };
          const imeiFree = await (async (): Promise<boolean> => {
            try {
              const r = (await db
                .select('SELECT data_json FROM imei_records WHERE id = $1', [pit.imeiNum])
                .catch(rethrowBusy)) as Array<{ data_json?: string | null }>;
              if (!r?.[0]) return true;
              let linked: string | null = null;
              let soldAt: string | null = null;
              try {
                const d = JSON.parse(String(r[0].data_json ?? '{}')) as {
                  sale_transaction_id?: unknown;
                  sold_at?: unknown;
                };
                linked = d.sale_transaction_id ? String(d.sale_transaction_id) : null;
                soldAt = d.sold_at ? String(d.sold_at) : null;
              } catch {
                return false;
              }
              if (!linked && !soldAt) return true;
              if (linked && (linked === txId || (await linkedTxnIsRefund(linked)))) return true;
              return false;
            } catch (e) {
              if (isBusyError(e)) throw e;
              try {
                const r2 = (await db
                  .select('SELECT sale_transaction_id, sold_at FROM imei_records WHERE imei = $1', [pit.imeiNum])
                  .catch(rethrowBusy)) as Array<{ sale_transaction_id?: string | null; sold_at?: string | null }>;
                const s = r2?.[0];
                const linked = s?.sale_transaction_id ? String(s.sale_transaction_id) : null;
                if (!linked && !s?.sold_at) return true;
                if (linked && (linked === txId || (await linkedTxnIsRefund(linked)))) return true;
                return false;
              } catch (e2) {
                if (isBusyError(e2)) throw e2;
                return true;
              }
            }
          })();
          if (!imeiFree) {
            throw new Error(`IMEI_ALREADY_SOLD:${pit.imeiNum}`);
          }
        }
const imeiVersion = await bumpEntityVersion(db, 'imei', pit.imeiNum);
          // Point-in-time warranty anchor, minted ONCE here at checkout.
          // Reads prefer this value, so a later catalog `warrantyMonths` edit
          // cannot retroactively re-date coverage a customer already bought.
          // `warranty_months_at_sale` is captured on the order line by the cart
          // (the only layer holding the sale-time product snapshot).
          // Already a non-negative integer from `resolveWarrantyWithFallback`, so no
          // re-floor here — the money-path float registry is shrink-only and a
          // redundant coercion must not grow it.
          const wMonths = Math.max(0, Number(pit.warrantyMonthsAtSale ?? 0) || 0);
          const { addMonthsClamped } = await import('../utils/warrantyResolver');
          const wExpiresAt =
            wMonths > 0 ? addMonthsClamped(now, wMonths) : new Date(now).toISOString();
          // `received_at` MUST NOT be stamped with the sale time: it is the
          // inventory-aging / FIFO clock. Preserve the true stock-entry instant
          // when the device is already registered, else fall back to `now`.
          const priorReceivedAt = await (async (): Promise<string | null> => {
            try {
              const rows = (await db
                .select('SELECT received_at FROM imei_records WHERE imei = $1', [pit.imeiNum])
                .catch(rethrowBusy)) as Array<{ received_at?: string | null }>;
              const v = rows?.[0]?.received_at;
              return v ? String(v) : null;
            } catch (e) {
              if (isBusyError(e)) throw e;
              return null;
            }
          })();
          const imeiData = {
            imei: pit.imeiNum,
            product_id: pit.prodId,
            sale_transaction_id: txId,
            sold_at: now,
            received_at: priorReceivedAt || now,
            warranty_months: wMonths,
            warranty_expires_at: wExpiresAt,
            version: imeiVersion,
          };
        const imeiKey = await stableEntityKey(db, 'imei', pit.imeiNum);
        try {
          await db.execute(
            `INSERT INTO imei_records (id, data_json, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
             VALUES ($1, $2, $3, $4, 'pending', 1, $5, $5, 0)
             ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at, sync_status='pending'`,
            [normalizeImeiKey(pit.imeiNum), JSON.stringify(imeiData), deviceId, imeiKey, now],
          );
        } catch {
          try {
            await db.execute(
              `INSERT INTO imei_records (imei, product_id, sale_transaction_id, sold_at,
                                         received_at, warranty_expires_at, warranty_months, version)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
               ON CONFLICT(imei) DO UPDATE SET
                 sale_transaction_id=excluded.sale_transaction_id,
                 sold_at=excluded.sold_at,
                 product_id=excluded.product_id,
                 warranty_expires_at=COALESCE(imei_records.warranty_expires_at,
                                              excluded.warranty_expires_at),
                 warranty_months=COALESCE(imei_records.warranty_months,
                                          excluded.warranty_months),
                 version=imei_records.version + 1`,
              [normalizeImeiKey(pit.imeiNum), pit.prodId, txId, now, priorReceivedAt || now, wExpiresAt, wMonths],
            );
          } catch (e: unknown) {
            console.warn('[db:imei] IMEI table record write skipped:', e);
          }
        }
        await db.execute(
          `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
           VALUES ($1,'imei',$2,'UPSERT',$3,'pending')
           ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
          [imeiKey, pit.imeiNum, JSON.stringify(imeiData), now],
        );
      }
    }

    // 6. Enqueue inventory ledger deltas (services have no physical stock deltas).
    // F0: ids AND keys derived from (sale, index); the ledger INSERT is
    // ON CONFLICT DO NOTHING so a replayed write (crash between COMMIT and
    // intent-clear, lost-commit-ack retry) converges instead of
    // double-decrementing stock locally and in the cloud.
    for (const [idx, d] of input.deltas.entries()) {
      const prodId = String(d.productId || 'unknown');
      if (prodId.startsWith('qt-') || prodId.startsWith('prod-misc-')) continue;
      if (unstockedCategoryIds.has(prodId)) continue;
      const ledgerId = String(d.id || `${txId}-ledger-${idx}`);
      const ledgerKey = String(d.idempotencyKey || `${txId}-ledgerkey-${idx}`);
      await db.execute(
        `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
          idempotency_key, sync_status, created_at, updated_at, deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$9,0)
         ON CONFLICT(id) DO NOTHING`,
        [ledgerId, prodId, Number(d.delta ?? 0), String(d.reason ?? 'SALE'), String(d.refType ?? 'order'), String(d.refId ?? `${txId}-${idx}`), deviceId, ledgerKey, now],
      );
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'ledger',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          ledgerKey, ledgerId,
          JSON.stringify({ id: ledgerId, product_id: prodId, delta: Number(d.delta ?? 0), reason: String(d.reason ?? 'SALE'), ref_type: String(d.refType ?? 'order'), ref_id: String(d.refId ?? `${txId}-${idx}`), device_id: deviceId, idempotency_key: ledgerKey }),
        ],
      );
    }

    // 7. Recompute cached stock AFTER ledger inserts (allow-negative policy).
    // Must run after step 6: the ledger deltas of THIS sale are part of the SUM.
    // Product outbox rows enqueued in step 3 carry the pre-sale snapshot, so
    // refresh them here with the post-sale row (idempotent DO UPDATE).
    const touched = [...new Set(input.deltas.map((d) => String(d.productId || '')).filter(Boolean))]
      .filter((pid) => !pid.startsWith('qt-') && !pid.startsWith('prod-misc-') && !unstockedCategoryIds.has(pid));
    for (const pid of touched) {
      await db.execute(
        `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=$1 AND deleted=0),stock),
          version = version + 1, updated_at=$2, sync_status='pending' WHERE id=$1`,
        [pid, now],
      );
    }
    for (const pid of touchedIds) {
      const rows = (await db.select('SELECT * FROM products WHERE id=$1', [pid]).catch(() => [])) as Array<Record<string, unknown>>;
      const prow = rows?.[0];
      if (!prow) continue;
      const pkey = (prow.idempotency_key as string) || `stub-${pid}`;
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'product',$2,'UPSERT',$3,'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
        [pkey, pid, toBoundedSyncJson(prow), now],
      );
    }

    // 8. Phase P1 Shadow Event Interceptor: Record checkout and sold stock into event_log & p_*
    try {
      const checkoutLines = (input.items ?? []).map((it) => ({
        product_id: String(it.product_id || it.productId || ''),
        qty: Math.abs(Number(it.quantity || 1)),
        unit_cents: Math.round(Number(it.applied_price ?? it.appliedPrice ?? 0) * 100),
      }));

      await recordShadowEvent(
        db,
        {
          type: 'checkout_completed',
          data: {
            transaction_id: txId,
            lines: checkoutLines,
            total_cents: Math.round(Number(input.orderRow.total ?? 0) * 100),
            payment: {
              method: String(input.orderRow.payment_method ?? 'cash'),
              tendered_cents: Math.round(Number(input.orderRow.cash_tendered ?? 0) * 100),
              change_cents: Math.round(Number(input.orderRow.change_due ?? 0) * 100),
            },
          },
        },
        `tx:${txId}`,
        deviceId
      );

      for (const line of checkoutLines) {
        if (line.product_id && line.qty > 0) {
          await recordShadowEvent(
            db,
            {
              type: 'stock_sold',
              data: {
                product_id: line.product_id,
                qty: line.qty,
                transaction_id: txId,
              },
            },
            `product:${line.product_id}`,
            deviceId
          );
        }
      }
    } catch (shadowErr) {
      console.warn('[writeCheckoutAtomic] Shadow event recording non-fatal error:', shadowErr);
    }

        if (useTxn && allocLedgerAvailable) {
      const verify = (await db
        .select(
          `SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS s
           FROM sale_batch_allocations WHERE sale_id = $1 AND deleted = 0`,
          [txId],
        )
        .catch(rethrowBusy)) as Array<{ s: number }>;
      const finalSum = Math.max(0, Math.round(Number(verify?.[0]?.s ?? 0)));
      const expectedSum = Math.max(0, Math.round(preAllocSum + allocLedgerTotal));
      if (finalSum !== expectedSum) {
        throw new Error(
          `LEDGER_COGS_MISMATCH:${txId}: frozen=${finalSum} computed=${expectedSum} — sale NOT committed`,
        );
      }
      if (fifoResolvedAny && fifoLedgerCogsTotal !== null && fifoOrderCostTotal !== null) {
        const expectedLedger = Math.max(0, Math.round(fifoLedgerCogsTotal));
        const expectedCost = Math.max(0, Math.round(fifoOrderCostTotal));
        const rowRows = (await db
          .select('SELECT cost_total, ledger_cogs_total FROM transactions WHERE id = $1', [txId])
          .catch(rethrowBusy)) as Array<{ cost_total: number; ledger_cogs_total: number }>;
        const rowLedger = Math.max(0, Math.round(Number(rowRows?.[0]?.ledger_cogs_total ?? NaN)));
        const rowCost = Math.max(0, Math.round(Number(rowRows?.[0]?.cost_total ?? NaN)));
        if (!rowRows?.[0] || rowLedger !== expectedLedger || rowCost !== expectedCost) {
          throw new Error(
            `LEDGER_COGS_MISMATCH:${txId}: row(cost=${rowRows?.[0]?.cost_total},ledger=${rowRows?.[0]?.ledger_cogs_total}) != computed(cost=${expectedCost},ledger=${expectedLedger}) — sale NOT committed`,
          );
        }
        if (!hasReturnLines) {
          const lineRows = (await db
            .select(
              `SELECT COALESCE(SUM(quantity * unit_cost_at_sale), 0) AS s
               FROM transaction_items WHERE transaction_id = $1`,
              [txId],
            )
            .catch(rethrowBusy)) as Array<{ s: number }>;
          const rawLines = Number(lineRows?.[0]?.s ?? 0);
          const linesSum = Math.max(0, Math.round(rawLines));
          if (linesSum !== expectedCost) {
            throw new Error(
              `LEDGER_COGS_MISMATCH:${txId}: lines=${linesSum} != computed cost=${expectedCost} (lines carry non-frozen costs) — sale NOT committed`,
            );
          }
          const rawRowCost = Number(rowRows?.[0]?.cost_total ?? 0);
          const rawRowLedger = Number(rowRows?.[0]?.ledger_cogs_total ?? 0);
          if (rawRowCost < 0 || rawRowLedger < 0 || rawLines < 0) {
            throw new Error(
              `LEDGER_COGS_MISMATCH:${txId}: negative stored cost on a pure sale (row cost=${rowRows?.[0]?.cost_total}, ledger=${rowRows?.[0]?.ledger_cogs_total}, lines=${lineRows?.[0]?.s}) — sale NOT committed`,
            );
          }
        }
      }
    }

    devBenchMark('checkout:pre-commit');
    if (useTxn) {
      await db.execute('COMMIT;');
    }
    devBenchMark('checkout:post-commit');
  } catch (error) {
    if (useTxn) {
      await db.execute('ROLLBACK;').catch(() => {});
    }
    // BUSY collisions are retried by the outer withBusyRetry (which already
    // logs "[busy-retry:checkout] attempt … retrying"). Logging them here as
    // console.error makes every transient collision look like a lost sale —
    // downgrade to warn so only the FINAL failure (or non-BUSY errors) are red.
    if (isRetryableDbError(error)) {
      console.warn('[writeCheckoutAtomic] retryable DB collision — bubbling to busy-retry:', error);
    } else {
      console.error('[writeCheckoutAtomic] Persistence failed:', error);
    }
    throw error;
  }

  return {
    deviceId,
    fifoCostTotal: fifoOrderCostTotal,
    fifoProfit: fifoOrderProfit,
    ledgerCogsTotal: fifoLedgerCogsTotal,
    fifoItems: fifoItemResolutions,
  };
}

/**
 * IMEI sold-state read (IMEI section — NO schema change, NO new constraint).
 * Application-level second check for serialized items: returns whether the
 * IMEI already carries a sale (sale_transaction_id or sold_at set) in the
 * durable SQLite lane. Best-effort: returns null when the DB is unreachable
 * (plain web preview) so callers fall back to the Dexie/Zustand mirrors.
 */
export async function findSoldImeiStatus(
  imei: string,
): Promise<{ sold: boolean; saleTransactionId?: string } | null> {
  const code = String(imei || '').trim();
  if (!code) return null;
  try {
    const db = await getLocalDb();
    // B-012: never swallow BUSY into sold:false — that would let a second
    // sale of the same IMEI through while the lock is held.
    return await withBusyRetry(
      async () => {
        // Fast path first: exact match on the normalized IMEI uses the
        // index (DB-003). New writes normalize too; a legacy mixed-case
        // row falls to the UPPER() fallback once, then heals in place.
        const imei = normalizeImeiKey(code);
        const fast = (await db.select(
          'SELECT imei, sale_transaction_id, sold_at FROM imei_records WHERE imei = $1 LIMIT 1',
          [imei],
        )) as Array<{ imei?: string; sale_transaction_id?: string | null; sold_at?: string | null }>;
        let row = fast?.[0];
        if (!row) {
          const slow = (await db.select(
            'SELECT imei, sale_transaction_id, sold_at FROM imei_records WHERE UPPER(imei) = UPPER($1) LIMIT 1',
            [code],
          )) as Array<{ imei?: string; sale_transaction_id?: string | null; sold_at?: string | null }>;
          row = slow?.[0];
          if (row?.imei) {
            db.execute('UPDATE imei_records SET imei = $1 WHERE imei = $2', [imei, String(row.imei)]).catch(() => {});
          }
        }
        if (!row) return { sold: false };
        const saleId = row.sale_transaction_id ?? undefined;
        const sold = Boolean(saleId ?? row.sold_at);
        return sold ? { sold: true, saleTransactionId: saleId } : { sold: false };
      },
      { label: 'findSoldImeiStatus' },
    );
  } catch (err) {
    if (isBusyError(err)) throw err;
    // Non-BUSY failure: returning null (unknown) is safer than sold:false.
    console.error('[findSoldImeiStatus] lookup failed:', err);
    return null;
  }
}

/**
 * Synchronizes recomputed product stock from SQLite products table to Dexie products table.
 * Ensures that UI components reading from Dexie immediately reflect stock changes made by remote sales.
 * Upserts missing rows (new peer products) instead of only patching existing ones.
 */
export async function syncProductsFromSqlToDexie(productIds?: Iterable<string>): Promise<number> {
  try {
    const db = await getLocalDb();
    const ids = productIds ? [...new Set([...productIds].filter(Boolean))] : [];
    // B-013: do NOT .catch(() => []) — a failed select must not be treated
    // as "catalog empty" (that path clears Dexie and wipes the UI shelf).
    const rows = (await db.select(
      ids.length > 0
        ? `SELECT * FROM products WHERE deleted=0 AND id IN (${ids.map(() => '?').join(',')})`
        : 'SELECT * FROM products WHERE deleted=0',
      ids.length > 0 ? ids : undefined,
    )) as Array<Record<string, unknown>>;
    const { db: dexieDb } = await import('./database');

    if (!rows || rows.length === 0) {
      // Genuine empty catalog (select succeeded): clear only on full sync.
      if (ids.length === 0) await dexieDb.products.clear();
      return 0;
    }

    const validIds = new Set<string>();
    // Bulk diff (F3): one bulkGet + one bulkPut replaces N×(get + update/put).
    // Same semantics: existing rows get a stock-only patch, missing rows a full put.
    const existingById = new Map<string, Product>();
    if (rows.length > 0) {
      const found = await dexieDb.products
        .bulkGet(rows.map((r) => String(r.id ?? '')))
        .catch(() => [] as Product[]);
      for (const p of found) {
        if (p) existingById.set(p.id, p);
      }
    }
    const toPut: Product[] = [];
    await dexieDb.transaction('rw', dexieDb.products, async () => {
      for (const r of rows) {
        const id = String(r.id ?? '');
        if (!id) continue;
        validIds.add(id);
        const existing = existingById.get(id);
        if (existing) {
          if (existing.stock !== Number(r.stock ?? existing.stock)) {
            existing.stock = Number(r.stock ?? 0);
            toPut.push(existing);
          }
        } else {
          let base: Record<string, unknown> = {};
          try {
            base = JSON.parse(String(r.json_payload ?? '{}')) as Record<string, unknown>;
          } catch {
            // keep base empty; row columns remain authoritative
          }
          toPut.push({
            ...base,
            id,
            sku: String(r.sku ?? base.sku ?? ''),
            barcode: String(r.barcode ?? base.barcode ?? ''),
            title: String(r.title ?? base.title ?? id),
            brand: (r.brand as never) ?? base.brand ?? 'Autre',
            category: (r.category as never) ?? base.category ?? 'Tous les produits',
            price: Number(r.price ?? base.price ?? 0),
            wholesalePrice: Number(r.wholesale_price ?? base.wholesalePrice ?? 0),
            semiWholesalePrice: typeof base.semiWholesalePrice === 'number' ? base.semiWholesalePrice : undefined,
            costPrice: Number(r.cost_price ?? base.costPrice ?? 0),
            stock: Number(r.stock ?? base.stock ?? 0),
            imageUrl: String(r.image_url ?? base.imageUrl ?? ''),
            isSerialized: Boolean(r.is_serialized ?? base.isSerialized),
            imeiNumber: (r.imei_number as string | undefined) ?? (base.imeiNumber as string | undefined),
            vendorName: String(r.vendor_name ?? base.vendorName ?? 'Fournisseur Général'),
            leadTimeDays: Number(r.lead_time_days ?? base.leadTimeDays ?? 7),
            dailySalesVelocity: Number(r.daily_sales_velocity ?? base.dailySalesVelocity ?? 0),
            reorderPoint: Number(r.reorder_point ?? base.reorderPoint ?? 5),
            compatibleModel: String(r.compatible_model ?? base.compatibleModel ?? ''),
          } as never);
        }
      }
      if (toPut.length > 0) {
        await dexieDb.products.bulkPut(toPut);
      }

      // Full reconciliation is only needed during the explicit full-sync path.
      // Pulls with a touched-ID set must stay bounded to the changed products.
      if (ids.length === 0) {
        const allDexie = await dexieDb.products.toArray();
        for (const dp of allDexie) {
          if (!validIds.has(dp.id)) {
            await dexieDb.products.delete(dp.id);
          }
        }
      }
    });
    return rows.length;
  } catch (err) {
    console.warn('[syncProductsFromSqlToDexie] Failed to mirror stock to Dexie:', err);
    return 0;
  }
}

  /**
   * H9: derives a customer's outstanding debt from the DURABLE debt ledger in
   * SQLite and mirrors the reconciled value into Dexie.
   *
   * Why this exists: `Customer.currentDebt` is a cached aggregate that every
   * write path sets independently (checkout, void, repayment). A reordered sync
   * replay could resurrect a settled balance even after the version guard above,
   * because the *customer* row and the *debt ledger* are two separate lanes that
   * converge independently. The ledger is the money trail; the cached field is
   * only a projection of it. Recomputing the projection from the authority — the
   * same pattern as the products.stock recompute above — makes the number
   * self-healing instead of trusting whichever write landed last.
   *
   * Convention: DEBT_ACQUIRED adds to the balance, PAYMENT_SETTLED subtracts.
   * `balanceAfter` on the row is NOT trusted (it is the same cached-projection
   * field from the writing device); the sum is recomputed from `amount` + `type`.
   */
  export async function reconcileCustomerDebtFromLedger(customerIds?: Iterable<string>): Promise<number> {
    try {
      const db = await getLocalDb();
      const ids = customerIds ? [...new Set([...customerIds].filter(Boolean))] : [];
      const rows = (await db.select(
        ids.length > 0
          ? `SELECT customer_id, type, COALESCE(amount, 0) AS amount
             FROM customer_debts
             WHERE deleted = 0 AND customer_id IN (${ids.map(() => '?').join(',')})`
          : 'SELECT customer_id, type, COALESCE(amount, 0) AS amount FROM customer_debts WHERE deleted = 0',
        ids.length > 0 ? ids : undefined,
        )) as Array<{ customer_id: string; type: string; amount: number }>;

      if (!rows || rows.length === 0) return 0;
      const byCustomer = new Map<string, number>();
      for (const r of rows) {
        const delta = r.type === 'PAYMENT_SETTLED' ? -Number(r.amount) : Number(r.amount);
        byCustomer.set(r.customer_id, (byCustomer.get(r.customer_id) ?? 0) + delta);
      }

      const { db: dexieDb } = await import('./database');
      await dexieDb.transaction('rw', dexieDb.customers, async () => {
        for (const [customerId, debt] of byCustomer) {
            // Boundary clamp: the signed sum is kept commutative inside the
            // reducer, but a customer's outstanding debt is never negative — an
            // over-payment must not create a store-credit out of a ledger that
            // has no credit column. Clamp only here, never inside the sum.
            const projected = Math.max(0, debt);
          const existing = await dexieDb.customers.get(customerId).catch(() => undefined);
            if (existing && Number(existing.currentDebt ?? 0) !== projected) {
              await dexieDb.customers.put({ ...existing, currentDebt: projected });
          }
        }
      });
      return byCustomer.size;
    } catch (err) {
      console.warn('[reconcileCustomerDebtFromLedger] Failed to reconcile debt:', err);
      return 0;
    }
  }

export async function getPendingOutbox(limit = 50): Promise<Array<Record<string, unknown>>> {
  const db = await getLocalDb();
  return (await db.select(
    `SELECT * FROM sync_outbox WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at <= $1)
     ORDER BY rowid LIMIT $2`,
    [utcNowIso(), limit],
  )) as Array<Record<string, unknown>>;
}

/**
 * Single pending outbox row for the push-batch dependency closure
 * (SYNC-002): pulls a missing parent into the batch ahead of its child.
 * Served by idx_outbox_entity — one indexed read, never a scan. Returns
 * null when the parent already synced (or never existed).
 */
export async function getOutboxRow(
  entityType: string,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  const db = await getLocalDb();
  const rows = (await db.select(
    `SELECT * FROM sync_outbox WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending' LIMIT 1`,
    [entityType, entityId],
  ).catch(() => [])) as Array<Record<string, unknown>>;
  return rows?.[0] ?? null;
}

export async function markOutbox(
  idempotencyKey: string,
  patch: { status: 'inflight' | 'pending' | 'synced' | 'failed'; retryCount?: number; nextRetryAt?: string | null; error?: string | null },
): Promise<void> {
  // Self-serializing (house rule: lowest-level writer owns the lock).
  // Callers (flusher loops, push path) must NOT wrap this in withWriteLock
  // (not re-entrant = deadlock) — they own retry, this owns the mutex.
  return withWriteLock(async () => {
    const db = await getLocalDb();
    if (patch.status === 'synced') {
      await db.execute('DELETE FROM sync_outbox WHERE idempotency_key=$1', [idempotencyKey]);
      return;
    }
    await db.execute(
      `UPDATE sync_outbox SET status=$1, retry_count=COALESCE($2, retry_count),
        next_retry_at=$3, last_error=$4, updated_at=$5 WHERE idempotency_key=$6`,
      [patch.status, patch.retryCount ?? null, patch.nextRetryAt ?? null, patch.error ?? null, utcNowIso(), idempotencyKey],
    );
  });
}

/**
 * Set-based outbox bookkeeping: one IPC per ~500 rows instead of one per row.
 * Semantics match markOutbox exactly for uniform patches (same status/error for
 * every key): `synced` deletes, otherwise status flips with next_retry_at and
 * last_error reset/overwritten just like the per-row form. Per-row divergent
 * patches (individual retry counts/errors) must keep using markOutbox.
 */
export async function markOutboxMany(
  idempotencyKeys: string[],
  patch: { status: 'inflight' | 'pending' | 'synced'; error?: string | null; retryCount?: number; nextRetryAt?: string | null },
): Promise<void> {
  if (idempotencyKeys.length === 0) return;
  // Self-serializing (house rule — see markOutbox): callers own retry only.
  return withWriteLock(async () => {
    const db = await getLocalDb();
    const now = utcNowIso();
    for (let i = 0; i < idempotencyKeys.length; i += 500) {
      const chunk = idempotencyKeys.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      if (patch.status === 'synced') {
        await db.execute(
          `DELETE FROM sync_outbox WHERE idempotency_key IN (${placeholders})`,
          chunk,
        );
      } else {
        // P2-13: optional retryCount/nextRetryAt thread through so set-based
        // patches can preserve backoff (absent = legacy NULL reset).
        await db.execute(
          `UPDATE sync_outbox SET status=?, retry_count=COALESCE(?, retry_count), next_retry_at=?, last_error=?, updated_at=? WHERE idempotency_key IN (${placeholders})`,
          [patch.status, patch.retryCount ?? null, patch.nextRetryAt ?? null, patch.error ?? null, now, ...chunk],
        );
      }
    }
  });
}

export async function getFailedOutboxCount(): Promise<number> {
  try {
    const db = await getLocalDb();
    const rows = (await db.select("SELECT COUNT(*) as n FROM sync_outbox WHERE status='failed'")) as Array<{ n: number }>;
    return rows?.[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

export async function retryQuarantinedOutbox(forceAll = true): Promise<number> {
  try {
    const db = await getLocalDb();
    const count = await getFailedOutboxCount();
    if (count > 0) {
      if (forceAll) {
        await db.execute(
          `UPDATE sync_outbox SET status='pending',
            retry_count=0,
            last_error=COALESCE(last_error,'') || ' [force-requeued@' || $1 || ']',
            next_retry_at=NULL, updated_at=$1
            WHERE status='failed'`,
          [utcNowIso()],
        );
      } else {
        // F10: preserve strike history when automatic — zeroing retry_count lets a poison row
        // loop quarantine→retry→quarantine burning 10 push cycles each time with no trace.
        await db.execute(
          `UPDATE sync_outbox SET status='pending',
            last_error=COALESCE(last_error,'') || ' [requeued@' || $1 || ']',
            next_retry_at=NULL, updated_at=$1
            WHERE status='failed' AND COALESCE(retry_count,0) < 30`,
          [utcNowIso()],
        );
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/** Quarantine rows for diagnostics/DLQ surfacing (entity, id, error, strikes). */
export interface QuarantinedRow {
  idempotency_key: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  last_error: string | null;
  retry_count: number;
  updated_at: string;
}

export async function getQuarantinedOutbox(limit = 50): Promise<QuarantinedRow[]> {
  try {
    const db = await getLocalDb();
    const rows = (await db.select(
      `SELECT idempotency_key, entity_type, entity_id, operation, last_error, retry_count, updated_at
       FROM sync_outbox WHERE status='failed' ORDER BY updated_at DESC LIMIT $1`,
      [Math.max(1, Math.min(200, limit))],
    ).catch(() => [])) as QuarantinedRow[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * Append compensating ledger deltas (VOID / REFUND / RECEIVE / ADJUST) without
 * creating a new order. Used by void/refund/receive paths. Recomputes cached
 * stock (allow-negative policy) and enqueues outbox rows. Best-effort: throws
 * only if plugin-sql DB is unavailable (e.g. plain web preview) — callers must
 * catch and continue with the legacy Dexie path.
 */
export async function appendInventoryDeltas(
  deltas: LedgerDeltaInput[],
  opts?: { notifySync?: () => void },
): Promise<{ deviceId: string }> {
  // B-011: same-window serializer + BEGIN IMMEDIATE so a kill/BUSY mid-loop
  // cannot leave partial ledger/stock/outbox (C6). BUSY bubbles to callers
  // that wrap with withBusyRetry, or is retried once here for direct callers.
  return withBusyRetry(() => withWriteLock(() => appendInventoryDeltasInner(deltas, opts)), {
    label: 'inventory-deltas',
    onExhausted: (err) => {
      console.error('[appendInventoryDeltas] SQLITE_BUSY exhausted:', err);
    },
  });
}

async function appendInventoryDeltasInner(
  deltas: LedgerDeltaInput[],
  opts?: { notifySync?: () => void },
): Promise<{ deviceId: string }> {
  const db = await getLocalDb();
  const deviceId = (await getOrCreateDeviceId(db)) || 'default';
  const now = utcNowIso();

  let began = false;
  began = await beginImmediate(db, 'appendInventoryDeltas');

  try {
    for (const d of deltas) {
      const ledgerId = String(d.id || newIdempotencyKey());
      const ledgerKey = String(d.idempotencyKey || d.id || newIdempotencyKey());
      const prodId = String(d.productId || 'unknown');
      await db.execute(
        `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
          idempotency_key, sync_status, created_at, updated_at, deleted)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$9,0)
          ON CONFLICT(id) DO NOTHING`,
        [ledgerId, prodId, Number(d.delta ?? 0), String(d.reason ?? 'ADJUST'), d.refType ? String(d.refType) : null, d.refId ? String(d.refId) : null, deviceId, ledgerKey, now],
      );
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'ledger',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          ledgerKey, ledgerId,
          JSON.stringify({ id: ledgerId, product_id: prodId, delta: Number(d.delta ?? 0), reason: String(d.reason ?? 'ADJUST'), ref_type: d.refType ?? null, ref_id: d.refId ?? null, device_id: deviceId, idempotency_key: ledgerKey }),
        ],
      );
    }
    const touched = [...new Set(deltas.map((d) => String(d.productId || '')).filter(Boolean))];
    for (const pid of touched) {
      await db.execute(
        `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=$1 AND deleted=0), stock),
          updated_at=$2, sync_status='pending' WHERE id=$1`,
        [pid, now],
      );
    }
    for (const pid of touched) {
      const rows = (await db.select('SELECT * FROM products WHERE id=$1', [pid]).catch(() => [])) as Array<Record<string, unknown>>;
      const prow = rows?.[0];
      if (!prow) continue;
      const pkey = (prow.idempotency_key as string) || `stub-${pid}`;
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'product',$2,'UPSERT',$3,'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=$4`,
        [pkey, pid, toBoundedSyncJson(prow), now],
      );
    }
    if (began) await db.execute('COMMIT;');
  } catch (err) {
    if (began) await db.execute('ROLLBACK;').catch(() => {});
    console.error('[appendInventoryDeltas] Failed to append deltas:', err);
    throw err;
  }

  // Phase P1 Shadow Event Interceptor (best-effort, outside the money txn):
  try {
    for (const d of deltas) {
      const prodId = String(d.productId || 'unknown');
      const deltaNum = Number(d.delta ?? 0);
      const reasonStr = String(d.reason ?? 'ADJUST');
      if (prodId !== 'unknown' && deltaNum !== 0) {
        if (reasonStr === 'RECEIVE' || reasonStr === 'PURCHASE') {
          await recordShadowEvent(
            db,
            {
              type: 'stock_received',
              data: {
                product_id: prodId,
                qty: deltaNum,
                supplier: d.refType ? String(d.refType) : null,
              },
            },
            `product:${prodId}`,
            deviceId
          );
        } else {
          await recordShadowEvent(
            db,
            {
              type: 'stock_adjusted',
              data: {
                product_id: prodId,
                delta: deltaNum,
                reason: reasonStr,
              },
            },
            `product:${prodId}`,
            deviceId
          );
        }
      }
    }
  } catch (shadowErr) {
    console.warn('[appendInventoryDeltas] Shadow event recording non-fatal error:', shadowErr);
  }

  try {
    opts?.notifySync?.();
  } catch (err: unknown) {
    console.warn('[db:checkout] notifySync callback failed:', err);
  }
  return {
    deviceId,
  };
}

export interface ProductSyncInput {
  id: string; sku?: string; barcode?: string; title: string;
  brand?: string; category?: string; price?: number; wholesalePrice?: number;
  costPrice?: number; stock?: number; imageUrl?: string; isSerialized?: boolean;
  imeiNumber?: string; vendorName?: string; leadTimeDays?: number;
  dailySalesVelocity?: number; reorderPoint?: number;
  raw?: Record<string, unknown>;
}

/**
 * Product create/edit sync (catalog manager path). Keeps the ledger as stock
 * truth: a user-edited stock becomes an ADJUST delta vs the current ledger
 * SUM (or a SEED delta for brand-new products), then the cached row and a
 * product outbox UPSERT follow. Best-effort — callers must catch.
 */
export async function syncProductUpsert(p: ProductSyncInput): Promise<void> {
  const db = await getLocalDb();
  const deviceId = (await getOrCreateDeviceId(db)) || 'default';
  const now = utcNowIso();
  const wantStock = Math.trunc(p.stock ?? 0);
    const pId = String(p.id || newId('prod'));
  const title = String(p.title || p.sku || pId || 'Article');
  const brand = String(p.brand || 'Autre');
  const category = String(p.category || 'Tous les produits');

  try {
    const existing = (await db.select('SELECT idempotency_key, created_at FROM products WHERE id=$1', [pId]).catch(() => [])) as Array<Record<string, unknown>>;
    const prev = existing?.[0];
    const pkey = (prev?.idempotency_key as string) || newIdempotencyKey();
      // H15: read the current version clock so the pushed payload can carry it.
      // The catalog-edit upsert below bumps `version = version + 1`; without
      // stamping the new value into the outbox payload, toRemoteUpsert's
      // `v(version || 1)` would send 1 and the remote guard
      // `WHERE excluded.version >= products.version` would reject the edit
      // whenever the remote row is already at v2+ — silently stuck forever (C6).
      const versionRows = (await db.select('SELECT version FROM products WHERE id=$1', [pId]).catch(() => [])) as Array<{ version: number }>;
      const baseVersion = Number(versionRows?.[0]?.version ?? 0);

    const ledgerStats = (await db.select(
      'SELECT COALESCE(SUM(delta),0) as s, COUNT(*) as n FROM inventory_ledger WHERE product_id=$1 AND deleted=0', [pId],
    ).catch(() => [{ s: 0, n: 0 }])) as Array<{ s: number; n: number }>;
    const currentSum = Number(ledgerStats?.[0]?.s ?? 0);
    const hasLedger = Number(ledgerStats?.[0]?.n ?? 0) > 0;

    await db.execute(
      `INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price,
        cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
        daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key,
        sync_status, created_at, updated_at, deleted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'pending',$21,$22,0)
       ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, barcode=excluded.barcode, title=excluded.title,
         brand=excluded.brand, category=excluded.category, price=excluded.price,
         wholesale_price=excluded.wholesale_price, cost_price=excluded.cost_price,
         image_url=excluded.image_url, is_serialized=excluded.is_serialized,
         imei_number=excluded.imei_number, vendor_name=excluded.vendor_name,
         lead_time_days=excluded.lead_time_days, daily_sales_velocity=excluded.daily_sales_velocity,
         reorder_point=excluded.reorder_point, json_payload=excluded.json_payload,
          updated_at=excluded.updated_at, sync_status='pending', deleted=0,
          version=excluded.version`,
      [
        pId, p.sku ?? '', p.barcode ?? '', title, brand, category,
        Number(p.price ?? 0), Number(p.wholesalePrice ?? 0), Number(p.costPrice ?? 0), wantStock,
        // P0 hygiene: image_url column must stay a reference; the raw object
        // (possibly 20 MB of base64) is bounded before persisting locally.
        sanitizeImageField(p.imageUrl) ?? null, p.isSerialized ? 1 : 0, p.imeiNumber ?? null, p.vendorName ?? null,
        p.leadTimeDays ?? 7, p.dailySalesVelocity ?? 0, p.reorderPoint ?? 5,
        toBoundedSyncJson(p.raw ?? p), deviceId, pkey, (prev?.created_at as string) ?? now, now,
          // H15: advance the version clock on every catalog edit, like the
          // checkout path does (version = version + 1).
          baseVersion + 1,
      ],
    );

    // Stock truth stays in the ledger: record the user's new baseline as a delta.
    const baseline = hasLedger ? currentSum : 0;
    const adjust = wantStock - baseline;
    if (adjust !== 0) {
      const ledgerId = newIdempotencyKey();
      const ledgerKey = newIdempotencyKey();
      await db.execute(
        `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
          idempotency_key, sync_status, created_at, updated_at, deleted)
         VALUES ($1,$2,$3,'ADJUST','manual',$2,$4,$5,'pending',$6,$6,0)`,
        [ledgerId, pId, adjust, deviceId, ledgerKey, now],
      );
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'ledger',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
        [ledgerKey, ledgerId, JSON.stringify({
          id: ledgerId, product_id: pId, delta: adjust, reason: 'ADJUST',
          ref_type: 'manual', ref_id: pId, device_id: deviceId, idempotency_key: ledgerKey,
        })],
      );
      await db.execute(
        `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=$1 AND deleted=0), stock),
          updated_at=$2, sync_status='pending' WHERE id=$1`,
        [pId, now],
      );
    }

    const productPayload = {
      id: pId,
      sku: p.sku ?? '',
      barcode: p.barcode ?? '',
      title,
      brand,
      category,
      price: Number(p.price ?? 0),
      wholesale_price: Number(p.wholesalePrice ?? 0),
      cost_price: Number(p.costPrice ?? 0),
      stock: wantStock,
      image_url: sanitizeImageField(p.imageUrl) ?? null,
      is_serialized: p.isSerialized ? 1 : 0,
      imei_number: p.imeiNumber ?? null,
      vendor_name: p.vendorName ?? null,
      lead_time_days: p.leadTimeDays ?? 7,
      daily_sales_velocity: p.dailySalesVelocity ?? 0,
      reorder_point: p.reorderPoint ?? 5,
      json_payload: toBoundedSyncJson(p.raw ?? p),
      device_id: deviceId,
      idempotency_key: pkey,
      sync_status: 'pending',
       // H15: carry the bumped clock so the remote guard
       // `WHERE excluded.version >= products.version` accepts the edit.
       version: baseVersion + 1,
      created_at: (prev?.created_at as string) ?? now,
      updated_at: now,
      deleted: 0,
    };

    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1,'product',$2,'UPSERT',$3,'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=$4`,
      [pkey, pId, toBoundedSyncJson(productPayload), now],
    );

    // Phase P1 Shadow Event Interceptor: Record product event and stock adjust
    try {
      const priceCents = Math.round(Number(p.price ?? 0) * 100);
      if (!prev) {
        await recordShadowEvent(
          db,
          {
            type: 'product_created',
            data: {
              id: pId,
              name: title,
              price_cents: priceCents,
              sku: p.sku ?? null,
            },
          },
          `product:${pId}`,
          deviceId
        );
      } else {
        const prevTitle = String(prev.title || '');
        const prevPriceCents = Math.round(Number(prev.price ?? 0) * 100);
        if (prevTitle && prevTitle !== title) {
          await recordShadowEvent(
            db,
            {
              type: 'product_renamed',
              data: { id: pId, new_name: title },
            },
            `product:${pId}`,
            deviceId
          );
        }
        if (prevPriceCents !== priceCents) {
          await recordShadowEvent(
            db,
            {
              type: 'price_changed',
              data: { id: pId, old_cents: prevPriceCents, new_cents: priceCents },
            },
            `product:${pId}`,
            deviceId
          );
        }
      }

      if (adjust !== 0) {
        await recordShadowEvent(
          db,
          {
            type: 'stock_adjusted',
            data: {
              product_id: pId,
              delta: adjust,
              reason: 'Ajustement manuel de stock',
            },
          },
          `product:${pId}`,
          deviceId
        );
      }
    } catch (shadowErr) {
      console.warn('[syncProductUpsert] Shadow event recording non-fatal error:', shadowErr);
    }
  } catch (err) {
    console.error('[writeProductAtomic] Failed to write product:', err);
    throw err;
  }
}

/**
 * Bulk product create/edit sync inside chunked transactions.
 * Prevents per-product disk fsync bottlenecks when importing or batch-updating.
 */
export async function syncProductUpsertBulk(products: ProductSyncInput[]): Promise<void> {
  if (!products || products.length === 0) return;
  const db = await getLocalDb();
  const deviceId = (await getOrCreateDeviceId(db)) || 'default';
  const now = utcNowIso();

  const CHUNK_SIZE = 100;
  for (let i = 0; i < products.length; i += CHUNK_SIZE) {
    const chunk = products.slice(i, i + CHUNK_SIZE);
    try {
      for (const p of chunk) {
          const pId = String(p.id || newId('prod'));
        const title = String(p.title || p.sku || pId || 'Article');
        const brand = String(p.brand || 'Autre');
        const category = String(p.category || 'Tous les produits');
        const wantStock = Math.trunc(p.stock ?? 0);
        const existing = (await db.select('SELECT idempotency_key, created_at FROM products WHERE id=$1', [pId]).catch(() => [])) as Array<Record<string, unknown>>;
        const prev = existing?.[0];
        const pkey = (prev?.idempotency_key as string) || newIdempotencyKey();
          // H15: read the clock so the pushed payload can carry the bumped value.
          const versionRows = (await db.select('SELECT version FROM products WHERE id=$1', [pId]).catch(() => [])) as Array<{ version: number }>;
          const baseVersion = Number(versionRows?.[0]?.version ?? 0);

        const sumRows = (await db.select(
          'SELECT COALESCE(SUM(delta),0) as s FROM inventory_ledger WHERE product_id=$1 AND deleted=0', [pId],
        ).catch(() => [{ s: 0 }])) as Array<{ s: number }>;
        const hasLedger = ((await db.select(
          'SELECT COUNT(*) as n FROM inventory_ledger WHERE product_id=$1 AND deleted=0', [pId],
        ).catch(() => [{ n: 0 }])) as Array<{ n: number }>)[0]?.n > 0;
        const currentSum = Number(sumRows?.[0]?.s ?? 0);

        await db.execute(
          `INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price,
            cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
            daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key,
            sync_status, created_at, updated_at, deleted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'pending',$21,$22,0)
           ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, barcode=excluded.barcode, title=excluded.title,
             brand=excluded.brand, category=excluded.category, price=excluded.price,
             wholesale_price=excluded.wholesale_price, cost_price=excluded.cost_price,
             image_url=excluded.image_url, is_serialized=excluded.is_serialized,
             imei_number=excluded.imei_number, vendor_name=excluded.vendor_name,
             lead_time_days=excluded.lead_time_days, daily_sales_velocity=excluded.daily_sales_velocity,
             reorder_point=excluded.reorder_point, json_payload=excluded.json_payload,
            updated_at=excluded.updated_at, sync_status='pending', deleted=0,
            version=excluded.version`,
          [
            pId, p.sku ?? '', p.barcode ?? '', title, brand, category,
            Number(p.price ?? 0), Number(p.wholesalePrice ?? 0), Number(p.costPrice ?? 0), wantStock,
            sanitizeImageField(p.imageUrl) ?? null, p.isSerialized ? 1 : 0, p.imeiNumber ?? null, p.vendorName ?? null,
            p.leadTimeDays ?? 7, p.dailySalesVelocity ?? 0, p.reorderPoint ?? 5,
            toBoundedSyncJson(p.raw ?? p), deviceId, pkey, (prev?.created_at as string) ?? now, now,
            baseVersion + 1,
          ],
        );

        const baseline = hasLedger ? currentSum : 0;
        const adjust = wantStock - baseline;
        if (adjust !== 0) {
          const ledgerId = newIdempotencyKey();
          const ledgerKey = newIdempotencyKey();
          await db.execute(
            `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
              idempotency_key, sync_status, created_at, updated_at, deleted)
             VALUES ($1,$2,$3,'ADJUST','manual',$2,$4,$5,'pending',$6,$6,0)`,
            [ledgerId, pId, adjust, deviceId, ledgerKey, now],
          );
          await db.execute(
            `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES ($1,'ledger',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
            [ledgerKey, ledgerId, JSON.stringify({
              id: ledgerId, product_id: pId, delta: adjust, reason: 'ADJUST',
              ref_type: 'manual', ref_id: pId, device_id: deviceId, idempotency_key: ledgerKey,
            })],
          );
          await db.execute(
            `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=$1 AND deleted=0), stock),
              updated_at=$2, sync_status='pending' WHERE id=$1`,
            [pId, now],
          );
        }

        const rows = (await db.select('SELECT * FROM products WHERE id=$1', [pId]).catch(() => [])) as Array<Record<string, unknown>>;
        if (rows?.[0]) {
          await db.execute(
            `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES ($1,'product',$2,'UPSERT',$3,'pending')
             ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
            [pkey, pId, toBoundedSyncJson(rows[0]), now],
          );
        }
      }
    } catch (err) {
      console.warn('[sqlPluginAdapter] Bulk product sync batch failed:', err);
    }
  }
}

/** Product delete sync: soft-delete locally + tombstone outbox op (full snapshot
 *  payload so the remote can upsert-then-tombstone even if it never saw the row). */
export function syncProductDelete(id: string): Promise<void> {
  return withWriteLock(async () => {
    const db = await getLocalDb();
    const now = utcNowIso();
    const safeId = String(id || '');
    if (!safeId) return;
    const rows = (await db.select('SELECT * FROM products WHERE id=$1', [safeId]).catch(() => [])) as Array<Record<string, unknown>>;
    const pkey = (rows?.[0]?.idempotency_key as string) || `legacy-${safeId}`;
    // H18b: the tombstone must carry a version strictly above the pre-delete row.
    // The pull guard is `WHERE excluded.version >= products.version`; without a
    // bump the local row stays at vN and a stale same-version echo (vN, deleted=0)
    // pulled before the tombstone is pushed satisfies vN >= vN and lands
    // deleted=0 — silently resurrecting the merchant's deleted product and making
    // it buyable again at the till. Bump the clock, like upsertProduct does
    // (H15), and stamp the bumped value into the payload so the remote DELETE
    // guard also sees a strictly-newer tombstone.
    const tombstoneVersion = Number(rows?.[0]?.version ?? 0) + 1;
    const snapshot = { ...(rows?.[0] ?? { id: safeId }), deleted: 1, updated_at: now, version: tombstoneVersion };
    await db.execute(
      `UPDATE products SET deleted=1, version=version+1, updated_at=$1, sync_status='pending' WHERE id=$2`, [now, safeId],
    ).catch((err: unknown) => {
      console.warn('[sync:soft-delete] Failed to update product deleted flag:', err);
    });
    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1,'product',$2,'DELETE',$3,'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET operation='DELETE', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
      [pkey, safeId, toBoundedSyncJson(snapshot), now],
    );

    // Phase P1 Shadow Event Interceptor: Record product deletion
    try {
      const deviceId = (await getOrCreateDeviceId(db)) || 'default';
      await recordShadowEvent(
        db,
        {
          type: 'product_deleted',
          data: { id: safeId },
        },
        `product:${safeId}`,
        deviceId
      );
    } catch (shadowErr) {
      console.warn('[syncProductDelete] Shadow event recording non-fatal error:', shadowErr);
    }
  });
}

/** Generic document-lane entities: full JSON in outbox payload, KV tables remotely. */
export type GenericEntity =
  | 'customer' | 'repair_order' | 'purchase_order' | 'trade_in' | 'imei' | 'audit_log'
  | 'cash_drop' | 'bundle' | 'customer_debt' | 'store_expense'
  | 'cash_session' | 'cash_movement' | 'setting' | 'credit_voucher' | 'stock_batches';

/**
 * H9-generalized: monotonic version clock for a (entity, id) pair.
 *
 * `entity_keys` has exactly one row per (entity_type, entity_id), so this is
 * the natural home for the clock. The bump is atomic against the row: read the
 * current value, add one, write it back. Two concurrent writers on the same
 * entity would both read N and write N+1, which is still monotonic (never goes
 * backwards) — and the outbox dedups on the stable idempotency_key anyway, so
 * the last writer's payload is what ships.
 *
 * Returns 1 for a first-ever write (the row is created by stableEntityKey
 * above with the schema default), so the very first push of any entity is v1
 * and every subsequent push strictly advances.
 */
export async function bumpEntityVersion(
  db: { select: (sql: string, args?: unknown[]) => Promise<unknown>; execute: (sql: string, args?: unknown[]) => Promise<unknown> },
  entity: string, id: string,
): Promise<number> {
  const safeEntity = String(entity || 'unknown');
  const safeId = String(id || 'unknown');
  try {
    // B-063: entity_keys ops used to swallow SQLITE_BUSY (code 5) and fall
    // back to version=1 / skip key registration while checkout held the pool.
    // Retry the whole clock bump instead of degrading the sync guard.
    return await withBusyRetry(
      async () => {
        // Self-heal the column on pre-migration-4 databases (the table itself is
        // created by stableEntityKey; the version column comes from migration 4).
        await db.execute('ALTER TABLE entity_keys ADD COLUMN version INTEGER NOT NULL DEFAULT 1').catch(() => {});
        const rows = (await db.select(
          'SELECT version FROM entity_keys WHERE entity_type=$1 AND entity_id=$2', [safeEntity, safeId],
        )) as Array<{ version: number }>;
        const current = Number(rows?.[0]?.version ?? 1);
        const next = current + 1;
        await db.execute(
          'UPDATE entity_keys SET version=$1 WHERE entity_type=$2 AND entity_id=$3',
          [next, safeEntity, safeId],
        );
        return next;
      },
      { attempts: 5, baseDelayMs: 40, maxDelayMs: 800, label: 'entity-version' },
    );
  } catch (err) {
    // Never block a local write because the clock could not advance: fall back
    // to 1 and let the remote guard do its job. The clock is an optimization
    // over last-write-wins, not a hard requirement.
    console.warn('[sync:entity-version] Clock bump failed after retries:', err);
    return 1;
  }
}

async function stableEntityKey(
  db: { select: (sql: string, args?: unknown[]) => Promise<unknown>; execute: (sql: string, args?: unknown[]) => Promise<unknown> },
  entity: string, id: string,
): Promise<string> {
  const safeEntity = String(entity || 'unknown');
  const safeId = String(id || 'unknown');
  try {
    // B-063: same pool-BUSY class as the version clock — retry registration
    // rather than logging "Key registration skipped" and minting an unstamped key.
    return await withBusyRetry(
      async () => {
        // entity_keys also self-creates here so pre-v4 local DBs work with no rebuild.
        await db.execute(
          `CREATE TABLE IF NOT EXISTS entity_keys (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL, PRIMARY KEY (entity_type, entity_id))`,
        );
        const rows = (await db.select(
          'SELECT idempotency_key FROM entity_keys WHERE entity_type=$1 AND entity_id=$2', [safeEntity, safeId],
        )) as Array<{ idempotency_key: string }>;
        if (rows?.[0]?.idempotency_key) return rows[0].idempotency_key;
        const key = newIdempotencyKey();
        await db.execute(
          'INSERT OR IGNORE INTO entity_keys (entity_type, entity_id, idempotency_key) VALUES ($1,$2,$3)',
          [safeEntity, safeId, key],
        );
        // Confirm the row (INSERT OR IGNORE may have lost a race to a peer key).
        const again = (await db.select(
          'SELECT idempotency_key FROM entity_keys WHERE entity_type=$1 AND entity_id=$2', [safeEntity, safeId],
        )) as Array<{ idempotency_key: string }>;
        return again?.[0]?.idempotency_key || key;
      },
      { attempts: 5, baseDelayMs: 40, maxDelayMs: 800, label: 'entity-keys' },
    );
  } catch (err) {
    console.warn('[sync:entity-keys] Key registration failed after retries:', err);
    // Last resort: mint a local key so the outbox row still has an idempotency_key.
    // The next enqueue re-runs stableEntityKey and will adopt the durable row.
    return newIdempotencyKey();
  }
}

/**
 * F3-coverage: device-local settings that must NEVER leave the device.
 * `sync.*` are cursors/state. Phase 4.5: `manager_pin` + `cashier_users`
 * are credential material (PIN hashes) back in the device-local set —
 * replicating them puts brute-forceable secrets in the cloud KV and onto
 * every peer (see report: single-SHA-256 over 4–6 digits). Printer routing
 * (`printerRouting` inside `mobi_pos_receipt_settings`) names per-device
 * printers — syncing it makes peers clobber each other's printer names.
 * Single predicate + payload stripper shared by push (setSetting),
 * backfill, repair, migration, and the pull merge (which additionally
 * preserves the LOCAL routing on apply).
 */
const DEVICE_LOCAL_SETTING_KEYS: ReadonlySet<string> = new Set([
  'manager_pin',
  'cashier_users',
]);

export function isDeviceLocalSettingKey(key: string): boolean {
  const k = String(key || '');
  return k.startsWith('sync.') || DEVICE_LOCAL_SETTING_KEYS.has(k);
}

/** Receipt-settings key whose routing block is per-device (see above). */
export const RECEIPT_SETTINGS_KEY = 'mobi_pos_receipt_settings';

/**
 * Strip per-device fields from a setting value before it ships to the cloud.
 * Unknown keys pass through untouched.
 */
export function stripDeviceLocalSettingValue<T>(key: string, value: T): T {
  if (
    String(key || '') === RECEIPT_SETTINGS_KEY &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const { printerRouting: _dropped, ...rest } = value as Record<string, unknown>;
    return rest as T;
  }
  return value;
}

/**
 * Enqueue any entity for full cloud sync (disaster-recovery lane). The payload
 * is the complete object as JSON; remote persists it in a per-entity KV table.
 * Never throws fatally — callers still catch, but this is already defensive.
 */
export async function enqueueGenericSync(
  entity: GenericEntity, id: string, entityPayload: Record<string, unknown>,
): Promise<void> {
  // Self-serializing (house rule — see markOutbox): callers own retry only.
  return withWriteLock(async () => {
    const db = await getLocalDb();
    const now = utcNowIso();
    const safeId = String(id || (entityPayload?.id as string) || newId(entity));
    const key = await stableEntityKey(db, entity, safeId);
    // H9-generalized: stamp a monotonic version onto the payload. Before this,
    // `toRemoteUpsert` computed `version = Number(payload.version ?? 1)` and no
    // generic lane ever set `.version`, so the value was the constant 1 on every
    // write and the remote + local `WHERE excluded.version >= X` guards could
    // never reject a stale echo. Bumping the clock here (at the single choke
    // point every generic lane funnels through) fixes all 11 lanes at once.
    const version = await bumpEntityVersion(db, entity, safeId);
    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1,$2,$3,'UPSERT',$4,'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$5`,
      [key, entity, safeId, toBoundedSyncJson({ ...entityPayload, version }), now],
    );
  });
}

/** Tombstone a generic entity (soft-delete converges everywhere). */
export async function enqueueGenericDelete(entity: GenericEntity, id: string): Promise<void> {
  // Self-serializing (house rule — see markOutbox): callers own retry only.
  return withWriteLock(async () => {
    const db = await getLocalDb();
    const now = utcNowIso();
    const safeId = String(id || newId(entity));
    const key = await stableEntityKey(db, entity, safeId);
    // H9-generalized: the tombstone must carry a version higher than the last
    // upsert, otherwise a stale upsert echo could un-delete the row.
    const version = await bumpEntityVersion(db, entity, safeId);
    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1,$2,$3,'DELETE',$4,'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET operation='DELETE', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$5`,
      [key, entity, safeId, JSON.stringify({ id: safeId, deleted: 1, version }), now],
    );
  });
}

/**
 * Enqueue a status-change order UPSERT (VOID / REFUNDED / PARTIALLY_REFUNDED).
 * Reuses the original idempotency_key so the remote ON CONFLICT(key) DO UPDATE
 * path fires with last-write-wins (no PK clash from a fresh key).
 */
export async function enqueueOrderSync(
  orderId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Self-serializing (house rule — see markOutbox): callers own retry only.
  return withWriteLock(async () => {
    const db = await getLocalDb();
    const now = utcNowIso();
    // Status flips commit inside a single-writer transaction with an in-txn
    // re-read: two racing voids serialize on BEGIN IMMEDIATE and the loser sees
    // the winner's VOIDED row and aborts with ALREADY_VOIDED instead of
    // double-restoring stock. beginImmediate recovers stale pooled txns.
    const useTxn = await beginImmediate(db, 'sync:order');
    try {
    // Bump the version clock on every status mutation (void/refund). Without
    // this, a stale same-version echo of the pre-void sale satisfies
    // applyRemoteRow's `excluded.version >= transactions.version` guard and
    // flips VOIDED back to COMPLETED. The bumped version is stamped into the
    // outbox payload so toRemoteUpsert propagates it to the cloud.
    let nextVersion = Number(payload.version ?? 1) || 1;
    if (payload.status) {
      const verRows = (await db
        .select('SELECT version, status FROM transactions WHERE id=$1', [orderId])
        .catch((err: unknown) => {
          // BUSY must retry the whole flip — [] would forge current=0 and
          // reset the version clock to 1 (un-void risk).
          if (isBusyError(err)) throw err;
          console.warn('[sync:order] Version lookup failed:', err);
          return [];
        })) as Array<{ version: number; status?: string }>;
      const current = Number(verRows?.[0]?.version ?? 0);
      const currentStatus = String(verRows?.[0]?.status ?? '');
      if (payload.status === 'VOIDED' && currentStatus === 'VOIDED' && verRows?.[0]) {
        throw new Error('ALREADY_VOIDED');
      }
      nextVersion = current + 1;
      await db.execute(
        'UPDATE transactions SET status=$1, updated_at=$2, version=$3, sync_status=$4 WHERE id=$5',
        [payload.status, now, nextVersion, 'pending', orderId],
      ).catch((err: unknown) => {
        console.warn('[sync:order] Order status update failed:', err);
      });
    }
    const rows = (await db.select('SELECT idempotency_key FROM transactions WHERE id=$1', [orderId]).catch((err: unknown) => {
      // BUSY must retry — a forged `legacy-` key would fork the outbox row
      // and the status flip would never converge.
      if (isBusyError(err)) throw err;
      console.warn('[sync:order] Idempotency key lookup failed:', err);
      return [];
    })) as Array<{ idempotency_key: string }>;
    const key = rows?.[0]?.idempotency_key || `legacy-${orderId}`;
    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1,'order',$2,'UPSERT',$3,'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
      [key, orderId, toBoundedSyncJson({ ...payload, idempotency_key: key, updated_at: now, version: nextVersion }), now],
    );
    if (useTxn) {
      await db.execute('COMMIT;');
    }
  } catch (err) {
    if (useTxn) {
      await db.execute('ROLLBACK;').catch(() => {});
    }
    throw err;
  }
  });
}

export async function getSyncCursor(): Promise<string> {
  const db = await getLocalDb();
  const rows = (await db
    .select("SELECT value_json FROM app_settings WHERE key='sync.last_pull_at'")
    .catch(() => [])) as Array<{ value_json: string }>;
  try {
    if (rows?.[0]) return JSON.parse(rows[0].value_json as string) as string;
  } catch (err: unknown) {
    console.warn('[db:cursor] Failed to parse sync cursor json:', err);
  }
  return '1970-01-01T00:00:00.000Z';
}

export async function setSyncCursor(iso: string): Promise<void> {
  const db = await getLocalDb();
  await db.execute(
    "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES ('sync.last_pull_at', ?, ?)",
    [JSON.stringify(iso), utcNowIso()],
  );
}

/**
 * Restitutes stock batches on refund/return.
 * Restores quantity to original batch(es) if available, or inserts a return batch.
 */
export async function restituteStockBatches(
  allocations: Array<{ batchId?: string; productId: string; quantity: number; unitCost: number }>,
  opts?: { batchKeySeed?: string }
): Promise<void> {
  // F04: same defense stack as checkout/void/refund — same-window
  // withWriteLock + cross-tab BEGIN IMMEDIATE + pool BUSY retry. The SQLite
  // writes run inside restituteStockBatchesInner's transaction; the Dexie
  // mirror stays outside the lock (Dexie I/O must never hold the SQLite
  // writer chain).
  const productIds = await withBusyRetry(
    () => withWriteLock(() => restituteStockBatchesInner(allocations, opts)),
    { attempts: 8, baseDelayMs: 120, label: 'restitute' }
  );
  if (productIds.length > 0) {
    try {
      const db = await getLocalDb();
      await mirrorStockBatchesToDexie(db, productIds);
    } catch (mirrorErr) {
      console.warn('[restituteStockBatches] Dexie batch mirror skipped:', mirrorErr);
    }
  }
}

async function restituteStockBatchesInner(
  allocations: Array<{ batchId?: string; productId: string; quantity: number; unitCost: number }>,
  opts?: { batchKeySeed?: string }
): Promise<string[]> {
  const db = await getLocalDb();
  const deviceId = (await getOrCreateDeviceId(db)) || 'default';
  const now = utcNowIso();
  // Deterministic operation seed (void-<txId> / ref-<refundId>): retries and
  // racing peers derive the SAME outbox keys + fallback batch ids, so the
  // second execution converges via ON CONFLICT instead of double-restoring.
  // Without a seed the legacy wall-clock keys are kept (same as before).
  const seed = String(opts?.batchKeySeed ?? '').trim();
  const useTxn = await beginImmediate(db, 'db:restitute');
  try {

  for (const [allocIdx, alloc] of allocations.entries()) {
    const qty = Math.max(0, alloc.quantity);
    if (qty <= 0) continue;

    // Shadow batches (`shadow-<txId>-<idx>`) are shortage markers with
    // quantity_remaining = 0 — NOT real stock. Restoring refunded qty onto
    // the shadow row would resurrect phantom inventory the shelf never held
    // (the sale consumed nothing real for that portion). Skip the restore so
    // the return falls through to a regular REFUND batch below: the customer
    // physically handed the unit back, so it re-enters stock as new
    // on-hand qty at the original unit cost while the shadow row stays dead.
    let restored = false;
    if (alloc.batchId && alloc.batchId !== 'unbatched' && !alloc.batchId.startsWith('shadow-')) {
      // Tombstoned batches stay dead: restoring onto a deleted row would
      // raise the ledger with no sellable stock (ledger/batches diverge).
      // Missing/deleted rows fall through to the REFUND batch below.
      const existing = (await db
        .select(
          'SELECT batch_id, quantity_remaining, unit_cost, version FROM stock_batches WHERE batch_id = $1 AND (deleted = 0 OR deleted IS NULL)',
          [alloc.batchId]
        )
        .catch(rethrowBusy)) as Array<{ batch_id: string; quantity_remaining: number; unit_cost: number; version: number }>;

      if (existing.length > 0) {
        const baseQty = Number(existing[0].quantity_remaining);
        const baseVersion = Number(existing[0].version ?? 0);
        const newQty = baseQty + qty;
        const upd = await db.execute(
          `UPDATE stock_batches
           SET quantity_remaining = $1,
               version = version + 1,
               updated_at = $2,
               sync_status = 'pending'
           WHERE batch_id = $3 AND version = $4`,
          [newQty, now, alloc.batchId, baseVersion]
        ).catch(rethrowBusy);
        const rowsAffected = Number((upd as { rowsAffected?: number })?.rowsAffected ?? 0);
        let finalQty = newQty;
        let finalUnitCost = Number(existing[0].unit_cost);
        let tombstonedMidOp = false;
        if (rowsAffected === 0) {
          // Lost the OCC race against a concurrent deplete/restitute on the
          // same batch: re-read once and retry on the fresh version. A second
          // miss means sustained contention — throw retryable so the outer
          // withBusyRetry re-runs the whole (idempotent) operation.
          const fresh = (await db
            .select(
              'SELECT batch_id, quantity_remaining, unit_cost, version FROM stock_batches WHERE batch_id = $1 AND (deleted = 0 OR deleted IS NULL)',
              [alloc.batchId]
            )
            .catch(rethrowBusy)) as Array<{ batch_id: string; quantity_remaining: number; unit_cost: number; version: number }>;
          if (fresh.length === 0) {
            // Batch was tombstoned mid-operation: fall through to REFUND mint.
            tombstonedMidOp = true;
          } else {
            const freshQty = Number(fresh[0].quantity_remaining) + qty;
            const freshVersion = Number(fresh[0].version ?? 0);
            const upd2 = await db.execute(
              `UPDATE stock_batches
               SET quantity_remaining = $1,
                   version = version + 1,
                   updated_at = $2,
                   sync_status = 'pending'
               WHERE batch_id = $3 AND version = $4`,
              [freshQty, now, alloc.batchId, freshVersion]
            ).catch(rethrowBusy);
            const rows2 = Number((upd2 as { rowsAffected?: number })?.rowsAffected ?? 0);
            if (rows2 === 0) {
              throw Object.assign(new Error('RESTITUTE_VERSION_CONFLICT'), { code: 5 });
            }
            finalQty = freshQty;
            finalUnitCost = Number(fresh[0].unit_cost);
          }
        }
        if (!tombstonedMidOp) {
          // H27: stamp the bumped version so the remote guard + isGuardedUpsert work
          const restituteVersion0 = ((await db
            .select('SELECT version FROM stock_batches WHERE batch_id = $1', [alloc.batchId])
            .catch(rethrowBusy)) as Array<{ version: number }>)[0]?.version ?? 1;

          const batchOutboxKey = seed ? `sb-${seed}-${alloc.batchId}` : `sb-${alloc.batchId}-${now}`;
          await db.execute(
            `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
             ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
            [
              batchOutboxKey,
              alloc.batchId,
              JSON.stringify({
                version: restituteVersion0,
                batch_id: alloc.batchId,
                product_id: alloc.productId,
                quantity_remaining: finalQty,
                unit_cost: finalUnitCost,
                updated_at: now,
              }),
              now,
            ]
          ).catch(rethrowBusy);
          restored = true;
        }
      }
    }

    if (!restored) {
      // Create a restitution batch for this product at the original unit cost.
      // Seeded id converges retries/races; the alloc index keeps two
      // fallback lines of the same product in one operation distinct.
      // Unseeded keeps the legacy random id.
      // ON CONFLICT DO NOTHING: a retried restitution must not mint twins.
      const newBatchId = seed
        ? `batch-return-${seed}-${String(alloc.productId)}-${Math.max(0, Math.round(alloc.unitCost))}-${allocIdx}`
        : newId('batch-return');
      const idempotencyKey = seed ? `sb-${newBatchId}` : newIdempotencyKey();
      await db.execute(
        `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
          purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
         VALUES ($1, $2, $3, $4, $5, 'REFUND', $6, $7, 'pending', 1, $5, $5, 0)
         ON CONFLICT(batch_id) DO NOTHING`,
        [newBatchId, alloc.productId, qty, alloc.unitCost, now, deviceId, idempotencyKey]
      );

      const batchOutboxKey = seed ? `sb-${newBatchId}` : `sb-${newBatchId}-${now}`;
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
        [
          batchOutboxKey,
          newBatchId,
          JSON.stringify({
          version: 1, // H27: matches the INSERT hardcode
            batch_id: newBatchId,
            product_id: alloc.productId,
            quantity_remaining: qty,
            unit_cost: alloc.unitCost,
            received_at: now,
            purchase_order_id: 'REFUND',
            updated_at: now,
          }),
          now,
        ]
      );
    }
  }

    if (useTxn) {
      await db.execute('COMMIT;').catch(rethrowBusy);
    }
  } catch (txnErr) {
    if (useTxn) {
      await db.execute('ROLLBACK;').catch(() => {});
    }
    throw txnErr;
  }
  // Returned to the outer wrapper which mirrors to Dexie OUTSIDE the write
  // lock (mirror is Dexie I/O, never SQLite-writer-chained).
  return [
    ...new Set(
      allocations
        .map((a) => a?.productId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
}

/**
 * Inserts a new received stock batch (e.g. from purchase order).
 */
export async function insertStockBatch(batch: {
  batchId?: string;
  productId: string;
  quantityRemaining: number;
  unitCost: number;
  receivedAt?: string;
  purchaseOrderId?: string;
  idempotencyKey?: string;
}): Promise<string> {
  const db = await getLocalDb();
  const deviceId = (await getOrCreateDeviceId(db)) || 'default';
  const now = utcNowIso();
  const batchId = batch.batchId || newId('batch');
  const receivedAt = batch.receivedAt || now;
  const idempotencyKey = newIdempotencyKey();

  await db.execute(
    `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
      purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 1, $9, $9, 0)
     ON CONFLICT(batch_id) DO UPDATE SET quantity_remaining=excluded.quantity_remaining,
     version = version + 1,
       unit_cost=excluded.unit_cost, updated_at=excluded.updated_at, sync_status='pending'`,
    [
      batchId,
      batch.productId,
      batch.quantityRemaining,
      batch.unitCost,
      receivedAt,
      batch.purchaseOrderId || null,
      deviceId,
      idempotencyKey,
      now,
    ]
  );

    // H27: the local ON CONFLICT path bumps version; read the real value so the
// outbox payload carries the truth (remote guard + isGuardedUpsert).
    const insertBatchVersion = ((await db
      .select('SELECT version FROM stock_batches WHERE batch_id = $1', [batchId])
      .catch(() => [{ version: 1 }])) as Array<{ version: number }>)[0]?.version ?? 1;
  const payload = {
    version: insertBatchVersion,
    batch_id: batchId,
    product_id: batch.productId,
    quantity_remaining: batch.quantityRemaining,
    unit_cost: batch.unitCost,
    received_at: receivedAt,
    purchase_order_id: batch.purchaseOrderId || null,
    device_id: deviceId,
    idempotency_key: idempotencyKey,
    updated_at: now,
  };

  await db.execute(
    `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
     VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
     ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
    [idempotencyKey, batchId, JSON.stringify(payload), now]
  );

  return batchId;
}

/**
 * Returns active stock batches for a given product, sorted oldest first (FIFO).
 */
export async function getProductStockBatches(productId: string): Promise<Array<{
  batchId: string;
  productId: string;
  quantityRemaining: number;
  unitCost: number;
  receivedAt: string;
  purchaseOrderId?: string;
}>> {
  const db = await getLocalDb();
  const rows = (await db
    .select(
      `SELECT batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id
       FROM stock_batches
       WHERE product_id = $1 AND deleted = 0 AND quantity_remaining > 0
       ORDER BY received_at ASC, rowid ASC`,
      [productId]
    )
    .catch(() => [])) as Array<{
      batch_id: string;
      product_id: string;
      quantity_remaining: number;
      unit_cost: number;
      received_at: string;
      purchase_order_id?: string;
    }>;
  return rows.map((r) => ({
    batchId: r.batch_id,
    productId: r.product_id,
    quantityRemaining: Number(r.quantity_remaining),
    unitCost: Number(r.unit_cost),
    receivedAt: r.received_at,
    purchaseOrderId: r.purchase_order_id,
  }));
}

/**
 * Calculates FIFO inventory valuation: SUM(quantity_remaining * unit_cost).
 */
export async function calculateInventoryValuation(productId?: string): Promise<number> {
  const db = await getLocalDb();
  if (productId) {
    const res = (await db
      .select(
        'SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0) as val FROM stock_batches WHERE product_id = $1 AND deleted = 0 AND quantity_remaining > 0',
        [productId]
      )
      .catch(() => [])) as Array<{ val: number }>;
    return Number(res?.[0]?.val ?? 0);
  } else {
    const res = (await db
      .select(
        'SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0) as val FROM stock_batches WHERE deleted = 0 AND quantity_remaining > 0'
      )
      .catch(() => [])) as Array<{ val: number }>;
    return Number(res?.[0]?.val ?? 0);
  }
}


function rethrowBusy(e: unknown): never {
  if (isBusyError(e) || isRetryableDbError(e)) throw e;
  throw e;
}

export async function linkedTxnIsRefund(saleId: string): Promise<boolean> {
  try {
    const db = await getLocalDb();
    const rows = (await db.select('SELECT json_payload FROM transactions WHERE id = $1', [saleId]).catch(rethrowBusy)) as Array<{ json_payload?: string | null }>;
    if (!rows?.[0]?.json_payload) return false;
    const p = JSON.parse(String(rows[0].json_payload));
    return Boolean(p.isRefund);
  } catch (e) {
    if (isBusyError(e)) throw e;
    return false;
  }
}

async function depleteBatchGuarded(
  db: { select: (sql: string, args?: unknown[]) => Promise<unknown>; execute: (sql: string, args?: unknown[]) => Promise<unknown> },
  batch: { batch_id: unknown; [k: string]: unknown },
  want: number,
  ctx: { prodId: string; deviceId: string; now: string; txId: string }
): Promise<{ taken: number; remaining: number }> {
  const upd = await db.execute(
    `UPDATE stock_batches
     SET quantity_remaining = quantity_remaining - $1,
         version = version + 1,
         updated_at = $2,
         sync_status = 'pending'
     WHERE batch_id = $3 AND quantity_remaining >= $1 AND deleted = 0`,
    [want, ctx.now, batch.batch_id]
  );
  const rowsAffected = Number((upd as { rowsAffected?: number })?.rowsAffected ?? 0);
  if (rowsAffected === 0) return { taken: 0, remaining: NaN };
  const read = (await db.select(
    'SELECT quantity_remaining, version, unit_cost, received_at, purchase_order_id, created_at, device_id FROM stock_batches WHERE batch_id = $1',
    [batch.batch_id]
  ).catch(rethrowBusy)) as Array<{
    quantity_remaining?: number;
    version?: number;
    unit_cost?: number;
    received_at?: string;
    purchase_order_id?: string | null;
    created_at?: string;
    device_id?: string;
  }>;
  const rem = Number(read?.[0]?.quantity_remaining);
  // Canonical name (owner-set 2026-10-02): the bumped version read back from
  // SQLite after the depletion UPDATE. `batchVersion` is the domain term for
  // the version stamped into the stock_batches outbox payload across the
  // SQLite/Dexie boundary — the sibling sites use `restituteVersion*` and
  // `insertBatchVersion` for the same field, so this one matches.
  const batchVersion = Number(read?.[0]?.version ?? 1);
  const unitCost = toFiniteNumber(read?.[0]?.unit_cost ?? batch.unit_cost, 0);
  const receivedAt = read?.[0]?.received_at ?? (batch.received_at as string | undefined) ?? ctx.now;
  const purchaseOrderId = read?.[0]?.purchase_order_id ?? (batch.purchase_order_id as string | undefined) ?? null;
  const createdAt = read?.[0]?.created_at ?? (batch.created_at as string | undefined) ?? receivedAt;
  const outKey = `sb-${batch.batch_id}-${ctx.txId}`;
  const payload = {
    version: batchVersion,
    batch_id: batch.batch_id,
    product_id: ctx.prodId,
    quantity_remaining: rem,
    unit_cost: unitCost,
    received_at: receivedAt,
    purchase_order_id: purchaseOrderId,
    created_at: createdAt,
    device_id: read?.[0]?.device_id ?? ctx.deviceId,
    updated_at: ctx.now,
  };
  await db.execute(
    `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
     VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
     ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
    [outKey, batch.batch_id, JSON.stringify(payload), ctx.now]
  );
  return { taken: want, remaining: rem };
}

function deterministicAllocationId(saleId: string, itemId: string, batchId: string): string {
  const m = String(itemId ?? '').match(/-item-(\d+)$/);
  return m ? `alloc-${saleId}-${m[1]}-${batchId}` : `alloc-${saleId}-${String(itemId)}-${batchId}`;
}

async function dedupeAllocationTwins(
  db: { execute: (sql: string, args?: unknown[]) => Promise<unknown> },
  saleId?: string
): Promise<number> {
  try {
    const keepSubquery = `EXISTS (
      SELECT 1 FROM sale_batch_allocations AS keep
      WHERE keep.sale_id = sale_batch_allocations.sale_id
        AND keep.batch_id = sale_batch_allocations.batch_id
        AND keep.qty_consumed = sale_batch_allocations.qty_consumed
        AND keep.unit_cost_at_sale = sale_batch_allocations.unit_cost_at_sale
        AND keep.id NOT GLOB 'alloc-*-item-*'
        AND keep.deleted = 0
    )`;
    const res = saleId
      ? await db.execute(
          `DELETE FROM sale_batch_allocations
           WHERE id GLOB 'alloc-*-item-*' AND sale_id = $1 AND deleted = 0 AND ${keepSubquery}`,
          [String(saleId)]
        )
      : await db.execute(
          `DELETE FROM sale_batch_allocations
           WHERE id GLOB 'alloc-*-item-*' AND deleted = 0 AND ${keepSubquery}`
        );
    const count = Number((res as { rowsAffected?: number })?.rowsAffected ?? 0);
    return Number.isFinite(count) ? Math.max(0, count) : 0;
  } catch {
    return 0;
  }
}

export async function getAllocationCogsForSale(
  saleId: string
): Promise<{ cogs: number; rowCount: number } | null> {
  try {
    const id = String(saleId ?? '');
    if (!id) return null;
    const db = await getLocalDb();
    const rows = (await db.select(
      `SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS cogs,
              COUNT(*) AS n
       FROM sale_batch_allocations
       WHERE (sale_id = $1 OR sale_id IN (SELECT id FROM transactions WHERE receipt_number = $1)) AND deleted = 0`,
      [id]
    )) as Array<{ cogs: number; n: number }>;
    const n = Math.max(0, Math.floor(Number(rows?.[0]?.n ?? 0)));
    if (!(n > 0)) return null;
    const cogs = Math.round(Number(rows?.[0]?.cogs ?? 0));
    return { cogs: Number.isFinite(cogs) ? Math.max(0, cogs) : 0, rowCount: n };
  } catch {
    return null;
  }
}

export async function getAllocationCogsMap(
  saleIds?: string[]
): Promise<Record<string, number>> {
  try {
    const db = await getLocalDb();
    const onlyIds = [...new Set((saleIds ?? []).map((s) => String(s ?? '')).filter(Boolean))];
    const sql = `
      SELECT sale_id, COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS cogs
      FROM sale_batch_allocations
      WHERE deleted = 0
      ${onlyIds.length > 0 ? `AND sale_id IN (${onlyIds.map(() => '?').join(',')})` : ''}
      GROUP BY sale_id
    `;
    const rows = (await db.select(sql, onlyIds.length > 0 ? onlyIds : undefined).catch(() => [])) as Array<{ sale_id: string; cogs: number }>;
    const result: Record<string, number> = {};
    for (const r of rows ?? []) {
      if (r?.sale_id) {
        result[String(r.sale_id)] = Math.round(Number(r.cogs ?? 0));
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function backfillSaleAllocationsFromItems(): Promise<number> {
  try {
    const db = await getLocalDb();
    return await backfillSaleAllocationsFromItemsWithDb(db);
  } catch {
    return 0;
  }
}

export async function backfillSaleAllocationsFromItemsWithDb(
  db: Database,
  opts?: { onlyTransactionIds?: string[] }
): Promise<number> {
  try {
    try {
      await db.select('SELECT sale_id FROM sale_batch_allocations LIMIT 0;');
    } catch {
      return 0;
    }
    const onlyIds = [...new Set((opts?.onlyTransactionIds ?? []).map((s) => String(s ?? '')).filter(Boolean))];
    if (onlyIds.length > 0) {
      for (const sid of onlyIds) {
        await dedupeAllocationTwins(db, sid).catch(() => 0);
      }
    } else {
      await dedupeAllocationTwins(db).catch(() => 0);
    }
    const items = (await db.select(
      onlyIds.length > 0
        ? `SELECT id, transaction_id, product_id, json_payload
           FROM transaction_items WHERE deleted = 0 AND transaction_id IN (${onlyIds.map(() => '?').join(',')})`
        : `SELECT id, transaction_id, product_id, json_payload
           FROM transaction_items WHERE deleted = 0`,
      onlyIds.length > 0 ? onlyIds : undefined
    )) as Array<{ id: string; transaction_id: string; product_id: string; json_payload?: string | null }>;
    let inserted = 0;
    const deviceId = (await getOrCreateDeviceId(db).catch(() => 'default')) || 'default';
    const now = utcNowIso();
    for (const it of items ?? []) {
      let allocs: Array<{ batchId?: string; quantity?: number; unitCost?: number }> = [];
      try {
        const parsed = JSON.parse(String(it.json_payload ?? '{}')) as {
          fifo_allocations?: Array<{ batchId?: string; quantity?: number; unitCost?: number }>;
        };
        allocs = Array.isArray(parsed.fifo_allocations) ? parsed.fifo_allocations : [];
      } catch {
        allocs = [];
      }
      for (const a of allocs) {
        const bId = a?.batchId ? String(a.batchId) : '';
        const qty = Math.max(0, Math.floor(Number(a?.quantity ?? 0)));
        if (!bId || !(qty > 0)) continue;
        const unitCost = Math.max(0, Math.round(Number(a?.unitCost ?? 0)));
        const allocId = deterministicAllocationId(String(it.transaction_id), String(it.id), bId);
        try {
          await db.execute(
            `INSERT INTO sale_batch_allocations
               (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
                created_at, product_id, sale_item_id,
                device_id, idempotency_key, sync_status, version, updated_at, deleted)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',1,$6,0)
             ON CONFLICT(id) DO NOTHING`,
            [allocId, String(it.transaction_id), bId, qty, unitCost, now, String(it.product_id ?? ''), String(it.id), deviceId, allocId]
          );
          inserted++;
        } catch (err) {
          if (isBusyError(err)) return inserted;
          continue;
        }
      }
    }
    return inserted;
  } catch {
    return 0;
  }
}

export async function backfillSaleAllocationsForSale(saleId: string): Promise<number> {
  try {
    const id = String(saleId ?? '');
    if (!id) return 0;
    const db = await getLocalDb();
    try {
      await db.select('SELECT sale_id FROM sale_batch_allocations LIMIT 0;');
    } catch {
      return 0;
    }
    const txnRows = (await db.select(
      `SELECT id FROM transactions WHERE id = $1 OR receipt_number = $1 LIMIT 1`,
      [id]
    )) as Array<{ id: string }>;
    const resolvedSaleId = txnRows?.[0]?.id || id;
    const items = (await db.select(
      `SELECT id, transaction_id, product_id, json_payload
       FROM transaction_items WHERE transaction_id = $1 AND deleted = 0`,
      [resolvedSaleId]
    )) as Array<{ id: string; transaction_id: string; product_id: string; json_payload?: string | null }>;
    if (!items || items.length === 0) return 0;
    await dedupeAllocationTwins(db, resolvedSaleId).catch(() => 0);
    let inserted = 0;
    const deviceId = (await getOrCreateDeviceId(db).catch(() => 'default')) || 'default';
    const now = utcNowIso();
    for (const it of items) {
      let allocs: Array<{ batchId?: string; quantity?: number; unitCost?: number }> = [];
      try {
        const parsed = JSON.parse(String(it.json_payload ?? '{}')) as {
          fifo_allocations?: Array<{ batchId?: string; quantity?: number; unitCost?: number }>;
        };
        allocs = Array.isArray(parsed.fifo_allocations) ? parsed.fifo_allocations : [];
      } catch {
        allocs = [];
      }
      for (const a of allocs) {
        const bId = a?.batchId ? String(a.batchId) : '';
        const qty = Math.max(0, Math.floor(Number(a?.quantity ?? 0)));
        if (!bId || !(qty > 0)) continue;
        const unitCost = Math.max(0, Math.round(Number(a?.unitCost ?? 0)));
        const allocId = deterministicAllocationId(String(it.transaction_id), String(it.id), bId);
        try {
          await db.execute(
            `INSERT INTO sale_batch_allocations
               (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
                created_at, product_id, sale_item_id,
                device_id, idempotency_key, sync_status, version, updated_at, deleted)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',1,$6,0)
             ON CONFLICT(id) DO NOTHING`,
            [allocId, String(it.transaction_id), bId, qty, unitCost, now, String(it.product_id ?? ''), String(it.id), deviceId, allocId]
          );
          inserted++;
        } catch (err) {
          if (isBusyError(err)) return inserted;
          continue;
        }
      }
    }
    return inserted;
  } catch {
    return 0;
  }
}

export async function repairSaleCogsFromLedger(saleId: string): Promise<{
  repaired: boolean;
  reason: string;
  before: { costTotal: number; profit: number; ledger: number | null } | null;
  after: { costTotal: number; profit: number; ledger: number } | null;
}> {
  const id = String(saleId ?? '');
  if (!id) return { repaired: false, reason: 'empty-id', before: null, after: null };
  let db: Database;
  try {
    db = await getLocalDb();
  } catch {
    return { repaired: false, reason: 'unreachable', before: null, after: null };
  }
  try {
    await db.select('SELECT ledger_cogs_total FROM transactions LIMIT 0;');
  } catch {
    return { repaired: false, reason: 'no-ledger-column', before: null, after: null };
  }
  let useTxn = false;
  try {
    useTxn = await beginImmediate(db, 'repair:ledger-cogs');
  } catch (e) {
    if (isBusyError(e)) return { repaired: false, reason: 'busy', before: null, after: null };
    throw e;
  }
  try {
    const orderRows = (await db.select(
      `SELECT id, total, cost_total, profit, status, deleted, json_payload, idempotency_key, version,
              ledger_cogs_total
       FROM transactions WHERE id = $1 OR receipt_number = $1 LIMIT 1`,
      [id]
    ).catch(rethrowBusy)) as Array<Record<string, unknown>>;
    const order = orderRows?.[0];
    if (!order) {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      return { repaired: false, reason: 'sale-not-found', before: null, after: null };
    }
    const realSaleId = String(order.id ?? id);
    if (Number(order.deleted ?? 0) !== 0) {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      return { repaired: false, reason: 'sale-deleted', before: null, after: null };
    }
    if (String(order.status ?? '') === 'VOIDED') {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      return { repaired: false, reason: 'sale-voided', before: null, after: null };
    }
    await getOrCreateDeviceId(db).catch(() => 'default');
    const now = utcNowIso();
    await dedupeAllocationTwins(db, id).catch(() => 0);
    await dedupeAllocationTwins(db, realSaleId).catch(() => 0);
    const sumRows = (await db.select(
      `SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS s, COUNT(*) AS n
       FROM sale_batch_allocations WHERE sale_id = $1 AND deleted = 0`,
      [realSaleId]
    ).catch(rethrowBusy)) as Array<{ s: number; n: number }>;
    const ledgerSum = Math.max(0, Math.round(Number(sumRows?.[0]?.s ?? 0)));
    const rowCount = Number(sumRows?.[0]?.n ?? 0);
    if (!(rowCount > 0)) {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      return {
        repaired: false,
        reason: 'no-ledger-rows',
        before: { costTotal: toIntMoney(order.cost_total ?? 0), profit: toIntMoney(order.profit ?? 0), ledger: null },
        after: null,
      };
    }
    const before = {
      costTotal: toIntMoney(order.cost_total ?? 0),
      profit: toIntMoney(order.profit ?? 0),
      ledger: order.ledger_cogs_total === null || order.ledger_cogs_total === undefined ? null : toIntMoney(order.ledger_cogs_total),
    };
    const orderTotal = toIntMoney(order.total ?? 0);
    if (before.ledger === ledgerSum && before.costTotal === ledgerSum) {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      return { repaired: false, reason: 'already-exact', before, after: null };
    }
    const lineRows = (await db.select(
      `SELECT id, product_id, quantity, applied_price, unit_price_charged,
              unit_cost_at_sale, discount_amount, line_profit, json_payload,
              idempotency_key, version
       FROM transaction_items WHERE transaction_id = $1 AND deleted = 0
       ORDER BY id`,
      [realSaleId]
    ).catch(rethrowBusy)) as Array<Record<string, unknown>>;
    const totalAbsQty = (lineRows ?? []).reduce(
      (acc, it) => acc + Math.abs(Math.round(Number(it.quantity ?? 0))),
      0
    );
    const avgCostPerUnit = totalAbsQty > 0 ? ledgerSum / totalAbsQty : 0;
    let newCostTotal = 0;
    const linePatches = new Map<string, { unit: number; profit: number }>();
    for (const line of lineRows ?? []) {
      const lineId = String(line.id ?? '');
      const qty = Math.round(Number(line.quantity ?? 0));
      const charged = toIntMoney(line.unit_price_charged ?? line.applied_price ?? 0);
      let lineAllocUnit: number | null = null;
      try {
        const parsed = JSON.parse(String(line.json_payload ?? '{}')) as {
          fifo_allocations?: Array<{ quantity?: number; unitCost?: number }>;
        };
        const arr = Array.isArray(parsed.fifo_allocations) ? parsed.fifo_allocations : [];
        const aQty = arr.reduce((acc, a) => acc + Math.max(0, Math.floor(Number(a?.quantity ?? 0))), 0);
        const aCost = arr.reduce(
          (acc, a) => acc + Math.max(0, Math.floor(Number(a?.quantity ?? 0))) * Math.max(0, Number(a?.unitCost ?? 0)),
          0
        );
        if (aQty > 0) lineAllocUnit = toIntMoney(aCost / aQty);
      } catch {}
      if (lineAllocUnit === null) lineAllocUnit = toIntMoney(avgCostPerUnit);
      const lineProfit = toIntMoney((charged - lineAllocUnit) * qty);
      newCostTotal += lineAllocUnit * qty;
      linePatches.set(lineId, { unit: lineAllocUnit, profit: lineProfit });
      let patchedLineJson = String(line.json_payload ?? '{}');
      try {
        const parsed = JSON.parse(patchedLineJson);
        parsed.unit_cost_at_sale = lineAllocUnit;
        parsed.unitCostAtSale = lineAllocUnit;
        parsed.unitCostPrice = lineAllocUnit;
        parsed.line_profit = lineProfit;
        parsed.lineProfit = lineProfit;
        patchedLineJson = toBoundedSyncJson(parsed);
      } catch {}
      const lineVersion = (Number(line.version) || 1) + 1;
      await db.execute(
        `UPDATE transaction_items
         SET unit_cost_at_sale = $1, line_profit = $2, json_payload = $3,
             version = $4, updated_at = $5, sync_status = 'pending'
         WHERE id = $6`,
        [lineAllocUnit, lineProfit, patchedLineJson, lineVersion, now, lineId]
      );
      const lineKey = String(line.idempotency_key ?? `repair-${lineId}`);
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1, 'order_item', $2, 'UPSERT', $3, 'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
        [lineKey, lineId, patchedLineJson, now]
      );
    }
    newCostTotal = toIntMoney(newCostTotal);
    const newProfit = orderTotal - newCostTotal;
    const newMargin = orderTotal > 0 && Number.isFinite(newProfit / orderTotal)
      ? Number(((newProfit / orderTotal) * 100).toFixed(1))
      : 0;
    const orderVersion = (Number(order.version) || 1) + 1;
    let patchedReceipt = String(order.json_payload ?? '{}');
    try {
      const parsed = JSON.parse(patchedReceipt);
      parsed.costTotal = newCostTotal;
      parsed.cost_total = newCostTotal;
      parsed.profit = newProfit;
      parsed.profitMargin = newMargin;
      parsed.profit_margin = newMargin;
      parsed.ledgerCogsTotal = ledgerSum;
      parsed.ledger_cogs_total = ledgerSum;
      const itemsArr = parsed.items;
      if (Array.isArray(itemsArr)) {
        for (const [lineId, patch] of linePatches) {
          const m = String(lineId).match(/-item-(\d+)$/);
          const rawItem = m ? itemsArr[Number(m[1])] : undefined;
          if (rawItem && typeof rawItem === 'object') {
            rawItem.unitCostAtSale = patch.unit;
            rawItem.unitCostPrice = patch.unit;
            rawItem.unit_cost_at_sale = patch.unit;
            rawItem.lineProfit = patch.profit;
            rawItem.line_profit = patch.profit;
          }
        }
      }
      patchedReceipt = toBoundedSyncJson({ ...parsed, version: orderVersion });
    } catch {}
    await db.execute(
      `UPDATE transactions
       SET cost_total = $1, profit = $2, profit_margin = $3, ledger_cogs_total = $4,
           json_payload = $5, version = $6, updated_at = $7, sync_status = 'pending'
       WHERE id = $8`,
      [newCostTotal, newProfit, newMargin, ledgerSum, patchedReceipt, orderVersion, now, realSaleId]
    );
    const orderKey = String(order.idempotency_key ?? `order-${realSaleId}`);
    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1, 'order', $2, 'UPSERT', $3, 'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
      [orderKey, realSaleId, patchedReceipt, now]
    );
    if (useTxn) await db.execute('COMMIT;');
    const after = { costTotal: newCostTotal, profit: newProfit, ledger: ledgerSum };
    try {
      const { reconstructDexieTransactionsFromSql } = await import('./backfill');
      await reconstructDexieTransactionsFromSql(db, { onlyTransactionIds: [realSaleId] });
    } catch (dexErr) {
      console.warn('[repair:ledger] Dexie mirror refresh skipped:', dexErr);
    }
    try {
      await mirrorSaleAllocationsToDexie(db, [realSaleId]);
    } catch (mirrorErr) {
      console.warn('[repair:ledger] Allocation Dexie mirror skipped:', mirrorErr);
    }
    try {
      const { syncManager } = await import('../sync/SyncManager');
      syncManager.notifyLocalWrite();
    } catch {}
    return { repaired: true, reason: 'repaired', before, after };
  } catch (e) {
    if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
    if (isBusyError(e) || isRetryableDbError(e)) {
      return { repaired: false, reason: 'busy', before: null, after: null };
    }
    throw e;
  }
}

export async function mirrorSaleAllocationsToDexie(db: Database, saleIds?: string[]): Promise<number> {
  try {
    const onlyIds = [...new Set((saleIds ?? []).map((s) => String(s ?? '')).filter(Boolean))];
    const rows = (await db.select(
      `SELECT id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
              created_at, product_id, sale_item_id, device_id,
              idempotency_key, sync_status, version, updated_at, deleted
       FROM sale_batch_allocations
       ${onlyIds.length > 0 ? `WHERE sale_id IN (${onlyIds.map(() => '?').join(',')})` : 'WHERE 1 = 1'}`,
      onlyIds.length > 0 ? onlyIds : undefined
    ).catch(rethrowBusy)) as Array<Record<string, unknown>>;
    const { dexieDb } = await import('./database');
    if (onlyIds.length > 0) {
      await dexieDb.saleBatchAllocations.where('saleId').anyOf(onlyIds).delete().catch(() => {});
    } else {
      await dexieDb.saleBatchAllocations.clear().catch(() => {});
    }
    if (!rows || rows.length === 0) return 0;
    await dexieDb.saleBatchAllocations.bulkPut(
      rows.map((r) => ({
        id: String(r.id),
        saleId: String(r.sale_id),
        batchId: String(r.batch_id),
        qtyConsumed: Math.max(0, Math.floor(Number(r.qty_consumed ?? 0))),
        unitCostAtSale: Math.max(0, Number(r.unit_cost_at_sale ?? 0)),
        createdAt: String(r.created_at ?? ''),
        productId: r.product_id ? String(r.product_id) : undefined,
        saleItemId: r.sale_item_id ? String(r.sale_item_id) : undefined,
        deviceId: r.device_id ? String(r.device_id) : undefined,
        idempotencyKey: r.idempotency_key ? String(r.idempotency_key) : undefined,
        syncStatus: r.sync_status ? (String(r.sync_status) as 'pending' | 'synced') : undefined,
        version: Number(r.version ?? 1),
        updatedAt: r.updated_at ? String(r.updated_at) : undefined,
        deleted: Number(r.deleted ?? 0),
      }))
    );
    return rows.length;
  } catch (err) {
    console.warn('[alloc:mirror] Dexie allocation mirror skipped:', err);
    return 0;
  }
}

export async function mirrorStockBatchesToDexie(db: Database, productIds?: string[]): Promise<number> {
  try {
    const onlyIds = [...new Set((productIds ?? []).map((s) => String(s ?? '')).filter(Boolean))];
    const rows = (await db.select(
      `SELECT batch_id, product_id, quantity_remaining, unit_cost, received_at,
              purchase_order_id, deleted, updated_at
       FROM stock_batches
       ${onlyIds.length > 0 ? `WHERE product_id IN (${onlyIds.map(() => '?').join(',')})` : 'WHERE 1 = 1'}
         AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')`,
      onlyIds.length > 0 ? onlyIds : undefined
    ).catch(rethrowBusy)) as Array<Record<string, unknown>>;
    if (!rows || rows.length === 0) return 0;
    const { dexieDb } = await import('./database');
    await dexieDb.stockBatches.bulkPut(
      rows.map((r) => {
        const item: Record<string, unknown> = {
          batchId: String(r.batch_id),
          productId: String(r.product_id),
          quantityRemaining: Math.max(0, Number(r.quantity_remaining ?? 0)),
          unitCost: Math.max(0, Number(r.unit_cost ?? 0)),
          receivedAt: String(r.received_at ?? ''),
          deleted: Number(r.deleted ?? 0),
        };
        if (r.purchase_order_id) item.purchaseOrderId = String(r.purchase_order_id);
        if (r.updated_at) item.updatedAt = String(r.updated_at);
        return item as any;
      })
    );
    return rows.length;
  } catch (err) {
    console.warn('[batches:mirror] Dexie batch mirror skipped:', err);
    return 0;
  }
}

export async function getInventoryValuationTotals(): Promise<{
  units: number;
  costValue: number;
  retailValue: number;
}> {
  const db = await getLocalDb();
  const rows = (await db.select(
    `SELECT COALESCE(SUM(sb.quantity_remaining), 0) AS units,
            COALESCE(SUM(sb.quantity_remaining * sb.unit_cost), 0) AS cost,
            COALESCE(SUM(sb.quantity_remaining * COALESCE(p.price, 0)), 0) AS retail
     FROM stock_batches sb LEFT JOIN products p ON p.id = sb.product_id
     WHERE sb.deleted = 0 AND sb.quantity_remaining > 0
       AND (sb.purchase_order_id IS NULL OR sb.purchase_order_id != 'SHADOW')`
  )) as Array<{ units?: number; cost?: number; retail?: number }>;
  const r = rows?.[0];
  const toInt = (val: unknown) => {
    const n = Math.round(Number(val) || 0);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    units: toInt(r?.units),
    costValue: toInt(r?.cost),
    retailValue: toInt(r?.retail),
  };
}

export const SALE_ALLOC_PROFIT_PER_SALE_SQL = `SELECT
    t.id AS sale_id,
    t.total AS total_revenue,
    COALESCE(
      (SELECT SUM(a.qty_consumed * a.unit_cost_at_sale)
       FROM sale_batch_allocations a
       WHERE a.sale_id = t.id AND a.deleted = 0),
      t.cost_total, 0
    ) AS total_cogs,
    (t.total - COALESCE(
      (SELECT SUM(a.qty_consumed * a.unit_cost_at_sale)
       FROM sale_batch_allocations a
       WHERE a.sale_id = t.id AND a.deleted = 0),
      t.cost_total, 0
    )) AS net_profit
FROM transactions t
WHERE t.deleted = 0 AND COALESCE(t.status, 'COMPLETED') != 'VOIDED'
GROUP BY t.id`;

export async function getSaleAllocationProfitRows(opts?: {
  saleIds?: string[];
}): Promise<Array<{ saleId: string; totalRevenue: number; totalCogs: number; netProfit: number }>> {
  const db = await getLocalDb();
  const onlyIds = [...new Set((opts?.saleIds ?? []).map((s) => String(s ?? '')).filter(Boolean))];
  const sql = `
SELECT
    t.id AS sale_id,
    t.total AS total_revenue,
    COALESCE(
      (SELECT SUM(a.qty_consumed * a.unit_cost_at_sale)
       FROM sale_batch_allocations a
       WHERE a.sale_id = t.id AND a.deleted = 0),
      t.cost_total, 0
    ) AS total_cogs,
    (t.total - COALESCE(
      (SELECT SUM(a.qty_consumed * a.unit_cost_at_sale)
       FROM sale_batch_allocations a
       WHERE a.sale_id = t.id AND a.deleted = 0),
      t.cost_total, 0
    )) AS net_profit
FROM transactions t
WHERE t.deleted = 0 AND COALESCE(t.status, 'COMPLETED') != 'VOIDED'
${onlyIds.length > 0 ? `AND t.id IN (${onlyIds.map(() => '?').join(',')})` : ''}
GROUP BY t.id
`.trim();
  const rows = (await db.select(sql, onlyIds.length > 0 ? onlyIds : undefined)) as Array<{
    sale_id?: unknown;
    total_revenue?: unknown;
    total_cogs?: unknown;
    net_profit?: unknown;
  }>;
  const toInt = (val: unknown) => {
    const n = Math.round(Number(val) || 0);
    return Number.isFinite(n) ? n : 0;
  };
  return (rows ?? []).map((r) => ({
    saleId: String(r.sale_id),
    totalRevenue: toInt(r.total_revenue),
    totalCogs: toInt(r.total_cogs),
    netProfit: toInt(r.net_profit),
  }));
}

export async function getSalesProfitTotalsFromAllocations(opts?: {
  saleIds?: string[];
}): Promise<{ totalRevenue: number; totalCogs: number; netProfit: number; saleCount: number }> {
  const rows = await getSaleAllocationProfitRows(opts);
  return rows.reduce(
    (acc, r) => ({
      totalRevenue: acc.totalRevenue + r.totalRevenue,
      totalCogs: acc.totalCogs + r.totalCogs,
      netProfit: acc.netProfit + r.netProfit,
      saleCount: acc.saleCount + 1,
    }),
    { totalRevenue: 0, totalCogs: 0, netProfit: 0, saleCount: 0 }
  );
}

const reconciledSaleIds: string[] = [];
const MAX_DRAIN_RECONCILED = 500;

export function drainReconciledSaleIds(): string[] {
  if (reconciledSaleIds.length === 0) return [];
  const snapshot = [...new Set(reconciledSaleIds)];
  reconciledSaleIds.length = 0;
  return snapshot;
}

export async function findNegativeStockProducts(): Promise<Array<{ productId: string; stock: number }>> {
  try {
    const db = await getLocalDb();
    const rows = ((await db
      .select(
        `SELECT product_id, COALESCE(SUM(delta), 0) AS s FROM inventory_ledger
         WHERE deleted = 0 GROUP BY product_id HAVING s < 0`
      )
      .catch(() => [])) ?? []) as Array<{ product_id?: string; s?: number }>;
    return rows
      .map((r) => ({
        productId: String(r.product_id ?? ''),
        stock: Math.trunc(Number(r.s ?? 0)),
      }))
      .filter((r) => r.productId && r.stock < 0);
  } catch {
    return [];
  }
}

export async function reconcileShadowBatches(targetProductId?: string): Promise<number> {
  return withWriteLock(async () => {
    const db = await getLocalDb();
    const deviceId = (await getOrCreateDeviceId(db)) || 'default';
    const now = utcNowIso();
    const useTxn = await beginImmediate(db, 'fifo:reconcile');
    let reconciledCount = 0;
    const touchedSaleIds: string[] = [];
    const touchedProductIds = new Set<string>();
    try {
      const shadows = (await db
        .select(
          `SELECT batch_id, product_id, unit_cost, idempotency_key
           FROM stock_batches
           WHERE purchase_order_id = 'SHADOW' AND deleted = 0 AND shadow_resolved = 0
           ${targetProductId ? 'AND product_id = $1' : ''}
           ORDER BY received_at ASC, batch_id ASC`,
          targetProductId ? [targetProductId] : undefined
        )
        .catch(rethrowBusy)) as Array<{ batch_id: string; product_id: string; unit_cost: number; idempotency_key: string }>;

      const loadShadowContext = async (
        bId: string
      ): Promise<{ saleId: string; itemId: string; qty: number } | null> => {        try {
          const rows = (await db
            .select(
              'SELECT shadow_sale_id, shadow_item_id, shadow_qty FROM stock_batches WHERE batch_id = $1',
              [bId]
            )
            .catch(rethrowBusy)) as Array<{
            shadow_sale_id?: string | null;
            shadow_item_id?: string | null;
            shadow_qty?: number | null;
          }>;
          const r = rows?.[0];
          const q = Math.round(Number(r?.shadow_qty ?? 0));
          if (!r?.shadow_sale_id || !r?.shadow_item_id || !(q > 0)) return null;
          return { saleId: String(r.shadow_sale_id), itemId: String(r.shadow_item_id), qty: q };
        } catch (e) {
          if (isBusyError(e)) throw e;
          return null;
        }
      };

      for (const sh of shadows) {
        let step = 'link';
        try {
          // Single-run ownership claim (once per run, not per shadow — the
          // probe alone costs a round-trip): two tills reconciling the same
          // shadows would each deplete their local mirror of the same real
          // batch (2× global consumption) and collide on identical outbox
          // keys. The loser skips the whole run and retries on the next
          // receipt/pull. Offline or lock trouble proceeds unclaimed, exactly
          // as before (offline-first inviolable).
          if (sh === shadows[0]) {
            try {
              const { tryClaimCompensation } = await import('../sync/claims');
              const claim = await tryClaimCompensation(
                'RECONCILE',
                `RECON-${targetProductId ?? 'ALL'}`,
                String(sh.batch_id ?? '')
              );
              if (!claim.claimed && claim.reason === 'HELD_BY_PEER') {
                console.info(
                  `[fifo:reconcile] run held by peer ${claim.holder ?? ''} — deferred to next receipt/pull.`
                );
                break;
              }
            } catch {
              // Claim lane trouble — proceed unclaimed (status quo ante).
            }
          }
          const ctx = await loadShadowContext(sh.batch_id);
          if (!ctx) continue;
          const prodId = String(sh.product_id);
          const shadowUnit = Math.max(0, defaultNumber(sh.unit_cost, 0));
          let need = ctx.qty;
          const takes: Array<{ batchId: string; quantity: number; unitCost: number }> = [];
          let takenCost = 0;
          const depCtx = { prodId, deviceId, now, txId: `recon-${sh.batch_id}` };
          const live = (await db
            .select(
              `SELECT batch_id, quantity_remaining, unit_cost, received_at, purchase_order_id, created_at
               FROM stock_batches
               WHERE product_id = $1 AND quantity_remaining > 0 AND deleted = 0
                 AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
               ORDER BY received_at ASC, batch_id ASC`,
              [prodId]
            )
            .catch(rethrowBusy)) as Array<{ batch_id: string; quantity_remaining: number; unit_cost: number }>;
          step = 'deplete';
          // Coverage pre-check: depleting first and bailing on partial cover
          // committed the depletion with no accounting (burned units: shadow
          // stayed open at full qty, takes discarded). Only touch live
          // batches when they fully cover the shadow. Residual cross-tab
          // races can still partial-fill below (guarded takes); those keep
          // the old leave-open path.
          const totalAvail = live.reduce(
            (a, b) => a + Math.max(0, Math.floor(Number(b.quantity_remaining) || 0)),
            0
          );
          if (totalAvail < need) continue; // Partial PO cover: leave shadow open, batches untouched
          for (const b of live) {
            if (need <= 0) break;
            const avail = Math.max(0, Math.floor(Number(b.quantity_remaining) || 0));
            const want = Math.min(avail, need);
            if (want <= 0) continue;
            const res = await depleteBatchGuarded(db, { ...b, quantity_remaining: avail }, want, depCtx);
            if (res.taken <= 0) continue;
            need -= res.taken;
            takenCost += res.taken * defaultNumber(b.unit_cost, 0);
            takes.push({ batchId: b.batch_id, quantity: res.taken, unitCost: defaultNumber(b.unit_cost, 0) });
          }
          if (need > 0) continue; // Partial PO cover: leave shadow open

          step = 'read-line';
          const lineRows = (await db
            .select(
              `SELECT transaction_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale,
                      discount_amount, line_profit, json_payload, idempotency_key, version
               FROM transaction_items WHERE id = $1`,
              [ctx.itemId]
            )
            .catch(rethrowBusy)) as Array<Record<string, unknown>>;
          const line = lineRows?.[0];
          if (!line) continue;
          const lineQty = Math.max(1, Math.round(Number(line.quantity ?? 1)));
          const charged = defaultNumber(line.unit_price_charged ?? line.applied_price, 0);
          const oldUnit = defaultNumber(line.unit_cost_at_sale, 0);
          const newUnit = toIntMoney((oldUnit * lineQty - shadowUnit * ctx.qty + takenCost) / lineQty);
          const newLineProfit = toIntMoney((charged - newUnit) * lineQty);
          const diffCogs = newUnit * lineQty - oldUnit * lineQty;

          let priorAllocs: Array<{ batchId?: string }> = [];
          try {
            const p = JSON.parse(String(line.json_payload ?? '{}')) as { fifo_allocations?: Array<{ batchId?: string }> };
            priorAllocs = Array.isArray(p.fifo_allocations) ? p.fifo_allocations : [];
          } catch {
            priorAllocs = [];
          }
          const mergedAllocs = [
            ...priorAllocs.filter((a) => a?.batchId !== sh.batch_id && a?.batchId !== 'unbatched'),
            ...takes,
          ];
          const linePayload = toBoundedSyncJson({
            ...JSON.parse(String(line.json_payload ?? '{}')),
            unit_cost_at_sale: newUnit,
            line_profit: newLineProfit,
            fifo_allocations: mergedAllocs,
          });
          const lineKey = String(line.idempotency_key ?? `recon-${ctx.itemId}`);
          const lineVersion = bumpEntityVersionValue(line.version);
          step = 'write-line';
          await db.execute(
            `UPDATE transaction_items
             SET unit_cost_at_sale = $1, line_profit = $2, json_payload = $3,
                 version = $4, updated_at = $5, sync_status = 'pending'
             WHERE id = $6`,
            [newUnit, newLineProfit, linePayload, lineVersion, now, ctx.itemId]
          );
          await db.execute(
            `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES ($1, 'order_item', $2, 'UPSERT', $3, 'pending')
             ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
            [lineKey, ctx.itemId, linePayload, now]
          );

          step = 'read-order';
          const orderRows = (await db
            .select(
              `SELECT total, cost_total, profit, json_payload, idempotency_key, version
               FROM transactions WHERE id = $1`,
              [ctx.saleId]
            )
            .catch(rethrowBusy)) as Array<Record<string, unknown>>;
          const order = orderRows?.[0];
          if (order) {
            const orderTotal = toIntMoney(order.total ?? 0);
            const newCost = toIntMoney(Number(order.cost_total ?? 0) + diffCogs);
            const newProfit = orderTotal - newCost;
            const newMargin = orderTotal > 0 && Number.isFinite(newProfit / orderTotal)
              ? Number(((newProfit / orderTotal) * 100).toFixed(1))
              : 0;
            const orderVersion = bumpEntityVersionValue(order.version);
            let orderPayload: string;
            try {
              const p = JSON.parse(String(order.json_payload ?? '{}'));
              p.costTotal = newCost;
              p.cost_total = newCost;
              p.profit = newProfit;
              p.profitMargin = newMargin;
              p.profit_margin = newMargin;
              const itemsArr = p.items;
              if (Array.isArray(itemsArr)) {
                const m = String(ctx.itemId).match(/-item-(\d+)$/);
                const rawItem = m ? itemsArr[Number(m[1])] : undefined;
                if (rawItem && typeof rawItem === 'object' && rawItem) {
                  const it = rawItem as Record<string, unknown>;
                  it.unitCostAtSale = newUnit;
                  it.unitCostPrice = newUnit;
                  it.unit_cost_at_sale = newUnit;
                  it.lineProfit = newLineProfit;
                  it.line_profit = newLineProfit;
                }
              }
              orderPayload = toBoundedSyncJson({ ...p, version: orderVersion });
            } catch {
              orderPayload = String(order.json_payload ?? '{}');
            }
            await db.execute(
              `UPDATE transactions
               SET cost_total = $1, profit = $2, profit_margin = $3, json_payload = $4,
                   version = $5, updated_at = $6, sync_status = 'pending'
               WHERE id = $7`,
              [newCost, newProfit, newMargin, orderPayload, orderVersion, now, ctx.saleId]
            );
            step = 'enqueue-order';
            const orderKey = (order.idempotency_key as string) ?? `order-${ctx.saleId}`;
            await db.execute(
              `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
               VALUES ($1, 'order', $2, 'UPSERT', $3, 'pending')
               ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
              [orderKey, ctx.saleId, orderPayload, now]
            );
          }

          step = 'tombstone-shadow';
          const shadowVer = bumpEntityVersionValue(
            (await db.select('SELECT version FROM stock_batches WHERE batch_id = $1', [sh.batch_id]).catch(rethrowBusy) as Array<{ version?: number }>)?.[0]?.version
          );
          await db.execute(
            `UPDATE stock_batches SET deleted = 1, shadow_resolved = 1, version = $1,
              updated_at = $2, sync_status = 'pending' WHERE batch_id = $3`,
            [shadowVer, now, sh.batch_id]
          );

          step = 'ledger-swap';
          try {
            await db.execute('DELETE FROM sale_batch_allocations WHERE sale_id = $1 AND batch_id = $2', [ctx.saleId, sh.batch_id]);
            for (const t of takes) {
              const q = Math.max(0, Math.floor(Number(t.quantity ?? 0)));
              if (!(q > 0)) continue;
              const aId = `alloc-${ctx.saleId}-${ctx.itemId}-${String(t.batchId)}-recon`;
              await db.execute(
                `INSERT INTO sale_batch_allocations
                   (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
                    created_at, product_id, sale_item_id,
                    device_id, idempotency_key, sync_status, version, updated_at, deleted)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',1,$6,0)
                 ON CONFLICT(id) DO NOTHING`,
                [aId, ctx.saleId, String(t.batchId), q, Math.max(0, toIntMoney(t.unitCost ?? 0)), now, prodId, ctx.itemId, deviceId, aId]
              );
            }
          } catch (swapErr) {
            if (isBusyError(swapErr)) throw swapErr;
            console.warn('[fifo:reconcile] allocation ledger swap skipped:', swapErr);
          }

          step = 'ledger-materialize';
          try {
            const sumRows = (await db.select(
              `SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS s
               FROM sale_batch_allocations WHERE sale_id = $1 AND deleted = 0`,
              [ctx.saleId]
            ).catch(rethrowBusy)) as Array<{ s: number }>;
            const ledgerSum = Math.max(0, Math.round(Number(sumRows?.[0]?.s ?? 0)));
            const orderMeta = (await db.select('SELECT json_payload, idempotency_key, version FROM transactions WHERE id = $1', [ctx.saleId]).catch(rethrowBusy)) as Array<{ json_payload?: string; idempotency_key?: string; version?: number }>;
            const oRow = orderMeta?.[0];
            if (oRow) {
              let pJson = String(oRow.json_payload ?? '{}');
              try {
                const parsed = JSON.parse(pJson);
                parsed.ledgerCogsTotal = ledgerSum;
                parsed.ledger_cogs_total = ledgerSum;
                pJson = toBoundedSyncJson({ ...parsed, version: bumpEntityVersionValue(oRow.version) });
              } catch {}
              await db.execute(
                `UPDATE transactions SET ledger_cogs_total = $1, json_payload = $2,
                 updated_at = $3, sync_status = 'pending' WHERE id = $4`,
                [ledgerSum, pJson, now, ctx.saleId]
              );
              const oKey = String(oRow.idempotency_key ?? `order-${ctx.saleId}`);
              await db.execute(
                `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
                 VALUES ($1, 'order', $2, 'UPSERT', $3, 'pending')
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
                [oKey, ctx.saleId, pJson, now]
              );
            }
          } catch (matErr) {
            if (isBusyError(matErr)) throw matErr;
            console.warn('[fifo:reconcile] ledger materialization skipped:', matErr);
          }

          await db.execute(
            `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
             ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
            [`sb-${sh.batch_id}-resolved`, sh.batch_id, JSON.stringify({
              version: shadowVer, batch_id: sh.batch_id, product_id: prodId, quantity_remaining: 0,
              unit_cost: shadowUnit, updated_at: now, purchase_order_id: 'SHADOW', device_id: deviceId,
              shadow_sale_id: ctx.saleId, shadow_item_id: ctx.itemId, shadow_qty: ctx.qty, shadow_resolved: 1, deleted: 1
            }), now]
          );

          reconciledCount++;
          touchedSaleIds.push(ctx.saleId);
          touchedProductIds.add(prodId);
        } catch (itemErr) {
          if (isBusyError(itemErr)) throw itemErr;
          console.warn('[fifo:reconcile] shadow skipped:', sh?.batch_id, `stage=${step}`, itemErr);
        }
      }
      if (useTxn) await db.execute('COMMIT;');
    } catch (err) {
      if (useTxn) await db.execute('ROLLBACK;').catch(() => {});
      throw err;
    }
    if (reconciledCount > 0) {
      try {
        const { reconstructDexieTransactionsFromSql } = await import('./backfill');
        await reconstructDexieTransactionsFromSql(db, { onlyTransactionIds: touchedSaleIds });
      } catch (dexErr) {
        console.warn('[fifo:reconcile] Dexie mirror refresh skipped:', dexErr);
      }
      for (const id of touchedSaleIds) {
        if (reconciledSaleIds.length >= MAX_DRAIN_RECONCILED) reconciledSaleIds.shift();
        reconciledSaleIds.push(String(id));
      }
      try {
        const pids = [...touchedProductIds];
        if (pids.length > 0) await mirrorStockBatchesToDexie(db, pids);
      } catch (bErr) {
        console.warn('[fifo:reconcile] Batch Dexie mirror skipped:', bErr);
      }
      try {
        const { syncManager } = await import('../sync/SyncManager');
        syncManager.notifyLocalWrite();
      } catch {}
    }
    return reconciledCount;
  });
}

function bumpEntityVersionValue(current: unknown): number {
  const n = Number(current);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) + 1 : 2;
}

export async function appendStocktakeAdjustments(
  adjustments: Array<{ productId: string; countedStock: number; refId: string }>,
  _options?: unknown
): Promise<{ adjusted: number; skippedServices: number }> {
  const clean = (adjustments ?? [])
    .map((a) => ({
      productId: String(a?.productId ?? ''),
      counted: Math.max(0, Math.floor(Number(a?.countedStock ?? NaN))),
      refId: String(a?.refId ?? ''),
    }))
    .filter((a) => a.productId && a.refId && Number.isFinite(a.counted));
  if (clean.length === 0) return { adjusted: 0, skippedServices: 0 };
  const db = await getLocalDb();
  const productIds = [...new Set(clean.map((c) => c.productId))];
  const serviceIds = new Set<string>();
  const productCosts = new Map<string, number>();
  try {
    const prodRows = (await db.select(
      `SELECT id, category, cost_price FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
      productIds
    ).catch(rethrowBusy)) as Array<{ id?: string; category?: string; cost_price?: number }>;
    for (const p of prodRows ?? []) {
      const pid = String(p?.id ?? '');
      const cost = Number(p?.cost_price ?? NaN);
      if (Number.isFinite(cost)) productCosts.set(pid, Math.max(0, Math.round(cost)));
      if (pid.startsWith('qt-') || pid.startsWith('prod-misc-') || p?.category === 'Services') {
        serviceIds.add(pid);
      }
    }
  } catch {}
  let adjusted = 0;
  let skippedServices = 0;
  const now = utcNowIso();
  const deviceId = (await getOrCreateDeviceId(db).catch(() => 'default')) || 'default';
  // No explicit txn here by design: insertStockBatch/getProductStockBatches
  // open their own pooled connections, so a local BEGIN would neither cover
  // them nor serialize against them (and rolling back only our own
  // statements on a helper BUSY would guarantee divergence). Every write
  // below is statement-atomic with deterministic ids, so a crash mid-count
  // is repaired by recount — retries converge instead of doubling.
  for (const adj of clean) {
    if (serviceIds.has(adj.productId)) {
      skippedServices++;
      continue;
    }
    const currentBatches = await getProductStockBatches(adj.productId);
    const currentQty = currentBatches.reduce((acc, b) => acc + b.quantityRemaining, 0);
    const delta = adj.counted - currentQty;
    if (delta > 0) {
      const cost = productCosts.get(adj.productId) ?? 0;
      await insertStockBatch({
        productId: adj.productId,
        quantityRemaining: delta,
        unitCost: cost,
        purchaseOrderId: `stocktake-${adj.refId}`,
        receivedAt: now,
      });
      adjusted++;
    } else if (delta < 0) {
      let needToRemove = Math.abs(delta);
      for (const b of currentBatches) {
        if (needToRemove <= 0) break;
        const take = Math.min(b.quantityRemaining, needToRemove);
        await db.execute(
          `UPDATE stock_batches SET quantity_remaining = quantity_remaining - $1,
             version = version + 1, updated_at = $2, sync_status = 'pending'
           WHERE batch_id = $3`,
          [take, now, b.batchId]
        );
        // The shrink must travel: without this outbox row peers keep
        // selling phantom stock (the gain branch enqueues via
        // insertStockBatch; this branch previously enqueued nothing).
        const bumped = (await db
          .select(
            `SELECT batch_id, product_id, quantity_remaining, unit_cost, received_at,
                    purchase_order_id, device_id, idempotency_key, version, updated_at
             FROM stock_batches WHERE batch_id = $1`,
            [b.batchId]
          )
          .catch(() => [])) as Array<Record<string, unknown>>;
        const br = bumped?.[0];
        if (br) {
          const outKey = `sb-${String(br.batch_id)}-stk-${String(br.version ?? 1)}`;
          await db.execute(
            `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
             ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
            [
              outKey,
              String(br.batch_id),
              JSON.stringify({
                version: Number(br.version ?? 1),
                batch_id: String(br.batch_id),
                product_id: String(br.product_id ?? adj.productId),
                quantity_remaining: Number(br.quantity_remaining ?? 0),
                unit_cost: Number(br.unit_cost ?? 0),
                received_at: String(br.received_at ?? now),
                purchase_order_id: br.purchase_order_id ?? null,
                device_id: String(br.device_id ?? deviceId),
                idempotency_key: String(br.idempotency_key ?? outKey),
                updated_at: String(br.updated_at ?? now),
              }),
              now,
            ]
          );
        }
        needToRemove -= take;
      }
      adjusted++;
    }
    // Ledger truth: the next sale recomputes products.stock as
    // SUM(inventory_ledger). Without this ADJUST delta the counted stock
    // evaporates on the next recompute (and shrinkage never books). The
    // delta is counted-vs-LEDGER (the recompute's source), deterministic
    // per audit so retries converge while distinct audits never collide.
    const ledgerRows = (await db
      .select('SELECT COALESCE(SUM(delta), 0) AS s FROM inventory_ledger WHERE product_id = $1 AND deleted = 0', [
        adj.productId,
      ])
      .catch(() => [{ s: 0 }])) as Array<{ s?: unknown }>;
    const ledgerSum = Math.round(Number(ledgerRows?.[0]?.s ?? 0));
    const ledgerDelta = adj.counted - ledgerSum;
    if (ledgerDelta !== 0) {
      const ledgerId = `LED-STK-${adj.refId}-${adj.productId}`;
      await db.execute(
        `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
          idempotency_key, sync_status, created_at, updated_at, deleted)
         VALUES ($1,$2,$3,'ADJUST','stocktake',$4,$5,$6,'pending',$7,$7,0)
         ON CONFLICT(id) DO NOTHING`,
        [ledgerId, adj.productId, ledgerDelta, adj.refId, deviceId, ledgerId, now]
      );
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'ledger',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          ledgerId,
          ledgerId,
          JSON.stringify({
            id: ledgerId,
            product_id: adj.productId,
            delta: ledgerDelta,
            reason: 'ADJUST',
            ref_type: 'stocktake',
            ref_id: adj.refId,
            device_id: deviceId,
            idempotency_key: ledgerId,
          }),
        ]
      );
      await db.execute(
        `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=$1 AND deleted=0), stock),
          updated_at=$2, sync_status='pending' WHERE id=$1`,
        [adj.productId, now]
      );
    }
  }
  return { adjusted, skippedServices };
}

export async function previewFifoLineCosts(
  lines: Array<{ productId: string; qty: number; fallbackCost: number }>
): Promise<Array<{ unitCost: number; fullyCovered: boolean }>> {
  const { previewFifoCostsForLines } = await import('../utils/fifoPreview');
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const batchesByProduct = new Map<string, Array<{ batchId: string; quantityRemaining: number; unitCost: number }>>();
  for (const pid of productIds) {
    const batches = await getProductStockBatches(pid);
    batchesByProduct.set(pid, batches);
  }
  return previewFifoCostsForLines(batchesByProduct, lines);
}

export async function ensureProductParents(productIds: Iterable<string>): Promise<void> {
  try {
    const list = [...new Set((productIds ? Array.from(productIds) : []).map(p => String(p ?? '')).filter(Boolean))];
    if (list.length === 0) return;
    const db = await getLocalDb();
    const now = utcNowIso();
    for (const p of list) {
      await db.execute(
        `INSERT OR IGNORE INTO products (id, sku, barcode, title, brand, category, price,
          wholesale_price, cost_price, stock, json_payload, device_id, idempotency_key,
          sync_status, created_at, updated_at, deleted)
         VALUES ($1,'','','', 'Autre','Tous les produits',0, 0,0,0,$2,'local',$3,'pending',$4,$4,0)`,
        [p, JSON.stringify({ id: p, stub: true }), `stub-${p}`, now]
      ).catch(() => {});
    }
  } catch (e) {
    console.warn('[batches:parents] Product stub bridge skipped:', e);
  }
}

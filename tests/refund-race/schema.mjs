/**
 * Shared fixture for the MOBI-DEFECT-F adversarial harness.
 *
 * Real-shaped subset of mobi_pos.db (NOT NULL / UNIQUE / defaults mirror
 * src-tauri/src/lib.rs v1+v2+v5+v109): the same statements that fail here
 * fail in production, and the same statements that pass here pass there.
 * `createLegacySchema` is the pre-v109 shape (no refund identity columns,
 * no dedup gate, no trigger). `applyV109` mirrors the Rust v109 migration
 * step for step (ADD COLUMNs, backfill from the canonical receipt JSON,
 * index, guardrail trigger).
 */
import { DatabaseSync } from 'node:sqlite';

export const open = (path) => {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON;');
  return db;
};

export const createLegacySchema = (db) =>
  db.exec(`
  CREATE TABLE products (
    id TEXT PRIMARY KEY, stock REAL NOT NULL DEFAULT 0, category TEXT,
    cost_price REAL DEFAULT 0, idempotency_key TEXT DEFAULT '',
    sync_status TEXT DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT DEFAULT '');
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, receipt_number TEXT NOT NULL, customer_id TEXT,
    subtotal REAL NOT NULL, discount_total REAL DEFAULT 0, total REAL NOT NULL,
    cost_total REAL DEFAULT 0, profit REAL DEFAULT 0, profit_margin REAL DEFAULT 0,
    pricing_tier TEXT DEFAULT 'Retail', payment_method TEXT DEFAULT 'Especes',
    cash_tendered REAL DEFAULT 0, change_due REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'COMPLETED', created_at TEXT NOT NULL,
    json_payload TEXT NOT NULL, device_id TEXT DEFAULT 'local',
    idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending',
    updated_at TEXT DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER DEFAULT 0, ledger_cogs_total REAL, shift_id TEXT);
  CREATE TABLE transaction_items (
    id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL, applied_price REAL NOT NULL, discount REAL DEFAULT 0,
    imei_number TEXT, cost_price REAL DEFAULT 0,
    unit_price_charged REAL DEFAULT 0, unit_cost_at_sale REAL DEFAULT 0,
    discount_amount REAL DEFAULT 0, line_profit REAL DEFAULT 0,
    json_payload TEXT NOT NULL, device_id TEXT DEFAULT 'local',
    idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '',
    deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE inventory_ledger (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL, delta INTEGER NOT NULL,
    reason TEXT NOT NULL, ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE stock_batches (
    batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
    quantity_remaining REAL NOT NULL DEFAULT 0, unit_cost REAL NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL, purchase_order_id TEXT,
    device_id TEXT NOT NULL DEFAULT 'local', idempotency_key TEXT NOT NULL UNIQUE,
    sync_status TEXT DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0);
  CREATE TABLE customers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL,
    json_payload TEXT NOT NULL, updated_at TEXT NOT NULL,
    idempotency_key TEXT DEFAULT '', created_at TEXT DEFAULT '');
  CREATE TABLE customer_debts (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT NOT NULL,
    type TEXT NOT NULL, amount REAL NOT NULL, balance_after REAL NOT NULL,
    receipt_number TEXT, payment_method TEXT, notes TEXT, recorded_by TEXT,
    created_at TEXT NOT NULL, json_payload TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0);
  CREATE TABLE credit_vouchers (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE,
    initial_amount REAL NOT NULL, remaining_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE', updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, deleted INTEGER DEFAULT 0);
  CREATE TABLE cash_sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'OPEN');
  CREATE TABLE cash_movements (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    amount INTEGER NOT NULL, reason TEXT NOT NULL, cashier_name TEXT,
    created_at TEXT NOT NULL, json_payload TEXT NOT NULL);
  CREATE TABLE sync_outbox (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE security_audit_logs (
    id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, user TEXT NOT NULL,
    action TEXT NOT NULL, details TEXT NOT NULL, requires_pin INTEGER DEFAULT 0);
  CREATE TABLE audit_chain (
    event_id TEXT PRIMARY KEY, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL);
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
`);

/**
 * v109 mirror: guarded ADD COLUMNs (probe first, like the TS heal),
 * dedup gate, canonical backfill, index, guardrail trigger.
 */
export function applyV109(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const has = (t, c) =>
      db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(t, c) !== undefined;
    if (!has('transactions', 'original_transaction_id')) {
      db.exec('ALTER TABLE transactions ADD COLUMN original_transaction_id TEXT');
    }
    if (!has('transactions', 'is_refund')) {
      db.exec('ALTER TABLE transactions ADD COLUMN is_refund INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS refund_dedup (
      ticket_id TEXT NOT NULL, items_hash TEXT NOT NULL, refund_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (ticket_id, items_hash));`);
    db.exec(`UPDATE transactions
       SET original_transaction_id = json_extract(json_payload, '$.originalTransactionId')
     WHERE original_transaction_id IS NULL
       AND json_valid(json_payload)
       AND json_extract(json_payload, '$.originalTransactionId') IS NOT NULL`);
    db.exec(`UPDATE transactions
       SET is_refund = 1
     WHERE is_refund = 0
       AND json_valid(json_payload)
       AND json_extract(json_payload, '$.isRefund') = 1`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_txn_orig
      ON transactions(original_transaction_id) WHERE original_transaction_id IS NOT NULL`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS trg_refund_requires_dedup
      BEFORE INSERT ON transactions
      WHEN NEW.is_refund = 1
       AND COALESCE(NEW.sync_status, '') <> 'synced'
       AND NOT EXISTS (SELECT 1 FROM refund_dedup WHERE refund_id = NEW.id)
      BEGIN
        SELECT RAISE(ABORT, 'REFUND_BYPASS: refunds must go through refund_sale_atomic');
      END`);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

/**
 * Diagnostic: payloads that mention the key but were NOT backfilled.
 * Heuristic LIKE (documented): explicit `"originalTransactionId":null`
 * machine spellings are excluded — only genuinely unreached shapes count.
 */
export const backfillMissed = (db) =>
  db
    .prepare(
      `SELECT id FROM transactions WHERE original_transaction_id IS NULL
        AND json_payload LIKE '%originalTransactionId%'
        AND json_payload NOT LIKE '%"originalTransactionId":null%'`
    )
    .all();

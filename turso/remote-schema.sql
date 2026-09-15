-- Turso CLOUD schema (single store, one DB). Apply with: turso db shell <db> < turso/remote-schema.sql
-- NOTE: sync_outbox is LOCAL-ONLY (never created remotely).
-- inventory_ledger deltas are the stock source of truth; products.stock is a cache.

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, sku TEXT, barcode TEXT, title TEXT NOT NULL, brand TEXT, category TEXT,
  price REAL NOT NULL DEFAULT 0, wholesale_price REAL DEFAULT 0, cost_price REAL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0, image_url TEXT, is_serialized INTEGER DEFAULT 0, imei_number TEXT,
  vendor_name TEXT, lead_time_days INTEGER DEFAULT 7, daily_sales_velocity REAL DEFAULT 0,
  reorder_point INTEGER DEFAULT 5, json_payload TEXT NOT NULL DEFAULT '{}',
  device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'synced', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_products_updated ON products(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, receipt_number TEXT NOT NULL UNIQUE, customer_id TEXT,
  subtotal REAL DEFAULT 0, tax REAL DEFAULT 0, discount_total REAL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
  cost_total REAL DEFAULT 0, profit REAL DEFAULT 0, profit_margin REAL DEFAULT 0,
  pricing_tier TEXT DEFAULT 'Retail', payment_method TEXT, cash_tendered REAL DEFAULT 0, change_due REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'COMPLETED', json_payload TEXT NOT NULL DEFAULT '{}',
  device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'synced', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_orders_updated ON transactions(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_orders_receipt ON transactions(receipt_number);

CREATE TABLE IF NOT EXISTS transaction_items (
  id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL, applied_price REAL NOT NULL, discount REAL DEFAULT 0,
  imei_number TEXT, cost_price REAL DEFAULT 0, json_payload TEXT NOT NULL DEFAULT '{}',
  device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'synced', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_oitems_updated ON transaction_items(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_oitems_order ON transaction_items(transaction_id);

CREATE TABLE IF NOT EXISTS inventory_ledger (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  delta INTEGER NOT NULL, reason TEXT NOT NULL, ref_type TEXT, ref_id TEXT,
  device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'synced', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ledger_updated ON inventory_ledger(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_ledger_product ON inventory_ledger(product_id, created_at);

-- Customers travel on the generic document lane like everything else
-- (full object as JSON). Dropped the v1 full-column shape while empty.
DROP TABLE IF EXISTS customers;
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_customers_updated ON customers(updated_at, id);

-- Full-sync KV tables (generic document lane): one row per entity, full JSON
-- in data_json. Covers everything else so a dead laptop loses nothing.
-- Apply with: turso db shell <db> < turso/remote-schema.sql (idempotent)
CREATE TABLE IF NOT EXISTS repair_orders (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_repair_orders_updated ON repair_orders(updated_at, id);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_updated ON purchase_orders(updated_at, id);
CREATE TABLE IF NOT EXISTS trade_ins (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trade_ins_updated ON trade_ins(updated_at, id);
CREATE TABLE IF NOT EXISTS imei_records (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_imei_records_updated ON imei_records(updated_at, id);
CREATE TABLE IF NOT EXISTS security_audit_logs (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_updated ON security_audit_logs(updated_at, id);
CREATE TABLE IF NOT EXISTS cash_drops (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cash_drops_updated ON cash_drops(updated_at, id);
CREATE TABLE IF NOT EXISTS product_bundles (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bundles_updated ON product_bundles(updated_at, id);
CREATE TABLE IF NOT EXISTS customer_debts (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_customer_debts_updated ON customer_debts(updated_at, id);
CREATE TABLE IF NOT EXISTS store_expenses (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_store_expenses_updated ON store_expenses(updated_at, id);
CREATE TABLE IF NOT EXISTS cash_sessions (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_updated ON cash_sessions(updated_at, id);
CREATE TABLE IF NOT EXISTS cash_movements (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cash_movements_updated ON cash_movements(updated_at, id);
CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_app_settings_updated ON app_settings(updated_at, id);

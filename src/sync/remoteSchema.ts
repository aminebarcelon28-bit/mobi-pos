// Remote Turso Schema & Versioned Migrations Engine.
// Ensures that on first connect to an empty customer database, the full schema
// is created idempotently and versioned migrations are tracked.

import type { Client } from '@libsql/client';

export interface RemoteMigration {
  version: number;
  description: string;
  statements: string[];
}

export const GENERIC_SYNC_TABLES = [
  'customers',
  'repair_orders',
  'purchase_orders',
  'trade_ins',
  'imei_records',
  'security_audit_logs',
  'cash_drops',
  'product_bundles',
  'customer_debts',
  'store_expenses',
  'cash_sessions',
  'cash_movements',
  'app_settings',
] as const;

export const ALL_REMOTE_SYNC_TABLES = [
  'products',
  'transactions',
  'transaction_items',
  'inventory_ledger',
  ...GENERIC_SYNC_TABLES,
] as const;

export type GenericSyncTable = (typeof GENERIC_SYNC_TABLES)[number];
export type RemoteSyncTable = (typeof ALL_REMOTE_SYNC_TABLES)[number];

const REMOTE_SYNC_TABLES_SET = new Set<string>(ALL_REMOTE_SYNC_TABLES);

/**
 * Validates that a table name belongs to the compile-time and runtime whitelist
 * of allowed sync tables before SQL interpolation per rules.md R10.2.
 */
export function assertValidSyncTable(table: string): asserts table is RemoteSyncTable {
  if (!REMOTE_SYNC_TABLES_SET.has(table)) {
    throw new Error(`[Security R10.2] Refused SQL execution with unwhitelisted table name: "${table}"`);
  }
}

export function isValidSyncTable(table: string): table is RemoteSyncTable {
  return REMOTE_SYNC_TABLES_SET.has(table);
}

export const REMOTE_MIGRATIONS: RemoteMigration[] = [
  {
    version: 1,
    description: 'Initial remote schema with optimistic concurrency versioning',
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL,
        description TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        sku TEXT,
        barcode TEXT,
        title TEXT NOT NULL,
        brand TEXT,
        category TEXT,
        price REAL NOT NULL DEFAULT 0,
        wholesale_price REAL DEFAULT 0,
        cost_price REAL DEFAULT 0,
        stock INTEGER NOT NULL DEFAULT 0,
        image_url TEXT,
        is_serialized INTEGER DEFAULT 0,
        imei_number TEXT,
        vendor_name TEXT,
        lead_time_days INTEGER DEFAULT 7,
        daily_sales_velocity REAL DEFAULT 0,
        reorder_point INTEGER DEFAULT 5,
        json_payload TEXT NOT NULL DEFAULT '{}',
        device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_products_updated ON products(updated_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)`,
      `CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku)`,

      `CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        receipt_number TEXT NOT NULL UNIQUE,
        customer_id TEXT,
        subtotal REAL DEFAULT 0,
        tax REAL DEFAULT 0,
        discount_total REAL DEFAULT 0,
        total REAL NOT NULL DEFAULT 0,
        cost_total REAL DEFAULT 0,
        profit REAL DEFAULT 0,
        profit_margin REAL DEFAULT 0,
        pricing_tier TEXT DEFAULT 'Retail',
        payment_method TEXT,
        cash_tendered REAL DEFAULT 0,
        change_due REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'COMPLETED',
        json_payload TEXT NOT NULL DEFAULT '{}',
        device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_updated ON transactions(updated_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_receipt ON transactions(receipt_number)`,

      `CREATE TABLE IF NOT EXISTS transaction_items (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES products(id),
        quantity INTEGER NOT NULL,
        applied_price REAL NOT NULL,
        discount REAL DEFAULT 0,
        imei_number TEXT,
        cost_price REAL DEFAULT 0,
        json_payload TEXT NOT NULL DEFAULT '{}',
        device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_t_items_updated ON transaction_items(updated_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_t_items_order ON transaction_items(transaction_id)`,

      `CREATE TABLE IF NOT EXISTS inventory_ledger (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id),
        delta INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ref_type TEXT,
        ref_id TEXT,
        device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_inv_ledger_updated ON inventory_ledger(updated_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_inv_ledger_product ON inventory_ledger(product_id, created_at)`,

      ...GENERIC_SYNC_TABLES.flatMap((table) => [
        `CREATE TABLE IF NOT EXISTS ${table} (
          id TEXT PRIMARY KEY,
          data_json TEXT NOT NULL DEFAULT '{}',
          device_id TEXT NOT NULL DEFAULT '',
          idempotency_key TEXT NOT NULL UNIQUE,
          sync_status TEXT NOT NULL DEFAULT 'synced',
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0
        )`,
        `CREATE INDEX IF NOT EXISTS idx_${table}_updated ON ${table}(updated_at, id)`,
      ]),
    ],
  },
  {
    version: 2,
    description: 'Add optimistic concurrency version column to core tables if missing',
    statements: [
      'ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
      'ALTER TABLE transactions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
      'ALTER TABLE transaction_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
      'ALTER TABLE inventory_ledger ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
      'ALTER TABLE customers ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    ],
  },
];

export const LATEST_REMOTE_VERSION = 2;

export async function ensureRemoteSchemaColumns(client: Client): Promise<void> {
  const alterStatements = [
    'ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE transactions ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE transaction_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE inventory_ledger ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE customers ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
  ];
  for (const stmt of alterStatements) {
    try {
      await client.execute(stmt);
    } catch {
      // Column already exists, ignore
    }
  }
}

export async function checkRemoteSchemaStatus(client: Client): Promise<{
  isInitialized: boolean;
  appliedVersion: number;
  missingTables: string[];
}> {
  try {
    const tableRes = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
    const existing = new Set(tableRes.rows.map((r) => String(r.name)));

    const missingTables = ALL_REMOTE_SYNC_TABLES.filter((t) => !existing.has(t));
    if (!existing.has('schema_migrations')) {
      return { isInitialized: false, appliedVersion: 0, missingTables };
    }

    const migRes = await client.execute('SELECT MAX(version) as v FROM schema_migrations');
    const appliedVersion = Number(migRes.rows[0]?.v ?? 0);

    return {
      isInitialized: missingTables.length === 0 && appliedVersion >= LATEST_REMOTE_VERSION,
      appliedVersion,
      missingTables,
    };
  } catch (e) {
    throw new Error(`Erreur de vérification du schéma distant: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function applyRemoteMigrations(client: Client): Promise<number> {
  // Ensure schema_migrations table exists
  await client.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    description TEXT NOT NULL
  )`);

  const currentRes = await client.execute('SELECT version FROM schema_migrations');
  const appliedSet = new Set(currentRes.rows.map((r) => Number(r.version)));

  let appliedCount = 0;
  for (const mig of REMOTE_MIGRATIONS) {
    if (appliedSet.has(mig.version)) continue;

    for (const stmt of mig.statements) {
      try {
        await client.execute(stmt);
      } catch (err: unknown) {
        const msg = String(err);
        if (msg.includes('duplicate column') || msg.includes('already exists')) {
          continue;
        }
        throw err;
      }
    }

    await client.execute({
      sql: 'INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)',
      args: [mig.version, new Date().toISOString(), mig.description],
    });
    appliedCount++;
  }

  await ensureRemoteSchemaColumns(client);
  return appliedCount;
}

// Remote Turso Schema & Versioned Migrations Engine.
// Ensures that on first connect to an empty customer database, the full schema
// is created idempotently and versioned migrations are tracked.

import type { Client } from '@libsql/client';
import { utcNowIso } from '../utils/dateUtils';

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
  'credit_vouchers',
] as const;

export const ALL_REMOTE_SYNC_TABLES = [
  'products',
  'transactions',
  'transaction_items',
  'inventory_ledger',
  'stock_batches',
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
        compatible_model TEXT,
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
  {
    version: 3,
    description: 'Add optimistic concurrency version column to all generic sync tables',
    statements: GENERIC_SYNC_TABLES.map(
      (table) => `ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 1;`
    ),
  },
  {
    version: 4,
    description: 'Add compatible_model column to products table for hardware retail and phone repair shops',
    statements: [
      'ALTER TABLE products ADD COLUMN compatible_model TEXT;',
    ],
  },
  {
    version: 5,
    description: 'FIFO stock_batches table and transaction_items costing columns',
    statements: [
      `CREATE TABLE IF NOT EXISTS stock_batches (
        batch_id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        quantity_remaining REAL NOT NULL DEFAULT 0 CHECK (quantity_remaining >= 0),
        unit_cost REAL NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
        received_at TEXT NOT NULL,
        purchase_order_id TEXT,
        device_id TEXT NOT NULL DEFAULT 'local',
        idempotency_key TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        shadow_sale_id TEXT,
        shadow_item_id TEXT,
        shadow_qty REAL NOT NULL DEFAULT 0,
        shadow_resolved INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_stock_batches_fifo ON stock_batches(product_id, received_at)`,
      `CREATE INDEX IF NOT EXISTS idx_stock_batches_updated ON stock_batches(updated_at, batch_id)`,
      `CREATE INDEX IF NOT EXISTS idx_stock_batches_po ON stock_batches(purchase_order_id)`,
      `ALTER TABLE transaction_items ADD COLUMN unit_price_charged REAL DEFAULT 0`,
      `ALTER TABLE transaction_items ADD COLUMN unit_cost_at_sale REAL DEFAULT 0`,
      `ALTER TABLE transaction_items ADD COLUMN discount_amount REAL DEFAULT 0`,
      `ALTER TABLE transaction_items ADD COLUMN line_profit REAL DEFAULT 0`,
    ],
  },
  {
    version: 6,
    description: 'H27: give stock_batches the shared id/data_json cursor columns so the pull and restore cursor queries can read it',
    statements: [
      'ALTER TABLE stock_batches ADD COLUMN id TEXT;',
      "ALTER TABLE stock_batches ADD COLUMN data_json TEXT NOT NULL DEFAULT '{}';",
      // Backfill existing rows: `id` mirrors the PK so the shared cursor
      // key (updated_at, id) works; `data_json` carries the full column set
      // so the generic-KV apply path can read it. Idempotent (guarded by
      // `WHERE id IS NULL`) so a re-run touches nothing.
      `UPDATE stock_batches SET id = batch_id, data_json = json_object(
        'batch_id', batch_id, 'product_id', product_id,
        'quantity_remaining', quantity_remaining, 'unit_cost', unit_cost,
        'received_at', received_at, 'purchase_order_id', purchase_order_id,
        'device_id', device_id, 'idempotency_key', idempotency_key,
        'version', version, 'created_at', created_at, 'updated_at', updated_at,
        'deleted', deleted) WHERE id IS NULL;`,
      'CREATE INDEX IF NOT EXISTS idx_stock_batches_id_updated ON stock_batches(updated_at, id);',
    ],
  },

  {
    version: 7,
    description: 'H29: credit_vouchers joins the sync surface (generic KV shape)',
    statements: [
      `CREATE TABLE IF NOT EXISTS credit_vouchers (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL DEFAULT '{}',
        device_id TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_credit_vouchers_updated ON credit_vouchers(updated_at, id)`,
    ],
  },

  {
    version: 8,
    description: 'Compensation claims: advisory TTL locks so two online tills cannot pay out the same refund/void twice',
    statements: [
      `CREATE TABLE IF NOT EXISTS refund_claims (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'REFUND',
        device_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_refund_claims_ticket ON refund_claims(ticket_id)`,
      `CREATE INDEX IF NOT EXISTS idx_refund_claims_expiry ON refund_claims(expires_at)`,
    ],
  },

  {
    version: 9,
    description: 'Edge B shadow-batch linkage columns on stock_batches (pending-COGS markers reconciled on invoice receipt)',
    statements: [
      'ALTER TABLE stock_batches ADD COLUMN shadow_sale_id TEXT;',
      'ALTER TABLE stock_batches ADD COLUMN shadow_item_id TEXT;',
      'ALTER TABLE stock_batches ADD COLUMN shadow_qty REAL NOT NULL DEFAULT 0;',
      'ALTER TABLE stock_batches ADD COLUMN shadow_resolved INTEGER NOT NULL DEFAULT 0;',
    ],
  },

  {
    version: 10,
    description: 'STRICT FIFO allocation ledger (sale_batch_allocations, frozen checkout COGS)',
    statements: [
      `CREATE TABLE IF NOT EXISTS sale_batch_allocations (
        id TEXT PRIMARY KEY,
        sale_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        qty_consumed INTEGER NOT NULL CHECK (qty_consumed > 0),
        unit_cost_at_sale REAL NOT NULL CHECK (unit_cost_at_sale >= 0),
        created_at TEXT NOT NULL,
        product_id TEXT,
        sale_item_id TEXT,
        device_id TEXT NOT NULL DEFAULT 'local',
        idempotency_key TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_alloc_sale ON sale_batch_allocations(sale_id)`,
      `CREATE INDEX IF NOT EXISTS idx_alloc_batch ON sale_batch_allocations(batch_id)`,
      `CREATE INDEX IF NOT EXISTS idx_alloc_updated ON sale_batch_allocations(updated_at, id)`,
    ],
  },

  {
    version: 11,
    description: 'Atomic COGS materialization column (transactions.ledger_cogs_total)',
    statements: [
      'ALTER TABLE transactions ADD COLUMN ledger_cogs_total REAL;',
    ],
  },

  {
    version: 12,
    description: 'Owning cash session id (transactions.shift_id) for close attribution',
    statements: [
      'ALTER TABLE transactions ADD COLUMN shift_id TEXT;',
    ],
  },
];

export const LATEST_REMOTE_VERSION = 12;

export async function ensureRemoteSchemaColumns(client: Client): Promise<void> {
  const alterStatements = ALL_REMOTE_SYNC_TABLES.map(
    (table) => `ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 1`
  );
  alterStatements.push(
    'ALTER TABLE products ADD COLUMN compatible_model TEXT',
    'ALTER TABLE transaction_items ADD COLUMN unit_price_charged REAL DEFAULT 0',
    'ALTER TABLE transaction_items ADD COLUMN unit_cost_at_sale REAL DEFAULT 0',
    'ALTER TABLE transaction_items ADD COLUMN discount_amount REAL DEFAULT 0',
    'ALTER TABLE transaction_items ADD COLUMN line_profit REAL DEFAULT 0',
    'ALTER TABLE stock_batches ADD COLUMN shadow_sale_id TEXT',
    'ALTER TABLE stock_batches ADD COLUMN shadow_item_id TEXT',
    'ALTER TABLE stock_batches ADD COLUMN shadow_qty REAL NOT NULL DEFAULT 0',
    'ALTER TABLE stock_batches ADD COLUMN shadow_resolved INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE transactions ADD COLUMN ledger_cogs_total REAL'
  );
  for (const stmt of alterStatements) {
    try {
      await client.execute(stmt);
    } catch (err: unknown) {
      // Ignore ONLY duplicate-column errors. A blanket catch previously
      // swallowed auth/quota/network failures too, letting the migration march
      // on against a cloud it could not write to (silent divergence, C6).
      const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase();
      const isDuplicateColumn =
        msg.includes('duplicate column') ||
        msg.includes('duplicate_column') ||
        msg.includes('already exists');
      if (isDuplicateColumn) continue;
      throw err;
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
      args: [mig.version, utcNowIso(), mig.description],
    });
    appliedCount++;
  }

  await ensureRemoteSchemaColumns(client);
  return appliedCount;
}

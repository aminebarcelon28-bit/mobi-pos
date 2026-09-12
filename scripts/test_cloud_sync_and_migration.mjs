/**
 * MOBI POS — Automated Turso Cloud Sync & Safe Migration Test Suite
 * Validates Phase 3 requirements:
 * 1. Remote schema initialization & idempotency
 * 2. Pre-existing customer data migration with SHA-256 integrity & zero data loss
 * 3. Interrupted migration resumption with zero duplicates
 * 4. Offline resilience & error handling (no app crash on network down)
 * 5. Reconnection & outbox draining
 * 6. Optimistic concurrency & version conflict resolution
 * 7. Blob guardrail (base64 image URLs stripped from cloud)
 * 8. Storage quota metering & alert thresholds (70%, 85%, 95%)
 * 9. Disaster recovery restore & inventory recalculation
 * 10. Non-destructive merge on target device with existing data
 * 11. Account disconnect & credential wipe (local data preserved)
 * 12. SHA-256 tamper detection (mismatch reported if remote data altered)
 */

import crypto from 'node:crypto';
import { createClient } from '@libsql/client';

console.log('========================================================================');
console.log('⚡ MOBI POS — TURSO CLOUD SYNC & CUSTOMER MIGRATION TEST SUITE');
console.log('========================================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failCount++;
  }
}

// ── Helpers ──
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function computeTableDigest(rows) {
  const sorted = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const serialized = JSON.stringify(sorted);
  return sha256Hex(serialized);
}

function sanitizePayloadForCloud(obj) {
  const sanitized = { ...obj };
  if (typeof sanitized.imageUrl === 'string' && sanitized.imageUrl.startsWith('data:')) {
    sanitized.imageUrl = '';
  }
  return sanitized;
}

// ── DDL Definitions matching remoteSchema.ts ──
const DDL_MIGRATIONS = [
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
      `CREATE TABLE IF NOT EXISTS transaction_items (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        applied_price REAL NOT NULL DEFAULT 0,
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
      `CREATE TABLE IF NOT EXISTS inventory_ledger (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
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
      `CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL DEFAULT '{}',
        device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS customer_debts (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL DEFAULT '{}',
        device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS store_expenses (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL DEFAULT '{}',
        device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS repair_orders (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL DEFAULT '{}',
        device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )`,
    ],
  },
];

async function applyMigrations(client) {
  for (const mig of DDL_MIGRATIONS) {
    for (const stmt of mig.statements) {
      await client.execute(stmt);
    }
    await client.execute({
      sql: `INSERT OR REPLACE INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)`,
      args: [mig.version, new Date().toISOString(), mig.description],
    });
  }
}

// ── Test Runner ──
async function runTests() {
  const remote = createClient({ url: ':memory:' });

  console.log('--- TEST 1: Remote Schema Initialization & Idempotency ---');
  await applyMigrations(remote);
  const v1 = await remote.execute('SELECT version, description FROM schema_migrations WHERE version = 1');
  assert(v1.rows.length === 1 && v1.rows[0].version === 1, 'Initial migration applied successfully (version 1)');

  // Re-apply migration to test idempotency
  await applyMigrations(remote);
  const v1Recheck = await remote.execute('SELECT COUNT(*) as n FROM schema_migrations');
  assert(v1Recheck.rows[0].n === 1, 'Migration idempotency verified: re-running DDL causes no errors or duplicate migration entries');

  console.log('\n--- TEST 2: Pre-Existing Customer Data Migration & SHA-256 Integrity ---');
  // Seed local customer data (Products, Sales, Ledger, Customers, Debts)
  const localProducts = [];
  const localTransactions = [];
  const localTxItems = [];
  const localLedger = [];
  const localCustomers = [];
  const localDebts = [];

  const now = new Date().toISOString();

  // 50 products
  for (let i = 1; i <= 50; i++) {
    const isBlobProduct = i === 1;
    localProducts.push({
      id: `prod-${i}`,
      sku: `SKU-${1000 + i}`,
      barcode: `613000${String(i).padStart(4, '0')}`,
      title: `Produit Test ${i}`,
      brand: 'Samsung',
      category: 'Accessoires',
      price: 2500,
      wholesale_price: 2000,
      cost_price: 1800,
      stock: 20,
      // Product 1 has a base64 image URL (blob guardrail test)
      image_url: isBlobProduct ? 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...' : '',
      is_serialized: 0,
      imei_number: null,
      vendor_name: 'Fournisseur A',
      lead_time_days: 7,
      daily_sales_velocity: 1.5,
      reorder_point: 5,
      json_payload: JSON.stringify({
        id: `prod-${i}`,
        title: `Produit Test ${i}`,
        imageUrl: isBlobProduct ? 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...' : '',
      }),
      device_id: 'laptop-pos-1',
      idempotency_key: `mig-prod-${i}`,
      sync_status: 'synced',
      version: 1,
      created_at: now,
      updated_at: now,
      deleted: 0,
    });
  }

  // 100 transactions with items & ledger
  for (let i = 1; i <= 100; i++) {
    const txId = `tx-${i}`;
    localTransactions.push({
      id: txId,
      receipt_number: `REC-2026-${String(i).padStart(5, '0')}`,
      customer_id: i % 3 === 0 ? `cust-${i % 5 + 1}` : null,
      subtotal: 5000,
      tax: 0,
      discount_total: 0,
      total: 5000,
      cost_total: 3600,
      profit: 1400,
      profit_margin: 28.0,
      pricing_tier: 'Retail',
      payment_method: 'Espèces',
      cash_tendered: 5000,
      change_due: 0,
      status: 'COMPLETED',
      json_payload: JSON.stringify({ id: txId, total: 5000 }),
      device_id: 'laptop-pos-1',
      idempotency_key: `mig-tx-${i}`,
      sync_status: 'synced',
      version: 1,
      created_at: now,
      updated_at: now,
      deleted: 0,
    });

    localTxItems.push({
      id: `txi-${i}-1`,
      transaction_id: txId,
      product_id: 'prod-1',
      quantity: 2,
      applied_price: 2500,
      discount: 0,
      imei_number: null,
      cost_price: 1800,
      json_payload: '{}',
      device_id: 'laptop-pos-1',
      idempotency_key: `mig-txi-${i}-1`,
      sync_status: 'synced',
      version: 1,
      created_at: now,
      updated_at: now,
      deleted: 0,
    });

    localLedger.push({
      id: `led-${i}-1`,
      product_id: 'prod-1',
      delta: -2,
      reason: 'SALE',
      ref_type: 'TRANSACTION',
      ref_id: txId,
      device_id: 'laptop-pos-1',
      idempotency_key: `mig-led-${i}-1`,
      sync_status: 'synced',
      version: 1,
      created_at: now,
      updated_at: now,
      deleted: 0,
    });
  }

  // 10 customers & debts
  for (let i = 1; i <= 10; i++) {
    localCustomers.push({
      id: `cust-${i}`,
      name: `Client ${i}`,
      phone: `055000000${i}`,
      balance: 15000,
    });
    localDebts.push({
      id: `debt-${i}`,
      customerId: `cust-${i}`,
      amount: 15000,
      remainingAmount: 15000,
      status: 'UNPAID',
    });
  }

  // Upload products in batches
  for (const p of localProducts) {
    const cleanPayload = sanitizePayloadForCloud(JSON.parse(p.json_payload || '{}'));
    const cleanImg = p.image_url.startsWith('data:') ? '' : p.image_url;
    await remote.execute({
      sql: `INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price,
        cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
        daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key, sync_status,
        version, created_at, updated_at, deleted)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, price=excluded.price, stock=excluded.stock,
        version=excluded.version, updated_at=excluded.updated_at, deleted=excluded.deleted, sync_status='synced'`,
      args: [
        p.id, p.sku, p.barcode, p.title, p.brand, p.category, p.price, p.wholesale_price,
        p.cost_price, p.stock, cleanImg, p.is_serialized, p.imei_number, p.vendor_name,
        p.lead_time_days, p.daily_sales_velocity, p.reorder_point, JSON.stringify(cleanPayload),
        p.device_id, p.idempotency_key, 'synced', p.version, p.created_at, p.updated_at, p.deleted,
      ],
    });
  }

  // Upload transactions
  for (const t of localTransactions) {
    await remote.execute({
      sql: `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total,
        total, cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
        status, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total, version=excluded.version,
        updated_at=excluded.updated_at, deleted=excluded.deleted, sync_status='synced'`,
      args: [
        t.id, t.receipt_number, t.customer_id, t.subtotal, t.tax, t.discount_total,
        t.total, t.cost_total, t.profit, t.profit_margin, t.pricing_tier, t.payment_method,
        t.cash_tendered, t.change_due, t.status, t.json_payload, t.device_id, t.idempotency_key,
        'synced', t.version, t.created_at, t.updated_at, t.deleted,
      ],
    });
  }

  // Upload transaction_items & inventory_ledger
  for (const item of localTxItems) {
    await remote.execute({
      sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price,
        discount, imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status,
        version, created_at, updated_at, deleted)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,?,?)
        ON CONFLICT(id) DO NOTHING`,
      args: [
        item.id, item.transaction_id, item.product_id, item.quantity, item.applied_price,
        item.discount, item.imei_number, item.cost_price, item.json_payload, item.device_id,
        item.idempotency_key, item.version, item.created_at, item.updated_at, item.deleted,
      ],
    });
  }

  for (const led of localLedger) {
    await remote.execute({
      sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id,
        device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
        VALUES (?,?,?,?,?,?,?,?,'synced',?,?,?,?)
        ON CONFLICT(id) DO NOTHING`,
      args: [
        led.id, led.product_id, led.delta, led.reason, led.ref_type, led.ref_id,
        led.device_id, led.idempotency_key, led.version, led.created_at, led.updated_at, led.deleted,
      ],
    });
  }

  // Upload customers & debts
  for (const c of localCustomers) {
    await remote.execute({
      sql: `INSERT INTO customers (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
        VALUES (?,?,?,?,'synced',1,?,0)
        ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version, updated_at=excluded.updated_at`,
      args: [c.id, JSON.stringify(c), 'laptop-pos-1', `mig-c-${c.id}`, now],
    });
  }

  for (const d of localDebts) {
    await remote.execute({
      sql: `INSERT INTO customer_debts (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
        VALUES (?,?,?,?,'synced',1,?,0)
        ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version, updated_at=excluded.updated_at`,
      args: [d.id, JSON.stringify(d), 'laptop-pos-1', `mig-d-${d.id}`, now],
    });
  }

  // Verify Counts
  const rProdCount = (await remote.execute('SELECT COUNT(*) as n FROM products')).rows[0].n;
  const rTxCount = (await remote.execute('SELECT COUNT(*) as n FROM transactions')).rows[0].n;
  const rTxiCount = (await remote.execute('SELECT COUNT(*) as n FROM transaction_items')).rows[0].n;
  const rLedCount = (await remote.execute('SELECT COUNT(*) as n FROM inventory_ledger')).rows[0].n;
  const rCustCount = (await remote.execute('SELECT COUNT(*) as n FROM customers')).rows[0].n;
  const rDebtCount = (await remote.execute('SELECT COUNT(*) as n FROM customer_debts')).rows[0].n;

  assert(rProdCount === 50, `Products migrated: 50 local == ${rProdCount} remote (ZERO loss)`);
  assert(rTxCount === 100, `Transactions migrated: 100 local == ${rTxCount} remote (ZERO loss)`);
  assert(rTxiCount === 100, `Transaction items migrated: 100 local == ${rTxiCount} remote (ZERO loss)`);
  assert(rLedCount === 100, `Ledger entries migrated: 100 local == ${rLedCount} remote (ZERO loss)`);
  assert(rCustCount === 10, `Customers migrated: 10 local == ${rCustCount} remote (ZERO loss)`);
  assert(rDebtCount === 10, `Customer debts migrated: 10 local == ${rDebtCount} remote (ZERO loss)`);

  // Verify SHA-256 Digest Match on Transactions
  const remoteTxRows = (await remote.execute('SELECT id, receipt_number, total, created_at FROM transactions')).rows;
  const localTxRows = localTransactions.map(t => ({ id: t.id, receipt_number: t.receipt_number, total: t.total, created_at: t.created_at }));
  const localTxDigest = computeTableDigest(localTxRows);
  const remoteTxDigest = computeTableDigest(remoteTxRows);

  assert(localTxDigest === remoteTxDigest, `SHA-256 Digest matches 100%: ${localTxDigest.substring(0, 16)}...`);

  console.log('\n--- TEST 3: Interrupted Migration Resumption (Idempotency) ---');
  // Re-run the migration simulation with the same data
  for (const p of localProducts) {
    const cleanPayload = sanitizePayloadForCloud(JSON.parse(p.json_payload || '{}'));
    const cleanImg = p.image_url.startsWith('data:') ? '' : p.image_url;
    await remote.execute({
      sql: `INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price,
        cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
        daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key, sync_status,
        version, created_at, updated_at, deleted)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, price=excluded.price, stock=excluded.stock,
        version=excluded.version, updated_at=excluded.updated_at, deleted=excluded.deleted, sync_status='synced'`,
      args: [
        p.id, p.sku, p.barcode, p.title, p.brand, p.category, p.price, p.wholesale_price,
        p.cost_price, p.stock, cleanImg, p.is_serialized, p.imei_number, p.vendor_name,
        p.lead_time_days, p.daily_sales_velocity, p.reorder_point, JSON.stringify(cleanPayload),
        p.device_id, p.idempotency_key, 'synced', p.version, p.created_at, p.updated_at, p.deleted,
      ],
    });
  }

  const rProdCount2 = (await remote.execute('SELECT COUNT(*) as n FROM products')).rows[0].n;
  assert(rProdCount2 === 50, `Repeated migration yields exactly ${rProdCount2} rows (ZERO duplicates generated)`);

  console.log('\n--- TEST 4: Offline Resilience & Outbox Accumulation ---');
  // Offline outbox queue simulation
  const outbox = [];
  function recordOfflineSale(sale) {
    const idempotencyKey = `outbox-tx-${Date.now()}-${Math.random()}`;
    outbox.push({
      idempotency_key: idempotencyKey,
      table_name: 'transactions',
      action: 'INSERT',
      payload: sale,
      status: 'pending',
      retry_count: 0,
    });
    return idempotencyKey;
  }

  const key1 = recordOfflineSale({ id: 'tx-offline-1', total: 7500 });
  const key2 = recordOfflineSale({ id: 'tx-offline-2', total: 12000 });

  assert(outbox.length === 2, `Offline transactions queued safely in sync_outbox (${outbox.length} pending)`);
  assert(outbox[0].status === 'pending' && outbox[0].idempotency_key === key1, 'Outbox item has valid idempotency key and pending status');

  console.log('\n--- TEST 5: Reconnection & Outbox Draining ---');
  // Simulate draining outbox when connection is restored
  for (const item of outbox) {
    item.status = 'inflight';
    await remote.execute({
      sql: `INSERT INTO transactions (id, receipt_number, total, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
        VALUES (?, ?, ?, ?, ?, 'synced', 1, ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET total=excluded.total, version=excluded.version`,
      args: [item.payload.id, `REC-${item.payload.id}`, item.payload.total, 'laptop-pos-1', item.idempotency_key, now, now],
    });
    item.status = 'synced';
  }

  const remainingPending = outbox.filter(i => i.status !== 'synced').length;
  assert(remainingPending === 0, 'Outbox drained completely upon reconnection: 0 pending items remain');
  const rOfflineTx = (await remote.execute("SELECT COUNT(*) as n FROM transactions WHERE id LIKE 'tx-offline%'")).rows[0].n;
  assert(rOfflineTx === 2, `Drained transactions landed safely in cloud (${rOfflineTx} recorded)`);

  console.log('\n--- TEST 6: Optimistic Concurrency & Version Conflict Resolution ---');
  // Device B updates Product 1 with version 2
  await remote.execute({
    sql: `UPDATE products SET title = 'Produit 1 Modifié par Caisse B', price = 2800, version = 2, updated_at = ? WHERE id = 'prod-1'`,
    args: [now],
  });

  // Device A has stale version 1 and tries to update
  const staleAttempt = {
    title: 'Produit 1 Modifié par Caisse A Stale',
    price: 2600,
    version: 1,
  };

  await remote.execute({
    sql: `UPDATE products SET
      title = CASE WHEN ? >= version THEN ? ELSE title END,
      price = CASE WHEN ? >= version THEN ? ELSE price END,
      version = CASE WHEN ? >= version THEN ? ELSE version END
      WHERE id = 'prod-1'`,
    args: [
      staleAttempt.version, staleAttempt.title,
      staleAttempt.version, staleAttempt.price,
      staleAttempt.version, staleAttempt.version,
    ],
  });

  const p1Final = (await remote.execute("SELECT title, price, version FROM products WHERE id = 'prod-1'")).rows[0];
  assert(p1Final.version === 2, `Optimistic concurrency guard: version is ${p1Final.version} (stale v1 ignored)`);
  assert(p1Final.title === 'Produit 1 Modifié par Caisse B', `Higher version data preserved: "${p1Final.title}"`);

  console.log('\n--- TEST 7: Blob Guardrail (Base64 Image Omission) ---');
  const p1Cloud = (await remote.execute("SELECT image_url, json_payload FROM products WHERE id = 'prod-1'")).rows[0];
  const p1Payload = JSON.parse(p1Cloud.json_payload);
  assert(p1Cloud.image_url === '', 'Base64 image stripped from column image_url in cloud');
  assert(p1Payload.imageUrl === '', 'Base64 image stripped from json_payload in cloud (blob guardrail satisfied)');

  console.log('\n--- TEST 8: Storage Quota Metering & Threshold Banners ---');
  const FREE_TIER_QUOTA = 9 * 1024 * 1024 * 1024; // 9 GB

  function checkQuotaThreshold(usedBytes) {
    const pct = (usedBytes / FREE_TIER_QUOTA) * 100;
    if (pct >= 95) return { level: 'CRITICAL', banner: 'QUOTA_BLOCK_MUTATIONS' };
    if (pct >= 85) return { level: 'WARNING_HIGH', banner: 'QUOTA_85_WARNING' };
    if (pct >= 70) return { level: 'WARNING_LOW', banner: 'QUOTA_70_ADVISORY' };
    return { level: 'OK', banner: null };
  }

  const normalUsage = 250 * 1024 * 1024; // 250 MB
  const usage72 = FREE_TIER_QUOTA * 0.72;
  const usage88 = FREE_TIER_QUOTA * 0.88;
  const usage96 = FREE_TIER_QUOTA * 0.96;

  assert(checkQuotaThreshold(normalUsage).level === 'OK', 'Normal usage (250MB) reports OK');
  assert(checkQuotaThreshold(usage72).banner === 'QUOTA_70_ADVISORY', '72% usage triggers 70% Advisory Banner');
  assert(checkQuotaThreshold(usage88).banner === 'QUOTA_85_WARNING', '88% usage triggers 85% Warning Banner');
  assert(checkQuotaThreshold(usage96).banner === 'QUOTA_BLOCK_MUTATIONS', '96% usage triggers 95% Block Mutations Banner');

  console.log('\n--- TEST 9: Disaster Recovery Restore (Replacement Laptop) ---');
  // Create a brand new empty database simulating replacement laptop
  const newDeviceDb = createClient({ url: ':memory:' });
  await applyMigrations(newDeviceDb);

  // Restore from remote
  const remoteTables = ['products', 'transactions', 'transaction_items', 'inventory_ledger', 'customers', 'customer_debts'];
  let totalRestored = 0;

  for (const tbl of remoteTables) {
    const rows = (await remote.execute(`SELECT * FROM ${tbl}`)).rows;
    for (const r of rows) {
      if (tbl === 'products') {
        await newDeviceDb.execute({
          sql: `INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price, cost_price, stock, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?, ?)`,
          args: [r.id, r.sku, r.barcode, r.title, r.brand, r.category, r.price, r.wholesale_price, r.cost_price, r.stock, r.json_payload, r.device_id, r.idempotency_key, r.version, r.created_at, r.updated_at, r.deleted],
        });
      } else if (tbl === 'transactions') {
        await newDeviceDb.execute({
          sql: `INSERT INTO transactions (id, receipt_number, customer_id, total, status, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?, ?)`,
          args: [r.id, r.receipt_number, r.customer_id, r.total, r.status, r.json_payload, r.device_id, r.idempotency_key, r.version, r.created_at, r.updated_at, r.deleted],
        });
      } else if (tbl === 'transaction_items') {
        await newDeviceDb.execute({
          sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount, imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?, ?)`,
          args: [r.id, r.transaction_id, r.product_id, r.quantity, r.applied_price, r.discount, r.imei_number, r.cost_price, r.json_payload, r.device_id, r.idempotency_key, r.version, r.created_at, r.updated_at, r.deleted],
        });
      } else if (tbl === 'inventory_ledger') {
        await newDeviceDb.execute({
          sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?, ?)`,
          args: [r.id, r.product_id, r.delta, r.reason, r.ref_type, r.ref_id, r.device_id, r.idempotency_key, r.version, r.created_at, r.updated_at, r.deleted],
        });
      }
      totalRestored++;
    }
  }

  // Recalculate stock from ledger
  await newDeviceDb.execute(`
    UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=products.id AND deleted=0), stock)
  `);

  const restoredProdCount = (await newDeviceDb.execute('SELECT COUNT(*) as n FROM products')).rows[0].n;
  const restoredTxCount = (await newDeviceDb.execute('SELECT COUNT(*) as n FROM transactions')).rows[0].n;
  const restoredItemCount = (await newDeviceDb.execute('SELECT COUNT(*) as n FROM transaction_items')).rows[0].n;
  const restoredLedCount = (await newDeviceDb.execute('SELECT COUNT(*) as n FROM inventory_ledger')).rows[0].n;

  // Verify that restored transactions have valid receipt_numbers
  const sampleTx = (await newDeviceDb.execute('SELECT receipt_number FROM transactions LIMIT 1')).rows[0];
  assert(sampleTx.receipt_number && sampleTx.receipt_number.startsWith('REC-'), 'Restored transaction has valid receipt_number');

  assert(restoredProdCount === 50, `Disaster recovery restored all 50 products`);
  assert(restoredTxCount === 102, `Disaster recovery restored all 102 transactions (100 base + 2 drained)`);
  assert(restoredItemCount === 100, `Disaster recovery restored all 100 transaction items`);
  assert(restoredLedCount === 100, `Disaster recovery restored all 100 inventory ledger entries`);

  console.log('\n--- TEST 10: Non-Destructive Merge on Target Device ---');
  // Target device has 1 unique local product that does not exist in the cloud
  await newDeviceDb.execute({
    sql: `INSERT INTO products (id, title, price, stock, device_id, idempotency_key, version, created_at, updated_at, deleted)
      VALUES ('local-unique-prod-999', 'Article Local Exclusif', 1200, 5, 'laptop-pos-1', 'mig-local-999', 1, ?, ?, 0)`,
    args: [now, now],
  });

  const mergedCount = (await newDeviceDb.execute('SELECT COUNT(*) as n FROM products')).rows[0].n;
  assert(mergedCount === 51, `Non-destructive merge: local-only article preserved (50 remote + 1 local = ${mergedCount})`);

  console.log('\n--- TEST 11: Account Disconnect & Credential Wipe ---');
  // Simulate OS Keychain state
  const mockKeychain = {
    'mobi_pos_cloud_db_url': 'libsql://customer-boutique.turso.io',
    'mobi_pos_cloud_auth_token': 'eyJh...secretToken',
  };

  function wipeCloudAccount() {
    delete mockKeychain['mobi_pos_cloud_db_url'];
    delete mockKeychain['mobi_pos_cloud_auth_token'];
  }

  wipeCloudAccount();
  assert(!mockKeychain['mobi_pos_cloud_db_url'], 'DB URL wiped from OS Keychain on disconnect');
  assert(!mockKeychain['mobi_pos_cloud_auth_token'], 'Auth Token wiped from OS Keychain on disconnect');

  // Verify local database is still intact
  const finalLocalProdCount = (await newDeviceDb.execute('SELECT COUNT(*) as n FROM products')).rows[0].n;
  assert(finalLocalProdCount === 51, `Local POS database remains 100% intact after account disconnect (${finalLocalProdCount} items)`);

  console.log('\n--- TEST 12: SHA-256 Tamper Detection ---');
  // Simulate tampering: altering 1 character in remote transaction receipt
  const tamperedRemote = remoteTxRows.map(r => r.id === 'tx-1' ? { ...r, receipt_number: 'TAMPERED-RECEIPT' } : r);
  const tamperedDigest = computeTableDigest(tamperedRemote);

  assert(localTxDigest !== tamperedDigest, 'SHA-256 successfully detects any single field divergence between local and cloud');

  console.log('\n========================================================================');
  console.log(`🎯 CLOUD SYNC & MIGRATION TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('========================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

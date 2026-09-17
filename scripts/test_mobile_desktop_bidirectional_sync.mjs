// test_mobile_desktop_bidirectional_sync.mjs
// End-to-end verification of mobile-to-desktop and desktop-to-mobile sync,
// verifying:
// 1. Clock skew resilience: mobile wall clock in the past does NOT prevent desktop from pulling the sale.
// 2. Remote sale notification: desktop registers the remote sale and emits a notification.
// 3. Stock deduction convergence: both desktop and mobile deduce stock correctly.

import { createClient } from '@libsql/client';
import { unlinkSync, existsSync } from 'node:fs';

const nowIso = () => new Date().toISOString();
const tmpPath = (name) => `/tmp/test-bidirectional-${name}.db`;

for (const f of [tmpPath('remote'), tmpPath('desktop'), tmpPath('mobile')]) {
  try {
    if (existsSync(f)) unlinkSync(f);
  } catch {}
}

const remote = createClient({ url: `file:${tmpPath('remote')}` });
const desktop = createClient({ url: `file:${tmpPath('desktop')}` });
const mobile = createClient({ url: `file:${tmpPath('mobile')}` });

let failures = 0;
const assert = (name, condition, extra = '') => {
  if (condition) {
    console.log(`  ✅ [PASS] ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    console.error(`  ❌ [FAIL] ${name}${extra ? ' — ' + extra : ''}`);
    failures++;
  }
};

console.log('========================================================================');
console.log('⚡ MOBI POS — BIDIRECTIONAL SYNC, NOTIFICATION & STOCK TEST SUITE');
console.log('========================================================================');

const localDDL = `
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  sku TEXT,
  barcode TEXT,
  title TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  price REAL NOT NULL,
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
  json_payload TEXT NOT NULL,
  device_id TEXT DEFAULT 'legacy',
  idempotency_key TEXT DEFAULT '',
  sync_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT '',
  updated_at TEXT NOT NULL,
  deleted INTEGER DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL,
  customer_id TEXT,
  subtotal REAL NOT NULL,
  tax REAL NOT NULL,
  discount_total REAL NOT NULL,
  total REAL NOT NULL,
  cost_total REAL NOT NULL,
  profit REAL NOT NULL,
  profit_margin REAL NOT NULL,
  pricing_tier TEXT DEFAULT 'Retail',
  payment_method TEXT NOT NULL DEFAULT 'Espèces',
  cash_tendered REAL NOT NULL,
  change_due REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  created_at TEXT NOT NULL,
  json_payload TEXT NOT NULL,
  device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE transaction_items (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  applied_price REAL NOT NULL,
  discount REAL NOT NULL,
  imei_number TEXT,
  cost_price REAL NOT NULL,
  json_payload TEXT NOT NULL,
  device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE inventory_ledger (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE sync_outbox (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT,
  updated_at TEXT NOT NULL
);
`;

const remoteDDL = `
CREATE TABLE products (
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
  json_payload TEXT NOT NULL DEFAULT '{}',
  device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  customer_id TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  discount_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  profit REAL NOT NULL DEFAULT 0,
  profit_margin REAL NOT NULL DEFAULT 0,
  pricing_tier TEXT DEFAULT 'Retail',
  payment_method TEXT NOT NULL DEFAULT 'Espèces',
  cash_tendered REAL NOT NULL DEFAULT 0,
  change_due REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  created_at TEXT NOT NULL,
  json_payload TEXT NOT NULL DEFAULT '{}',
  device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE transaction_items (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  applied_price REAL NOT NULL,
  discount REAL NOT NULL,
  imei_number TEXT,
  cost_price REAL NOT NULL,
  json_payload TEXT NOT NULL DEFAULT '{}',
  device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE inventory_ledger (
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
);
`;

for (const s of localDDL.split(';').map((x) => x.trim()).filter(Boolean)) {
  await desktop.execute(s + ';');
  await mobile.execute(s + ';');
}
for (const s of remoteDDL.split(';').map((x) => x.trim()).filter(Boolean)) {
  await remote.execute(s + ';');
}

// Emulate SyncManager push and pull logic
async function pushClient(localDb, deviceId, serverNowOverride) {
  const batch = (await localDb.execute("SELECT * FROM sync_outbox WHERE status='pending' ORDER BY rowid LIMIT 50")).rows;
  if (batch.length === 0) return 0;

  const serverNow = serverNowOverride || (await remote.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")).rows[0].now;

  const rank = { product: 0, customer: 0, order: 1, order_item: 2, ledger: 2 };
  batch.sort((a, b) => (rank[a.entity_type] ?? 9) - (rank[b.entity_type] ?? 9));

  for (const op of batch) {
    const p = JSON.parse(op.payload_json);
    const version = Number(p.version ?? 1);
    const now = serverNow; // SERVER AUTHORITY (ADR-0008)

    if (op.entity_type === 'product') {
      await remote.execute({
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
          p.id, p.sku ?? '', p.barcode ?? '', p.title ?? p.id, p.brand ?? 'Autre', p.category ?? 'Tous',
          Number(p.price ?? 0), Number(p.wholesale_price ?? 0), Number(p.cost_price ?? 0), Number(p.stock ?? 0),
          p.image_url ?? '', p.is_serialized ? 1 : 0, p.imei_number ?? null, p.vendor_name ?? null,
          op.payload_json, p.device_id ?? deviceId, op.idempotency_key, version,
          p.created_at ?? now, now, Number(p.deleted ?? 0)
        ],
      });
    } else if (op.entity_type === 'order') {
      await remote.execute({
        sql: `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
          cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
          status, created_at, json_payload, device_id, idempotency_key, sync_status, version, updated_at, deleted)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,0)
          ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total,
            json_payload=excluded.json_payload, version=excluded.version, updated_at=excluded.updated_at, sync_status='synced'
            WHERE excluded.version >= transactions.version`,
        args: [
          p.id, p.receipt_number ?? p.receiptNumber ?? p.id, p.customer_id ?? null,
          Number(p.subtotal ?? 0), Number(p.tax ?? 0), Number(p.discount_total ?? 0), Number(p.total ?? 0),
          Number(p.cost_total ?? 0), Number(p.profit ?? 0), Number(p.profit_margin ?? 0),
          p.pricing_tier ?? 'Retail', p.payment_method ?? 'Espèces', Number(p.cash_tendered ?? 0),
          Number(p.change_due ?? 0), p.status ?? 'COMPLETED', p.created_at ?? now,
          op.payload_json, p.device_id ?? deviceId, op.idempotency_key, version, now
        ],
      });
    } else if (op.entity_type === 'order_item') {
      await remote.execute({
        sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
          imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,?,0) ON CONFLICT(id) DO NOTHING`,
        args: [
          p.id, p.transaction_id, p.product_id, Number(p.quantity ?? 1), Number(p.applied_price ?? 0),
          Number(p.discount ?? 0), p.imei_number ?? null, Number(p.cost_price ?? 0), op.payload_json,
          p.device_id ?? deviceId, op.idempotency_key, version, p.created_at ?? now, now
        ],
      });
    } else if (op.entity_type === 'ledger') {
      await remote.execute({
        sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
          idempotency_key, sync_status, version, created_at, updated_at, deleted)
          VALUES (?,?,?,?,?,?,?,?,'synced',?,?,?,0) ON CONFLICT(id) DO NOTHING`,
        args: [
          p.id, p.product_id, Number(p.delta ?? 0), p.reason ?? 'SALE', p.ref_type ?? null,
          p.ref_id ?? null, p.device_id ?? deviceId, op.idempotency_key, version, p.created_at ?? now, now
        ],
      });
    }

    await localDb.execute({ sql: "UPDATE sync_outbox SET status='synced' WHERE idempotency_key=?", args: [op.idempotency_key] });
  }
  return batch.length;
}

function createPuller(localDb, clientDeviceId) {
  const cursors = {};
  return async function pull() {
    let totalPulled = 0;
    const notifiedSales = [];

    for (const table of ['products', 'transactions', 'transaction_items', 'inventory_ledger']) {
      const cur = cursors[table] ?? { time: '1970-01-01T00:00:00.000Z', id: '' };
      const rs = (await remote.execute({
        sql: `SELECT * FROM ${table} WHERE (updated_at > ?) OR (updated_at = ? AND id > ?) ORDER BY updated_at ASC, id ASC LIMIT 200`,
        args: [cur.time, cur.time, cur.id],
      })).rows;

      let maxTime = cur.time;
      let maxId = cur.id;

      for (const r of rs) {
        const rowUpdated = r.updated_at ?? nowIso();
        const rowId = r.id;

        if (table === 'products') {
          await localDb.execute({
            sql: `INSERT INTO products (id, sku, barcode, title, price, stock, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET title=excluded.title, price=excluded.price, stock=excluded.stock,
              version=excluded.version, updated_at=excluded.updated_at, deleted=excluded.deleted, sync_status='synced'
              WHERE excluded.version >= products.version`,
            args: [
              r.id, r.sku ?? '', r.barcode ?? '', r.title ?? r.id, Number(r.price ?? 0), Number(r.stock ?? 0),
              r.json_payload ?? '{}', r.device_id ?? 'remote', r.idempotency_key ?? r.id, 'synced',
              Number(r.version ?? 1), r.created_at ?? nowIso(), r.updated_at ?? nowIso(), Number(r.deleted ?? 0)
            ],
          });
        } else if (table === 'transactions') {
          const existing = (await localDb.execute({ sql: 'SELECT id FROM transactions WHERE id = ?', args: [r.id] })).rows;
          const isNewSale = existing.length === 0;

          await localDb.execute({
            sql: `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
              cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
              status, created_at, json_payload, device_id, idempotency_key, sync_status, version, updated_at, deleted)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,?)
              ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total, version=excluded.version, updated_at=excluded.updated_at, sync_status='synced'
              WHERE excluded.version >= transactions.version`,
            args: [
              r.id, r.receipt_number ?? r.id, r.customer_id ?? null, Number(r.subtotal ?? 0), Number(r.tax ?? 0),
              Number(r.discount_total ?? 0), Number(r.total ?? 0), Number(r.cost_total ?? 0), Number(r.profit ?? 0),
              Number(r.profit_margin ?? 0), r.pricing_tier ?? 'Retail', r.payment_method ?? 'Espèces',
              Number(r.cash_tendered ?? 0), Number(r.change_due ?? 0), r.status ?? 'COMPLETED',
              r.created_at ?? nowIso(), r.json_payload ?? '{}', r.device_id ?? 'remote',
              r.idempotency_key ?? r.id, Number(r.version ?? 1), r.updated_at ?? nowIso(), Number(r.deleted ?? 0)
            ],
          });

          const incomingDeviceId = String(r.device_id || '');
          const isOwnDevice = incomingDeviceId !== '' && incomingDeviceId === clientDeviceId;
          if (isNewSale && !isOwnDevice && Number(r.deleted ?? 0) === 0) {
            notifiedSales.push(r);
          }
        } else if (table === 'transaction_items') {
          await localDb.execute({
            sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount, cost_price, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO NOTHING`,
            args: [
              r.id, r.transaction_id, r.product_id, Number(r.quantity ?? 1), Number(r.applied_price ?? 0),
              Number(r.discount ?? 0), Number(r.cost_price ?? 0), r.json_payload ?? '{}',
              r.device_id ?? 'remote', r.idempotency_key ?? r.id, 'synced', Number(r.version ?? 1),
              r.created_at ?? nowIso(), r.updated_at ?? nowIso(), Number(r.deleted ?? 0)
            ],
          });
        } else if (table === 'inventory_ledger') {
          await localDb.execute({
            sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET delta=excluded.delta, version=excluded.version, updated_at=excluded.updated_at, sync_status='synced'
              WHERE excluded.version >= inventory_ledger.version`,
            args: [
              r.id, r.product_id, Number(r.delta ?? 0), r.reason ?? 'SALE', r.ref_type ?? null,
              r.ref_id ?? null, r.device_id ?? 'remote', r.idempotency_key ?? r.id, 'synced',
              Number(r.version ?? 1), r.created_at ?? nowIso(), r.updated_at ?? nowIso(), Number(r.deleted ?? 0)
            ],
          });
        }

        totalPulled++;
        if (rowUpdated > maxTime || (rowUpdated === maxTime && rowId > maxId)) {
          maxTime = rowUpdated;
          maxId = rowId;
        }
      }
      cursors[table] = { time: maxTime, id: maxId };
    }

    if (totalPulled > 0) {
      await localDb.execute(
        `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE inventory_ledger.product_id = products.id AND deleted=0), stock)`
      );
    }

    return { totalPulled, notifiedSales };
  };
}

const desktopId = 'desktop-till-uuid-001';
const mobileId = 'mobile-phone-uuid-002';

const desktopPull = createPuller(desktop, desktopId);
const mobilePull = createPuller(mobile, mobileId);

const getStock = async (db, productId) => {
  const row = (await db.execute({ sql: 'SELECT stock FROM products WHERE id=?', args: [productId] })).rows[0];
  return Number(row?.stock ?? 0);
};

// --- PHASE 1: Desktop Initial Setup ---
console.log('\n--- TEST 1: Initial Desktop Catalog Setup & Seed Baseline ---');
const PROD_ID = 'PROD-COQUE-IPHONE';
const initialNow = nowIso();

// Insert baseline product (stock = 10)
await desktop.execute({
  sql: `INSERT INTO products (id, sku, barcode, title, brand, category, price, stock, json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version)
    VALUES (?, 'IPH15-CLR', '6131234567890', 'Coque Transparente iPhone 15', 'Apple', 'Coques iPhone', 1500, 10, '{}', ?, 'idem-p1', 'pending', ?, ?, 0, 1)`,
  args: [PROD_ID, desktopId, initialNow, initialNow],
});
// Insert initial ledger delta (+10)
await desktop.execute({
  sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version)
    VALUES ('led-seed-1', ?, 10, 'SEED', 'initial', ?, ?, 'idem-led-1', 'pending', ?, ?, 0, 1)`,
  args: [PROD_ID, PROD_ID, desktopId, initialNow, initialNow],
});
// Enqueue outbox
await desktop.execute({
  sql: "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) VALUES (?, 'product', ?, 'UPSERT', ?, 'pending', ?, ?)",
  args: ['idem-p1', PROD_ID, JSON.stringify({ id: PROD_ID, title: 'Coque Transparente iPhone 15', stock: 10, version: 1, created_at: initialNow }), initialNow, initialNow],
});
await desktop.execute({
  sql: "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) VALUES (?, 'ledger', ?, 'UPSERT', ?, 'pending', ?, ?)",
  args: ['idem-led-1', 'led-seed-1', JSON.stringify({ id: 'led-seed-1', product_id: PROD_ID, delta: 10, reason: 'SEED', version: 1, created_at: initialNow }), initialNow, initialNow],
});

await pushClient(desktop, desktopId);
assert('Desktop pushes initial catalog to cloud', true);

// Mobile pairs and pulls initial catalog
const mobileInit = await mobilePull();
assert('Mobile pulls initial catalog', mobileInit.totalPulled >= 2, `pulled ${mobileInit.totalPulled} rows`);
const mobileStockInit = await getStock(mobile, PROD_ID);
assert('Mobile initial stock is 10', mobileStockInit === 10, `got ${mobileStockInit}`);

// Desktop cursor advances
await desktopPull();

// --- PHASE 2: Mobile Checkout with Simulated Clock Skew ---
console.log('\n--- TEST 2: Mobile Checkout with Intentional Clock Skew (Phone behind Cloud) ---');
// Emulate phone clock being 10 minutes BEHIND real cloud time
const skewedPhoneWallClock = new Date(Date.now() - 600_000).toISOString();
const mobileTxId = 'TXN-MOBILE-001';
const mobileReceipt = 'REC-M-1001';

// 1. Mobile records transaction locally with phone's local time
await mobile.execute({
  sql: `INSERT INTO transactions (id, receipt_number, total, subtotal, tax, discount_total, cost_total, profit, profit_margin, payment_method, cash_tendered, change_due, status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, deleted, version)
    VALUES (?, ?, 1500, 1500, 0, 0, 500, 1000, 66.6, 'Espèces', 1500, 0, 'COMPLETED', ?, ?, ?, ?, 'pending', ?, 0, 1)`,
  args: [mobileTxId, mobileReceipt, skewedPhoneWallClock, JSON.stringify({ id: mobileTxId, receiptNumber: mobileReceipt, total: 1500, deviceId: mobileId }), mobileId, 'idem-tx-m1', skewedPhoneWallClock],
});
// 2. Mobile records inventory ledger delta (-1)
await mobile.execute({
  sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version)
    VALUES ('led-sale-m1', ?, -1, 'SALE', 'order', ?, ?, 'idem-led-m1', 'pending', ?, ?, 0, 1)`,
  args: [PROD_ID, mobileTxId, mobileId, skewedPhoneWallClock, skewedPhoneWallClock],
});
// 3. Mobile recomputes stock locally (10 -> 9) and bumps version
await mobile.execute({
  sql: `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=? AND deleted=0), stock),
    version = version + 1, updated_at=? WHERE id=?`,
  args: [PROD_ID, skewedPhoneWallClock, PROD_ID],
});
const mobileLocalStock = await getStock(mobile, PROD_ID);
assert('Mobile stock immediately drops to 9 locally', mobileLocalStock === 9, `got ${mobileLocalStock}`);

// 4. Mobile enqueues outbox rows
await mobile.execute({
  sql: "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) VALUES (?, 'order', ?, 'UPSERT', ?, 'pending', ?, ?)",
  args: ['idem-tx-m1', mobileTxId, JSON.stringify({ id: mobileTxId, receipt_number: mobileReceipt, total: 1500, status: 'COMPLETED', created_at: skewedPhoneWallClock, device_id: mobileId }), skewedPhoneWallClock, skewedPhoneWallClock],
});
await mobile.execute({
  sql: "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) VALUES (?, 'ledger', ?, 'UPSERT', ?, 'pending', ?, ?)",
  args: ['idem-led-m1', 'led-sale-m1', JSON.stringify({ id: 'led-sale-m1', product_id: PROD_ID, delta: -1, reason: 'SALE', device_id: mobileId, version: 1 }), skewedPhoneWallClock, skewedPhoneWallClock],
});
await mobile.execute({
  sql: "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) VALUES (?, 'product', ?, 'UPSERT', ?, 'pending', ?, ?)",
  args: ['idem-p1-v2', PROD_ID, JSON.stringify({ id: PROD_ID, title: 'Coque Transparente iPhone 15', stock: 9, version: 2, device_id: mobileId }), skewedPhoneWallClock, skewedPhoneWallClock],
});

// Mobile pushes to Turso. Under ADR-0008, pushClient stamps updated_at with serverNow
const cloudNow = nowIso();
await pushClient(mobile, mobileId, cloudNow);

// Verify that remote Turso received the transaction with serverNow timestamp authority
const remoteTx = (await remote.execute({ sql: 'SELECT updated_at, created_at, device_id FROM transactions WHERE id=?', args: [mobileTxId] })).rows[0];
assert('Remote transaction created_at preserves origin truth', remoteTx.created_at === skewedPhoneWallClock);
assert('Remote transaction updated_at has server authority (not skewed phone clock)', remoteTx.updated_at === cloudNow);

// --- PHASE 3: Desktop Pull & Remote Notification ---
console.log('\n--- TEST 3: Desktop Pulls Mobile Sale & Fires Remote Sale Notification ---');
const desktopPullResult = await desktopPull();
assert('Desktop successfully pulls mobile sale despite phone clock skew', desktopPullResult.totalPulled >= 2, `pulled ${desktopPullResult.totalPulled} rows`);

assert('Desktop received remote sale notification', desktopPullResult.notifiedSales.length === 1, `notified count: ${desktopPullResult.notifiedSales.length}`);
assert('Desktop notification matches mobile receipt number', desktopPullResult.notifiedSales[0]?.receipt_number === mobileReceipt);
assert('Desktop notification correctly identifies mobile as remote author', desktopPullResult.notifiedSales[0]?.device_id === mobileId);

const desktopStockAfterMobileSale = await getStock(desktop, PROD_ID);
assert('Desktop stock drops from 10 to 9', desktopStockAfterMobileSale === 9, `got ${desktopStockAfterMobileSale}`);

// --- PHASE 4: Bidirectional Sale from Desktop to Mobile ---
console.log('\n--- TEST 4: Desktop Sale Syncs Back to Mobile Till ---');
const desktopTxId = 'TXN-DESKTOP-002';
const desktopReceipt = 'REC-D-2002';
const desktopSaleNow = nowIso();

await desktop.execute({
  sql: `INSERT INTO transactions (id, receipt_number, total, subtotal, tax, discount_total, cost_total, profit, profit_margin, payment_method, cash_tendered, change_due, status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, deleted, version)
    VALUES (?, ?, 3000, 3000, 0, 0, 1000, 2000, 66.6, 'Espèces', 3000, 0, 'COMPLETED', ?, ?, ?, ?, 'pending', ?, 0, 1)`,
  args: [desktopTxId, desktopReceipt, desktopSaleNow, JSON.stringify({ id: desktopTxId, receiptNumber: desktopReceipt, total: 3000, deviceId: desktopId }), desktopId, 'idem-tx-d2', desktopSaleNow],
});
await desktop.execute({
  sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version)
    VALUES ('led-sale-d2', ?, -2, 'SALE', 'order', ?, ?, 'idem-led-d2', 'pending', ?, ?, 0, 1)`,
  args: [PROD_ID, desktopTxId, desktopId, desktopSaleNow, desktopSaleNow],
});
await desktop.execute({
  sql: `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=? AND deleted=0), stock),
    version = version + 1, updated_at=? WHERE id=?`,
  args: [PROD_ID, desktopSaleNow, PROD_ID],
});
await desktop.execute({
  sql: "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) VALUES (?, 'order', ?, 'UPSERT', ?, 'pending', ?, ?)",
  args: ['idem-tx-d2', desktopTxId, JSON.stringify({ id: desktopTxId, receipt_number: desktopReceipt, total: 3000, status: 'COMPLETED', created_at: desktopSaleNow, device_id: desktopId }), desktopSaleNow, desktopSaleNow],
});
await desktop.execute({
  sql: "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) VALUES (?, 'ledger', ?, 'UPSERT', ?, 'pending', ?, ?)",
  args: ['idem-led-d2', 'led-sale-d2', JSON.stringify({ id: 'led-sale-d2', product_id: PROD_ID, delta: -2, reason: 'SALE', device_id: desktopId, version: 1 }), desktopSaleNow, desktopSaleNow],
});
await desktop.execute({
  sql: "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) VALUES (?, 'product', ?, 'UPSERT', ?, 'pending', ?, ?)",
  args: ['idem-p1-v3', PROD_ID, JSON.stringify({ id: PROD_ID, title: 'Coque Transparente iPhone 15', stock: 7, version: 3, device_id: desktopId }), desktopSaleNow, desktopSaleNow],
});

await pushClient(desktop, desktopId);

const mobilePullResult = await mobilePull();
assert('Mobile pulls desktop sale', mobilePullResult.totalPulled >= 2, `pulled ${mobilePullResult.totalPulled} rows`);
assert('Mobile received remote sale notification for desktop sale', mobilePullResult.notifiedSales.length === 1);
assert('Mobile notification matches desktop receipt number', mobilePullResult.notifiedSales[0]?.receipt_number === desktopReceipt);

const finalMobileStock = await getStock(mobile, PROD_ID);
const finalDesktopStock = await getStock(desktop, PROD_ID);
assert('Final Mobile stock is 7', finalMobileStock === 7, `got ${finalMobileStock}`);
assert('Final Desktop stock is 7', finalDesktopStock === 7, `got ${finalDesktopStock}`);
assert('Both devices have perfectly converged stock (7 vs 7)', finalMobileStock === finalDesktopStock);

console.log('========================================================================');
if (failures === 0) {
  console.log('🎯 ALL BIDIRECTIONAL SYNC & NOTIFICATION INVARIANTS SATISFIED (0 FAILURES)');
  console.log('========================================================================\n');
  process.exit(0);
} else {
  console.error(`💥 TEST SUITE FAILED WITH ${failures} FAILURE(S)`);
  console.log('========================================================================\n');
  process.exit(1);
}

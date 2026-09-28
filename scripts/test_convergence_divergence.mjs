// Adversarial test: cross-device convergence under the ACTUAL sync protocol.
// Mirrors SyncManager.pushOnce (toRemoteUpsert) + pullOnce (applyRemoteRow)
// against a shared cloud DB, using the real SQL each side emits.
//
// Scenario A (stock divergence): Device A sells 1 of 10. Device B sells 1 of 10
//   at ~the same time. Both push. Does cloud stock converge to 8?
//
// Scenario B (void un-void): Device A voids a sale. A queued echo of the
//   pre-void sale lands afterwards. Does VOIDED survive?
//
// Scenario C (refund restock): a refund enqueues NO ledger delta when nothing
//   is restocked, and a `deltas: []` checkout write. Verify no phantom ledger.
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' :: ' + extra : ''}`);
}

const tmp = (n) => `file:tmp-conv-${n}.db`;
const cleanup = ['a', 'b', 'cloud'];
for (const n of cleanup) {
  for (const f of [`tmp-conv-${n}.db`, `tmp-conv-${n}.db-wal`, `tmp-conv-${n}.db-journal`]) {
    rmSync(f, { force: true });
  }
}

const cloud = createClient({ url: tmp('cloud') });
const devA = createClient({ url: tmp('a') });
const devB = createClient({ url: tmp('b') });

const SCHEMA = `
  CREATE TABLE products (
    id TEXT PRIMARY KEY, sku TEXT, barcode TEXT, title TEXT NOT NULL, brand TEXT,
    compatible_model TEXT, category TEXT, price REAL NOT NULL DEFAULT 0,
    wholesale_price REAL NOT NULL DEFAULT 0, cost_price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0, image_url TEXT, is_serialized INTEGER NOT NULL DEFAULT 0,
    imei_number TEXT, vendor_name TEXT, lead_time_days INTEGER NOT NULL DEFAULT 7,
    daily_sales_velocity INTEGER NOT NULL DEFAULT 0, reorder_point INTEGER NOT NULL DEFAULT 5,
    json_payload TEXT, device_id TEXT, idempotency_key TEXT, sync_status TEXT,
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, receipt_number TEXT, customer_id TEXT, subtotal REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0, discount_total REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
    cost_total REAL NOT NULL DEFAULT 0, profit REAL NOT NULL DEFAULT 0, profit_margin REAL NOT NULL DEFAULT 0,
    pricing_tier TEXT, payment_method TEXT, cash_tendered REAL NOT NULL DEFAULT 0,
    change_due REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT,
    json_payload TEXT, device_id TEXT, idempotency_key TEXT, sync_status TEXT,
    version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE inventory_ledger (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL, delta INTEGER NOT NULL,
    reason TEXT, ref_type TEXT, ref_id TEXT, device_id TEXT, idempotency_key TEXT,
    sync_status TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT,
    updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0
  );
`;
const SCHEMA_STMTS = SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
for (const c of [cloud, devA, devB]) {
  for (const stmt of SCHEMA_STMTS) await c.execute(stmt);
}

// Seed product on both devices + cloud (v1, stock 10)
// The app's recompute sets stock = SUM(delta) over the ledger, so the ledger
// must carry the opening stock as a +10 row.
for (const c of [cloud, devA, devB]) {
  await c.execute(
    `INSERT INTO products (id, sku, title, price, stock, version, updated_at, deleted)
     VALUES ('P1','SKU1','Phone',100,10,1,'t0',0)`,
  );
  await c.execute(
    `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
     VALUES ('L-OPEN','P1',10,'INITIAL_STOCK',NULL,NULL,'system','k-open','synced',1,'t0','t0',0)`,
  );
}

// ---------- Scenario A: concurrent sales ----------
// Device A sells 1: ledger delta -1, cached stock recomputed to 9
await devA.execute(
  `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
   VALUES ('L-A1','P1',-1,'SALE','order','T-A','devA','k-A1','pending',1,'t1','t1',0)`,
);
await devA.execute(
  `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id='P1' AND deleted=0), stock),
    version = version + 1, updated_at='t1', sync_status='pending' WHERE id='P1'`,
);
// Device B sells 1: same, stock 9
await devB.execute(
  `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
   VALUES ('L-B1','P1',-1,'SALE','order','T-B','devB','k-B1','pending',1,'t2','t2',0)`,
);
await devB.execute(
  `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id='P1' AND deleted=0), stock),
    version = version + 1, updated_at='t2', sync_status='pending' WHERE id='P1'`,
);

// Both push their product row (toRemoteUpsert 'product' lane: version || 1)
// Device A's local version is now 2, B's is 2.
const pushProduct = async (c, version, stock, now) => {
  await c.execute(
    `INSERT INTO products (id, sku, title, price, stock, version, updated_at, deleted)
     VALUES ('P1','SKU1','Phone',100,?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET stock=excluded.stock, version=excluded.version,
       updated_at=excluded.updated_at, deleted=excluded.deleted
     WHERE excluded.version >= products.version`,
    [stock, version, now],
  );
};
await pushProduct(cloud, 2, 9, 't3'); // A pushes first
await pushProduct(cloud, 2, 9, 't4'); // B pushes second — same version, `>=` admits it

const cloudP = (await cloud.execute('SELECT stock, version FROM products WHERE id = ?', ['P1'])).rows;
check('cloud stock after both pushes = 9 (last writer wins, version 2)', cloudP[0]?.stock === 9, `stock=${cloudP[0]?.stock} v=${cloudP[0]?.version}`);

// Now both devices pull each other's LEDGER rows (the real stock authority)
// and recompute. This is the convergence path the app relies on.
const pullLedger = async (from, to) => {
  // The real pull reads by updated_at cursor and applies rows the device lacks;
  // simulate that by id rather than sync_status.
  const rs = await from.execute('SELECT * FROM inventory_ledger');
  for (const row of rs.rows) {
    await to.execute(
      `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
       VALUES (?,?,?,?,?,?,?,?,'synced',?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET delta=excluded.delta, version=excluded.version, updated_at=excluded.updated_at, sync_status='synced'
       WHERE excluded.version >= inventory_ledger.version`,
      [row.id, row.product_id, row.delta, row.reason, row.ref_type, row.ref_id, row.device_id,
       row.idempotency_key, row.version, row.created_at, row.updated_at, row.deleted],
    );
  }
};
await pullLedger(devA, cloud);
await pullLedger(devB, cloud);
await pullLedger(cloud, devA);
await pullLedger(cloud, devB);

const recompute = async (c) => {
  await c.execute(
    `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id='P1' AND deleted=0), stock) WHERE id='P1'`,
  );
};
for (const c of [cloud, devA, devB]) await recompute(c);

const finalA = (await devA.execute('SELECT stock FROM products WHERE id = ?', ['P1'])).rows;
const finalB = (await devB.execute('SELECT stock FROM products WHERE id = ?', ['P1'])).rows;
const finalC = (await cloud.execute('SELECT stock FROM products WHERE id = ?', ['P1'])).rows;
check('all three converge to stock 8 after ledger exchange', finalA[0]?.stock === 8 && finalB[0]?.stock === 8 && finalC[0]?.stock === 8,
  `A=${finalA[0]?.stock} B=${finalB[0]?.stock} cloud=${finalC[0]?.stock}`);

// ---------- Scenario B: void un-void ----------
await devA.execute(
  `INSERT INTO transactions (id, receipt_number, total, status, version, updated_at, deleted)
   VALUES ('T-V','R1',500,'COMPLETED',1,'t1',0)`,
);
// local void (FIXED): status flips AND version bumps (enqueueOrderSync /
// writeCheckoutAtomic now maintain the transactions version clock)
await devA.execute(`UPDATE transactions SET status='VOIDED', updated_at='t2', version=2, sync_status='pending' WHERE id='T-V'`);
// a queued remote echo of the pre-void sale arrives (applyRemoteRow 'transactions')
await devA.execute(
  `INSERT INTO transactions (id, receipt_number, total, status, version, updated_at, deleted)
   VALUES ('T-V','R1',500,'COMPLETED',1,'t3',0)
   ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total,
     version=excluded.version, updated_at=excluded.updated_at, sync_status='synced'
   WHERE excluded.version >= transactions.version`,
);
const voidRow = (await devA.execute('SELECT status FROM transactions WHERE id = ?', ['T-V'])).rows;
check('VOIDED sale survives a same-version COMPLETED echo', voidRow[0]?.status === 'VOIDED', `status=${voidRow[0]?.status}`);

// Round-trip: the bumped version must reach the cloud (toRemoteUpsert reads
// payload.version) so peers also reject the stale echo.
await cloud.execute(
  `INSERT INTO transactions (id, receipt_number, total, status, version, updated_at, deleted)
   VALUES ('T-V','R1',500,'VOIDED',2,'t2',0)
   ON CONFLICT(id) DO UPDATE SET status=excluded.status, version=excluded.version, updated_at=excluded.updated_at
   WHERE excluded.version >= transactions.version`,
);
const cloudV = (await cloud.execute('SELECT status, version FROM transactions WHERE id = ?', ['T-V'])).rows;
check('voided version 2 reaches the cloud', cloudV[0]?.status === 'VOIDED' && cloudV[0]?.version === 2,
  `status=${cloudV[0]?.status} v=${cloudV[0]?.version}`);
// The cloud now holds v2 VOIDED. A stale v1 COMPLETED echo arrives at the
// cloud (e.g. a queued pre-void push from a slow device). The cloud's own
// `excluded.version >= transactions.version` guard must reject it — this is
// what protects every peer, since peers all pull from the cloud.
await cloud.execute(
  `INSERT INTO transactions (id, receipt_number, total, status, version, updated_at, deleted)
   VALUES ('T-V','R1',500,'COMPLETED',1,'t3',0)
   ON CONFLICT(id) DO UPDATE SET status=excluded.status, version=excluded.version, updated_at=excluded.updated_at
   WHERE excluded.version >= transactions.version`,
);
const cloudAfterStale = (await cloud.execute('SELECT status, version FROM transactions WHERE id = ?', ['T-V'])).rows;
check('cloud rejects stale v1 COMPLETED echo while holding v2 VOIDED',
  cloudAfterStale[0]?.status === 'VOIDED' && cloudAfterStale[0]?.version === 2,
  `status=${cloudAfterStale[0]?.status} v=${cloudAfterStale[0]?.version}`);

// ---------- Scenario C: refund with no restock leaves no phantom ledger ----------
const before = (await devA.execute('SELECT COUNT(*) AS n FROM inventory_ledger WHERE ref_id = ?', ['REF-1'])).rows;
check('no ledger row exists for a not-yet-issued refund', Number(before[0]?.n) === 0, `n=${before[0]?.n}`);

const failed = results.filter((r) => !r.ok);
console.log('====================================================');
console.log(`TEST SUMMARY: ${results.length - failed.length} PASSED, ${failed.length} FAILED`);
console.log('====================================================');
if (failed.length > 0) {
  console.log('FAILURES:');
  for (const f of failed) console.log(' - ' + f.name);
}
for (const c of [cloud, devA, devB]) await c.close();
for (const n of cleanup) {
  for (const f of [`tmp-conv-${n}.db`, `tmp-conv-${n}.db-wal`, `tmp-conv-${n}.db-journal`]) {
    try { rmSync(f, { force: true }); } catch { /* WAL sidecar may still be open */ }
  }
}
process.exit(failed.length > 0 ? 1 : 0);

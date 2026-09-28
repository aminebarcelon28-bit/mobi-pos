/**
 * H6 regression: oversell guard at the checkout write boundary.
 *
 * Reproduction (pre-fix): the cart validated stock against the Zustand copy
 * (`createCartSlice.addToCart` → `product.stock`), which is stale the moment
 * another lane sells the same SKU — a second till, a synced remote sale, or a
 * double-tap on "Encaisser" between render and click. `writeCheckoutAtomic`
 * had no stock check of its own: it appended the SALE ledger delta
 * unconditionally and recomputed `products.stock = SUM(delta)`, so two
 * concurrent sales of a 5-unit product both "succeeded" and stock went to -1.
 *
 * Post-fix the ledger sum is re-read at the write boundary and a SALE that
 * would drive it negative is refused before any row is persisted.
 *
 * Lazy-baseline follow-up (ledger=-1 poisonings, e.g. INSUFFICIENT_STOCK
 * on stability-test rows after one untracked sale): a product with on-hand
 * stock but zero ledger rows materializes an idempotent SEED baseline from
 * products.stock before the check, so the first sale can no longer leave a
 * lone SALE delta behind. This replica mirrors that production behavior.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-h6-oversell.db';
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, sku TEXT, barcode TEXT, title TEXT, brand TEXT, category TEXT,
  price INTEGER DEFAULT 0, wholesale_price INTEGER DEFAULT 0, cost_price INTEGER DEFAULT 0,
  stock INTEGER DEFAULT 0, json_payload TEXT, device_id TEXT, idempotency_key TEXT,
  sync_status TEXT DEFAULT 'pending', created_at TEXT, updated_at TEXT, deleted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inventory_ledger (
  id TEXT PRIMARY KEY, product_id TEXT, delta INTEGER, reason TEXT, ref_type TEXT,
  ref_id TEXT, device_id TEXT, idempotency_key TEXT, sync_status TEXT DEFAULT 'pending',
  created_at TEXT, updated_at TEXT, deleted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, receipt_number TEXT, customer_id TEXT, total INTEGER, status TEXT,
  json_payload TEXT, idempotency_key TEXT, version INTEGER DEFAULT 1, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  idempotency_key TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT,
  operation TEXT, payload_json TEXT, status TEXT, updated_at TEXT
);
`;

/**
 * Mirrors the production guard: refuse a SALE delta that would make the ledger
 * sum negative. Returns the thrown message, or null when the sale is allowed.
 */
async function guardAndApply(db, txnId, deltas, snapshots = []) {
  const snapById = new Map(snapshots.map((s) => [String(s.id || ''), s]));
  for (const d of deltas) {
    const pid = String(d.productId || '');
    if (!pid) continue;
    const rows = await db.execute(
      'SELECT COUNT(*) AS n, COALESCE(SUM(delta),0) AS s FROM inventory_ledger WHERE product_id=$1 AND deleted=0',
      [pid],
    );
    const rowCount = Number(rows.rows?.[0]?.n ?? 0);
    const ledgerSum = Number(rows.rows?.[0]?.s ?? 0);
    // Mirrors production lazy baseline: untracked + on-hand stock > 0 seeds
    // an idempotent SEED row first (ON CONFLICT DO NOTHING + re-read).
    let liveRowCount = rowCount;
    let liveSum = ledgerSum;
    if (rowCount === 0) {
      const stockRows = await db.execute('SELECT stock FROM products WHERE id=$1', [pid]);
      // Stub door (F1): no SQLite row — fall back to the sale payload's
      // last-known snapshot stock (production: productSnapshots[].stock).
      const snapStock =
        stockRows.rows && stockRows.rows.length > 0
          ? Number(stockRows.rows[0]?.stock ?? 0)
          : Number(snapById.get(pid)?.stock ?? 0);
      const onHand = Math.trunc(Number.isFinite(snapStock) ? snapStock : 0);
      if (Number.isFinite(onHand) && onHand > 0) {
        const seedKey = `seed-baseline-${pid}`;
        await db.execute(
          `INSERT INTO inventory_ledger (id,product_id,delta,reason,ref_type,ref_id,device_id,idempotency_key,sync_status,created_at,updated_at,deleted)
           VALUES ($1,$2,$3,'SEED','heal',$4,'dev',$5,'pending','t','t',0) ON CONFLICT(id) DO NOTHING`,
          [seedKey, pid, onHand, txnId, seedKey],
        );
        await db.execute(
          `INSERT INTO sync_outbox (idempotency_key,entity_type,entity_id,operation,payload_json,status)
           VALUES ($1,'ledger',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
          [seedKey, seedKey, JSON.stringify({ id: seedKey, product_id: pid, delta: onHand, reason: 'SEED' })],
        );
        const re = await db.execute(
          'SELECT COUNT(*) AS n, COALESCE(SUM(delta),0) AS s FROM inventory_ledger WHERE product_id=$1 AND deleted=0',
          [pid],
        );
        liveRowCount = Number(re.rows?.[0]?.n ?? 0);
        liveSum = Number(re.rows?.[0]?.s ?? 0);
      }
    }
    if (liveRowCount > 0) {
      const take = Math.abs(Number(d.delta ?? 0));
      if (liveSum - take < 0) {
        return `INSUFFICIENT_STOCK:${pid}: ledger=${liveSum} requested=${take}`;
      }
    }
  }
  // Allowed: append the deltas and recompute cached stock exactly like step 7.
  for (const d of deltas) {
    await db.execute(
      `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
        idempotency_key, sync_status, created_at, updated_at, deleted)
       VALUES ($1,$2,$3,$4,$5,$6,'dev','k','pending','t','t',0)`,
      [`L-${txnId}-${d.productId}`, d.productId, d.delta, 'SALE', 'order', txnId],
    );
  }
  for (const pid of [...new Set(deltas.map((d) => d.productId))]) {
    await db.execute(
      `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=$1 AND deleted=0), stock)
       WHERE id=$1`,
      [pid],
    );
  }
  return null;
}

async function main() {
  let db;
  try { rmSync(DB_FILE); } catch { /* may not exist */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  db = createClient({ url: `file:${DB_FILE}` });
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.execute(stmt);
  }

  // Seed: product P1 with 5 units on hand (ledger seeded by the catalog path).
  await db.execute(
    `INSERT INTO products (id,sku,barcode,title,brand,category,price,stock,json_payload,device_id,idempotency_key,sync_status,created_at,updated_at,deleted)
     VALUES ('P1','SKU1','4001','Phone','Brand','Cat',100,5,'{}','dev','seed','pending','t0','t0',0)`,
  );
  await db.execute(
    `INSERT INTO inventory_ledger (id,product_id,delta,reason,ref_type,ref_id,device_id,idempotency_key,sync_status,created_at,updated_at,deleted)
     VALUES ('L-seed','P1',5,'SEED','manual','P1','dev','kseed','pending','t0','t0',0)`,
  );

  // ---- Step 1: first concurrent sale of 5 units succeeds (stock exactly 0). ----
  let err1 = await guardAndApply(db, 'TXN-A', [{ productId: 'P1', delta: -5, reason: 'SALE' }]);
  check('first sale of full stock is accepted', err1 === null, err1 ?? 'ok');
  const after1 = (await db.execute('SELECT stock FROM products WHERE id=$1', ['P1'])).rows[0];
  check('stock is exactly 0 after selling all units', Number(after1?.stock) === 0, `stock=${after1?.stock}`);

  // ---- Step 2: second concurrent sale of 1 unit is REFUSED (no oversell). ----
  let err2 = await guardAndApply(db, 'TXN-B', [{ productId: 'P1', delta: -1, reason: 'SALE' }]);
  check('second sale past zero stock is refused', err2 !== null && err2.startsWith('INSUFFICIENT_STOCK'), err2 ?? 'ALLOWED');
  const after2 = (await db.execute('SELECT stock FROM products WHERE id=$1', ['P1'])).rows[0];
  check('stock stays 0, never negative', Number(after2?.stock) === 0, `stock=${after2?.stock}`);
  const ledgerRows = (await db.execute('SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id=$1 AND ref_id=$2', ['P1', 'TXN-B'])).rows;
  check('refused sale leaves no ledger row', Number(ledgerRows?.[0]?.n) === 0, `rows=${ledgerRows?.[0]?.n}`);

  // ---- Step 3: a refund (deltas:[]) never trips the guard. ----
  let err3 = await guardAndApply(db, 'TXN-REF', []);
  check('refund path (no SALE deltas) is never blocked', err3 === null, err3 ?? 'ok');

  // ---- Step 4: an untracked product (no ledger row) is allowed through. ----
  await db.execute(
    `INSERT INTO products (id,sku,barcode,title,brand,category,price,stock,json_payload,device_id,idempotency_key,sync_status,created_at,updated_at,deleted)
     VALUES ('P2','SKU2','4002','Case','Brand','Cat',20,3,'{}','dev','seed2','pending','t0','t0',0)`,
  );
  let err4 = await guardAndApply(db, 'TXN-C', [{ productId: 'P2', delta: -1, reason: 'SALE' }]);
  check('untracked product (no ledger row) is allowed', err4 === null, err4 ?? 'ok');

  // ---- Step 5: restock then sale is allowed again (guard is live, not latched). ----
  await db.execute(
    `INSERT INTO inventory_ledger (id,product_id,delta,reason,ref_type,ref_id,device_id,idempotency_key,sync_status,created_at,updated_at,deleted)
     VALUES ('L-restk','P1',10,'RECEIVE','manual','P1','dev','kr','pending','t9','t9',0)`,
  );
  let err5 = await guardAndApply(db, 'TXN-D', [{ productId: 'P1', delta: -3, reason: 'SALE' }]);
  check('sale is accepted again after restock', err5 === null, err5 ?? 'ok');
  const after5 = (await db.execute('SELECT stock FROM products WHERE id=$1', ['P1'])).rows[0];
  check('stock reflects restock minus sale', Number(after5?.stock) === 7, `stock=${after5?.stock}`);

  // ---- Step 6: untracked-with-stock sale heals instead of poisoning. ----
  // P2 (seeded stock 3) sold 1 in Step 4: the lazy baseline (3) plus the
  // sale (-1) must leave ledger 2 / stock 2 — never the old -1 poison.
  const p2ledger = (await db.execute(
    'SELECT COUNT(*) AS n, COALESCE(SUM(delta),0) AS s FROM inventory_ledger WHERE product_id=$1 AND deleted=0',
    ['P2'],
  )).rows[0];
  check('first untracked sale materializes baseline (ledger 3-1=2)', Number(p2ledger?.s) === 2, `sum=${p2ledger?.s}`);
  const p2seed = (await db.execute(
    "SELECT delta FROM inventory_ledger WHERE product_id=$1 AND reason='SEED' AND deleted=0", ['P2'],
  )).rows;
  check('baseline row is a SEED of on-hand stock', p2seed.length === 1 && Number(p2seed[0]?.delta) === 3, JSON.stringify(p2seed));
  const p2stock = (await db.execute('SELECT stock FROM products WHERE id=$1', ['P2'])).rows[0];
  check('cached stock follows healed ledger (2)', Number(p2stock?.stock) === 2, `stock=${p2stock?.stock}`);
  // Oversell past the healed truth is still refused — with truthful numbers.
  const err6 = await guardAndApply(db, 'TXN-E', [{ productId: 'P2', delta: -3, reason: 'SALE' }]);
  check('sale past healed stock refused with truthful ledger=2', err6 === 'INSUFFICIENT_STOCK:P2: ledger=2 requested=3', err6 ?? 'ALLOWED');
  // Exact-quantity sale drains to zero and stays non-negative.
  const err7 = await guardAndApply(db, 'TXN-F', [{ productId: 'P2', delta: -2, reason: 'SALE' }]);
  check('exact-quantity sale accepted', err7 === null, err7 ?? 'ok');
  const p2final = (await db.execute(
    'SELECT COUNT(*) AS n, COALESCE(SUM(delta),0) AS s FROM inventory_ledger WHERE product_id=$1 AND deleted=0',
    ['P2'],
  )).rows[0];
  check('ledger drains to exactly 0, never negative', Number(p2final?.s) === 0, `sum=${p2final?.s}`);

  // ---- Step 7: stub door (F1) — no SQLite row, snapshot stock 5. ----
  // Production then stub-inserts stock 0; without the snapshot fallback the
  // first sale would poison the ledger (0 → -take). With it, the sale heals.
  const err8 = await guardAndApply(db, 'TXN-G', [{ productId: 'P3', delta: -2, reason: 'SALE' }], [{ id: 'P3', stock: 5 }]);
  check('Dexie-only sale allowed via snapshot baseline', err8 === null, err8 ?? 'ok');
  const p3seed = (await db.execute(
    "SELECT delta FROM inventory_ledger WHERE product_id=$1 AND reason='SEED' AND deleted=0", ['P3'],
  )).rows;
  check('stub-door baseline is a SEED of snapshot stock', p3seed.length === 1 && Number(p3seed[0]?.delta) === 5, JSON.stringify(p3seed));
  const p3ledger = (await db.execute(
    'SELECT COUNT(*) AS n, COALESCE(SUM(delta),0) AS s FROM inventory_ledger WHERE product_id=$1 AND deleted=0', ['P3'],
  )).rows[0];
  check('stub-door ledger converges (5-2=3, never -2)', Number(p3ledger?.s) === 3, `sum=${p3ledger?.s}`);
  const err9 = await guardAndApply(db, 'TXN-H', [{ productId: 'P3', delta: -4, reason: 'SALE' }], [{ id: 'P3', stock: 5 }]);
  check('overtake past healed stub-door stock refused', err9 === 'INSUFFICIENT_STOCK:P3: ledger=3 requested=4', err9 ?? 'ALLOWED');
  // Legacy replay payload without stock field keeps legacy behavior.
  const err10 = await guardAndApply(db, 'TXN-I', [{ productId: 'P4', delta: -1, reason: 'SALE' }], [{ id: 'P4' }]);
  check('snapshot without stock stays untracked-allowed', err10 === null, err10 ?? 'ok');

  console.log('====================================================');
  console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
  console.log('====================================================');
  await db.close();
  try { rmSync(DB_FILE); } catch { /* noop */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

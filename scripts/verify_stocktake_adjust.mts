/**
 * VERIFICATION: physical counts survive checkout recompute.
 *
 * The bug class: stocktake audits + manual stock edits persisted
 * products.stock with NO inventory_ledger delta, so the next sale's
 * `products.stock = SUM(ledger)` recompute silently discarded the count —
 * and shrinkage never booked anywhere. appendStocktakeAdjustments closes it
 * by persisting (counted − ledger sum) as one ADJUST delta per product.
 *
 * This replicates the helper's exact SQL shape (the helper itself needs the
 * Tauri SQL lane, like every other fixture here):
 *   A. counted 8 vs ledger 10 → delta −2 → recompute yields 8;
 *   B. repeat identical count → variance 0 → no delta (idempotent);
 *   C. service sentinel (999999) never becomes a delta;
 *   D. zero-ledger product counted 3 → +3 delta → recompute yields 3;
 *   E. ADJUST rows carry reason/refType for the audit trail + outbox sync.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

let pass = 0; let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
};

const DB_FILE = 'tmp-verify-stocktake.db';
try { rmSync(DB_FILE); } catch {}
const db = createClient({ url: `file:${DB_FILE}` });

// Verbatim helper shape: sums → variances vs counted → ADJUST deltas.
async function adjust(items, refType) {
  const ids = [...new Set(items.map((i) => i.productId))];
  const cats = (await db.execute({ sql: `SELECT id, category FROM products WHERE id IN (${ids.map(() => '?').join(',')})`, args: ids })).rows;
  const svc = new Set((cats ?? []).filter((r) => String(r.category ?? '') === 'Services').map((r) => String(r.id)));
  const sums = (await db.execute({ sql: `SELECT product_id, COALESCE(SUM(delta),0) AS s FROM inventory_ledger WHERE product_id IN (${ids.map(() => '?').join(',')}) AND deleted = 0 GROUP BY product_id`, args: ids })).rows;
  const map = new Map((sums ?? []).map((r) => [String(r.product_id), Number(r.s ?? 0)]));
  let n = 0;
  for (const it of items) {
    if (svc.has(it.productId) || it.productId.startsWith('qt-')) continue;
    const variance = Math.trunc(Math.max(0, Math.floor(Number(it.countedStock)))) - Math.trunc(Number(map.get(it.productId) ?? 0));
    if (variance === 0) continue;
    const key = `adj-${it.productId}-${variance}`;
    await db.execute({ sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?, 'd1', ?, 'pending', ?, ?, 0) ON CONFLICT(id) DO NOTHING`,
      args: [key, it.productId, variance, 'ADJUST', refType, it.productId, key, '2026-03-01T10:00:00.000Z', '2026-03-01T10:00:00.000Z'] });
    n++;
  }
  return n;
}

async function recompute(pid) {
  await db.execute({ sql: `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id = $1 AND deleted = 0), stock) WHERE id = $1`, args: [pid] });
  return Number((await db.execute({ sql: `SELECT stock FROM products WHERE id = ?`, args: [pid] })).rows[0]?.stock);
}

try {
  await db.execute(`CREATE TABLE products (id TEXT PRIMARY KEY, category TEXT NOT NULL DEFAULT '', stock REAL NOT NULL DEFAULT 0)`);
  await db.execute(`CREATE TABLE inventory_ledger (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, delta REAL NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT 'ADJUST', ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL DEFAULT 'd1', idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`);
  await db.execute(`INSERT INTO products (id, category, stock) VALUES ('prodA', 'Goods', 10), ('qt-svc', 'Services', 999999), ('prodNew', 'Goods', 0)`);
  for (const [id, d] of [['L1', 6], ['L2', 4]]) {
    await db.execute({ sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, created_at, updated_at, deleted) VALUES (?,?,?, 'SEED', ?, ?, 'd1', ?, 'pending', ?, ?, 0)`,
      args: [id, 'prodA', d, 'heal', id, id, '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z'] });
  }

  // A: shrinkage −2 books and survives recompute.
  check('adjustment written for variance', (await adjust([{ productId: 'prodA', countedStock: 8 }], 'stocktake')) === 1, '');
  const dr = (await db.execute(`SELECT delta, reason, ref_type FROM inventory_ledger WHERE product_id = 'prodA' AND reason = 'ADJUST'`)).rows[0];
  check('shrinkage books −2 with audit reason', Number(dr?.delta) === -2 && dr?.ref_type === 'stocktake', JSON.stringify(dr));
  check('recompute preserves the count (8)', (await recompute('prodA')) === 8, '');
  // B: repeat count is a no-op.
  check('repeat count appends nothing', (await adjust([{ productId: 'prodA', countedStock: 8 }], 'stocktake')) === 0, '');
  const nA = Number((await db.execute(`SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = 'prodA' AND reason = 'ADJUST'`)).rows[0]?.n ?? -1);
  check('still exactly one ADJUST row', nA === 1, `rows=${nA}`);
  // C: service sentinel untouched.
  check('service skipped', (await adjust([{ productId: 'qt-svc', countedStock: 999999 }], 'stocktake')) === 0, '');
  const nS = Number((await db.execute(`SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = 'qt-svc'`)).rows[0]?.n ?? -1);
  check('no ledger row for services', nS === 0, `rows=${nS}`);
  // D: zero-ledger product becomes tracked at its count.
  check('new product tracked', (await adjust([{ productId: 'prodNew', countedStock: 3 }], 'manual-edit')) === 1, '');
  check('recompute yields 3', (await recompute('prodNew')) === 3, '');
  // E: over-count books positive variance.
  check('over-count adjusts', (await adjust([{ productId: 'prodA', countedStock: 11 }], 'stocktake')) === 1, '');
  check('recompute yields 11', (await recompute('prodA')) === 11, '');

  // F: batches track the ledger (verbatim batch-op shape from the adapter).
  await db.execute(`CREATE TABLE stock_batches (batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
    quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0), received_at TEXT NOT NULL,
    purchase_order_id TEXT, device_id TEXT NOT NULL DEFAULT 'local',
    idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'pending',
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0)`);
  for (const [bid, q, c, at] of [['FB-old', 4, 500, '2026-01-01T10:00:00.000Z'], ['FB-new', 6, 400, '2026-02-01T10:00:00.000Z']]) {
    await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?, 'PO-F', 'd1', ?, 'pending', 1, ?, ?, 0)`,
      args: [bid, 'prodB', q, c, at, `k-${bid}`, at, at] });
  }
  // Shrink 3 (counted 7 vs 10): newest-first consumes FB-new 6→3.
  {
    let need = 3;
    const live = (await db.execute(`SELECT batch_id, quantity_remaining FROM stock_batches WHERE product_id = 'prodB' AND quantity_remaining > 0 AND deleted = 0 AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW') ORDER BY received_at DESC, batch_id DESC`)).rows;
    for (const b of live) {
      if (need <= 0) break;
      const take = Math.min(Number(b.quantity_remaining), need);
      const upd = await db.execute({ sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?, version = version + 1 WHERE batch_id = ? AND quantity_remaining >= ? AND deleted = 0`, args: [take, String(b.batch_id), take] });
      if (Number(upd.rowsAffected) !== 1) continue;
      need -= take;
    }
    check('shrink consumes newest batch first', need === 0, `shortfall=${need}`);
    const qNew = Number((await db.execute(`SELECT quantity_remaining FROM stock_batches WHERE batch_id = 'FB-new'`)).rows[0]?.quantity_remaining ?? -1);
    const qOld = Number((await db.execute(`SELECT quantity_remaining FROM stock_batches WHERE batch_id = 'FB-old'`)).rows[0]?.quantity_remaining ?? -1);
    check('newest batch reduced 6→3, oldest untouched at 4', qNew === 3 && qOld === 4, `new=${qNew} old=${qOld}`);
    const batchSum = Number((await db.execute(`SELECT COALESCE(SUM(quantity_remaining),0) AS s FROM stock_batches WHERE product_id = 'prodB' AND deleted = 0`)).rows[0]?.s ?? -1);
    check('batches sum to counted 7 (no phantoms)', batchSum === 7, `sum=${batchSum}`);
  }
  // Gain 2 (counted 9 vs 7): one ADJUST batch at last-known cost.
  {
    const lk = (await db.execute(`SELECT unit_cost FROM stock_batches WHERE product_id = 'prodB' AND deleted = 0 AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW') ORDER BY received_at DESC, batch_id DESC LIMIT 1`)).rows;
    const unit = lk?.[0] ? Number(lk[0].unit_cost) : 0;
    await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES ($1, $2, $3, $4, $5, 'ADJUST', 'd1', $6, 'pending', 1, $5, $5, 0) ON CONFLICT(batch_id) DO NOTHING`,
      args: ['batch-adjust-op1-prodB', 'prodB', 2, unit, '2026-03-01T10:00:00.000Z', 'sb-batch-adjust-op1-prodB'] });
    const g = (await db.execute(`SELECT quantity_remaining, unit_cost, purchase_order_id FROM stock_batches WHERE batch_id = 'batch-adjust-op1-prodB'`)).rows[0];
    check('gain mints ADJUST batch (2 units @ last-known cost)', Number(g?.quantity_remaining) === 2 && Number(g?.unit_cost) === 400 && g?.purchase_order_id === 'ADJUST', JSON.stringify(g));
    // Re-import is a no-op (idempotent retry converges).
    await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES ($1, $2, $3, $4, $5, 'ADJUST', 'd1', $6, 'pending', 1, $5, $5, 0) ON CONFLICT(batch_id) DO NOTHING`,
      args: ['batch-adjust-op1-prodB', 'prodB', 2, unit, '2026-03-01T10:00:00.000Z', 'sb-batch-adjust-op1-prodB'] });
    const nB = Number((await db.execute(`SELECT COUNT(*) AS n FROM stock_batches WHERE batch_id = 'batch-adjust-op1-prodB'`)).rows[0]?.n ?? -1);
    check('retry converges (no twin batch)', nB === 1, `rows=${nB}`);
    const batchSum2 = Number((await db.execute(`SELECT COALESCE(SUM(quantity_remaining),0) AS s FROM stock_batches WHERE product_id = 'prodB' AND deleted = 0`)).rows[0]?.s ?? -1);
    check('batches sum to counted 9', batchSum2 === 9, `sum=${batchSum2}`);
  }
} finally { db.close(); try { rmSync(DB_FILE); } catch {} }

console.log(`STOCKTAKE SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);

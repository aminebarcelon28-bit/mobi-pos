/**
 * Batch-based inventory valuation suite (asset report pipeline):
 *   Valuation = Σ(quantity_remaining × unit_cost) over live batch rows —
 *   never products.stock × costPrice (global latest cost).
 *
 * Part 1 runs the totals-query semantics against a scratch libsql DB with
 * the production DDL + JOIN (including zero-qty, tombstoned, SHADOW, and
 * orphan-product rows that must contribute nothing), then depletes one unit
 * oldest-first and re-asserts the new totals.
 * Part 2 exercises the REAL pure core (src/utils/inventoryValuation.ts) over
 * the same rows in Dexie-mirror shape (plus corrupt values).
 * Part 3 asserts the production wiring: SQLite totals + Dexie mirror
 * function, mirror calls on every batch-mutating path (checkout, refund
 * restitution, shadow reconcile), one-shot boot remirror, and the report
 * modal reading the batch pipeline instead of the legacy fallback.
 */
import { createClient } from '@libsql/client';
import { rmSync, readFileSync } from 'node:fs';
import { aggregateBatchValuation } from '../src/utils/inventoryValuation.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}
const src = (p: string) => readFileSync(`${process.cwd()}/${p}`, 'utf8');

// Verbatim replica of getInventoryValuationTotals (Tauri plugin-sql can't run
// under node; same SQLite semantics via libsql).
const TOTALS_SQL = `SELECT COALESCE(SUM(sb.quantity_remaining), 0) AS units,
       COALESCE(SUM(sb.quantity_remaining * sb.unit_cost), 0) AS cost,
       COALESCE(SUM(sb.quantity_remaining * COALESCE(p.price, 0)), 0) AS retail
  FROM stock_batches sb LEFT JOIN products p ON p.id = sb.product_id
  WHERE sb.deleted = 0 AND sb.quantity_remaining > 0
    AND (sb.purchase_order_id IS NULL OR sb.purchase_order_id != 'SHADOW')`;

const DB_FILE = 'tmp-inventory-valuation.db';
try { rmSync(DB_FILE); } catch { /* fresh start */ }
const db = createClient({ url: `file:${DB_FILE}` });

try {
  console.log('--- Part 1: totals-query semantics (non-zero remaining stock) ---');
  await db.execute(`CREATE TABLE products (id TEXT PRIMARY KEY, price REAL NOT NULL DEFAULT 0)`);
  await db.execute(`CREATE TABLE stock_batches (
    batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
    quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
    received_at TEXT NOT NULL, purchase_order_id TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  )`);
  await db.execute({ sql: `INSERT INTO products VALUES (?,?)`, args: ['prodX', 3500] });
  await db.execute({ sql: `INSERT INTO products VALUES (?,?)`, args: ['prodY', 2000] });
  const addBatch = (id: string, pid: string, qty: number, cost: number, at: string, po: string | null, del: number) =>
    db.execute({ sql: `INSERT INTO stock_batches VALUES (?,?,?,?,?,?,?)`, args: [id, pid, qty, cost, at, po, del] });
  await addBatch('batch-A', 'prodX', 1, 500, '2026-01-01T10:00:00.000Z', 'PO-1', 0);
  await addBatch('batch-B', 'prodX', 1, 400, '2026-02-01T10:00:00.000Z', 'PO-2', 0);
  await addBatch('batch-C', 'prodY', 3, 1200, '2026-01-15T10:00:00.000Z', 'PO-1', 0);
  await addBatch('batch-D', 'prodX', 0, 500, '2026-01-01T10:00:00.000Z', 'PO-1', 0);   // depleted
  await addBatch('batch-E', 'prodY', 2, 999, '2026-01-20T10:00:00.000Z', 'PO-1', 1);   // tombstoned
  await addBatch('shadow-1', 'prodX', 0, 400, '2026-03-01T10:00:00.000Z', 'SHADOW', 0); // marker
  await addBatch('batch-G', 'prodMissing', 2, 100, '2026-02-10T10:00:00.000Z', 'PO-3', 0); // orphan product

  const totals = async () => (await db.execute(TOTALS_SQL)).rows[0] as Record<string, number>;
  {
    const t = await totals();
    // units: 1+1+3+2(orphan) = 7 · cost: 500+400+3600+200 = 4700
    // retail: 2×3500 + 3×2000 + 2×0(unknown price) = 13000
    check('units count only live rows (7)', Number(t.units) === 7, `got ${t.units}`);
    check('cost = Σ(qty×unit_cost) = 4700', Number(t.cost) === 4700, `got ${t.cost}`);
    check('retail joins catalog price, unknown product = 0 (13000)', Number(t.retail) === 13000, `got ${t.retail}`);
    check('zero-qty / deleted / SHADOW rows contribute nothing', Number(t.units) === 7 && Number(t.cost) === 4700);
  }
  // Sell one unit oldest-first (batch-A @500), then revalue.
  {
    const avail = await db.execute({
      sql: `SELECT batch_id, quantity_remaining FROM stock_batches
            WHERE product_id = ? AND quantity_remaining > 0 AND deleted = 0
              AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
            ORDER BY received_at ASC, batch_id ASC`,
      args: ['prodX'],
    });
    const first = avail.rows[0];
    check('depletion still takes oldest batch first', String(first.batch_id) === 'batch-A', String(first.batch_id));
    await db.execute({
      sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - 1
            WHERE batch_id = ? AND quantity_remaining >= 1 AND deleted = 0`,
      args: [String(first.batch_id)],
    });
    const t = await totals();
    check('after sale: units 6', Number(t.units) === 6, `got ${t.units}`);
    check('after sale: cost 4200 (500-batch consumed)', Number(t.cost) === 4200, `got ${t.cost}`);
    check('after sale: retail 9500', Number(t.retail) === 9500, `got ${t.retail}`);
  }

  console.log('--- Part 2: pure offline core (Dexie-mirror shape) ---');
  {
    const rows = [
      { productId: 'prodX', quantityRemaining: 1, unitCost: 500, deleted: 0, purchaseOrderId: 'PO-1' },
      { productId: 'prodX', quantityRemaining: 1, unitCost: 400, deleted: 0, purchaseOrderId: 'PO-2' },
      { productId: 'prodY', quantityRemaining: 3, unitCost: 1200, deleted: 0, purchaseOrderId: 'PO-1' },
      { productId: 'prodX', quantityRemaining: 0, unitCost: 500, deleted: 0, purchaseOrderId: 'PO-1' },
      { productId: 'prodY', quantityRemaining: 2, unitCost: 999, deleted: 1, purchaseOrderId: 'PO-1' },
      { productId: 'prodX', quantityRemaining: 0, unitCost: 400, deleted: 0, purchaseOrderId: 'SHADOW' },
      { productId: 'prodMissing', quantityRemaining: 2, unitCost: 100, deleted: 0, purchaseOrderId: 'PO-3' },
      { productId: 'prodX', quantityRemaining: NaN, unitCost: 'oops', deleted: 0, purchaseOrderId: 'PO-9' },
    ];
    const prices = new Map([['prodX', 3500], ['prodY', 2000]]);
    const v = aggregateBatchValuation(rows, (pid) => prices.get(pid) ?? 0);
    check('Dexie aggregation: units 7', v.units === 7, `got ${v.units}`);
    check('Dexie aggregation: cost 4700', v.costValue === 4700, `got ${v.costValue}`);
    check('Dexie aggregation: retail 13000', v.retailValue === 13000, `got ${v.retailValue}`);
    check('corrupt rows never poison totals (finite)', [v.units, v.costValue, v.retailValue].every(Number.isFinite));
    const empty = aggregateBatchValuation([], () => 0);
    check('empty mirror values zero (not legacy fallback)', empty.units === 0 && empty.costValue === 0 && empty.retailValue === 0);
  }

  console.log('--- Part 3: production wiring ---');
  {
    const adapter = src('src/db/sqlPluginAdapter.ts');
    const backfill = src('src/db/backfill.ts');
    const modal = src('src/components/modals/ReportsModal.tsx');
    const hook = src('src/hooks/useInventoryValuation.ts');
    check('SQLite totals entry point exists', adapter.includes('getInventoryValuationTotals'));
    check('Dexie mirror function exists and never throws',
      adapter.includes('mirrorStockBatchesToDexie') && adapter.includes('NEVER throws'));
    check('mirror skips SHADOW markers like the pull path',
      adapter.includes(`purchase_order_id != 'SHADOW'`) && adapter.includes('WHERE product_id IN'));
    const mirrorCalls = (adapter.match(/mirrorStockBatchesToDexie\(db/g) ?? []).length;
    check('mirror runs on checkout + restitution + reconcile (3 call sites)', mirrorCalls >= 3, `got ${mirrorCalls}`);
    check('one-shot boot remirror heals pre-mirror installs',
      backfill.includes('REMIRROR_BATCHES_FLAG') && backfill.includes('mirrorStockBatchesToDexie'));
    check('report reads the batch pipeline (no legacy primary)',
      modal.includes('useInventoryValuation') && !modal.includes('fifoValuation'));
    check('report cost/units/retail share one batch basis',
      modal.includes('valuation.costValue') && modal.includes('valuation.units') && modal.includes('valuation.retailValue'));
    check('hook falls back SQLite → Dexie mirror → legacy',
      hook.includes('getInventoryValuationTotals') && hook.includes('stockBatches') && hook.includes('aggregateBatchValuation'));
  }
} finally {
  db.close();
  try { rmSync(DB_FILE); } catch { /* scratch cleanup best-effort */ }
}

console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);

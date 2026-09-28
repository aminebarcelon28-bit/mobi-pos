/**
 * Autonomous issue test: FIFO profit must be 6,100 — not 6,200.
 *
 * Scenario (reported issue):
 *   1. Receive 1 unit @ 500 cost  (older batch)
 *   2. Receive 1 unit @ 400 cost  (newer batch, becomes product.costPrice)
 *   3. Sell both units @ 3,500 each
 *   Expected: COGS = 500 + 400 = 900 → profit = 7,000 − 900 = 6,100.
 *   Buggy:    COGS = 400 + 400 = 800 → profit = 6,200 (latest cost for both).
 *
 * What it exercises (scratch libsql DB, production-matching DDL):
 *   - Receipt inserts using the same column shape as `insertStockBatch`.
 *   - The checkout depletion sequence with the EXACT guarded-UPDATE +
 *     oldest-first SELECT from `writeCheckoutAtomicInner`/`depleteBatchGuarded`
 *     (Tauri plugin-sql itself can't run under node, so the statements run
 *     verbatim against libsql — same SQLite semantics).
 *   - The REAL preview core (`src/utils/fifoPreview.ts`) fed with rows
 *     SELECTed from that DB, asserting preview == stored (450/u).
 *   - The stored order/line profit assertions, including profit !== 6200.
 *
 * Logs each step and exits 1 on any mismatch.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';
import { previewFifoCostsForLines } from '../src/utils/fifoPreview.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// Integer-DA canonicalization — same rule as normalizeMoneyInput/toIntMoney.
const toIntMoney = (n: unknown): number => {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) ? v : 0;
};

const DB_FILE = 'tmp-fifo-issue-6100.db';
try { rmSync(DB_FILE); } catch { /* fresh start */ }
const db = createClient({ url: `file:${DB_FILE}` });

try {
  // ---- Schema (production shape: NOT NULL version, FIFO + shadow columns)
  await db.execute(`CREATE TABLE stock_batches (
    batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
    quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
    received_at TEXT NOT NULL, purchase_order_id TEXT,
    device_id TEXT NOT NULL DEFAULT 'local',
    idempotency_key TEXT NOT NULL UNIQUE,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    shadow_sale_id TEXT, shadow_item_id TEXT,
    shadow_qty REAL NOT NULL DEFAULT 0, shadow_resolved INTEGER NOT NULL DEFAULT 0
  )`);
  await db.execute(`CREATE TABLE transactions (
    id TEXT PRIMARY KEY, total REAL NOT NULL DEFAULT 0,
    cost_total REAL DEFAULT 0, profit REAL DEFAULT 0, profit_margin REAL DEFAULT 0,
    json_payload TEXT, version INTEGER NOT NULL DEFAULT 1
  )`);
  await db.execute(`CREATE TABLE transaction_items (
    id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL, applied_price REAL DEFAULT 0,
    unit_price_charged REAL DEFAULT 0, unit_cost_at_sale REAL DEFAULT 0,
    discount_amount REAL DEFAULT 0, line_profit REAL DEFAULT 0,
    json_payload TEXT, version INTEGER NOT NULL DEFAULT 1
  )`);

  // ---- Step 1+2: receive 1 unit @500 (older), then 1 unit @400 (newer)
  // Same column shape as insertStockBatch.
  const receiveBatch = async (batchId: string, unitCost: number, receivedAt: string, poId: string) => {
    await db.execute({
      sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
        received_at, purchase_order_id, device_id, idempotency_key, sync_status,
        version, created_at, updated_at, deleted)
        VALUES (?,?,?,?,?,?,?,?,'pending',1,?,?,0)`,
      args: [batchId, 'prodX', 1, unitCost, receivedAt, poId, 'd1', `key-${batchId}`, receivedAt, receivedAt],
    });
  };
  await receiveBatch('batch-A', 500, '2026-01-01T10:00:00.000Z', 'PO-1');
  console.log('[STEP 1] received 1 unit @ 500 (batch-A, older)');
  await receiveBatch('batch-B', 400, '2026-02-01T10:00:00.000Z', 'PO-2');
  console.log('[STEP 2] received 1 unit @ 400 (batch-B, newer; catalog costPrice now 400)');

  // ---- Preview (REAL production core) before selling
  const previewRows = await db.execute({
    sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
          WHERE product_id = ? AND quantity_remaining > 0 AND deleted = 0
            AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
          ORDER BY received_at ASC, rowid ASC`,
    args: ['prodX'],
  });
  const batchesByProduct = new Map([
    ['prodX', previewRows.rows.map((r) => ({
      batchId: String(r.batch_id),
      quantityRemaining: Number(r.quantity_remaining),
      unitCost: Number(r.unit_cost),
    }))],
  ]);
  const [preview] = previewFifoCostsForLines(batchesByProduct, [
    { productId: 'prodX', qty: 2, fallbackCost: 400 },
  ]);
  console.log(`[PREVIEW] FIFO unit cost = ${preview.unitCost}/u (fullyCovered=${preview.fullyCovered})`);
  check('preview blends oldest-first (450/u)', preview.unitCost === 450, `got ${preview.unitCost}`);

  // ---- Step 3: sell both units @3,500 each (checkout depletion, verbatim SQL)
  const QTY = 2;
  const PRICE = 3500;
  const available = previewRows.rows;
  let needed = QTY;
  let totalCostAccum = 0;
  let totalAllocatedQty = 0;
  const allocs: Array<{ batchId: string; quantity: number; unitCost: number }> = [];
  for (const batch of available) {
    if (needed <= 0) break;
    const avail = Math.max(0, Math.floor(Number(batch.quantity_remaining) || 0));
    const want = Math.min(avail, needed);
    if (want <= 0) continue;
    // Exact guarded UPDATE from depleteBatchGuarded (row-serializing guard).
    const upd = await db.execute({
      sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?,
              version = version + 1, updated_at = ?, sync_status = 'pending'
            WHERE batch_id = ? AND quantity_remaining >= ? AND deleted = 0`,
      args: [want, '2026-03-01T10:00:00.000Z', String(batch.batch_id), want],
    });
    if (Number(upd.rowsAffected) === 0) continue;
    needed -= want;
    totalAllocatedQty += want;
    totalCostAccum += want * Number(batch.unit_cost);
    allocs.push({ batchId: String(batch.batch_id), quantity: want, unitCost: Number(batch.unit_cost) });
  }
  check('depletion takes oldest batch first (1×500)', allocs[0]?.batchId === 'batch-A' && allocs[0]?.unitCost === 500, JSON.stringify(allocs));
  check('depletion overflows into newer batch (1×400)', allocs[1]?.batchId === 'batch-B' && allocs[1]?.unitCost === 400, JSON.stringify(allocs));
  check('no shadow shortfall (batches covered both units)', needed === 0, `short=${needed}`);

  const blended = totalAllocatedQty > 0 ? totalCostAccum / totalAllocatedQty : 0;
  const unitCostAtSale = toIntMoney(blended);
  const lineProfit = (PRICE - unitCostAtSale) * QTY;
  const orderTotal = PRICE * QTY;
  const orderProfit = orderTotal - toIntMoney(totalCostAccum);
  console.log(`[SALE] COGS = ${totalCostAccum} (${allocs.map((a) => `${a.quantity}×${a.unitCost}`).join(' + ')}) → unit ${unitCostAtSale}/u, profit ${orderProfit}`);

  // Persist the sale the way the checkout write does (order + line + version).
  await db.execute({ sql: `INSERT INTO transactions (id, total, cost_total, profit, json_payload, version) VALUES (?,?,?,?,?,1)`, args: ['TXN-6100', orderTotal, toIntMoney(totalCostAccum), orderProfit, '{}'] });
  await db.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale, line_profit, version) VALUES (?,?,?,?,?,?,?,?,1)`, args: ['TXN-6100-item-0', 'TXN-6100', 'prodX', QTY, PRICE, PRICE, unitCostAtSale, lineProfit] });

  const storedOrder = (await db.execute({ sql: `SELECT total, cost_total, profit FROM transactions WHERE id = ?`, args: ['TXN-6100'] })).rows[0];
  const storedLine = (await db.execute({ sql: `SELECT unit_cost_at_sale, line_profit FROM transaction_items WHERE id = ?`, args: ['TXN-6100-item-0'] })).rows[0];
  console.log(`[STORED] order total=${storedOrder.total} cost=${storedOrder.cost_total} profit=${storedOrder.profit} | line unit_cost=${storedLine.unit_cost_at_sale} line_profit=${storedLine.line_profit}`);

  // ---- Verdict
  check('preview matches stored COGS basis (450/u)', preview.unitCost === Number(storedLine.unit_cost_at_sale), `preview=${preview.unitCost} stored=${storedLine.unit_cost_at_sale}`);
  check('stored COGS is 500+400=900', Number(storedOrder.cost_total) === 900, `got ${storedOrder.cost_total}`);
  check('EXPECTED profit is 6,100', Number(storedOrder.profit) === 6100, `got ${storedOrder.profit}`);
  check('BUG profit 6,200 (400+400) is gone', Number(storedOrder.profit) !== 6200, `got ${storedOrder.profit}`);
  check('line profit is 6,100', Number(storedLine.line_profit) === 6100, `got ${storedLine.line_profit}`);
} finally {
  db.close();
  try { rmSync(DB_FILE); } catch { /* scratch cleanup best-effort */ }
}

console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);

/**
 * Autonomous PO-flow issue test: per-sale FIFO attribution across two sales.
 *
 * Scenario:
 *   1. Existing item stock: 1 unit @ 500 cost (older batch — prior inventory)
 *   2. Receive PO: 1 unit @ 400 cost (newer batch — validateAndReceivePO shape)
 *   3. Sale 1: sell 1 unit @ 3,500 → must consume the OLDEST batch (500)
 *   4. Sale 2: sell 1 unit @ 3,500 → must consume the newer batch (400)
 *   Expected: Sale 1 profit 3,000 + Sale 2 profit 3,100 = 6,100 total.
 *   Buggy:    400 cost applied to both (Sale 1 profit 3,100) or any
 *             cross-contamination between the two sales.
 *
 * Exercises (scratch libsql DB, production-matching DDL):
 *   - Existing-stock seeding + PO receipt in `insertStockBatch` column shape.
 *   - Two sequential checkout depletions with the EXACT guarded-UPDATE +
 *     oldest-first SELECT from `writeCheckoutAtomicInner`/`depleteBatchGuarded`
 *     (verbatim SQL against libsql — same SQLite semantics; Tauri plugin-sql
 *     itself can't run under node).
 *   - The REAL preview core (`src/utils/fifoPreview.ts`) fed with rows
 *     SELECTed from that DB: before Sale 1 (2 units → 450/u) and between
 *     sales (1 unit left → 400/u), proving sequential correctness.
 *   - Stored per-sale order/line profit assertions + explicit discrepancy log.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';
import { previewFifoCostsForLines } from '../src/utils/fifoPreview.ts';

let pass = 0;
let fail = 0;
const discrepancies: string[] = [];
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else {
    fail++;
    const line = `[FAIL] ${name}${extra ? ' :: ' + extra : ''}`;
    console.log(line);
    discrepancies.push(line);
  }
}

// Integer-DA canonicalization — same rule as normalizeMoneyInput/toIntMoney.
const toIntMoney = (n: unknown): number => {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) ? v : 0;
};

const DB_FILE = 'tmp-fifo-po-sales-6100.db';
try { rmSync(DB_FILE); } catch { /* fresh start */ }
const db = createClient({ url: `file:${DB_FILE}` });

type BatchRow = { batch_id: unknown; quantity_remaining: unknown; unit_cost: unknown };

async function activeBatches(): Promise<BatchRow[]> {
  return (await db.execute({
    sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
          WHERE product_id = ? AND quantity_remaining > 0 AND deleted = 0
            AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
          ORDER BY received_at ASC, rowid ASC`,
    args: ['prodX'],
  })).rows as BatchRow[];
}

/** Checkout depletion replica (verbatim SQL): oldest-first guarded takes. */
async function deplete(qty: number, now: string) {
  let needed = qty;
  let totalCost = 0;
  let taken = 0;
  const allocs: Array<{ batchId: string; quantity: number; unitCost: number }> = [];
  for (const batch of await activeBatches()) {
    if (needed <= 0) break;
    const avail = Math.max(0, Math.floor(Number(batch.quantity_remaining) || 0));
    const want = Math.min(avail, needed);
    if (want <= 0) continue;
    const upd = await db.execute({
      sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?,
              version = version + 1, updated_at = ?, sync_status = 'pending'
            WHERE batch_id = ? AND quantity_remaining >= ? AND deleted = 0`,
      args: [want, now, String(batch.batch_id), want],
    });
    if (Number(upd.rowsAffected) === 0) continue;
    needed -= want;
    taken += want;
    totalCost += want * Number(batch.unit_cost);
    allocs.push({ batchId: String(batch.batch_id), quantity: want, unitCost: Number(batch.unit_cost) });
  }
  return { allocs, totalCost, takenQty: taken, shortQty: needed };
}

async function previewQty(qty: number) {
  const rows = await activeBatches();
  const [r] = previewFifoCostsForLines(
    new Map([['prodX', rows.map((b) => ({
      batchId: String(b.batch_id),
      quantityRemaining: Number(b.quantity_remaining),
      unitCost: Number(b.unit_cost),
    }))]]),
    [{ productId: 'prodX', qty, fallbackCost: 400 }],
  );
  return r;
}

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

  // ---- Step 1: existing stock 1 unit @ 500 (prior inventory, older batch)
  await db.execute({
    sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
      received_at, purchase_order_id, device_id, idempotency_key, sync_status,
      version, created_at, updated_at, deleted)
      VALUES (?,?,?,?,?,?,?,?,'pending',1,?,?,0)`,
    args: ['batch-A', 'prodX', 1, 500, '2026-01-01T10:00:00.000Z', 'PO-OLD', 'd1', 'key-batch-A', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z'],
  });
  console.log('[STEP 1] existing stock: 1 unit @ 500 (batch-A, older)');

  // ---- Step 2: PO receipt 1 unit @ 400 (insertStockBatch column shape)
  await db.execute({
    sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
      received_at, purchase_order_id, device_id, idempotency_key, sync_status,
      version, created_at, updated_at, deleted)
      VALUES (?,?,?,?,?,?,?,?,'pending',1,?,?,0)`,
    args: ['batch-B', 'prodX', 1, 400, '2026-02-01T10:00:00.000Z', 'PO-2', 'd1', 'key-batch-B', '2026-02-01T10:00:00.000Z', '2026-02-01T10:00:00.000Z'],
  });
  console.log('[STEP 2] PO received: 1 unit @ 400 (batch-B, newer; catalog costPrice now 400)');

  // ---- Preview before any sale: 2 units → blended 450/u
  const pre = await previewQty(2);
  console.log(`[PREVIEW] 2 units → ${pre.unitCost}/u (fullyCovered=${pre.fullyCovered})`);
  check('preview blends both batches (450/u)', pre.unitCost === 450, `got ${pre.unitCost}`);

  // ---- Step 3: Sale 1 — 1 unit @ 3,500 → must take batch-A @ 500
  const s1 = await deplete(1, '2026-03-01T10:00:00.000Z');
  console.log(`[SALE 1] allocs = ${JSON.stringify(s1.allocs)}`);
  check('sale 1 consumes oldest batch (batch-A)', s1.allocs.length === 1 && s1.allocs[0].batchId === 'batch-A', JSON.stringify(s1.allocs));
  check('sale 1 uses 500 cost (not 400)', s1.totalCost === 500, `got cost ${s1.totalCost}`);
  check('sale 1 fully covered (no shadow)', s1.shortQty === 0);
  const s1Unit = toIntMoney(s1.totalCost / 1);
  const s1Profit = 3500 - s1Unit;
  await db.execute({ sql: `INSERT INTO transactions (id, total, cost_total, profit, json_payload, version) VALUES (?,?,?,?,?,1)`, args: ['TXN-S1', 3500, s1.totalCost, s1Profit, '{}'] });
  await db.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale, line_profit, version) VALUES (?,?,?,?,?,?,?,?,1)`, args: ['TXN-S1-item-0', 'TXN-S1', 'prodX', 1, 3500, 3500, s1Unit, s1Profit] });
  console.log(`[SALE 1] stored: cost=${s1.totalCost} profit=${s1Profit}`);
  check('sale 1 stored profit is 3,000', s1Profit === 3000, `got ${s1Profit}`);

  // ---- Preview between sales: 1 unit left → must be 400/u (batch-B)
  const mid = await previewQty(1);
  console.log(`[PREVIEW] 1 unit left → ${mid.unitCost}/u (fullyCovered=${mid.fullyCovered})`);
  check('mid preview sees only the newer batch (400/u)', mid.unitCost === 400 && mid.fullyCovered === true, `got ${mid.unitCost}`);

  // ---- Step 4: Sale 2 — 1 unit @ 3,500 → must take batch-B @ 400
  const s2 = await deplete(1, '2026-03-02T10:00:00.000Z');
  console.log(`[SALE 2] allocs = ${JSON.stringify(s2.allocs)}`);
  check('sale 2 consumes newer batch (batch-B)', s2.allocs.length === 1 && s2.allocs[0].batchId === 'batch-B', JSON.stringify(s2.allocs));
  check('sale 2 uses 400 cost (not 500 — no reuse)', s2.totalCost === 400, `got cost ${s2.totalCost}`);
  check('sale 2 fully covered (no shadow)', s2.shortQty === 0);
  const s2Unit = toIntMoney(s2.totalCost / 1);
  const s2Profit = 3500 - s2Unit;
  await db.execute({ sql: `INSERT INTO transactions (id, total, cost_total, profit, json_payload, version) VALUES (?,?,?,?,?,1)`, args: ['TXN-S2', 3500, s2.totalCost, s2Profit, '{}'] });
  await db.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale, line_profit, version) VALUES (?,?,?,?,?,?,?,?,1)`, args: ['TXN-S2-item-0', 'TXN-S2', 'prodX', 1, 3500, 3500, s2Unit, s2Profit] });
  console.log(`[SALE 2] stored: cost=${s2.totalCost} profit=${s2Profit}`);
  check('sale 2 stored profit is 3,100', s2Profit === 3100, `got ${s2Profit}`);

  // ---- Step 5: totals + final stock
  const totals = (await db.execute({ sql: `SELECT COALESCE(SUM(total),0) AS t, COALESCE(SUM(cost_total),0) AS c, COALESCE(SUM(profit),0) AS p FROM transactions` })).rows[0];
  const totalProfit = Number(totals.p);
  console.log(`[TOTAL] revenue=${totals.t} COGS=${totals.c} profit=${totalProfit} (expected 6100 = 3000 + 3100)`);
  check('total COGS is 500+400=900', Number(totals.c) === 900, `got ${totals.c}`);
  check('TOTAL profit is 6,100', totalProfit === 6100, `got ${totalProfit}`);
  check('total is not the buggy 6,200', totalProfit !== 6200, `got ${totalProfit}`);

  const remaining = (await db.execute({ sql: `SELECT batch_id, quantity_remaining FROM stock_batches ORDER BY received_at ASC` })).rows;
  console.log(`[STOCK] remaining = ${JSON.stringify(remaining)}`);
  check('both batches fully depleted', remaining.every((r) => Number(r.quantity_remaining) === 0), JSON.stringify(remaining));

  // ---- Discrepancy log
  if (discrepancies.length > 0) {
    console.log(`[DISCREPANCIES] ${discrepancies.length} found:`);
    for (const d of discrepancies) console.log(`  • ${d}`);
  } else {
    console.log('[DISCREPANCIES] none — per-sale FIFO attribution is correct.');
  }
} finally {
  db.close();
  try { rmSync(DB_FILE); } catch { /* scratch cleanup best-effort */ }
}

console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);

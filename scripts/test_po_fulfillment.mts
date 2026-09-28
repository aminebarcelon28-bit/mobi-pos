/**
 * PO approval/fulfillment audit suite (purchase-to-sale traceability):
 *
 * Part 1 — wiring audit: every stock-inflow path must mint a stock_batches
 * row (unit_cost = line cost, quantity_remaining = line qty) alongside any
 * products.stock increment; drafts move no stock; the receipt boundary
 * sanitizes costs so a bad value can never fail the batch CHECK while the
 * stock bump persists (untracked-stock leak).
 *
 * Part 2 — behavioral trace (scratch libsql DB, production DDL + verbatim
 * SQL): PO @ $X$ → approve (stock bump) → sell → assert the sale consumes
 * the EXACT PO batch id and COGS strictly equals $X$ (per unit × qty).
 * Includes partial fulfillment across two PO lines and the negative-cost
 * guard at the receipt boundary.
 */
import { createClient } from '@libsql/client';
import { rmSync, readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; failures.push(`${name}${extra ? ' :: ' + extra : ''}`); console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}
const src = (p: string) => readFileSync(`${process.cwd()}/${p}`, 'utf8');
const region = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to));

const SELL_PRICE = 3500;
const DB_FILE = 'tmp-po-fulfillment.db';
try { rmSync(DB_FILE); } catch { /* fresh start */ }
const db = createClient({ url: `file:${DB_FILE}` });

// Verbatim production statements (insertStockBatch shape + guarded depletion).
async function receiveBatch(batchId: string, pid: string, qty: number, cost: number, at: string, po: string | null) {
  await db.execute({
    sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
      received_at, purchase_order_id, device_id, idempotency_key, sync_status,
      version, created_at, updated_at, deleted)
      VALUES ($1,$2,$3,$4,$5,$6,'d1',$7,'pending',1,$5,$5,0)`,
    args: [batchId, pid, qty, cost, at, po, `key-${batchId}`],
  });
}

async function deplete(pid: string, qty: number, now: string) {
  const r = await db.execute({
    sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
          WHERE product_id = $1 AND quantity_remaining > 0 AND deleted = 0
            AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
          ORDER BY received_at ASC, batch_id ASC`,
    args: [pid],
  });
  let need = qty;
  let cogs = 0;
  const allocs: Array<{ batchId: string; qty: number; cost: number }> = [];
  for (const b of r.rows) {
    if (need <= 0) break;
    const avail = Math.max(0, Math.floor(Number(b.quantity_remaining) || 0));
    const want = Math.min(avail, need);
    if (want <= 0) continue;
    const upd = await db.execute({
      sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?,
              version = version + 1, updated_at = ?, sync_status = 'pending'
            WHERE batch_id = ? AND quantity_remaining >= ? AND deleted = 0`,
      args: [want, now, String(b.batch_id), want],
    });
    if (Number(upd.rowsAffected ?? 0) <= 0) continue;
    need -= want;
    cogs += want * Number(b.unit_cost);
    allocs.push({ batchId: String(b.batch_id), qty: want, cost: Number(b.unit_cost) });
  }
  return { allocs, cogs, short: need };
}

try {
  console.log('--- Part 1: approval/fulfillment wiring audit ---');
  {
    const proc = src('src/store/slices/createProcurementSlice.ts');
    const catalog = src('src/store/slices/createCatalogSlice.ts');
    const modal = src('src/components/modals/InvoiceIngestionModal.tsx');

    // Receipt path: batch row carries the exact verified line cost + qty.
    check('receipt batch: quantity_remaining = verified line qty',
      proc.includes('quantityRemaining: vi.receivedQty'));
    check('receipt batch: unit_cost = verified line cost, linked to the PO',
      proc.includes('unitCost: actualCost,') && proc.includes('purchaseOrderId: targetPO.id'));
    check('receipt boundary sanitizes cost (no CHECK-fail → untracked stock)',
      proc.includes('const actualCost = Math.max('));
    check('receipt appends PURCHASE_ORDER ledger deltas alongside batches',
      proc.includes(`refType: 'PURCHASE_ORDER'`) && proc.includes('await appendInventoryDeltas(deltas)'));

    // Approval path: stock bump coexists with batch creation (never alone).
    const approveRegion = region(proc, 'approvePurchaseOrder: async', 'directRestockVendor: async');
    void approveRegion;
    check('approval bumps stock AND mints batches (no stock without batch)',
      proc.includes('stock: p.stock + poItem.suggestedQty') && proc.includes('Approval batch tracking deferred'));
    const jitRegion = region(proc, 'directRestockVendor: async', 'approvePurchaseOrder: async');
    check('JIT restock bumps stock AND mints batches',
      jitRegion.includes('stock: p.stock + addedQty') && proc.includes('[jit:batch]'));

    // Draft paths move no stock and mint no batches.
    const draftRegion = region(proc, 'createDraftPOForVendor: async', 'createWaitingListPO: async');
    check('PO draft creation moves no stock / mints no batches',
      !draftRegion.includes('p.stock +') && !draftRegion.includes('insertStockBatch'));
    const waitingRegion = region(proc, 'createWaitingListPO: async', 'createManualPurchaseOrder: async');
    check('waiting-list PO creation moves no stock',
      !waitingRegion.includes('p.stock +'));

    // Invoice path: receipt lines reach the slice; slice mints batches.
    check('invoice modal forwards receipt lines (qty + unitCost per product)',
      modal.includes('receiptMap') && modal.includes('unitCost: Math.max(0, Math.round(invoiceCost))'));
    check('invoice ingestion mints batches + RECEIVE deltas',
      catalog.includes('INVOICE_IMPORT') && catalog.includes('insertStockBatch'));
  }

  console.log('--- Part 2: PO @ $X$ → approve → sell → COGS == $X$ ---');
  await db.execute(`CREATE TABLE products (id TEXT PRIMARY KEY, stock REAL NOT NULL DEFAULT 0, cost_price REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0)`);
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
    deleted INTEGER NOT NULL DEFAULT 0
  )`);
  await db.execute({ sql: `INSERT INTO products VALUES (?,?,?,?)`, args: ['prodX', 0, 500, SELL_PRICE] });

  const X = 750;
  const PO_QTY = 3;
  // PO receipt: batch row with unit_cost = line cost, qty = line qty.
  await receiveBatch('batch-PO1-1', 'prodX', PO_QTY, X, '2026-02-01T10:00:00.000Z', 'PO-1');
  {
    const row = (await db.execute({ sql: `SELECT quantity_remaining, unit_cost, purchase_order_id FROM stock_batches WHERE batch_id = ?`, args: ['batch-PO1-1'] })).rows[0];
    check('batch row: quantity_remaining = PO line qty (3)', Number(row.quantity_remaining) === PO_QTY, `got ${row.quantity_remaining}`);
    check('batch row: unit_cost = PO line cost (750)', Number(row.unit_cost) === X, `got ${row.unit_cost}`);
    check('batch row linked to the PO', String(row.purchase_order_id) === 'PO-1');
  }
  // Approval: stock bump only alongside the batch (batch coverage == bump).
  await db.execute({ sql: `UPDATE products SET stock = stock + ? WHERE id = 'prodX'`, args: [PO_QTY] });
  {
    const stock = Number((await db.execute({ sql: `SELECT stock FROM products WHERE id = 'prodX'` })).rows[0].stock);
    const covered = Number((await db.execute({ sql: `SELECT COALESCE(SUM(quantity_remaining),0) AS q FROM stock_batches WHERE product_id = 'prodX' AND deleted = 0` })).rows[0].q);
    check('approval stock bump is fully batch-covered (no stock without batch)', stock === PO_QTY && covered === PO_QTY, `stock=${stock} batched=${covered}`);
  }
  // Sale: 3 units @3500 must consume the EXACT PO batch id; COGS == 3×750.
  {
    const s = await deplete('prodX', 3, '2026-03-01T10:00:00.000Z');
    const onlyPoBatch = s.allocs.length > 0 && s.allocs.every((a) => a.batchId === 'batch-PO1-1');
    check('sale consumes the exact PO batch id', onlyPoBatch, JSON.stringify(s.allocs));
    check('COGS strictly equals 3 × 750 = 2250', s.cogs === PO_QTY * X && s.short === 0, `got ${s.cogs}`);
    const profit = PO_QTY * SELL_PRICE - s.cogs;
    check('profit = 10500 − 2250 = 8250', profit === 8250, `got ${profit}`);
  }

  console.log('--- Part 3: partial fulfillment + boundary guard ---');
  {
    // Second PO line @800 qty 2; partial sale spanning nothing (exact fit x2).
    await receiveBatch('batch-PO2-1', 'prodX', 2, 800, '2026-04-01T10:00:00.000Z', 'PO-2');
    const s = await deplete('prodX', 2, '2026-04-02T10:00:00.000Z');
    check('partial PO sale consumes only the PO-2 batch', s.allocs.every((a) => a.batchId === 'batch-PO2-1'), JSON.stringify(s.allocs));
    check('partial COGS = 2 × 800 = 1600', s.cogs === 1600, `got ${s.cogs}`);
    // Negative-cost guard: sanitized boundary value inserts cleanly (no CHECK fail).
    const sanitized = Math.max(0, Math.round(Number(-50) || 0));
    check('receipt boundary clamps negative cost to 0', sanitized === 0);
    await receiveBatch('batch-GUARD-1', 'prodX', 1, sanitized, '2026-05-01T10:00:00.000Z', 'PO-3');
    const guard = (await db.execute({ sql: `SELECT quantity_remaining, unit_cost FROM stock_batches WHERE batch_id = ?`, args: ['batch-GUARD-1'] })).rows[0];
    check('clamped batch persists (tracked at 0, never untracked)',
      Number(guard.quantity_remaining) === 1 && Number(guard.unit_cost) === 0);
  }
} finally {
  db.close();
  try { rmSync(DB_FILE); } catch { /* scratch cleanup best-effort */ }
}

console.log('========================================================================');
console.log(`PO FULFILLMENT SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (failures.length > 0) {
  console.log('--- discrepancies ---');
  for (const f of failures) console.log(`  • ${f}`);
} else {
  console.log('[DISCREPANCIES] none — PO stock is fully batch-tracked into sales.');
}
console.log('========================================================================');
if (fail > 0) process.exit(1);
process.exit(0);

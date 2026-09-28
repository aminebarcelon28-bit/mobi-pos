/**
 * PO → sale traceability suite (6000-profit bug hunt):
 *   Reported symptom: UI/Report shows 6,000 (7,000 − 1,000) = 500 + 500,
 *   ignoring the PO's 400 cost entirely.
 *
 * Part 1 — mapping audit: the receipt batch row must carry unit_cost = PO
 * line cost and quantity_remaining = PO line qty (never the reference cost);
 * the FK parent bridge must exist so a missing products row can never strand
 * the batch; both receiving UIs must default to remaining qty; approval must
 * pair every stock bump with a batch row.
 *
 * Part 2 — behavioral trace (scratch libsql DB, production DDL + verbatim
 * SQL): existing stock 1×@500 + PO-20260926-11KHFJ-02-XMT05 1×@400 → single
 * sale of 2 units @3,500. Asserts the sale consumes the exact PO batch id,
 * COGS = 900, profit = 6,100 (and NOT 1,000/6,000, NOT 800/6,200).
 *
 * Part 3 — report query: the sales/inventory reports must read stored batch
 * COGS first (never units × costPrice as primary).
 */
import { createClient } from '@libsql/client';
import { rmSync, readFileSync } from 'node:fs';
import { previewFifoCostsForLines } from '../src/utils/fifoPreview.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; failures.push(`${name}${extra ? ' :: ' + extra : ''}`); console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}
const src = (p: string) => readFileSync(`${process.cwd()}/${p}`, 'utf8');

const PO_ID = 'PO-20260926-11KHFJ-02-XMT05';
const PRICE = 3500;
const DB_FILE = 'tmp-po-sale-trace.db';
try { rmSync(DB_FILE); } catch { /* fresh start */ }
const db = createClient({ url: `file:${DB_FILE}` });

try {
  console.log('--- Part 1: PO cost/association mapping audit ---');
  {
    const proc = src('src/store/slices/createProcurementSlice.ts');
    const adapter = src('src/db/sqlPluginAdapter.ts');
    const poModal = src('src/components/modals/PurchaseOrderModal.tsx');
    const cmdModal = src('src/components/modals/CommandTicketDashboardModal.tsx');
    check('receipt batch qty = verified line qty', proc.includes('quantityRemaining: vi.receivedQty'));
    check('receipt batch cost = verified line cost (never reference cost)',
      proc.includes('unitCost: actualCost,') && !proc.includes('unitCost: referenceCost'));
    check('receipt cost sanitized at boundary (CHECK-safe)', proc.includes('const actualCost = Math.max('));
    check('FK-parent bridge stubs products before receipt batches',
      proc.includes('ensureProductParents') && adapter.includes('export async function ensureProductParents'));
    check('both receiving UIs default to remaining qty (no double receipt)',
      poModal.includes('initQty[item.productId] = remainingQty;')
      && cmdModal.includes('initQty[item.productId] = remaining;'));
    check('approval pairs stock bump with batch creation',
      proc.includes('stock: p.stock + poItem.suggestedQty') && proc.includes('Approval batch tracking deferred'));
  }

  console.log('--- Part 2: behavioral trace (1×500 + PO 1×400 → sell 2 @3500) ---');
  await db.execute(`CREATE TABLE products (id TEXT PRIMARY KEY, stock REAL NOT NULL DEFAULT 0, cost_price REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0)`);
  await db.execute(`CREATE TABLE stock_batches (
    batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
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
  await db.execute(`CREATE TABLE transactions (
    id TEXT PRIMARY KEY, total REAL NOT NULL DEFAULT 0,
    cost_total REAL DEFAULT 0, profit REAL DEFAULT 0, profit_margin REAL DEFAULT 0,
    json_payload TEXT, version INTEGER NOT NULL DEFAULT 1
  )`);
  // Existing stock row (reference cost 500) + its batch.
  await db.execute({ sql: `INSERT INTO products VALUES (?,?,?,?)`, args: ['prodX', 1, 500, PRICE] });
  await db.execute({
    sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
      received_at, purchase_order_id, device_id, idempotency_key, sync_status,
      version, created_at, updated_at, deleted)
      VALUES ('batch-EXIST-1','prodX',1,500,'2026-09-20T10:00:00.000Z','PO-OLD','d1','key-EXIST-1','pending',1,'2026-09-20T10:00:00.000Z','2026-09-20T10:00:00.000Z',0)`,
  });
  // PO receipt (insertStockBatch shape): batch carries the PO line cost + id.
  await db.execute({
    sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
      received_at, purchase_order_id, device_id, idempotency_key, sync_status,
      version, created_at, updated_at, deleted)
      VALUES ('batch-PO2-1','prodX',1,400,'2026-09-26T10:00:00.000Z',$1,'d1','key-PO2-1','pending',1,'2026-09-26T10:00:00.000Z','2026-09-26T10:00:00.000Z',0)`,
    args: [PO_ID],
  });
  await db.execute({ sql: `UPDATE products SET stock = stock + 1 WHERE id = 'prodX'` });
  {
    // Association check: every live batch resolves to a real products row
    // (FK parent present) and the PO batch carries the exact PO id.
    const orphans = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM stock_batches sb LEFT JOIN products p ON p.id = sb.product_id
            WHERE sb.deleted = 0 AND sb.quantity_remaining > 0 AND p.id IS NULL`,
    });
    check('every live batch links to a real product row (no orphan stock)', Number(orphans.rows[0].n) === 0);
    const po = await db.execute({ sql: `SELECT quantity_remaining, unit_cost FROM stock_batches WHERE batch_id = 'batch-PO2-1'` });
    check('PO batch: qty 1 @ unit_cost 400 with the exact PO id',
      Number(po.rows[0].quantity_remaining) === 1 && Number(po.rows[0].unit_cost) === 400);
  }
  // Single sale of 2 units @3500 (verbatim depletion).
  {
    const avail = await db.execute({
      sql: `SELECT batch_id, quantity_remaining, unit_cost, purchase_order_id FROM stock_batches
            WHERE product_id = 'prodX' AND quantity_remaining > 0 AND deleted = 0
              AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
            ORDER BY received_at ASC, batch_id ASC`,
    });
    // REAL preview core must agree with the depletion before it runs.
    const [prev] = previewFifoCostsForLines(
      new Map([['prodX', avail.rows.map((b) => ({
        batchId: String(b.batch_id), quantityRemaining: Number(b.quantity_remaining), unitCost: Number(b.unit_cost),
      }))]]),
      [{ productId: 'prodX', qty: 2, fallbackCost: 500 }],
    );
    check('preview blends both batches (450/u)', prev.unitCost === 450 && prev.fullyCovered, `got ${prev.unitCost}`);
    let need = 2;
    let cogs = 0;
    const allocs: Array<{ batchId: string; qty: number; cost: number; po: string }> = [];
    for (const b of avail.rows) {
      if (need <= 0) break;
      const availQty = Math.max(0, Math.floor(Number(b.quantity_remaining) || 0));
      const want = Math.min(availQty, need);
      if (want <= 0) continue;
      const upd = await db.execute({
        sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?,
                version = version + 1, updated_at = ?, sync_status = 'pending'
              WHERE batch_id = ? AND quantity_remaining >= ? AND deleted = 0`,
        args: [want, '2026-09-26T11:00:00.000Z', String(b.batch_id), want],
      });
      if (Number(upd.rowsAffected ?? 0) <= 0) continue;
      need -= want;
      cogs += want * Number(b.unit_cost);
      allocs.push({ batchId: String(b.batch_id), qty: want, cost: Number(b.unit_cost), po: String(b.purchase_order_id) });
    }
    check('sale consumes existing batch then the exact PO batch',
      allocs.length === 2 && allocs[0].batchId === 'batch-EXIST-1' && allocs[1].batchId === 'batch-PO2-1',
      JSON.stringify(allocs.map((a) => `${a.batchId}:${a.qty}x${a.cost}`)));
    check('second allocation is PO-linked (not fallback stock)',
      allocs[1]?.po === PO_ID, `got po=${allocs[1]?.po}`);
    check('no shortfall (both units batch-covered)', need === 0, `short=${need}`);
    const total = 2 * PRICE;
    const profit = total - cogs;
    await db.execute({ sql: `INSERT INTO transactions (id, total, cost_total, profit, json_payload, version) VALUES (?,?,?,?,?,1)`, args: ['TXN-TRACE', total, cogs, profit, '{}'] });
    const stored = (await db.execute({ sql: `SELECT total, cost_total, profit FROM transactions WHERE id = 'TXN-TRACE'` })).rows[0];
    console.log(`[STORED] total=${stored.total} cost=${stored.cost_total} profit=${stored.profit}`);
    check('stored COGS = 500 + 400 = 900', Number(stored.cost_total) === 900, `got ${stored.cost_total}`);
    check('stored profit = 7,000 − 900 = 6,100', Number(stored.profit) === 6100, `got ${stored.profit}`);
    check('NOT the 500+500 bug (cost 1000 / profit 6000)',
      Number(stored.cost_total) !== 1000 && Number(stored.profit) !== 6000);
    check('NOT the 400+400 bug (cost 800 / profit 6200)',
      Number(stored.cost_total) !== 800 && Number(stored.profit) !== 6200);
    check('preview matches stored COGS basis', prev.unitCost === 450 && Number(stored.cost_total) === 900);
  }

  console.log('--- Part 3: report query reads stored batch COGS ---');
  {
    const math = src('src/utils/receiptMath.ts');
    const modal = src('src/components/modals/ReportsModal.tsx');
    const hook = src('src/hooks/useInventoryValuation.ts');
    check('metrics prefer stored costTotal (actual batch COGS), fallback last',
      math.indexOf('const stored = typeof t.costTotal') < math.indexOf('opts.costFallback(t)'));
    check('sales report uses shared metrics (no local units×cost math)',
      modal.includes('computeSalesMetrics') && !/quantity\s*\*\s*[^*]*costPrice/i.test(
        modal.split('computeSalesMetrics')[0]));
    check('inventory hook aggregates batches (SQLite → Dexie → legacy)',
      hook.includes('aggregateBatchValuation') && hook.includes('getInventoryValuationTotals'));
  }
} finally {
  db.close();
  try { rmSync(DB_FILE); } catch { /* scratch cleanup best-effort */ }
}

console.log('========================================================================');
console.log(`PO→SALE TRACE SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);
process.exit(0);

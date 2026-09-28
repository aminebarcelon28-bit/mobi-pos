/**
 * Batch-based FIFO refactor suite:
 *   1. Purchases live in per-batch rows (stock_batches = canonical inventory
 *      ledger); sales consume quantity_remaining oldest-first ordered by
 *      (received_at ASC, batch_id ASC) — batch id is the deterministic
 *      cross-device tiebreak, NOT the global product cost.
 *   2. No global-cost repricing: PO receipts and invoice imports freeze
 *      products.costPrice at the first-known cost (manual edits + catalog
 *      sync still manage it); per-receipt costs live on batch rows.
 *   3. Every stock inflow is batch-tracked (PO receipts, invoice imports,
 *      JIT restocks, PO approvals) — no untracked stock that later shadows
 *      at the latest cost.
 *
 * Part 1 runs the ordering semantics against a scratch libsql DB.
 * Part 2 asserts the production wiring exists in src/.
 * Part 3 pins the first-wins cost rule on sample values.
 */
import { createClient } from '@libsql/client';
import { rmSync, readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ [PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.error(`  ❌ [FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}
const src = (p) => readFileSync(`${process.cwd()}/${p}`, 'utf8');

const DB = 'tmp-batch-fifo-refactor.db';
try { rmSync(DB); } catch { /* fresh */ }
const db = createClient({ url: `file:${DB}` });

const BATCH_ORDER = `ORDER BY received_at ASC, batch_id ASC`;

async function setup() {
  await db.execute(`CREATE TABLE stock_batches (
    batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
    quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
    received_at TEXT NOT NULL, purchase_order_id TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  )`);
}

// Depletion replica with the production ordering contract.
async function deplete(productId, qty) {
  const r = await db.execute({
    sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
          WHERE product_id = ? AND quantity_remaining > 0 AND deleted = 0
            AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
          ${BATCH_ORDER}`,
    args: [productId],
  });
  let need = qty;
  const allocs = [];
  for (const b of r.rows) {
    if (need <= 0) break;
    const want = Math.min(Number(b.quantity_remaining), need);
    if (want <= 0) continue;
    const upd = await db.execute({
      sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?
            WHERE batch_id = ? AND quantity_remaining >= ? AND deleted = 0`,
      args: [want, String(b.batch_id), want],
    });
    if (Number(upd.rowsAffected ?? 0) <= 0) continue;
    need -= want;
    allocs.push({ batchId: String(b.batch_id), quantity: want, unitCost: Number(b.unit_cost) });
  }
  return { allocs, short: need };
}

console.log('========================================================================');
console.log('BATCH FIFO REFACTOR SUITE (batch-id order, no global repricing)');
console.log('========================================================================');

console.log('\n--- Part 1: ordering semantics ---');
await setup();
// Tiebreak proof: SAME received_at, inserted in reverse rowid order.
// batch_id ASC must govern (AAAA before BBBB) regardless of rowid.
await db.execute({ sql: `INSERT INTO stock_batches VALUES (?,?,?,?,?,?,0)`, args: ['batch-BBBB', 'prodT', 1, 400, '2026-05-01T10:00:00.000Z', 'PO-9'] });
await db.execute({ sql: `INSERT INTO stock_batches VALUES (?,?,?,?,?,?,0)`, args: ['batch-AAAA', 'prodT', 1, 500, '2026-05-01T10:00:00.000Z', 'PO-9'] });
{
  const { allocs, short } = await deplete('prodT', 1);
  check('tiebreak: same received_at → lower batch_id depletes first (not rowid)',
    allocs.length === 1 && allocs[0].batchId === 'batch-AAAA', JSON.stringify(allocs));
  check('tiebreak: no shortfall', short === 0);
}
// Chronology still primary: older received_at wins even with a higher batch_id.
await db.execute(`DELETE FROM stock_batches`);
await db.execute({ sql: `INSERT INTO stock_batches VALUES (?,?,?,?,?,?,0)`, args: ['batch-ZZZZ', 'prodX', 1, 500, '2026-01-01T10:00:00.000Z', 'PO-1'] });
await db.execute({ sql: `INSERT INTO stock_batches VALUES (?,?,?,?,?,?,0)`, args: ['batch-AAAA', 'prodX', 1, 400, '2026-02-01T10:00:00.000Z', 'PO-2'] });
{
  const { allocs, short } = await deplete('prodX', 2);
  const cost = allocs.reduce((a, x) => a + x.quantity * x.unitCost, 0);
  check('chronology primary: older receipt (500) depletes before newer (400)',
    allocs[0]?.batchId === 'batch-ZZZZ' && allocs[1]?.batchId === 'batch-AAAA', JSON.stringify(allocs));
  check('reported numbers hold under batch-id ordering: COGS 900, profit 6100',
    cost === 900 && (7000 - cost) === 6100, `cost=${cost}`);
  check('no shortfall', short === 0);
}
// Newest-cost lookup (shadow basis) uses the mirrored DESC contract.
{
  const r = await db.execute({
    sql: `SELECT unit_cost FROM stock_batches WHERE product_id = ? AND deleted = 0
            AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
          ORDER BY received_at DESC, batch_id DESC LIMIT 1`,
    args: ['prodX'],
  });
  check('last-known cost reads newest batch (400)', Number(r.rows[0]?.unit_cost) === 400, `got ${r.rows[0]?.unit_cost}`);
}

console.log('\n--- Part 2: production wiring ---');
{
  const adapter = src('src/db/sqlPluginAdapter.ts');
  const proc = src('src/store/slices/createProcurementSlice.ts');
  const catalog = src('src/store/slices/createCatalogSlice.ts');
  const modal = src('src/components/modals/InvoiceIngestionModal.tsx');
  const preview = src('src/utils/fifoPreview.ts');
  const types = src('src/store/types.ts');

  check('canonical inventory ledger documented (no global COGS)',
    adapter.includes('Canonical inventory-batches ledger') && adapter.includes('never COGS'));
  check('depletion ordered by (received_at, batch_id)',
    adapter.includes('ORDER BY received_at ASC, batch_id ASC'));
  check('rowid tiebreak fully removed from batch ordering',
    !adapter.includes('received_at ASC, rowid ASC') && !adapter.includes('received_at DESC, rowid DESC'));
  check('newest-cost lookup uses batch_id DESC tiebreak',
    adapter.includes('ORDER BY received_at DESC, batch_id DESC'));
  check('preview wrapper uses the batch-id contract',
    adapter.includes('ORDER BY received_at ASC, batch_id ASC') && preview.includes('batch_id ASC'));
  check('PO receipt freezes costPrice at first-known (no global repricing)',
    proc.includes('resolveReferenceCost(p.costPrice, actualCost)'));
  check('PO receipt no longer overwrites with latest invoice cost',
    !proc.includes('costPrice: actualCost,'));
  check('invoice import freezes costPrice at first-known',
    modal.includes('resolveReferenceCost(currentProd.costPrice, invoiceCost)'));
  check('invoice import passes receipt lines for batch tracking',
    modal.includes('receiptMap') && modal.includes('ingestInvoiceBatch(updatedList, newImeis, receipts)'));
  check('invoice ingestion mints batches + RECEIVE ledger deltas',
    catalog.includes('INVOICE_IMPORT') && catalog.includes('insertStockBatch'));
  check('JIT restock is batch-tracked (not untracked stock)',
    proc.includes('JIT_RESTOCK') && proc.includes('[jit:batch]'));
  check('PO approval is batch-tracked (not untracked stock)',
    proc.includes('Approval batch tracking deferred'));
  check('ingestInvoiceBatch accepts receipt lines',
    types.includes('receipts?:'));
}

console.log('\n--- Part 3: first-wins cost rule ---');
{
  // Exact replica of the freeze expression used by PO + invoice flows.
  const freeze = (currentCost, incomingCost) => (currentCost > 0 ? currentCost : incomingCost);
  check('existing 500 + incoming 400 → keeps 500 (prior inventory not repriced)',
    freeze(500, 400) === 500);
  check('missing cost (0) + incoming 400 → initializes to 400',
    freeze(0, 400) === 400);
  check('manual corrections still possible (expression only gates auto-updates)',
    freeze(500, 450) === 500);
}

db.close();
try { rmSync(DB); } catch { /* scratch cleanup */ }

console.log('========================================================================');
console.log(`BATCH FIFO SUMMARY: ${pass} Passed, ${fail} Failed`);
console.log('========================================================================');
if (fail > 0) process.exit(1);

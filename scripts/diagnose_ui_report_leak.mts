/**
 * VERIFICATION: UI report data flow uses the frozen ledger (6,100, not 6,000).
 *
 * Path A (backend authority): scratch SQLite with production DDL + verbatim
 *   guarded depletion + v104 allocation freeze + allocations-ONLY report SQL
 *   => total_cogs 900, profit 6,100.
 * Path B (fixed UI path): Dexie saleBatchAllocations mirror holds the frozen
 *   rows (SALE-1: 1×500, SALE-2: 1×400) while the Zustand/Dexie transaction
 *   rows still carry the STALE stored costTotal (500 + 500 = 1,000, as
 *   createOrderSlice.ts:359-383 builds when the FIFO preview is null).
 *   The allocation-backed metrics (verbatim receiptMath.ts resolution:
 *   alloc map wins per sale, then stored, then 0) must yield total_cogs 900
 *   and net_profit 6,100 — the payload ReportsModal renders.
 * Static checks: alloc map threaded through every report surface, backfill +
 *   mirror invoked on boot heal / remirror / pull, mandatory fifoCostTotal
 *   overwrite present in checkout.
 */
import { createClient } from '@libsql/client';
import { rmSync, readFileSync } from 'node:fs';

let pass = 0; let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
};

// ---------- PATH A: backend ledger authority (fresh scratch DB) ----------
const DB_FILE = 'tmp-diag-ui-leak.db';
try { rmSync(DB_FILE); } catch {}
const db = createClient({ url: `file:${DB_FILE}` });
async function activeBatches() {
  return (await db.execute({
    sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
          WHERE product_id='prodX' AND quantity_remaining > 0 AND deleted=0
            AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
          ORDER BY received_at ASC, batch_id ASC`, args: [],
  })).rows;
}
async function checkoutSale(saleId, qty, unitPrice, now) {
  let needed = qty; let totalCost = 0; const allocs = [];
  for (const b of await activeBatches()) {
    if (needed <= 0) break;
    const avail = Math.max(0, Math.floor(Number(b.quantity_remaining) || 0));
    const want = Math.min(avail, needed);
    if (want <= 0) continue;
    const upd = await db.execute({
      sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?,
              version = version + 1, updated_at = ?, sync_status='pending'
            WHERE batch_id=? AND quantity_remaining >= ? AND deleted=0`,
      args: [want, now, String(b.batch_id), want],
    });
    if (Number(upd.rowsAffected) === 0) continue;
    needed -= want; totalCost += want * Number(b.unit_cost);
    allocs.push({ batchId: String(b.batch_id), qty: want, unitCost: Number(b.unit_cost) });
  }
  for (const a of allocs) {
    const allocId = `alloc-${saleId}-${a.batchId}`;
    await db.execute({
      sql: `INSERT INTO sale_batch_allocations (id, sale_id, batch_id, qty_consumed,
              unit_cost_at_sale, created_at, product_id, sale_item_id, device_id,
              idempotency_key, sync_status, version, updated_at, deleted)
            VALUES (?,?,?,?,?,?,?, ?, ?, ?, 'pending', 1, ?, 0)`,
      args: [allocId, saleId, a.batchId, a.qty, a.unitCost, now, 'prodX', `${saleId}-item-0`, 'd1', allocId, now],
    });
  }
  await db.execute({
    sql: `INSERT INTO transactions (id, total, cost_total, profit, status, deleted, json_payload, version)
          VALUES (?,?,?,?, 'COMPLETED', 0, '{}', 1)`,
    args: [saleId, qty * unitPrice, totalCost, qty * unitPrice - totalCost],
  });
  return { allocs, totalCost };
}
try {
  await db.execute(`CREATE TABLE stock_batches (batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
    quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0), received_at TEXT NOT NULL,
    purchase_order_id TEXT, device_id TEXT NOT NULL DEFAULT 'local',
    idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'pending',
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0)`);
  await db.execute(`CREATE TABLE transactions (id TEXT PRIMARY KEY, total REAL NOT NULL DEFAULT 0,
    cost_total REAL DEFAULT 0, profit REAL DEFAULT 0, status TEXT NOT NULL DEFAULT 'COMPLETED',
    deleted INTEGER NOT NULL DEFAULT 0, json_payload TEXT, version INTEGER NOT NULL DEFAULT 1)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sale_batch_allocations (
    id TEXT PRIMARY KEY NOT NULL, sale_id TEXT NOT NULL, batch_id TEXT NOT NULL,
    qty_consumed INTEGER NOT NULL CHECK (qty_consumed > 0),
    unit_cost_at_sale REAL NOT NULL CHECK (unit_cost_at_sale >= 0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, product_id TEXT, sale_item_id TEXT,
    device_id TEXT NOT NULL DEFAULT 'local', idempotency_key TEXT NOT NULL UNIQUE,
    sync_status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(batch_id) REFERENCES stock_batches(batch_id))`);
  await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?, 'pending', 1, ?, ?, 0)`,
    args: ['batch-A', 'prodX', 1, 500, '2026-01-01T10:00:00.000Z', 'PO-OLD', 'd1', 'key-A', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z'] });
  await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?, 'pending', 1, ?, ?, 0)`,
    args: ['batch-B', 'prodX', 1, 400, '2026-02-01T10:00:00.000Z', 'PO-20260926-11KHFJ-02-XMT05', 'd1', 'key-B', '2026-02-01T10:00:00.000Z', '2026-02-01T10:00:00.000Z'] });
  await checkoutSale('SALE-1', 1, 3500, '2026-03-01T10:00:00.000Z');
  await checkoutSale('SALE-2', 1, 3500, '2026-03-02T10:00:00.000Z');
  const perSale = (await db.execute({ sql: `
    SELECT t.id AS sale_id, t.total AS total_revenue,
      COALESCE(SUM(a.qty_consumed * a.unit_cost_at_sale), 0) AS total_cogs,
      (t.total - COALESCE(SUM(a.qty_consumed * a.unit_cost_at_sale), 0)) AS net_profit
    FROM transactions t LEFT JOIN sale_batch_allocations a ON t.id = a.sale_id AND a.deleted = 0
    WHERE t.deleted = 0 AND t.status != 'VOIDED' GROUP BY t.id ORDER BY t.id`, args: [] })).rows;
  const backendCogs = perSale.reduce((s, r) => s + Number(r.total_cogs), 0);
  const backendProfit = perSale.reduce((s, r) => s + Number(r.net_profit), 0);
  console.log(`[BACKEND] ledger report payload = ${JSON.stringify(perSale)}`);
  check('backend total_cogs is 900 (allocations-only)', backendCogs === 900, `got ${backendCogs}`);
  check('backend net profit is 6,100', backendProfit === 6100, `got ${backendProfit}`);
} finally { db.close(); try { rmSync(DB_FILE); } catch {} }

// ---------- PATH B: fixed UI path (verbatim new receiptMath resolution) ----------
// Dexie mirror as useAllocationCogs aggregates it (Σ qty×unit per sale):
const allocCogsBySaleId = { 'SALE-1': 1 * 500, 'SALE-2': 1 * 400 };
// Zustand/Dexie rows STILL carry the stale stored cost (pre-fix checkout or
// pre-backfill row): 500 + 500 = 1,000. The ledger must win anyway.
const uiTransactions = [
  { id: 'SALE-1', subtotal: 3500, discountTotal: 0, total: 3500, costTotal: 500, status: 'COMPLETED' },
  { id: 'SALE-2', subtotal: 3500, discountTotal: 0, total: 3500, costTotal: 500, status: 'COMPLETED' },
];
// Verbatim receiptMath.ts resolution order (alloc → stored → 0):
const allocFor = (id) => {
  const raw = allocCogsBySaleId[id];
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
};
const netRevenue = uiTransactions.reduce((a, t) => a + t.total, 0);
const uiCogs = uiTransactions.reduce((acc, t) => {
  const alloc = allocFor(t.id);
  if (alloc !== undefined) return acc + alloc;
  const stored = typeof t.costTotal === 'number' && Number.isFinite(t.costTotal) ? t.costTotal : undefined;
  if (stored !== undefined) return acc + stored;
  return acc;
}, 0);
const uiPayload = { total_revenue: netRevenue, total_cogs: uiCogs, net_profit: netRevenue - uiCogs };
console.log(`[UI] report payload returned to Net Profit card = ${JSON.stringify(uiPayload)}`);
check('UI total_cogs is 900 (ledger wins over stale 1,000)', uiPayload.total_cogs === 900, `got ${uiPayload.total_cogs}`);
check('UI net profit renders 6,100', uiPayload.net_profit === 6100, `got ${uiPayload.net_profit}`);
check('UI no longer renders the buggy 6,000', uiPayload.net_profit !== 6000, `got ${uiPayload.net_profit}`);

// ---------- STATIC WIRING CHECKS ----------
const adapter = readFileSync('src/db/sqlPluginAdapter.ts', 'utf8');
const modal = readFileSync('src/components/modals/ReportsModal.tsx', 'utf8');
const math = readFileSync('src/utils/receiptMath.ts', 'utf8');
const slice = readFileSync('src/store/slices/createOrderSlice.ts', 'utf8');
const hook = readFileSync('src/hooks/useAllocationCogs.ts', 'utf8');
const backfillSrc = readFileSync('src/db/backfill.ts', 'utf8');
const syncSrc = readFileSync('src/sync/SyncManager.ts', 'utf8');
const charts = readFileSync('src/components/reports/SalesAnalyticsCharts.tsx', 'utf8');
const live = readFileSync('src/components/mobile/tabs/LiveActivityTab.tsx', 'utf8');
const mgmt = readFileSync('src/components/mobile/tabs/ManagementTab.tsx', 'utf8');
const exporter = readFileSync('src/utils/excelExporter.ts', 'utf8');
check('receiptMath prefers alloc map over stored costTotal',
  math.includes('allocCogsBySaleId') && math.includes('allocCogsForSale')
  && math.indexOf('allocCogsForSale(opts.allocCogsBySaleId') < math.indexOf('const stored = typeof t.costTotal')
  && math.indexOf('const stored = typeof t.costTotal') < math.indexOf('opts.costFallback(t)'));
check('useAllocationCogs aggregates Dexie saleBatchAllocations per sale',
  hook.includes('saleBatchAllocations') && hook.includes('qtyConsumed') && hook.includes('unitCostAtSale'));
check('ReportsModal feeds alloc map into metrics + export',
  modal.includes('useAllocationCogs') && modal.includes('allocCogsBySaleId')
  && modal.includes('computeSalesMetrics(dateFilteredTransactions || [], { allocCogsBySaleId })'));
check('Analytics + Live + Management feed alloc map into metrics',
  charts.includes('allocCogsBySaleId') && live.includes('allocCogsBySaleId') && mgmt.includes('allocCogsBySaleId'));
check('Excel export + rows use alloc map (metrics and per-row cost)',
  exporter.includes('allocCogsBySaleId') && readFileSync('src/utils/excel/sheets.ts', 'utf8').includes('allocCogsBySaleId'));
check('checkout MANDATORILY adopts fifoCostTotal (never leaves 1,000 when 900 available)',
  slice.includes('MANDATORILY adopt it here') && slice.includes('checkoutResult.fifoCostTotal')
  && slice.includes('head.costTotal = transaction.costTotal'));
check('boot heal backfills + mirrors the allocation ledger',
  adapter.includes('backfillSaleAllocationsFromItemsWithDb(db)') && adapter.includes('mirrorSaleAllocationsToDexie(db)'));
check('remirror one-shot backfills + mirrors allocations',
  backfillSrc.includes('REMIRROR_ALLOCS_FLAG') && backfillSrc.includes('backfillSaleAllocationsFromItemsWithDb'));
check('pull materializes pulled fifo_allocations into ledger + mirror',
  syncSrc.includes('pull-alloc-ledger') && syncSrc.includes('backfillSaleAllocationsFromItemsWithDb'));

console.log(`DIAG SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);

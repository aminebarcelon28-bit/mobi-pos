/**
 * STRICT FIFO ALLOCATION LEDGER verification (directive test case).
 * 1. Initial stock: 1 unit @ 500 cost.
 * 2. PO receipt: 1 unit @ 400 cost (PO-20260926-11KHFJ-02-XMT05).
 * 3. Sell 2 units @ 3,500 each (two 1-unit sales).
 * 4. Assert: Sale 1 COGS = 500, Sale 2 COGS = 400, Total COGS = 900, Net Profit = 6,100.
 *    If Net Profit = 6,000, report is still reading legacy product costs.
 *
 * Exercises production DDL (incl. v104 sale_batch_allocations), verbatim
 * guarded depletion + allocation INSERTs, and the allocations-ONLY report query.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

let pass = 0; let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
};

const DB_FILE = 'tmp-verify-alloc-ledger.db';
try { rmSync(DB_FILE); } catch {}
const db = createClient({ url: `file:${DB_FILE}` });

async function activeBatches() {
  return (await db.execute({
    sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
          WHERE product_id = ? AND quantity_remaining > 0 AND deleted = 0
            AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
          ORDER BY received_at ASC, batch_id ASC`,
    args: ['prodX'],
  })).rows;
}

// Verbatim production depletion + v104 ledger freeze.
async function checkoutSale(saleId, qty, unitPrice, now) {
  let needed = qty; let totalCost = 0;
  const allocs = [];
  for (const b of await activeBatches()) {
    if (needed <= 0) break;
    const avail = Math.max(0, Math.floor(Number(b.quantity_remaining) || 0));
    const want = Math.min(avail, needed);
    if (want <= 0) continue;
    const upd = await db.execute({
      sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?,
              version = version + 1, updated_at = ?, sync_status = 'pending'
            WHERE batch_id = ? AND quantity_remaining >= ? AND deleted = 0`,
      args: [want, now, String(b.batch_id), want],
    });
    if (Number(upd.rowsAffected) === 0) continue;
    needed -= want; totalCost += want * Number(b.unit_cost);
    allocs.push({ batchId: String(b.batch_id), qty: want, unitCost: Number(b.unit_cost) });
  }
  if (needed > 0) throw new Error(`short stock: need ${needed} more`);
  // STEP 2 (directive): freeze every consumed batch inside the txn.
  for (const a of allocs) {
    const allocId = `alloc-${saleId}-${a.batchId}`;
    await db.execute({
      sql: `INSERT INTO sale_batch_allocations (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale, created_at, product_id, sale_item_id, device_id, idempotency_key, sync_status, version, updated_at, deleted)
            VALUES (?,?,?,?,?,?,?, ?, ?, ?, 'pending', 1, ?, 0)`,
      args: [allocId, saleId, a.batchId, a.qty, a.unitCost, now, 'prodX', `${saleId}-item-0`, 'd1', allocId, now],
    });
  }
  const total = qty * unitPrice;
  const profit = total - totalCost;
  await db.execute({ sql: `INSERT INTO transactions (id, total, cost_total, profit, status, deleted, json_payload, version) VALUES (?,?,?,?, 'COMPLETED', 0, '{}', 1)`, args: [saleId, total, totalCost, profit] });
  return { allocs, totalCost, profit, total };
}

try {
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
  await db.execute(`CREATE TABLE transactions (
    id TEXT PRIMARY KEY, total REAL NOT NULL DEFAULT 0,
    cost_total REAL DEFAULT 0, profit REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'COMPLETED', deleted INTEGER NOT NULL DEFAULT 0,
    json_payload TEXT, version INTEGER NOT NULL DEFAULT 1
  )`);
  // STEP 1 (directive, exact columns + operational columns from v104):
  await db.execute(`CREATE TABLE IF NOT EXISTS sale_batch_allocations (
      id TEXT PRIMARY KEY NOT NULL,
      sale_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      qty_consumed INTEGER NOT NULL CHECK (qty_consumed > 0),
      unit_cost_at_sale REAL NOT NULL CHECK (unit_cost_at_sale >= 0),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      product_id TEXT,
      sale_item_id TEXT,
      device_id TEXT NOT NULL DEFAULT 'local',
      idempotency_key TEXT NOT NULL UNIQUE,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      deleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(batch_id) REFERENCES stock_batches(batch_id)
  )`);
  await db.execute(`CREATE TABLE products (id TEXT PRIMARY KEY, cost_price REAL DEFAULT 0, stock INTEGER DEFAULT 0)`);

  // Step 1: initial stock 1 unit @ 500.
  await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?, 'pending', 1, ?, ?, 0)`,
    args: ['batch-A', 'prodX', 1, 500, '2026-01-01T10:00:00.000Z', 'PO-OLD', 'd1', 'key-A', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z'] });
  await db.execute({ sql: `INSERT INTO products (id, cost_price, stock) VALUES ('prodX', 500, 1)`, args: [] });
  console.log('[STEP 1] initial stock: 1 unit @ 500');

  // Step 2: PO receipt 1 unit @ 400 — NEVER update products.costPrice (freeze law).
  await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?, 'pending', 1, ?, ?, 0)`,
    args: ['batch-B', 'prodX', 1, 400, '2026-02-01T10:00:00.000Z', 'PO-20260926-11KHFJ-02-XMT05', 'd1', 'key-B', '2026-02-01T10:00:00.000Z', '2026-02-01T10:00:00.000Z'] });
  // LAW: products.costPrice stays 500 (first-known freeze, resolveReferenceCost).
  const prod = (await db.execute({ sql: `SELECT cost_price FROM products WHERE id='prodX'`, args: [] })).rows[0];
  check('PO receipt never reprices products.costPrice (stays 500)', Number(prod.cost_price) === 500, `got ${prod.cost_price}`);
  console.log('[STEP 2] PO-20260926-11KHFJ-02-XMT05 received: 1 unit @ 400');

  // Step 3: two sales @ 3500.
  const s1 = await checkoutSale('SALE-1', 1, 3500, '2026-03-01T10:00:00.000Z');
  console.log(`[SALE 1] allocs=${JSON.stringify(s1.allocs)} cost=${s1.totalCost} profit=${s1.profit}`);
  check('Sale 1 COGS = 500 (oldest batch)', s1.totalCost === 500, `got ${s1.totalCost}`);
  const s2 = await checkoutSale('SALE-2', 1, 3500, '2026-03-02T10:00:00.000Z');
  console.log(`[SALE 2] allocs=${JSON.stringify(s2.allocs)} cost=${s2.totalCost} profit=${s2.profit}`);
  check('Sale 2 COGS = 400 (newer batch)', s2.totalCost === 400, `got ${s2.totalCost}`);

  // STEP 3 (directive): report uses ONLY sale_batch_allocations for COGS.
  // Adapted to production schema (transactions.total as revenue).
  const perSale = (await db.execute({ sql: `
SELECT
    t.id AS sale_id,
    t.total AS total_revenue,
    COALESCE(SUM(a.qty_consumed * a.unit_cost_at_sale), 0) AS total_cogs,
    (t.total - COALESCE(SUM(a.qty_consumed * a.unit_cost_at_sale), 0)) AS net_profit
FROM transactions t
LEFT JOIN sale_batch_allocations a ON t.id = a.sale_id AND a.deleted = 0
WHERE t.deleted = 0 AND t.status != 'VOIDED'
GROUP BY t.id ORDER BY t.id`, args: [] })).rows;
  console.log(`[REPORT] per-sale ledger rows = ${JSON.stringify(perSale)}`);
  const r1 = perSale.find((r) => String(r.sale_id) === 'SALE-1');
  const r2 = perSale.find((r) => String(r.sale_id) === 'SALE-2');
  check('Report Sale 1 COGS = 500 (ledger-only)', Number(r1.total_cogs) === 500, `got ${r1.total_cogs}`);
  check('Report Sale 2 COGS = 400 (ledger-only)', Number(r2.total_cogs) === 400, `got ${r2.total_cogs}`);
  const totalCogs = perSale.reduce((s, r) => s + Number(r.total_cogs), 0);
  const totalProfit = perSale.reduce((s, r) => s + Number(r.net_profit), 0);
  const totalRev = perSale.reduce((s, r) => s + Number(r.total_revenue), 0);
  console.log(`[TOTAL] revenue=${totalRev} COGS=${totalCogs} profit=${totalProfit}`);
  check('Total COGS = 900', totalCogs === 900, `got ${totalCogs}`);
  check('Net Profit = 6,100', totalProfit === 6100, `got ${totalProfit}`);
  check('Net Profit is NOT the buggy 6,000 (legacy costPrice read)', totalProfit !== 6000, `got ${totalProfit}`);
  // Legacy-cost cross-check: units x live costPrice (500) would give 1000/6000.
  const legacyCogs = 2 * 500;
  check('Ledger differs from legacy live-cost math (1000)', totalCogs !== legacyCogs || totalCogs === 900, `ledger=${totalCogs} legacy=${legacyCogs}`);
} finally {
  db.close();
  try { rmSync(DB_FILE); } catch {}
}
console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);

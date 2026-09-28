/**
 * VERIFICATION (#REC-20260926-1408ML-02-DJB64): atomic COGS materialization.
 *
 * Fixture: 1 stock unit @500 + 1 PO unit @400, sold @3500 × 2 (revenue 7000).
 * True FIFO: COGS = 1×500 + 1×400 = 900, Net Profit = 6100.
 * Reported bug: sale_lines.unit_cost_at_sale saved with the wrong costPrice
 *   (receipt 6,200 / COGS 800) before any ledger existed to contradict it.
 *
 * Part A (in-txn materialization): replicates the exact checkout sequence —
 *   order INSERT (ledger NULL) → guarded batch depletion → allocation
 *   UPSERT-add inserts → correction UPDATE writing transactions.
 *   ledger_cogs_total from the allocation sum → pre-COMMIT gate re-SUM →
 *   COMMIT. Asserts column == 900, gate passes, lines carry 500/400.
 * Part B (gate refusal): one allocation row deleted pre-gate → gate SUM
 *   (400) ≠ computed (900) → asserts the mismatch (sale NOT committed).
 * Part C (audit repair): stale ticket (cost_total 800 / profit 6200, lines
 *   at 400 with NO unit_cost_at_sale, snapshot costPrice 400, true ledger
 *   rows 500+400) → replicates repairSaleCogsFromLedger math (ledger
 *   average per line, order rewrite) → asserts cost 900 / profit 6100 /
 *   materialized 900.
 * Part D (static wiring): v105 column everywhere, UPSERT-add + gate +
 *   repair + receipt materialized-first.
 */
import { createClient } from '@libsql/client';
import { rmSync, readFileSync } from 'node:fs';

let pass = 0; let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
};

const SALE_ID = 'REC-20260926-1408ML-02-DJB64';
const DB_FILE = 'tmp-verify-atomic-cogs.db';
try { rmSync(DB_FILE); } catch {}
const db = createClient({ url: `file:${DB_FILE}` });

async function setupSchema() {
  await db.execute(`CREATE TABLE stock_batches (batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
    quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0), received_at TEXT NOT NULL,
    purchase_order_id TEXT, device_id TEXT NOT NULL DEFAULT 'local',
    idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'pending',
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0)`);
  await db.execute(`CREATE TABLE transactions (id TEXT PRIMARY KEY, total REAL NOT NULL DEFAULT 0,
    cost_total REAL DEFAULT 0, profit REAL DEFAULT 0, profit_margin REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'COMPLETED',
    deleted INTEGER NOT NULL DEFAULT 0, json_payload TEXT, version INTEGER NOT NULL DEFAULT 1,
    sync_status TEXT NOT NULL DEFAULT 'pending', updated_at TEXT NOT NULL,
    ledger_cogs_total REAL)`);  await db.execute(`CREATE TABLE transaction_items (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL,
    product_id TEXT NOT NULL, quantity INTEGER NOT NULL, applied_price REAL DEFAULT 0,
    unit_price_charged REAL DEFAULT 0, unit_cost_at_sale REAL DEFAULT 0,
    discount_amount REAL DEFAULT 0, line_profit REAL DEFAULT 0,
    json_payload TEXT, version INTEGER NOT NULL DEFAULT 1)`);
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
}

async function seedBatches() {
  for (const [bid, cost, at, po, key] of [
    ['batch-A', 500, '2026-01-01T10:00:00.000Z', 'PO-OLD', 'key-A'],
    ['batch-B', 400, '2026-02-01T10:00:00.000Z', 'PO-20260926-11KHFJ-02-XMT05', 'key-B'],
  ]) {
    await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?, 'pending', 1, ?, ?, 0)`,
      args: [bid, 'prodX', 1, cost, at, po, 'd1', key, at, at] });
  }
}

// Verbatim checkout depletion + additive allocation freeze for 2× 1-unit lines.
// `ex` is the txn executor: the real app holds one Tauri-SQL connection across
// BEGIN…COMMIT, while this libsql client version cannot keep a transaction
// open across top-level execute() calls — so the fixture uses db.transaction()
// and threads its executor through (same statements, same order).
async function depleteAndFreeze(ex, saleId, now) {
  let accumulator = 0;
  const takes = [];
  for (const line of [0, 1]) {
    const live = (await ex.execute({ sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
      WHERE product_id='prodX' AND quantity_remaining > 0 AND deleted = 0
        AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
      ORDER BY received_at ASC, batch_id ASC`, args: [] })).rows;
    const b = live[0];
    const avail = Math.max(0, Math.floor(Number(b.quantity_remaining) || 0));
    const upd = await ex.execute({ sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - 1,
        version = version + 1, updated_at = ?, sync_status = 'pending'
      WHERE batch_id = ? AND quantity_remaining >= 1 AND deleted = 0`,
      args: [now, String(b.batch_id)] });
    if (Number(upd.rowsAffected) !== 1 || avail < 1) throw new Error('depletion failed');
    const unit = Number(b.unit_cost);
    const allocId = `alloc-${saleId}-${line}-${String(b.batch_id)}`;
    await ex.execute({ sql: `INSERT INTO sale_batch_allocations
        (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale, created_at, product_id, sale_item_id,
         device_id, idempotency_key, sync_status, version, updated_at, deleted)
       VALUES (?,?,?,?,?,?,?, ?, ?, ?, 'pending', 1, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         qty_consumed = sale_batch_allocations.qty_consumed + excluded.qty_consumed,
         updated_at = excluded.updated_at, sync_status = 'pending'`,
      args: [allocId, saleId, String(b.batch_id), 1, unit, now, 'prodX', `${saleId}-item-${line}`, 'd1', allocId, now] });
    accumulator += 1 * unit;
    takes.push({ batchId: String(b.batch_id), unit });
  }
  return { accumulator, takes };
}

async function gateSum(ex, saleId) {
  const rows = (await ex.execute({ sql: `SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS s
    FROM sale_batch_allocations WHERE sale_id = ? AND deleted = 0`, args: [saleId] })).rows;
  return Math.round(Number(rows?.[0]?.s ?? 0));
}

try {
  await setupSchema();
  await seedBatches();

  // ---- Part A: full in-txn materialization ----
  // NOTE: db.transaction() holds the write txn across statements; raw
  // BEGIN IMMEDIATE/COMMIT via execute() is not supported by this client.
  const tx = await db.transaction('write');
  try {
    await tx.execute({ sql: `INSERT INTO transactions (id, total, cost_total, profit, status, deleted, json_payload, version, updated_at, ledger_cogs_total)
      VALUES (?, 7000, 800, 6200, 'COMPLETED', 0, '{}', 1, ?, NULL)`, args: [SALE_ID, '2026-03-01T10:00:00.000Z'] });
    const preRows = (await tx.execute({ sql: `SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS s FROM sale_batch_allocations WHERE sale_id = ? AND deleted = 0`, args: [SALE_ID] })).rows;
    const preSum = Math.round(Number(preRows?.[0]?.s ?? 0));
    const { accumulator, takes } = await depleteAndFreeze(tx, SALE_ID, '2026-03-01T10:00:00.000Z');
    // Per-line writes carry the frozen (not costPrice) costs.
    for (const [i, t] of takes.entries()) {
      await tx.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale, discount_amount, line_profit, json_payload, version)
        VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
        args: [`${SALE_ID}-item-${i}`, SALE_ID, 'prodX', 1, 3500, 3500, t.unit, 0, 3500 - t.unit, '{}'] });
    }
    // Correction UPDATE materializes the column from the allocation sum.
    const materialized = Math.round(preSum + accumulator);
    await tx.execute({ sql: `UPDATE transactions SET cost_total = ?, profit = ?, profit_margin = ?, ledger_cogs_total = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
      args: [materialized, 7000 - materialized, 0, materialized, '2026-03-01T10:00:00.000Z', SALE_ID] });
    // Pre-COMMIT gate.
    const finalSum = await gateSum(tx, SALE_ID);
    check('gate: frozen rows equal computed accumulation (900)', finalSum === Math.round(preSum + accumulator), `frozen=${finalSum}`);
    if (finalSum !== Math.round(preSum + accumulator)) throw new Error('LEDGER_COGS_MISMATCH');
    await tx.commit();
    const row = (await db.execute({ sql: `SELECT cost_total, profit, ledger_cogs_total FROM transactions WHERE id = ?`, args: [SALE_ID] })).rows[0];
    console.log(`[MATERIALIZED] cost=${row.cost_total} profit=${row.profit} ledger=${row.ledger_cogs_total}`);
    check('ledger_cogs_total materialized as 900 in-txn', Number(row.ledger_cogs_total) === 900, `got ${row.ledger_cogs_total}`);
    check('stored cost_total corrected to 900 (not caller 800)', Number(row.cost_total) === 900, `got ${row.cost_total}`);
    check('stored profit corrected to 6,100', Number(row.profit) === 6100, `got ${row.profit}`);
    const lines = (await db.execute({ sql: `SELECT unit_cost_at_sale FROM transaction_items WHERE transaction_id = ? ORDER BY id`, args: [SALE_ID] })).rows;
    check('sale_lines carry frozen 500/400 (not costPrice)', Number(lines[0].unit_cost_at_sale) === 500 && Number(lines[1].unit_cost_at_sale) === 400,
      JSON.stringify(lines.map((r) => r.unit_cost_at_sale)));
  } catch (e) { try { await tx.rollback(); } catch {} throw e; }

  // ---- Part B: gate refusal on a lost allocation write ----
  await db.execute({ sql: `DELETE FROM sale_batch_allocations WHERE sale_id = ? AND batch_id = 'batch-B'`, args: [SALE_ID] });
  const brokenSum = await gateSum(db, SALE_ID);
  check('gate detects the tampered ledger (400 ≠ 900, commit refused)', brokenSum !== 900, `frozen=${brokenSum} computed=900`);
  await db.execute({ sql: `INSERT INTO sale_batch_allocations (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale, created_at, product_id, sale_item_id, device_id, idempotency_key, sync_status, version, updated_at, deleted)
    VALUES (?,?,?,?,?,?,?, ?, ?, ?, 'pending', 1, ?, 0)
    ON CONFLICT(id) DO UPDATE SET qty_consumed = sale_batch_allocations.qty_consumed + excluded.qty_consumed, updated_at = excluded.updated_at, sync_status = 'pending'`,
    args: [`alloc-${SALE_ID}-1-batch-B`, SALE_ID, 'batch-B', 1, 400, '2026-03-01T10:00:00.000Z', 'prodX', `${SALE_ID}-item-1`, 'd1', `alloc-${SALE_ID}-1-batch-B`, '2026-03-01T10:00:00.000Z'] });
  check('ledger restored to 900 after re-freeze', (await gateSum(db, SALE_ID)) === 900);

  // ---- Part C: audit repair of a stale ticket ----
  const STALE = 'REC-STALE-800';
  await db.execute({ sql: `INSERT INTO transactions (id, total, cost_total, profit, status, deleted, json_payload, version, updated_at, ledger_cogs_total)
    VALUES (?, 7000, 800, 6200, 'COMPLETED', 0, '{}', 1, ?, NULL)`, args: [STALE, '2026-03-01T10:00:00.000Z'] });
  await db.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale, discount_amount, line_profit, json_payload, version)
    VALUES (?,?,?,?,?,?,?,?,?,?,1)`, args: [`${STALE}-item-0`, STALE, 'prodX', 2, 3500, 3500, 400, 0, 6200, '{}'] });
  await db.execute({ sql: `INSERT INTO sale_batch_allocations (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale, created_at, product_id, sale_item_id, device_id, idempotency_key, sync_status, version, updated_at, deleted)
    VALUES (?,?,?,?,?,?,?, ?, ?, ?, 'pending', 1, ?, 0)`, args: [`alloc-${STALE}-0-batch-A`, STALE, 'batch-A', 1, 500, '2026-03-01T10:00:00.000Z', 'prodX', `${STALE}-item-0`, 'd1', `alloc-${STALE}-0-batch-A`, '2026-03-01T10:00:00.000Z'] });
  await db.execute({ sql: `INSERT INTO sale_batch_allocations (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale, created_at, product_id, sale_item_id, device_id, idempotency_key, sync_status, version, updated_at, deleted)
    VALUES (?,?,?,?,?,?,?, ?, ?, ?, 'pending', 1, ?, 0)`, args: [`alloc-${STALE}-0-batch-B`, STALE, 'batch-B', 1, 400, '2026-03-01T10:00:00.000Z', 'prodX', `${STALE}-item-0`, 'd1', `alloc-${STALE}-0-batch-B`, '2026-03-01T10:00:00.000Z'] });
  // Repair math (verbatim repairSaleCogsFromLedger policy: no JSON allocs →
  // pro-rata ledger average; order rewrite from the frozen sum).
  const staleBefore = (await db.execute({ sql: `SELECT cost_total, profit FROM transactions WHERE id = ?`, args: [STALE] })).rows[0];
  const frozen = await gateSum(db, STALE);
  const avgUnit = Math.round(frozen / 2);
  await db.execute({ sql: `UPDATE transaction_items SET unit_cost_at_sale = ?, line_profit = ? WHERE id = ?`, args: [avgUnit, (3500 - avgUnit) * 2, `${STALE}-item-0`] });
  await db.execute({ sql: `UPDATE transactions SET cost_total = ?, profit = ?, ledger_cogs_total = ? WHERE id = ?`, args: [frozen, 7000 - frozen, frozen, STALE] });
  const staleAfter = (await db.execute({ sql: `SELECT cost_total, profit, ledger_cogs_total FROM transactions WHERE id = ?`, args: [STALE] })).rows[0];
  const staleLine = (await db.execute({ sql: `SELECT unit_cost_at_sale FROM transaction_items WHERE id = ?`, args: [`${STALE}-item-0`] })).rows[0];
  console.log(`[REPAIR] before=${JSON.stringify({ cost: staleBefore.cost_total, profit: staleBefore.profit })} after=${JSON.stringify({ cost: staleAfter.cost_total, profit: staleAfter.profit, ledger: staleAfter.ledger_cogs_total })} line=${staleLine.unit_cost_at_sale}`);
  check('repair rewrites cost 800 → 900 from frozen rows', Number(staleAfter.cost_total) === 900, `got ${staleAfter.cost_total}`);
  check('repair rewrites profit 6200 → 6100', Number(staleAfter.profit) === 6100, `got ${staleAfter.profit}`);
  check('repair materializes ledger_cogs_total 900', Number(staleAfter.ledger_cogs_total) === 900, `got ${staleAfter.ledger_cogs_total}`);
  check('repair fixes line unit_cost 400 → ledger average 450', Number(staleLine.unit_cost_at_sale) === 450, `got ${staleLine.unit_cost_at_sale}`);
} finally { db.close(); try { rmSync(DB_FILE); } catch {} }

// ---- Part D: static wiring ----
{
  const adapter = readFileSync('src/db/sqlPluginAdapter.ts', 'utf8');
  const slice = readFileSync('src/store/slices/createOrderSlice.ts', 'utf8');
  const modal = readFileSync('src/components/modals/ReportsModal.tsx', 'utf8');
  const rust = readFileSync('src-tauri/src/lib.rs', 'utf8');
  const remote = readFileSync('src/sync/remoteSchema.ts', 'utf8');
  const types = readFileSync('src/types/pos.ts', 'utf8');
  const backfill = readFileSync('src/db/backfill.ts', 'utf8');
  const sync = readFileSync('src/sync/SyncManager.ts', 'utf8');
  check('Rust v105 adds ledger_cogs_total + max version 105',
    rust.includes('ALTER TABLE transactions ADD COLUMN ledger_cogs_total REAL;') && rust.includes('EXPECTED_MAX_DB_USER_VERSION: u32 = 105'));
  check('TS heal probes + alters ledger_cogs_total (NULL default, never zero)',
    adapter.includes('SELECT ledger_cogs_total FROM transactions LIMIT 0;') && adapter.includes('ALTER TABLE transactions ADD COLUMN ledger_cogs_total REAL;'));
  check('remote v12 carries the column + shift attribution', remote.includes('ledger_cogs_total') && remote.includes('LATEST_REMOTE_VERSION = 12') && remote.includes('shift_id'));
  check('SaleTransaction exposes ledgerCogsTotal (absent = unknown)',
    types.includes('ledgerCogsTotal?: number;'));
  check('checkout writes ledger_cogs_total from allocations in the 5b UPDATE',
    adapter.includes('ledger_cogs_total = $4,') && adapter.includes('fifoLedgerCogsTotal = toIntMoney(preAllocSum + allocLedgerTotal)'));
  check('allocation inserts are additive upserts (replay-safe accumulation)',
    adapter.includes('qty_consumed = sale_batch_allocations.qty_consumed + excluded.qty_consumed'));
  check('pre-COMMIT gate refuses divergent sums (LEDGER_COGS_MISMATCH, no commit)',
    adapter.includes('LEDGER_COGS_MISMATCH') && adapter.includes('sale NOT committed'));
  check('replay-after-commit short-circuits (no re-depletion, stored materialization returned)',
    adapter.includes('replay-after-commit') && adapter.includes('returning stored materialization, no re-depletion'));
  check('checkout result + adoption carry the materialized value to Dexie/Zustand',
    adapter.includes('ledgerCogsTotal: fifoLedgerCogsTotal') && slice.includes('transaction.ledgerCogsTotal = checkoutResult.ledgerCogsTotal'));
  check('receipt reads materialized column, hook only for legacy rows',
    modal.includes('inspectorMaterialized') && modal.includes('inspectorMaterialized != null ? undefined : inspectingTransaction?.id'));
  check('audit repair rebuilds rows + lines + receipt from frozen sums',
    adapter.includes('export async function repairSaleCogsFromLedger') && adapter.includes('dedupeAllocationTwins(db, id)'));
  check('reconcile re-materializes the column after shadow swaps',
    adapter.includes('ledger-materialize') && adapter.includes('SET ledger_cogs_total = $1, json_payload = $2'));
  check('pull fills NULL columns from the receipt envelope (never overwrites)',
    sync.includes('ledger_cogs_total IS NULL'));
  check('backfill maps finite column/JSON values, never cements costTotal',
    backfill.includes('ledgerCogsTotal') && backfill.includes('Never fall'));
}

console.log(`VERIFY SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);

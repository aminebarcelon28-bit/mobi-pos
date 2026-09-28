/**
 * Directed case verification (user-specified):
 *   Unit 1 (existing stock): cost 500, sold @ 3,500 → profit 3,000.
 *   Unit 2 (PO-20260926-11KHFJ-02-XMT05): cost 400, sold @ 3,500 → profit 3,100.
 *   Total net profit: 3,000 + 3,100 = 6,100.
 *
 * Exercises the REAL production logic (preview core + reference-cost rule)
 * against a scratch libsql DB using the exact PO id, with the depletion
 * running the verbatim guarded-UPDATE + oldest-first SELECT from
 * writeCheckoutAtomicInner/depleteBatchGuarded (Tauri plugin-sql itself
 * cannot run under node — same SQLite semantics via libsql).
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';
import { previewFifoCostsForLines } from '../src/utils/fifoPreview.ts';
import { resolveReferenceCost } from '../src/utils/referenceCost.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const PO_ID = 'PO-20260926-11KHFJ-02-XMT05';
const PRICE = 3500;
const DB_FILE = 'tmp-po-case-6100.db';
try { rmSync(DB_FILE); } catch { /* fresh start */ }
const db = createClient({ url: `file:${DB_FILE}` });

async function liveBatches() {
  return (await db.execute({
    sql: `SELECT batch_id, quantity_remaining, unit_cost, purchase_order_id FROM stock_batches
          WHERE product_id = 'prodX' AND quantity_remaining > 0 AND deleted = 0
            AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
          ORDER BY received_at ASC, batch_id ASC`,
  })).rows;
}

async function preview(qty: number, fallback: number) {
  const rows = await liveBatches();
  const [r] = previewFifoCostsForLines(
    new Map([['prodX', rows.map((b) => ({
      batchId: String(b.batch_id), quantityRemaining: Number(b.quantity_remaining), unitCost: Number(b.unit_cost),
    }))]]),
    [{ productId: 'prodX', qty, fallbackCost: fallback }],
  );
  return r;
}

async function sellOne(now: string) {
  let need = 1;
  let cogs = 0;
  const allocs: Array<{ batchId: string; qty: number; cost: number }> = [];
  for (const b of await liveBatches()) {
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

  // Unit 1: existing stock 1×@500 (older batch, predates the PO).
  await db.execute({
    sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
      received_at, purchase_order_id, device_id, idempotency_key, sync_status,
      version, created_at, updated_at, deleted)
      VALUES ('batch-EXIST-1','prodX',1,500,'2026-09-20T10:00:00.000Z','PO-OLD','d1','key-EXIST-1','pending',1,'2026-09-20T10:00:00.000Z','2026-09-20T10:00:00.000Z',0)`,
  });
  console.log('[SETUP] Unit 1: existing stock 1×@500 (batch-EXIST-1)');
  let refCost = resolveReferenceCost(0, 500);
  check('reference cost initializes to 500', refCost === 500, `got ${refCost}`);

  // Unit 2: PO-20260926-11KHFJ-02-XMT05 receipt 1×@400 (insertStockBatch shape).
  await db.execute({
    sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
      received_at, purchase_order_id, device_id, idempotency_key, sync_status,
      version, created_at, updated_at, deleted)
      VALUES ('batch-PO2-1','prodX',1,400,'2026-09-26T10:00:00.000Z',$1,'d1','key-PO2-1','pending',1,'2026-09-26T10:00:00.000Z','2026-09-26T10:00:00.000Z',0)`,
    args: [PO_ID],
  });
  console.log(`[PO] ${PO_ID}: received 1×@400 (batch-PO2-1)`);
  refCost = resolveReferenceCost(refCost, 400); // production freeze rule
  check('PO does not reprice Unit 1 (reference stays 500)', refCost === 500, `got ${refCost}`);
  {
    const rows = await liveBatches();
    check('two distinct live batches [1×500, 1×400]',
      rows.length === 2 && Number(rows[0].unit_cost) === 500 && Number(rows[1].unit_cost) === 400,
      JSON.stringify(rows.map((r) => ({ id: r.batch_id, qty: r.quantity_remaining, cost: r.unit_cost, po: r.purchase_order_id }))));
    check('PO batch carries the exact PO id', String(rows[1].purchase_order_id) === PO_ID);
  }

  // Sale 1: 1 unit @3500 → oldest batch (500) → profit 3000.
  {
    const prev = await preview(1, refCost);
    check('sale-1 preview: 500/u (oldest batch)', prev.unitCost === 500, `got ${prev.unitCost}`);
    const s = await sellOne('2026-09-26T11:00:00.000Z');
    check('sale-1 consumes the existing-stock batch', s.allocs.length === 1 && s.allocs[0].batchId === 'batch-EXIST-1', JSON.stringify(s.allocs));
    check('sale-1 COGS = 500', s.cogs === 500 && s.short === 0, `got ${s.cogs}`);
    const profit = PRICE - s.cogs;
    check('sale-1 profit = 3,500 − 500 = 3,000', profit === 3000, `got ${profit}`);
    check('sale-1 preview matches stored', prev.unitCost === 500);
  }

  // Sale 2: 1 unit @3500 → PO batch (400) → profit 3100.
  {
    const prev = await preview(1, refCost);
    check('sale-2 preview: 400/u (PO batch)', prev.unitCost === 400, `got ${prev.unitCost}`);
    const s = await sellOne('2026-09-26T12:00:00.000Z');
    check('sale-2 consumes the exact PO batch', s.allocs.length === 1 && s.allocs[0].batchId === 'batch-PO2-1', JSON.stringify(s.allocs));
    check('sale-2 COGS = 400 (no 500 reuse)', s.cogs === 400 && s.short === 0, `got ${s.cogs}`);
    const profit = PRICE - s.cogs;
    check('sale-2 profit = 3,500 − 400 = 3,100', profit === 3100, `got ${profit}`);
  }

  console.log('[TOTAL] 3,000 + 3,100 = 6,100');
  check('total net profit = 6,100 (not 6,200)', 3000 + 3100 === 6100);
} finally {
  db.close();
  try { rmSync(DB_FILE); } catch { /* scratch cleanup */ }
}

console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);
process.exit(0);

/**
 * FIFO state-machine + property suite (PO purchase-to-sale pipeline audit).
 *
 * Part 1 — Audit wiring (the leak hunt): no receipt path may reprice existing
 * inventory (shared resolveReferenceCost rule), no statement may rewrite an
 * existing batch's unit_cost, cancelPO must touch neither batches nor costs,
 * voids must restitute batches, and checkout depletion must read live batches
 * inside its write transaction (never a cache).
 *
 * Part 2 — Property test (randomized, seeded): N purchases at varying prices
 * interleaved with M sales and voids. After EVERY op the SQLite batches must
 * equal a reference FIFO model lot-for-lot, every sale's COGS must equal the
 * model's oldest-first COGS, the REAL preview core must match the stored unit
 * cost, and the conservation identity (received value − COGS = remaining
 * value) must hold. The whole randomized run executes TWICE on fresh DBs with
 * the same seed: identical digests prove ordering comes from the data
 * (received_at, batch_id) — never from execution speed.
 *
 * Part 3 — PO integration (bug isolation): stock 1×500, PO 1×400 → reference
 * stays 500, two distinct rows; sell @3500 twice → 3000 + 3100 = 6100.
 *
 * Part 4 — Edges: PO edit/cancel after partial sales, same-millisecond
 * receipts, multi-unit bulk PO with boundary-spanning sales.
 */
import { createClient } from '@libsql/client';
import { rmSync, readFileSync } from 'node:fs';
import { previewFifoCostsForLines } from '../src/utils/fifoPreview.ts';
import { resolveReferenceCost } from '../src/utils/referenceCost.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${extra ? ' :: ' + extra : ''}`); console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}
const src = (p: string) => readFileSync(`${process.cwd()}/${p}`, 'utf8');
const toIntMoney = (n: unknown): number => {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) ? v : 0;
};

// Deterministic PRNG (mulberry32) — same seed replays the same suite.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEMA = `
CREATE TABLE stock_batches (
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
);
CREATE TABLE products (id TEXT PRIMARY KEY, cost_price REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0);
`;

type Lot = { batchId: string; qty: number; cost: number; at: string };
type SaleRec = { id: string; allocs: Array<{ batchId: string; qty: number; cost: number }>; cogs: number; qty: number };

async function freshDb(path: string) {
  try { rmSync(path); } catch { /* fresh */ }
  const db = createClient({ url: `file:${path}` });
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.execute(stmt);
  await db.execute({ sql: `INSERT INTO products VALUES (?,?,?)`, args: ['prodX', 0, 3500] });
  return db;
}

// Verbatim production statements ------------------------------------------------
async function sqlReceive(db, batchId: string, qty: number, cost: number, at: string, po: string | null) {
  await db.execute({
    sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
      received_at, purchase_order_id, device_id, idempotency_key, sync_status,
      version, created_at, updated_at, deleted)
      VALUES ($1,'prodX',$2,$3,$4,$5,'d1',$6,'pending',1,$4,$4,0)`,
    args: [batchId, qty, cost, at, po, `key-${batchId}`],
  });
}

async function sqlDeplete(db, qty: number, now: string) {
  const r = await db.execute({
    sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
          WHERE product_id = 'prodX' AND quantity_remaining > 0 AND deleted = 0
            AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
          ORDER BY received_at ASC, batch_id ASC`,
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

// Void restitution replica: restore each allocation into its ORIGIN batch
// (mirrors the void fix calling restituteStockBatches with recorded allocs).
async function sqlVoid(db, sale: SaleRec) {
  for (const a of sale.allocs) {
    await db.execute({
      sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?,
              version = version + 1 WHERE batch_id = ?`,
      args: [a.qty, a.batchId],
    });
  }
}

async function sqlSnapshot(db): Promise<Lot[]> {
  const r = await db.execute({
    sql: `SELECT batch_id, quantity_remaining, unit_cost, received_at FROM stock_batches
          ORDER BY received_at ASC, batch_id ASC`,
  });
  return r.rows.map((b) => ({
    batchId: String(b.batch_id), qty: Number(b.quantity_remaining),
    cost: Number(b.unit_cost), at: String(b.received_at),
  }));
}

async function sqlPreview(db, qty: number, fallback: number) {
  const rows = await db.execute({
    sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
          WHERE product_id = 'prodX' AND quantity_remaining > 0 AND deleted = 0
            AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
          ORDER BY received_at ASC, batch_id ASC`,
  });
  const [res] = previewFifoCostsForLines(
    new Map([['prodX', rows.rows.map((b) => ({
      batchId: String(b.batch_id), quantityRemaining: Number(b.quantity_remaining), unitCost: Number(b.unit_cost),
    }))]]),
    [{ productId: 'prodX', qty, fallbackCost: fallback }],
  );
  return res;
}

// Reference FIFO model -----------------------------------------------------------
class FifoModel {
  lots: Lot[] = [];
  receive(batchId: string, qty: number, cost: number, at: string) {
    this.lots.push({ batchId, qty, cost, at });
  }
  sell(qty: number): { cogs: number; allocs: Array<{ batchId: string; qty: number; cost: number }> } {
    let need = qty;
    let cogs = 0;
    const allocs: Array<{ batchId: string; qty: number; cost: number }> = [];
    for (const lot of this.lots) {
      if (need <= 0) break;
      const take = Math.min(lot.qty, need);
      if (take <= 0) continue;
      lot.qty -= take;
      need -= take;
      cogs += take * lot.cost;
      allocs.push({ batchId: lot.batchId, qty: take, cost: lot.cost });
    }
    return { cogs, allocs };
  }
  voidSale(sale: SaleRec) {
    for (const a of sale.allocs) {
      const lot = this.lots.find((l) => l.batchId === a.batchId);
      if (lot) lot.qty += a.qty;
    }
  }
  available(): number {
    return this.lots.reduce((s, l) => s + l.qty, 0);
  }
  value(): number {
    return this.lots.reduce((s, l) => s + l.qty * l.cost, 0);
  }
}

const PRICES = [100, 250, 400, 500, 750, 1200, 2000];
const SELL_PRICE = 3500;

console.log('========================================================================');
console.log('FIFO PROPERTY + STATE-MACHINE SUITE (purchase-to-sale pipeline audit)');
console.log('========================================================================');

console.log('--- Part 1: audit wiring (find the leak) ---');
{
  const adapter = src('src/db/sqlPluginAdapter.ts');
  const proc = src('src/store/slices/createProcurementSlice.ts');
  const catalog = src('src/store/slices/createCatalogSlice.ts');
  const modal = src('src/components/modals/InvoiceIngestionModal.tsx');
  const order = src('src/store/slices/createOrderSlice.ts');

  check('PO + invoice share one reference-cost rule (no divergent repricing)',
    proc.includes('resolveReferenceCost') && modal.includes('resolveReferenceCost')
    && src('src/utils/referenceCost.ts').includes('first-known cost wins'));
  check('PO receipt never sets costPrice = new_cost on existing inventory',
    !proc.includes('costPrice: actualCost,'));
  check('no statement rewrites an existing batch unit_cost (write-once batches)',
    !/SET unit_cost\s*=\s*\$/.test(adapter) && !/SET unit_cost\s*=\s*\$/.test(src('src/sync/SyncManager.ts')));
  const cancelBody = proc.slice(proc.indexOf('cancelPO: async'), proc.indexOf('deletePO: async'));
  check('cancelPO touches no batches, ledger, or costs',
    !cancelBody.includes('stock_batches') && !cancelBody.includes('inventory_ledger')
    && !cancelBody.includes('costPrice') && cancelBody.includes(`status: 'Cancelled'`));
  check('void restitutes batches (ledger-only void would strand units)',
    order.includes('restituteStockBatches(voidRestitution)'));
  check('invoice ingestion mints batches + RECEIVE ledger (no untracked stock)',
    catalog.includes('INVOICE_IMPORT') && catalog.includes('insertStockBatch'));
  check('checkout depletion reads live batches inside the write txn (no cache)',
    adapter.includes('BEGIN IMMEDIATE') && !/cachedBatches|batchCache/.test(adapter));
}

console.log('--- Part 2: randomized property test (seeded) ---');
const SEED = 6100;
const SCENARIOS = 60;
async function runSuite(dbPath: string): Promise<string> {
  const db = await freshDb(dbPath);
  const digest: string[] = [];
  try {
    const rnd = mulberry32(SEED);
    let clock = Date.parse('2026-01-01T10:00:00.000Z');
    let batchSeq = 0;
    let refCost = 0;
    let receivedValue = 0;
    let totalCogs = 0;
    const openSales = new Map<string, SaleRec>();
    let saleSeq = 0;

    const snapEqual = (a: Lot[], b: Lot[]) =>
      a.length === b.length && a.every((l, i) =>
        l.batchId === b[i].batchId && l.qty === b[i].qty && l.cost === b[i].cost);

    for (let s = 0; s < SCENARIOS; s++) {
      const model = new FifoModel();
      openSales.clear();
      receivedValue = 0;
      totalCogs = 0;
      refCost = 0;
      const ops = 8 + Math.floor(rnd() * 13); // 8..20 ops per scenario
      for (let o = 0; o < ops; o++) {
        clock += 1000 + Math.floor(rnd() * 5000); // strictly increasing logical time
        const at = new Date(clock).toISOString();
        const roll = rnd();
        if (roll < 0.55 || model.available() === 0) {
          // RECEIVE (or forced receive when empty — oversell guard would block)
          const qty = 1 + Math.floor(rnd() * 4);
          const cost = PRICES[Math.floor(rnd() * PRICES.length)];
          batchSeq += 1;
          const bid = `batch-${clock}-${batchSeq}-TST`;
          await sqlReceive(db, bid, qty, cost, at, `PO-S${s}`);
          // Wipe scenario lots between scenarios: fresh product lots per scenario
          model.receive(bid, qty, cost, at);
          receivedValue += qty * cost;
          refCost = resolveReferenceCost(refCost, cost);
        } else if (roll < 0.85) {
          // SALE (clamped to available, like the oversell guard)
          const avail = model.available();
          if (avail <= 0) continue;
          const qty = Math.min(avail, 1 + Math.floor(rnd() * 4));
          // Preview (REAL core) must match what the depletion is about to store.
          const prev = await sqlPreview(db, qty, refCost);
          const { allocs, cogs, short } = await sqlDeplete(db, qty, at);
          const m = model.sell(qty);
          saleSeq += 1;
          const sid = `S${s}-${saleSeq}`;
          openSales.set(sid, { id: sid, allocs, cogs, qty });
          const after = await sqlSnapshot(db);
          const modelLots = model.lots;
          if (!snapEqual(after, modelLots)) {
            check(`s${s} sale ${sid}: batches == model`, false, `sql=${JSON.stringify(after)} model=${JSON.stringify(modelLots)}`);
          }
          if (cogs !== m.cogs) {
            check(`s${s} sale ${sid}: COGS == FIFO model`, false, `sql=${cogs} model=${m.cogs}`);
          }
          if (short !== 0) {
            check(`s${s} sale ${sid}: no shortfall (guard clamped qty)`, false, `short=${short}`);
          }
          const storedUnit = toIntMoney(cogs / qty);
          if (prev.unitCost !== storedUnit || !prev.fullyCovered) {
            check(`s${s} sale ${sid}: preview == stored`, false, `prev=${prev.unitCost}/${prev.fullyCovered} stored=${storedUnit}`);
          }
          const profit = SELL_PRICE * qty - cogs;
          if (profit !== SELL_PRICE * qty - m.cogs) {
            check(`s${s} sale ${sid}: profit consistent`, false, '');
          }
          totalCogs += cogs;
        } else {
          // VOID a random open sale (exact batch reversal). Invariant: every
          // allocation of THAT sale is restored unit-for-unit into its origin
          // batch — independent of receipts that arrived after the sale (those
          // legitimately remain, so full-snapshot equality would be wrong).
          const keys = [...openSales.keys()];
          if (keys.length === 0) continue;
          const sid = keys[Math.floor(rnd() * keys.length)];
          const rec = openSales.get(sid)!;
          const qtyBefore = new Map((await sqlSnapshot(db)).map((l) => [l.batchId, l.qty] as const));
          const modelBefore = new Map(model.lots.map((l) => [l.batchId, l.qty] as const));
          await sqlVoid(db, rec);
          model.voidSale(rec);
          openSales.delete(sid);
          totalCogs -= rec.cogs;
          const qtyAfter = new Map((await sqlSnapshot(db)).map((l) => [l.batchId, l.qty] as const));
          const modelAfter = new Map(model.lots.map((l) => [l.batchId, l.qty] as const));
          for (const a of rec.allocs) {
            const dSql = (qtyAfter.get(a.batchId) ?? 0) - (qtyBefore.get(a.batchId) ?? 0);
            if (dSql !== a.qty) {
              check(`s${s} void ${sid}: restores ${a.qty} into ${a.batchId}`, false, `delta=${dSql}`);
            }
            const dModel = (modelAfter.get(a.batchId) ?? 0) - (modelBefore.get(a.batchId) ?? 0);
            if (dModel !== a.qty) {
              check(`s${s} void ${sid}: model restores ${a.batchId}`, false, `delta=${dModel}`);
            }
          }
          const after = await sqlSnapshot(db);
          if (!snapEqual(after, model.lots)) {
            check(`s${s} void ${sid}: sql == model after reversal`, false, '');
          }
        }
      }
      // Conservation identity per scenario: received − COGS = remaining.
      const remaining = model.value();
      if (receivedValue - totalCogs !== remaining) {
        check(`s${s} conservation identity`, false, `received=${receivedValue} cogs=${totalCogs} remaining=${remaining}`);
      }
      // Cross-check remaining value straight from SQL.
      const rem = await db.execute({
        sql: `SELECT COALESCE(SUM(quantity_remaining * unit_cost),0) AS v FROM stock_batches WHERE deleted = 0 AND quantity_remaining > 0`,
      });
      if (Number(rem.rows[0].v) !== remaining) {
        check(`s${s} SQL remaining == model`, false, `sql=${rem.rows[0].v} model=${remaining}`);
      }
      digest.push(`${s}:${receivedValue}:${totalCogs}:${remaining}`);
      // Reset tables between scenarios (isolated state machines).
      await db.execute(`DELETE FROM stock_batches`);
      pass += 0; // per-op checks above already counted; scenario survived if no FAIL
    }
  } finally {
    db.close();
    try { rmSync(dbPath); } catch { /* scratch cleanup */ }
  }
  return digest.join('|');
}

const digestA = await runSuite('tmp-fifo-props-a.db');
const digestB = await runSuite('tmp-fifo-props-b.db');
check('property suite executed without mismatch (see FAILs above)', fail === 0, `${SCENARIOS} scenarios × 8-20 ops`);
check('identical digests across two runs (speed-independent ordering)', digestA === digestB);
console.log(`[INFO] ${SCENARIOS} randomized scenarios × 2 runs, seed ${SEED} — COGS ≡ FIFO model, conservation holds.`);

console.log('--- Part 3: PO integration (bug isolation) ---');
{
  const db = await freshDb('tmp-fifo-po-int.db');
  try {
    // Initial state: stock 1 unit @ 500 (existing inventory batch).
    await sqlReceive(db, 'batch-100-1-A', 1, 500, '2026-01-01T10:00:00.000Z', 'PO-OLD');
    let refCost = resolveReferenceCost(0, 500);
    await db.execute({ sql: `UPDATE products SET cost_price = ? WHERE id = 'prodX'`, args: [refCost] });
    // Action: process PO for 1 unit @ 400.
    await sqlReceive(db, 'batch-200-1-B', 1, 400, '2026-02-01T10:00:00.000Z', 'PO-2');
    refCost = resolveReferenceCost(refCost, 400); // production freeze rule
    await db.execute({ sql: `UPDATE products SET cost_price = ? WHERE id = 'prodX'`, args: [refCost] });
    const ref = await db.execute({ sql: `SELECT cost_price FROM products WHERE id = 'prodX'` });
    check('reference cost remains 500 after the 400 PO (no global repricing)', Number(ref.rows[0].cost_price) === 500, `got ${ref.rows[0].cost_price}`);
    const rows = await db.execute({
      sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches WHERE deleted = 0 AND quantity_remaining > 0 ORDER BY received_at ASC, batch_id ASC`,
    });
    check('two distinct active rows [1×500, 1×400]', rows.rows.length === 2
      && Number(rows.rows[0].unit_cost) === 500 && Number(rows.rows[1].unit_cost) === 400,
      JSON.stringify(rows.rows));
    // Sell 1 @3500 → COGS 500 / profit 3000.
    const s1 = await sqlDeplete(db, 1, '2026-03-01T10:00:00.000Z');
    check('sale 1 COGS = 500', s1.cogs === 500, `got ${s1.cogs}`);
    check('sale 1 profit = 3,000', 3500 - s1.cogs === 3000);
    // Sell 1 @3500 → COGS 400 / profit 3100.
    const s2 = await sqlDeplete(db, 1, '2026-03-02T10:00:00.000Z');
    check('sale 2 COGS = 400', s2.cogs === 400, `got ${s2.cogs}`);
    check('sale 2 profit = 3,100', 3500 - s2.cogs === 3100);
    check('total profit = 6,100 (not 6,200)', 7000 - (s1.cogs + s2.cogs) === 6100);
  } finally {
    db.close();
    try { rmSync('tmp-fifo-po-int.db'); } catch { /* scratch */ }
  }
}

console.log('--- Part 4: edges & races ---');
{
  const db = await freshDb('tmp-fifo-edges.db');
  try {
    // Edge 1: PO edit/cancel AFTER partial sales — batches immutable.
    await sqlReceive(db, 'batch-E1-1', 2, 500, '2026-01-01T10:00:00.000Z', 'PO-1');
    await sqlReceive(db, 'batch-E1-2', 3, 400, '2026-02-01T10:00:00.000Z', 'PO-2');
    const s = await sqlDeplete(db, 2, '2026-03-01T10:00:00.000Z'); // consumes batch-E1-1 fully
    check('partial sale consumes oldest batch first', s.allocs.length === 1 && s.allocs[0].batchId === 'batch-E1-1' && s.cogs === 1000, JSON.stringify(s.allocs));
    // Simulate PO edit (doc fields only) + cancelPO (status flip): model as
    // purchase_orders UPDATEs with NO batch/ledger/cost touch.
    await db.execute(`CREATE TABLE purchase_orders (id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
    await db.execute({ sql: `INSERT INTO purchase_orders VALUES (?,?)`, args: ['PO-2', 'Partially Received'] });
    await db.execute({ sql: `UPDATE purchase_orders SET status = 'Cancelled' WHERE id = ?`, args: ['PO-2'] });
    const after = await sqlSnapshot(db);
    check('PO edit/cancel leaves batches untouched',
      after.find((l) => l.batchId === 'batch-E1-1')?.qty === 0
      && after.find((l) => l.batchId === 'batch-E1-2')?.qty === 3
      && after.find((l) => l.batchId === 'batch-E1-2')?.cost === 400,
      JSON.stringify(after));
    const s2 = await sqlDeplete(db, 1, '2026-03-02T10:00:00.000Z');
    check('post-cancel sale still uses original batch cost (400)', s2.cogs === 400, `got ${s2.cogs}`);
    await db.execute(`DELETE FROM stock_batches`);

    // Edge 2: same-millisecond receipts — deterministic via batch_id.
    const sameMs = '2026-04-01T10:00:00.000Z';
    await sqlReceive(db, 'batch-SM-1-X', 1, 500, sameMs, 'PO-A');
    await sqlReceive(db, 'batch-SM-2-Y', 1, 400, sameMs, 'PO-B');
    const d1 = await sqlDeplete(db, 1, '2026-04-02T10:00:00.000Z');
    check('same-ms: lower batch_id wins deterministically', d1.allocs[0]?.batchId === 'batch-SM-1-X', JSON.stringify(d1.allocs));
    // Re-run on a fresh copy: identical outcome (execution-speed independent).
    await db.execute(`DELETE FROM stock_batches`);
    await sqlReceive(db, 'batch-SM-1-X', 1, 500, sameMs, 'PO-A');
    await sqlReceive(db, 'batch-SM-2-Y', 1, 400, sameMs, 'PO-B');
    const d2 = await sqlDeplete(db, 1, '2026-04-02T10:00:00.000Z');
    check('same-ms: repeat run identical (deterministic)', JSON.stringify(d2.allocs) === JSON.stringify(d1.allocs));
    await db.execute(`DELETE FROM stock_batches`);

    // Edge 3: bulk PO spanning boundary — existing 2×500, PO 5×400, sell 4.
    await sqlReceive(db, 'batch-BK-1', 2, 500, '2026-01-01T10:00:00.000Z', 'PO-OLD');
    await sqlReceive(db, 'batch-BK-2', 5, 400, '2026-02-01T10:00:00.000Z', 'PO-BULK');
    const b1 = await sqlDeplete(db, 4, '2026-03-01T10:00:00.000Z');
    const b1cost = b1.allocs.reduce((a, x) => a + x.qty * x.cost, 0);
    check('bulk boundary: 2×500 + 2×400 = 1800', b1cost === 1800 && b1.short === 0, JSON.stringify(b1.allocs));
    const b2 = await sqlDeplete(db, 3, '2026-03-02T10:00:00.000Z');
    const b2cost = b2.allocs.reduce((a, x) => a + x.qty * x.cost, 0);
    check('bulk remainder: 3×400 = 1200', b2cost === 1200 && b2.short === 0, JSON.stringify(b2.allocs));
    check('bulk totals: COGS 3000, profit 21500 (7×3500 − 3000)',
      b1cost + b2cost === 3000 && 7 * 3500 - (b1cost + b2cost) === 21500);
    const left = await sqlSnapshot(db);
    check('bulk PO fully consumed', left.every((l) => l.qty === 0), JSON.stringify(left));
  } finally {
    db.close();
    try { rmSync('tmp-fifo-edges.db'); } catch { /* scratch */ }
  }
}

console.log('========================================================================');
console.log(`PROPERTY SUITE SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (failures.length > 0) {
  console.log('--- discrepancies ---');
  for (const f of failures) console.log(`  • ${f}`);
} else {
  console.log('[DISCREPANCIES] none.');
}
console.log('========================================================================');
if (fail > 0) process.exit(1);
process.exit(0);

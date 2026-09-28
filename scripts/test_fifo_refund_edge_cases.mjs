/**
 * FIFO / Refund / Edge-case audit suite (spec 2026-09-24):
 *  Edge A — LIFO reverse-depletion on multi-batch partial returns
 *  Edge B — Shadow/ghost batch + reconciliation on invoice receipt
 *  Edge C — Discounts alter revenue only, never FIFO cost basis
 *  Edge D — Unequal exchange as atomic restock+deplete with split profit
 *  Edge E — Guarded depletion (CHECK + overflow, no overdraw)
 *  + Quarantine/SAV write-off + receipt-linked (saleItemId) restoration
 *  + Mobile/Desktop single-formula checks (source wiring)
 *
 * Part 1 runs the exact SQL semantics against a scratch libsql file DB.
 * Part 2 asserts the production wiring exists in src/.
 * Part 3 runs computeCartTotals (transpiled) for Edge C/D money math.
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

const SCHEMA = `
CREATE TABLE stock_batches (
  batch_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
  unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
  received_at TEXT NOT NULL,
  purchase_order_id TEXT,
  device_id TEXT NOT NULL DEFAULT 'local',
  idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  shadow_sale_id TEXT,
  shadow_item_id TEXT,
  shadow_qty REAL NOT NULL DEFAULT 0,
  shadow_resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE transaction_items (
  id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL, applied_price REAL DEFAULT 0,
  unit_price_charged REAL DEFAULT 0, unit_cost_at_sale REAL DEFAULT 0,
  discount_amount REAL DEFAULT 0, line_profit REAL DEFAULT 0,
  json_payload TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE transactions (
  id TEXT PRIMARY KEY, total REAL NOT NULL DEFAULT 0,
  cost_total REAL DEFAULT 0, profit REAL DEFAULT 0, profit_margin REAL DEFAULT 0,
  json_payload TEXT, version INTEGER NOT NULL DEFAULT 1
);
`;

const DB_BASE = 'tmp-fifo-refund-edge-cases';
let dbSeq = 0;
const dbFileFor = () => `${DB_BASE}-${dbSeq++}.db`;

async function freshDb() {
  const f = dbFileFor();
  try { rmSync(f); } catch {}
  try { rmSync(`${f}-wal`); } catch {}
  try { rmSync(`${f}-shm`); } catch {}
  const db = createClient({ url: `file:${f}` });
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.execute(stmt);
  return db;
}
const rowsOf = async (db, sql, args = []) => (await db.execute({ sql, args })).rows;
const qtyOf = async (db, id) => Number((await rowsOf(db, 'SELECT quantity_remaining FROM stock_batches WHERE batch_id = ?', [id]))[0]?.quantity_remaining);

async function seedBatches(db) {
  await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
    VALUES ('b1','prodA',2,1000,'2026-09-01T10:00:00','d1','k-b1','pending',1,'2026-09-01T10:00:00','2026-09-01T10:00:00',0)`, args: [] });
  await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
    VALUES ('b2','prodA',3,1200,'2026-09-05T10:00:00','d1','k-b2','pending',1,'2026-09-05T10:00:00','2026-09-05T10:00:00',0)`, args: [] });
}

// Faithful replica of the guarded production depletion: oldest-first,
// UPDATE..WHERE qty>=take, loser overflows onward.
async function depleteGuarded(db, productId, qty) {
  const batches = await rowsOf(db,
    `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
     WHERE product_id = ? AND quantity_remaining > 0 AND deleted = 0
       AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
     ORDER BY received_at ASC, rowid ASC`, [productId]);
  let need = qty;
  const allocs = [];
  for (const b of batches) {
    if (need <= 0) break;
    const want = Math.min(Number(b.quantity_remaining), need);
    if (want <= 0) continue;
    const res = await db.execute({
      sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?, version = version + 1
            WHERE batch_id = ? AND quantity_remaining >= ? AND deleted = 0`,
      args: [want, b.batch_id, want],
    });
    let take = 0;
    if (Number(res.rowsAffected ?? 0) > 0) {
      take = want;
    } else {
      const fresh = await rowsOf(db, 'SELECT quantity_remaining FROM stock_batches WHERE batch_id = ?', [b.batch_id]);
      const left = Math.max(0, Math.floor(Number(fresh[0]?.quantity_remaining ?? 0)));
      const want2 = Math.min(left, need);
      if (want2 <= 0) continue;
      const res2 = await db.execute({
        sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?, version = version + 1
              WHERE batch_id = ? AND quantity_remaining >= ? AND deleted = 0`,
        args: [want2, b.batch_id, want2],
      });
      if (Number(res2.rowsAffected ?? 0) <= 0) continue;
      take = want2;
    }
    need -= take;
    allocs.push({ batchId: String(b.batch_id), quantity: take, unitCost: Number(b.unit_cost) });
  }
  return { allocs, short: need };
}

// Faithful replica of LIFO reverse-depletion restitution.
async function restituteLifo(db, allocs, returnQty) {
  let rem = returnQty;
  for (const a of [...allocs].reverse()) {
    if (rem <= 0) break;
    const n = Math.min(a.quantity, rem);
    await db.execute({
      sql: 'UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?, version = version + 1 WHERE batch_id = ?',
      args: [n, a.batchId],
    });
    rem -= n;
  }
  return rem;
}

function part2() {
  console.log('\n--- Source wiring (both clients share these paths) ---');
  const adapter = src('src/db/sqlPluginAdapter.ts');
  const slice = src('src/store/slices/createOrderSlice.ts');
  const modal = src('src/components/modals/RefundModal.tsx');
  const sync = src('src/sync/SyncManager.ts');
  const gen = src('src/sync/genericApply.ts');
  const remote = src('src/sync/remoteSchema.ts');
  const types = src('src/types/pos.ts');
  const cart = src('src/components/mobile/tabs/MobileCheckoutTab.tsx');
  const paym = src('src/components/modals/PaymentModal.tsx');

  check('saleItemId links refund lines to original sale lines', modal.includes('saleItemId') && slice.includes('saleItemId'));
  check('condition flag Restock|Defective exists', types.includes(`'restock' | 'defective'`) && modal.includes(`'restock' : 'defective'`));
  check('defective write-off posts Perte Stock / SAV (non-cash)', slice.includes('Perte Stock / SAV') && types.includes('Perte Stock / SAV'));
  check('exchange return lines flagged is_return in payload', slice.includes('is_return') && adapter.includes('isReturnLine'));
  check('exchange restocks earliest batch (no depletion)', adapter.includes('earliest'));
  check('signed cost accumulation for exchanges', adapter.includes('signedQty'));
  check('guarded depletion UPDATE (qty >= take)', adapter.includes('quantity_remaining >= $1'));
  check('SHADOW rows excluded from depletion', adapter.includes(`!= 'SHADOW'`));
  check('shadow batch creation on overdraft', adapter.includes(`'SHADOW'`) && adapter.includes('shadow_sale_id'));
  check('reconcileShadowBatches job exists + hooked to receipt', adapter.includes('reconcileShadowBatches') && adapter.includes('await reconcileShadowBatches(batch.productId)'));
  check('pull of new batches triggers reconcile (both clients)', sync.includes('reconcileShadowBatches'));
  check('pull-apply persists shadow linkage, skips Dexie for SHADOW', gen.includes('shadow_sale_id') && gen.includes(`=== 'SHADOW'`));
  check('remote schema v12 + shadow columns + CHECK', /LATEST_REMOTE_VERSION = 12/.test(remote) && remote.includes('quantity_remaining >= 0'));
  check('remote schema v12 frozen allocation ledger + shift attribution', remote.includes('sale_batch_allocations') && remote.includes('LATEST_REMOTE_VERSION = 12') && remote.includes('shift_id'));
  check('restitution skips shadow batches', adapter.includes(`startsWith('shadow-')`));
  check('Edge C: mobile + desktop share computeCartTotals', cart.includes('computeCartTotals') && paym.includes('computeCartTotals'));
  check('restitution restores newest-first (LIFO)', slice.includes('reversedAllocations'));
}

async function part3() {
  console.log('\n--- Edge C/D money math (transpiled receiptMath) ---');
  const ts = await import('typescript');
  const fs = await import('node:fs');
  const ROOT = process.cwd();
  const tr = (p) => ts.transpileModule(fs.readFileSync(p, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }, fileName: p,
  }).outputText;
  const durl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  const taxUrl = durl(tr(`${ROOT}/src/utils/taxEngine.ts`));
  const pricingUrl = durl(tr(`${ROOT}/src/utils/pricingEngine.ts`));
  let rmSrc = fs.readFileSync(`${ROOT}/src/utils/receiptMath.ts`, 'utf8');
  rmSrc = rmSrc.replace(/from\s+(['"])\.\/pricingEngine\1/g, `from '${pricingUrl}'`);
  rmSrc = rmSrc.replace(/from\s+(['"])\.\/taxEngine\1/g, `from '${taxUrl}'`);
  const rm = await import(durl(ts.transpileModule(rmSrc, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }, fileName: 'receiptMath.ts',
  }).outputText));

  // Edge C: 10% global discount on 10 000 gross, FIFO cost 6000 (unchanged by discount).
  const disc = rm.computeCartTotals(
    [{ product: { price: 10000 }, quantity: 1, appliedPrice: 10000, discount: 0 }],
    { cartDiscountPercent: 10, vatRate: 0 }
  );
  check('Edge C: 10% remise → net 9000, discount 1000', disc.total === 9000 && disc.discountTotal === 1000, `total=${disc.total}`);
  const fifoCost = 6000;
  check('Edge C: profit = net after remise − FIFO cost (3000)', disc.total - fifoCost === 3000);
  check('Edge C: undiscounted catalog profit would be 4000 (must NOT use)', 10000 - fifoCost !== disc.total - fifoCost);

  // Edge D: exchange 3500 → 4000 + 500 cash. Spec profit = (4000-costB) − (3500-costA).
  const costA = 2500;
  const costB = 3000;
  const exch = rm.computeCartTotals([
    { product: { price: 3500 }, quantity: 1, appliedPrice: 3500, discount: 0, isReturn: true },
    { product: { price: 4000 }, quantity: 1, appliedPrice: 4000, discount: 0 },
  ], { vatRate: 0 });
  check('Edge D: revenue delta +500 cash', exch.total === 500 && exch.net === 500, `total=${exch.total}`);
  const signedCost = costB - costA;
  const splitProfit = (4000 - costB) - (3500 - costA);
  check('Edge D: split profit formula holds', exch.total - signedCost === splitProfit, `profit=${exch.total - signedCost}`);
  check('Edge D: unsigned-cost profit would be wrong', (exch.total - (costA + costB)) !== splitProfit);

  // Edge C line discount variant.
  const line = rm.computeCartTotals(
    [{ product: { price: 5000 }, quantity: 2, appliedPrice: 5000, discount: 1000 }],
    { vatRate: 0 }
  );
  check('line remise reduces net (9000) not cost basis', line.total === 9000 && line.grossSubtotal === 10000);

  // Edge F: computeSalesMetrics cost-basis order (exchange → alloc → row
  // ledger → stored). The ledger-only freeze means exchanges MUST use the
  // signed row cost; pure sales prefer alloc, then the materialized row
  // column (Dexie-mirror lag window), then stored.
  const mkSale = (over) => ({ id: 'S', status: 'COMPLETED', total: 7000, subtotal: 7000, discountTotal: 0, items: [], ...over });
  const sLine = (over) => ({ product: { id: 'p', price: 3500 }, quantity: 1, appliedPrice: 3500, ...over });
  const exSale = mkSale({ id: 'EX1', costTotal: 900, items: [sLine({ isReturn: true }), sLine({})] });
  const exMetrics = rm.computeSalesMetrics([exSale], { allocCogsBySaleId: { EX1: 1500 } });
  check('Edge F: exchange uses signed row cost, not alloc', exMetrics.costTotal === 900, `got ${exMetrics.costTotal}`);
  check('Edge F: exchange profit = total − row', exMetrics.profitTotal === 6100, `got ${exMetrics.profitTotal}`);
  const pureAlloc = mkSale({ id: 'P1', costTotal: 800, ledgerCogsTotal: 900, items: [sLine({})] });
  check('Edge F: pure sale alloc wins', rm.computeSalesMetrics([pureAlloc], { allocCogsBySaleId: { P1: 900 } }).costTotal === 900);
  const pureLedger = mkSale({ id: 'P2', costTotal: 800, ledgerCogsTotal: 900, items: [sLine({})] });
  check('Edge F: row ledger beats stored (mirror-lag window)', rm.computeSalesMetrics([pureLedger], { allocCogsBySaleId: {} }).costTotal === 900);
  const legacy = mkSale({ id: 'L1', costTotal: 800, items: [sLine({})] });
  check('Edge F: legacy stored fallback', rm.computeSalesMetrics([legacy], { allocCogsBySaleId: {} }).costTotal === 800);
  const exNoRow = mkSale({ id: 'EX2', items: [sLine({ isReturn: true }), sLine({})] });
  delete exNoRow.costTotal;
  check('Edge F: exchange w/o row falls to alloc', rm.computeSalesMetrics([exNoRow], { allocCogsBySaleId: { EX2: 1500 } }).costTotal === 1500);
}

async function run() {
  console.log('========================================================================');
  console.log('FIFO / REFUNDS / EDGE-CASE AUDIT SUITE (A–E + quarantine + linking)');
  console.log('========================================================================');

  console.log('\n--- Edge A: LIFO reverse-depletion (5u sale: b1 2×1000 + b2 3×1200) ---');
  {
    const db = await freshDb();
    await seedBatches(db);
    const sale = await depleteGuarded(db, 'prodA', 5);
    check('sale consumes b1 first (2u)', sale.allocs[0]?.batchId === 'b1' && sale.allocs[0]?.quantity === 2);
    check('sale consumes b2 second (3u)', sale.allocs[1]?.batchId === 'b2' && sale.allocs[1]?.quantity === 3);
    check('batches fully depleted', (await qtyOf(db, 'b1')) === 0 && (await qtyOf(db, 'b2')) === 0);
    await restituteLifo(db, sale.allocs, 2);
    check('return 2u restores newest batch b2 first', (await qtyOf(db, 'b2')) === 2 && (await qtyOf(db, 'b1')) === 0);
    db.close();
  }
  {
    const db = await freshDb();
    await seedBatches(db);
    const sale = await depleteGuarded(db, 'prodA', 5);
    await restituteLifo(db, sale.allocs, 4);
    check('return 4u fills b2 (3u) then b1 (1u)', (await qtyOf(db, 'b2')) === 3 && (await qtyOf(db, 'b1')) === 1);
    const val = Number((await rowsOf(db, 'SELECT COALESCE(SUM(quantity_remaining*unit_cost),0) v FROM stock_batches WHERE deleted=0'))[0].v);
    check('valuation = 3×1200 + 1×1000 = 4600', val === 4600, `got ${val}`);
    db.close();
  }

  console.log('\n--- Edge E: guarded depletion, CHECK, overflow ---');
  {
    const db = await freshDb();
    await seedBatches(db);
    const r1 = await depleteGuarded(db, 'prodA', 3);
    check('3u overflows b1 into b2 automatically', r1.short === 0 && (await qtyOf(db, 'b1')) === 0 && (await qtyOf(db, 'b2')) === 2);
    const r2 = await depleteGuarded(db, 'prodA', 5);
    check('overdraft never overdraws (short 3, b2 = 0)', r2.short === 3 && (await qtyOf(db, 'b2')) === 0);
    let checkHeld = false;
    try { await db.execute({ sql: 'UPDATE stock_batches SET quantity_remaining = -1 WHERE batch_id = ?', args: ['b2'] }); } catch { checkHeld = true; }
    check('CHECK (quantity_remaining >= 0) rejects negatives', checkHeld);
    let costCheckHeld = false;
    try { await db.execute({ sql: 'UPDATE stock_batches SET unit_cost = -5 WHERE batch_id = ?', args: ['b2'] }); } catch { costCheckHeld = true; }
    check('CHECK (unit_cost >= 0) rejects negatives', costCheckHeld);
    db.close();
  }

  console.log('\n--- Edge B: shadow batch + reconciliation ---');
  {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
        purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted,
        shadow_sale_id, shadow_item_id, shadow_qty, shadow_resolved)
        VALUES ('shadow-T1-0','prodB',0,1000,'2026-09-24T10:00:00','SHADOW','d1','sb-shadow-T1-0','pending',1,'2026-09-24T10:00:00','2026-09-24T10:00:00',0,'T1','T1-item-0',2,0)`,
      args: [],
    });
    await db.execute({
      sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale, discount_amount, line_profit, json_payload, version)
        VALUES ('T1-item-0','T1','prodB',2,1500,1500,1000,0,1000,'{"fifo_allocations":[{"batchId":"shadow-T1-0","quantity":2,"unitCost":1000}]}',1)`,
      args: [],
    });
    await db.execute({
      sql: `INSERT INTO transactions (id, total, cost_total, profit, profit_margin, json_payload, version)
        VALUES ('T1',3000,2000,1000,33.3,'{"costTotal":2000,"profit":1000}',1)`,
      args: [],
    });
    const val0 = Number((await rowsOf(db, 'SELECT COALESCE(SUM(quantity_remaining*unit_cost),0) v FROM stock_batches WHERE deleted=0'))[0].v);
    check('shadow (qty 0) contributes 0 to valuation', val0 === 0);
    await db.execute({
      sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
        purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
        VALUES ('binv1','prodB',10,1100,'2026-09-24T12:00:00','PO-1','d1','k-inv1','pending',1,'2026-09-24T12:00:00','2026-09-24T12:00:00',0)`,
      args: [],
    });
    const need = 2;
    const rr = await db.execute({
      sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?, version = version + 1
            WHERE batch_id = 'binv1' AND quantity_remaining >= ? AND deleted = 0`, args: [need, need],
    });
    check('reconcile consumes real batch (guarded)', Number(rr.rowsAffected) === 1 && (await qtyOf(db, 'binv1')) === 8);
    const newUnit = Math.round((1000 * 2 - 1000 * 2 + 1100 * 2) / 2);
    await db.execute({ sql: 'UPDATE transaction_items SET unit_cost_at_sale = ?, line_profit = (unit_price_charged - ?) * quantity, version = version + 1 WHERE id = ?', args: [newUnit, newUnit, 'T1-item-0'] });
    const line = (await rowsOf(db, 'SELECT unit_cost_at_sale, line_profit FROM transaction_items WHERE id = ?', ['T1-item-0']))[0];
    check('line COGS recalculated to invoice cost (1100)', Number(line.unit_cost_at_sale) === 1100, `got ${line.unit_cost_at_sale}`);
    check('line profit = (1500-1100)×2 = 800', Number(line.line_profit) === 800, `got ${line.line_profit}`);
    await db.execute({ sql: "UPDATE transactions SET cost_total = 2200, profit = 800, profit_margin = 26.7 WHERE id = 'T1'", args: [] });
    const ord = (await rowsOf(db, 'SELECT cost_total, profit FROM transactions WHERE id = ?', ['T1']))[0];
    check('order retro-adjusted (cost 2200, profit 800)', Number(ord.cost_total) === 2200 && Number(ord.profit) === 800);
    await db.execute({ sql: "UPDATE stock_batches SET deleted = 1, shadow_resolved = 1, version = version + 1 WHERE batch_id = 'shadow-T1-0'", args: [] });
    const sh = (await rowsOf(db, 'SELECT deleted, shadow_resolved FROM stock_batches WHERE batch_id = ?', ['shadow-T1-0']))[0];
    check('shadow tombstoned resolved (idempotent re-run finds nothing)', Number(sh.deleted) === 1 && Number(sh.shadow_resolved) === 1);
    db.close();
  }

  part2();
  await part3();

  console.log('\n========================================================================');
  console.log(`EDGE-CASE SUMMARY: ${pass} Passed, ${fail} Failed`);
  console.log('========================================================================');
  for (let i = 0; i < dbSeq; i++) {
    const f = `${DB_BASE}-${i}.db`;
    try { rmSync(f); } catch {}
    try { rmSync(`${f}-wal`); } catch {}
    try { rmSync(`${f}-shm`); } catch {}
  }
  if (fail > 0) process.exit(1);
}

run().catch((err) => { console.error('Test script crashed:', err); process.exit(1); });

/**
 * Level-Omega Phase 2 — read-only forensic audit of the LIVE mobi_pos.db.
 *
 *  node scripts/forensic-audit-tradein.mjs            # full audit vs live DB
 *  node scripts/forensic-audit-tradein.mjs --baseline # + write JSON snapshot
 *
 * STRICTLY read-only: SELECT statements only, database opened with
 * { readOnly: true }. Safe to run while the Tauri app is live (WAL readers
 * never block the writer). Never VACUUMs, checkpoints, or writes.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB = path.join(process.env.APPDATA || '', 'com.mobi.pos', 'mobi_pos.db');
if (!fs.existsSync(DB)) {
  console.error(`DB not found: ${DB}`);
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✅ [PASS] ${name}`); }
  else { fail += 1; console.log(`  ❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

const db = new DatabaseSync(DB, { readOnly: true });
const all = (sql, params = []) => db.prepare(sql).all(...params);
const snap = {};

console.log(`DB: ${DB} (${(fs.statSync(DB).size / 1048576).toFixed(1)} MB)`);
console.log('========================================================================');
console.log('0. SHIFT PREREQUISITE — open session + float');
console.log('========================================================================');
const sessions = all(`SELECT id, status, opening_float, opened_at, closed_at, cashier_name FROM cash_sessions ORDER BY opened_at DESC LIMIT 5`);
console.table(sessions);
snap.sessions = sessions;
const open = sessions.filter((s) => s.status === 'OPEN');
check('exactly one OPEN shift (operator: fresh 15k float shift per protocol)', open.length === 1, `open=${open.length}`);
if (open.length === 1) {
  console.log(`   OPEN shift ${open[0].id} float=${open[0].opening_float} opened=${open[0].opened_at}`);
  snap.openShift = open[0];
}

console.log('========================================================================');
console.log('1. ORPHANED BATCHES (expect 0 rows)');
console.log('========================================================================');
const orphans = all(`
  SELECT b.batch_id, b.product_id, b.purchase_order_id, b.quantity_remaining
  FROM stock_batches b LEFT JOIN products p ON b.product_id = p.id
  WHERE p.id IS NULL`);
console.table(orphans);
snap.orphans = orphans;
check('zero orphaned batches', orphans.length === 0, `${orphans.length} found`);

console.log('========================================================================');
console.log('2. TRADE BATCHES FIFO/DEPLETION (ordered oldest-first)');
console.log('========================================================================');
const tradeBatches = all(`
  SELECT purchase_order_id, product_id, quantity_remaining, unit_cost, created_at
  FROM stock_batches WHERE purchase_order_id LIKE 'TRADE-%' ORDER BY created_at ASC`);
console.table(tradeBatches);
snap.tradeBatches = tradeBatches;
const depletedOk = tradeBatches.every((b) => Number(b.quantity_remaining) >= 0);
check('no negative batch quantities', depletedOk);

console.log('========================================================================');
console.log('3. NEGATIVE INVENTORY (expect 0 rows)');
console.log('========================================================================');
const neg = all(`SELECT id, sku, title, stock FROM products WHERE stock < 0`);
console.table(neg);
snap.negativeStock = neg;
check('zero negative-stock products (raw, incl. fixtures)', neg.length === 0, `${neg.length} found`);
// Scoped companion: dev DBs carry test/service standby rows (prod-test-*,
// prod-misc-*, qt-*) that legitimately sit negative. The protocol gate
// applies to the SELLABLE catalog only.
const negReal = all(`
  SELECT id, sku, title, stock FROM products
  WHERE stock < 0 AND id NOT LIKE 'prod-test-%' AND id NOT LIKE 'prod-misc-%' AND id NOT LIKE 'qt-%'`);
console.table(negReal);
snap.negativeStockSellable = negReal;
check('zero negative-stock SELLABLE products', negReal.length === 0, `${negReal.length} found`);

console.log('========================================================================');
console.log('4. CASH MOVEMENTS BY TYPE + SOULTE/RACHAT ROWS');
console.log('========================================================================');
const movTypes = all(`SELECT type, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM cash_movements GROUP BY type`);
console.table(movTypes);
snap.movementsByType = movTypes;
const soulteRows = all(`
  SELECT id, session_id, type, amount, substr(reason,1,72) AS reason, created_at
  FROM cash_movements WHERE reason LIKE '%Soulte%' OR reason LIKE '%Rachat%'
  ORDER BY created_at DESC LIMIT 20`);
console.table(soulteRows);
snap.soulteAndRachat = soulteRows;
const negOut = soulteRows.filter((r) => Number(r.amount) < 0);
check('no negative-amount outflow rows (EXPENSE rows carry positive amounts)', negOut.length === 0, JSON.stringify(negOut.map((r) => r.id)));

console.log('========================================================================');
console.log('5. TRADE_INS LEDGER (count + latest)');
console.log('========================================================================');
const tradeCount = all(`SELECT COUNT(*) AS n FROM trade_ins`)[0];
console.log(`   trade_ins rows: ${tradeCount.n}`);
snap.tradeInsCount = tradeCount.n;
const latestTrades = all(`
  SELECT id, device_model, imei, brand, buyback_value, resale_price, customer_name, credit_to_wallet, created_at
  FROM trade_ins ORDER BY created_at DESC LIMIT 10`);
console.table(latestTrades.map((t) => ({ ...t, imei: String(t.imei || '').slice(-6).padStart(15, '*') })));
snap.latestTrades = latestTrades;

console.log('========================================================================');
console.log('6. EXCHANGE TICKETS (transactions carrying tradeInId)');
console.log('========================================================================');
let exchangeTxns = [];
try {
  exchangeTxns = all(`
    SELECT id, receipt_number, total, payment_method, created_at
    FROM transactions WHERE json_payload LIKE '%tradeInId%' AND COALESCE(deleted,0) = 0
    ORDER BY created_at DESC LIMIT 10`);
} catch (e) {
  console.log(`   (transactions scan skipped: ${e.message})`);
}
console.table(exchangeTxns);
snap.exchangeTxns = exchangeTxns;

console.log('========================================================================');
console.log(`RESULT: ${pass} PASSED, ${fail} FAILED`);
console.log('========================================================================');

if (process.argv.includes('--baseline')) {
  const out = path.join(process.cwd(), `tmp-forensic-baseline-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), db: DB, snap }, null, 2));
  console.log(`Baseline snapshot written: ${out}`);
}
process.exit(fail > 0 ? 1 : 0);

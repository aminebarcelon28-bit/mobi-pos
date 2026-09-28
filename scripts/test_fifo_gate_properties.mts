/**
 * PROPERTY / FUZZ SUITE for the FIFO COGS transaction lock.
 *
 * Hand-built scenarios prove the happy path; this script hunts what humans
 * won't think of: seeded-random batches × lines × returns × services across
 * 150 iterations, asserting the three-way invariant the pre-COMMIT gate
 * enforces (allocations ≡ lines ≡ row) plus conservation laws:
 *   P1  depleted units == sold units minus shadow shortfall (no stock created
 *       or destroyed by the math);
 *   P2  gate triple agrees (alloc sum, row cost/ledger, lines sum);
 *   P3  no batch ever negative (CHECK + guarded UPDATEs);
 *   P4  |ledger - cost_total| <= #sale-lines (accepted blended-rounding
 *       bound — anything beyond is a real bug, not rounding);
 *   P5  tampering (deleted allocation row) is DETECTED by re-summing;
 *   P6  service/occasion shadows are terminal (resolved=1, null linkage,
 *       invisible to the reconcile pickup);
 *   P7  refund receipts deplete nothing and freeze nothing.
 *
 * Deterministic: mulberry32(SEED) — same run everywhere, no flakes.
 * Fixture mirrors writeCheckoutAtomicInner's sequence verbatim (deplete →
 * freeze → lines → 5b UPDATE → gate), so a failure here names a real
 * adapter-class bug, not a harness artifact.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

let pass = 0; let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
};

// --- seeded RNG ---
const SEED = 20260927;
let rngState = SEED >>> 0;
function rnd() {
  rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const DB_FILE = 'tmp-fifo-gate-props.db';
try { rmSync(DB_FILE); } catch {}
const db = createClient({ url: `file:${DB_FILE}` });
const R = (v) => Math.round(Number(v) || 0);

async function setup() {
  await db.execute(`CREATE TABLE stock_batches (batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
    quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0), received_at TEXT NOT NULL,
    purchase_order_id TEXT, device_id TEXT NOT NULL DEFAULT 'local',
    idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'pending',
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, shadow_sale_id TEXT, shadow_item_id TEXT,
    shadow_qty REAL, shadow_resolved INTEGER NOT NULL DEFAULT 0)`);
  await db.execute(`CREATE TABLE transactions (id TEXT PRIMARY KEY, total REAL NOT NULL DEFAULT 0,
    cost_total REAL DEFAULT 0, profit REAL DEFAULT 0, profit_margin REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'COMPLETED', is_refund INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0, json_payload TEXT, version INTEGER NOT NULL DEFAULT 1,
    sync_status TEXT NOT NULL DEFAULT 'pending', updated_at TEXT NOT NULL,
    ledger_cogs_total REAL)`);
  await db.execute(`CREATE TABLE transaction_items (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL,
    product_id TEXT NOT NULL, quantity INTEGER NOT NULL, applied_price REAL DEFAULT 0,
    unit_price_charged REAL DEFAULT 0, unit_cost_at_sale REAL DEFAULT 0,
    discount_amount REAL DEFAULT 0, line_profit REAL DEFAULT 0, is_return INTEGER NOT NULL DEFAULT 0,
    json_payload TEXT, version INTEGER NOT NULL DEFAULT 1)`);
  await db.execute(`CREATE TABLE sale_batch_allocations (
    id TEXT PRIMARY KEY NOT NULL, sale_id TEXT NOT NULL, batch_id TEXT NOT NULL,
    qty_consumed INTEGER NOT NULL CHECK (qty_consumed > 0),
    unit_cost_at_sale REAL NOT NULL CHECK (unit_cost_at_sale >= 0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, product_id TEXT, sale_item_id TEXT,
    device_id TEXT NOT NULL DEFAULT 'local', idempotency_key TEXT NOT NULL UNIQUE,
    sync_status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted INTEGER NOT NULL DEFAULT 0)`);
}

const COSTS = [100, 250, 400, 500, 750, 1100, 1500, 1999, 2000];

try {
  await setup();
  const N = 150;
  let tamperDetected = 0; let tamperRuns = 0;
  for (let i = 0; i < N; i++) {
    const tag = `it${i}`;
    const isRefundOnly = rnd() < 0.12;
    const nProducts = ri(1, 3);
    const prods = [];
    for (let p = 0; p < nProducts; p++) {
      const isService = rnd() < 0.25;
      const pid = isService ? `qt-svc-${tag}-${p}` : `prod-${tag}-${p}`;
      const nb = isService ? 0 : ri(1, 4);
      let day = ri(1, 28);
      for (let b = 0; b < nb; b++) {
        day += ri(0, 3);
        const at = `2026-01-${String(Math.min(day, 28)).padStart(2, '0')}T10:00:00.000Z`;
        await db.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?, 'd1', ?, 'pending', 1, ?, ?, 0)`,
          args: [`${tag}-b${p}-${b}`, pid, ri(1, 6), pick(COSTS), at, `PO-${tag}`, `${tag}-k${p}-${b}`, at, at] });
      }
      prods.push({ pid, isService });
    }
    // Sale lines (occasionally with a return leg; occasionally refund-only).
    const lines = [];
    const nLines = ri(1, 4);
    for (let l = 0; l < nLines; l++) {
      const pr = pick(prods);
      lines.push({
        prodId: pr.pid, isService: pr.isService,
        qty: ri(1, 5), price: pick([500, 1500, 3500, 5000]),
        isReturn: !isRefundOnly && rnd() < 0.15,
        callerCost: pick(COSTS), // deliberately often WRONG (trust-anchor fuzz)
      });
    }
    const saleId = `SALE-${tag}`;
    const now = `2026-03-${String((i % 27) + 1).padStart(2, '0')}T10:00:00.000Z`;
    const total = lines.reduce((a, l) => a + (l.isReturn ? -l.qty * l.price : l.qty * l.price), 0);
    const preStock = Number((await db.execute({ sql: `SELECT COALESCE(SUM(quantity_remaining),0) AS s FROM stock_batches WHERE batch_id LIKE '${tag}-b%'`, args: [] })).rows[0]?.s ?? 0);

    const tx = await db.transaction('write');
    try {
      await tx.execute({ sql: `INSERT INTO transactions (id, total, cost_total, profit, status, is_refund, deleted, json_payload, version, updated_at, ledger_cogs_total) VALUES (?, ?, 777777, -777777, 'COMPLETED', ?, 0, '{}', 1, ?, NULL)`,
        args: [saleId, total, isRefundOnly ? 1 : 0, now] });
      let allocTotal = 0; let costAccum = 0; let depletedUnits = 0; let soldUnits = 0;
      let saleLineCount = 0; let hasReturn = false; let resolvedAny = false;
      for (const [idx, ln] of lines.entries()) {
        const itemId = `${saleId}-item-${idx}`;
        if (isRefundOnly) {
          await tx.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale, discount_amount, line_profit, is_return, json_payload, version) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
            args: [itemId, saleId, ln.prodId, ln.qty, ln.price, ln.price, ln.callerCost, 0, 0, 0, '{}'] });
          continue;
        }
        if (ln.isReturn) {
          hasReturn = true;
          const unit = R(ln.callerCost);
          await tx.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale, discount_amount, line_profit, is_return, json_payload, version) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
            args: [itemId, saleId, ln.prodId, ln.qty, ln.price, ln.price, unit, 0, (ln.price - unit) * -ln.qty, 1, '{}'] });
          costAccum += unit * -ln.qty;
          resolvedAny = true;
          continue;
        }
        // SALE leg: verbatim depletion (guarded UPDATE + overflow + shadow).
        soldUnits += ln.qty;
        let needed = ln.qty; let takeAccum = 0; let takeCost = 0;
        const takes = [];
        const live = (await tx.execute({ sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches WHERE product_id = ? AND quantity_remaining > 0 AND deleted = 0 AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW') ORDER BY received_at ASC, batch_id ASC`, args: [ln.prodId] })).rows;
        for (const b of live) {
          if (needed <= 0) break;
          const avail = Math.max(0, Math.floor(Number(b.quantity_remaining) || 0));
          const want = Math.min(avail, needed);
          if (want <= 0) continue;
          const upd = await tx.execute({ sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?, version = version + 1, updated_at = ?, sync_status = 'pending' WHERE batch_id = ? AND quantity_remaining >= ? AND deleted = 0`, args: [want, now, String(b.batch_id)] });
          if (Number(upd.rowsAffected) !== 1) continue;
          needed -= want; takeAccum += want; takeCost += want * Number(b.unit_cost);
          takes.push({ batchId: String(b.batch_id), qty: want, unit: Number(b.unit_cost) });
        }
        if (needed > 0) {
          const real = (await tx.execute({ sql: `SELECT unit_cost FROM stock_batches WHERE product_id = ? AND deleted = 0 AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW') ORDER BY received_at DESC, batch_id DESC LIMIT 1`, args: [ln.prodId] })).rows;
          const sc = real?.[0] ? Number(real[0].unit_cost) : R(ln.callerCost);
          const terminal = ln.isService;
          await tx.execute({ sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted, shadow_sale_id, shadow_item_id, shadow_qty, shadow_resolved) VALUES ($1, $2, 0, $3, $4, 'SHADOW', 'd1', $5, 'pending', 1, $4, $4, 0, $6, $7, $8, $9) ON CONFLICT(batch_id) DO NOTHING`,
            args: [`shadow-${saleId}-${idx}`, ln.prodId, sc, now, `sb-shadow-${saleId}-${idx}`, terminal ? null : saleId, terminal ? null : itemId, needed, terminal ? 1 : 0] });
          takeAccum += needed; takeCost += needed * sc;
          takes.push({ batchId: `shadow-${saleId}-${idx}`, qty: needed, unit: sc });
          needed = 0;
        }
        const unit = takeAccum > 0 ? R(takeCost / takeAccum) : R(ln.callerCost);
        for (const t of takes) {
          const aid = `alloc-${saleId}-${idx}-${t.batchId}`;
          await tx.execute({ sql: `INSERT INTO sale_batch_allocations (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale, created_at, product_id, sale_item_id, device_id, idempotency_key, sync_status, version, updated_at, deleted) VALUES (?,?,?,?,?,?,?, ?, ?, ?, 'pending', 1, ?, 0) ON CONFLICT(id) DO UPDATE SET qty_consumed = sale_batch_allocations.qty_consumed + excluded.qty_consumed, updated_at = excluded.updated_at, sync_status = 'pending'`,
            args: [aid, saleId, t.batchId, t.qty, R(t.unit), now, ln.prodId, itemId, 'd1', aid, now] });
          allocTotal += t.qty * R(t.unit);
        }
        depletedUnits += takeAccum;
        costAccum += unit * ln.qty;
        saleLineCount++;
        resolvedAny = true;
        const lp = (ln.price - unit) * ln.qty;
        await tx.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, unit_price_charged, unit_cost_at_sale, discount_amount, line_profit, is_return, json_payload, version) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
          args: [itemId, saleId, ln.prodId, ln.qty, ln.price, ln.price, unit, 0, lp, 0, '{}'] });
      }
      if (!isRefundOnly && resolvedAny) {
        const orderCost = R(costAccum);
        const ledger = R(allocTotal);
        await tx.execute({ sql: `UPDATE transactions SET cost_total = ?, profit = ?, profit_margin = ?, ledger_cogs_total = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`,
          args: [orderCost, total - orderCost, 0, ledger, now, saleId] });
        // Gate triple (mirrors the adapter lock).
        const fAlloc = Number((await tx.execute({ sql: `SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale),0) AS s FROM sale_batch_allocations WHERE sale_id = ? AND deleted = 0`, args: [saleId] })).rows[0]?.s ?? 0);
        const row = (await tx.execute({ sql: `SELECT cost_total, ledger_cogs_total FROM transactions WHERE id = ?`, args: [saleId] })).rows[0];
        const fLines = Number((await tx.execute({ sql: `SELECT COALESCE(SUM(quantity * unit_cost_at_sale),0) AS s FROM transaction_items WHERE transaction_id = ?`, args: [saleId] })).rows[0]?.s ?? 0);
        check(`${tag}: gate alloc leg`, R(fAlloc) === ledger, `f=${R(fAlloc)} e=${ledger}`);
        check(`${tag}: gate row leg`, R(row.cost_total) === orderCost && R(row.ledger_cogs_total) === ledger, JSON.stringify(row));
        if (!hasReturn) check(`${tag}: gate lines leg`, R(fLines) === orderCost, `f=${R(fLines)} e=${orderCost}`);
        check(`${tag}: conservation depleted==sold`, depletedUnits === soldUnits, `${depletedUnits} vs ${soldUnits}`);
        // P4 bound applies to pure sales only: exchange return legs live in
        // cost_total but never in the alloc-only ledger (by design).
        if (!hasReturn) check(`${tag}: ledger-cost bound |ledger-cost|<=lines`, Math.abs(ledger - orderCost) <= Math.max(1, saleLineCount), `${ledger} vs ${orderCost}`);
        check(`${tag}: caller poison corrected`, orderCost !== 777777, '');
      }
      if (isRefundOnly) {
        const postStock = Number((await db.execute({ sql: `SELECT COALESCE(SUM(quantity_remaining),0) AS s FROM stock_batches WHERE batch_id LIKE '${tag}-b%'`, args: [] })).rows[0]?.s ?? -1);
        const nAlloc = Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM sale_batch_allocations WHERE sale_id = ?`, args: [saleId] })).rows[0]?.n ?? -1);
        check(`${tag}: refund depletes nothing`, postStock === preStock, `${preStock} vs ${postStock}`);
        check(`${tag}: refund freezes nothing`, nAlloc === 0, `allocs=${nAlloc}`);
      }
      await tx.commit();
    } catch (e) { try { await tx.rollback(); } catch {} throw e; }

    // P5 (subset): tamper → re-sum must disagree.
    if (i % 10 === 0 && !isRefundOnly) {
      tamperRuns++;
      const victim = (await db.execute({ sql: `SELECT id FROM sale_batch_allocations WHERE sale_id = ? AND deleted = 0 LIMIT 1`, args: [saleId] })).rows[0];
      if (victim) {
        await db.execute({ sql: `DELETE FROM sale_batch_allocations WHERE id = ?`, args: [String(victim.id)] });
        const after = Number((await db.execute({ sql: `SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale),0) AS s FROM sale_batch_allocations WHERE sale_id = ? AND deleted = 0`, args: [saleId] })).rows[0]?.s ?? 0);
        const row = (await db.execute({ sql: `SELECT ledger_cogs_total FROM transactions WHERE id = ?`, args: [saleId] })).rows[0];
        if (R(after) !== R(Number(row?.ledger_cogs_total ?? NaN))) tamperDetected++;
        else check(`${tag}: tamper detected`, false, `after=${after} ledger=${row?.ledger_cogs_total}`);
      }
    }
    // P6: service shadows terminal + pickup-blind.
    const svcShadows = (await db.execute({ sql: `SELECT batch_id, shadow_resolved, shadow_sale_id FROM stock_batches WHERE batch_id LIKE 'shadow-${saleId}-%' AND product_id LIKE 'qt-svc-%'`, args: [] })).rows;
    for (const s of svcShadows) {
      check(`${tag}: service shadow terminal`, Number(s.shadow_resolved) === 1 && (s.shadow_sale_id === null || s.shadow_sale_id === undefined), JSON.stringify(s));
    }
    const picked = (await db.execute({ sql: `SELECT COUNT(*) AS n FROM stock_batches WHERE purchase_order_id = 'SHADOW' AND deleted = 0 AND shadow_resolved = 0 AND product_id LIKE 'qt-svc-%'`, args: [] })).rows[0];
    check(`${tag}: reconcile pickup blind to services`, Number(picked?.n ?? -1) === 0, '');
  }
  check('P5 tamper always detected', tamperDetected === tamperRuns && tamperRuns > 0, `${tamperDetected}/${tamperRuns}`);
  // P3 global: no negative stock anywhere.
  const neg = (await db.execute(`SELECT COUNT(*) AS n FROM stock_batches WHERE quantity_remaining < 0`)).rows[0];
  check('P3 no negative batches globally', Number(neg?.n ?? -1) === 0, '');
} finally { db.close(); try { rmSync(DB_FILE); } catch {} }

console.log(`GATE PROPERTY SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);

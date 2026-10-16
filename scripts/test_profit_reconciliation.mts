/**
 * Profit reconciliation regression (2026-10-16 incident).
 *
 * Reported symptom: the dashboard card Bénéfice Net (CA Net 44,958 DA →
 * profit 5,472 DA) did not match Σ per-line margins from the inspector
 * (15,507 DA). Two root causes, both locked by this test:
 *
 *   1. LINE PROFIT WAS GROSS OF THE LINE DISCOUNT. Ticket totals are stored
 *      net of discounts, so the 200 DA remise on one sale alone made
 *      Σ per-line overshoot the ticket by exactly 200. Canonical formula:
 *      receiptMath.lineProfitNet /
 *      (Rust twin `line_profit_net`, src-tauri/src/checkout.rs).
 *
 *   2. NATIVE RECEIPTS KEPT PRE-FIFO CALLER COST SNAPSHOTS. Six lines kept a
 *      stale catalog cost (200) where the frozen FIFO ledger resolved 1,605
 *      (Σ divergence 9,835 + 200 = 10,035). The checkout now adopts resolved
 *      costs into the receipt JSON + item payloads; this test proves the
 *      stored line profits must follow the FROZEN ledger, never the caller
 *      snapshot.
 *
 * What this exercises:
 *   - The REAL pure functions (receiptMath.ts transpiled the same way as
 *     scripts/test_receipt_math.mjs): lineProfitNet + computeSalesMetrics.
 *   - The EXACT oldest-first guarded depletion SQL from
 *     writeCheckoutAtomicInner / checkout.rs against a scratch libsql DB
 *     (mirrors scripts/test_fifo_issue_6100.mts), then stores order + line
 *     rows like the checkout write does and reads them BACK to build the
 *     metrics input — so the whole chain rows → metric is under test:
 *
 *       card profit === Σ stored per-sale profit (refund vouchers subtracted
 *       per design) === Σ stored per-line profit over valid sales.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.error(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const toIntMoney = (n: unknown): number => {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) ? v : 0;
};

// ---- Load the REAL receiptMath module (same loader as test_receipt_math.mjs)
async function loadReceiptMath(): Promise<{
  lineProfitNet: (i: {
    unitPriceCharged: number; unitCostAtSale: number; quantity: number;
    discount?: number | null; isReturn?: boolean;
  }) => number;
  computeSalesMetrics: (list: unknown[], opts?: Record<string, unknown>) => {
    validSales: unknown[]; refundVouchers: unknown[]; validCount: number;
    netRevenue: number; costTotal: number; profitTotal: number; refundsTotal: number;
  };
}> {
  const ts = await import('typescript');
  const fs = await import('node:fs');
  const ROOT = process.cwd();
  const transpileFile = (absPath: string) => {
    const source = fs.readFileSync(absPath, 'utf8');
    return ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
      fileName: absPath,
    }).outputText;
  };
  const toDataUrl = (js: string) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  const pricingUrl = toDataUrl(transpileFile(`${ROOT}/src/utils/pricingEngine.ts`));
  let src = fs.readFileSync(`${ROOT}/src/utils/receiptMath.ts`, 'utf8');
  src = src.replace(/from\s+(['"])\.\/pricingEngine\1/g, `from '${pricingUrl}'`);
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'receiptMath.ts',
  });
  return import(toDataUrl(out.outputText));
}

const { lineProfitNet, computeSalesMetrics } = await loadReceiptMath();

// ---- Formula lock (direct, both signs) ------------------------------------
console.log('\n--- Formula: lineProfitNet ---');
check('discounted sale line nets the remise: (2416−1336)×1 − 200 = 880',
  lineProfitNet({ unitPriceCharged: 2416, unitCostAtSale: 1336, quantity: 1, discount: 200 }) === 880);
check('gross formula 1080 is REJECTED by the stored law',
  lineProfitNet({ unitPriceCharged: 2416, unitCostAtSale: 1336, quantity: 1, discount: 200 }) !== 1080);
check('multi-unit stale-catalog line: (400−1605)×2 = −2410',
  lineProfitNet({ unitPriceCharged: 400, unitCostAtSale: 1605, quantity: 2 }) === -2410);
check('return line: discount shrinks the refund: −((500−380)×2)+100 = −140',
  lineProfitNet({ unitPriceCharged: 500, unitCostAtSale: 380, quantity: 2, discount: 100, isReturn: true }) === -140);

// ---- Scratch DB: the real depletion SQL ------------------------------------
const DB_FILE = 'tmp-profit-reconciliation.db';
try { rmSync(DB_FILE); } catch { /* fresh start */ }
const db = createClient({ url: `file:${DB_FILE}` });

/** Oldest-first guarded depletion — verbatim checkout semantics. */
async function deplete(productId: string, qty: number): Promise<{
  allocs: Array<{ batchId: string; quantity: number; unitCost: number }>;
  blended: number; short: number;
}> {
  const rows = (await db.execute({
    sql: `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
          WHERE product_id = ? AND quantity_remaining > 0 AND deleted = 0
            AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
          ORDER BY received_at ASC, batch_id ASC`,
    args: [productId],
  })).rows;
  let needed = qty;
  let cost = 0;
  let taken = 0;
  const allocs: Array<{ batchId: string; quantity: number; unitCost: number }> = [];
  for (const batch of rows) {
    if (needed <= 0) break;
    const avail = Math.max(0, Math.floor(Number(batch.quantity_remaining) || 0));
    const want = Math.min(avail, needed);
    if (want <= 0) continue;
    const upd = await db.execute({
      sql: `UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?,
              version = version + 1, updated_at = ?, sync_status = 'pending'
            WHERE batch_id = ? AND quantity_remaining >= ? AND deleted = 0`,
      args: [want, new Date().toISOString(), String(batch.batch_id), want],
    });
    if (Number(upd.rowsAffected) === 0) continue;
    needed -= want;
    taken += want;
    cost += want * Number(batch.unit_cost);
    allocs.push({ batchId: String(batch.batch_id), quantity: want, unitCost: Number(batch.unit_cost) });
  }
  return { allocs, blended: taken > 0 ? Math.round(cost / taken) : 0, short: needed };
}

async function receiveBatch(batchId: string, productId: string, qty: number, unitCost: number, receivedAt: string) {
  await db.execute({
    sql: `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
      received_at, purchase_order_id, device_id, idempotency_key, sync_status,
      version, created_at, updated_at, deleted)
      VALUES (?,?,?,?,?,?,?,?,'pending',1,?,?,0)`,
    args: [batchId, productId, qty, unitCost, receivedAt, 'PO-1', 'd1', `key-${batchId}`, receivedAt, receivedAt],
  });
}

/** Persist a sale the way the checkout write does (order + line + read back). */
async function persistSale(input: {
  id: string; productId: string; qty: number; unitPriceCharged: number;
  discount: number; unitCostAtSale: number; isReturn?: boolean;
}): Promise<{
  order: { id: string; total: number; subtotal: number; discount_total: number; cost_total: number; profit: number };
  line: {
    id: string; product_id: string; quantity: number; applied_price: number;
    unit_price_charged: number; unit_cost_at_sale: number; discount_amount: number; line_profit: number;
  };
}> {
  const signedQty = input.isReturn ? -Math.abs(input.qty) : Math.abs(input.qty);
  const lineTotal = input.unitPriceCharged * Math.abs(input.qty) - input.discount;
  const total = signedQty < 0 ? -lineTotal : lineTotal;
  const costTotal = input.unitCostAtSale * signedQty;
  const profit = total - costTotal;
  // THE canonical line formula under test (shared TS function).
  const lineProfit = lineProfitNet({
    unitPriceCharged: input.unitPriceCharged,
    unitCostAtSale: input.unitCostAtSale,
    quantity: input.qty,
    discount: input.discount,
    isReturn: input.isReturn,
  });
  await db.execute({
    sql: `INSERT INTO transactions (id, subtotal, discount_total, total, cost_total, profit, json_payload, version)
          VALUES (?,?,?,?,?,?,'{}',1)`,
    args: [input.id, lineTotal + input.discount, input.discount, total, costTotal, profit],
  });
  await db.execute({
    sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price,
            unit_price_charged, unit_cost_at_sale, discount, discount_amount, line_profit, json_payload, version)
          VALUES (?,?,?,?,?,?,?,?,0,?,'{}',1)`,
    args: [ `${input.id}-item-0`, input.id, input.productId, Math.abs(input.qty), input.unitPriceCharged,
      input.unitPriceCharged, input.unitCostAtSale, input.discount, lineProfit],
  });
  const order = (await db.execute({ sql: `SELECT * FROM transactions WHERE id = ?`, args: [input.id] })).rows[0] as Record<string, unknown>;
  const line = (await db.execute({ sql: `SELECT * FROM transaction_items WHERE id = ?`, args: [`${input.id}-item-0`] })).rows[0] as Record<string, unknown>;
  return {
    order: {
      id: String(order.id), subtotal: Number(order.subtotal), discount_total: Number(order.discount_total),
      total: Number(order.total), cost_total: Number(order.cost_total), profit: Number(order.profit),
    },
    line: line as unknown as {
      id: string; product_id: string; quantity: number; applied_price: number;
      unit_price_charged: number; unit_cost_at_sale: number; discount_amount: number; line_profit: number;
    },
  };
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
    id TEXT PRIMARY KEY, subtotal REAL DEFAULT 0, discount_total REAL DEFAULT 0,
    total REAL NOT NULL, cost_total REAL DEFAULT 0, profit REAL DEFAULT 0,
    json_payload TEXT, version INTEGER NOT NULL DEFAULT 1
  )`);
  await db.execute(`CREATE TABLE transaction_items (
    id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL, applied_price REAL DEFAULT 0,
    unit_price_charged REAL DEFAULT 0, unit_cost_at_sale REAL DEFAULT 0,
    discount REAL DEFAULT 0, discount_amount REAL DEFAULT 0, line_profit REAL DEFAULT 0,
    json_payload TEXT, version INTEGER NOT NULL DEFAULT 1
  )`);

  // ---- Scenario: FIFO batches + discount + refund --------------------------
  console.log('\n--- Scenario: FIFO batches + line discount + refund ---');
  await receiveBatch('bA-old', 'prodA', 2, 500, '2026-01-01T10:00:00.000Z');
  await receiveBatch('bA-new', 'prodA', 3, 400, '2026-02-01T10:00:00.000Z');
  await receiveBatch('bB-old', 'prodB', 1, 1605, '2026-01-15T10:00:00.000Z');

  // S1: prodA ×2 @3500, no discount. FIFO: 2×500 → cost 1000.
  const s1dep = await deplete('prodA', 2);
  check('S1 depletes oldest batch first (2×500)',
    s1dep.allocs[0]?.batchId === 'bA-old' && s1dep.allocs[0]?.quantity === 2, JSON.stringify(s1dep.allocs));
  const S1 = await persistSale({ id: 'S1', productId: 'prodA', qty: 2, unitPriceCharged: 3500, discount: 0, unitCostAtSale: s1dep.blended });

  // S2: prodA ×1 @1200 with 200 remise — the #5 pattern. FIFO: 1×400 → cost 400.
  const s2dep = await deplete('prodA', 1);
  check('S2 depletes the newer batch next (1×400)',
    s2dep.allocs[0]?.batchId === 'bA-new' && s2dep.blended === 400, JSON.stringify(s2dep.allocs));
  const S2 = await persistSale({ id: 'S2', productId: 'prodA', qty: 1, unitPriceCharged: 1200, discount: 200, unitCostAtSale: s2dep.blended });

  // S3: prodB ×1 @400 — stale caller snapshot (catalog 200) vs frozen FIFO 1605
  // (the prod-test-0610 incident shape). The stored line MUST use 1605.
  const s3dep = await deplete('prodB', 1);
  const S3 = await persistSale({ id: 'S3', productId: 'prodB', qty: 1, unitPriceCharged: 400, discount: 0, unitCostAtSale: s3dep.blended });
  check('S3 frozen FIFO cost is 1605, NOT the stale caller snapshot 200',
    S3.line.unit_cost_at_sale === 1605 && S3.order.profit === -1205,
    `ucas=${S3.line.unit_cost_at_sale} profit=${S3.order.profit}`);

  // R1: refund voucher of S2 — reversal row, excluded from valid sales.
  const R1 = await persistSale({ id: 'R1', productId: 'prodA', qty: 1, unitPriceCharged: 1200, discount: 200, unitCostAtSale: 400 });
  await db.execute({ sql: `UPDATE transactions SET total = ?, profit = ? WHERE id = 'R1'`, args: [1000, 600] });

  // ---- Ticket law: stored order profit == Σ of its stored lines ------------
  console.log('\n--- Ticket law: defined on the same line ---');
  for (const [label, s] of [['S1', S1], ['S2', S2], ['S3', S3]] as const) {
    check(`${label}: stored ticket profit === Σ stored per-line profit`,
      s.order.profit === s.line.line_profit,
      `ticket=${s.order.profit} line=${s.line.line_profit}`);
  }
  check('S2 line profit is NET of the remise (600), not gross (800) and not stale-catalog (700)',
    S2.line.line_profit === 600 && S2.line.line_profit !== 800 && S2.line.line_profit !== 700,
    `line=${S2.line.line_profit}`);

  // ---- Card == Σ per-sale (metrics on the read-back rows) -------------------
  const validRows = [S1, S2, S3];
  const refundRows = [R1];
  const allocCogs = new Map<string, number>([
    ['S1', 1000], ['S2', 400], ['S3', 1605], ['R1', 400],
  ]);
  const madeTx = (r: (typeof validRows)[number], isRefund: boolean) => ({
    id: r.order.id,
    subtotal: r.order.subtotal,
    discountTotal: r.order.discount_total,
    total: r.order.total,
    costTotal: r.order.cost_total,
    profit: r.order.profit,
    isRefund,
    status: 'COMPLETED',
  });
  const metrics = computeSalesMetrics(
    [...validRows.map((r) => madeTx(r, false)), ...refundRows.map((r) => madeTx(r, true))],
    {
      // Deliberately WRONG fallback: the frozen map must win — never live costs.
      costFallback: () => 400,
      allocCogsBySaleId: allocCogs,
    }
  );
  const sumValidProfit = validRows.reduce((acc, r) => acc + r.order.profit, 0);
  const sumLineProfit = validRows.reduce((acc, r) => acc + r.line.line_profit, 0);
  const refundTotal = refundRows.reduce((acc, r) => acc + r.order.total, 0);
  console.log(`[METRICS] CA net=${metrics.netRevenue} cost=${metrics.costTotal} profit=${metrics.profitTotal} | Σ per-sale=${sumValidProfit} refund=${refundTotal} Σ per-line=${sumLineProfit}`);

  check('card profit === Σ stored per-sale profit − refund vouchers',
    metrics.profitTotal === sumValidProfit - refundTotal,
    `card=${metrics.profitTotal} expected=${sumValidProfit - refundTotal}`);
  check('card profit === Σ stored per-line profit − refund vouchers',
    metrics.profitTotal === sumLineProfit - refundTotal,
    `card=${metrics.profitTotal} Σline=${sumLineProfit} refund=${refundTotal}`);
  check('refund voucher subtracted exactly once (orig S2 row untouched)',
    metrics.refundsTotal === 1000 && S2.order.profit === 600,
    `refunds=${metrics.refundsTotal} S2=${S2.order.profit}`);
  check('frozen ledger map wins over the (wrong) cost fallback',
    metrics.costTotal === 3005,
    `cost=${metrics.costTotal}`);
  check('valid sales count + refund classification',
    metrics.validCount === 3 && metrics.refundVouchers.length === 1);
} finally {
  db.close();
  try { rmSync(DB_FILE); } catch { /* scratch cleanup best-effort */ }
}

console.log(`\nTEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);

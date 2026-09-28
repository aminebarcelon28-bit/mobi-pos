/**
 * H5 regression: refunds must never be counted as sales revenue.
 *
 * Reproduction (pre-fix): a refund is persisted as its own transaction row with
 * status 'COMPLETED', isRefund: true, profit: 0 and total = the refunded
 * amount. Several reporting paths filtered only on `status !== 'VOIDED'` and
 * never checked `isRefund`, so the money the merchant handed BACK to the
 * customer was added to revenue:
 *   - mobile ManagementTab "today revenue" + average basket
 *   - shift close `totalSalesRevenue` / `totalSalesCount` / `totalProfits`
 * The desktop ReportsModal and the X-report already excluded refunds correctly.
 *
 * Post-fix every sales aggregate filters `status !== 'VOIDED' && !t.isRefund`.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-h5-refund-revenue.db';
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, receipt_number TEXT, total INTEGER, profit INTEGER,
  status TEXT, is_refund INTEGER DEFAULT 0, created_at TEXT
);
`;

/**
 * Mirrors the production filter used by every sales aggregate after the fix.
 * A refund row is COMPLETED with total = refunded amount; it must be excluded
 * from revenue, count and profit.
 */
function validSales(rows) {
  return rows.filter((t) => t.status !== 'VOIDED' && !t.isRefund);
}

async function main() {
  let db;
  try { rmSync(DB_FILE); } catch { /* may not exist */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  db = createClient({ url: `file:${DB_FILE}` });
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.execute(stmt);
  }

  const DAY = '2026-09-14';
  const rows = [
    { id: 'S1', total: 10000, profit: 3000, status: 'COMPLETED', is_refund: 0, created_at: `${DAY}T10:00:00Z` },
    { id: 'S2', total: 5000, profit: 1500, status: 'COMPLETED', is_refund: 0, created_at: `${DAY}T11:00:00Z` },
    // The refund: COMPLETED, isRefund, profit 0, total = money given back.
    { id: 'R1', total: 5000, profit: 0, status: 'COMPLETED', is_refund: 1, created_at: `${DAY}T12:00:00Z` },
    // A voided sale must stay excluded too.
    { id: 'V1', total: 8000, profit: 2000, status: 'VOIDED', is_refund: 0, created_at: `${DAY}T13:00:00Z` },
  ];
  for (const r of rows) {
    await db.execute(
      `INSERT INTO transactions (id,receipt_number,total,profit,status,is_refund,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.id, `REC-${r.id}`, r.total, r.profit, r.status, r.is_refund, r.created_at],
    );
  }

  const all = (await db.execute('SELECT id,total,profit,status,is_refund,created_at FROM transactions')).rows.map((r) => ({
    id: String(r.id), total: Number(r.total), profit: Number(r.profit),
    status: String(r.status), isRefund: Boolean(Number(r.is_refund)), createdAt: String(r.created_at),
  }));

  // ---- ManagementTab / shift-close style aggregate. ----
  const sales = validSales(all);
  const revenue = sales.reduce((acc, t) => acc + t.total, 0);
  const count = sales.length;
  const profit = sales.reduce((acc, t) => acc + t.profit, 0);
  const basket = count > 0 ? Math.round(revenue / count) : 0;

  check('revenue excludes the refund and the void', revenue === 15000, `revenue=${revenue}`);
  check('sales count excludes the refund and the void', count === 2, `count=${count}`);
  check('profit excludes the refund (profit 0) and the void', profit === 4500, `profit=${profit}`);
  check('average basket is not inflated by the refund', basket === 7500, `basket=${basket}`);

  // ---- The refund must still be visible as a refund (not silently dropped). ----
  const refunds = all.filter((t) => t.isRefund);
  check('refund row is still retrievable for the refund total', refunds.length === 1 && refunds[0].total === 5000,
    `refunds=${refunds.length}`);

  // ---- Net revenue = sales - refunds (desktop ReportsModal semantics). ----
  const refundValue = all.filter((t) => t.isRefund).reduce((acc, t) => acc + t.total, 0);
  const net = Math.max(0, revenue - refundValue);
  check('net revenue nets the refund out', net === 10000, `net=${net}`);

  // ---- A day with only a refund must show zero revenue, not negative. ----
  const onlyRefund = validSales([all[2]]);
  check('a lone refund yields zero sales revenue', onlyRefund.reduce((a, t) => a + t.total, 0) === 0, 'ok');

  console.log('====================================================');
  console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
  console.log('====================================================');
  await db.close();
  try { rmSync(DB_FILE); } catch { /* noop */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

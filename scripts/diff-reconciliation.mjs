/**
 * Stage C reconciliation differencer (blocked-period build, verified now).
 *
 * Compares two database files (before/after) per table: row counts, SUMs of
 * configured numeric columns, and column-name sets. Prints a per-table
 * EQUAL/DELTA report with every delta itemized line-by-line for owner
 * sign-off (PD-15).
 *
 * Modes:
 *   --strict   any delta (or schema difference) exits 1. For 1b-i, where
 *              zero delta is required (drop of a proven-zero column).
 *   (default)  report mode for Stage C backfills: prints all deltas,
 *              exits 0 (deltas are sign-off items, not failures).
 *
 * Usage:
 *   node scripts/diff-reconciliation.mjs --before a.db --after b.db [--strict]
 *
 * Self-verification performed at author time on the live-DB copy:
 *   identical DBs -> zero deltas (strict passes);
 *   snapshot-vs-tax-dropped -> exactly the tax-column delta, nothing else.
 */
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const BEFORE = opt('--before');
const AFTER = opt('--after');
const STRICT = args.includes('--strict');
if (!BEFORE || !AFTER || !existsSync(BEFORE) || !existsSync(AFTER)) {
  console.log('Usage: node scripts/diff-reconciliation.mjs --before a.db --after b.db [--strict]');
  process.exit(2);
}

// Table -> numeric money/quantity columns to SUM (Phase 0 money map наверху;
// extended at Stage B expand with *_minor/*_milli pairs).
const TABLES = {
  transactions: ['subtotal', 'discount_total', 'total', 'cost_total', 'profit', 'cash_tendered', 'change_due'],
  transaction_items: ['applied_price', 'discount', 'cost_price'],
  stock_batches: ['quantity_remaining', 'unit_cost'],
  products: ['price', 'cost_price', 'stock'],
  customers: ['store_credit', 'total_spent'],
  customer_debts: ['amount'],
  store_expenses: ['amount'],
  cash_drops: ['amount'],
  sale_batch_allocations: ['qty_consumed', 'unit_cost_at_sale'],
  credit_vouchers: ['initial_amount', 'remaining_amount'],
  inventory_ledger: ['delta'],
};

const { DatabaseSync } = await import('node:sqlite');
const open = (p) => new DatabaseSync(p, { readOnly: true });
const before = open(BEFORE);
const after = open(AFTER);

const hasTable = (db, t) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
const columns = (db, t) => {
  try {
    return db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  } catch {
    return null;
  }
};

let deltas = 0;
for (const [table, numCols] of Object.entries(TABLES)) {
  const bHas = hasTable(before, table);
  const aHas = hasTable(after, table);
  if (!bHas || !aHas) {
    console.log(`${!bHas && !aHas ? 'EQUAL' : 'DELTA'} ${table}: presence before=${bHas} after=${aHas}`);
    if (bHas !== aHas) deltas += 1;
    continue;
  }
  const bCols = columns(before, table);
  const aCols = columns(after, table);
  const colDiff = `${JSON.stringify(bCols)} -> ${JSON.stringify(aCols)}`;
  const rowsB = before.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n;
  const rowsA = after.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n;
  const parts = [];
  if (JSON.stringify(bCols) !== JSON.stringify(aCols)) parts.push(`columns ${colDiff}`);
  if (rowsB !== rowsA) parts.push(`rows ${rowsB} -> ${rowsA}`);
  for (const c of numCols) {
    if (!bCols.includes(c) || !aCols.includes(c)) {
      if (bCols.includes(c) !== aCols.includes(c)) parts.push(`column '${c}' present before=${bCols.includes(c)} after=${aCols.includes(c)}`);
      continue;
    }
    const sb = before.prepare(`SELECT COALESCE(SUM(CAST(${c} AS REAL)),0) AS s FROM ${table}`).get()?.s;
    const sa = after.prepare(`SELECT COALESCE(SUM(CAST(${c} AS REAL)),0) AS s FROM ${table}`).get()?.s;
    if (sb !== sa) parts.push(`SUM(${c}) ${sb} -> ${sa}`);
  }
  if (parts.length === 0) {
    console.log(`EQUAL ${table} (rows=${rowsB})`);
  } else {
    deltas += 1;
    console.log(`DELTA ${table}:`);
    for (const p of parts) console.log(`    ${p}`);
  }
}
before.close();
after.close();

console.log('========================================================================');
if (deltas === 0) {
  console.log('RECONCILIATION: zero deltas.');
} else {
  console.log(`RECONCILIATION: ${deltas} table(s) with deltas — owner sign-off required (PD-15).`);
}
if (STRICT && deltas > 0) {
  console.log('STRICT MODE: failing on deltas.');
  process.exit(1);
}

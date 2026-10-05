/**
 * Restore source assessment (SYNC-012) — tests for hasLocalRestoreData()
 * and isSourceEmpty() in src/sync/restoreGuards.ts. Pure predicates.
 *
 * Proves: emptiness spans all six user-data tables (a customers-only
 * device is NOT fresh); any single populated table marks data present;
 * garbage counts fail safe to empty (fail-closed only where a merge
 * decision could destroy — here toward "treat as fresh", matching the
 * merge-never-deletes restore semantics).
 */
import { hasLocalRestoreData, isSourceEmpty, RESTORE_DATA_TABLES } from '../src/sync/restoreGuards.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

check('registry covers six tables', RESTORE_DATA_TABLES.length === 6);
check('all empty → fresh', hasLocalRestoreData({}) === false);
check('all zero → fresh',
  hasLocalRestoreData({ transactions: 0, products: 0, customers: 0, customer_debts: 0, credit_vouchers: 0, stock_batches: 0 }) === false);
// The old two-table check called each of these "empty":
for (const table of ['customers', 'customer_debts', 'credit_vouchers', 'stock_batches', 'transactions', 'products']) {
  check(`lone ${table} row → has data`, hasLocalRestoreData({ [table]: 3 }) === true);
}
check('garbage counts fail safe', hasLocalRestoreData({ transactions: Number.NaN }) === false);
check('empty source detected', isSourceEmpty({}) === true && isSourceEmpty({ transactions: 0 }) === true);
check('non-empty source detected', isSourceEmpty({ products: 12 }) === false);

console.log(`\nrestore-guards: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

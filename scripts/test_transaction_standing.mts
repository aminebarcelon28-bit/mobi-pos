/**
 * Canonical transaction standing (D3: CT-007/CT-008) — truth-table tests
 * for resolveTransactionStanding() in src/utils/dateUtils.ts.
 *
 * Proves: the four known statuses reproduce every consumer's historic
 * verdict exactly (behavior-preserving), while null/empty/typo/case drift
 * quarantines (fail-closed). The legacy per-screen predicates are quoted
 * in each check so a drift between helper and consumer is visible here.
 */
import {
  isRefundReceipt,
  isRevenueSale,
  isVoidedTransaction,
  resolveTransactionStanding,
} from '../src/utils/dateUtils.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const KNOWN = ['COMPLETED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED'];

// 1. Known statuses reproduce the legacy predicates exactly.
for (const status of KNOWN) {
  for (const isRefund of [true, false]) {
    const t = { status, isRefund };
    const standing = resolveTransactionStanding(t);
    // Legacy validSales: status !== 'VOIDED' && !isRefund
    const legacyValid = status !== 'VOIDED' && !isRefund;
    check(`[${status}, refund=${isRefund}] matches legacy validSales`, (standing === 'sale') === legacyValid);
    // Legacy void check: status === 'VOIDED'
    check(`[${status}, refund=${isRefund}] matches legacy void`, (standing === 'void') === (status === 'VOIDED'));
    // Legacy avoir filter (known rows): Boolean(isRefund)
    if (!isRefund) {
      check(`[${status}, sale] never refund`, standing !== 'refund');
    } else if (status !== 'VOIDED') {
      check(`[${status}, refund] is refund receipt`, standing === 'refund');
    }
  }
}
// VOIDED dominates isRefund (a cancelled refund is cancelled, not an avoir).
check('VOIDED + isRefund → void', resolveTransactionStanding({ status: 'VOIDED', isRefund: true }) === 'void');

// 2. Unknown statuses quarantine — never sale, never refund, never void.
const unknowns: Array<{ status?: unknown; isRefund?: unknown }> = [
  {},
  { status: undefined },
  { status: null },
  { status: '' },
  { status: 'COMPLETTED' },
  { status: 'voided' },
  { status: 'completed' },
  { status: 'PENDING' },
  { status: 'DRAFT' },
  { status: 42 },
  { status: 'COMPLETED ' },
  { status: ' COMPLETED' },
];
for (const t of unknowns) {
  check(`unknown ${JSON.stringify(t.status)} (refund=${Boolean(t.isRefund)}) → unknown`,
    resolveTransactionStanding(t) === 'unknown');
  check(`unknown ${JSON.stringify(t.status)} excluded from revenue`, isRevenueSale(t) === false);
  check(`unknown ${JSON.stringify(t.status)} excluded from refunds`, isRefundReceipt(t) === false);
  check(`unknown ${JSON.stringify(t.status)} not void`, isVoidedTransaction(t) === false);
}
// isRefund cannot rescue a malformed status (the flag itself may be corrupt).
check('isRefund + garbage status → unknown, not refund',
  resolveTransactionStanding({ status: 'BOGUS', isRefund: true }) === 'unknown');

// 3. Null/undefined rows quarantine.
check('null row → unknown', resolveTransactionStanding(null) === 'unknown');
check('undefined row → unknown', resolveTransactionStanding(undefined) === 'unknown');

// 4. Predicate helpers agree with the standing.
check('helpers agree (sale)', isRevenueSale({ status: 'COMPLETED' }) && !isVoidedTransaction({ status: 'COMPLETED' }) && !isRefundReceipt({ status: 'COMPLETED' }));
check('helpers agree (refund)', isRefundReceipt({ status: 'COMPLETED', isRefund: true }));

console.log(`\ntransaction-standing: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

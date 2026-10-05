/**
 * Close-scope status resolution (D2: CT-003) — tests for closeRowStatus()
 * in src/utils/cashTerms.ts.
 *
 * Proves: columns win over stale envelopes (a voided ticket is VOIDED even
 * when its sale-time envelope still says COMPLETED); legacy empty columns
 * fall back exactly as before; corrupt-but-present columns pass through
 * for the D3 quarantine instead of silently becoming revenue.
 */
import { closeRowStatus } from '../src/utils/cashTerms.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// Agreement: identical outcomes to the old payload-first read.
check('agree COMPLETED → COMPLETED', closeRowStatus('COMPLETED', 'COMPLETED') === 'COMPLETED');
check('agree VOIDED → VOIDED', closeRowStatus('VOIDED', 'VOIDED') === 'VOIDED');
check('agree REFUNDED → REFUNDED', closeRowStatus('REFUNDED', 'REFUNDED') === 'REFUNDED');

// The void window: column flipped, envelope stale from sale time.
check('voided column beats stale COMPLETED envelope',
  closeRowStatus('VOIDED', 'COMPLETED') === 'VOIDED');
check('refunded column beats stale COMPLETED envelope',
  closeRowStatus('PARTIALLY_REFUNDED', 'COMPLETED') === 'PARTIALLY_REFUNDED');

// Legacy fallbacks: behavior byte-identical to the old chain.
check('empty column falls back to envelope', closeRowStatus('', 'COMPLETED') === 'COMPLETED');
check('null column falls back to envelope', closeRowStatus(null, 'REFUNDED') === 'REFUNDED');
check('undefined column falls back to envelope', closeRowStatus(undefined, 'COMPLETED') === 'COMPLETED');
check('both empty → COMPLETED (pre-status rows)', closeRowStatus('', '') === 'COMPLETED');
check('both missing → COMPLETED', closeRowStatus(null, undefined) === 'COMPLETED');

// Corrupt-but-present columns pass through untouched for quarantine.
check('typo column passes through (quarantine handles it)',
  closeRowStatus('VOIDEDD', 'COMPLETED') === 'VOIDEDD');
check('lowercase passes through (quarantine handles it)',
  closeRowStatus('voided', 'COMPLETED') === 'voided');

// Non-string inputs never crash the close.
check('numeric column tolerated', closeRowStatus(42 as unknown as string, 'COMPLETED') === 'COMPLETED');

console.log(`\nclose-status: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

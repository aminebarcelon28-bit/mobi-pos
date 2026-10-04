/**
 * Compensation-claim hardening (A4: SYNC-008) — tests for the pure
 * contention resolver and the method-independent claim key in
 * src/sync/claims.ts.
 *
 * Proves: own claims proceed; live peer claims hold; expired holders
 * (including sweep-failure residue) are takeover-eligible; missing/invalid
 * inputs fail safe; the refund-leg key is stable per leg and diverges per
 * leg without any method input (same items + different methods converge).
 */
import {
  CLAIM_TTL_MIN,
  refundLegClaimId,
  resolveClaimContention,
} from '../src/sync/claims.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const NOW = '2026-09-16T10:00:00.000Z';
const PAST = '2026-09-16T09:00:00.000Z';
const FUTURE = '2026-09-16T11:00:00.000Z';

// 1. Own claim always proceeds (idempotent replay safe).
check('own live claim → ours',
  resolveClaimContention({ holderDevice: 'till-01', holderExpiresAt: FUTURE, ourDevice: 'till-01', nowIso: NOW }) === 'ours');
check('own expired claim → ours (replay, not takeover)',
  resolveClaimContention({ holderDevice: 'till-01', holderExpiresAt: PAST, ourDevice: 'till-01', nowIso: NOW }) === 'ours');

// 2. Live peer claim holds.
check('live peer claim → held',
  resolveClaimContention({ holderDevice: 'till-02', holderExpiresAt: FUTURE, ourDevice: 'till-01', nowIso: NOW }) === 'held');

// 3. Expired peer claim is takeover-eligible (the sweep-failure wedge fix).
check('expired peer claim → takeover-expired',
  resolveClaimContention({ holderDevice: 'till-02', holderExpiresAt: PAST, ourDevice: 'till-01', nowIso: NOW }) === 'takeover-expired');

// 4. Missing/invalid inputs fail safe.
check('missing expiry → takeover-eligible (abandoned lock)',
  resolveClaimContention({ holderDevice: 'till-02', ourDevice: 'till-01', nowIso: NOW }) === 'takeover-expired');
check('empty holder + live expiry → held (unknown owner, live lock)',
  resolveClaimContention({ holderDevice: '', holderExpiresAt: FUTURE, ourDevice: 'till-01', nowIso: NOW }) === 'held');
check('empty holder + dead expiry → takeover-eligible',
  resolveClaimContention({ holderDevice: '', holderExpiresAt: PAST, ourDevice: 'till-01', nowIso: NOW }) === 'takeover-expired');
check('garbage inputs → takeover-eligible, never held-on-garbage',
  resolveClaimContention({ holderDevice: 42, holderExpiresAt: null, ourDevice: 'till-01', nowIso: NOW }) === 'takeover-expired');

// 5. Expiry boundary: exactly-now counts expired (lock no longer live).
check('expiry equal to now → takeover-eligible',
  resolveClaimContention({ holderDevice: 'till-02', holderExpiresAt: NOW, ourDevice: 'till-01', nowIso: NOW }) === 'takeover-expired');

// 6. Method-independent leg key.
{
  const items = 'prodA:1:1000:1,prodB:2:500:1';
  const cash = refundLegClaimId('TX-1', items);
  check('key stable per leg', cash === refundLegClaimId('TX-1', items));
  check('key shape CLAIM-REF-<8HEX>', /^CLAIM-REF-[0-9A-F]{8}$/.test(cash), cash);
  // Method is not an input at all: Espèces and Avoir legs converge by construction.
  check('no method dependence possible (single key per leg)', refundLegClaimId('TX-1', items) === cash);
  check('different items → different key', refundLegClaimId('TX-1', 'prodA:2:1000:1') !== cash);
  check('different ticket → different key', refundLegClaimId('TX-2', items) !== cash);
  check('empty inputs → still deterministic key', refundLegClaimId('', '') === refundLegClaimId('', ''));
}

// 7. TTL constant sane (advisory lock, minutes not seconds/days).
check('claim TTL is minutes-scale', CLAIM_TTL_MIN >= 1 && CLAIM_TTL_MIN <= 60, `TTL=${CLAIM_TTL_MIN}`);

console.log(`\nclaim-contention: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

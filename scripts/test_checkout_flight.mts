/**
 * B-061/B-063 checkout-flight lock regression:
 *  - tryAcquire succeeds when free
 *  - second tryAcquire fails while held (no queue — fail fast)
 *  - owner-scoped release: stale owner cannot free the new owner's lock
 *  - renewCheckoutFlight refreshes idle activity for the owner only
 *  - double-release is safe (idempotent)
 *  - owner labels are exposed for diagnostics
 *  - CHECKOUT_FLIGHT_TIMEOUT_MS is the documented 60s idle window
 */

import {
  tryAcquireCheckoutFlight,
  releaseCheckoutFlight,
  renewCheckoutFlight,
  isCheckoutFlightActive,
  checkoutFlightOwner,
  CHECKOUT_FLIGHT_TIMEOUT_MS,
} from '../src/db/checkoutFlight.ts';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

async function main() {
  // Start free
  releaseCheckoutFlight();
  check('starts free', !isCheckoutFlightActive());
  check('owner empty', checkoutFlightOwner() === '');

  // Acquire
  check('first acquire succeeds', tryAcquireCheckoutFlight('processPayment'));
  check('active after acquire', isCheckoutFlightActive());
  check('owner is processPayment', checkoutFlightOwner() === 'processPayment');

  // Second acquire fails while held (boot replay / double-tap / refund)
  check('second acquire fails (replay)', !tryAcquireCheckoutFlight('boot-replay'));
  check('third acquire fails (refund)', !tryAcquireCheckoutFlight('refund-write'));
  check('owner unchanged while contested', checkoutFlightOwner() === 'processPayment');

  // renew: owner may renew; non-owner may not (when owner is specified)
  renewCheckoutFlight('processPayment');
  check('owner renew keeps lock', isCheckoutFlightActive());
  renewCheckoutFlight('boot-replay');
  check('stale-owner renew is no-op (still active)', isCheckoutFlightActive());
  check('stale-owner renew did not steal owner', checkoutFlightOwner() === 'processPayment');

  // B-063: release is owner-scoped — a stale owner cannot free the new lock.
  // Simulate: force-clear without owner, re-acquire as boot-replay, then
  // processPayment's late finally must NOT free boot-replay's lock.
  releaseCheckoutFlight(); // force-clear (test/hard cleanup path)
  check('force-clear releases', !isCheckoutFlightActive());
  check('re-acquire as boot-replay', tryAcquireCheckoutFlight('boot-replay'));
  check('owner is boot-replay', checkoutFlightOwner() === 'boot-replay');
  // Stale processPayment finally:
  releaseCheckoutFlight('processPayment');
  check(
    'stale processPayment release ignored',
    isCheckoutFlightActive() && checkoutFlightOwner() === 'boot-replay',
    `owner=${checkoutFlightOwner()} active=${isCheckoutFlightActive()}`
  );
  // Correct owner releases:
  releaseCheckoutFlight('boot-replay');
  check('owner-scoped release works', !isCheckoutFlightActive());

  // Double-release is idempotent
  releaseCheckoutFlight();
  releaseCheckoutFlight();
  check('double-release safe', !isCheckoutFlightActive());

  check(
    'timeout constant is 60_000ms',
    CHECKOUT_FLIGHT_TIMEOUT_MS === 60_000,
    `got ${CHECKOUT_FLIGHT_TIMEOUT_MS}`
  );

  check('acquire again after double-release', tryAcquireCheckoutFlight('processPayment'));
  releaseCheckoutFlight('processPayment');
  check('owner release clears hold', !isCheckoutFlightActive());

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

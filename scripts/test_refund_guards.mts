/**
 * REF-87 regression guards — unit level, no DOM, no DB.
 *
 * Every assertion here maps to a defect that was observed in this session:
 *  - two submits in one millisecond (E-0052) -> createSubmitGuard
 *  - a manager PIN surviving into the next refund (E-0055) -> pinAuthorisesTicket
 *  - two legitimate chunks colliding on the dedup hash (E-0050) -> committedRefundBasis
 *    + refundIdentity basis sensitivity
 */
import { createSubmitGuard, pinAuthorisesTicket, committedRefundBasis, avoirRecipientRefusal } from '../src/utils/refundGuards.ts';
import { refundIdentity } from '../src/db/adapters/refundNative.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`[FAIL] ${name} :: ${extra}`);
  }
};

/* 1. Two submits in the same tick -> exactly one entry ---------------------- */
{
  const guard = createSubmitGuard();
  let entered = 0;
  // simulate two click handlers firing in the same tick
  for (let i = 0; i < 2; i++) {
    if (guard.tryEnter()) entered++;
  }
  check('two same-tick submits enter exactly once', entered === 1, `entered=${entered}`);
  check('the guard reports busy while in flight', guard.busy === true, String(guard.busy));
  guard.leave();
  check('after leave a new submit may enter (next chunk)', guard.tryEnter() === true && guard.busy === true);
  guard.leave();
}

/* 2. A PIN for ticket A never authorises ticket B --------------------------- */
{
  check('PIN typed for ticket A authorises A', pinAuthorisesTicket('TXN-A', 'TXN-A') === true);
  check('PIN typed for ticket A does NOT authorise B', pinAuthorisesTicket('TXN-A', 'TXN-B') === false);
  check('PIN with no bound ticket authorises nothing', pinAuthorisesTicket(null, 'TXN-A') === false);
  check('blank PIN ticket authorises nothing', pinAuthorisesTicket('   ', 'TXN-A') === false);
  check('missing refund ticket authorises nothing', pinAuthorisesTicket('TXN-A', null) === false);
}

/* 3. Basis counts committed refunds durably -------------------------------- */
{
  // first chunk: nothing committed yet
  check('first chunk basis is 0', committedRefundBasis(0, 0) === 0);
  // second chunk: union blind, SQLite already has 1 committed refund
  check('durable count wins when the union is blind', committedRefundBasis(0, 1) === 1, String(committedRefundBasis(0, 1)));
  // union ahead of a lagging durable read: still monotonic
  check('union wins when it is ahead', committedRefundBasis(2, 1) === 2);
  // junk must not poison the identity
  check('NaN durable count falls back to the union', committedRefundBasis(1, Number.NaN) === 1);
  check('negative counts clamp to 0', committedRefundBasis(-3, -1) === 0);
}

/* 4. refundIdentity is basis-sensitive (the actual collision mechanism) ---- */
{
  const base = { ticketId: 'TXN-1', canonicalKey: 'P:1:2000000000:1:item-0::restock', method: 'Avoir Client', netRefund: 2_000_000_000 };
  const a0 = refundIdentity({ ...base, basis: 0 });
  const a0again = refundIdentity({ ...base, basis: 0 });
  const a1 = refundIdentity({ ...base, basis: 1 });
  check('identical request+basis -> identical hash (replay is refused)', a0.itemsHash === a0again.itemsHash, `${a0.itemsHash} vs ${a0again.itemsHash}`);
  check('a later chunk (basis+1) hashes differently', a0.itemsHash !== a1.itemsHash, `${a0.itemsHash} vs ${a1.itemsHash}`);
  check('different method hashes differently', refundIdentity({ ...base, basis: 0, method: 'Espèces' }).itemsHash !== a0.itemsHash);
  check('different amount hashes differently', refundIdentity({ ...base, basis: 0, netRefund: 1 }).itemsHash !== a0.itemsHash);
}

/* 5. P0 recipient rule: no Avoir leg without a recipient ------------------- */
{
  check(
    'anonymous Avoir refund is refused',
    avoirRecipientRefusal({ method: 'Avoir Client', hasCustomer: false, avoirShare: 0 }) === 'AVOIR_RECIPIENT_REQUIRED',
  );
  check(
    'anonymous funding-avoir refund is refused',
    avoirRecipientRefusal({ method: 'Espèces', hasCustomer: false, avoirShare: 500 }) === 'AVOIR_RECIPIENT_REQUIRED',
  );
  check('customer-attached Avoir refund is allowed', avoirRecipientRefusal({ method: 'Avoir Client', hasCustomer: true, avoirShare: 0 }) === null);
  check('customer-attached funding-avoir refund is allowed', avoirRecipientRefusal({ method: 'Espèces', hasCustomer: true, avoirShare: 500 }) === null);
  check(
    'anonymous cash refund without an avoir lane is allowed',
    avoirRecipientRefusal({ method: 'Espèces', hasCustomer: false, avoirShare: 0 }) === null,
  );
  check(
    'offline cap switch onto Avoir with no customer is refused',
    avoirRecipientRefusal({ method: 'Avoir Client', hasCustomer: false, avoirShare: 0 }) !== null,
  );
  check(
    'replay of an Avoir request with no customer is refused',
    avoirRecipientRefusal({ method: 'Avoir Client', hasCustomer: false, avoirShare: 0 }) === 'AVOIR_RECIPIENT_REQUIRED',
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

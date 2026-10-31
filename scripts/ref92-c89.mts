/**
 * REF-92 (store-level, committed behaviour) + C89 (offline cash-cap model).
 *
 * REF-92: three partial refunds on a mixed ticket with an odd total, driven
 * through the real split -> funding payload -> reader chain. It pins the CURRENT
 * behaviour, including the sub-dinar residue that currently lands on the digital
 * lane on a cash+avoir ticket. That residue is the open D-RND question: when the
 * owner picks the rounding rule, this expectation changes with it (the assertion
 * names the residue explicitly, so the change is visible, not silent).
 *
 * C89: models the offline cash-refund ceiling with the REAL clamp
 * (`cashTerms.clampCashRefund`, read-only). It asserts the documented fallback:
 * once the shift's cash budget is spent, a cash refund degrades to Avoir Client
 * instead of being refused - and never pays cash beyond what was tendered.
 */
import {
  computeRefundFundingSplit,
  fundingPayloadOf,
  refundLaneTotalsOf,
  type RefundLaneTotals,
} from '../src/utils/receiptMath.ts';
import { clampCashRefund } from '../src/utils/cashTerms.ts';

const M = (v: number) => Math.round(Number(v) * 100);
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`[FAIL] ${name} :: ${extra}`);
  }
};

/* ------------------------------- REF-92 ------------------------------- */
{
  const sale = {
    id: 'REF92',
    subtotal: 999.99,
    discountTotal: 0,
    total: 699.99,
    paymentMethod: 'Espèces',
    tenders: [
      { method: 'Espèces', amount: 699.99 },
      { method: 'Avoir Client', amount: 300 },
    ],
  };
  let prior: RefundLaneTotals = { cash: 0, avoir: 0, voucher: 0, debt: 0, digital: 0, gross: 0, basis: 'explicit', anomalies: [] };
  let priorNet = 0;
  for (const [i, g] of [333.33, 333.33, 333.33].entries()) {
    const s = computeRefundFundingSplit(sale, g, priorNet, { ...prior });
    const payload = fundingPayloadOf(s);
    const read = refundLaneTotalsOf({ funding: payload } as unknown as Record<string, unknown>);
    const rowSum = M(s.cashShare) + M(s.avoirShare) + M(s.voucherShare) + M(s.debtShare) + M(s.digitalShare);
    check(`REF-92 step ${i + 1}: row lanes equal the refund total`, rowSum === M(s.netRefund), `${rowSum} vs ${M(s.netRefund)}`);
    check(`REF-92 step ${i + 1}: payload round-trips`, M(read.avoir) === M(s.avoirShare) && M(read.digital) === M(s.digitalShare), JSON.stringify(read));
    check(`REF-92 step ${i + 1}: cash is a whole-dinar amount`, M(s.cashShare) % 100 === 0, `cash=${s.cashShare}`);
    prior = {
      cash: prior.cash + s.cashShare,
      avoir: prior.avoir + s.avoirShare,
      voucher: prior.voucher + s.voucherShare,
      debt: prior.debt + s.debtShare,
      digital: prior.digital + s.digitalShare,
      gross: (prior.gross ?? 0) + s.grossRefund,
      basis: 'explicit',
      anomalies: [],
    };
    priorNet += s.netRefund;
  }
  check('REF-92: three partials return the whole ticket (999.99)', M(priorNet) === 99999, `net=${priorNet}`);
  check('REF-92: the avoir lane returns exactly its 300', M(prior.avoir) === 30000, `avoir=${prior.avoir}`);
  check('REF-92: cash returns 699 whole dinars', M(prior.cash) === 69900, `cash=${prior.cash}`);
  check(
    'REF-92: the sub-dinar residue (<=1 DA) sits on the digital lane (D-RND artefact)',
    M(prior.digital) > 0 && M(prior.digital) < 100,
    `digital=${prior.digital}`
  );
  check('REF-92: nothing is lost (lanes + residue == ticket)', M(prior.cash) + M(prior.avoir) + M(prior.digital) === 99999, `${prior.cash}+${prior.avoir}+${prior.digital}`);
}

/* -------------------------------- C89 -------------------------------- */
{
  // `clampCashRefund` is the PER-TICKET cap: cash returned on one refund can
  // never exceed what remains of the cash the customer actually tendered
  // (cashTenderedNet - priorCashOut). The SHIFT-wide offline ceiling is a
  // different check, inline in createOrderSlice (`shiftCashOut + cashOut >
  // shiftCap` -> OFFLINE_CASH_CAP_EXCEEDED, and the modal re-validates as Avoir);
  // it is not a pure function, so it is asserted by the E2E helper, not here.
  const remaining = clampCashRefund({ cashShare: 300, cashTenderedNet: 800, priorCashOut: 500 });
  check('C89: the ticket cap allows only what remains (800-500=300)', remaining.cashOut === 300 && remaining.avoirOverflow === 0, JSON.stringify(remaining));

  const overTicket = clampCashRefund({ cashShare: 300, cashTenderedNet: 800, priorCashOut: 700 });
  check('C89: past the ticket cap the excess locks to Avoir, never refused', overTicket.cashOut === 100 && overTicket.avoirOverflow === 200, JSON.stringify(overTicket));

  const aboveTender = clampCashRefund({ cashShare: 900, cashTenderedNet: 800, priorCashOut: 0 });
  check('C89: cash never exceeds what was tendered', aboveTender.cashOut === 800 && aboveTender.avoirOverflow === 100, JSON.stringify(aboveTender));

  for (const i of [remaining, overTicket, aboveTender]) {
    check('C89: cash + Avoir always equals the requested share', i.cashOut + i.avoirOverflow === (i === remaining ? 300 : i === overTicket ? 300 : 900), JSON.stringify(i));
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

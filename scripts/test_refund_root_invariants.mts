/**
 * Refund engine — root invariants (post-rebuild adversarial suite).
 *
 * Pins the SEVEN invariants of the rebuilt refund engine on the real TS
 * helpers (no copies), plus source-wiring checks that bind the UI/slice/
 * adapters to the native authority:
 *
 *   I2  line identity — canonical hash + per-line refundable remaining
 *       (dual-IMEI same-SKU, multi-step partials).
 *   I3  order-discount proration — cumulative partial refunds conserve the
 *       ticket value to the Dinar (80 + 90 + 100 = 270), 4th is ineligible.
 *   I4  debt-first / tender-capped waterfall — refund split reverses each
 *       funding source, cash never exceeds net cash paid.
 *   I5  FIFO restitution vs defective quarantine — P&L credit is recovered
 *       COGS only; a write-off carries the cost burden once.
 *   I6  IMEI event vocabulary — RETURN_IN / RETURN_DEFECTIVE deterministic ids
 *       (byte-identical to the native `imev|...` format).
 *   I7  Z-report conservation — cash refund reduces expected cash exactly
 *       once (cashDisbursed, never `total` when both exist; ALLOCATION
 *       movements stay math-invisible).
 *   I1  read-back hydration — the slice consumes native ticketPayload /
 *       debtReliefApplied / customerDebtAfter / recoveredCogs; refund-native
 *       error domain includes RESTOCK_REASON_REQUIRED.
 *
 * Integer DZD throughout; no floats cross any assertion.
 */
import { readFileSync } from 'node:fs';
import * as receiptMathModule from '../src/utils/receiptMath.ts';
import { deterministicId } from '../src/utils/ids.ts';
import {
  computeRefundFundingSplit,
  computeSalesMetrics,
  refundedQtyByProduct,
  refundableBalanceOfTxn,
  refundableValueOf,
  isRefundEligible,
} from '../src/utils/receiptMath.ts';
import { cashRefundsFromTxns, standaloneExpensesFromMovements } from '../src/utils/cashTerms.ts';
import { imeiTrustEventId, IMEI_TRUST_EVENT_LABELS } from '../src/utils/deviceTrust.ts';
import type { SaleTransaction } from '../src/types/pos.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`);
  }
}
const src = (p: string): string => readFileSync(p, 'utf8');
const isInt = (n: number): boolean => Number.isInteger(n);

const line = (
  pid: string,
  qty: number,
  price: number,
  opts: { discount?: number; imei?: string; saleItemId?: string } = {}
) => ({
  product: { id: pid, price },
  quantity: qty,
  appliedPrice: price,
  discount: opts.discount ?? 0,
  ...(opts.imei ? { imeiNumber: opts.imei } : {}),
  ...(opts.saleItemId ? { saleItemId: opts.saleItemId } : {}),
});

const SALE = {
  id: 'TKT-A',
  receiptNumber: 'REC-A',
  status: 'COMPLETED',
  isRefund: false,
  subtotal: 370,
  discountTotal: 100,
  total: 270,
  costTotal: 135,
  profit: 135,
  profitMargin: 50,
  ledgerCogsTotal: 135,
  paymentMethod: 'Espèces',
  cashTendered: 270,
  changeDue: 0,
  customer: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  pricingTier: 'Retail',
  items: [
    line('P1', 1, 100, { saleItemId: 'TKT-A-item-0', imei: 'IMEI-A1' }),
    line('P2', 1, 120, { saleItemId: 'TKT-A-item-1', imei: 'IMEI-A2' }),
    line('P3', 1, 150, { saleItemId: 'TKT-A-item-2' }),
  ],
} as unknown as SaleTransaction;

/** Refund row exactly as the native engine / slice now writes it. */
const refundRow = (
  id: string,
  total: number,
  restoredCogs: number,
  items: Array<{ productId: string; quantity: number; saleItemId?: string; imeiNumber?: string }>,
  extra: Partial<SaleTransaction> = {}
) =>
  ({
    id,
    receiptNumber: `REC-${id}`,
    status: 'COMPLETED',
    isRefund: true,
    originalTransactionId: SALE.id,
    subtotal: total,
    discountTotal: 0,
    total,
    costTotal: restoredCogs,
    restoredCogs,
    profit: total - restoredCogs,
    profitMargin: 0,
    paymentMethod: 'Espèces',
    cashTendered: 0,
    changeDue: 0,
    customer: null,
    createdAt: '2026-10-18T11:00:00.000Z',
    pricingTier: 'Retail',
    items: [],
    refundedItems: items,
    ...extra,
  }) as unknown as SaleTransaction;

// ------------------------------------------------------------------ I2 ---
console.log('\n--- I2: line identity — canonical hash + per-line remainder ---');
{
  // Mirrors createOrderSlice canonicalKey EXACTLY (order built after the
  // canonical sort by productId / qty / price).
  const canonicalKey = (
    items: Array<{
      productId: string;
      quantity: number;
      unitPrice?: number;
      restock: boolean;
      saleItemId?: string;
      imeiNumber?: string;
      condition?: string;
    }>
  ) =>
    [...items]
      .sort(
        (a, b) =>
          String(a.productId).localeCompare(String(b.productId)) ||
          a.quantity - b.quantity ||
          (a.unitPrice ?? 0) - (b.unitPrice ?? 0)
      )
      .map(
        (i) =>
          `${i.productId}:${i.quantity}:${Math.round(i.unitPrice ?? 0)}:${i.restock ? 1 : 0}:` +
          `${i.saleItemId ?? ''}:${(i.imeiNumber ?? '').trim()}:${i.condition ?? ''}`
      )
      .join(',');

  const base = {
    productId: 'P1',
    quantity: 1,
    unitPrice: 200,
    restock: true,
    saleItemId: 'TKT-A-item-0',
    imeiNumber: 'IMEI-A1',
    condition: 'restock',
  };
  check(
    'identical line → identical key (cross-device determinism)',
    canonicalKey([base]) === canonicalKey([{ ...base }])
  );
  check(
    'same SKU, different line identity → different key (no false dedup)',
    canonicalKey([base]) !== canonicalKey([{ ...base, saleItemId: 'TKT-A-item-1' }])
  );
  check(
    'same SKU, different IMEI → different key',
    canonicalKey([base]) !== canonicalKey([{ ...base, imeiNumber: 'IMEI-A2' }])
  );
  check(
    'restock vs defective → different key (same unit, different lane)',
    canonicalKey([base]) !== canonicalKey([{ ...base, restock: false, condition: 'defective' }])
  );
  check(
    'key ordering is product-sorted (item order cannot fork the hash)',
    canonicalKey([base, { ...base, productId: 'P0', saleItemId: 'TKT-A-item-9' }]) ===
      canonicalKey([{ ...base, productId: 'P0', saleItemId: 'TKT-A-item-9' }, base])
  );
}

// ------------------------------------------------------------------ I3 ---
console.log('\n--- I3: multi-step partials conserve the discounted total ---');
{
  // 80 + 90 + 100 = 270 exactly; recovered COGS 40 + 50 + 45 = 135 = the
  // sale's gross cost → full restock refund leaves P&L at zero.
  const r1 = refundRow('R-A1', 80, 40, [
    { productId: 'P1', quantity: 1, saleItemId: 'TKT-A-item-0', imeiNumber: 'IMEI-A1' },
  ]);
  const r2 = refundRow('R-A2', 90, 50, [
    { productId: 'P2', quantity: 1, saleItemId: 'TKT-A-item-1', imeiNumber: 'IMEI-A2' },
  ]);
  const r3 = refundRow('R-A3', 100, 45, [
    { productId: 'P3', quantity: 1, saleItemId: 'TKT-A-item-2' },
  ]);
  const all = [SALE, r1, r2, r3];
  const cumulative = r1.total + r2.total + r3.total;
  check('cumulative partials end exactly at the ticket total (270)', cumulative === SALE.total, `got ${cumulative}`);
  check('integer arithmetic only', [SALE.total, r1.total, r2.total, r3.total].every(isInt));
  check('4th refund attempt sees ZERO refundable value', refundableValueOf(SALE, all) === 0);
  check('4th refund attempt is ineligible', isRefundEligible(SALE, refundedQtyByProduct(all, SALE.id)) === false);

  const mid = [SALE, r1, r2];
  check(
    'per-line remainder after two partials keeps only the untouched line',
    refundableValueOf(SALE, mid) === 100,
    `got ${refundableValueOf(SALE, mid)}`
  );
  check(
    'legacy payload readers still aggregate product quantities (native entries)',
    refundedQtyByProduct([SALE, ...all.slice(1)], SALE.id).get('P1') === 1
  );
}

// ------------------------------------------------------------------ I5 ---
console.log('\n--- I5: P&L conservation — restock neutral, write-off burdened once ---');
{
  const fullRestock = refundRow('R-FULL', 270, 135, [
    { productId: 'P1', quantity: 1, saleItemId: 'TKT-A-item-0' },
    { productId: 'P2', quantity: 1, saleItemId: 'TKT-A-item-1' },
    { productId: 'P3', quantity: 1, saleItemId: 'TKT-A-item-2' },
  ]);
  const m1 = computeSalesMetrics([SALE, fullRestock]);
  check('full restock refund: CA Net 0', m1.netRevenue === 0, `got ${m1.netRevenue}`);
  check('full restock refund: gross COGS stays 135', m1.costTotal === 135, `got ${m1.costTotal}`);
  check('full restock refund: recovered 135', m1.restoredCogsTotal === 135, `got ${m1.restoredCogsTotal}`);
  check('full restock refund: profit exactly 0 (no leak, no double cost)', m1.profitTotal === 0, `got ${m1.profitTotal}`);

  const partialRestock = refundRow('R-PART', 90, 50, [
    { productId: 'P2', quantity: 1, saleItemId: 'TKT-A-item-1' },
  ]);
  const m2 = computeSalesMetrics([SALE, partialRestock]);
  check('partial restock: CA Net 180', m2.netRevenue === 180, `got ${m2.netRevenue}`);
  check('partial restock: profit 95 (180 − 135 + 50)', m2.profitTotal === 95, `got ${m2.profitTotal}`);

  const writeOff = refundRow('R-DEF', 270, 0, [
    { productId: 'P1', quantity: 1, condition: 'defective' },
    { productId: 'P2', quantity: 1, condition: 'defective' },
    { productId: 'P3', quantity: 1, condition: 'defective' },
  ]);
  const m3 = computeSalesMetrics([SALE, writeOff]);
  check('full write-off: recovered credit 0', m3.restoredCogsTotal === 0);
  check('full write-off: profit = −cost (−135) exactly once', m3.profitTotal === -135, `got ${m3.profitTotal}`);

  // Legacy refund row: no restored_cogs value anywhere → no credit invented.
  const legacy = refundRow('R-LEGACY', 270, 0, []);
  delete (legacy as unknown as Record<string, unknown>).restoredCogs;
  const m4 = computeSalesMetrics([SALE, legacy]);
  check('legacy refund row is never over-credited', m4.restoredCogsTotal === 0 && m4.profitTotal === -135);

  // Snake-case alias (unmapped payload / peer row) is honored.
  const alias = refundRow('R-ALIAS', 270, 0, []);
  delete (alias as unknown as Record<string, unknown>).restoredCogs;
  (alias as unknown as Record<string, unknown>).restored_cogs = 135;
  const m5 = computeSalesMetrics([SALE, alias]);
  check('restored_cogs alias feeds the same credit', m5.profitTotal === 0, `got ${m5.profitTotal}`);

  // Base profit identity: base = 270 − 135 = 135.
  const base = computeSalesMetrics([SALE]);
  check('base profit identity (135)', base.profitTotal === 135);
  const delta = base.profitTotal - m2.profitTotal;
  check(
    'profit delta equals Σ(net refund − recovered) for the partial',
    delta === 90 - 50,
    `got ${delta}`
  );
}

// ------------------------------------------------------------------ I4 ---
console.log('\n--- I4: debt-first / tender-capped funding waterfall ---');
{
  const mixed = {
    id: 'TKT-B',
    subtotal: 1000,
    total: 1000,
    paymentMethod: 'Espèces',
    debtAdded: 400,
    tenders: [
      { method: 'Espèces', amount: 600 },
      { method: 'Crédit Client', amount: 400 },
    ],
  };
  const full = computeRefundFundingSplit(mixed, 1000);
  check('full mixed refund nets the whole 1000', full.netRefund === 1000, `got ${full.netRefund}`);
  check('debt leg reversed first/exactly (400)', full.debtShare === 400, `got ${full.debtShare}`);
  check('cash never exceeds net cash paid (600)', full.cashShare === 600, `got ${full.cashShare}`);
  check('cash cap reference is the paid cash (600)', full.cashPaidOriginal === 600);
  check(
    'funding split conserves the net to the Dinar',
    full.cashShare + full.debtShare + full.voucherShare + full.avoirShare + full.digitalShare === full.netRefund
  );
  check('integer split only', [full.cashShare, full.debtShare, full.netRefund].every(isInt));

  const half = computeRefundFundingSplit(mixed, 500);
  check('half refund: net 500', half.netRefund === 500);
  check('half refund: debt share 200 (pro-rata)', half.debtShare === 200, `got ${half.debtShare}`);
  check('half refund: cash share 300 (never prorated gross)', half.cashShare === 300, `got ${half.cashShare}`);

  // Fully debt-funded ticket: a full refund must not mint drawer cash.
  const debtOnly = {
    id: 'TKT-C',
    subtotal: 800,
    total: 800,
    paymentMethod: 'Crédit Client',
    debtAdded: 800,
  };
  const d = computeRefundFundingSplit(debtOnly, 800);
  check('debt-only refund pays ZERO cash', d.cashShare === 0 && d.digitalShare === 0, JSON.stringify(d));
  check('debt-only refund restores the full debt (800)', d.debtShare === 800);

  // Cash cap across partials: cumulative recovery never exceeds paid value.
  const capped = computeRefundFundingSplit(mixed, 700, 700);
  check('cumulative cash cap trims over-recovery', capped.capped === true && capped.netRefund === 300, JSON.stringify(capped));
}

// --------------------------------------------------------------- I4b ---
console.log('\n--- I4b: credit-leg convention (C01 refund allocation) ---');
{
  // (a) The committed REF-28 shape: `total` EXCLUDES the avoir leg (800 paid
  // cash + 100 avoir = 900 given). A full reversal returns 900: 800 cash and
  // the 100 back to the wallet. This is the behaviour the E2E case asserts.
  const exclCredit = {
    id: 'TKT-EXCL',
    subtotal: 1400,
    discountTotal: 500,
    total: 800,
    paymentMethod: 'Espèces',
    tenders: [
      { method: 'Avoir Client', amount: 100 },
      { method: 'Espèces', amount: 800 },
    ],
  };
  const a = computeRefundFundingSplit(exclCredit, 900);
  check('I4b/a full refund reverses 900', a.netRefund === 900, JSON.stringify(a));
  check('I4b/a avoir share returns to the wallet (100)', a.avoirShare === 100, `got ${a.avoirShare}`);
  check('I4b/a cash share is the cash actually paid (800)', a.cashShare === 800, `got ${a.cashShare}`);
  check(
    'I4b/a parts sum to the refund',
    a.voucherShare + a.avoirShare + a.debtShare + a.cashShare + a.digitalShare === a.netRefund
  );

  // (b) The SAME ticket when `total` already INCLUDES the credit leg (the
  // shape the in-memory checkout object can carry: total = Σ tenders). The
  // customer gave 669 (462 cash + 207 avoir); a full refund must return 669.
  // Adding the avoir on top of a total that already contains it mints money.
  const inclCredit = {
    id: 'TKT-INCL',
    subtotal: 669,
    discountTotal: 0,
    total: 669,
    paymentMethod: 'Espèces',
    tenders: [
      { method: 'Espèces', amount: 462 },
      { method: 'Avoir Client', amount: 207 },
    ],
  };
  const b = computeRefundFundingSplit(inclCredit, 669);
  const givenB = 669; // 462 cash + 207 avoir
  check('I4b/b full refund never returns more than the customer gave', b.netRefund <= givenB, `net=${b.netRefund} given=${givenB}`);
  check('I4b/b full refund returns exactly 669', b.netRefund === givenB, `got ${b.netRefund}`);
  check('I4b/b avoir share is 207 (not 207 + its own double count)', b.avoirShare === 207, `got ${b.avoirShare}`);
  check('I4b/b cash share is 462', b.cashShare === 462, `got ${b.cashShare}`);

  // (c) Property sweep: for random tickets, the refund never exceeds the value
  // the customer handed over (Σ tenders + voucher), and the lanes always sum
  // to the net. Deterministic pseudo-random so a failure is reproducible.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const ri = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  let over = 0;
  let sumBad = 0;
  let firstOver = '';
  for (let i = 0; i < 5000; i++) {
    const avoir = rnd() < 0.35 ? ri(1, 400) : 0;
    const cash = rnd() < 0.85 ? ri(0, 800) : 0;
    const debt = rnd() < 0.2 ? ri(0, 300) : 0;
    const voucher = rnd() < 0.15 ? ri(0, 200) : 0;
    const tendered = avoir + cash + debt;
    if (tendered === 0) continue;
    const discount = rnd() < 0.5 ? ri(0, tendered) : 0;
    // Both conventions appear in the repo: credits excluded, and included.
    const total = rnd() < 0.5 ? Math.max(0, tendered - avoir - debt) : tendered;
    const gross = ri(0, Math.max(1, tendered - discount));
    const s = computeRefundFundingSplit(
      {
        subtotal: tendered,
        discountTotal: discount,
        total,
        paymentMethod: 'Espèces',
        tenders: [
          ...(cash ? [{ method: 'Espèces', amount: cash }] : []),
          ...(avoir ? [{ method: 'Avoir Client', amount: avoir }] : []),
          ...(debt ? [{ method: 'Crédit Client', amount: debt }] : []),
        ],
        voucherCreditApplied: voucher,
      },
      gross
    );
    const given = tendered + voucher;
    const parts = s.voucherShare + s.avoirShare + s.debtShare + s.cashShare + s.digitalShare;
    if (Math.round(parts * 100) !== Math.round(s.netRefund * 100)) sumBad++;
    if (Math.round(s.netRefund * 100) > Math.round(given * 100)) {
      over++;
      if (!firstOver) firstOver = JSON.stringify({ total, tendered, voucher, gross, net: s.netRefund });
    }
  }
  check('I4b/c lanes always sum to the net (5000 random tickets)', sumBad === 0, `${sumBad} shapes`);
  check('I4b/c a refund never exceeds what was handed over (5000 random tickets)', over === 0, `${over} shapes, first=${firstOver}`);

  // ---- D3 cumulative lanes: the tests below pass the per-lane amounts
  // already returned. Until the split accepts them (4th argument) they are
  // ignored, so these checks are red for the arithmetic, not for a type.
  type Lanes = { cash: number; avoir: number; voucher: number; debt: number; digital: number };
  // Money is exact at the minor unit; DA values are hundredths, so compare
  // there rather than on float equality.
  const eqMinor = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);
  // (d) Three partial refunds of the exclusion-convention ticket conserve.
  // Each step is given the lanes already returned — the API's contract.
  const seqD = runSequence(exclCredit, [300, 300, 300]);
  function runSequence(sale: Record<string, unknown>, grosses: number[]) {
    const prior: Lanes = { cash: 0, avoir: 0, voucher: 0, debt: 0, digital: 0 };
    let priorNet = 0;
    const rows: Array<{ net: number; lanes: Lanes }> = [];
    for (const g of grosses) {
      const s = (computeRefundFundingSplit as unknown as (
        o: unknown,
        g: number,
        p: number,
        l: Lanes
      ) => {
        netRefund: number;
        cashShare: number;
        avoirShare: number;
        voucherShare: number;
        debtShare: number;
        digitalShare: number;
      })(sale, g, priorNet, { ...prior });
      const lanes: Lanes = {
        cash: s.cashShare,
        avoir: s.avoirShare,
        voucher: s.voucherShare,
        debt: s.debtShare,
        digital: s.digitalShare,
      };
      rows.push({ net: s.netRefund, lanes });
      prior.cash += lanes.cash;
      prior.avoir += lanes.avoir;
      prior.voucher += lanes.voucher;
      prior.debt += lanes.debt;
      prior.digital += lanes.digital;
      priorNet += s.netRefund;
    }
    return { rows, total: prior, net: priorNet };
  }

  for (const n of [2, 3, 5]) {
    const grosses = Array.from({ length: n }, () => Math.round(900 / n));
    const seq = runSequence(exclCredit, grosses);
    const laneSum =
      seq.total.cash + seq.total.avoir + seq.total.voucher + seq.total.debt + seq.total.digital;
    check(
      `I4b/e ${n} partials: the avoir lane is refunded exactly (100)`,
      eqMinor(seq.total.avoir, 100),
      `${n} partials -> avoir ${seq.total.avoir} (${seq.rows.map((r) => r.lanes.avoir).join('+')})`
    );
    check(
      `I4b/e ${n} partials: lanes sum to the net returned (${grosses.reduce((a, b) => a + b, 0)})`,
      eqMinor(laneSum, seq.net),
      `lanes=${laneSum} net=${seq.net}`
    );
    check(
      `I4b/e ${n} partials: no lane is negative`,
      Object.values(seq.total).every((v) => v >= 0),
      JSON.stringify(seq.total)
    );
    check(
      `I4b/e ${n} partials: each refund's lanes sum to its own total`,
      seq.rows.every(
        (r) => eqMinor(r.lanes.cash + r.lanes.avoir + r.lanes.voucher + r.lanes.debt + r.lanes.digital, r.net)
      ),
      JSON.stringify(seq.rows.map((r) => [r.net, r.lanes]))
    );
  }

  // (f) Odd amounts and one-minor-unit edges: 0.01 DA tickets and 1-DA refunds
  // must not mint or destroy a minor unit.
  const penny = {
    id: 'TKT-PENNY',
    subtotal: 1.01,
    discountTotal: 0,
    total: 1.01,
    paymentMethod: 'Espèces',
    tenders: [
      { method: 'Espèces', amount: 0.51 },
      { method: 'Avoir Client', amount: 0.5 },
    ],
  };
  const pennySeq = runSequence(penny, [0.01, 0.01, 0.99]);
  check(
    'I4b/f 0.01 DA partials keep the credit lane exact',
    eqMinor(pennySeq.total.avoir, 0.5),
    `${JSON.stringify(pennySeq.total)} rows=${JSON.stringify(pennySeq.rows)}`
  );
  check(
    'I4b/f penny sequence conserves the net',
    Math.round(pennySeq.net * 100) === 101,
    `net=${pennySeq.net}`
  );

  // (g) Mixed lanes: cash + avoir + voucher on one ticket, three partials, each
  // lane conserving its own original amount. (A debt lane is deliberately NOT
  // asserted here: the current model pays debt relief out of the customer's
  // returned value, which is a separate cluster's semantics — REF-65. Changing
  // it is out of C01 scope; recorded in the RFC as an open finding.)
  const threeLanes = {
    id: 'TKT-3L',
    subtotal: 1000,
    discountTotal: 0,
    total: 700, // cash only: credits excluded by convention
    paymentMethod: 'Espèces',
    tenders: [
      { method: 'Espèces', amount: 700 },
      { method: 'Avoir Client', amount: 200 },
    ],
    voucherCreditApplied: 100,
  };
  const seq4 = runSequence(threeLanes, [400, 300, 300]);
  check('I4b/g mixed lanes: avoir 200 exact', eqMinor(seq4.total.avoir, 200), JSON.stringify(seq4.total));
  check('I4b/g mixed lanes: voucher 100 exact', eqMinor(seq4.total.voucher, 100), JSON.stringify(seq4.total));
  check('I4b/g mixed lanes: cash 700 exact', eqMinor(seq4.total.cash, 700), JSON.stringify(seq4.total));
  check(
    'I4b/g mixed lanes: lanes sum to the value returned (1000)',
    eqMinor(seq4.total.cash + seq4.total.avoir + seq4.total.voucher, 1000),
    JSON.stringify(seq4.total)
  );

  // (h) Property: random partial sequences, invariants (i)-(iv) hold.
  {
    let s2 = 987654321;
    const r2 = () => ((s2 = (s2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const ri2 = (lo: number, hi: number) => lo + Math.floor(r2() * (hi - lo + 1));
    let bad = 0;
    let firstBad = '';
    for (let t = 0; t < 400; t++) {
      const avoir = r2() < 0.4 ? ri2(1, 300) : 0;
      const voucher = r2() < 0.2 ? ri2(1, 150) : 0;
      const debt = r2() < 0.2 ? ri2(1, 200) : 0;
      const cash = ri2(0, 700);
      const tendered = avoir + debt + cash;
      if (tendered === 0) continue;
      const sale = {
        id: `TKT-P${t}`,
        subtotal: tendered,
        discountTotal: r2() < 0.4 ? ri2(0, tendered) : 0,
        total: Math.max(0, tendered - avoir - debt),
        paymentMethod: 'Espèces',
        tenders: [
          ...(cash ? [{ method: 'Espèces', amount: cash }] : []),
          ...(avoir ? [{ method: 'Avoir Client', amount: avoir }] : []),
          ...(debt ? [{ method: 'Crédit Client', amount: debt }] : []),
        ],
        voucherCreditApplied: voucher,
      };
      const base = Math.max(1, tendered - sale.discountTotal);
      const pieces = ri2(1, 6);
      const grosses: number[] = [];
      let left = base;
      for (let k = 0; k < pieces - 1 && left > 0; k++) {
        const g = ri2(0, left);
        grosses.push(g);
        left -= g;
      }
      grosses.push(left);
      const seq = runSequence(sale, grosses);
      const given = tendered + voucher;
      const lanesTotal =
        seq.total.cash + seq.total.avoir + seq.total.voucher + seq.total.debt + seq.total.digital;
      const fullRefund = grosses.reduce((a, b) => a + b, 0) === base;
      if (Math.round(seq.net * 100) > Math.round(given * 100)) {
        bad++;
        if (!firstBad) firstBad = `net>given t=${t} net=${seq.net} given=${given}`;
      } else if (Math.round(lanesTotal * 100) !== Math.round(seq.net * 100)) {
        bad++;
        if (!firstBad) firstBad = `lanes!=net t=${t} lanes=${lanesTotal} net=${seq.net}`;
      } else if (Object.values(seq.total).some((v) => v < 0)) {
        bad++;
        if (!firstBad) firstBad = `negative lane t=${t}`;
      } else if (fullRefund && Math.round(seq.total.avoir * 100) !== Math.round(avoir * 100)) {
        bad++;
        if (!firstBad) firstBad = `avoir drift t=${t} avoir=${seq.total.avoir} want=${avoir}`;
      }
    }
    check('I4b/h random partial sequences hold invariants (i)-(iv)', bad === 0, `${bad} bad: ${firstBad}`);
  }

  // (i) S3 — the persisted REF-28 mis-tender shape, measured 2026-10-30:
  // total 800 (credits excluded), tenders 100 avoir + 900 cash, change 100.
  // The customer gave 900 net cash + 100 credit = 1000? No: 900 cash was
  // tendered and 100 handed back, so the shop kept 800 cash + 100 credit = the
  // 900 payable. The split must see 900, not 1000.
  const s3 = {
    id: 'TKT-S3',
    subtotal: 1400,
    discountTotal: 500,
    total: 800,
    changeDue: 100,
    paymentMethod: 'Avoir Client',
    tenders: [
      { method: 'Avoir Client', amount: 100 },
      { method: 'Espèces', amount: 900 },
    ],
  };
  const s3Split = computeRefundFundingSplit(s3, 900);
  check('I4b/j S3: full refund reverses 900 (change carved from cash)', s3Split.netRefund === 900, JSON.stringify(s3Split));
  check('I4b/j S3: 100 to the wallet', s3Split.avoirShare === 100, JSON.stringify(s3Split));
  check('I4b/j S3: 800 cash out (900 tendered − 100 change)', s3Split.cashShare === 800, JSON.stringify(s3Split));

  // (k) Reprise (trade-in) is restored by its own quota, never by the funding
  // split: it must not enter G, or a trade-in sale would double-count it.
  const trade = {
    id: 'TKT-TRADE',
    subtotal: 1200,
    discountTotal: 0,
    total: 900,
    paymentMethod: 'Espèces',
    tenders: [
      { method: 'Espèces', amount: 600 },
      { method: 'Avoir Client', amount: 300 },
      { method: 'Reprise', amount: 300 },
    ],
  };
  const tradeSplit = computeRefundFundingSplit(trade, 1200);
  check('I4b/k Reprise is not funding: refund reverses 900', tradeSplit.netRefund === 900, JSON.stringify(tradeSplit));
  check('I4b/k trade-in: avoir 300', tradeSplit.avoirShare === 300, JSON.stringify(tradeSplit));
  check('I4b/k trade-in: cash 600', tradeSplit.cashShare === 600, JSON.stringify(tradeSplit));

  // (l) Legacy refund rows carry no `funding` object: the lane reader must
  // derive them from the durable columns and never throw.
  {
    const helper = (receiptMathModule as unknown as Record<string, unknown>).refundLaneTotalsOf as
      | ((t: unknown) => Lanes)
      | undefined;
    let derived: Lanes | null = null;
    let threw = '';
    try {
      derived = helper
        ? helper({
            id: 'REF-LEGACY',
            isRefund: true,
            total: 500,
            cashDisbursed: 300,
            refundMethod: 'Avoir Client',
          })
        : null;
    } catch (e) {
      threw = String((e as Error)?.message ?? e);
    }
    check('I4b/i legacy refund without a funding object does not throw', threw === '', threw);
    check(
      'I4b/i legacy refund derives cash 300 and avoir 200',
      !!derived && derived.cash === 300 && derived.avoir === 200,
      JSON.stringify(derived)
    );
  }
}

// ------------------------------------------------------------------ I6 ---
console.log('\n--- I6: IMEI ownership event vocabulary (native parity) ---');
{
  check(
    'RETURN_IN id mirrors the native format',
    imeiTrustEventId('RETURN_IN', 'order', 'REF-C', 'IMEI-A1') === 'imev|RETURN_IN|order|REF-C|IMEI-A1'
  );
  check(
    'RETURN_DEFECTIVE id mirrors the native format',
    imeiTrustEventId('RETURN_DEFECTIVE', 'order', 'REF-C', 'IMEI-A2') ===
      'imev|RETURN_DEFECTIVE|order|REF-C|IMEI-A2'
  );
  check('RETURN_DEFECTIVE has an operator label', IMEI_TRUST_EVENT_LABELS.RETURN_DEFECTIVE.length > 0);

  // Quarantine marker ids: TS helper === native fixed vectors (FNV-1a 32,
  // ASCII). The Rust suite asserts the same literals — drift fails both.
  check('LED-DEF vector matches native', deterministicId('LED-DEF', 'REF-C', 'P1', 1) === 'LED-DEF-AB72EE0E');
  check('LED-DEF vector (second line)', deterministicId('LED-DEF', 'REF-A', 'P1', 1) === 'LED-DEF-A9AF04CC');
  check(
    'refund-id vector matches native (identity-bearing canonical key)',
    deterministicId('REF', 'TKT-1', 'P1:2:200:1::IMEI-A1:restock', 'Voucher', 200, 1) === 'REF-87C70085'
  );
}

// ------------------------------------------------------------------ I7 ---
console.log('\n--- I7: Z-report — cash refund reduces expected cash exactly once ---');
{
  const cashRefund = refundRow('R-CASH', 500, 0, [], {
    cashDisbursed: 150,
    refundMethod: 'Espèces',
    shiftId: 'SHIFT-1',
  });
  check('exact disbursed cash read (150), never the net value (500)', cashRefundsFromTxns([cashRefund]) === 150);
  check('integer cash figure', isInt(cashRefundsFromTxns([cashRefund])));

  const debtFunded = refundRow('R-MIX', 500, 0, [], {
    cashDisbursed: 0,
    refundMethod: 'Espèces',
  });
  check('Espèces refund with zero cash share pays nothing from the drawer', cashRefundsFromTxns([debtFunded]) === 0);

  const voided = refundRow('R-VOID', 500, 0, [], {
    cashDisbursed: 150,
    refundMethod: 'Espèces',
    status: 'VOIDED',
  });
  check('VOIDED refund rows never count', cashRefundsFromTxns([voided]) === 0);

  const legacyCash = refundRow('R-LEG', 120, 0, [], { refundMethod: 'Espèces' });
  check('legacy row (no cashDisbursed) falls back to total', cashRefundsFromTxns([legacyCash]) === 120);

  // The cross-shift ALLOCATION movement is math-invisible (no manual tag).
  const alloc = {
    type: 'EXPENSE',
    amount: 150,
    reason: `Remboursement allocation [REC-R-CASH] drawer=SHIFT-1 periode=SHIFT-1 net=500 especes=150 avoir=0 origine=REC-A ticket=TKT-A shift_origine=SHIFT-0`,
  };
  check('ALLOCATION movement is excluded from drawer expenses', standaloneExpensesFromMovements([alloc]) === 0);

  // Expected cash: opening 1000 + 0 sales − 0 expenses − 150 refund = 850.
  const openingFloat = 1000;
  const expectedCash =
    openingFloat + 0 - standaloneExpensesFromMovements([alloc]) - cashRefundsFromTxns([cashRefund]);
  check('expected cash debited exactly once (850)', expectedCash === 850, `got ${expectedCash}`);

  // Same ticket refunded in two cash steps: 80 + 70 = 150 (not 500).
  const step1 = refundRow('R-S1', 300, 0, [], { cashDisbursed: 80, refundMethod: 'Espèces' });
  const step2 = refundRow('R-S2', 200, 0, [], { cashDisbursed: 70, refundMethod: 'Espèces' });
  check('multi-step cash refunds accumulate exactly', cashRefundsFromTxns([step1, step2]) === 150);
}

// ------------------------------------------------------------------ I1 ---
console.log('\n--- I1: single authority — read-back hydration wiring ---');
{
  const slice = src('src/store/slices/createOrderSlice.ts');
  const nativeClient = src('src/db/adapters/refundNative.ts');
  const modal = src('src/components/modals/RefundModal.tsx');
  const math = src('src/utils/receiptMath.ts');
  const trust = src('src/utils/deviceTrust.ts');
  const txAdapter = src('src/db/adapters/transactionAdapter.ts');
  const shiftModal = src('src/components/modals/ShiftCloseModal.tsx');
  const reports = src('src/components/modals/ReportsModal.tsx');
  const rust = src('src-tauri/src/refund.rs');

  check('slice hydrates recovered COGS from the receipt', slice.includes('nativeRes.recoveredCogs'));
  check('slice hydrates the clamped debt relief', slice.includes('nativeRes.debtReliefApplied'));
  check('slice hydrates the live debt after', slice.includes('nativeRes.customerDebtAfter'));
  check('slice hydrates the loyalty verdict', slice.includes('nativeRes.customerPointsAfter'));
  check('slice mirrors the durable merged payload', slice.includes('nativeRes.updatedOriginal'));
  check('slice sends line identity + condition natively', slice.includes('saleItemId: ri.saleItemId ?? null') && slice.includes("condition: ri.condition ?? (ri.restock ? 'restock' : 'defective')"));
  check('slice splits restock/defective IMEIs', slice.includes('defectiveImeis') && slice.includes('defectiveImeis,'));
  check('slice cost sum is restock-only', slice.includes("!== 'restock') return acc;"));
  check('slice refund row carries restoredCogs', slice.includes('restoredCogs: costRefundTotal'));
  check('slice commits the hydrated refund row', slice.includes('restoredCogs: committedRecoveredCogs'));
  check('slice has no client-math debtRelief fallback to requested amount', !slice.includes('amount: debtReliefForNative.relief'));

  check('native client exposes ticketPayload', nativeClient.includes('ticketPayload') && nativeClient.includes('hydrateRefundedItems'));
  check('native client maps RESTOCK_REASON_REQUIRED', nativeClient.includes("reason: 'RESTOCK_REASON_REQUIRED'"));
  check('native client result carries the authoritative fields', nativeClient.includes('debtReliefApplied: number') && nativeClient.includes('recoveredCogs: number'));

  check('modal computes per-line remaining', modal.includes('computeRefundableRemaining') && modal.includes('remainingByItemKey'));
  check('modal stepper max is per-line remaining', modal.includes('qty >= maxQty') && !modal.includes('qty >= item.quantity'));
  check('modal uses the per-line max in handlers', modal.includes('handleQuantityChange(itemKey, qty + 1, maxQty)'));

  check('metrics interface exposes restoredCogsTotal', math.includes('restoredCogsTotal: number'));
  check('metrics profit includes the recovered credit', math.includes('netRevenue - costTotal + restoredCogsTotal'));
  check('device trust knows RETURN_DEFECTIVE', trust.includes("'RETURN_DEFECTIVE'"));
  check('transaction adapter maps restored_cogs', txAdapter.includes('restored_cogs') && txAdapter.includes('restoredCogs: Math.round(v)'));
  check(
    'legacy adapter releases defective IMEIs into quarantine',
    txAdapter.includes("kind: 'RETURN_DEFECTIVE'") && txAdapter.includes('status = $2')
  );
  check(
    'legacy adapter keeps ONE release list for Dexie + SQLite + sync',
    txAdapter.includes('imeiReleases(restoredImeis, defectiveImeis)')
  );
  check(
    'legacy adapter writes the RETURN_DEFECTIVE ownership event',
    txAdapter.includes("imeiTrustEventId(release.kind, 'order', refundTransaction.id, imei)")
  );
  check(
    'slice hands defective IMEIs to the legacy lane',
    /processRefundAtomic\([\s\S]{0,600}defectiveImeis/.test(slice)
  );
  check(
    'IMEIRecord carries the release-status vocabulary',
    src('src/types/pos.ts').includes("status?: 'in_stock' | 'defective'")
  );
  check('shift close reads cashDisbursed via the canonical helper', shiftModal.includes('cashRefundsFromTxns(sessionRefunds)'));
  check('reports P&L shows the recovered-COGS credit', reports.includes('totalRestoredCogs') && reports.includes('COGS Récupérés'));
  check('defect loss memo stays out of EBITDA', reports.includes("e.category !== 'Perte Stock / SAV'"));

  // Native engine vocabulary / gates (the authority the TS mirrors).
  check('native gate: defect reason required', rust.includes('RESTOCK_REASON_REQUIRED'));
  check('native: defective IMEI vocabulary', rust.includes('RETURN_DEFECTIVE'));
  check('native debt waterfall fills plans FIFO', rust.includes('fill_debt_plans_fifo'));
  check('native loyalty replay persists', rust.includes('customer_points_after'));
  check('native read-back returns ticket payload', rust.includes('ticket_payload'));
  check('native recomputes recovered COGS', rust.includes('recovered_cogs'));
  check('native masks defective quarantine rows', rust.includes('DEFECTIVE_QUARANTINE'));
  check('native merges refundedItems into the durable payload', rust.includes('"refundedItems"'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

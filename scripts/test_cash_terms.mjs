/**
 * cashTerms unification guard: every surface that computes expected cash
 * (booking, close preview, Reports, Z report) must share THESE predicates.
 * Pure-logic tests — no DB, no store. Transpiles src/utils/cashTerms.ts
 * directly (dependency-free by design).
 */

const ROOT = process.cwd();

async function loadCashTerms() {
  const ts = await import('typescript');
  const fs = await import('node:fs');
  const absPath = `${ROOT}/src/utils/cashTerms.ts`;
  const src = fs.readFileSync(absPath, 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: absPath,
  });
  return import('data:text/javascript;base64,' + Buffer.from(out.outputText).toString('base64'));
}

const {
  cashSalesFromTxns,
  cashRefundsFromTxns,
  exchangeCashOutFromMovements,
  standaloneDepositsFromMovements,
  standaloneExpensesFromMovements,
  MANUAL_MOVEMENT_TAG,
  DRAWER_REASON_PREFIXES,
} = await loadCashTerms();

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('========================================================================');
console.log('🧮 CASH TERMS UNIFICATION GUARD');
console.log('========================================================================');

// ── funding split (receiptMath, same rewrite pattern as test_money_fixes) ──
const ts2 = await import('typescript');
const fs2 = await import('node:fs');
const toDataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const trFile = (abs) => ts2.transpileModule(fs2.readFileSync(abs, 'utf8'), {
  compilerOptions: { module: ts2.ModuleKind.ESNext, target: ts2.ScriptTarget.ES2020 }, fileName: abs,
}).outputText;
const taxUrl = toDataUrl(trFile(`${ROOT}/src/utils/taxEngine.ts`));
const pricingUrl = toDataUrl(trFile(`${ROOT}/src/utils/pricingEngine.ts`));
let rmSrc = fs2.readFileSync(`${ROOT}/src/utils/receiptMath.ts`, 'utf8');
rmSrc = rmSrc.replace(/from\s+(['"])\.\/pricingEngine\1/g, `from '${pricingUrl}'`);
rmSrc = rmSrc.replace(/from\s+(['"])\.\/taxEngine\1/g, `from '${taxUrl}'`);
const { computeRefundFundingSplit } = await import(toDataUrl(ts2.transpileModule(rmSrc, {
  compilerOptions: { module: ts2.ModuleKind.ESNext, target: ts2.ScriptTarget.ES2020 }, fileName: 'receiptMath.ts',
}).outputText));

console.log('\n--- computeRefundFundingSplit (anti-arbitrage C1/C2/C3) ---');
// Pure-cash sale with a 10% cart discount: 10000 gross → 9000 net.
{
  const s = computeRefundFundingSplit({ total: 9000, subtotal: 10000, tenders: [{ method: 'Espèces', amount: 9000 }] }, 10000);
  check('discounted cash sale full refund nets 9000, all cash', s.netRefund === 9000 && s.cashShare === 9000, JSON.stringify(s));
}
// Voucher sale: 10000 gross, 2000 voucher, 8000 cash.
{
  const s = computeRefundFundingSplit(
    { total: 8000, subtotal: 10000, voucherCreditApplied: 2000, tenders: [{ method: 'Espèces', amount: 8000 }] }, 10000);
  check('voucher sale: full value restored (8000 cash + 2000 voucher), never gross cash',
    s.netRefund === 10000 && s.cashShare === 8000 && s.voucherShare === 2000, JSON.stringify(s));
}
// Avoir sale: 10000 gross, 3000 avoir tender, 7000 cash.
{
  const s = computeRefundFundingSplit(
    { total: 7000, subtotal: 10000, tenders: [{ method: 'Avoir Client', amount: 3000 }, { method: 'Espèces', amount: 7000 }] }, 10000);
  check('avoir sale: full value restored (7000 cash + 3000 wallet), wallet never cashed',
    s.netRefund === 10000 && s.cashShare === 7000 && s.avoirShare === 3000, JSON.stringify(s));
}
// All-credit sale: 10000 on debt.
{
  const s = computeRefundFundingSplit(
    { total: 10000, subtotal: 10000, debtAdded: 10000, tenders: [{ method: 'Crédit Client', amount: 10000 }] }, 10000);
  check('credit sale: zero cash, full debt share', s.netRefund === 10000 && s.cashShare === 0 && s.debtShare === 10000, JSON.stringify(s));
}
// Partial refund: half the lines back on a voucher sale.
{
  const s = computeRefundFundingSplit(
    { total: 8000, subtotal: 10000, voucherCreditApplied: 2000, tenders: [{ method: 'Espèces', amount: 8000 }] }, 5000);
  check('partial refund splits pro-rata (5000 value: 4000 cash + 1000 voucher)',
    s.netRefund === 5000 && s.cashShare === 4000 && s.voucherShare === 1000, JSON.stringify(s));
}
// Cumulative cap: prior gross-format recovery bounds the second refund.
{
  const orig = { total: 8000, subtotal: 10000, voucherCreditApplied: 2000, tenders: [{ method: 'Espèces', amount: 8000 }] };
  const s = computeRefundFundingSplit(orig, 10000, 8000);
  check('cumulative cap trims to remaining recoverable (2000)',
    s.netRefund === 2000 && s.capped === true, JSON.stringify(s));
}
// Exactness: shares always sum to net.
{
  const s = computeRefundFundingSplit(
    { total: 7333, subtotal: 10000, voucherCreditApplied: 1111, tenders: [{ method: 'Avoir Client', amount: 2222 }, { method: 'Espèces', amount: 4000 }] }, 3333);
  check('shares sum exactly to netRefund',
    s.voucherShare + s.avoirShare + s.debtShare + s.cashShare === s.netRefund, JSON.stringify(s));
}

// ── cash sales ──
console.log('\n--- cashSalesFromTxns ---');
check(
  'tender-split cash minus change',
  cashSalesFromTxns([{ status: 'COMPLETED', tenders: [{ method: 'Espèces', amount: 5000 }], changeDue: 500, total: 4500 }]) === 4500,
  String(cashSalesFromTxns([{ status: 'COMPLETED', tenders: [{ method: 'Espèces', amount: 5000 }], changeDue: 500, total: 4500 }]))
);
check(
  'VOIDED excluded',
  cashSalesFromTxns([{ status: 'VOIDED', tenders: [{ method: 'Espèces', amount: 5000 }], total: 5000 }]) === 0
);
check(
  'isRefund excluded from sales',
  cashSalesFromTxns([{ status: 'COMPLETED', isRefund: true, paymentMethod: 'Espèces', total: 2000 }]) === 0
);
check(
  'legacy fallback paymentMethod Espèces',
  cashSalesFromTxns([{ status: 'COMPLETED', paymentMethod: 'Espèces', total: 3000 }]) === 3000
);
check(
  'non-cash method ignored',
  cashSalesFromTxns([{ status: 'COMPLETED', paymentMethod: 'BaridiMob', total: 3000 }]) === 0
);
check(
  'undefined tender amount reads as 0 (NaN-poison guard)',
  cashSalesFromTxns([{ status: 'COMPLETED', tenders: [{ method: 'Espèces' }], total: 999 }]) === 0
);
check(
  'mixed tenders count Espèces only',
  cashSalesFromTxns([{ status: 'COMPLETED', tenders: [{ method: 'Espèces', amount: 1000 }, { method: 'BaridiMob', amount: 5000 }], total: 6000 }]) === 1000
);
check(
  'exchange ticket (no tender, total 0) contributes 0',
  cashSalesFromTxns([{ status: 'COMPLETED', paymentMethod: 'Espèces', total: 0, changeDue: 0 }]) === 0
);

// ── cash refunds ──
console.log('\n--- cashRefundsFromTxns ---');
check(
  'Espèces refund counted',
  cashRefundsFromTxns([{ status: 'COMPLETED', isRefund: true, refundMethod: 'Espèces', paymentMethod: 'Espèces', total: 2000 }]) === 2000
);
check(
  'non-cash refund ignored',
  cashRefundsFromTxns([{ status: 'COMPLETED', isRefund: true, refundMethod: 'BaridiMob', paymentMethod: 'BaridiMob', total: 2000 }]) === 0
);
check(
  'non-refund rows never counted',
  cashRefundsFromTxns([{ status: 'COMPLETED', paymentMethod: 'Espèces', total: 2000 }]) === 0
);
check(
  'VOIDED refund excluded',
  cashRefundsFromTxns([{ status: 'VOIDED', isRefund: true, refundMethod: 'Espèces', total: 2000 }]) === 0
);

// ── movement terms ──
console.log('\n--- movement terms ---');
const exch = { type: 'EXPENSE', reason: `${DRAWER_REASON_PREFIXES.EXCHANGE_CASHOUT} (ticket R-1)`, amount: 1500 };
check('exchange cash-out counted', exchangeCashOutFromMovements([exch]) === 1500);
check(
  'twin EXPENSE (drop) never leaks into exchange term',
  exchangeCashOutFromMovements([{ type: 'EXPENSE', reason: 'Prélèvement Coffre (Cash Drop): x', amount: 9000 }]) === 0
);
const manualDep = { type: 'MANUAL_DEPOSIT', reason: `Apport monnaie ${MANUAL_MOVEMENT_TAG}`, amount: 4000 };
const twinDep = { type: 'MANUAL_DEPOSIT', reason: 'Versement Règlement Dette: X (Ticket Y)', amount: 7000 };
check('tagged manual deposit counted', standaloneDepositsFromMovements([manualDep, twinDep]) === 4000);
const manualExp = { type: 'EXPENSE', reason: `Achat café ${MANUAL_MOVEMENT_TAG}`, amount: 500 };
const twinExp = { type: 'EXPENSE', reason: "Dépense d'exploitation espèces (Loyer): local", amount: 20000 };
check('tagged manual expense counted, twin ignored', standaloneExpensesFromMovements([manualExp, twinExp]) === 500);
check(
  'exchange row never leaks into standalone terms',
  standaloneExpensesFromMovements([exch]) === 0 && standaloneDepositsFromMovements([exch]) === 0
);
check('empty/null inputs read as 0', cashSalesFromTxns(null) === 0 && cashRefundsFromTxns(undefined) === 0 && exchangeCashOutFromMovements([]) === 0);

console.log('\n========================================================================');
console.log(`CASH TERMS SUMMARY: ${pass} Passed, ${fail} Failed`);
console.log('========================================================================');
process.exit(fail === 0 ? 0 : 1);

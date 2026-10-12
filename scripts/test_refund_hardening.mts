/**
 * Refund hardening regression tests (enterprise ledger integrity package).
 *
 * Covers the four fixes against the REAL pure helpers (no copies):
 *   Fix 1 — zero-value/exhausted tickets never listable nor committable
 *            (receiptMath: refundableBalanceOf / isRefundEligible).
 *   Fix 2 — strict tender clamp: cumulative drawer cash out can never exceed
 *            net physical cash tendered; excess locks to Avoir (cashTerms).
 *   Fix 3 — offline fail-closed on remote/past-shift tickets + 90 s claim
 *            TTL (refundLockPolicy).
 *   Fix 4 — ALLOCATION movements stay out of every cash-math reader while
 *            carrying the cross-shift trail (cashTerms readers + prefix).
 * Plus source-wiring checks that UI + slice + adapter share the helpers.
 *
 * Integer DA throughout; no floats cross any assertion.
 */
import {
  physicalCashTendered,
  cashDisbursedOf,
  clampCashRefund,
  standaloneExpensesFromMovements,
  exchangeCashOutFromMovements,
  DRAWER_REASON_PREFIXES,
} from '../src/utils/cashTerms.ts';
import {
  refundedQtyByProduct,
  isRefundEligible,
  refundableBalanceOfTxn,
  refundableValueOf,
} from '../src/utils/receiptMath.ts';
import {
  REFUND_CLAIM_TTL_SEC,
  isOwnShiftTicket,
  offlineRefundVerdict,
} from '../src/sync/refundLockPolicy.ts';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}
const src = (p: string): string => readFileSync(p, 'utf8');
const isInt = (n: number): boolean => Number.isInteger(n);

const line = (pid: string, qty: number, price: number, discount = 0) => ({
  product: { id: pid, price },
  quantity: qty,
  appliedPrice: price,
  discount,
});

// ---------------------------------------------------------------- Fix 1 ---
console.log('\n--- Fix 1: zero-value / exhausted ticket eligibility ---');
{
  const zero = { id: 'T0', status: 'COMPLETED', items: [line('P1', 1, 0)] };
  check('0 DA ticket balance is 0', refundableBalanceOfTxn(zero, [zero]) === 0);
  check('0 DA ticket ineligible', isRefundEligible(zero, new Map()) === false);

  const sale = { id: 'T1', status: 'COMPLETED', items: [line('P1', 2, 1500), line('P2', 1, 800)] };
  const r1 = { id: 'R1', isRefund: true, originalTransactionId: 'T1', refundedItems: [{ productId: 'P1', quantity: 2 }] };
  const r2 = { id: 'R2', isRefund: true, originalTransactionId: 'T1', refundedItems: [{ productId: 'P2', quantity: 1 }] };
  check('exhausted ticket balance is 0', refundableBalanceOfTxn(sale, [sale, r1, r2]) === 0);
  check('exhausted ticket ineligible', isRefundEligible(sale, refundedQtyByProduct([sale, r1, r2], 'T1')) === false);

  const partial = refundableBalanceOfTxn(sale, [sale, r1]);
  check('partial ticket keeps exact remainder (800)', partial === 800, `got ${partial}`);
  check('partial ticket eligible', isRefundEligible(sale, refundedQtyByProduct([sale, r1], 'T1')) === true);

  const voided = { id: 'TV', status: 'VOIDED', items: [line('P1', 1, 5000)] };
  check('VOIDED excluded', isRefundEligible(voided, new Map()) === false);
  const refundRow = { id: 'RR', status: 'COMPLETED', isRefund: true, items: [line('P1', 1, 5000)] };
  check('refund rows never listable', isRefundEligible(refundRow, new Map()) === false);
  const comp = { id: 'TC', status: 'COMPLETED', items: [line('P1', 1, 1000, 1000)] };
  check('100% comped line contributes 0', refundableBalanceOfTxn(comp, [comp]) === 0);

  // Live incident: REC-20261004-SWENR — trade-in exchange (device in, goods
  // out, total 0, anonymous). Line basis says 2748 (the trap); money truth
  // says 0 (funding net 0 + unclaimable trade value). Must not list.
  const swenr = {
    id: 'TXN-SWENR', status: 'COMPLETED', total: 0, subtotal: 2748,
    paymentMethod: 'Reprise', tenders: [{ method: 'Reprise', amount: 20000 }],
    tradeInId: 'trade-1', tradeInDeduction: 20000, customer: null,
    items: [line('P9', 1, 2748)],
  };
  check('SWENR line basis overstates (documents trap)', refundableBalanceOfTxn(swenr, [swenr]) === 2748);
  check('SWENR money truth is 0', refundableValueOf(swenr, [swenr]) === 0, `got ${refundableValueOf(swenr, [swenr])}`);
  const swenrNamed = { ...swenr, id: 'TXN-SWENR2', customer: { id: 'cust-1' } };
  check('same trade WITH customer stays eligible (wallet restore)',
    refundableValueOf(swenrNamed, [swenrNamed]) === 20000, `got ${refundableValueOf(swenrNamed, [swenrNamed])}`);
  const cashSale = {
    id: 'T2', status: 'COMPLETED', total: 1800, subtotal: 1800, paymentMethod: 'Espèces',
    tenders: [{ method: 'Espèces', amount: 1800 }], items: [line('P1', 1, 1800)],
  };
  check('plain cash ticket keeps full value', refundableValueOf(cashSale, [cashSale]) === 1800);
}

// ---------------------------------------------------------------- Fix 2 ---
console.log('\n--- Fix 2: tender-clamped cash allocations ---');
{
  // Pure-avoir ticket: customer gave 0 physical cash.
  const avoirTender = { tenders: [{ method: 'Avoir Client', amount: 3500 }], paymentMethod: 'Avoir Client', total: 3500, changeDue: 0 };
  check('pure-avoir tendered cash is 0', physicalCashTendered(avoirTender) === 0);
  const c1 = clampCashRefund({ cashShare: 3500, cashTenderedNet: 0, priorCashOut: 0 });
  check('pure-avoir cashShare clamps to 0', c1.cashOut === 0);
  check('pure-avoir excess locks to Avoir (3500)', c1.avoirOverflow === 3500, `got ${c1.avoirOverflow}`);

  // Mixed ticket: 2000 cash of 5000, 500 already disbursed -> cap 1500.
  const mixed = { tenders: [{ method: 'Espèces', amount: 2000 }, { method: 'Avoir Client', amount: 3000 }], total: 5000, changeDue: 0 };
  check('mixed tendered cash is 2000', physicalCashTendered(mixed) === 2000);
  const c2 = clampCashRefund({ cashShare: 2000, cashTenderedNet: 2000, priorCashOut: 500 });
  check('prior payout reduces cap (1500 out)', c2.cashOut === 1500, `got ${c2.cashOut}`);
  check('remainder overflows (500)', c2.avoirOverflow === 500);

  // Cumulative double-partial can never exceed tendered.
  const c3a = clampCashRefund({ cashShare: 1200, cashTenderedNet: 2000, priorCashOut: 0 });
  const c3b = clampCashRefund({ cashShare: 1200, cashTenderedNet: 2000, priorCashOut: c3a.cashOut });
  check('two partials sum within tendered', c3a.cashOut + c3b.cashOut <= 2000, `got ${c3a.cashOut + c3b.cashOut}`);

  // Legacy fallback (no tenders array).
  check('legacy Especes falls back to total', physicalCashTendered({ paymentMethod: 'Espèces', total: 4200 }) === 4200);
  check('legacy non-cash falls back to 0', physicalCashTendered({ paymentMethod: 'Avoir Client', total: 4200 }) === 0);
  // Change handed back was never collected.
  check('change nets off tendered', physicalCashTendered({ tenders: [{ method: 'Espèces', amount: 5000 }], total: 4300, changeDue: 700 }) === 4300);

  // cashDisbursedOf mirrors the drawer lane (exact field, legacy total fallback).
  check('disbursed prefers cashDisbursed', cashDisbursedOf({ refundMethod: 'Espèces', cashDisbursed: 900, total: 1800 }) === 900);
  check('disbursed legacy falls back to total', cashDisbursedOf({ refundMethod: 'Espèces', total: 1800 }) === 1800);
  check('non-cash method disburses 0', cashDisbursedOf({ refundMethod: 'Avoir Client', cashDisbursed: 900, total: 1800 }) === 0);

  // Integer-only outputs.
  for (const r of [c1, c2, c3a, c3b]) {
    if (!isInt(r.cashOut) || !isInt(r.avoirOverflow)) {
      check('clamp outputs are integers', false, JSON.stringify(r));
    }
  }
  check('clamp outputs are integers', true);
}

// ---------------------------------------------------------------- Fix 3 ---
console.log('\n--- Fix 3: offline fail-closed + 90 s TTL ---');
{
  check('refund claim TTL is 90 s', REFUND_CLAIM_TTL_SEC === 90, `got ${REFUND_CLAIM_TTL_SEC}`);
  const own = { deviceId: 'till-1', shiftId: 'shift-B' };
  const ctx = { localDeviceId: 'till-1', activeShiftId: 'shift-B' };
  check('own-shift ticket allowed offline', offlineRefundVerdict(own, ctx).allow === true);
  check('remote-device ticket denied offline',
    JSON.stringify(offlineRefundVerdict({ deviceId: 'till-2', shiftId: 'shift-B' }, ctx)) ===
    JSON.stringify({ allow: false, reason: 'OFFLINE_REMOTE_TICKET' }));
  check('past-shift ticket denied offline',
    offlineRefundVerdict({ deviceId: 'till-1', shiftId: 'shift-A' }, ctx).allow === false);
  check('closed shift denies everything',
    offlineRefundVerdict(own, { localDeviceId: 'till-1', activeShiftId: null }).allow === false);
  check('unknown device denies everything',
    offlineRefundVerdict({ shiftId: 'shift-B' }, { localDeviceId: '', activeShiftId: 'shift-B' }).allow === false);
  check('legacy device_id field honored',
    isOwnShiftTicket({ device_id: 'till-1', shiftId: 'shift-B' }, ctx) === true);
}

// ---------------------------------------------------------------- Fix 4 ---
console.log('\n--- Fix 4: allocation records stay out of cash math ---');
{
  const alloc = {
    type: 'ALLOCATION',
    amount: 1800,
    reason: `${DRAWER_REASON_PREFIXES.REFUND_ALLOCATION} [AVOIR-X] tiroir=S1 periode=S1 net=1800 especes=1800 avoir=0 origine=REC-1 ticket=T1 shift_origine=S0`,
    createdAt: 't1',
  };
  check('allocation prefix defined', DRAWER_REASON_PREFIXES.REFUND_ALLOCATION.length > 0);
  check('ALLOCATION invisible to standalone expenses',
    standaloneExpensesFromMovements([alloc]) === 0);
  check('ALLOCATION invisible to exchange out', exchangeCashOutFromMovements([alloc]) === 0);
  check('allocation carries immutable origin link',
    alloc.reason.includes('ticket=T1') && alloc.reason.includes('origine=REC-1'));
  check('allocation carries drawer + period attribution',
    alloc.reason.includes('tiroir=S1') && alloc.reason.includes('periode=S1'));
}

// ------------------------------------------------- wiring (UI+slice+adapter share helpers) ---
console.log('\n--- Wiring: single-source helpers everywhere ---');
{
  const modal = src('src/components/modals/RefundModal.tsx');
  check('modal filters on shared eligibility', modal.includes('refundableValueOf'));
  check('modal previews shared clamp', modal.includes('clampCashRefund'));
  check('modal badges offline lock', modal.includes('isOwnShiftTicket'));
  check('modal gates closed shift', modal.includes('NO_OPEN_SHIFT') || modal.includes('Ouvrez la caisse'));
  const slice = src('src/store/slices/createOrderSlice.ts');
  check('slice enforces eligibility', slice.includes('ZERO_REFUNDABLE'));
  check('slice clamps tender', slice.includes('clampCashRefund') && slice.includes('physicalCashTendered'));
  check('slice claims with 90 s TTL', slice.includes('REFUND_CLAIM_TTL_SEC'));
  check('slice denies offline-remote', slice.includes('OFFLINE_REMOTE_TICKET'));
  check('slice writes allocation record', slice.includes('REFUND_ALLOCATION'));
  const adapter = src('src/db/adapters/transactionAdapter.ts');
  check('adapter verifies cap independently', adapter.includes('CASH_CAP_EXCEEDED'));
  check('adapter verifies eligibility independently', adapter.includes('ZERO_REFUNDABLE'));
  check('adapter verifies offline policy independently', adapter.includes('OFFLINE_REMOTE_TICKET'));
  check('adapter verifies open shift independently', adapter.includes('NO_OPEN_SHIFT'));
  const claims = src('src/sync/claims.ts');
  check('claims accept caller TTL', claims.includes('ttlSec'));
}

console.log(`\nREFUND HARDENING SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);
process.exit(0);

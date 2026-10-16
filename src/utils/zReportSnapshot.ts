import type {
  CustomerDebtEntry,
  DenominationCount,
  ReceiptSettings,
  RepairOrder,
  SaleTransaction,
  StoreExpense,
  TradeInItem,
} from '../types/pos';
import { isTxInCloseScope } from '../db/adapters/shiftAdapter';
import {
  cashRefundsFromTxns,
  cashSalesFromTxns,
  exchangeCashOutFromMovements,
  savDepositsFromRepairs,
  savSettledFromTxns,
  standaloneDepositsFromMovements,
  standaloneExpensesFromMovements,
  tenderSplitFromTxns,
  zTicketNumber,
  DRAWER_REASON_PREFIXES,
} from './cashTerms';
import type { ZReportSnapshot } from '../components/receipt/ZReportPaper';

export interface CashDropLike {
  id: string;
  timestamp?: string;
  reason: string;
  amount: number;
}

export interface PayoutLike {
  id: string;
  timestamp?: string;
  amount: number;
}

export interface ZSnapshotShift {
  id?: string;
  openedAt?: string | null;
  closedAt?: string | null;
  openingFloat: number;
  openedBy?: string;
  cashierName?: string;
  movements?: Array<{ type?: string; amount?: number; reason?: string }>;
  denominations?: DenominationCount | null;
  closingDenominations?: DenominationCount | null;
}

export interface BuildZSnapshotArgs {
  settings?: ReceiptSettings | null;
  shift: ZSnapshotShift | null;
  shiftFloat: number;
  transactions: SaleTransaction[];
  customerDebts: CustomerDebtEntry[];
  storeExpenses: StoreExpense[];
  repairOrders: RepairOrder[];
  tradeIns: TradeInItem[];
  cashDrops: CashDropLike[];
  payouts: PayoutLike[];
  /** Physical count for the reconciliation block. */
  countedCash: number;
  /**
   * Whether a blind count was actually tallied. The interim Z report is a preview
   * printed BEFORE any count, so its `countedCash` is 0 and its derived variance
   * would read as a full-drawer shortage; it passes `false` and all three
   * renderers print "non effectué" instead of a figure. Defaults to `true` — the
   * close ticket is gated on a positive count (`ShiftCloseModal`), so every other
   * caller keeps its current numbers.
   */
  blindCountPerformed?: boolean;
  /** Frozen at snapshot time (pre-close for the close ticket). */
  closedAtISO: string;
  /** Closed-shift count feeding the Z ticket sequence. */
  closedShiftCount: number;
  /** Lock-screen cashier ultimate fallback (never blank output). */
  fallbackCashier?: string;
  closingDenominations?: DenominationCount | null;
  openingDenominations?: DenominationCount | null;
}

/**
 * Single definition of the Z-report numbers — the interim preview, the close
 * ticket, the ESC/POS twin and the mobile text all read this frozen snapshot,
 * so the four can never disagree. Windowing mirrors ShiftZReportModal exactly
 * (stamp-aware `isTxInCloseScope` for txns, `createdAt >= openedAt` for the
 * non-txn lanes; all-time fallback without an open shift).
 */
export function buildZSnapshot(a: BuildZSnapshotArgs): ZReportSnapshot {
  const openedAt = a.shift?.openedAt ?? null;
  const closedAt = a.shift?.closedAt ?? a.closedAtISO ?? null;
  const inShiftWindow = (iso: string | undefined): boolean => {
    if (!openedAt) return true;
    if (!iso) return true;
    if (iso < openedAt) return false;
    if (closedAt && iso > closedAt) return false;
    return true;
  };
  const safeTransactions = a.transactions || [];
  const shiftTxns = openedAt
    ? safeTransactions.filter((t) => isTxInCloseScope(t, { id: a.shift?.id, openedAt, closedAt }, a.closedAtISO))
    : safeTransactions;

  const totalCashSales = cashSalesFromTxns(shiftTxns);
  const totalCashRefunds = cashRefundsFromTxns(shiftTxns);
  const todayDebtSettlements = (a.customerDebts || [])
    .filter((d) => d.type === 'PAYMENT_SETTLED' && d.paymentMethod === 'Espèces' && inShiftWindow(d.createdAt))
    .reduce((acc, d) => acc + (d.amount || 0), 0);
  const todayCashExpenses = (a.storeExpenses || [])
    .filter((e) => e.paymentMethod === 'Espèces' && inShiftWindow(e.createdAt))
    .reduce((acc, e) => acc + (e.amount || 0), 0);
  const sessionMovements = a.shift?.movements || [];
  const savAcompteFromMovs = sessionMovements
    .filter(
      (m) =>
        m &&
        m.type === 'MANUAL_DEPOSIT' &&
        ((m.reason || '').includes('Acompte SAV') || (m.reason || '').includes('SAV_ACOMPTE'))
    )
    .reduce((acc, m) => acc + Math.max(0, Number(m.amount) || 0), 0);
  const savDeposits =
    savAcompteFromMovs > 0
      ? savAcompteFromMovs
      : savDepositsFromRepairs((a.repairOrders || []).filter((r) => inShiftWindow(r.createdAt)));
  const savSettled = savSettledFromTxns(shiftTxns);
  const tradeInCashOut = (a.tradeIns || [])
    .filter((t) => !t.creditToWallet && inShiftWindow(t.createdAt))
    .reduce((acc, t) => acc + (t.buybackValue || 0), 0);
  const totalDrops = (a.cashDrops || [])
    .filter((d) => inShiftWindow(d.timestamp))
    .reduce((acc, d) => acc + (d.amount || 0), 0);
  const totalPayouts = (a.payouts || [])
    .filter((p) => inShiftWindow(p.timestamp))
    .reduce((acc, p) => acc + (p.amount || 0), 0);
  const exchangeOut = exchangeCashOutFromMovements(sessionMovements);
  const soulteOut = sessionMovements
    .filter(
      (m) =>
        m.type === 'EXPENSE' &&
        (m.category === 'TRADE_IN_SOULTE' || (m.reason || '').startsWith(DRAWER_REASON_PREFIXES.SOULTE_CASHOUT))
    )
    .reduce((acc, m) => acc + Math.max(0, Number(m.amount) || 0), 0);
  const exchangeOutPure = Math.max(0, exchangeOut - soulteOut);
  const manualIn = standaloneDepositsFromMovements(sessionMovements);
  const manualOut = standaloneExpensesFromMovements(sessionMovements);

  const turnover = tenderSplitFromTxns(shiftTxns);
  const netSales = totalCashSales + turnover.card + turnover.credit - turnover.reprise;
  const openingFloat = a.shift?.openingFloat ?? a.shiftFloat;
  const expectedCash =
    openingFloat + totalCashSales + todayDebtSettlements + savDeposits + manualIn
    - totalCashRefunds - totalDrops - totalPayouts - todayCashExpenses - tradeInCashOut - exchangeOut - manualOut;

  const opener =
    (a.shift?.openedBy || '').trim() ||
    (a.shift?.cashierName || '').trim() ||
    (a.fallbackCashier || '').trim() ||
    'Caissier';

  return {
    storeName: a.settings?.storeName || 'MOBI ACCESSORIES',
    zNumber: zTicketNumber(a.closedShiftCount),
    openedAtISO: openedAt || a.closedAtISO,
    closedAtISO: a.closedAtISO,
    registerLabel: a.shift?.id ? `Caisse ${a.shift.id.slice(-8)}` : 'Caisse Principale',
    responsibleName: opener,
    openingFloat,
    cashSales: totalCashSales,
    cardSales: turnover.card,
    creditSales: turnover.credit,
    repriseTake: turnover.reprise,
    netSales,
    debtSettlements: todayDebtSettlements,
    savDeposits,
    savSettled,
    refunds: totalCashRefunds,
    expenses: todayCashExpenses,
    drops: totalDrops,
    payouts: totalPayouts,
    exchangeOut: exchangeOutPure,
    soulteOut,
    manualIn,
    manualOut,
    tradeInCashOut,
    expectedCash,
    // BUG-MONEY-02 fix: single-base aggregation — both legs unrounded, display
    // (formatDZD) rounds once. Rounding countedCash here while expectedCash
    // stays exact fabricated ±1 phantom variances on half-dinar rows.
    countedCash: Math.max(0, Number(a.countedCash) || 0),
    variance: (Number(a.countedCash) || 0) - expectedCash,
    // Carried, not inferred from `countedCash`: a legitimately empty drawer is a
    // real count of 0, and an un-counted drawer is a different fact entirely.
    // Only the caller knows which one it is.
    blindCountPerformed: a.blindCountPerformed ?? true,
    dropsList: (a.cashDrops || [])
        .filter((d) => inShiftWindow(d.timestamp))
        .map((d) => ({ id: d.id, reason: d.reason, amount: d.amount })),
    closingDenominations: a.closingDenominations ?? a.shift?.closingDenominations ?? null,
    openingDenominations: a.openingDenominations ?? a.shift?.denominations ?? null,
  };
}

/**
 * Audit detail for the blind-count reveal, and nothing else.
 *
 * The blind count exists so the cashier commits to a figure BEFORE the software
 * shows the expected drawer balance. That figure is the whole collusion surface:
 * once revealed, the operator can adjust the count to it. So the audit line
 * records THAT a reveal happened, and deliberately records NO monetary value —
 * not the counted amount, not the expected balance, not the variance.
 *
 * This is not squeamishness: `security_audit_logs` is synced to peers and
 * included in the backup merge, so a variance figure written here would land in
 * the one table every device and every restore can read, outliving the shift it
 * was meant to grade. `zNumber` is a document number, not a concealed value, so
 * it stays — an accountability event with no document reference is useless.
 *
 * The type deliberately accepts no money fields, so a future caller cannot widen
 * it by accident: the only inputs are the ones safe to journal.
 */
export function blindRevealAuditDetail(args: { zNumber?: string | null; cashier?: string | null }): string {
  const z = (args.zNumber ?? '').trim() || 'Z (non numérotée)';
  const who = (args.cashier ?? '').trim() || 'Caissier';
  return [
    `Réconciliation à Aveugle — révélation du solde théorique (${z}) par ${who}.`,
    "Montant compté, solde attendu et écart NON journalisés (valeur masquée).",
  ].join(' ');
}

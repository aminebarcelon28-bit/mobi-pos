import type {
  CustomerDebtEntry,
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
  openingFloat: number;
  openedBy?: string;
  cashierName?: string;
  movements?: Array<{ type?: string; amount?: number; reason?: string }>;
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
  /** Frozen at snapshot time (pre-close for the close ticket). */
  closedAtISO: string;
  /** Closed-shift count feeding the Z ticket sequence. */
  closedShiftCount: number;
  /** Lock-screen cashier ultimate fallback (never blank output). */
  fallbackCashier?: string;
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
  const inShiftWindow = (iso: string | undefined): boolean => {
    if (!openedAt) return true;
    if (!iso) return true;
    return iso >= openedAt;
  };
  const safeTransactions = a.transactions || [];
  const shiftTxns = openedAt
    ? safeTransactions.filter((t) => isTxInCloseScope(t, { id: a.shift?.id, openedAt }))
    : safeTransactions;

  const totalCashSales = cashSalesFromTxns(shiftTxns);
  const totalCashRefunds = cashRefundsFromTxns(shiftTxns);
  const todayDebtSettlements = (a.customerDebts || [])
    .filter((d) => d.type === 'PAYMENT_SETTLED' && d.paymentMethod === 'Espèces' && inShiftWindow(d.createdAt))
    .reduce((acc, d) => acc + (d.amount || 0), 0);
  const todayCashExpenses = (a.storeExpenses || [])
    .filter((e) => e.paymentMethod === 'Espèces' && inShiftWindow(e.createdAt))
    .reduce((acc, e) => acc + (e.amount || 0), 0);
  const savDeposits = savDepositsFromRepairs((a.repairOrders || []).filter((r) => inShiftWindow(r.createdAt)));
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
  const sessionMovements = a.shift?.movements || [];
  const exchangeOut = exchangeCashOutFromMovements(sessionMovements);
  const soulteOut = sessionMovements
    .filter(
      (m) => m.type === 'EXPENSE' && (m.reason || '').startsWith(DRAWER_REASON_PREFIXES.SOULTE_CASHOUT)
    )
    .reduce((acc, m) => acc + Math.max(0, Math.round(Number(m.amount) || 0)), 0);
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
    countedCash: Math.max(0, Math.round(a.countedCash || 0)),
    variance: Math.round(a.countedCash || 0) - expectedCash,
    dropsList: (a.cashDrops || [])
      .filter((d) => inShiftWindow(d.timestamp))
      .map((d) => ({ id: d.id, reason: d.reason, amount: d.amount })),
  };
}

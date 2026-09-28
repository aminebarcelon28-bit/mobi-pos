/**
 * Shared cash-drawer term predicates — the single definition of "what counts
 * as cash in / cash out" used by every surface that computes expected cash:
 *
 * - booking authority  (closeShift in shiftAdapter.ts, SQLite/Dexie rows)
 * - close preview      (ShiftCloseModal, session-scoped store rows)
 * - Reports reconciler (ReportsModal, date-range-filtered store rows + Dexie)
 * - interim Z report   (ShiftZReportModal, shift-window store rows)
 *
 * Surfaces differ ONLY in which rows they feed in (session window vs date
 * range vs all-time); the per-row math below must never be reimplemented
 * inline again — the last four cash bugs were all predicate drift between
 * copies (SAV imputation, missing refund outflow, missing exchange outflow,
 * NaN-poisoning tender sums).
 *
 * Money rules (integer DZD; corrupt rows read as 0, never NaN):
 * - cash in on a sale  = Espèces tender sum minus changeDue (change handed
 *   back was never in the drawer); legacy rows without tenders fall back to
 *   paymentMethod === 'Espèces' ? total : 0.
 * - VOIDED rows never count; isRefund rows never count as sales.
 * - cash out on a refund row (isRefund, COMPLETED, total = refunded amount) =
 *   total iff refundMethod/paymentMethod is Espèces.
 * - exchange cash-outs and standalone manual movements live ONLY in the
 *   movement lane (no source-table twin) — see the movement helpers.
 */
/**
 * Drawer-movement reason prefixes that carry machine meaning. Writers and
 * readers must both reference these — a literal drift silently drops money
 * from one lane's math. (Re-exported from constants/index for legacy
 * import sites; this module is the owner.)
 */
export const DRAWER_REASON_PREFIXES = {
  /** Cash handed back on a net-negative (exchange) ticket. Written by the
   * checkout slice post-commit; read by the exchange term below. */
  EXCHANGE_CASHOUT: 'Remboursement espèces échange',
} as const;

/** Tag appended to standalone (twin-less) manual movements at write time by
 * ShiftMovementModal — the ONLY writer of movements without a source-table
 * twin. Twin writers (drops, expenses, trade-ins, debts, repairs, exchanges,
 * compensations) never carry it, so tag presence identifies exactly the
 * movements no source-table term counts. Legacy untagged standalone rows
 * stay invisible (today's behavior — no regression, coverage grows forward).
 * Repair-balance deposits paid via the manual modal also carry it, which is
 * correct: balance payments have no source row either. */
export const MANUAL_MOVEMENT_TAG = '[saisie manuelle]';

export interface CashTxnLike {
  tenders?: Array<{ method?: string; amount?: number }> | null;
  paymentMethod?: string;
  refundMethod?: string;
  total?: number;
  /**
   * Exact cash disbursed through a refund row (processRefund persists it).
   * Preferred over total when present: total is the VALUE reversed (net),
   * cashDisbursed the DRAWER outflow (net of voucher/wallet/debt shares).
   * Legacy rows without it keep the old total===cash reading.
   */
  cashDisbursed?: number;
  changeDue?: number;
  isRefund?: boolean;
  status?: string;
}

export interface CashMovementLike {
  type?: string;
  amount?: number;
  reason?: string;
  createdAt?: string;
}

function toCashAmount(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/** Cash collected on non-void, non-refund sales. */
export function cashSalesFromTxns(txns: CashTxnLike[] | undefined | null): number {
  return (txns || [])
    .filter((t) => t && t.status !== 'VOIDED' && !t.isRefund)
    .reduce((acc, t) => {
      if (t.tenders && Array.isArray(t.tenders) && t.tenders.length > 0) {
        const cashTenderTotal = t.tenders
          .filter((tender) => tender && tender.method === 'Espèces')
          .reduce((sum, tender) => sum + (Number(tender.amount) || 0), 0);
        return acc + Math.max(0, cashTenderTotal - (Number(t.changeDue) || 0));
      }
      return t.paymentMethod === 'Espèces' ? acc + toCashAmount(t.total) : acc;
    }, 0);
}

/** Cash handed back on refund rows. */
export function cashRefundsFromTxns(txns: CashTxnLike[] | undefined | null): number {
  return (txns || [])
    .filter((t) => t && t.status !== 'VOIDED' && t.isRefund)
    .reduce((acc, t) => {
      if (!(t.refundMethod === 'Espèces' || t.paymentMethod === 'Espèces')) return acc;
      const d = t.cashDisbursed;
      return acc + (d === undefined || d === null ? toCashAmount(t.total) : toCashAmount(d));
    }, 0);
}

/** Exchange cash-outs: EXPENSE movements written post-commit for
 * net-negative tickets (no source-table twin by design). */
export function exchangeCashOutFromMovements(movs: CashMovementLike[] | undefined | null): number {
  return (movs || [])
    .filter((m) => m && m.type === 'EXPENSE' && (m.reason || '').startsWith(DRAWER_REASON_PREFIXES.EXCHANGE_CASHOUT))
    .reduce((acc, m) => acc + toCashAmount(m.amount), 0);
}

function isStandalone(m: CashMovementLike): boolean {
  return (m.reason || '').includes(MANUAL_MOVEMENT_TAG);
}

/** Twin-less manual deposits (generic apports, repair-balance payments). */
export function standaloneDepositsFromMovements(movs: CashMovementLike[] | undefined | null): number {
  return (movs || [])
    .filter((m) => m && m.type === 'MANUAL_DEPOSIT' && isStandalone(m))
    .reduce((acc, m) => acc + toCashAmount(m.amount), 0);
}

/** Twin-less manual expenses (generic décaissements). */
export function standaloneExpensesFromMovements(movs: CashMovementLike[] | undefined | null): number {
  return (movs || [])
    .filter((m) => m && m.type === 'EXPENSE' && isStandalone(m))
    .reduce((acc, m) => acc + toCashAmount(m.amount), 0);
}

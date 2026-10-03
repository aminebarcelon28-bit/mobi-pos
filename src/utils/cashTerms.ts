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
  /** Soulte boutique: shop owes the exchange difference, paid from drawer.
   * Written by the checkout slice post-commit (single net EXPENSE tagged
   * with the trade id); read by the exchange term below. */
  SOULTE_CASHOUT: 'Soulte échange (Reprise)',
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

/** Tender-rail turnover split for the Z turnover section (reference layout).
 * Same conventions as `cashSalesFromTxns` (tenders first, paymentMethod
 * fallback, VOIDED/refunds excluded): card = TPE rails (Autre, BaridiMob,
 * Chèque), credit = 'Crédit Client', avoir = 'Avoir Client', reprise =
 * 'Reprise' deduction legs. Pure + additive (no existing term touched). */
export interface TenderTurnoverSplit {
  cash: number;
  card: number;
  credit: number;
  avoir: number;
  reprise: number;
}

function railOf(t: { method?: string } | null | undefined, fallbackMethod?: string): string {
  const m = (t?.method || fallbackMethod || '').trim();
  return m;
}

export function tenderSplitFromTxns(txns: CashTxnLike[] | undefined | null): TenderTurnoverSplit {
  const split: TenderTurnoverSplit = { cash: 0, credit: 0, card: 0, avoir: 0, reprise: 0 };
  for (const t of txns || []) {
    if (!t || t.status === 'VOIDED' || t.isRefund) continue;
    // Mirror cashSalesFromTxns: change handed back was never collected, so it
    // nets once against the summed Espèces legs (split.cash then equals
    // cashSalesFromTxns on the same input — one number, never two).
    const change = Math.max(0, Math.round(Number(t.changeDue) || 0));
    let cashLegs = 0;
    const legs =
      t.tenders && Array.isArray(t.tenders) && t.tenders.length > 0
        ? t.tenders
        : [{ method: t.paymentMethod || 'Espèces', amount: Number(t.total) || 0 }];
    for (const leg of legs) {
      if (railOf(leg, t.paymentMethod) === 'Espèces') {
        cashLegs += Math.max(0, Math.round(Number(leg?.amount) || 0));
      }
    }
    split.cash += Math.max(0, cashLegs - change);
    for (const leg of legs) {
      const amount = Math.max(0, Math.round(Number(leg?.amount) || 0));
      if (amount <= 0) continue;
      switch (railOf(leg, t.paymentMethod)) {
        case 'Espèces':
          // Already counted above (net of change) — skip here.
          break;
        case 'Crédit Client':
          split.credit += amount;
          break;
        case 'Reprise':
          split.reprise += amount;
          break;
        case 'Avoir Client':
          split.avoir += amount;
          break;
        case 'Autre':
        case 'BaridiMob':
        case 'Chèque':
          split.card += amount;
          break;
        default:
          // Unknown rail (legacy rows): count as card-present volume rather
          // than vanishing it from turnover. Never NaN, never negative.
          split.card += amount;
          break;
      }
    }
  }
  return split;
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
 * net-negative tickets AND soulte boutique payouts (no source-table twin
 * by design — a single reader so the lanes cannot drift). */
export function exchangeCashOutFromMovements(movs: CashMovementLike[] | undefined | null): number {
  return (movs || [])
    .filter(
      (m) =>
        m &&
        m.type === 'EXPENSE' &&
        ((m.reason || '').startsWith(DRAWER_REASON_PREFIXES.EXCHANGE_CASHOUT) ||
          (m.reason || '').startsWith(DRAWER_REASON_PREFIXES.SOULTE_CASHOUT))
    )
    .reduce((acc, m) => acc + toCashAmount(m.amount), 0);
}

/**
 * Drawer-availability estimate (Chaos S2 overdraft guard). SAME term set as
 * the booking authority and the Z reconciler — a single source so the guard
 * can never disagree with what closeShift will book. All inputs integer DZD;
 * corrupt rows read as 0, never NaN. Pure (node-testable).
 */
export interface DrawerEstimateInput {
  openingFloat: number;
  cashSales: number;
  debtSettled: number;
  deposits: number;
  manualIn: number;
  refunds: number;
  drops: number;
  payouts: number;
  cashExpenses: number;
  tradeInCashOut: number;
  exchangeOut: number;
  manualOut: number;
}

export function estimateDrawerCash(i: DrawerEstimateInput): number {
  return (
    toCashAmount(i.openingFloat) +
    toCashAmount(i.cashSales) +
    toCashAmount(i.debtSettled) +
    toCashAmount(i.deposits) +
    toCashAmount(i.manualIn) -
    toCashAmount(i.refunds) -
    toCashAmount(i.drops) -
    toCashAmount(i.payouts) -
    toCashAmount(i.cashExpenses) -
    toCashAmount(i.tradeInCashOut) -
    toCashAmount(i.exchangeOut) -
    toCashAmount(i.manualOut)
  );
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

export interface SavRepairLike {
  depositAmount?: number;
}

export interface SavTxnItemLike {
  product?: { sku?: string; id?: string } | null;
  appliedPrice?: number;
  quantity?: number;
  discount?: number;
}

export interface SavTxnLike {
  items?: SavTxnItemLike[] | null;
  status?: string;
  isRefund?: boolean;
}

/** SAV deposits actually taken (never imputed unpaid balances). Display-only. */
export function savDepositsFromRepairs(repairs: SavRepairLike[] | undefined | null): number {
  return (repairs || []).reduce((acc, r) => acc + toCashAmount(r?.depositAmount), 0);
}

/**
 * SAV balances settled through checkout (SAV- service lines, net of line
 * discounts). Display-only informational split — the cash itself is already
 * counted inside cashSalesFromTxns, so this must NEVER enter expected-cash
 * math or drawer totals would double-count.
 */
export function savSettledFromTxns(txns: SavTxnLike[] | undefined | null): number {
  return (txns || [])
    .filter((t) => t && t.status !== 'VOIDED' && !t.isRefund)
    .reduce((acc, t) => {
      const lines = (t.items || []).filter(
        (i) =>
          i &&
          ((i.product?.sku || '').startsWith('SAV-') ||
            (i.product?.id || '').startsWith('repair-balance-'))
      );
      return (
        acc +
        lines.reduce((sum, i) => {
          const net =
            Math.round(Number(i.appliedPrice) || 0) * Math.max(0, Math.floor(Number(i.quantity) || 0)) -
            Math.max(0, Math.round(Number(i.discount) || 0));
          return sum + Math.max(0, net);
        }, 0)
      );
    }, 0);
}

/**
 * Sequential Z-ticket number: `[YYYYMMDD]-[SHIFT_SEQUENCE]` where the
 * sequence is closed-sessions-so-far + 1. Deterministic per (day, count).
 */
export function zTicketNumber(closedShiftCount: number, at?: Date | string): string {
  const d = at instanceof Date ? at : new Date(typeof at === 'string' ? at : Date.now());
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const seq = String(Math.max(1, Math.floor(closedShiftCount || 0) + 1)).padStart(3, '0');
  return `${day}-${seq}`;
}

/**
 * Receipt & revenue money-math helpers.
 *
 * INVARIANT (bug fix 2026-09-19): `SaleTransaction.subtotal` is stored as the
 * GROSS catalog total (sum of unit prices x qty, before any discount). The
 * stored `total` is the net amount actually due. Therefore the gross subtotal
 * shown on a ticket is `subtotal`, NOT `subtotal + discountTotal` — that
 * double-counts the discount and prints an internally inconsistent ticket
 * (e.g. 5200 - 1000 = 4200 on screen while the net total says 3200).
 *
 * Every receipt, daily-summary and export view must derive the gross from
 * these helpers so the breakdown always reconciles:
 *
 *   SOUS-TOTAL BRUT   = grossFromTransaction(tx)      = tx.subtotal
 *   REMISE ACCORDÉE   = tx.discountTotal
 *   TOTAL NET A PAYER = tx.total   (= gross - discount - store credit)
 */

import type { SaleTransaction } from '../types/pos';
import type { CartItem, PricingTier, TradeInDirection } from '../types/pos';
import { getProductPriceForTier } from './pricingEngine';
import { computeTax } from './taxEngine';

/**
 * Gross catalog value of a transaction: sum of (unit price x qty) over all
 * items, before discounts. Falls back to `total` only for legacy rows where
 * `subtotal` was never persisted (backfill / older sync payloads).
 */
export function grossFromTransaction(tx: SaleTransaction): number {
  return Math.max(0, tx.subtotal || tx.total || 0);
}

/**
 * Total discounts granted on a transaction, always non-negative.
 */
export function discountsFromTransaction(tx: SaleTransaction): number {
  return Math.max(0, tx.discountTotal || 0);
}

/**
 * Net revenue actually collected: gross - discounts - store credit redeemed.
 * Uses the stored `total` when present (it already accounts for store credit);
 * otherwise derives it from the gross/discount pair.
 */
export function netFromTransaction(tx: SaleTransaction): number {
  // B-030: presence check, not > 0 — a fully credit-paid sale stores total=0
  // and must NOT fall through to gross−discount (which overstates revenue).
  if (typeof tx.total === 'number' && Number.isFinite(tx.total)) return Math.max(0, tx.total);
  return Math.max(0, grossFromTransaction(tx) - discountsFromTransaction(tx));
}

/**
 * True for a row that should contribute to gross/net revenue metrics.
 * Voided sales and refunds are excluded from the daily "valid sales" totals.
 */
export function isValidSale(tx: SaleTransaction): boolean {
  return tx.status !== 'VOIDED' && !tx.isRefund;
}

export interface FiscalSettingsLike {
  rc?: string;
  nif?: string;
  nis?: string;
  art?: string;
  taxNumber?: string;
}

/**
 * Official fiscal identifier block. Granular RC/NIF/NIS/ART win; legacy
 * taxNumber renders as `NIF / RC` compat; null when nothing is configured
 * (callers fall back cleanly).
 */
export function fiscalIdentifierLine(settings?: FiscalSettingsLike | null): string | null {
  if (!settings) return null;
  const parts: string[] = [];
  if ((settings.rc || '').trim()) parts.push(`RC: ${(settings.rc || '').trim()}`);
  if ((settings.nif || '').trim()) parts.push(`NIF: ${(settings.nif || '').trim()}`);
  if ((settings.nis || '').trim()) parts.push(`NIS: ${(settings.nis || '').trim()}`);
  if ((settings.art || '').trim()) parts.push(`ART: ${(settings.art || '').trim()}`);
  if (parts.length > 0) return parts.join(' | ');
  if ((settings.taxNumber || '').trim()) return `NIF / RC : ${(settings.taxNumber || '').trim()}`;
  return null;
}

export interface TvaSplit {
  ht: number;
  tva: number;
  ttc: number;
  rate: number;
}

/**
 * TVA breakdown derived from the TTC total when a VAT rate is configured.
 * Integer DZD; null when disabled. HT = TTC / (1 + rate), TVA = TTC − HT.
 */
export function tvaSplitFromTotal(total: number, vatRate?: number | null): TvaSplit | null {
  const rate = Math.max(0, Number(vatRate) || 0);
  if (!(rate > 0)) return null;
  const ttc = Math.max(0, Math.round(total || 0));
  const ht = Math.round(ttc / (1 + rate / 100));
  return { ht, tva: Math.max(0, ttc - ht), ttc, rate };
}

/**
 * True for an exchange receipt (return leg present). The frozen ledger only
 * ever freezes the SALE leg, while the ticket total and the stored cost are
 * signed net (both legs) — so every margin consumer must use the signed row
 * cost for exchanges, never the alloc-only sum. Single definition shared by
 * the inspector, lists, exports, shift close and the metrics below.
 */
export function isExchangeSaleTx(t: SaleTransaction | null | undefined): boolean {
  return ((t?.items as unknown as Array<unknown>) || []).some(
    (it) =>
      Boolean(
        (it as { isReturn?: unknown }).isReturn ??
          (it as { is_return?: unknown }).is_return
      ) || Number((it as { quantity?: unknown }).quantity) < 0
  );
}

/**
 * Canonical sales metrics — the ONE formula Desktop (ReportsModal),
 * Mobile (LiveActivityTab / ManagementTab) and Analytics must share so the
 * same transactions always yield the same turnover, profit and basket.
 *
 * - Turnover (CA Net) = Σ net(valid sales) − Σ refunds(isRefund vouchers).
 *   Net honours discounts/store-credit via netFromTransaction (B-029); the
 *   old Desktop code summed gross(subtotal) and overstated CA by exactly
 *   Σ discountTotal (the reported 2 326 DA gap).
 * - Profit = CA Net − Σ costTotal(valid sales).
 *   STRICT FIFO LEDGER LAW (v104): Σ cost comes from the FROZEN checkout
 *   ledger ONLY — per sale, in order: exchange receipts (return leg present)
 *   use the signed stored row cost (the ledger only freezes sale legs while
 *   the ticket total is signed net); otherwise the alloc-map sum wins
 *   whenever present, then the materialized row column `ledgerCogsTotal`
 *   (covers the Dexie-mirror lag window), then the stored `costTotal`
 *   (equal to the ledger sum by construction for post-v104 sales). NO
 *   fallback to `products.costPrice`, live `stock_batches`, or price-ratio
 *   estimates ever. A sale with no stored cost and no ledger entry
 *   contributes 0 (never a fabricated estimate); the SQLite authority
 *   `getSalesProfitTotalsFromAllocations()` sums the ledger rows directly.
 *   `costFallback` is retained ONLY for legacy/offline surfaces and MUST
 *   never read live catalog costs — report callers pass the alloc map and
 *   no fallback.
 * - Basket = round(Σ net(valid sales) / validCount) — average net ticket,
 *   refunds excluded from the denominator (they are vouchers, not tickets).
 * - Refunds = isRefund vouchers only (non-voided). A `REFUNDED` status on
 *   the ORIGINAL sale must NOT count as a refund — the voucher already does.
 */
export interface SalesMetrics {
  validSales: SaleTransaction[];
  refundVouchers: SaleTransaction[];
  validCount: number;
  grossRevenue: number;
  discountTotal: number;
  netSalesRevenue: number;
  refundsTotal: number;
  netRevenue: number;
  costTotal: number;
  profitTotal: number;
  averageBasket: number;
  marginPct: string;
}

/**
 * Frozen ledger COGS lookup by sale id, as mirrored into Dexie
 * (`saleBatchAllocations`: Σ qtyConsumed × unitCostAtSale per sale).
 * Accepts the plain record produced by `useAllocationCogs` or a Map —
 * both shapes are read without normalizing (hot loop, no allocs).
 */
export type AllocCogsLookup = Record<string, number> | Map<string, number> | undefined;

function allocCogsForSale(lookup: AllocCogsLookup, saleId: string): number | undefined {
  if (!lookup || !saleId) return undefined;
  const raw = lookup instanceof Map ? lookup.get(saleId) : lookup[saleId];
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

export function computeSalesMetrics(
  list: SaleTransaction[],
  opts: {
    costFallback?: (t: SaleTransaction) => number;
    /** Frozen-ledger COGS per sale id — WINS over stored costTotal. */
    allocCogsBySaleId?: AllocCogsLookup;
  } = {}
): SalesMetrics {
  const transactions = list || [];
  const validSales = transactions.filter(isValidSale);
  const refundVouchers = transactions.filter((t) => Boolean(t.isRefund) && t.status !== 'VOIDED');

  const grossRevenue = validSales.reduce((acc, t) => acc + grossFromTransaction(t), 0);
  const discountTotal = validSales.reduce((acc, t) => acc + discountsFromTransaction(t), 0);
  const netSalesRevenue = validSales.reduce((acc, t) => acc + netFromTransaction(t), 0);
  const refundsTotal = refundVouchers.reduce((acc, t) => acc + (t.total || 0), 0);
  const netRevenue = Math.max(0, netSalesRevenue - refundsTotal);

  const costTotal = validSales.reduce((acc, t) => {
    // EXCHANGE BRANCH: the frozen ledger only ever freezes sale legs, so
    // for exchange receipts the signed stored row cost (both legs, hardened
    // pre-commit by the same gate) is the exact basis — using the alloc sum
    // here would overstate COGS by the return-leg cost on every KPI, Excel
    // export and analytics trend. Pure sales keep the LEDGER FIRST rule
    // below (frozen allocation sum beats the stored row).
    if (isExchangeSaleTx(t)) {
      const row = Number(t.costTotal);
      if (Number.isFinite(row)) return acc + Math.round(row);
    }
    // LEDGER FIRST: the frozen allocation sum for this sale beats the stored
    // row (post-v104 they are equal by construction; for pre-v104 sales the
    // backfilled ledger repairs the stale stored cost, e.g. 500+400=900 vs
    // the stored 500×2=1000 that rendered profit 6,000 instead of 6,100).
    // The materialized row column sits between map and stored so a fresh
    // commit still reads exact during the Dexie-mirror lag window.
    const alloc = allocCogsForSale(opts.allocCogsBySaleId, t.id);
    if (alloc !== undefined) return acc + alloc;
    const rowLedger = Number(t.ledgerCogsTotal);
    if (Number.isFinite(rowLedger) && rowLedger >= 0) return acc + Math.round(rowLedger);
    const stored = typeof t.costTotal === 'number' && Number.isFinite(t.costTotal) ? t.costTotal : undefined;
    if (stored !== undefined) return acc + stored;
    if (opts.costFallback) return acc + Math.max(0, opts.costFallback(t) || 0);
    return acc;
  }, 0);

  const profitTotal = netRevenue - costTotal;
  const validCount = validSales.length;
  const averageBasket = validCount > 0 ? Math.round(netSalesRevenue / validCount) : 0;
  const marginPct = netRevenue > 0 ? ((profitTotal / netRevenue) * 100).toFixed(1) : '0';

  return {
    validSales,
    refundVouchers,
    validCount,
    grossRevenue,
    discountTotal,
    netSalesRevenue,
    refundsTotal,
    netRevenue,
    costTotal,
    profitTotal,
    averageBasket,
    marginPct,
  };
}

/**
 * Canonical cart totals — the ONE function every checkout surface
 * (CartPanel, PaymentModal, MobileCheckoutTab, processPayment,
 * quickCashPayment) must use so all three agree to the dinar.
 *
 * - Signed quantities: `isReturn` lines subtract (returns/exchanges).
 * - Per-item discounts are sign-aware: a stored positive `discount` on a sale
 *   line reduces the total; the same stored value on an `isReturn` line
 *   reduces the REFUND (symmetric reversal — toggling a discounted sale to a
 *   return refunds exactly what was charged, never gross + discount).
 * - `cartDiscountPercent`: % applied on the post-line-discount base when > 0
 *   (no-op on a negative base — a net return gets no extra discount).
 * - `storeCreditApplied` / `voucherCreditApplied`: payment-method credits.
 *   They do NOT reduce the VAT base — tax is computed on the pre-credit
 *   subtotal (an avoir pays the ticket, it is not a commercial discount).
 *   Identical to the old formula when vatRate is 0.
 * - Tax via taxEngine.computeTax(preCreditSubtotal, vatRate) (default 0).
 *
 * Money stays integer DZD: inputs rounded on entry, the two percent
 * multiplications (cart %, VAT) are the only rounding points.
 */
export interface CartTotalsOptions {
  pricingTier?: PricingTier;
  cartDiscountPercent?: number;
  storeCreditApplied?: number;
  voucherCreditApplied?: number;
  /**
   * Two-way exchange credit (trade-in buyback value, 1:1 — no +10% bonus).
   * Payment credit like store/voucher credit: does NOT reduce the VAT base.
   * Never pushed as a negative-price cart line (corrupts gross + FIFO).
   */
  tradeInCredit?: number;
  vatRate?: number;
}

/**
 * Two-way exchange settlement:
 *   Net Balance = Gross Cart Total − Trade-In Buyback Value
 * - Net > 0 (CUSTOMER_PAYS): customer owes the difference (tender the rest).
 * - Net < 0 (SOULTE_SHOP_PAYS): shop owes the soulte (cash payout or avoir).
 * - Net = 0 (EVEN): straight swap, nothing due either way.
 * Pure + integer DZD. Buyback applies 1:1 (exchange mode hides the +10%
 * wallet bonus so inventory cost basis and margins stay undistorted).
 * Direction type lives in types/pos (single source); result shape here.
 */
export interface TradeInSettlementResult {
  netBalance: number;
  direction: TradeInDirection;
  /** Amount the customer still owes (>= 0). */
  customerOwes: number;
  /** Amount the shop owes back as soulte (>= 0). */
  shopOwes: number;
}

export function computeTradeInSettlement(
  grossCartTotal: number,
  buybackValue: number
): TradeInSettlementResult {
  const gross = Math.max(0, Math.round(Number(grossCartTotal) || 0));
  const buyback = Math.max(0, Math.round(Number(buybackValue) || 0));
  const netBalance = gross - buyback;
  if (netBalance > 0) {
    return { netBalance, direction: 'CUSTOMER_PAYS', customerOwes: netBalance, shopOwes: 0 };
  }
  if (netBalance < 0) {
    return { netBalance, direction: 'SOULTE_SHOP_PAYS', customerOwes: 0, shopOwes: -netBalance };
  }
  return { netBalance: 0, direction: 'EVEN', customerOwes: 0, shopOwes: 0 };
}

export interface CartTotals {
  /** Signed catalog value before discounts (return lines negative). */
  grossSubtotal: number;
  /** Signed sum of stored per-line discounts (return lines subtract, so a
   * toggled return exactly reverses its sale; may be negative). */
  lineDiscountTotal: number;
  /** Cart-level percent discount (>= 0). */
  cartDiscountTotal: number;
  /** lineDiscountTotal + cartDiscountTotal. */
  discountTotal: number;
  /** grossSubtotal − discountTotal (may be negative for net returns). */
  subtotalAfterDiscount: number;
  storeCreditApplied: number;
  voucherCreditApplied: number;
  /** Two-way exchange credit applied (trade-in buyback 1:1, >= 0). */
  tradeInCreditApplied: number;
  /** subtotalAfterDiscount − credits (may be negative → refund due). */
  net: number;
  /** Taxable base: PRE-credit subtotal clamped >= 0 (credits are payment). */
  ht: number;
  /** VAT amount → persisted into the order row `tax` column. */
  tva: number;
  /** Amount the tender must cover (ht + tva, always >= 0). */
  ttc: number;
  /** Alias of ttc (what processPayment stores as `total`). */
  total: number;
  /** Alias of tva (what processPayment stores as `tax`). */
  tax: number;
  /**
   * B-026: cash/store-credit owed BACK when returns dominate (net < 0).
   * Always >= 0; 0 when the cart is payable. UI must branch on this —
   * `total`/`ttc` is clamped to 0 for refunds and is never negative.
   */
  refundDue: number;
}

function toInt(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Chaos S5 trade-in restoration quota for one refund row: pro-rata share of
 * the deduction by net value reversed, capped by what prior refunds of the
 * same ticket already restored. Pure (slice + battery share it — one source).
 */
export function computeTradeRestoreQuota(
  tradeDeduction: number,
  netRefund: number,
  originalTotal: number,
  priorRestored: number
): number {
  const deduction = Math.max(0, Math.round(Number(tradeDeduction) || 0));
  if (deduction <= 0) return 0;
  const share = originalTotal > 0 ? Math.min(1, netRefund / Math.max(1, originalTotal)) : 1;
  return Math.max(
    0,
    Math.min(
      Math.round(deduction * share),
      deduction - Math.max(0, Math.round(Number(priorRestored) || 0))
    )
  );
}

export function computeCartTotals(lines: CartItem[], opts: CartTotalsOptions = {}): CartTotals {
  const tier = opts.pricingTier;
  let grossSubtotal = 0;
  let lineDiscountTotal = 0;
  for (const line of lines ?? []) {
    const unit =
      line.appliedPrice !== undefined
        ? line.appliedPrice
        : getProductPriceForTier(line.product, tier);
    const magnitude = Math.abs(toInt(line.quantity));
    const signedQty = line.isReturn ? -magnitude : magnitude;
    grossSubtotal += toInt(unit) * signedQty;
    // Sign-aware discounts (OBS-A1): a return line's stored discount must
    // shrink the refund, not grow it — otherwise toggling a discounted sale
    // to a return refunds gross + discount (e.g. 1100 on a 900 ticket).
    const lineDisc = Math.max(0, toInt(line.discount));
    lineDiscountTotal += line.isReturn ? -lineDisc : lineDisc;
  }
  const pct = Math.max(0, Math.min(100, Number(opts.cartDiscountPercent) || 0));
  const base = grossSubtotal - lineDiscountTotal;
  const cartDiscountTotal = base > 0 && pct > 0 ? Math.round((base * pct) / 100) : 0;
  const discountTotal = lineDiscountTotal + cartDiscountTotal;
  const subtotalAfterDiscount = grossSubtotal - discountTotal;
  const storeCreditApplied = Math.max(0, toInt(opts.storeCreditApplied));
  const voucherCreditApplied = Math.max(0, toInt(opts.voucherCreditApplied));
  // Exchange credit is clamped to the payable remainder AFTER store +
  // voucher credits (never over-covers into a phantom refund via refundDue;
  // a true soulte is a post-checkout payout, never a negative net). Credits
  // can never exceed the pre-credit base in combination.
  const tradeInCreditApplied = Math.max(
    0,
    Math.min(
      toInt(opts.tradeInCredit),
      Math.max(0, subtotalAfterDiscount - storeCreditApplied - voucherCreditApplied)
    )
  );
  const credits = storeCreditApplied + voucherCreditApplied + tradeInCreditApplied;
  const net = subtotalAfterDiscount - credits;
  const vatRate = Math.max(0, Number(opts.vatRate) || 0);
  // Credits are payment, not discount: VAT applies to the pre-credit
  // subtotal (OBS-A2). At vatRate 0 this is exactly the old formula.
  const { ht, tva } = computeTax(Math.max(0, subtotalAfterDiscount), vatRate);
  const ttc = Math.max(0, ht + tva - credits);
  return {
    grossSubtotal,
    lineDiscountTotal,
    cartDiscountTotal,
    discountTotal,
    subtotalAfterDiscount,
    storeCreditApplied,
    voucherCreditApplied,
    tradeInCreditApplied,
    net,
    ht,
    tva,
    ttc,
    total: ttc,
    tax: tva,
    // B-026: signed net can go negative — surface the disbursement amount.
    // With VAT, the refund is credits minus what was actually owed.
    refundDue:
      subtotalAfterDiscount < 0 ? Math.max(0, -net) : Math.max(0, credits - (ht + tva)),
  };
}

/** Funding sources of an original sale, for refund reversal. */
export interface RefundFundingInput {
  total?: number;
  subtotal?: number;
  voucherCreditApplied?: number | null;
  tenders?: Array<{ method?: string; amount?: number }> | null;
  paymentMethod?: string;
  /** Persisted credit-debt amount (preferred over re-summing tenders). */
  debtAdded?: number | null;
}

export interface RefundFundingSplit {
  /** Gross value of the returned lines (input basis, informational). */
  grossRefund: number;
  /** Net value reversed (pro-rata share of the net total — the money truth). */
  netRefund: number;
  /** Portions routed back to each funding source (sum = netRefund). */
  voucherShare: number;
  avoirShare: number;
  debtShare: number;
  cashShare: number;
  /** Net cash the customer originally paid (cap reference). */
  cashPaidOriginal: number;
  /** True when the cumulative cap trimmed the reversal. */
  capped: boolean;
}

function tenderSum(tenders: RefundFundingInput['tenders'], method: string): number {
  if (!tenders || !Array.isArray(tenders)) return NaN;
  return tenders
    .filter((t) => t && t.method === method)
    .reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
}

/**
 * Anti-arbitrage refund split: a refund must reverse each funding source —
 * never pay gross cash for value the customer paid with voucher, wallet
 * credit, or unpaid debt (C1/C2/C3), and never refund cart discounts as cash.
 * The net total is split pro-rata over everything the customer gave
 * (net paid + voucher + avoir value); the cash plug keeps books exact.
 * Pure + dependency-free (unit-tested via test_cash_terms style scripts).
 */
export function computeRefundFundingSplit(
  orig: RefundFundingInput | null | undefined,
  grossRefund: number,
  priorRecovery = 0
): RefundFundingSplit {
  const total = Math.max(0, Math.round(Number(orig?.total ?? 0)));
  const grossBase = Math.max(0, Math.round(Number(orig?.subtotal ?? 0)));
  const fundV = Math.min(total, Math.max(0, Math.round(Number(orig?.voucherCreditApplied ?? 0))));
  const avoirRaw = tenderSum(orig?.tenders, 'Avoir Client');
  const fundA = Math.min(
    total,
    Math.max(0, Math.round(Number.isFinite(avoirRaw) ? avoirRaw : orig?.paymentMethod === 'Avoir Client' ? total : 0))
  );
  const debtTender = tenderSum(orig?.tenders, 'Crédit Client');
  const debtRaw =
    orig?.debtAdded ?? (Number.isFinite(debtTender) ? debtTender : orig?.paymentMethod === 'Crédit Client' ? total : 0);
  const fundD = Math.min(total, Math.max(0, Math.round(Number(debtRaw))));
  const gross = Math.max(0, Math.round(Number(grossRefund ?? 0)));
  const ratio =
    grossBase > 0 ? Math.min(1, gross / grossBase) : total > 0 ? Math.min(1, gross / total) : 0;
  // Recoverable base = everything the customer gave (net paid + voucher +
  // avoir value). The ratio applies to THIS, not to total alone — otherwise
  // a full refund of a voucher/avoir sale would evaporate the prepaid value
  // instead of restoring it to its origin.
  const recoverableBase = total + fundV + fundA;
  let net = Math.round(recoverableBase * ratio);
  // Cumulative cap: all refunds combined can never return more value than
  // the customer gave. Prior rows are gross-format (legacy), which
  // overstates recovery — safe direction.
  const maxRecoverable = recoverableBase;
  const cappedNet = Math.max(0, Math.min(net, maxRecoverable - Math.max(0, Math.round(priorRecovery))));
  const capped = cappedNet < net;
  net = cappedNet;
  const denom = total + fundV + fundA;
  let v = 0;
  let a = 0;
  let d = 0;
  if (denom > 0 && net > 0) {
    v = Math.min(fundV, Math.round((net * fundV) / denom));
    a = Math.min(fundA, Math.round((net * fundA) / denom));
    d = Math.min(fundD, Math.round((net * fundD) / denom));
  }
  const cash = Math.max(0, net - v - a - d);
  return {
    grossRefund: gross,
    netRefund: net,
    voucherShare: v,
    avoirShare: a,
    debtShare: d,
    cashShare: cash,
    cashPaidOriginal: Math.max(0, total - fundD),
    capped,
  };
}

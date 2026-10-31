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
import type { CartItem, PricingTier, TradeInDirection, ActivePriceBookItem } from '../types/pos';
import { resolveBaseUnitPrice } from './pricingEngine';

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
  /** Σ recovered COGS over refund rows (restocked units, v127). */
  restoredCogsTotal: number;
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

  // Recovered-COGS credit (v127): refund rows carry the native-computed
  // value of the RESTOCKED units only (frozen per-line cost at commit).
  //   profitTotal = netRevenue − grossSaleCOGS + Σ restoredCogs
  // which equals base − Σ(netRefund − recovered): a full restock refund is
  // P&L-neutral, a write-off stays a cost burden (no restock credit, loss
  // memo'd separately — never double-counted). Legacy refund rows have no
  // value → 0 credit; they are never over-credited.
  const restoredCogsTotal = refundVouchers.reduce((acc, t) => {
    const raw = typeof t.restoredCogs === 'number' ? t.restoredCogs : t.restored_cogs;
    const v = Number(raw);
    return acc + (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  }, 0);

  const profitTotal = netRevenue - costTotal + restoredCogsTotal;
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
    restoredCogsTotal,
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
 *   They are payment, not discount (an avoir pays the ticket, it is not a
 *   commercial discount).
* - NO TAX (no-TVA product, Gate Addendum A + Phase 1b-i): there is no tax
  *   term at all — `ht` = pre-credit subtotal, `ttc` = ht − credits, and the
  *   result carries no `tax`/`tva` field (they were deleted, not zeroed).
 *
 * Money stays integer DZD: inputs rounded on entry, the cart-% multiplication
 * is the only rounding point.
 */
export interface CartTotalsOptions {
  pricingTier?: PricingTier;
  cartDiscountPercent?: number;
  storeCreditApplied?: number;
  voucherCreditApplied?: number;
  /**
   * Two-way exchange credit (trade-in buyback value, 1:1 — no +10% bonus).
   * Payment credit like store/voucher credit. Never pushed as a negative-price
   * cart line (corrupts gross + FIFO).
   */
  tradeInCredit?: number;
  /**
   * UPGRADE-04: the attached customer's contract price-book items. Only used
   * for the legacy fallback (lines without `appliedPrice`) — priced lines
   * already carry the resolved base in `appliedPrice`.
   */
  priceBookItems?: readonly ActivePriceBookItem[] | null;
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
  /** Amount the tender must cover (ht − credits, always >= 0). */
  ttc: number;
  /** Alias of ttc (what processPayment stores as `total`). */
  total: number;
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
 * Money at the precision the product actually carries: integer minor units
 * (1 DA = 100). The cart used to round every unit price to WHOLE dinars
 * (`toInt`), so a 0,01 DA line charged 0, a 33,335 DA line charged 33,00 and
 * 3×33,33 + 7×14,29 charged 197,00 while the lines rendered 200,02
 * ([MNY-01/02/03/06]). Half-away-from-zero is the same rule the entry path
 * uses (`Money.fromUserInput` rejects a third decimal; display rounds half up).
 */
function toMinor(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100);
}

function fromMinor(minor: number): number {
  return minor / 100;
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
  let grossMinor = 0;
  let lineDiscountMinor = 0;
  for (const line of lines ?? []) {
    const unit =
      line.appliedPrice !== undefined
        ? line.appliedPrice
        : resolveBaseUnitPrice(line.product, tier, line.quantity, opts.priceBookItems ?? null);
    const magnitude = Math.abs(toInt(line.quantity));
    const signedQty = line.isReturn ? -magnitude : magnitude;
    // Charge the price the line DISPLAYS (2 decimals), never a whole-dinar
    // rounding of it: [MNY-01/02/03/06] all failed because this multiplied a
    // rounded unit by the quantity.
    grossMinor += toMinor(unit) * signedQty;
    // Sign-aware discounts (OBS-A1): a return line's stored discount must
    // shrink the refund, not grow it — otherwise toggling a discounted sale
    // to a return refunds gross + discount (e.g. 1100 on a 900 ticket).
    const lineDiscMinor = Math.max(0, toMinor(line.discount));
    lineDiscountMinor += line.isReturn ? -lineDiscMinor : lineDiscMinor;
  }
  const pct = Math.max(0, Math.min(100, Number(opts.cartDiscountPercent) || 0));
  const baseMinor = grossMinor - lineDiscountMinor;
  const cartDiscountMinor = baseMinor > 0 && pct > 0 ? Math.round((baseMinor * pct) / 100) : 0;
  const discountMinor = lineDiscountMinor + cartDiscountMinor;
  const subtotalAfterDiscountMinor = grossMinor - discountMinor;
  const storeCreditMinor = Math.max(0, toMinor(opts.storeCreditApplied));
  const voucherCreditMinor = Math.max(0, toMinor(opts.voucherCreditApplied));
  // Exchange credit is clamped to the payable remainder AFTER store +
  // voucher credits (never over-covers into a phantom refund via refundDue;
  // a true soulte is a post-checkout payout, never a negative net). Credits
  // can never exceed the pre-credit base in combination.
  const tradeInCreditMinor = Math.max(
    0,
    Math.min(
      toMinor(opts.tradeInCredit),
      Math.max(0, subtotalAfterDiscountMinor - storeCreditMinor - voucherCreditMinor)
    )
  );
  const creditsMinor = storeCreditMinor + voucherCreditMinor + tradeInCreditMinor;
  const netMinor = subtotalAfterDiscountMinor - creditsMinor;
  // Phase 1b-i: the `taxEngine` zero shim is deleted. `ht` is the taxable base
  // (pre-credit subtotal, clamped >= 0) and there is no VAT to add — every sale
  // is HT-only by product decision (Gate Addendum A), and the `tax` column that
  // used to receive the zero is dropped in migration 108.
  const htMinor = Math.max(0, subtotalAfterDiscountMinor);
  const ttcMinor = Math.max(0, htMinor - creditsMinor);
  const grossSubtotal = fromMinor(grossMinor);
  const lineDiscountTotal = fromMinor(lineDiscountMinor);
  const cartDiscountTotal = fromMinor(cartDiscountMinor);
  const discountTotal = fromMinor(discountMinor);
  const subtotalAfterDiscount = fromMinor(subtotalAfterDiscountMinor);
  const storeCreditApplied = fromMinor(storeCreditMinor);
  const voucherCreditApplied = fromMinor(voucherCreditMinor);
  const tradeInCreditApplied = fromMinor(tradeInCreditMinor);
  const net = fromMinor(netMinor);
  const ht = fromMinor(htMinor);
  const ttc = fromMinor(ttcMinor);
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
    ttc,
    total: ttc,
    // B-026: signed net can go negative — surface the disbursement amount.
    // HT-only, so what was owed is `ht` itself: credits minus the taxable base.
    refundDue:
      subtotalAfterDiscountMinor < 0
        ? fromMinor(Math.max(0, -netMinor))
        : fromMinor(Math.max(0, creditsMinor - htMinor)),
  };
}

/**
 * One line's contribution to the ticket profit — THE canonical line-profit
 * formula. Rust twin: `line_profit_net` in src-tauri/src/checkout.rs; the TS
 * twin (sqlPluginAdapter), the ledger repairs and the shadow reconciliation
 * all call THIS function so the invariants can never drift again:
 *
 *   (unitPriceCharged − unitCostAtSale) × signedQty − signed line discount
 *
 * Why the discount is netted here (2026-10-16): ticket totals are stored net
 * of discounts, so a gross line profit left Σ per-line ≠ ticket profit (one
 * 200 DA remise alone made the inspector's line sum overshoot the stored
 * per-sale profits by exactly that 200). Return lines follow
 * computeCartTotals' sign contract: signedQty is negative AND their line
 * discount shrinks the refund, never grows it (OBS-A1).
 *
 * Cart-level percent discounts and store/voucher credits are NOT attributed
 * per line (no live caller produces a cart-% discount; credits are a funding
 * settlement, not a line price) — ticket totals remain the authority.
 */
export function lineProfitNet(input: {
  unitPriceCharged: number;
  unitCostAtSale: number;
  quantity: number;
  discount?: number | null;
  isReturn?: boolean;
}): number {
  const charged = toMinor(input.unitPriceCharged);
  const unitCost = toInt(input.unitCostAtSale) * 100;
  const qty = toInt(input.quantity);
  const isReturn = Boolean(input.isReturn);
  const signedQty = isReturn ? -Math.abs(qty) : Math.abs(qty);
  const lineDiscount = Math.max(0, toMinor(input.discount));
  const signedDiscount = isReturn ? -lineDiscount : lineDiscount;
  return fromMinor((charged - unitCost) * signedQty - signedDiscount);
}

/** Funding sources of an original sale, for refund reversal. */
export interface RefundFundingInput {
  total?: number;
  subtotal?: number;
  /** Ticket-level discount (line discounts + cart discount), if recorded. */
  discountTotal?: number | null;
  voucherCreditApplied?: number | null;
  tenders?: Array<{ method?: string; amount?: number }> | null;
  paymentMethod?: string;
  /** Persisted credit-debt amount (preferred over re-summing tenders). */
  debtAdded?: number | null;
  /**
   * Voucher code carried by the sale. Native restore (`refund.rs`) credits the
   * voucher back BY CODE; an amount with no code cannot be restored anywhere.
   */
  voucherCode?: string | null;
  /** Change handed back at the till — carved out of the CASH lane only. */
  changeDue?: number | null;
  /** Lines of the original ticket — fallback basis when the columns are absent. */
  items?: RefundEligibilityItem[] | null;
}

/**
 * Per-lane amounts already returned by earlier refunds of the SAME ticket.
 * Stored in the refund row's JSON payload (`funding`), so no migration is
 * needed; `gross` is the cumulative gross refunded (the basis for the
 * cumulative rounding, which is what makes partial refunds conserve exactly).
 * `basis` records how the numbers were obtained, `anomalies` records anything
 * the code had to guess (D1d).
 */
export interface RefundLaneTotals {
  cash: number;
  avoir: number;
  voucher: number;
  debt: number;
  digital: number;
  gross?: number;
  basis?: 'explicit' | 'derived' | 'legacy';
  anomalies?: string[];
}

const DIGITAL_RAILS = ['BaridiMob', 'Chèque', 'Autre'];
const FUNDING_RAILS = ['Espèces', 'Avoir Client', 'Crédit Client', ...DIGITAL_RAILS];

function tenderMinor(tenders: RefundFundingInput['tenders'], rails: string[]): number {
  if (!Array.isArray(tenders)) return NaN;
  return tenders.reduce((acc, t) => {
    const method = String(t?.method ?? '');
    return rails.includes(method) ? acc + toMinor(t?.amount) : acc;
  }, 0);
}

/**
 * Persisted per-refund funding (Q-vi): integer MINOR units with an explicit
 * `unit` tag. Version stays 1 because no released build ever wrote the earlier
 * DA-valued shape (no tag contains the commit that introduced it); the reader
 * still accepts a DA-valued object from this branch's own test runs and flags
 * it as `funding-unit-legacy`.
 */
export interface RefundFundingPayload {
  version: 1;
  unit: 'minor';
  basis: 'explicit' | 'derived' | 'legacy';
  anomalies: string[];
  cash: number;
  avoir: number;
  voucher: number;
  debt: number;
  digital: number;
  gross: number;
}

export function fundingPayloadOf(
  split: RefundFundingSplit,
  basis: 'explicit' | 'derived' | 'legacy' = 'explicit'
): RefundFundingPayload {
  return {
    version: 1,
    unit: 'minor',
    basis,
    anomalies: [...(split.anomalies ?? [])],
    cash: toMinor(split.cashShare),
    avoir: toMinor(split.avoirShare),
    voucher: toMinor(split.voucherShare),
    debt: toMinor(split.debtShare),
    digital: toMinor(split.digitalShare),
    gross: toMinor(split.grossRefund),
  };
}

/**
 * Read the per-lane funding of one refund row.
 *
 * New rows carry `funding` in their JSON payload (D2, no migration). Historical
 * rows do not, so the durable columns are the only evidence and the residual is
 * attributed to the rail the refund was settled on. Must never throw: a
 * malformed or missing `funding` object falls back to the derivation.
 */
export function refundLaneTotalsOf(txn: Record<string, unknown> | null | undefined): RefundLaneTotals {
  const raw = (txn?.funding ?? null) as Partial<RefundFundingPayload> | null;
  if (raw && typeof raw === 'object') {
    const keys = ['cash', 'avoir', 'voucher', 'debt', 'digital'] as const;
    if (keys.every((k) => Number.isFinite(Number((raw as Record<string, unknown>)[k])))) {
      // `unit:'minor'` is the current format. A DA-valued object can only come
      // from this branch's own pre-Q-vi test runs; it is read (not rejected) and
      // flagged so a mixed history is visible.
      const isMinor = (raw as RefundFundingPayload).unit === 'minor';
      const scale = (v: unknown) => fromMinor(Number(v)); // minor -> DA
      const da = (v: unknown) => (isMinor ? scale(v) : Number(v));
      const anomalies = Array.isArray(raw.anomalies) ? [...(raw.anomalies as string[])] : [];
      if (!isMinor) anomalies.push('funding-unit-legacy');
      return {
        cash: da(raw.cash),
        avoir: da(raw.avoir),
        voucher: da(raw.voucher),
        debt: da(raw.debt),
        digital: da(raw.digital),
        gross: da(raw.gross),
        basis: (raw.basis as RefundLaneTotals['basis']) ?? 'explicit',
        anomalies,
      };
    }
  }
  const totalM = Math.max(0, toMinor(txn?.total));
  const method = String(txn?.refundMethod ?? txn?.paymentMethod ?? '');
  const cashRaw = txn?.cashDisbursed;
  const cashM =
    cashRaw === undefined || cashRaw === null
      ? method === 'Espèces'
        ? totalM
        : 0
      : Math.min(totalM, Math.max(0, toMinor(cashRaw)));
  const residualM = Math.max(0, totalM - cashM);
  // A legacy cash row whose `total` exceeds its `cashDisbursed` carried the
  // rest on another lane; the old refund code paid a stacked-discount share as
  // avoir, so that is where an unattributable cash residual goes. Recorded in
  // `anomalies` because it is a derivation, not evidence.
  const legacyAnomalies = ['legacy-no-funding-object'];
  let avoirM = method === 'Avoir Client' ? residualM : 0;
  if (method !== 'Avoir Client' && residualM > 0 && (cashM > 0 || method === 'Espèces')) {
    avoirM = residualM;
    legacyAnomalies.push('legacy-cash-residual-to-avoir');
  }
  return {
    cash: fromMinor(cashM),
    avoir: fromMinor(avoirM),
    voucher: fromMinor(method === 'Voucher' || method === 'Bon Achat' ? residualM : 0),
    debt: fromMinor(method === 'Crédit Client' ? residualM : 0),
    digital: fromMinor(DIGITAL_RAILS.includes(method) ? residualM : 0),
    gross: fromMinor(Math.max(0, toMinor(txn?.subtotal ?? txn?.total))),
    basis: 'legacy',
    anomalies: legacyAnomalies,
  };
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
  /**
   * Level-5 chaos fix: value paid over non-cash direct rails (BaridiMob,
   * Chèque, Autre). Reversing it as drawer cash would drain money that never
   * entered the till as cash — it is reported for rail-of-origin reversal,
   * never disbursed. Reprise tenders are excluded here (restored to the
   * wallet by the trade-restore quota instead — never double-counted).
   */
  digitalShare: number;
  /** Net cash the customer originally paid (cap reference). */
  cashPaidOriginal: number;
  /** True when the cumulative cap trimmed the reversal. */
  capped: boolean;
  /**
   * Anything the split had to guess (legacy row without tenders, credits above
   * the base, rounding correction, cash over the paid amount). Persisted inside
   * the refund's `funding` object so a disputed refund can be reconstructed.
   */
  anomalies: string[];
}

function netBaseOf(orig: RefundFundingInput): number {
  const items = orig?.items;
  if (!items || items.length === 0) return 0;
  let sum = 0;
  for (const item of items) {
    if (!item) continue;
    sum += netUnitOf(item) * Math.max(0, Number(item.quantity) || 0);
  }
  return Math.max(0, Math.round(sum));
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
  priorRecovery = 0,
  priorLanes?: RefundLaneTotals | null
): RefundFundingSplit {
  const anomalies: string[] = [];
  const totalM = Math.max(0, toMinor(orig?.total));
  // Proration basis: the NET value of the ticket's lines. Every caller passes
  // the net value of the returned lines, so the denominator must be net too —
  // using the GROSS subtotal applied the line discount twice ([MNY-30]).
  const grossLinesM = Math.max(0, toMinor(orig?.subtotal));
  const discountM = Math.max(0, toMinor(orig?.discountTotal));
  const netLinesM = Math.max(0, grossLinesM - discountM);
  const itemsBaseM = toMinor(netBaseOf(orig ?? {}));
  const baseM = netLinesM > 0 ? netLinesM : itemsBaseM > 0 ? itemsBaseM : grossLinesM;

  // `undefined` (not []) when the row carries no tender array: tenderMinor
  // returns NaN for that, which is how the legacy fallbacks below are chosen.
  const tenders = orig?.tenders;
  const fundingTenderM = tenderMinor(tenders, FUNDING_RAILS);
  const cashTenderM = tenderMinor(tenders, ['Espèces']);
  const digitalTenderM = tenderMinor(tenders, DIGITAL_RAILS);
  const avoirTenderM = tenderMinor(tenders, ['Avoir Client']);
  const debtTenderM = tenderMinor(tenders, ['Crédit Client']);
  // B-2 guard: native restore credits the voucher back BY CODE (refund.rs CAS on
  // credit_vouchers.code). An amount with no code can never be restored, so it is
  // NOT reported as a refund lane - it is excluded from the funding base and
  // flagged, instead of promising money that nothing can pay.
  const voucherAppliedM = Math.max(0, toMinor(orig?.voucherCreditApplied));
  const voucherRestorable = voucherAppliedM > 0 && String(orig?.voucherCode ?? '').trim().length > 0;
  const voucherM = voucherAppliedM > 0 && !voucherRestorable ? 0 : voucherAppliedM;
  if (voucherAppliedM > 0 && !voucherRestorable) anomalies.push('voucher-lane-unrestorable');
  const changeM = Math.max(0, toMinor(orig?.changeDue));

  // Change is carved out of the CASH lane only (D1a): a till that handed 100 DA
  // back did not collect it, and no credit lane is ever reduced for change.
  let cashPaidM = 0;
  if (Number.isFinite(cashTenderM)) {
    cashPaidM = Math.max(0, cashTenderM - Math.min(cashTenderM, changeM));
  } else if (orig?.paymentMethod === 'Espèces') {
    cashPaidM = Math.max(0, totalM - changeM);
    anomalies.push('legacy-no-tenders');
  } else {
    anomalies.push('no-tenders');
  }
  const digitalPaidM = Number.isFinite(digitalTenderM) ? Math.max(0, digitalTenderM) : 0;

  const tenderedGivenM =
    (Number.isFinite(fundingTenderM) ? Math.max(0, fundingTenderM) : 0) + voucherM;
  // D1: what the customer gave, counted ONCE. `total` excludes credit legs and
  // tenders include them, so the larger is the truth for that row's vintage;
  // change is always netted out.
  const givenM = Math.max(totalM, Math.max(0, tenderedGivenM - changeM));
  if (givenM <= 0) anomalies.push('no-funding-base');

  const fundV = Math.min(givenM, voucherM);
  // Tenders are the authority; a legacy row without them falls back to the
  // persisted method/debt columns (same convention as the refund readers).
  const avoirRaw = Number.isFinite(avoirTenderM)
    ? Math.max(0, avoirTenderM)
    : orig?.paymentMethod === 'Avoir Client'
      ? totalM
      : 0;
  const debtRaw = Number.isFinite(debtTenderM)
    ? Math.max(0, debtTenderM)
    : Math.max(0, toMinor(orig?.debtAdded ?? (orig?.paymentMethod === 'Crédit Client' ? totalM : 0)));
  const fundA = Math.min(givenM, avoirRaw);
  const fundD = Math.min(givenM, debtRaw);
  if (fundV + fundA + fundD > givenM) anomalies.push('credits-exceed-base');

  const grossM = Math.max(0, toMinor(grossRefund));
  const priorNetM = Math.max(0, toMinor(priorRecovery));
  const prior = {
    cash: Math.max(0, toMinor(priorLanes?.cash)),
    avoir: Math.max(0, toMinor(priorLanes?.avoir)),
    voucher: Math.max(0, toMinor(priorLanes?.voucher)),
    debt: Math.max(0, toMinor(priorLanes?.debt)),
    digital: Math.max(0, toMinor(priorLanes?.digital)),
    // Cumulative GROSS is the basis for the cumulative rounding; older callers
    // without it fall back to the cumulative net (one rounding per step still).
    gross: Math.max(0, toMinor(priorLanes?.gross ?? priorRecovery)),
  };
  if (priorLanes?.basis === 'legacy') anomalies.push('prior-refund-legacy');

  // Cumulative gross -> one rounding per step on a monotone cumulative, which
  // telescopes to the lane total at the end (D3 i-iv).
  const capGrossM = baseM > 0 ? baseM : Number.MAX_SAFE_INTEGER;
  const cumGrossM = Math.min(capGrossM, prior.gross + grossM);
  let cumNetM = baseM > 0 ? Math.min(givenM, Math.round((givenM * cumGrossM) / baseM)) : givenM;
  // Q-i: the drawer can only hand out whole dinars. On a CASH-ONLY ticket the
  // refund itself is therefore rounded to a whole dinar on a cumulative target,
  // so the sequence still sums to the exact net (333 + 333 + 334 = 1000) and no
  // sub-dinar is ever promised to a drawer that would round it away.
  const hasNonCashLane = fundV > 0 || fundA > 0 || fundD > 0;
  if (!hasNonCashLane) cumNetM = Math.round(cumNetM / 100) * 100;
  const thisNetM = Math.max(0, cumNetM - priorNetM);
  const requestedNetM = baseM > 0 ? Math.round((givenM * grossM) / baseM) : givenM;
  const capped = thisNetM < requestedNetM;
  // D1(c): the hard cap. `cumGrossM` can never pass the ticket's net line value,
  // so the sum of every refund of a ticket can never exceed what was sold —
  // recorded explicitly so a trimmed request is visible in the funding object
  // instead of looking like a smaller refund.
  if (capped) anomalies.push('cumulative-cap');

  const targetM = (fund: number) => (givenM > 0 ? Math.round((cumNetM * fund) / givenM) : 0);

  let v = Math.max(0, Math.min(fundV - prior.voucher, targetM(fundV) - prior.voucher));
  let a = Math.max(0, Math.min(fundA - prior.avoir, targetM(fundA) - prior.avoir));
  let d = Math.max(0, Math.min(fundD - prior.debt, targetM(fundD) - prior.debt));

  // The cash plug absorbs rounding; when the credit lanes round ABOVE the
  // refund (measured 1-in-5000) the largest lane gives the dinar back.
  let plugM = thisNetM - (v + a + d);
  if (plugM < 0) {
    let excess = -plugM;
    const lanes: Array<['v' | 'a' | 'd', number]> = [
      ['v', v],
      ['a', a],
      ['d', d],
    ];
    lanes.sort((x, y) => y[1] - x[1]);
    for (const [key, value] of lanes) {
      if (excess <= 0) break;
      const take = Math.min(excess, value);
      if (key === 'v') v -= take;
      else if (key === 'a') a -= take;
      else d -= take;
      excess -= take;
    }
    plugM = 0;
    anomalies.push('rounding-correction');
  }

  // Rail split of the cash plug: the drawer pays the cash share, a digital rail
  // reverses on its own lane. Cash never exceeds what the customer left behind.
  const railPaidM = cashPaidM + digitalPaidM;
  let cashM = railPaidM > 0 ? Math.min(plugM, Math.round((plugM * cashPaidM) / railPaidM)) : plugM;
  // Q-i: the DRAWER only pays whole dinars. Round the cash lane to a cumulative
  // whole-dinar target (so the sequence stays exact) and hand the sub-dinar
  // remainder to the largest non-cash lane. A fractional ORIGINAL cash lane
  // cannot be fixed here: it is recorded instead of being silently dropped.
  if (cashPaidM % 100 !== 0) {
    // Q-alpha b, narrowed (B5 decision B): the original cash lane itself is
    // fractional, so the drawer can only pay whole dinars. Pay the FLOOR of the
    // cumulative cash quota and let the largest-remainder step below distribute
    // the sub-dinar residue to a lane with headroom (Hamilton / largest
    // remainder: floor the quotas, give the remainder to the largest fractional
    // parts, so the parts still sum to the whole). If nothing can take it, the
    // residue is recorded as `sub-dinar-residue:<r>` and stays unpaid - never
    // silently dropped.
    const cumCashTargetM = Math.round((cumNetM * cashPaidM) / Math.max(1, givenM));
    const floorM = Math.floor(cumCashTargetM / 100) * 100;
    cashM = Math.max(0, Math.min(cashPaidM - prior.cash, floorM - prior.cash));
    anomalies.push('fractional-original-cash');
  } else if (digitalPaidM === 0 && cashPaidM > 0) {
    const cumCashTargetM = Math.round((cumNetM * cashPaidM) / Math.max(1, givenM));
    const cumCashWholeM = Math.round(cumCashTargetM / 100) * 100;
    // The whole-dinar target may exceed this row's cash plug by up to 1 DA;
    // the excess (rem below) is taken out of the largest non-cash lane so the
    // row still sums to its total and the drawer never receives a fraction.
    cashM = Math.max(0, Math.min(cashPaidM - prior.cash, cumCashWholeM - prior.cash));
  }
  let digitalM = digitalPaidM > 0 ? Math.max(0, plugM - cashM) : 0;
  // Sub-dinar remainder -> a non-cash lane with ROOM (rem > 0) or with value to
  // give back (rem < 0), so a lane already at its original amount is never
  // pushed past it. This is what keeps (ii) exact at the end of a sequence.
  let remM = plugM - cashM - digitalM;
  if (remM !== 0) {
    const headroom = (fund: number, priorLane: number, current: number) =>
      Math.max(0, fund - priorLane - current);
    const lanes: Array<['v' | 'a' | 'd', number, number]> = [
      ['v', v, headroom(fundV, prior.voucher, v)],
      ['a', a, headroom(fundA, prior.avoir, a)],
      ['d', d, headroom(fundD, prior.debt, d)],
    ];
    if (remM > 0) {
      lanes.sort((x, y) => y[2] - x[2]);
      for (const [key, , room] of lanes) {
        if (remM === 0) break;
        const take = Math.min(remM, room);
        if (take <= 0) continue;
        if (key === 'v') v += take;
        else if (key === 'a') a += take;
        else d += take;
        remM -= take;
      }
    } else {
      lanes.sort((x, y) => y[1] - x[1]);
      let excess = -remM;
      for (const [key, value] of lanes) {
        if (excess === 0) break;
        const take = Math.min(excess, value);
        if (take <= 0) continue;
        if (key === 'v') v -= take;
        else if (key === 'a') a -= take;
        else d -= take;
        excess -= take;
      }
      remM = -excess;
    }
    if (remM !== 0) {
      // D-RND, resolved by measurement against two oracles: the penny sequence
      // (1.01 ticket, 0.51 cash + 0.50 avoir, refunds 0.01/0.01/0.99) only
      // conserves if a FRACTIONAL original cash lane keeps its fraction, while
      // a whole-DA cash lane must not carry a fraction. So: a real card rail
      // first, then the fractional cash lane itself, then a credit lane, then
      // cash as the last resort. Nothing is ever invented on a rail the
      // customer did not use.
      if (digitalPaidM > 0) digitalM += remM;
      else if (cashPaidM % 100 !== 0) cashM += remM;
      else if (fundA > 0) a += remM;
      else if (fundV > 0) v += remM;
      else if (fundD > 0) d += remM;
      else cashM += remM;
    }
  }
  if (cashM + prior.cash > cashPaidM) anomalies.push('cash-over-paid');

  return {
    grossRefund: fromMinor(grossM),
    netRefund: fromMinor(thisNetM),
    voucherShare: fromMinor(v),
    avoirShare: fromMinor(a),
    debtShare: fromMinor(d),
    cashShare: fromMinor(cashM),
    digitalShare: fromMinor(digitalM),
    cashPaidOriginal: fromMinor(cashPaidM),
    capped,
    anomalies,
  };
}

/**
 * Refund eligibility (zero-value ticket pollution guard). Structural inputs
 * only — the modal memo, the slice pre-check, and unit tests share these, so
 * the list filter can never disagree with the execution gate. Integer DA out.
 */
export interface RefundEligibilityItem {
  product?: { id?: string; price?: number } | null;
  quantity?: number;
  appliedPrice?: number;
  discount?: number;
}

export interface RefundEligibilityTxn {
  id?: string;
  status?: string;
  isRefund?: boolean;
  total?: number;
  subtotal?: number;
  paymentMethod?: string;
  tenders?: Array<{ method?: string; amount?: number }> | null;
  tradeInId?: string | null;
  tradeInDeduction?: number;
  tradeInRestored?: number;
  customer?: { id?: string } | null;
  items?: RefundEligibilityItem[] | null;
  refundedItems?: Array<{ productId?: string; quantity?: number }> | null;
  originalTransactionId?: string;
}

/** Already-refunded quantities per product for one original ticket. */
export function refundedQtyByProduct(
  all: RefundEligibilityTxn[] | undefined | null,
  originalId: string
): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of all || []) {
    if (!t || !t.isRefund || t.originalTransactionId !== originalId) continue;
    for (const ri of t.refundedItems || []) {
      if (!ri || !ri.productId) continue;
      m.set(ri.productId, (m.get(ri.productId) || 0) + Math.max(0, Number(ri.quantity) || 0));
    }
  }
  return m;
}

function netUnitOf(item: RefundEligibilityItem): number {
  const qty = Math.max(0, Number(item.quantity) || 0);
  const unit = Number(item.appliedPrice) || Number(item.product?.price) || 0;
  const discountPerUnit =
    Number(item.discount) > 0 && qty > 0 ? Number(item.discount) / qty : 0;
  return Math.max(0, unit - discountPerUnit);
}

/**
 * Still-refundable value of a ticket (integer DA): remaining quantities at
 * net unit prices, rounded once at the sum — the same basis the slice commits.
 */
export function refundableBalanceOf(
  txn: RefundEligibilityTxn | undefined | null,
  refundedQty: Map<string, number>
): number {
  if (!txn) return 0;
  let sum = 0;
  for (const item of txn.items || []) {
    if (!item) continue;
    const pid = item.product?.id || '';
    if (!pid) continue;
    const remaining = Math.max(0, (Number(item.quantity) || 0) - (refundedQty.get(pid) || 0));
    sum += netUnitOf(item) * remaining;
  }
  return Math.max(0, Math.round(sum));
}

/** List + submit gate: live ticket, not a refund row, with value left. */
export function isRefundEligible(
  txn: RefundEligibilityTxn | undefined | null,
  refundedQty: Map<string, number>
): boolean {
  if (!txn || txn.isRefund) return false;
  if (txn.status === 'VOIDED' || txn.status === 'REFUNDED') return false;
  return refundableBalanceOf(txn, refundedQty) > 0;
}

/**
 * Convenience: remaining refundable value of one ticket against the full
 * ledger (builds the per-ticket refunded map internally). The modal list
 * filter and the slice pre-check share this — one basis, never two.
 */
export function refundableBalanceOfTxn(
  txn: RefundEligibilityTxn | undefined | null,
  allTxns: RefundEligibilityTxn[] | undefined | null
): number {
  if (!txn || txn.isRefund) return 0;
  if (txn.status === 'VOIDED' || txn.status === 'REFUNDED') return 0;
  return refundableBalanceOf(txn, refundedQtyByProduct(allTxns, txn.id || ''));
}

/**
 * Money-truth refundable value (Fix 1 basis): the funding-split net for the
 * remaining lines plus the claimable trade-restore quota — i.e. value that
 * would actually move on submit. Line value alone overstates tickets whose
 * value came from a trade-in device (Reprise, total 0): with no customer the
 * trade value is unclaimable by policy, so the ticket carries 0 and must not
 * list. Integer DA.
 */
export function refundableValueOf(
  txn: RefundEligibilityTxn | undefined | null,
  allTxns: RefundEligibilityTxn[] | undefined | null
): number {
  if (!txn || txn.isRefund) return 0;
  if (txn.status === 'VOIDED' || txn.status === 'REFUNDED') return 0;
  const gross = refundableBalanceOf(txn, refundedQtyByProduct(allTxns, txn.id || ''));
  if (gross <= 0) return 0;
  let priorGross = 0;
  let priorTrade = 0;
  for (const t of allTxns || []) {
    if (!t || !t.isRefund || t.originalTransactionId !== txn.id) continue;
    // Refund totals include the trade value they restored; the funding cap is
    // on the funding basis, so subtract it back (same rule as the slice).
    priorTrade += Math.max(0, Math.round(Number(t.tradeInRestored) || 0));
    priorGross += Math.max(0, Math.round(Number(t.total) || 0) - Math.round(Number(t.tradeInRestored) || 0));
  }
  const funding = computeRefundFundingSplit(txn, gross, priorGross);
  let value = funding.netRefund;
  const deduction = Math.max(0, Math.round(Number(txn.tradeInDeduction) || 0));
  const hasTradeLeg = Boolean(txn.tradeInId) && deduction > 0;
  // Unclaimed trade value (anonymous ticket) restores nothing by policy —
  // it must not keep the ticket listable.
  if (hasTradeLeg && txn.customer) {
    value += computeTradeRestoreQuota(deduction, funding.netRefund, Number(txn.total) || 0, priorTrade);
  }
  return Math.max(0, Math.round(value));
}

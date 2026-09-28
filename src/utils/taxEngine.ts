/**
 * VAT / tax engine — single home for tax math (integer DZD minor units).
 *
 * CONVENTION (documented, 2026-09-20): the `net` input is treated as the
 * HT (pre-tax) base: net = gross − discounts − store/voucher credits.
 *   tva = round(net × vatRate / 100)   (rounded once, at the boundary)
 *   ttc = net + tva
 * `vatRate` is a percent (e.g. 19 for 19 %). Default 0 → identity
 * (ht = net, tva = 0, ttc = net), so behavior is unchanged until a merchant
 * configures a rate in Settings (receiptSettings.vatRate).
 *
 * Money stays integer: inputs are rounded to whole DA on entry, the rate
 * multiplication is the single rounding point. No floats for money.
 */

export interface TaxBreakdown {
  /** Taxable base actually used (net clamped to >= 0 — a refund owes no VAT). */
  ht: number;
  /** VAT amount persisted into the `tax` column of the order row. */
  tva: number;
  /** Total due: ht + tva. This is the amount the tender must cover. */
  ttc: number;
  /** Echo of the applied rate (percent). */
  vatRate: number;
}

function toInt(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) ? v : 0;
}

export function computeTax(net: number, vatRate: number): TaxBreakdown {
  const ht = Math.max(0, toInt(net));
  const rate = Math.max(0, Number(vatRate) || 0);
  const tva = Math.round((ht * rate) / 100);
  return { ht, tva, ttc: ht + tva, vatRate: rate };
}

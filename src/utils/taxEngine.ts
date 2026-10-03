/**
 * VAT / tax engine — REMOVED (owner-confirmed no-TVA product, Gate Addendum A).
 *
 * This module is kept as a zero-tax shim so existing imports keep compiling
 * until the Phase 1b schema drop removes the `tax` column and the `vatRate`
 * plumbing in lockstep (local DDL + remote schema + adapters + projections).
 *
 * Semantics: the rate argument is IGNORED. Every sale is HT-only:
 *   ht = net (clamped >= 0), tva = 0, ttc = ht.
 * There is no rounding point here anymore — inputs are rounded on entry.
 */

export interface TaxBreakdown {
  /** Taxable base actually used (net clamped to >= 0 — a refund owes no VAT). */
  ht: number;
  /** Always 0 — no TVA in this product. Persisted into `tax` until Phase 1b drops it. */
  tva: number;
  /** Total due: ht + 0. This is the amount the tender must cover. */
  ttc: number;
  /** Always 0 — the caller's rate is ignored. */
  vatRate: number;
}

function toInt(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) ? v : 0;
}

export function computeTax(net: number, _vatRate?: number): TaxBreakdown {
  const ht = Math.max(0, toInt(net));
  return { ht, tva: 0, ttc: ht, vatRate: 0 };
}

/**
 * UPGRADE-07 — freight landed-cost allocation + supplier price variance.
 *
 * Freight is strictly the physical shipping/handling fee a supplier invoice
 * charges — NEVER a fiscal levy or customs charge. No levy math exists
 * here and none may be added.
 *
 * Money doctrine: the total is integer DZD and every per-line share is
 * integer DZD whose SUM equals the total exactly (largest-remainder
 * apportionment — no silent cent loss, no sequential fallback). Per-unit
 * rates (`perUnitFreight`) are derived REAL quantities; the single rounding
 * boundary sits at the FIFO composition site
 * (`toIntMoney(unit_cost + freight_per_unit)`), mirroring the rest of the
 * batch-cost pipeline.
 */

export type FreightMethod = 'VALUE' | 'QTY' | 'WEIGHT';

export interface FreightLineInput {
  qty: number;
  unitCost: number;
  /** Physical weight in kg — required when method is WEIGHT. */
  weightKg?: number;
}

export interface FreightAllocationOk {
  ok: true;
  /** Integer DZD per line; Σ === amount exactly. */
  perLineAmount: number[];
  /** perLineAmount[i] / qty[i] — REAL rate, rounded only at composition. */
  perUnitFreight: number[];
}

export interface FreightAllocationErr {
  ok: false;
  reason: 'FREIGHT_NEGATIVE' | 'FREIGHT_EMPTY' | 'FREIGHT_WEIGHT_UNAVAILABLE';
}

export type FreightAllocation = FreightAllocationOk | FreightAllocationErr;

/**
 * Apportions an integer-DZD freight total across receipt lines.
 *
 * - `VALUE` (default): weight = qty × unitCost.
 * - `QTY`: weight = qty.
 * - `WEIGHT`: weight = physical kg; REFUSED unless every line carries one
 *   (no silent downgrade to another method — money doctrine).
 *
 * Zero total weight (e.g. VALUE with all-free lines) splits equally — the
 * only deterministic rule that still lands 100% of the freight.
 */
export function allocateFreight(
  amount: number,
  method: FreightMethod,
  lines: FreightLineInput[]
): FreightAllocation {
  const total = Math.round(Number(amount) || 0);
  if (!Number.isFinite(total) || total < 0) return { ok: false, reason: 'FREIGHT_NEGATIVE' };
  if (lines.length === 0) return { ok: false, reason: 'FREIGHT_EMPTY' };
  if (total === 0) {
    return { ok: true, perLineAmount: lines.map(() => 0), perUnitFreight: lines.map(() => 0) };
  }

  const weights = lines.map((l) => {
    const qty = Math.max(0, Number(l.qty) || 0);
    if (method === 'QTY') return qty;
    if (method === 'WEIGHT') return Math.max(0, Number(l.weightKg) || 0);
    return qty * Math.max(0, Number(l.unitCost) || 0); // VALUE
  });

  if (method === 'WEIGHT' && weights.some((w) => w <= 0)) {
    return { ok: false, reason: 'FREIGHT_WEIGHT_UNAVAILABLE' };
  }

  let weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    for (let i = 0; i < weights.length; i++) weights[i] = 1;
    weightSum = weights.length;
  }

  // Largest-remainder apportionment over integer DZD.
  const exact = weights.map((w) => (total * w) / weightSum);
  const perLine = exact.map((x) => Math.floor(x));
  let remainder = total - perLine.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    perLine[i] += 1;
    remainder -= 1;
  }

  const perUnitFreight = perLine.map((share, i) => {
    const qty = Math.max(0, Number(lines[i].qty) || 0);
    return qty > 0 ? share / qty : 0;
  });

  return { ok: true, perLineAmount: perLine, perUnitFreight };
}

export interface PriceAlert {
  productId: string;
  productName?: string;
  previousCost: number;
  newCost: number;
  /** One-decimal percentage vs the last receipt from the same supplier. */
  variancePct: number;
}

/** Alert threshold: STRICTLY greater than 10% upward creep. */
export const PRICE_ALERT_THRESHOLD_PCT = 10;

/**
 * Detects >10% upward price creep vs the previous receipt from the same
 * supplier. Downward moves are not alerts (a price cut needs no dispute).
 * Lines without a previous price are first-time purchases — nothing to
 * compare, nothing flagged.
 */
export function computePriceAlerts(
  lines: Array<{ productId: string; productName?: string | null; unitCost: number }>,
  previousByProduct: Map<string, number>,
  thresholdPct = PRICE_ALERT_THRESHOLD_PCT
): PriceAlert[] {
  const alerts: PriceAlert[] = [];
  for (const line of lines) {
    const prev = previousByProduct.get(line.productId);
    const next = Math.round(Number(line.unitCost) || 0);
    if (prev === undefined || !Number.isFinite(prev) || prev <= 0 || next <= 0) continue;
    const pct = ((next - prev) / prev) * 100;
    if (pct > thresholdPct) {
      alerts.push({
        productId: line.productId,
        productName: line.productName ?? undefined,
        previousCost: prev,
        newCost: next,
        variancePct: Math.round(pct * 10) / 10,
      });
    }
  }
  return alerts;
}

/**
 * Batch-based inventory valuation — dependency-free core (importable from
 * node tests).
 *
 * Asset valuation is Σ(quantity_remaining × unit_cost) over live batch rows,
 * never products.stock × costPrice (the global latest cost misprices prior
 * inventory — the 500/400 → 6200 class of bug). Mirrors the SQL contract in
 * `getInventoryValuationTotals`: live rows only (deleted = 0,
 * quantity_remaining > 0, SHADOW markers excluded — they are pending-COGS
 * placeholders with zero quantity anyway), missing product price counts 0
 * retail, totals rounded to whole dinars.
 */

export interface ValuationBatchRow {
  productId: string;
  quantityRemaining: unknown;
  unitCost: unknown;
  deleted?: unknown;
  purchaseOrderId?: unknown;
}

export interface InventoryValuation {
  /** Σ live batch quantities (exact remaining units). */
  units: number;
  /** Σ(quantity_remaining × unit_cost) — capital immobilisé. */
  costValue: number;
  /** Σ(quantity_remaining × catalog price) — chiffre d'affaires potentiel. */
  retailValue: number;
}

function toFinite(n: unknown, fallback = 0): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function toInt(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Aggregate batch rows (SQLite SELECT or Dexie mirror shape) into valuation
 * totals. `priceOf` resolves the catalog selling price per product id for
 * the retail leg; unknown products contribute 0 retail (same as the SQL
 * LEFT JOIN + COALESCE(price, 0)).
 */
export function aggregateBatchValuation(
  batches: ValuationBatchRow[] | null | undefined,
  priceOf: (productId: string) => number,
): InventoryValuation {
  let units = 0;
  let cost = 0;
  let retail = 0;
  for (const b of batches ?? []) {
    if (Number(b?.deleted ?? 0) === 1) continue;
    if (String(b?.purchaseOrderId ?? '') === 'SHADOW') continue;
    const qty = Math.max(0, Math.floor(toFinite(b?.quantityRemaining, 0)));
    if (qty <= 0) continue;
    const unitCost = Math.max(0, toFinite(b?.unitCost, 0));
    const price = Math.max(0, toFinite(priceOf(String(b?.productId ?? '')), 0));
    units += qty;
    cost += qty * unitCost;
    retail += qty * price;
  }
  return { units: toInt(units), costValue: toInt(cost), retailValue: toInt(retail) };
}

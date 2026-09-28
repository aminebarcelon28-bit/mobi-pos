/**
 * Catalog reference-cost rule (batch-based FIFO invariant).
 *
 * `products.costPrice` is a managed catalog REFERENCE — never auto-repriced
 * by goods receipts. The first-known cost wins; a missing cost initializes
 * from the first receipt; deliberate corrections happen only via explicit
 * catalog edits (ProductEditor) and catalog sync convergence. Per-receipt
 * actual costs live on their own `stock_batches` rows.
 *
 * Both receipt flows (PO validation, invoice import) funnel through this
 * single predicate so they can never diverge: overwriting the reference with
 * each invoice repriced prior inventory at the newest cost (the 500/400 →
 * 6200 bug class).
 */
export function resolveReferenceCost(currentCost: unknown, incomingCost: unknown): number {
  const current = Number(currentCost);
  if (Number.isFinite(current) && current > 0) return current;
  const incoming = Number(incomingCost);
  if (Number.isFinite(incoming) && incoming >= 0) return incoming;
  return 0;
}

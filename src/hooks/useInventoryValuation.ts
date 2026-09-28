import { useEffect, useState } from 'react';
import type { Product } from '../types/pos';
import { aggregateBatchValuation, type InventoryValuation } from '../utils/inventoryValuation';
import { getEffectiveCostPrice } from '../utils/pricingEngine';

export type ValuationSource = 'sqlite' | 'dexie' | 'legacy';

export interface InventoryValuationState extends InventoryValuation {
  /** sqlite = batches authority; dexie = offline mirror; legacy = last resort. */
  source: ValuationSource;
}

/** Last-resort estimate when neither batch store is reachable. */
function legacyValuation(products: Product[] | undefined): InventoryValuation {
  const list = products ?? [];
  const toInt = (n: unknown): number => {
    const v = Math.round(Number(n) || 0);
    return Number.isFinite(v) ? v : 0;
  };
  let units = 0;
  let cost = 0;
  let retail = 0;
  for (const p of list) {
    const stock = Math.max(0, toInt(p?.stock ?? 0));
    units += stock;
    cost += stock * Math.max(0, toInt(getEffectiveCostPrice(p)));
    retail += stock * Math.max(0, toInt(p?.price ?? 0));
  }
  return { units, costValue: cost, retailValue: retail };
}

/**
 * Report-grade inventory valuation, always batch-based when reachable:
 * SQLite batches authority first, Dexie offline mirror second, legacy
 * stock×cost estimate only when both are unreachable. Totals are
 * Σ(quantity_remaining × unit_cost) over live batches — never the global
 * latest cost times the stock cache.
 */
export function useInventoryValuation(products: Product[] | undefined): InventoryValuationState {
  const [state, setState] = useState<InventoryValuationState>(() => ({
    ...legacyValuation(products),
    source: 'legacy' as const,
  }));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { getInventoryValuationTotals } = await import('../db/sqlPluginAdapter');
        const t = await getInventoryValuationTotals();
        if (!cancelled) setState({ ...t, source: 'sqlite' });
        return;
      } catch {
        // No SQLite (web preview) — fall through to the Dexie mirror.
      }
      try {
        const { db: dexieDb } = await import('../db/database');
        const rows = await dexieDb.stockBatches.toArray();
        const priceById = new Map((products ?? []).map((p) => [p.id, Number(p?.price ?? 0)]));
        const t = aggregateBatchValuation(
          (rows ?? []).map((r) => ({
            productId: String(r.productId ?? ''),
            quantityRemaining: Number(r.quantityRemaining ?? 0),
            unitCost: Number(r.unitCost ?? 0),
            deleted: Number(r.deleted ?? 0),
            purchaseOrderId: (r.purchaseOrderId ?? null) as string | null,
          })),
          (pid) => priceById.get(pid) ?? 0,
        );
        if (!cancelled) setState({ ...t, source: 'dexie' });
      } catch {
        if (!cancelled) setState({ ...legacyValuation(products), source: 'legacy' });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  return state;
}

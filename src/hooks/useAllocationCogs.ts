import { useEffect, useState } from 'react';

/**
 * Frozen-ledger COGS feed for report surfaces (STRICT FIFO LEDGER, v104).
 *
 * Reads the Dexie `saleBatchAllocations` mirror (kept in sync by the
 * checkout post-commit mirror, the boot backfill + mirror, and the pull
 * backfill + mirror) and aggregates Σ(qtyConsumed × unitCostAtSale) per
 * sale id. Report callers pass the returned map as
 * `computeSalesMetrics(..., { allocCogsBySaleId })` so COGS comes from
 * frozen checkout batches — never from stored estimates, `products.
 * costPrice`, or live `stock_batches`.
 *
 * Best-effort: an unreachable/missing mirror yields an empty map and the
 * metrics fall back to stored `costTotal` (never throws, never blocks).
 */
export function useAllocationCogs(saleIds?: string[]): {
  allocCogsBySaleId: Record<string, number>;
  allocationsLoaded: boolean;
} {
  const [map, setMap] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);

  // Scope key: re-query when the sale set identity changes. Cap the key
  // length so a 10k-ticket history cannot blow the dep string.
  const scopeKey = saleIds ? [...saleIds].sort().slice(0, 2000).join(',') : '';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { dexieDb } = await import('../db/database');
        const table = dexieDb.saleBatchAllocations;
        if (!table) {
          if (!cancelled) {
            setMap({});
            setLoaded(true);
          }
          return;
        }
        const ids = saleIds && saleIds.length > 0 ? [...new Set(saleIds.filter(Boolean))] : null;
        const rows = ids && ids.length > 0
          ? await table.where('saleId').anyOf(ids).toArray().catch(() => [])
          : await table.toArray().catch(() => []);
        if (cancelled) return;
        const agg: Record<string, number> = {};
        for (const r of rows ?? []) {
          if (!r || Number(r.deleted ?? 0) !== 0) continue;
          const saleId = String(r.saleId ?? '');
          const qty = Math.max(0, Math.floor(Number(r.qtyConsumed ?? 0)));
          const unit = Math.max(0, Number(r.unitCostAtSale ?? 0));
          if (!saleId || !(qty > 0) || !Number.isFinite(unit)) continue;
          agg[saleId] = (agg[saleId] ?? 0) + qty * unit;
        }
        // Integer-DA canonical: ledger math stays whole dinars like every
        // other money surface in the app.
        for (const k of Object.keys(agg)) agg[k] = Math.round(agg[k]);
        setMap(agg);
        setLoaded(true);
      } catch {
        if (!cancelled) {
          setMap({});
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  return { allocCogsBySaleId: map, allocationsLoaded: loaded };
}

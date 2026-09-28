import { useEffect, useState } from 'react';
import type { CartItem } from '../types/pos';

/**
 * FIFO COGS preview for cart margin displays (index-aligned with `cart`).
 *
 * The cart carries no cost until checkout, so margin badges historically used
 * `product.costPrice` — the LATEST purchase cost — for all units and showed
 * (3500−400)×2 = 6200 for a 500+400 FIFO sale whose true margin is 6100.
 * This hook previews the oldest-first batch allocation (same basis the
 * durable write stores) so displays match the ticket.
 *
 * Resolution order per refresh: SQLite `stock_batches` authority first
 * (same WHERE/ORDER BY as the checkout depletion), then the Dexie
 * `stockBatches` mirror (web preview without SQLite, lock contention).
 * Only FULLY-COVERED previews surface: any shortfall is priced at the
 * last-known/catalog fallback inside the core, i.e. a costPrice-derived
 * number (500×2=1000 → 6,000) — surfacing it would reintroduce the exact
 * bug this hook exists to prevent. Short lines stay `undefined` so callers
 * render pending. Return/exchange lines are always fully covered by
 * construction (caller cost, mirroring the checkout restock leg).
 * Entries are `undefined` while loading/failed everywhere — callers must
 * render a pending state, NEVER a `costPrice`-derived margin (which printed
 * 6,000/6,200 for a 6,100 cart).
 */
export function useFifoPreviewCosts(cart: CartItem[]): Array<number | undefined> {
  const [preview, setPreview] = useState<{ sig: string; costs: Array<number | undefined> }>({
    sig: '',
    costs: [],
  });

  // Render-time signature: a preview resolved for a different cart is stale
  // and stays invisible (never show another product's cost while refetching).
  const sig = (cart ?? [])
    .map((ci) => `${ci.product?.id ?? ''}:${ci.quantity}:${ci.isReturn ? 1 : 0}`)
    .join('|');

  useEffect(() => {
    if (!cart || cart.length === 0) return;
    const snapshot = cart;
    const snapshotSig = sig;
    let cancelled = false;
    const requests = snapshot.map((ci) => ({
      productId: ci.product?.id ?? '',
      qty: Math.abs(Number(ci.quantity ?? 1)),
      isReturn: Boolean(ci.isReturn),
      fallbackCost: Number(ci.unitCostAtSale ?? ci.unitCostPrice ?? ci.product?.costPrice ?? 0),
    }));
    (async () => {
      // Only fully-covered previews surface (see header): a shortfall embeds
      // the catalog fallback cost, which must never reach a margin badge.
      const onlyCovered = (res: Array<{ unitCost: number; fullyCovered: boolean }>) =>
        res.map((r) => (r?.fullyCovered ? r.unitCost : undefined));
      // 1. SQLite authority (same WHERE/ORDER BY as the checkout depletion).
      try {
        const { previewFifoLineCosts } = await import('../db/sqlPluginAdapter');
        const res = await previewFifoLineCosts(requests);
        if (!cancelled) setPreview({ sig: snapshotSig, costs: onlyCovered(res) });
        return;
      } catch {
        // No SQLite (web preview) or lock contention — fall through to the
        // Dexie mirror below instead of surfacing a costPrice-based margin.
      }
      // 2. Dexie stockBatches mirror (offline/web preview). Same oldest-first
      // contract: live rows only, SHADOW markers excluded, blended shortfall
      // handled by the shared preview core.
      try {
        const [{ previewFifoCostsForLines }, { dexieDb }] = await Promise.all([
          import('../utils/fifoPreview'),
          import('../db/database'),
        ]);
        const productIds = [...new Set(requests.filter((l) => !l?.isReturn).map((l) => String(l?.productId ?? '')))].filter(Boolean);
        const batchesByProduct = new Map<string, Array<{ batchId: string; quantityRemaining: number; unitCost: number }>>();
        for (const pid of productIds) {
          const rows = await dexieDb.stockBatches.where('productId').equals(pid).toArray().catch(() => []);
          const live = (rows ?? [])
            .filter((r) => Number(r.quantityRemaining ?? 0) > 0 && Number(r.deleted ?? 0) !== 1 && r.purchaseOrderId !== 'SHADOW')
            .sort((a, b) =>
              String(a.receivedAt ?? '') < String(b.receivedAt ?? '') ? -1
              : String(a.receivedAt ?? '') > String(b.receivedAt ?? '') ? 1
              : String(a.batchId ?? '') < String(b.batchId ?? '') ? -1 : 1,
            )
            .map((r) => ({
              batchId: String(r.batchId),
              quantityRemaining: Number(r.quantityRemaining ?? 0),
              unitCost: Number(r.unitCost ?? 0),
            }));
          batchesByProduct.set(pid, live);
        }
        const res = previewFifoCostsForLines(batchesByProduct, requests);
        if (!cancelled) setPreview({ sig: snapshotSig, costs: onlyCovered(res) });
      } catch {
        // Keep the previous preview (or empty): callers render pending, never
        // a costPrice-derived margin.
      }
    })();
    return () => {
      cancelled = true;
    };
    // `sig` is derived from `cart` during render; a sig change implies a cart
    // change, so depending on the cart identity alone is exact without firing
    // on unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart]);

  return preview.sig === sig ? preview.costs : [];
}

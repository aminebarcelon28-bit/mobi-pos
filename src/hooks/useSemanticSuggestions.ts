/**
 * UPGRADE-03 — advisory accessory suggestions (sqlite-vec Tier-2).
 *
 * Wraps the native `checkout_suggest_accessories` command: given the cart's
 * seed product, the native side ranks catalog neighbors by cosine distance
 * over the product index. This hook is display-only — nothing is ever added
 * to a cart automatically; callers render the products and let the operator
 * decide (suggestions-only, never auto-apply).
 *
 * No-ops outside Tauri (web preview) and while the native index has no
 * confident neighbor. Debounced because cart mutations arrive rapidly.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Product } from '../types/pos';
import { usePosStore } from '../store/usePosStore';
import { invokeCommand } from '../platform/invoke';
import { isTauriEnv } from '../utils/platform';

interface AccessorySuggestionRow {
  /** `products.id` of the neighbor. */
  id: string;
  sku: string;
  title: string;
  price: number;
  stock: number;
  distance: number;
}

export function useSemanticSuggestions(
  seedProductId: string | null,
  limit = 5,
): Product[] {
  const products = usePosStore((s) => s.products);
  const [rows, setRows] = useState<AccessorySuggestionRow[]>([]);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!seedProductId || !isTauriEnv()) {
      setRows([]);
      return undefined;
    }
    const seq = ++requestSeq.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await invokeCommand<AccessorySuggestionRow[]>(
            'checkout_suggest_accessories',
            { seedProductId, k: limit },
          );
          if (requestSeq.current === seq) {
            setRows(Array.isArray(result) ? result : []);
          }
        } catch {
          // Advisory lane: a failed recall renders nothing, never an error.
          if (requestSeq.current === seq) setRows([]);
        }
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [seedProductId, limit]);

  return useMemo(() => {
    const byId = new Map(products.map((p) => [p.id, p]));
    const out: Product[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      const product = byId.get(row.id);
      // Same rule as the existing suggested-products drawer: sellable only.
      if (!product || product.stock <= 0) continue;
      seen.add(row.id);
      out.push(product);
      if (out.length >= limit) break;
    }
    return out;
  }, [rows, products, limit]);
}

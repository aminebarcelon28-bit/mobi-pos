/**
 * UPGRADE-03 — advisory accessory suggestion chips (checkout lanes).
 *
 * Renders the nearest catalog neighbors of the cart's most recent line
 * (native sqlite-vec recall, see `useSemanticSuggestions`). Suggestions are
 * ADVISORY: nothing is added automatically — a tap on a chip is the only
 * commit path, and it routes through the normal `addToCart` lane (stock,
 * pricing tier and volume rules all apply). Renders nothing outside Tauri,
 * with an empty cart, or when the native index has no confident neighbor.
 */
import React from 'react';
import { Plus } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { useSemanticSuggestions } from '../hooks/useSemanticSuggestions';
import { useToast } from './ui/Toast';
import { formatDZD } from '../types/pos';

export const AccessorySuggestions: React.FC = () => {
  const cart = usePosStore((s) => s.cart);
  const addToCart = usePosStore((s) => s.addToCart);
  const { showToast } = useToast();

  const seedId = cart.length > 0 ? (cart[cart.length - 1]?.product?.id ?? null) : null;
  const suggestions = useSemanticSuggestions(seedId, 4);

  const inCart = new Set(cart.map((i) => i.product.id));
  const visible = suggestions.filter((p) => !inCart.has(p.id)).slice(0, 3);
  if (visible.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider shrink-0 select-none">
        Suggestions
      </span>
      {visible.map((product) => (
        <button
          key={product.id}
          type="button"
          onClick={() => {
            const res = addToCart(product);
            if (!res.success) {
              showToast('Stock insuffisant pour cet article', 'warning', 2500);
            }
          }}
          className="flex items-center gap-1.5 min-h-[44px] px-2.5 py-1 rounded-xl bg-pos-card border border-pos-border hover:border-emerald-500/50 active:scale-95 transition cursor-pointer shrink-0"
        >
          <Plus className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
          <span className="text-[11px] font-bold text-pos-text truncate max-w-[9.5rem]">{product.title}</span>
          <span className="text-[10.5px] font-mono text-pos-muted tabular-nums shrink-0">
            {formatDZD(product.price)}
          </span>
        </button>
      ))}
    </div>
  );
};

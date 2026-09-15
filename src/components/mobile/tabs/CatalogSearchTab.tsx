import React, { useState, useMemo } from 'react';
import {
  Search,
  Package,
  Plus,
  Check,
  Smartphone,
  X,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import type { Product } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { getProductPriceForTier } from '../../../utils/pricingEngine';
import { soundEngine } from '../../../utils/audioFeedback';

interface CatalogSearchTabProps {
  onAddToCart?: (product: Product) => void;
}

export const CatalogSearchTab: React.FC<CatalogSearchTabProps> = ({ onAddToCart }) => {
  const { products, addToCart } = usePosStore();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [addedAnimationId, setAddedAnimationId] = useState<string | null>(null);

  // Extract unique categories
  const categories = useMemo(() => {
    const set = new Set<string>();
    (products || []).forEach((p) => {
      if (p.category) set.add(p.category);
    });
    return ['all', ...Array.from(set)];
  }, [products]);

  // Filtered products with multi-attribute search
  const filteredProducts = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return (products || []).filter((p) => {
      const matchesCat = selectedCategory === 'all' || p.category === selectedCategory;
      if (!matchesCat) return false;

      if (!q) return true;
      const titleMatch = (p.title || '').toLowerCase().includes(q);
      const skuMatch = (p.sku || '').toLowerCase().includes(q);
      const barcodeMatch = (p.barcode || '').toLowerCase().includes(q);
      const brandMatch = (p.brand || '').toLowerCase().includes(q);
      return titleMatch || skuMatch || barcodeMatch || brandMatch;
    });
  }, [products, searchTerm, selectedCategory]);

  const handleAdd = (product: Product) => {
    soundEngine.playScan?.();
    addToCart(product);
    onAddToCart?.(product);
    setAddedAnimationId(product.id);
    setTimeout(() => setAddedAnimationId(null), 800);
  };

  return (
    <div className="flex-1 overflow-y-auto p-3.5 space-y-3 pb-20 select-none">
      {/* Search Bar with Camera Barcode Trigger */}
      <div className="relative flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Rechercher nom, code-barres, référence..."
            className="w-full bg-pos-panel border border-pos-border focus:border-cyan-500 rounded-xl pl-9 pr-8 py-2.5 text-xs text-pos-text placeholder-pos-muted focus:outline-none transition-all"
            autoFocus
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-pos-muted hover:text-pos-text"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Categories Horizontal Scroll */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar text-[11px] font-bold">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setSelectedCategory(cat)}
            className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition cursor-pointer ${
              selectedCategory === cat
                ? 'bg-cyan-500 text-slate-950 font-black shadow-sm'
                : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text'
            }`}
          >
            {cat === 'all' ? 'Tous les articles' : cat}
          </button>
        ))}
      </div>

      {/* Product List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[11px] font-bold text-pos-muted px-1">
          <span>{filteredProducts.length} articles répertoriés</span>
        </div>

        {filteredProducts.length === 0 ? (
          <div className="p-8 text-center bg-pos-panel border border-pos-border rounded-2xl">
            <Package className="w-8 h-8 text-pos-muted mx-auto mb-2 opacity-50" />
            <p className="text-xs font-bold text-pos-muted">Aucun article trouvé pour cette recherche.</p>
          </div>
        ) : (
          filteredProducts.map((prod) => {
            const stock = prod.stock ?? 0;
            const isOutOfStock = stock <= 0;
            const isLowStock = stock > 0 && stock <= 3;
            const isAdded = addedAnimationId === prod.id;

            // Multi-tier prices
            const retailPrice = getProductPriceForTier(prod, 'Retail');
            const semiWholesalePrice = getProductPriceForTier(prod, 'VIP');
            const wholesalePrice = getProductPriceForTier(prod, 'Wholesale');

            return (
              <div
                key={prod.id}
                className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-2 shadow-sm hover:border-cyan-500/30 transition"
              >
                {/* Header: Title & Stock Status */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5">
                      {prod.isSerialized && (
                        <span className="p-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                          <Smartphone className="w-3 h-3" />
                        </span>
                      )}
                      <h4 className="text-xs font-black text-pos-text leading-tight">
                        {prod.title}
                      </h4>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-pos-muted mt-0.5">
                      <span>Réf : {prod.sku || '-'}</span>
                      {prod.barcode && <span>• CB : {prod.barcode}</span>}
                    </div>
                  </div>

                  {/* Stock Badge */}
                  <span
                    className={`text-[10px] font-black px-2 py-0.5 rounded-md border shrink-0 ${
                      isOutOfStock
                        ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                        : isLowStock
                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                        : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    }`}
                  >
                    {isOutOfStock ? 'Rupture' : `${stock} en stock`}
                  </span>
                </div>

                {/* Pricing Tiers Matrix */}
                <div className="grid grid-cols-3 gap-1.5 bg-pos-panel/60 p-2 rounded-xl border border-pos-border/40 text-center">
                  <div>
                    <span className="text-[9px] font-bold uppercase text-pos-muted block">
                      Détail
                    </span>
                    <span className="font-mono text-xs font-black text-pos-text block mt-0.5">
                      {formatDZD(retailPrice)}
                    </span>
                  </div>

                  <div className="border-x border-pos-border/40">
                    <span className="text-[9px] font-bold uppercase text-pos-muted block">
                      Demi-Gros
                    </span>
                    <span className="font-mono text-xs font-bold text-cyan-300 block mt-0.5">
                      {formatDZD(semiWholesalePrice)}
                    </span>
                  </div>

                  <div>
                    <span className="text-[9px] font-bold uppercase text-pos-muted block">
                      Gros
                    </span>
                    <span className="font-mono text-xs font-bold text-purple-300 block mt-0.5">
                      {formatDZD(wholesalePrice)}
                    </span>
                  </div>
                </div>

                {/* Quick Add Action */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[10px] text-pos-muted font-medium">
                    {prod.category || 'Général'}
                  </span>

                  <button
                    type="button"
                    onClick={() => handleAdd(prod)}
                    className={`px-3 py-1.5 rounded-xl font-bold text-xs flex items-center gap-1.5 transition active:scale-95 cursor-pointer ${
                      isAdded
                        ? 'bg-emerald-500 text-slate-950 font-black'
                        : 'bg-pos-panel border border-pos-border text-pos-text hover:border-cyan-500'
                    }`}
                  >
                    {isAdded ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Ajouté
                      </>
                    ) : (
                      <>
                        <Plus className="w-3.5 h-3.5 text-cyan-400" />
                        Au Panier
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

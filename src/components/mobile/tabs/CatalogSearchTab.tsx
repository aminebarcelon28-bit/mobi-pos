import React, { useState, useMemo } from 'react';
import {
  Search,
  Package,
  Plus,
  Check,
  Smartphone,
  X,
  Camera,
  Layers,
  Edit3,
  Sparkles,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { AppTabContent } from '../AppScreenLayout';
import type { Product } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { getProductPriceForTier } from '../../../utils/pricingEngine';
import { soundEngine } from '../../../utils/audioFeedback';
import { MobileCameraScanner } from '../MobileCameraScanner';
import { useToast } from '../../ui/Toast';

interface CatalogSearchTabProps {
  onAddToCart?: (product: Product) => void;
}

export const CatalogSearchTab: React.FC<CatalogSearchTabProps> = ({ onAddToCart }) => {
  const { products, addToCart, setEditingProduct, openModal } = usePosStore();
  const { showToast } = useToast();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [addedAnimationId, setAddedAnimationId] = useState<string | null>(null);
  const [isScannerOpen, setIsScannerOpen] = useState(false);

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

  const handleBarcodeScanned = (scannedCode: string) => {
    const trimmed = scannedCode.trim();
    if (!trimmed) return;

    soundEngine.playScan?.();
    setIsScannerOpen(false);

    // Look for exact barcode, sku, or serialized match
    const found = (products || []).find(
      (p) =>
        p.barcode?.toLowerCase() === trimmed.toLowerCase() ||
        p.sku?.toLowerCase() === trimmed.toLowerCase() ||
        p.imeiNumber?.toLowerCase() === trimmed.toLowerCase()
    );

    if (found) {
      handleAdd(found);
      showToast(`Article ajouté : ${found.title}`, 'success');
      setSearchTerm('');
    } else {
      setSearchTerm(trimmed);
      showToast(`Code scanné : ${trimmed}`, 'info');
    }
  };

  return (
    <>
      <AppTabContent
        pinnedTop={
          <div className="px-3.5 pt-3 pb-2.5 space-y-2.5 bg-pos-bg">
            {/* Search Bar with Camera Barcode Trigger */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Nom, code-barres, référence..."
                  className="w-full min-h-[42px] bg-pos-panel border border-pos-border focus:border-cyan-500 rounded-xl pl-9 pr-9 py-2 text-xs text-pos-text placeholder-pos-muted focus:outline-none transition-all shadow-xs"
                />
                {searchTerm && (
                  <button
                    type="button"
                    onClick={() => setSearchTerm('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-pos-muted hover:text-pos-text min-h-[38px] min-w-[38px] flex items-center justify-center active-press cursor-pointer"
                    aria-label="Effacer la recherche"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Camera Barcode Trigger */}
              <button
                type="button"
                onClick={() => setIsScannerOpen(true)}
                className="min-h-[42px] px-3.5 bg-cyan-500/10 border border-cyan-500/30 hover:border-cyan-400 hover:bg-cyan-500/20 text-cyan-400 rounded-xl flex items-center justify-center gap-1.5 active-press transition-all text-xs font-bold shrink-0 cursor-pointer shadow-xs"
                title="Scanner un code-barres avec l'appareil photo"
              >
                <Camera className="w-4 h-4" />
                <span className="hidden xs:inline">Scanner</span>
              </button>
            </div>

            {/* Quick Actions Row: New Product & Accessories Compatibility */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  setEditingProduct(null);
                }}
                className="flex-1 min-h-[42px] px-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-emerald-400 active-press font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-xs"
                title="Créer une nouvelle fiche article (Éditeur complet)"
              >
                <Plus className="w-3.5 h-3.5 stroke-[3]" />
                <span>Nouvel Article</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  openModal('compatibility');
                }}
                className="min-h-[42px] px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-cyan-400/50 text-cyan-400 active-press font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                title="Matrice de compatibilité écrans, verres trempés & coques"
              >
                <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                <span>Compatibilité</span>
              </button>
            </div>

            {/* Categories Horizontal Scroll */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar text-[11px] font-bold">
              {categories.map((cat) => {
                const count =
                  cat === 'all'
                    ? products?.length || 0
                    : (products || []).filter((p) => p.category === cat).length;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`min-h-[40px] px-3.5 py-1.5 rounded-xl whitespace-nowrap transition-all duration-200 cursor-pointer flex items-center gap-1.5 active-press ${
                      selectedCategory === cat
                        ? 'bg-cyan-500 text-slate-950 font-black shadow-md shadow-cyan-500/20'
                        : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text hover:border-pos-border/80'
                    }`}
                  >
                    <span>{cat === 'all' ? 'Tous les articles' : cat}</span>
                    <span
                      className={`text-[9px] px-1.5 py-0.2 rounded-full font-mono ${
                        selectedCategory === cat
                          ? 'bg-slate-950/20 text-slate-950 font-black'
                          : 'bg-pos-card text-pos-muted'
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between text-[11px] font-bold text-pos-muted px-1">
              <span className="flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-cyan-400" />
                {filteredProducts.length} articles trouvés
              </span>
              {searchTerm && (
                <span className="text-[10px] text-cyan-400 truncate max-w-[180px]">
                  Filtre: "{searchTerm}"
                </span>
              )}
            </div>
          </div>
        }
        contentClassName="px-3.5 pb-4 select-none"
      >
        {/* Product List */}
        <div className="space-y-2.5 pt-1">
          {filteredProducts.length === 0 ? (
            <div className="p-8 my-4 text-center bg-pos-panel/60 border border-dashed border-pos-border rounded-2xl flex flex-col items-center justify-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-pos-card border border-pos-border flex items-center justify-center text-pos-muted">
                <Package className="w-6 h-6 opacity-60" />
              </div>
              <div>
                <p className="text-xs font-black text-pos-text">Aucun article trouvé</p>
                <p className="text-[11px] text-pos-muted mt-0.5">
                  Modifiez votre recherche ou utilisez le scanner pour identifier un code-barres.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsScannerOpen(true)}
                className="min-h-[40px] px-4 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400 font-bold text-xs flex items-center gap-1.5 active:scale-95 transition cursor-pointer"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>Ouvrir le Scanner</span>
              </button>
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
                  className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-2.5 shadow-xs hover:border-cyan-500/40 active:border-cyan-500/60 transition-all"
                >
                  {/* Header: Title & Stock Status */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        {prod.isSerialized && (
                          <span className="p-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 shrink-0" title="Article Sérialisé IMEI">
                            <Smartphone className="w-3 h-3" />
                          </span>
                        )}
                        <h4 className="text-xs font-black text-pos-text leading-tight truncate">
                          {prod.title}
                        </h4>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-pos-muted mt-1 font-mono">
                        <span>Réf: {prod.sku || '-'}</span>
                        {prod.barcode && <span>• CB: {prod.barcode}</span>}
                      </div>
                    </div>

                    {/* Stock Badge */}
                    <span
                      className={`text-[10px] font-black px-2 py-0.5 rounded-lg border shrink-0 ${
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
                  <div className="grid grid-cols-3 gap-1.5 bg-pos-panel/70 p-2 rounded-xl border border-pos-border/40 text-center">
                    <div>
                      <span className="text-[9px] font-bold uppercase text-pos-muted block">
                        Détail
                      </span>
                      <span className="font-mono text-xs font-black text-pos-text block mt-0.5">
                        {formatDZD(retailPrice)}
                      </span>
                    </div>

                    <div className="border-x border-pos-border/40">
                      <span className="text-[9px] font-bold uppercase text-cyan-400/90 block">
                        Demi-Gros
                      </span>
                      <span className="font-mono text-xs font-bold text-cyan-300 block mt-0.5">
                        {formatDZD(semiWholesalePrice)}
                      </span>
                    </div>

                    <div>
                      <span className="text-[9px] font-bold uppercase text-purple-400/90 block">
                        Gros
                      </span>
                      <span className="font-mono text-xs font-bold text-purple-300 block mt-0.5">
                        {formatDZD(wholesalePrice)}
                      </span>
                    </div>
                  </div>

                  {/* Quick Add Action & Category Pill */}
                  <div className="flex items-center justify-between pt-1 gap-2">
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-pos-panel border border-pos-border/50 text-pos-muted truncate max-w-[110px]">
                      {prod.category || 'Général'}
                    </span>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.playKeyBeep?.();
                          setEditingProduct(prod);
                        }}
                        className="min-h-[42px] px-3 rounded-xl border border-pos-border bg-pos-panel hover:bg-pos-hover text-pos-muted hover:text-cyan-400 font-bold text-xs flex items-center gap-1.5 transition active-press cursor-pointer"
                        title="Modifier cette fiche article"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span className="hidden xs:inline">Modifier</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleAdd(prod)}
                        className={`min-h-[42px] px-3.5 rounded-xl font-bold text-xs flex items-center gap-1.5 transition-all duration-200 active-press cursor-pointer shadow-xs ${
                          isAdded
                            ? 'bg-emerald-500 text-slate-950 font-black shadow-emerald-500/20'
                            : 'bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500 hover:text-slate-950 text-emerald-400'
                        }`}
                      >
                        {isAdded ? (
                          <>
                            <Check className="w-3.5 h-3.5 stroke-[3]" />
                            <span>Ajouté !</span>
                          </>
                        ) : (
                          <>
                            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                            <span>Au Panier</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </AppTabContent>

      {/* Camera Barcode Scanner Modal */}
      {isScannerOpen && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col p-3 pt-[max(0.75rem,var(--safe-top))] pb-[max(0.75rem,var(--safe-bottom))] animate-in fade-in">
          <div className="flex items-center justify-between pb-2 border-b border-white/10 text-white">
            <div className="flex items-center gap-2">
              <Camera className="w-5 h-5 text-cyan-400" />
              <h3 className="text-sm font-bold">Scanner un Article</h3>
            </div>
            <button
              type="button"
              onClick={() => setIsScannerOpen(false)}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-white/10 hover:bg-white/20 text-white transition cursor-pointer"
              aria-label="Fermer la caméra"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 my-2 overflow-hidden rounded-2xl relative">
            <MobileCameraScanner
              isActive={isScannerOpen}
              onScan={handleBarcodeScanned}
              mode="barcode"
            />
          </div>
        </div>
      )}
    </>
  );
};


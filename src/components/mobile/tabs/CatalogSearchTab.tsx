import React, { useState, useMemo, useEffect } from 'react';
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
  History,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { AppTabContent } from '../AppScreenLayout';
import type { Product } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { getProductPriceForTier } from '../../../utils/pricingEngine';
import { soundEngine } from '../../../utils/audioFeedback';
import { MobileCameraScanner } from '../MobileCameraScanner';
import { useToast } from '../../ui/Toast';

// Normalisation insensible aux accents/casse pour la recherche catalogue.
const foldForSearch = (s: string | undefined | null): string =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

interface CatalogSearchTabProps {
  onAddToCart?: (product: Product) => void;
}

// Recherches récentes : persistance locale, 5 termes maximum, effaçables.
// Réutilise le champ de recherche existant (aucune logique métier touchée).
const RECENT_SEARCHES_KEY = 'mobipos_recent_searches_v1';
const MAX_RECENT_SEARCHES = 5;

const readRecentSearches = (): string[] => {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
};

// Squelette des résultats : mêmes dimensions que les cartes article
// (p-3.5, grille tarifaire, rangée d'actions 42px) pour éviter tout saut.
const CatalogSkeletonCard: React.FC = () => (
  <div
    aria-hidden="true"
    className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-2.5 animate-pulse"
  >
    <div className="flex items-start justify-between gap-2">
      <div className="h-3.5 w-2/3 rounded-md bg-pos-panel border border-pos-border" />
      <div className="h-5 w-16 rounded-lg bg-pos-panel border border-pos-border shrink-0" />
    </div>
    <div className="h-12 rounded-xl bg-pos-panel border border-pos-border" />
    <div className="flex items-center justify-between gap-2">
      <div className="h-4 w-20 rounded-md bg-pos-panel border border-pos-border" />
      <div className="h-[42px] w-28 rounded-xl bg-pos-panel border border-pos-border shrink-0" />
    </div>
  </div>
);

export const CatalogSearchTab: React.FC<CatalogSearchTabProps> = ({ onAddToCart }) => {
  const { products, addToCart, setEditingProduct, openModal } = usePosStore();
  const { showToast } = useToast();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [addedAnimationId, setAddedAnimationId] = useState<string | null>(null);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  // Debounced scan input: instant field, list scan follows 200ms after typing.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm), 200);
    return () => clearTimeout(t);
  }, [searchTerm]);
  // Premier rendu : squelette le temps que le catalogue peigne ses cartes.
  const [catalogHydrated, setCatalogHydrated] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setCatalogHydrated(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const [recentSearches, setRecentSearches] = useState<string[]>(readRecentSearches);
  // Mémorise les recherches abouties (≥ 2 lettres, dédupliquées, max 5).
  useEffect(() => {
    const term = debouncedSearch.trim();
    if (term.length < 2) return;
    setRecentSearches((prev) => {
      if (prev.some((s) => s.toLowerCase() === term.toLowerCase())) return prev;
      const next = [term, ...prev].slice(0, MAX_RECENT_SEARCHES);
      try {
        localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
      } catch {
        // Stockage indisponible (navigation privée) : les puces vivent en mémoire.
      }
      return next;
    });
  }, [debouncedSearch]);

  const handleClearRecentSearches = () => {
    setRecentSearches([]);
    try {
      localStorage.removeItem(RECENT_SEARCHES_KEY);
    } catch {
      // Stockage indisponible : la liste mémoire est déjà vidée.
    }
  };

  const handleClearSearch = () => {
    setSearchTerm('');
    setSelectedCategory('all');
  };

  // Extract unique categories
  const categories = useMemo(() => {
    const set = new Set<string>();
    (products || []).forEach((p) => {
      if (p.category) set.add(p.category);
    });
    return ['all', ...Array.from(set)];
  }, [products]);

  // Filtered products with multi-attribute search (accent-insensitive).
  // Reads debouncedSearch so the list re-scans 200ms after typing stops.
  const filteredProducts = useMemo(() => {
    const q = foldForSearch(debouncedSearch.trim());
    return (products || []).filter((p) => {
      const matchesCat = selectedCategory === 'all' || p.category === selectedCategory;
      if (!matchesCat) return false;

      if (!q) return true;
      const titleMatch = foldForSearch(p.title).includes(q);
      const skuMatch = foldForSearch(p.sku).includes(q);
      const barcodeMatch = foldForSearch(p.barcode).includes(q);
      const imeiMatch = foldForSearch(p.imeiNumber).includes(q);
      const brandMatch = foldForSearch(p.brand).includes(q);
      return titleMatch || skuMatch || barcodeMatch || imeiMatch || brandMatch;
    });
  }, [products, debouncedSearch, selectedCategory]);

  const handleAdd = (product: Product) => {
    soundEngine.playScan?.();
    addToCart(product);
    onAddToCart?.(product);
    setAddedAnimationId(product.id);
    setTimeout(() => setAddedAnimationId(null), 800);
  };

  const handleBarcodeScanned = (scannedCode: string) => {
    const raw = (scannedCode || '').trim();
    if (!raw) return;

    soundEngine.playScan?.();
    setIsScannerOpen(false);

    const code = raw.toLowerCase();
    const clean = raw.replace(/^\][A-Za-z0-9]{2}/, '').toLowerCase();
    const noLeadingZeros = clean.replace(/^0+/, '');

    // Look for exact barcode, sku, or serialized match with robust normalization
    const found = (products || []).find((p) => {
      const b = (p.barcode || '').trim().toLowerCase();
      const s = (p.sku || '').trim().toLowerCase();
      const imei = (p.imeiNumber || '').trim().toLowerCase();
      return (
        b === code ||
        b === clean ||
        (noLeadingZeros.length > 0 && b === noLeadingZeros) ||
        s === code ||
        s === clean ||
        (noLeadingZeros.length > 0 && s === noLeadingZeros) ||
        imei === code ||
        imei === clean
      );
    });

    if (found) {
      handleAdd(found);
      showToast(`Article ajouté : ${found.title}`, 'success');
      setSearchTerm('');
    } else {
      setSearchTerm(clean || raw);
      showToast(`Code scanné : ${raw}`, 'info');
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

            {/* Recherches récentes : puces réutilisant le champ existant */}
            {recentSearches.length > 0 && !searchTerm.trim() && (
              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
                <span className="text-[10px] font-black uppercase tracking-wider text-pos-muted shrink-0 flex items-center gap-1">
                  <History className="w-3.5 h-3.5" />
                  <span>Récents</span>
                </span>
                {recentSearches.map((term) => (
                  <button
                    key={term}
                    type="button"
                    onClick={() => setSearchTerm(term)}
                    aria-label={`${term} — Rechercher`}
                    className="min-h-[44px] px-3 rounded-xl bg-pos-panel border border-pos-border text-pos-text text-[11px] font-bold whitespace-nowrap active-press transition hover:border-cyan-400/50 cursor-pointer shrink-0"
                  >
                    {term}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={handleClearRecentSearches}
                  aria-label="Effacer les recherches récentes"
                  title="Effacer les recherches récentes"
                  className="min-h-[44px] min-w-[44px] px-2.5 rounded-xl text-pos-muted hover:text-rose-400 text-[11px] font-bold active-press transition cursor-pointer shrink-0 flex items-center justify-center"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Quick Actions Row: New Product, Scan Facture (IA) & Compatibility */}
            <div className="grid grid-cols-3 gap-1.5 sm:flex sm:items-center sm:gap-2">
              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  setEditingProduct(null);
                  openModal('product_editor');
                }}
                className="min-h-[44px] px-2 sm:px-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-emerald-400 active-press font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-xs truncate"
                title="Créer une nouvelle fiche article (Éditeur complet)"
              >
                <Plus className="w-3.5 h-3.5 stroke-[3] shrink-0" />
                <span className="truncate">Article</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  openModal('invoice_ingestion');
                }}
                className="min-h-[44px] px-2 sm:px-3 rounded-xl bg-gradient-to-r from-emerald-500/20 to-teal-500/20 border border-emerald-500/40 text-emerald-300 hover:text-emerald-200 active-press font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-xs truncate"
                title="Scanner un Bon de Livraison ou Facture Fournisseur (IA Recon)"
              >
                <Camera className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="truncate">Facture IA</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  openModal('compatibility');
                }}
                className="min-h-[44px] px-2 sm:px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-cyan-400/50 text-cyan-400 active-press font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer truncate"
                title="Matrice de compatibilité écrans, verres trempés & coques"
              >
                <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <span className="truncate">Compat</span>
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
        <div className="space-y-2.5 pt-1" aria-busy={searchTerm !== debouncedSearch}>
          {!catalogHydrated ? (
            <div role="status" aria-label="Chargement du catalogue…" className="space-y-2.5">
              <CatalogSkeletonCard />
              <CatalogSkeletonCard />
              <CatalogSkeletonCard />
            </div>
          ) : filteredProducts.length === 0 ? (
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
              <div className="flex flex-col sm:flex-row gap-2 w-full max-w-xs justify-center">
                <button
                  type="button"
                  onClick={handleClearSearch}
                  className="w-full min-h-[44px] px-4 rounded-xl bg-pos-card border border-pos-border hover:border-pos-text text-pos-text font-bold text-xs flex items-center justify-center gap-1.5 active-press transition cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Effacer la recherche</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsScannerOpen(true)}
                  className="w-full min-h-[44px] px-4 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400 font-bold text-xs flex items-center justify-center gap-1.5 active-press transition cursor-pointer"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>Ouvrir le Scanner</span>
                </button>
              </div>
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
                      <div className="flex items-center gap-2 text-[10px] text-pos-muted mt-1 font-mono flex-wrap">
                        <span>Réf: {prod.sku || '-'}</span>
                        {prod.barcode && <span>• CB: {prod.barcode}</span>}
                        {prod.imeiNumber && (
                          <span className="text-cyan-400 font-bold bg-cyan-500/10 px-1.5 py-0.2 rounded border border-cyan-500/20">
                            IMEI: {prod.imeiNumber}
                          </span>
                        )}
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
                          openModal('product_editor');
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


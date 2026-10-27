import React, { useState, useMemo, useEffect, useRef } from 'react';
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
import { soundEngine, triggerHaptic } from '../../../utils/audioFeedback';
import { MobileCameraScanner } from '../MobileCameraScanner';
import { useToast } from '../../ui/Toast';
import { useRegisterMobileBackHandler } from '../../../hooks/useMobileBackNavigation';
import { useTranslation, Bdi } from '../../../i18n';

// Normalisation insensible aux accents/casse pour la recherche catalogue.
import { matchProductSearch } from '../../../utils/catalogSearch';



interface CatalogSearchTabProps {
  onAddToCart?: (product: Product) => void;
}

// Recherches récentes : persistance locale, 5 termes maximum, effaçables.
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

// Squelette des résultats : mêmes dimensions compactes que les cartes article pour éviter tout saut.
const CatalogSkeletonCard: React.FC = () => (
  <div
    aria-hidden="true"
    className="bg-pos-card border border-pos-border rounded-2xl p-3 space-y-2 animate-pulse"
  >
    <div className="flex items-start justify-between gap-2">
      <div className="h-3.5 w-2/3 rounded-md bg-pos-panel border border-pos-border" />
      <div className="h-5 w-16 rounded-lg bg-pos-panel border border-pos-border shrink-0" />
    </div>
    <div className="h-11 rounded-xl bg-pos-panel border border-pos-border" />
    <div className="flex items-center justify-between gap-2">
      <div className="h-4 w-20 rounded-md bg-pos-panel border border-pos-border" />
      <div className="h-[48px] w-28 rounded-xl bg-pos-panel border border-pos-border shrink-0" />
    </div>
  </div>
);

export const CatalogSearchTab: React.FC<CatalogSearchTabProps> = ({ onAddToCart }) => {
  const { t } = useTranslation();
  const { products, addToCart, setEditingProduct, openModal } = usePosStore();
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [addedAnimationId, setAddedAnimationId] = useState<string | null>(null);
  const [isScannerOpen, setIsScannerOpen] = useState(false);

  useRegisterMobileBackHandler(isScannerOpen, () => setIsScannerOpen(false), 'catalog-scanner');

  // Debounced scan input: instant field, list scan follows 200ms after typing.
  // Instant reset on empty query to prevent UI lag on search clear.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [prevSearchTerm, setPrevSearchTerm] = useState(searchTerm);
  if (prevSearchTerm !== searchTerm) {
    setPrevSearchTerm(searchTerm);
    if (!searchTerm.trim()) {
      setDebouncedSearch('');
    }
  }

  useEffect(() => {
    if (!searchTerm.trim()) return;
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 200);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Premier rendu : instantané sans délai artificiel
  const [catalogHydrated] = useState(true);

  const [recentSearches, setRecentSearches] = useState<string[]>(readRecentSearches);
  // Mémorise les recherches abouties (≥ 2 lettres, dédupliquées, max 5).
  useEffect(() => {
    const term = debouncedSearch.trim();
    if (term.length < 2) return;
    const timer = setTimeout(() => {
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
    }, 0);
    return () => clearTimeout(timer);
  }, [debouncedSearch]);

  const handleClearRecentSearches = () => {
    soundEngine.playKeyBeep?.();
    setRecentSearches([]);
    try {
      localStorage.removeItem(RECENT_SEARCHES_KEY);
    } catch {
      // Stockage indisponible : la liste mémoire est déjà vidée.
    }
    showToast('Recherches récentes effacées', 'info');
  };

  const handleClearSearch = () => {
    setSearchTerm('');
    setDebouncedSearch('');
    setSelectedCategory('all');
    inputRef.current?.focus();
  };

  const handleSelectRecentSearch = (term: string) => {
    soundEngine.playKeyBeep?.();
    setSearchTerm(term);
    setDebouncedSearch(term);
  };

  // Precomputed category counts ($O(N)$ once per products change)
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let total = 0;
    for (const p of products || []) {
      total++;
      if (p.category) {
        counts.set(p.category, (counts.get(p.category) || 0) + 1);
      }
    }
    counts.set('all', total);
    return counts;
  }, [products]);

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
    const rawQ = debouncedSearch.trim();
    return (products || []).filter((p) => {
      const matchesCat = !rawQ ? (selectedCategory === 'all' || p.category === selectedCategory) : true;
      if (!matchesCat) return false;

      if (!rawQ) return true;
      return matchProductSearch(p, rawQ);







    });
  }, [products, debouncedSearch, selectedCategory]);

  const handleAdd = (product: Product) => {
    const res = addToCart(product);
    if (!res.success) {
      soundEngine.playError?.();
      if (res.reason === 'STOCK_EMPTY') {
        showToast(`Stock épuisé pour « ${product.title} » (PIN gérant requis)`, 'error');
      } else {
        showToast(res.reason || "Impossible d'ajouter au panier", 'error');
      }
      return;
    }

    triggerHaptic('medium');
    soundEngine.playScan?.();
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
      setDebouncedSearch('');
    } else {
      const term = clean || raw;
      setSearchTerm(term);
      setDebouncedSearch(term);
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
                <Search
                  className="w-4 h-4 absolute start-3.5 top-1/2 -translate-y-1/2 text-pos-muted pointer-events-none"
                  aria-hidden="true"
                />
                {/* Font size text-base (16px) strictly preserves iOS Safari auto-zoom prevention */}
                <input
                  ref={inputRef}
                  type="search"
                  inputMode="search"
                  enterKeyHint="search"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  data-barcode-scan-target="true"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder={t.catalog.searchPlaceholder}
                  className="w-full min-h-[48px] bg-pos-panel border border-pos-border focus:border-cyan-500 rounded-xl ps-10 pe-12 py-2 text-base text-pos-text placeholder-pos-muted focus:outline-none transition-all shadow-xs"
                />
                {searchTerm && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchTerm('');
                      setDebouncedSearch('');
                      inputRef.current?.focus();
                    }}
                    className="absolute end-1 top-1/2 -translate-y-1/2 min-h-[48px] min-w-[48px] text-pos-muted hover:text-pos-text flex items-center justify-center active-press cursor-pointer"
                    aria-label={t.catalog.clearSearchAria}
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
              </div>

              {/* Camera Barcode Trigger */}
              <button
                type="button"
                onClick={() => setIsScannerOpen(true)}
                className="min-h-[48px] min-w-[48px] px-3.5 pos-status-info border hover:bg-cyan-500/20 rounded-xl flex items-center justify-center gap-1.5 active-press transition-all text-xs font-bold shrink-0 cursor-pointer shadow-xs"
                title="Scanner un code-barres avec l'appareil photo"
                aria-label={`${t.catalog.scannerButton} — Appareil photo`}
              >
                <Camera className="w-4 h-4" aria-hidden="true" />
                <span className="hidden xs:inline">{t.catalog.scannerButton}</span>
              </button>
            </div>

            {/* Recherches récentes : puces réutilisant le champ existant avec défilement fluide et fondu */}
            {recentSearches.length > 0 && !searchTerm.trim() && (
              <div className="flex items-center gap-1.5">
                <div className="flex-1 flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar scroll-smooth overscroll-contain scroll-fade-x">
                  <span className="text-[10px] font-black uppercase tracking-wider text-pos-muted shrink-0 flex items-center gap-1 ps-0.5">
                    <History className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
                    <span>{t.catalog.recentSearchesLabel}</span>
                  </span>
                  {recentSearches.map((term) => (
                    <button
                      key={term}
                      type="button"
                      onClick={() => handleSelectRecentSearch(term)}
                      aria-label={`${term} — Rechercher`}
                      className="min-h-[48px] px-3 rounded-xl bg-pos-panel border border-pos-border text-pos-text text-[11px] font-bold whitespace-nowrap active-press transition hover:border-cyan-500/50 cursor-pointer shrink-0"
                    >
                      {term}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleClearRecentSearches}
                  aria-label={t.catalog.clearRecentSearchesAria}
                  title={t.catalog.clearRecentSearchesAria}
                  className="min-h-[48px] min-w-[48px] px-2.5 rounded-xl text-pos-muted hover:text-rose-600 dark:hover:text-rose-400 text-[11px] font-bold active-press transition cursor-pointer shrink-0 flex items-center justify-center border border-pos-border bg-pos-panel/60"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
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
                className="min-h-[48px] px-2 sm:px-3 rounded-xl pos-status-ok border hover:bg-emerald-500/25 active-press font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-xs truncate"
                title={t.catalog.newProductTitle}
              >
                <Plus className="w-3.5 h-3.5 stroke-[3] shrink-0" aria-hidden="true" />
                <span className="truncate">{t.catalog.newProductButton}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  openModal('invoice_ingestion');
                }}
                className="min-h-[48px] px-2 sm:px-3 rounded-xl pos-status-ok border hover:bg-emerald-500/25 active-press font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-xs truncate"
                title={t.catalog.aiInvoiceTitle}
              >
                <Camera className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{t.catalog.aiInvoiceButton}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  openModal('compatibility');
                }}
                className="min-h-[48px] px-2 sm:px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-cyan-500/50 text-cyan-700 dark:text-cyan-400 active-press font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer truncate"
                title={t.catalog.compatibilityTitle}
              >
                <Sparkles className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400 shrink-0" aria-hidden="true" />
                <span className="truncate">{t.catalog.compatibilityButton}</span>
              </button>
            </div>

            {/* Categories Horizontal Scroll with Trailing Fade & Overscroll Containment */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar scroll-smooth overscroll-contain scroll-fade-x text-[11px] font-bold">
              {categories.map((cat) => {
                const isSelected = selectedCategory === cat;
                const count = categoryCounts.get(cat) || 0;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => {
                      soundEngine.playKeyBeep?.();
                      setSelectedCategory(cat);
                    }}
                    aria-pressed={isSelected}
                    className={`min-h-[48px] px-3.5 py-1.5 rounded-xl whitespace-nowrap transition-all duration-200 cursor-pointer flex items-center gap-1.5 active-press shrink-0 ${
                      isSelected
                        ? 'bg-cyan-500 text-slate-950 font-black shadow-md shadow-cyan-500/20'
                        : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text hover:border-pos-border/80'
                    }`}
                  >
                    <span>{cat === 'all' ? t.catalog.allCategories : cat}</span>
                    <Bdi
                      mono
                      className={`text-[10px] px-1.5 py-0.5 rounded-full transition-colors ${
                        isSelected
                          ? 'bg-slate-950/25 text-slate-950 font-black'
                          : 'bg-pos-card text-pos-text border border-pos-border font-bold'
                      }`}
                    >
                      {count}
                    </Bdi>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between text-[11px] font-bold text-pos-muted px-1">
              <span className="flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
                <span>
                  {t('catalog.productsFoundCount', { count: filteredProducts.length })}
                </span>
              </span>
              {searchTerm && (
                <span className="text-[10px] text-cyan-700 dark:text-cyan-400 truncate max-w-[180px]">
                  {t('catalog.activeFilterPrefix', { query: searchTerm })}
                </span>
              )}
            </div>
          </div>
        }
        contentClassName="px-3.5 pb-4 select-none"
      >
        {/* Product List / Responsive High-Density Grid */}
        <div className="@container pt-1" aria-busy={searchTerm !== debouncedSearch}>
          {!catalogHydrated ? (
            <div
              role="status"
              aria-label={t.catalog.loadingCatalogAria}
              className="grid grid-cols-1 sm:grid-cols-2 @min-[560px]:grid-cols-2 gap-2.5"
            >
              <CatalogSkeletonCard />
              <CatalogSkeletonCard />
              <CatalogSkeletonCard />
              <CatalogSkeletonCard />
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="p-8 my-4 text-center bg-pos-panel/60 border border-dashed border-pos-border rounded-2xl flex flex-col items-center justify-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-pos-card border border-pos-border flex items-center justify-center text-pos-muted">
                <Package className="w-6 h-6 opacity-60" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs font-black text-pos-text">{t.catalog.emptyCatalogTitle}</p>
                <p className="text-[11px] text-pos-muted mt-0.5">{t.catalog.emptyCatalogDescription}</p>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 w-full max-w-xs justify-center pt-1">
                <button
                  type="button"
                  onClick={handleClearSearch}
                  className="w-full min-h-[48px] px-4 rounded-xl bg-pos-card border border-pos-border hover:border-pos-text text-pos-text font-bold text-xs flex items-center justify-center gap-1.5 active-press transition cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t.catalog.clearSearchButton}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsScannerOpen(true)}
                  className="w-full min-h-[48px] px-4 rounded-xl pos-status-info border font-bold text-xs flex items-center justify-center gap-1.5 active-press transition cursor-pointer shadow-xs"
                >
                  <Camera className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t.catalog.openScannerButton}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 @min-[560px]:grid-cols-2 gap-2.5">
              {filteredProducts.map((prod) => {
                const isService = Boolean(
                  prod.isService ||
                    prod.category === 'Services' ||
                    prod.id?.startsWith('qt-') ||
                    prod.id?.startsWith('prod-misc-'),
                );
                const stock = prod.stock ?? 0;
                const isOutOfStock = !isService && stock <= 0;
                const isLowStock = !isService && stock > 0 && stock <= (prod.reorderPoint || 3);
                const isAdded = addedAnimationId === prod.id;
                const hasFifoCost = !isService && typeof prod.costPrice === 'number' && prod.costPrice > 0;

                // Multi-tier prices
                const retailPrice = getProductPriceForTier(prod, 'Retail');
                const semiWholesalePrice = getProductPriceForTier(prod, 'VIP');
                const wholesalePrice = getProductPriceForTier(prod, 'Wholesale');

                return (
                  <div
                    key={prod.id}
                    className={`bg-pos-card border rounded-2xl p-3 space-y-2 shadow-xs transition-all duration-200 ${
                      isAdded
                        ? 'border-emerald-500 ring-2 ring-emerald-500/60 shadow-md shadow-emerald-500/10'
                        : isOutOfStock
                        ? 'border-dashed border-rose-500/40 bg-rose-500/5'
                        : isLowStock
                        ? 'border-amber-500/40 hover:border-amber-500/60'
                        : 'border-pos-border hover:border-cyan-500/40'
                    }`}
                  >
                    {/* Header: Title & Stock Status Badge */}
                    <div className="flex items-start justify-between gap-2 text-start">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {prod.isSerialized && (
                            <span
                              className="p-0.5 rounded pos-status-info border shrink-0"
                              title="Article Sérialisé IMEI"
                            >
                              <Smartphone className="w-3 h-3" aria-hidden="true" />
                            </span>
                          )}
                          <h4 className="text-xs font-black text-pos-text leading-tight truncate">
                            {prod.title}
                          </h4>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-pos-muted mt-1 font-mono flex-wrap">
                          <span>
                            {t.catalog.skuPrefix} <Bdi mono>{prod.sku || '-'}</Bdi>
                          </span>
                          {prod.barcode && (
                            <span>
                              • {t.catalog.barcodePrefix} <Bdi mono>{prod.barcode}</Bdi>
                            </span>
                          )}
                          {prod.imeiNumber && (
                            <span className="pos-status-info font-bold px-1.5 py-0.5 rounded border">
                              IMEI: <Bdi mono>{prod.imeiNumber}</Bdi>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Stock Badge with Contrast-Verified Light & Dark States */}
                      {isService ? (
                        <span className="text-[10px] font-black px-2 py-0.5 rounded-lg border pos-status-warn shrink-0 inline-flex items-center gap-1">
                          <Sparkles className="w-2.5 h-2.5" aria-hidden="true" />
                          <span>{t.catalog.serviceBadge}</span>
                        </span>
                      ) : isOutOfStock ? (
                        <span className="text-[10px] font-black px-2 py-0.5 rounded-lg border pos-status-danger shrink-0 inline-flex items-center gap-1 shadow-xs">
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" aria-hidden="true" />
                          <span>{t.catalog.stockOut}</span>
                        </span>
                      ) : isLowStock ? (
                        <span className="text-[10px] font-black px-2 py-0.5 rounded-lg border pos-status-warn shrink-0 inline-flex items-center gap-1 shadow-xs">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                          <span>
                            {t('catalog.stockLow', { count: stock })}
                          </span>
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg border pos-status-ok shrink-0 inline-flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                          <span>
                            {t('catalog.stockAvailable', { count: stock })}
                          </span>
                        </span>
                      )}
                    </div>

                    {/* Pricing Tiers Matrix & FIFO Cost — Contrast-Verified in Light & Dark Mode */}
                    <div className="space-y-1.5">
                      <div className="grid grid-cols-3 gap-1.5 bg-pos-panel p-2 rounded-xl border border-pos-border text-center">
                        <div>
                          <span className="text-[9px] font-bold uppercase text-pos-muted block">
                            {t.catalog.tierRetailShort}
                          </span>
                          <Bdi mono className="text-xs font-black text-pos-text block mt-0.5">
                            {formatDZD(retailPrice)}
                          </Bdi>
                        </div>

                        <div className="border-x border-pos-border px-1">
                          <span className="text-[9px] font-bold uppercase text-purple-800 dark:text-purple-300 block">
                            {t.catalog.tierSemiWholesaleShort}
                          </span>
                          <Bdi
                            mono
                            className="text-xs font-bold text-purple-800 dark:text-purple-300 block mt-0.5"
                          >
                            {formatDZD(semiWholesalePrice)}
                          </Bdi>
                        </div>

                        <div>
                          <span className="text-[9px] font-bold uppercase text-indigo-800 dark:text-indigo-300 block">
                            {t.catalog.tierWholesaleShort}
                          </span>
                          <Bdi
                            mono
                            className="text-xs font-bold text-indigo-800 dark:text-indigo-300 block mt-0.5"
                          >
                            {formatDZD(wholesalePrice)}
                          </Bdi>
                        </div>
                      </div>

                      {/* FIFO Cost Indicator (visible where applicable: physical products with recorded cost) */}
                      {hasFifoCost && (
                        <div className="flex items-center justify-between px-2.5 py-1 rounded-lg bg-pos-panel border border-pos-border text-[10px] font-mono">
                          <span className="text-pos-muted font-bold flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-cyan-500" aria-hidden="true" />
                            <span>{t.catalog.fifoCostLabel}</span>
                          </span>
                          <Bdi mono className="font-bold text-cyan-800 dark:text-cyan-300">
                            {formatDZD(prod.costPrice)}
                          </Bdi>
                        </div>
                      )}
                    </div>

                    {/* Quick Add Action & Category Pill */}
                    <div className="flex items-center justify-between pt-0.5 gap-2">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-pos-panel border border-pos-border text-pos-muted truncate max-w-[110px]">
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
                          aria-label={`${t.catalog.editProductButton} — ${prod.title}`}
                          className="min-h-[48px] min-w-[48px] px-3 rounded-xl border border-pos-border bg-pos-panel hover:bg-pos-hover text-pos-muted hover:text-cyan-600 dark:hover:text-cyan-400 font-bold text-xs flex items-center justify-center gap-1.5 transition active-press cursor-pointer"
                          title="Modifier cette fiche article"
                        >
                          <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span className="hidden xs:inline">{t.catalog.editProductButton}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleAdd(prod)}
                          aria-label={
                            isAdded
                              ? `${t.catalog.addedToCartFeedback} — ${prod.title}`
                              : `${t.catalog.addToCartButton} — ${prod.title}`
                          }
                          className={`min-h-[48px] px-3.5 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all duration-200 active-press cursor-pointer shadow-xs ${
                            isAdded
                              ? 'bg-emerald-500 text-slate-950 font-black shadow-emerald-500/20'
                              : isOutOfStock
                              ? 'pos-status-danger border hover:bg-rose-500 hover:text-white'
                              : 'pos-status-ok border hover:bg-emerald-500 hover:text-slate-950'
                          }`}
                        >
                          {isAdded ? (
                            <>
                              <Check className="w-3.5 h-3.5 stroke-[3]" aria-hidden="true" />
                              <span>{t.catalog.addedToCartFeedback}</span>
                            </>
                          ) : (
                            <>
                              <Plus className="w-3.5 h-3.5 stroke-[2.5]" aria-hidden="true" />
                              <span>{t.catalog.addToCartButton}</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </AppTabContent>

      {/* Camera Barcode Scanner Modal */}
      {isScannerOpen && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col p-3 pt-[max(0.75rem,var(--safe-top))] pb-[max(0.75rem,var(--safe-bottom))] animate-in fade-in">
          <div className="flex items-center justify-between pb-2 border-b border-white/10 text-white">
            <div className="flex items-center gap-2">
              <Camera className="w-5 h-5 text-cyan-400" aria-hidden="true" />
              <h3 className="text-sm font-bold">Scanner un Article</h3>
            </div>
            <button
              type="button"
              onClick={() => setIsScannerOpen(false)}
              className="min-h-[48px] min-w-[48px] flex items-center justify-center rounded-xl bg-white/10 hover:bg-white/20 text-white transition active-press cursor-pointer"
              aria-label="Fermer la caméra"
            >
              <X className="w-5 h-5" aria-hidden="true" />
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



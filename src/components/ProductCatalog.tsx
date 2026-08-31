import React, { useState, useCallback, useMemo } from 'react';
import { Search, Edit2, Zap, AlertCircle, Truck, LayoutGrid, List } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { useCatalogHotkeys } from '../hooks/useCatalogHotkeys';
import { formatDZD } from '../types/pos';
import type { CategoryType, SortOption, Product, BrandName } from '../types/pos';
import { PinDialog } from './ui/PinDialog';

const CATEGORIES: CategoryType[] = [
  'Tous les produits',
  'Coques iPhone',
  'Coques Samsung',
  'Coques Google',
  'Chargeurs',
  'Câbles',
  'Protège-Écran',
];

const BRANDS: Array<{ label: string; value: 'Tous' | BrandName }> = [
  { label: 'Toutes Marques', value: 'Tous' },
  { label: 'Apple', value: 'Apple' },
  { label: 'Samsung', value: 'Samsung' },
  { label: 'Xiaomi', value: 'Autre' },
  { label: 'Google', value: 'Google' },
];

const SORT_OPTIONS: { label: string; value: SortOption }[] = [
  { label: 'Nom (A-Z)', value: 'name_asc' },
  { label: 'Prix croissant', value: 'price_asc' },
  { label: 'Prix décroissant', value: 'price_desc' },
  { label: 'Stock élevé', value: 'stock_desc' },
  { label: 'Par Marque', value: 'brand_asc' },
];

interface QuickActionTile {
  id: string;
  title: string;
  category: CategoryType;
  price: number;
  costPrice: number;
  icon: string;
  color: string;
}

const DEFAULT_QUICK_TILES: QuickActionTile[] = [
  { id: 'qt-hydrogel', title: 'Pose Film Hydrogel', category: 'Protège-Écran', price: 1000, costPrice: 200, icon: '🛡️', color: 'from-blue-500/20 to-cyan-500/20 text-cyan-300 border-cyan-500/40' },
  { id: 'qt-charger20w', title: 'Chargeur 20W Fast', category: 'Chargeurs', price: 1800, costPrice: 900, icon: '⚡', color: 'from-amber-500/20 to-yellow-500/20 text-amber-300 border-amber-500/40' },
  { id: 'qt-cablec', title: 'Câble Type-C Braided', category: 'Câbles', price: 600, costPrice: 250, icon: '🔌', color: 'from-emerald-500/20 to-teal-500/20 text-emerald-300 border-emerald-500/40' },
  { id: 'qt-cablelightning', title: 'Câble Type-C vers Lightning', category: 'Câbles', price: 800, costPrice: 350, icon: '⚡', color: 'from-purple-500/20 to-indigo-500/20 text-purple-300 border-purple-500/40' },
  { id: 'qt-flash', title: 'Flash & Formatage', category: 'Tous les produits', price: 1500, costPrice: 0, icon: '🔄', color: 'from-rose-500/20 to-pink-500/20 text-rose-300 border-rose-500/40' },
  { id: 'qt-deblocage', title: 'Déblocage FRP / Google', category: 'Tous les produits', price: 2500, costPrice: 0, icon: '🔓', color: 'from-orange-500/20 to-red-500/20 text-orange-300 border-orange-500/40' },
  { id: 'qt-clean', title: 'Nettoyage Connecteur', category: 'Tous les produits', price: 500, costPrice: 0, icon: '🧹', color: 'from-teal-500/20 to-cyan-500/20 text-teal-300 border-teal-500/40' },
  { id: 'qt-earphones', title: 'Écouteurs Filaire', category: 'Tous les produits', price: 600, costPrice: 250, icon: '🎧', color: 'from-violet-500/20 to-purple-500/20 text-violet-300 border-violet-500/40' },
];

/**
 * Compact Action Tile Component (Text-First, 70-85px height, Full-Tile Click Area)
 */
const ProductTile = React.memo(({ 
  product, 
  shortcutKey,
  pricingTier, 
  onAddToCart, 
  onEdit, 
  onOrderStock,
}: { 
  product: Product; 
  shortcutKey?: number;
  pricingTier: string; 
  onAddToCart: (p: Product) => void;
  onEdit: (p: Product) => void;
  onOrderStock: (p: Product) => void;
}) => {
  const activePrice = pricingTier === 'Wholesale' ? product.wholesalePrice || product.price * 0.75 : product.price;
  const isLowStock = product.stock <= (product.reorderPoint || 10) && product.stock > 0;
  const isOutOfStock = product.stock <= 0;

  return (
    <div
      onClick={() => onAddToCart(product)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onAddToCart(product);
        }
      }}
      className={`bg-pos-card border border-pos-border rounded-xl p-2.5 flex flex-col justify-between hover:border-emerald-500/60 hover:bg-pos-hover/60 transition-all duration-150 ease-out cursor-pointer group relative overflow-hidden shadow-sm active:scale-[0.98] active:border-emerald-500 min-h-[76px] select-none ${
        isOutOfStock 
          ? 'opacity-80 border-rose-500/40 bg-rose-950/10 hover:border-rose-500/60' 
          : isLowStock 
          ? 'border-amber-500/30' 
          : ''
      }`}
    >
      {/* Top Header: Brand/Compatibility Micro-Line, Shortcut Key & Micro Stock Indicator */}
      <div className="flex items-center justify-between gap-1.5 w-full">
        {/* Secondary Metadata Line (10-11px uppercase) */}
        <div className="flex items-center gap-1 min-w-0 flex-1">
          {shortcutKey && (
            <kbd className="shrink-0 px-1.5 py-0.2 text-[9px] font-mono font-black rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-xs" title={`Touche rapide: ${shortcutKey}`}>
              {shortcutKey}
            </kbd>
          )}
          <span className="text-[10px] md:text-[11px] font-bold text-pos-muted uppercase tracking-wider truncate">
            {product.brand} {product.compatibleModel ? `• ${product.compatibleModel}` : ''}
          </span>
          {product.isMagSafe && (
            <span className="shrink-0 text-cyan-400" title="Compatible MagSafe">
              <Zap className="w-2.5 h-2.5 fill-cyan-400" />
            </span>
          )}
        </div>

        {/* Micro Stock Status Badge */}
        <div className="shrink-0">
          {isOutOfStock ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-extrabold bg-rose-950/90 text-rose-300 border border-rose-800/80 shadow-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
              Rupture
            </span>
          ) : isLowStock ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-amber-950/80 text-amber-300 border border-amber-800/70 shadow-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              {product.stock} dispo
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-pos-bg/80 text-pos-muted border border-pos-border/70">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              {product.stock} dispo
            </span>
          )}
        </div>
      </div>

      {/* Middle: Product Name (13-14px semi-bold, max 2 lines with truncation) */}
      <h3 className="text-[13px] md:text-[14px] font-semibold text-pos-text leading-snug line-clamp-2 my-1 group-hover:text-emerald-400 transition-colors">
        {product.title}
      </h3>

      {/* Bottom Bar: Tabular Price & Discreet Quick Actions */}
      <div className="flex items-center justify-between w-full pt-1 border-t border-pos-border/40 mt-auto">
        {/* Tabular Price (14-15px bold font-mono) */}
        <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
          {pricingTier === 'Wholesale' && (
            <span className="text-[10px] text-amber-400/80 line-through font-bold">
              {formatDZD(product.price)}
            </span>
          )}
          <span className="text-[14px] md:text-[15px] font-bold text-emerald-400 tracking-tight">
            {formatDZD(activePrice)}
          </span>
        </div>

        {/* Hover Action Cluster (Edit / PO) */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          {(isLowStock || isOutOfStock) && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOrderStock(product);
              }}
              className="p-1 rounded-md bg-blue-600/20 text-blue-300 hover:bg-blue-600 hover:text-white border border-blue-500/30 transition cursor-pointer"
              title="Créer commande de réapprovisionnement (PO)"
            >
              <Truck className="w-3 h-3" />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(product);
            }}
            className="p-1 rounded-md bg-pos-bg hover:bg-emerald-500 hover:text-slate-950 text-pos-muted border border-pos-border transition cursor-pointer"
            title="Modifier le produit"
          >
            <Edit2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
});

/**
 * Dense Table List Row Component (Fast barcode & reference scanning)
 */
const ProductTableRow = React.memo(({ 
  product, 
  shortcutKey,
  pricingTier, 
  onAddToCart, 
  onEdit,
  onOrderStock,
}: { 
  product: Product; 
  shortcutKey?: number;
  pricingTier: string; 
  onAddToCart: (p: Product) => void;
  onEdit: (p: Product) => void;
  onOrderStock: (p: Product) => void;
}) => {
  const activePrice = pricingTier === 'Wholesale' ? product.wholesalePrice || product.price * 0.75 : product.price;
  const isLowStock = product.stock <= (product.reorderPoint || 10) && product.stock > 0;
  const isOutOfStock = product.stock <= 0;

  return (
    <tr
      onClick={() => onAddToCart(product)}
      className={`group border-b border-pos-border/50 hover:bg-pos-card/90 active:scale-[0.99] active:bg-emerald-500/10 cursor-pointer transition-all duration-100 select-none ${
        isOutOfStock ? 'opacity-75 bg-rose-950/5' : ''
      }`}
    >
      {/* SKU / Code-Barre */}
      <td className="py-2 px-3 text-xs font-mono text-pos-muted whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          {shortcutKey && (
            <kbd className="px-1.5 py-0.2 text-[9px] font-mono font-black rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-xs" title={`Touche rapide: ${shortcutKey}`}>
              {shortcutKey}
            </kbd>
          )}
          <span className="px-1.5 py-0.5 rounded bg-pos-bg border border-pos-border/60">
            {product.sku || product.barcode || '-'}
          </span>
        </div>
      </td>

      {/* Brand & Model */}
      <td className="py-2 px-3 text-xs whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          <span className="font-bold text-pos-text uppercase text-[11px]">{product.brand}</span>
          {product.compatibleModel && (
            <span className="text-[11px] text-pos-muted truncate max-w-[130px]">
              • {product.compatibleModel}
            </span>
          )}
          {product.isMagSafe && (
            <span className="shrink-0 text-cyan-400" title="Compatible MagSafe">
              <Zap className="w-2.5 h-2.5 fill-cyan-400" />
            </span>
          )}
        </div>
      </td>

      {/* Product Title */}
      <td className="py-2 px-3 text-xs font-semibold text-pos-text group-hover:text-emerald-400 transition-colors">
        <span className="line-clamp-1">{product.title}</span>
      </td>

      {/* Category */}
      <td className="py-2 px-3 text-xs text-pos-muted whitespace-nowrap hidden lg:table-cell">
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-pos-card border border-pos-border/40">
          {product.category}
        </span>
      </td>

      {/* Stock Status */}
      <td className="py-2 px-3 text-xs whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              isOutOfStock ? 'bg-rose-500 ring-2 ring-rose-500/20 animate-pulse' : isLowStock ? 'bg-amber-400' : 'bg-emerald-400'
            }`}
          />
          <span
            className={`font-mono text-xs font-bold ${
              isOutOfStock ? 'text-rose-400' : isLowStock ? 'text-amber-400' : 'text-pos-muted'
            }`}
          >
            {isOutOfStock ? 'Rupture' : `${product.stock} dispo`}
          </span>
        </div>
      </td>

      {/* Price (Tabular Numerals) */}
      <td className="py-2 px-3 text-right whitespace-nowrap">
        <div className="flex items-center justify-end gap-1.5 font-mono tabular-nums">
          {pricingTier === 'Wholesale' && (
            <span className="text-[10px] text-amber-400/80 line-through font-bold">
              {formatDZD(product.price)}
            </span>
          )}
          <span className="text-[13px] md:text-[14px] font-bold text-emerald-400">
            {formatDZD(activePrice)}
          </span>
        </div>
      </td>

      {/* Action Icons */}
      <td className="py-2 px-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          {(isLowStock || isOutOfStock) && (
            <button
              type="button"
              onClick={() => onOrderStock(product)}
              className="p-1 rounded bg-blue-500/10 hover:bg-blue-500 hover:text-white text-blue-400 border border-blue-500/30 transition cursor-pointer"
              title="Commander PO"
            >
              <Truck className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onEdit(product)}
            className="p-1 rounded bg-pos-card hover:bg-emerald-500 hover:text-slate-950 text-pos-muted border border-pos-border transition cursor-pointer"
            title="Modifier"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
});

export const ProductCatalog: React.FC = () => {
  const {
    products,
    selectedCategory,
    setSelectedCategory,
    searchQuery,
    sortOption,
    setSortOption,
    addToCart,
    setEditingProduct,
    pricingTier,
    openModal,
    activeModal,
  } = usePosStore();

  const [pinDialogState, setPinDialogState] = useState<{isOpen: boolean, product: Product | null}>({ isOpen: false, product: null });
  const [feedback, setFeedback] = useState<{message: string, type: 'success'|'error'} | null>(null);
  const [stockAlertOnly, setStockAlertOnly] = useState(false);
  const [selectedBrand, setSelectedBrand] = useState<'Tous' | BrandName>('Tous');
  const [magsafeOnly, setMagsafeOnly] = useState(false);
  const [showQuickTiles, setShowQuickTiles] = useState(true);
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  // Category counts map
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { 'Tous les produits': products.length };
    products.forEach((p) => {
      counts[p.category] = (counts[p.category] || 0) + 1;
    });
    return counts;
  }, [products]);

  // Memoized filter & sort of products
  const sortedProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = products.filter((product) => {
      const matchesCategory = selectedCategory === 'Tous les produits' || product.category === selectedCategory;
      const matchesStockAlert = !stockAlertOnly || product.stock <= (product.reorderPoint || 10);
      const matchesBrand = selectedBrand === 'Tous' || product.brand === selectedBrand;
      const matchesMagsafe = !magsafeOnly || product.isMagSafe === true;

      if (!matchesCategory || !matchesStockAlert || !matchesBrand || !matchesMagsafe) return false;
      if (!q) return true;
      return (
        product.title.toLowerCase().includes(q) ||
        product.sku.toLowerCase().includes(q) ||
        product.barcode.toLowerCase().includes(q) ||
        product.brand.toLowerCase().includes(q) ||
        product.compatibleModel.toLowerCase().includes(q)
      );
    });

    return [...filtered].sort((a, b) => {
      if (sortOption === 'name_asc') return a.title.localeCompare(b.title);
      if (sortOption === 'price_asc') return a.price - b.price;
      if (sortOption === 'price_desc') return b.price - a.price;
      if (sortOption === 'stock_desc') return b.stock - a.stock;
      if (sortOption === 'brand_asc') return a.brand.localeCompare(b.brand);
      return 0;
    });
  }, [products, selectedCategory, searchQuery, sortOption, stockAlertOnly, selectedBrand, magsafeOnly]);

  const showFeedback = (message: string, type: 'success' | 'error') => {
    setFeedback({ message, type });
    setTimeout(() => setFeedback(null), 3000);
  };

  const handleAddToCart = useCallback((product: Product) => {
    const result = addToCart(product);
    if (!result.success) {
      if (result.reason === 'STOCK_EMPTY') {
        setPinDialogState({ isOpen: true, product });
      } else {
        showFeedback("Erreur lors de l'ajout au panier", 'error');
      }
    }
  }, [addToCart]);

  // Hook for 1-9 quick hotkeys targeting top 9 visible products
  useCatalogHotkeys({
    products: sortedProducts,
    onAddToCart: handleAddToCart,
    disabled: activeModal !== null || pinDialogState.isOpen,
  });

  const handleQuickTileClick = (tile: QuickActionTile) => {
    const existing = products.find(
      (p) => p.title.toLowerCase() === tile.title.toLowerCase() || p.id === tile.id
    );
    if (existing) {
      handleAddToCart(existing);
      showFeedback(`+1 ${tile.title} ajouté au panier`, 'success');
    } else {
      const adHocProduct: Product = {
        id: tile.id,
        title: tile.title,
        price: tile.price,
        wholesalePrice: Math.round(tile.price * 0.8),
        costPrice: tile.costPrice,
        category: tile.category,
        brand: 'Autre',
        stock: 999,
        sku: tile.id.toUpperCase(),
        barcode: '',
        compatibleModel: 'Tous modèles',
        imageUrl: '',
        reorderPoint: 0,
        vendorName: 'Fournisseur Local',
        leadTimeDays: 1,
        dailySalesVelocity: 5,
      };
      addToCart(adHocProduct, true);
      showFeedback(`+1 ${tile.title} (${formatDZD(tile.price)}) ajouté`, 'success');
    }
  };

  const handleOrderStock = useCallback((product: Product) => {
    openModal('vendor_procurement');
    showFeedback(`Gestionnaire d'approvisionnement ouvert pour ${product.title}`, 'success');
  }, [openModal]);

  const handlePinSuccess = () => {
    if (pinDialogState.product) {
      addToCart(pinDialogState.product, true);
      setPinDialogState({ isOpen: false, product: null });
      showFeedback("Produit ajouté (Vente forcée autorisée)", 'success');
    }
  };

  return (
    <div className="flex-1 bg-pos-bg flex flex-col h-full overflow-hidden select-none transition-colors duration-200 relative">
      {/* Feedback Toast */}
      {feedback && (
        <div className={`absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full text-xs font-bold shadow-lg animate-in fade-in slide-in-from-top-4 ${
          feedback.type === 'success' ? 'bg-emerald-500 text-slate-950' : 'bg-rose-500 text-white'
        }`}>
          {feedback.message}
        </div>
      )}

      {/* Category Pills & Sorting / View Mode Toolbar */}
      <div className="p-3 border-b border-pos-border bg-pos-panel flex flex-col gap-2 z-10 relative shrink-0">
        {/* Categories & View Mode row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 max-w-[70vw] scrollbar-none">
            {CATEGORIES.map((cat) => {
              const count = categoryCounts[cat] || 0;
              return (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all flex items-center gap-1.5 cursor-pointer ${
                    selectedCategory === cat
                      ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                      : 'bg-pos-card text-pos-muted hover:text-pos-text border border-pos-border hover:border-emerald-500/40'
                  }`}
                >
                  <span>{cat}</span>
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-black ${
                    selectedCategory === cat ? 'bg-slate-950/20 text-slate-950' : 'bg-pos-bg text-pos-muted'
                  }`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Right Toolbar: Sort Dropdown & View Mode Segmented Control */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-bold text-pos-muted uppercase">Trier:</span>
            <select
              value={sortOption}
              onChange={(e) => setSortOption(e.target.value as SortOption)}
              className="bg-pos-card border border-pos-border rounded-lg px-2.5 py-1 text-xs text-pos-text font-bold focus:border-emerald-500 focus:outline-none cursor-pointer"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {/* Segmented Control (Grid vs. Dense Table List) */}
            <div className="flex items-center bg-pos-card rounded-lg border border-pos-border p-0.5 ml-1">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded-md transition cursor-pointer flex items-center gap-1 ${
                  viewMode === 'grid'
                    ? 'bg-emerald-500 text-slate-950 shadow-sm font-bold'
                    : 'text-pos-muted hover:text-pos-text'
                }`}
                title="Vue Grille (Tuiles compactes)"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={`p-1.5 rounded-md transition cursor-pointer flex items-center gap-1 ${
                  viewMode === 'table'
                    ? 'bg-emerald-500 text-slate-950 shadow-sm font-bold'
                    : 'text-pos-muted hover:text-pos-text'
                }`}
                title="Vue Tableau Dense (Code-barres & Référence rapide)"
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Secondary Filter Chips Row: Brands & MagSafe & Alerts */}
        <div className="flex items-center justify-between pt-1 border-t border-pos-border/40 text-xs">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            <span className="text-[10px] font-bold text-pos-muted uppercase mr-1">Marque:</span>
            {BRANDS.map((b) => (
              <button
                key={b.label}
                onClick={() => setSelectedBrand(b.value)}
                className={`px-2 py-0.5 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                  selectedBrand === b.value
                    ? 'bg-cyan-500/20 border border-cyan-500 text-cyan-300'
                    : 'bg-pos-bg border border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowQuickTiles(!showQuickTiles)}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 border cursor-pointer ${
                showQuickTiles
                  ? 'bg-amber-500/20 border-amber-500 text-amber-300 shadow-sm'
                  : 'bg-pos-card text-pos-muted border-pos-border hover:text-pos-text'
              }`}
              title="Afficher/masquer les touches rapides 1-clic"
            >
              <Zap className="w-3.5 h-3.5 fill-amber-400 text-amber-400" /> Touches Rapides
            </button>

            <button
              onClick={() => setMagsafeOnly(!magsafeOnly)}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 border cursor-pointer ${
                magsafeOnly
                  ? 'bg-cyan-500/20 border-cyan-500 text-cyan-300 shadow-sm'
                  : 'bg-pos-card text-pos-muted border-pos-border hover:text-pos-text'
              }`}
            >
              <Zap className="w-3.5 h-3.5" /> MagSafe
            </button>

            <button
              onClick={() => setStockAlertOnly(!stockAlertOnly)}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 border cursor-pointer ${
                stockAlertOnly
                  ? 'bg-rose-500 text-white border-rose-400 shadow-md'
                  : 'bg-pos-card text-pos-muted border-pos-border hover:text-pos-text'
              }`}
            >
              <AlertCircle className="w-3.5 h-3.5" /> Alertes Stock ({products.filter(p => p.stock <= (p.reorderPoint || 10)).length})
            </button>
          </div>
        </div>
      </div>

      {/* ═══ Quick-Action Favorites Tile Matrix ("Touches Rapides 1-Clic") ═══ */}
      {showQuickTiles && (
        <div className="px-3 py-2.5 bg-pos-panel/60 border-b border-pos-border shrink-0 animate-in fade-in slide-in-from-top-2">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
              <span className="text-[10px] font-black uppercase tracking-wider text-pos-text">
                Touches Rapides 1-Clic (Services & Best-Sellers Sans Code-Barre)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowQuickTiles(false)}
              className="text-[10px] text-pos-muted hover:text-pos-text transition cursor-pointer"
            >
              Masquer ✕
            </button>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
            {DEFAULT_QUICK_TILES.map((tile) => (
              <button
                key={tile.id}
                type="button"
                onClick={() => handleQuickTileClick(tile)}
                className={`p-2 rounded-xl bg-gradient-to-br ${tile.color} border hover:scale-[1.02] active:scale-95 transition-all text-left flex flex-col justify-between shadow-sm cursor-pointer min-h-[58px] group`}
              >
                <div className="flex items-center justify-between w-full">
                  <span className="text-sm">{tile.icon}</span>
                  <span className="text-[9px] font-mono font-black px-1 rounded bg-slate-950/40 text-pos-text">
                    {formatDZD(tile.price)}
                  </span>
                </div>
                <span className="text-[10px] font-black leading-tight text-pos-text line-clamp-1 group-hover:text-white mt-1">
                  {tile.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Product Catalog Display: High-Density Action Tile Matrix or Dense Table List */}
      <div className="flex-1 overflow-y-auto p-3.5">
        {sortedProducts.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-pos-muted space-y-2 py-12">
            <Search className="w-10 h-10 opacity-40 text-emerald-400" />
            <p className="text-sm font-extrabold text-pos-text">Aucun accessoire trouvé</p>
            <p className="text-xs">Essayez un autre mot-clé ou modifiez vos filtres de sélection.</p>
          </div>
        ) : viewMode === 'grid' ? (
          /* ═══ High-Density Compact Action Tiles (16-24 items visible without scroll) ═══ */
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-6 gap-2 sm:gap-2.5">
            {sortedProducts.map((product, index) => (
              <ProductTile
                key={product.id}
                product={product}
                shortcutKey={index < 9 ? index + 1 : undefined}
                pricingTier={pricingTier}
                onAddToCart={handleAddToCart}
                onEdit={setEditingProduct}
                onOrderStock={handleOrderStock}
              />
            ))}
          </div>
        ) : (
          /* ═══ Dense Table List View (For rapid barcode reference) ═══ */
          <div className="bg-pos-card border border-pos-border rounded-xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-pos-panel border-b border-pos-border text-[10px] uppercase font-black text-pos-muted tracking-wider">
                    <th className="py-2.5 px-3">Réf / SKU</th>
                    <th className="py-2.5 px-3">Marque & Modèle</th>
                    <th className="py-2.5 px-3">Désignation</th>
                    <th className="py-2.5 px-3 hidden lg:table-cell">Catégorie</th>
                    <th className="py-2.5 px-3">Disponibilité</th>
                    <th className="py-2.5 px-3 text-right">Prix Unitaire</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-pos-border/40">
                  {sortedProducts.map((product, index) => (
                    <ProductTableRow
                      key={product.id}
                      product={product}
                      shortcutKey={index < 9 ? index + 1 : undefined}
                      pricingTier={pricingTier}
                      onAddToCart={handleAddToCart}
                      onEdit={setEditingProduct}
                      onOrderStock={handleOrderStock}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <PinDialog
        isOpen={pinDialogState.isOpen}
        onCancel={() => setPinDialogState({ isOpen: false, product: null })}
        onSuccess={handlePinSuccess}
        title="Rupture de Stock"
        description={`Le produit "${pinDialogState.product?.title}" est en rupture. Entrez le code PIN manager pour forcer la vente.`}
      />
    </div>
  );
};

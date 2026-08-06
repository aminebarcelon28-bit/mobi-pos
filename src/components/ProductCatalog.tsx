import React, { useState, useCallback, useMemo } from 'react';
import { Search, Plus, Edit2, Zap, AlertTriangle, Package, AlertCircle } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { formatDZD } from '../types/pos';
import type { CategoryType, SortOption, Product } from '../types/pos';
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

const SORT_OPTIONS: { label: string; value: SortOption }[] = [
  { label: 'Nom (A-Z)', value: 'name_asc' },
  { label: 'Prix croissant', value: 'price_asc' },
  { label: 'Prix décroissant', value: 'price_desc' },
  { label: 'Stock élevé', value: 'stock_desc' },
  { label: 'Par Marque', value: 'brand_asc' },
];

const ProductCard = React.memo(({ 
  product, 
  pricingTier, 
  onAddToCart, 
  onEdit 
}: { 
  product: Product; 
  pricingTier: string; 
  onAddToCart: (p: Product) => void;
  onEdit: (p: Product) => void;
}) => {
  const [imgError, setImgError] = useState(false);

  const activePrice = pricingTier === 'Wholesale' ? product.wholesalePrice || product.price * 0.75 : product.price;
  const isLowStock = product.stock <= (product.reorderPoint || 10);
  const isOutOfStock = product.stock <= 0;

  return (
    <div
      onClick={() => onAddToCart(product)}
      className={`bg-pos-card border border-pos-border rounded-2xl p-3 flex flex-col justify-between hover:border-emerald-500/60 transition cursor-pointer group relative overflow-hidden shadow-sm hover:shadow-md ${
        isOutOfStock ? 'opacity-85 border-rose-500/40 bg-rose-950/10' : ''
      }`}
    >
      {/* Image & Badges */}
      <div className="relative aspect-square rounded-xl bg-pos-bg overflow-hidden mb-2.5 border border-pos-border/40 flex items-center justify-center">
        {!imgError ? (
          <img
            src={product.imageUrl}
            alt={product.title}
            loading="lazy"
            onError={() => setImgError(true)}
            className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-slate-900 to-slate-950 flex flex-col items-center justify-center p-3 text-center">
            <Package className="w-8 h-8 text-emerald-400/60 mb-1" />
            <span className="text-[10px] font-extrabold text-pos-muted uppercase tracking-wider line-clamp-1">{product.brand}</span>
          </div>
        )}

        {/* MagSafe Badge */}
        {product.isMagSafe && (
          <span className="absolute top-2 left-2 bg-slate-900/90 text-emerald-400 p-1 rounded-md border border-emerald-500/30 shadow">
            <Zap className="w-3 h-3 fill-emerald-400" />
          </span>
        )}

        {/* Stock Alert Badge */}
        <span
          className={`absolute top-2 right-2 text-[10px] font-extrabold px-2 py-0.5 rounded-md border shadow ${
            isOutOfStock
              ? 'bg-rose-950/95 text-rose-300 border-rose-800'
              : isLowStock
              ? 'bg-amber-950/95 text-amber-300 border-amber-800'
              : 'bg-slate-900/90 text-pos-muted border-pos-border'
          }`}
        >
          {isOutOfStock ? 'Rupture (PIN)' : `Stock: ${product.stock}`}
        </span>

        {/* Hover Quick Edit Button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit(product);
          }}
          className="absolute bottom-2 right-2 p-1.5 bg-black/90 hover:bg-emerald-500 text-white rounded-lg opacity-0 group-hover:opacity-100 transition duration-200 border border-white/20 shadow-md"
          title="Modifier Produit"
        >
          <Edit2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Details */}
      <div className="flex-1 flex flex-col justify-between">
        <div>
          <div className="flex justify-between items-start gap-1">
            <span className="text-[10px] uppercase font-extrabold text-pos-muted tracking-wider">
              {product.brand}
            </span>
            <span className="text-[9px] text-emerald-400 font-bold truncate max-w-[100px]">
              {product.compatibleModel}
            </span>
          </div>
          <h3 className="text-xs font-bold text-pos-text leading-snug line-clamp-2 mt-0.5">
            {product.title}
          </h3>
        </div>

        {/* Price & Add Action */}
        <div className="flex justify-between items-end mt-3 pt-2 border-t border-pos-border/40">
          <div>
            {pricingTier === 'Wholesale' && (
              <span className="text-[9px] text-amber-400 block line-through font-semibold">
                {formatDZD(product.price)}
              </span>
            )}
            <span className="text-sm font-black text-emerald-400 tracking-tight">
              {formatDZD(activePrice)}
            </span>
          </div>

          <button
            onClick={(e) => {
              e.stopPropagation();
              onAddToCart(product);
            }}
            className={`p-2 rounded-xl transition shadow-sm cursor-pointer ${
              isOutOfStock
                ? 'bg-rose-950 text-rose-400 hover:bg-rose-900 border border-rose-800'
                : 'bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/30'
            }`}
            title={isOutOfStock ? 'Vente Stock Épuisé (PIN Requis)' : 'Ajouter au Panier'}
          >
            {isOutOfStock ? <AlertTriangle className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
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
  } = usePosStore();

  const [pinDialogState, setPinDialogState] = useState<{isOpen: boolean, product: Product | null}>({ isOpen: false, product: null });
  const [feedback, setFeedback] = useState<{message: string, type: 'success'|'error'} | null>(null);
  const [stockAlertOnly, setStockAlertOnly] = useState(false);

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
      if (!matchesCategory || !matchesStockAlert) return false;
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
  }, [products, selectedCategory, searchQuery, sortOption, stockAlertOnly]);

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

  const handlePinSuccess = () => {
    if (pinDialogState.product) {
      addToCart(pinDialogState.product, true);
      setPinDialogState({ isOpen: false, product: null });
      showFeedback("Produit ajouté (Forcé)", 'success');
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

      {/* Category Pills & Sorting Toolbar */}
      <div className="p-3 border-b border-pos-border bg-pos-panel flex flex-wrap items-center justify-between gap-2 z-10 relative shrink-0">
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

        {/* Sorting Dropdown & Alert Toggle */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setStockAlertOnly(!stockAlertOnly)}
            className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 border ${
              stockAlertOnly
                ? 'bg-rose-500 text-white border-rose-400 shadow-md'
                : 'bg-pos-card text-pos-muted border-pos-border hover:text-pos-text'
            }`}
          >
            <AlertCircle className="w-3.5 h-3.5" /> Alertes Stock
          </button>

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
        </div>
      </div>

      {/* Product Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {sortedProducts.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-pos-muted space-y-2 py-12">
            <Search className="w-10 h-10 opacity-40 text-emerald-400" />
            <p className="text-sm font-extrabold text-pos-text">Aucun accessoire trouvé</p>
            <p className="text-xs">Essayez un autre mot-clé ou désactivez le filtre d'alerte stock.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5">
            {sortedProducts.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                pricingTier={pricingTier}
                onAddToCart={handleAddToCart}
                onEdit={setEditingProduct}
              />
            ))}
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


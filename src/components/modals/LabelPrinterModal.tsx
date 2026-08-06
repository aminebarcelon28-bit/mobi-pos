import React, { useState, useRef, useEffect, useMemo } from 'react';
import { X, Printer, Barcode, Search, Filter, Check, Tag, Sparkles, Sliders, Layers } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { CategoryType } from '../../types/pos';
import { renderBarcodeToCanvas } from '../../utils/barcodeGenerator';
import { resolvePrinterForDocument } from '../../utils/printerRoutingEngine';

type LabelSize = '50x25' | '60x40' | '100x50';

const CATEGORIES: CategoryType[] = [
  'Tous les produits',
  'Coques iPhone',
  'Coques Samsung',
  'Coques Google',
  'Chargeurs',
  'Câbles',
  'Protège-Écran',
];

export const LabelPrinterModal: React.FC = () => {
  const { activeModal, closeModal, products, receiptSettings } = usePosStore();
  const targetPrinter = resolvePrinterForDocument('label', receiptSettings.printerRouting);
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('Tous les produits');
  const [brandFilter, setBrandFilter] = useState<string>('Toutes les marques');
  const [labelQuantity, setLabelQuantity] = useState<number>(10);
  const [labelSize, setLabelSize] = useState<LabelSize>('50x25');

  // Label element toggles
  const [showStoreName, setShowStoreName] = useState<boolean>(true);
  const [showPrice, setShowPrice] = useState<boolean>(true);
  const [showModel, setShowModel] = useState<boolean>(true);

  const barcodeCanvasRef = useRef<HTMLCanvasElement>(null);

  // Extract unique brands for filtering
  const availableBrands = useMemo(() => {
    const brands = new Set(products.map(p => p.brand).filter(Boolean));
    return ['Toutes les marques', ...Array.from(brands)];
  }, [products]);

  // Filtered product list based on search, category, brand
  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      const matchesCategory = categoryFilter === 'Tous les produits' || p.category === categoryFilter;
      const matchesBrand = brandFilter === 'Toutes les marques' || p.brand === brandFilter;
      const matchesSearch =
        !q ||
        p.title.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q) ||
        p.brand.toLowerCase().includes(q) ||
        (p.compatibleModel && p.compatibleModel.toLowerCase().includes(q));

      return matchesCategory && matchesBrand && matchesSearch;
    });
  }, [products, searchQuery, categoryFilter, brandFilter]);

  // Auto-select first matching product if current selection is invalid
  useEffect(() => {
    if (activeModal === 'label_printer') {
      if (!selectedProductId && products.length > 0) {
        setSelectedProductId(products[0].id);
      }
    }
  }, [activeModal, products, selectedProductId]);

  const selectedProduct = products.find((p) => p.id === selectedProductId) || filteredProducts[0] || products[0];

  useEffect(() => {
    if (selectedProduct && selectedProduct.barcode && barcodeCanvasRef.current) {
      renderBarcodeToCanvas(barcodeCanvasRef.current, selectedProduct.barcode, 'code128', {
        height: labelSize === '100x50' ? 45 : labelSize === '60x40' ? 36 : 28,
        showText: false,
      });
    }
  }, [selectedProduct, labelSize, activeModal]);

  if (activeModal !== 'label_printer') return null;

  const handlePrintLabels = () => {
    window.print();
  };

  const getLabelDimensions = () => {
    switch (labelSize) {
      case '50x25':
        return 'w-[230px] h-[115px] p-2.5';
      case '60x40':
        return 'w-[280px] h-[175px] p-3.5';
      case '100x50':
        return 'w-[360px] h-[200px] p-4';
      default:
        return 'w-[230px] h-[115px] p-2.5';
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 text-emerald-400">
            <Barcode className="w-5 h-5" />
            <h2 className="text-base font-bold text-pos-text">
              Studio d'Impression d'Étiquettes Code-Barres & Prix
            </h2>
          </div>
          <button
            onClick={closeModal}
            className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body: Split into Left Selection Panel & Right Label Preview Studio */}
        <div className="flex-1 flex overflow-hidden divide-x divide-pos-border">
          
          {/* Left Panel: Search & Product Picker Grid */}
          <div className="w-7/12 flex flex-col p-4 space-y-3 overflow-hidden bg-pos-bg">
            
            {/* Search & Filter Toolbar */}
            <div className="space-y-2 shrink-0">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Rechercher produit, Réf, Code-barres, Modèle..."
                  className="w-full bg-pos-card border border-pos-border rounded-xl pl-9 pr-3 py-2 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs"
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Filters Dropdowns */}
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-1.5 bg-pos-card border border-pos-border rounded-lg px-2 py-1 text-xs">
                  <Filter className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="w-full bg-transparent text-pos-text text-xs font-medium focus:outline-none cursor-pointer"
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat} value={cat} className="bg-pos-card text-pos-text">
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-1.5 bg-pos-card border border-pos-border rounded-lg px-2 py-1 text-xs">
                  <Tag className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <select
                    value={brandFilter}
                    onChange={(e) => setBrandFilter(e.target.value)}
                    className="w-full bg-transparent text-pos-text text-xs font-medium focus:outline-none cursor-pointer"
                  >
                    {availableBrands.map((b) => (
                      <option key={b} value={b} className="bg-pos-card text-pos-text">
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Product Selection List */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {filteredProducts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-pos-muted py-8 text-center">
                  <Search className="w-8 h-8 opacity-40 mb-2" />
                  <p className="text-xs font-semibold">Aucun article ne correspond</p>
                  <p className="text-[10px]">Essayez de modifier votre recherche ou vos filtres.</p>
                </div>
              ) : (
                filteredProducts.map((p) => {
                  const isSelected = p.id === selectedProduct?.id;
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelectedProductId(p.id)}
                      className={`p-2.5 rounded-xl border transition cursor-pointer flex items-center justify-between gap-3 ${
                        isSelected
                          ? 'bg-emerald-500/10 border-emerald-500/80 shadow-sm'
                          : 'bg-pos-card border-pos-border hover:border-pos-hover hover:bg-pos-hover/40'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <img
                          src={p.imageUrl}
                          alt={p.title}
                          className="w-10 h-10 rounded-lg object-cover bg-pos-bg border border-pos-border shrink-0"
                        />
                        <div className="min-w-0">
                          <h4 className="text-xs font-bold text-pos-text truncate">{p.title}</h4>
                          <div className="flex items-center gap-2 text-[10px] text-pos-muted mt-0.5">
                            <span className="font-semibold text-emerald-400">{p.brand}</span>
                            <span>•</span>
                            <span>{p.compatibleModel}</span>
                            <span>•</span>
                            <span>SKU: {p.sku}</span>
                          </div>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <span className="text-xs font-black text-emerald-400 block">{formatDZD(p.price)}</span>
                        <span className="text-[9px] text-pos-muted">Stock: {p.stock}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Panel: Label Configuration & Live Studio Preview */}
          <div className="w-5/12 flex flex-col p-5 bg-pos-panel space-y-4 overflow-y-auto">
            
            {/* Format & Quantity Controls */}
            <div className="space-y-3 bg-pos-card border border-pos-border p-3.5 rounded-xl">
              <h3 className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                <Sliders className="w-4 h-4 text-emerald-400" /> Paramètres d'Impression
              </h3>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Taille Rouleau</label>
                  <select
                    value={labelSize}
                    onChange={(e) => setLabelSize(e.target.value as LabelSize)}
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                  >
                    <option value="50x25">50 × 25 mm (Standard)</option>
                    <option value="60x40">60 × 40 mm (Moyen)</option>
                    <option value="100x50">100 × 50 mm (Grand)</option>
                  </select>
                </div>

                <div>
                  <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Nombre d'Étiquettes</label>
                  <div className="flex gap-1.5 items-center">
                    <input
                      type="number"
                      min="1"
                      max="1000"
                      value={labelQuantity}
                      onChange={(e) => setLabelQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs font-black text-emerald-400 focus:border-emerald-400 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Preset Quantity Buttons */}
              <div className="flex items-center gap-1.5 pt-1">
                <span className="text-[10px] text-pos-muted font-semibold">Presets:</span>
                {[1, 5, 10, 20, 50, 100].map((qty) => (
                  <button
                    key={qty}
                    type="button"
                    onClick={() => setLabelQuantity(qty)}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold border transition ${
                      labelQuantity === qty
                        ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                        : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                    }`}
                  >
                    {qty}
                  </button>
                ))}
              </div>
            </div>

            {/* Element Display Toggles */}
            <div className="bg-pos-card border border-pos-border p-3.5 rounded-xl space-y-2">
              <h3 className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-cyan-400" /> Éléments sur l'Étiquette
              </h3>
              
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setShowStoreName(!showStoreName)}
                  className={`p-1.5 rounded-lg border text-[10px] font-bold transition flex items-center justify-center gap-1 ${
                    showStoreName ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'bg-pos-bg border-pos-border text-pos-muted'
                  }`}
                >
                  {showStoreName && <Check className="w-3 h-3" />} Magasin
                </button>

                <button
                  type="button"
                  onClick={() => setShowPrice(!showPrice)}
                  className={`p-1.5 rounded-lg border text-[10px] font-bold transition flex items-center justify-center gap-1 ${
                    showPrice ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'bg-pos-bg border-pos-border text-pos-muted'
                  }`}
                >
                  {showPrice && <Check className="w-3 h-3" />} Prix DA
                </button>

                <button
                  type="button"
                  onClick={() => setShowModel(!showModel)}
                  className={`p-1.5 rounded-lg border text-[10px] font-bold transition flex items-center justify-center gap-1 ${
                    showModel ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'bg-pos-bg border-pos-border text-pos-muted'
                  }`}
                >
                  {showModel && <Check className="w-3 h-3" />} Modèle
                </button>
              </div>
            </div>

            {/* Live Studio Tag Preview Box */}
            <div className="flex-1 bg-slate-950 p-4 rounded-xl border border-pos-border flex flex-col items-center justify-center relative overflow-hidden min-h-[220px]">
              <span className="absolute top-2 left-2 text-[9px] font-bold text-pos-muted uppercase tracking-wider flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-emerald-400" /> Aperçu Étiquette Thermique
              </span>

              {selectedProduct ? (
                <div data-printable="true" className={`printable-area print:w-full bg-white text-black shadow-2xl rounded flex flex-col justify-between border border-gray-300 font-sans transition-all ${getLabelDimensions()}`}>
                  {/* Header */}
                  <div className="flex justify-between items-start">
                    {showStoreName ? (
                      <span className="text-[9px] font-extrabold uppercase tracking-wider text-gray-800 truncate max-w-[140px]">
                        {receiptSettings.storeName || 'ACCESSOIRES MOBI'}
                      </span>
                    ) : <span />}
                    <span className="text-[8px] font-bold text-gray-700 bg-gray-200 px-1 rounded">
                      {selectedProduct.brand}
                    </span>
                  </div>

                  {/* Title & Compatible Model */}
                  <div className="my-1 flex-1">
                    <p className="text-[10px] font-bold leading-tight text-gray-900 line-clamp-2">
                      {selectedProduct.title}
                    </p>
                    {showModel && selectedProduct.compatibleModel && (
                      <p className="text-[8px] text-gray-600 mt-0.5">Comp: {selectedProduct.compatibleModel}</p>
                    )}
                  </div>

                  {/* Price */}
                  {showPrice && (
                    <div className="text-right my-0.5">
                      <span className="text-sm font-black text-black tracking-tight">
                        {formatDZD(selectedProduct.price)}
                      </span>
                    </div>
                  )}

                  {/* Barcode Canvas */}
                  <div className="text-center pt-1 border-t border-gray-300 flex flex-col items-center">
                    <canvas ref={barcodeCanvasRef} className="max-w-full mix-blend-multiply" />
                    <div className="flex justify-between w-full text-[7px] font-mono text-gray-700 mt-0.5">
                      <span>SKU: {selectedProduct.sku}</span>
                      <span>EAN: {selectedProduct.barcode}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-pos-muted">Aucun produit sélectionné</p>
              )}
            </div>

          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex justify-between items-center shrink-0">
          <div className="text-xs text-pos-muted flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>
              Impression Étiquettes : <strong className="text-pos-text">{labelQuantity}× {selectedProduct?.title || 'Étiquette'}</strong> ({labelSize} mm) — <span className="text-emerald-400 font-bold">⚡ Routé vers : {targetPrinter.printerName}</span>
            </span>
          </div>

          <div className="flex gap-2">
            <button
              onClick={closeModal}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition-colors"
            >
              Annuler
            </button>
            <button
              onClick={handlePrintLabels}
              className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/20 transition-all cursor-pointer"
            >
              <Printer className="w-4 h-4" /> Imprimer Étiquettes ({labelQuantity})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};


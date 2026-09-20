import React, { useState, useMemo } from 'react';
import { Smartphone, X, ShieldCheck, Plus, Package } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';

export const CompatibilityModal: React.FC = () => {
  const { activeModal, closeModal, products, addToCart } = usePosStore();
  const [selectedBrand, setSelectedBrand] = useState<string>('Apple');
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const BRANDS = ['Apple', 'Samsung', 'Xiaomi', 'Oppo', 'Google'];

  const modelsForBrand = useMemo(() => {
    const models = new Set<string>();
    products.forEach(p => {
      if ((p.brand === selectedBrand || p.title.includes(selectedBrand)) && p.compatibleModel && p.compatibleModel !== 'Universel' && p.compatibleModel !== 'N/A') {
        models.add(p.compatibleModel);
      }
    });
    return Array.from(models).sort();
  }, [products, selectedBrand]);

  const matchingProducts = useMemo(() => {
    if (!selectedModel) return [];
    return products.filter(p => 
      (p.compatibleModel === selectedModel || p.title.includes(selectedModel)) 
      && p.stock > 0
    );
  }, [products, selectedModel]);

  if (activeModal !== 'compatibility') return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none">
      <div className="bg-pos-panel border border-emerald-500/50 rounded-t-3xl sm:rounded-2xl w-full max-w-4xl h-[94vh] sm:h-[85vh] flex flex-col overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:zoom-in-95">
        {/* Mobile drag handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />
        
        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-emerald-950/20 shrink-0 gap-2">
          <div className="flex items-center gap-2 text-emerald-400 min-w-0">
            <Smartphone className="w-5 h-5 shrink-0" />
            <h2 className="text-xs sm:text-lg font-bold text-white tracking-wide truncate">Compatibilité Accessoires</h2>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-white rounded-xl transition cursor-pointer min-h-[38px] min-w-[38px] flex items-center justify-center shrink-0"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar: Brands & Models */}
          <div className={`bg-pos-card border-r border-pos-border flex flex-col h-full ${selectedModel ? 'hidden sm:flex sm:w-1/3' : 'w-full sm:w-1/3'}`}>
            <div className="p-3 sm:p-4 border-b border-pos-border bg-pos-bg/50">
              <span className="text-xs font-bold text-pos-muted uppercase tracking-wider mb-2 block">1. Marque</span>
              <div className="flex flex-wrap gap-1.5 sm:gap-2">
                {BRANDS.map(brand => (
                  <button
                    key={brand}
                    onClick={() => { setSelectedBrand(brand); setSelectedModel(null); }}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition border min-h-[36px] active:scale-95 cursor-pointer ${
                      selectedBrand === brand
                        ? 'bg-emerald-500 text-slate-950 border-emerald-500 shadow-md shadow-emerald-500/20 font-black'
                        : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text hover:border-pos-text'
                    }`}
                  >
                    {brand}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-3 sm:p-4 flex-1 overflow-y-auto hide-scrollbar space-y-2">
              <span className="text-xs font-bold text-pos-muted uppercase tracking-wider mb-2 block">2. Modèle</span>
              {modelsForBrand.length === 0 ? (
                <p className="text-xs text-pos-muted italic py-4">Aucun modèle spécifique répertorié</p>
              ) : (
                modelsForBrand.map(model => (
                  <button
                    key={model}
                    onClick={() => setSelectedModel(model)}
                    className={`w-full text-left px-4 py-3 rounded-xl text-xs sm:text-sm font-semibold transition border min-h-[44px] cursor-pointer active:scale-98 ${
                      selectedModel === model
                        ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400 font-bold'
                        : 'bg-pos-bg border-pos-border/50 text-pos-text hover:border-emerald-500/30'
                    }`}
                  >
                    {model}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Main: Matching Accessories */}
          <div className={`flex-1 bg-pos-bg flex flex-col ${!selectedModel ? 'hidden sm:flex' : 'flex'}`}>
            <div className="p-3 sm:p-4 border-b border-pos-border bg-pos-panel/50">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-pos-muted uppercase tracking-wider">3. Accessoires Compatibles</span>
                {selectedModel && (
                  <button
                    type="button"
                    onClick={() => setSelectedModel(null)}
                    className="sm:hidden text-xs font-bold text-cyan-400 px-2.5 py-1 rounded-lg bg-pos-card border border-pos-border cursor-pointer min-h-[34px]"
                  >
                    Changer Modèle
                  </button>
                )}
              </div>
              {selectedModel && (
                <h3 className="text-sm sm:text-lg font-bold text-white mt-1">
                  Accessoires pour <span className="text-emerald-400">{selectedModel}</span>
                </h3>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3">
              {!selectedModel ? (
                <div className="h-full flex flex-col items-center justify-center text-pos-muted">
                  <Smartphone className="w-12 h-12 opacity-20 mb-3" />
                  <p className="text-sm">Sélectionnez un modèle pour voir les accessoires garantis compatibles.</p>
                </div>
              ) : matchingProducts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-pos-muted">
                  <Package className="w-12 h-12 opacity-20 mb-3" />
                  <p className="text-sm">Aucun accessoire en stock pour ce modèle.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {matchingProducts.map(prod => (
                    <div key={prod.id} className="bg-pos-card border border-pos-border rounded-xl p-3 flex gap-3 hover:border-emerald-500/30 transition group">
                      <div className="w-16 h-16 rounded-lg bg-pos-bg border border-pos-border flex items-center justify-center shrink-0 text-emerald-400">
                        <Package className="w-8 h-8" />
                      </div>
                      <div className="flex-1 flex flex-col justify-between min-w-0">
                        <div>
                          <p className="text-xs font-semibold text-pos-text leading-tight line-clamp-2" title={prod.title}>
                            {prod.title}
                          </p>
                          <span className="text-[10px] text-emerald-500 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded inline-block mt-1">
                            En stock: {prod.stock}
                          </span>
                        </div>
                        <div className="flex items-end justify-between mt-2">
                          <span className="text-sm font-black text-white">{formatDZD(prod.price)}</span>
                          <button
                            onClick={() => addToCart(prod)}
                            className="bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg p-1.5 shadow-md transition transform active:scale-95"
                            title="Ajouter au panier"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-pos-border bg-pos-panel flex justify-between items-center">
          <div className="flex items-center gap-2 text-pos-muted text-xs">
            <ShieldCheck className="w-4 h-4 text-emerald-500" /> 
            Garantie d'adaptation parfaite
          </div>
          <button
            onClick={closeModal}
            className="px-6 py-2.5 bg-pos-card hover:bg-pos-hover text-white font-bold rounded-xl text-sm transition"
          >
            Fermer l'Assistant
          </button>
        </div>
      </div>
    </div>
  );
};

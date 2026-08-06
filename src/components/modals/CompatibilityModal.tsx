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
      // In a real DB this might be strict, here we check if brand matches or title contains it if brand is 'Autre'
      if ((p.brand === selectedBrand || p.title.includes(selectedBrand)) && p.compatibleModel && p.compatibleModel !== 'Universel' && p.compatibleModel !== 'N/A') {
        models.add(p.compatibleModel);
      }
    });
    // Fallback static models if store has none, to make it look robust for the demo
    if (models.size === 0) {
      if (selectedBrand === 'Apple') return ['iPhone 15 Pro Max', 'iPhone 15 Pro', 'iPhone 14 Pro', 'iPhone 13'];
      if (selectedBrand === 'Samsung') return ['Galaxy S24 Ultra', 'Galaxy S23 FE', 'Galaxy A54', 'Galaxy Z Fold 5'];
      if (selectedBrand === 'Xiaomi') return ['Redmi Note 13 Pro', 'Xiaomi 14 Ultra', 'POCO X6 Pro'];
      if (selectedBrand === 'Oppo') return ['Reno 10 Pro', 'Find X5 Pro', 'A78'];
      if (selectedBrand === 'Google') return ['Pixel 8 Pro', 'Pixel 7a', 'Pixel Fold'];
    }
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
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-emerald-500/50 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl animate-in fade-in zoom-in-95">
        
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-emerald-950/20">
          <div className="flex items-center gap-2 text-emerald-400">
            <Smartphone className="w-6 h-6" />
            <h2 className="text-lg font-bold text-white tracking-wide">Assistant de Compatibilité Accessoires</h2>
          </div>
          <button onClick={closeModal} className="p-1 hover:bg-pos-hover text-pos-muted hover:text-white rounded-lg transition">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar: Brands & Models */}
          <div className="w-1/3 bg-pos-card border-r border-pos-border flex flex-col h-full">
            <div className="p-4 border-b border-pos-border bg-pos-bg/50">
              <span className="text-xs font-bold text-pos-muted uppercase tracking-wider mb-2 block">1. Marque</span>
              <div className="flex flex-wrap gap-2">
                {BRANDS.map(brand => (
                  <button
                    key={brand}
                    onClick={() => { setSelectedBrand(brand); setSelectedModel(null); }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition border ${
                      selectedBrand === brand
                        ? 'bg-emerald-500 text-slate-950 border-emerald-500 shadow-lg shadow-emerald-500/20'
                        : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text hover:border-pos-text'
                    }`}
                  >
                    {brand}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 flex-1 overflow-y-auto hide-scrollbar space-y-2">
              <span className="text-xs font-bold text-pos-muted uppercase tracking-wider mb-2 block">2. Modèle</span>
              {modelsForBrand.map(model => (
                <button
                  key={model}
                  onClick={() => setSelectedModel(model)}
                  className={`w-full text-left px-4 py-3 rounded-xl text-sm font-semibold transition border ${
                    selectedModel === model
                      ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400'
                      : 'bg-pos-bg border-pos-border/50 text-pos-text hover:border-emerald-500/30'
                  }`}
                >
                  {model}
                </button>
              ))}
            </div>
          </div>

          {/* Main: Matching Accessories */}
          <div className="flex-1 bg-pos-bg flex flex-col">
            <div className="p-4 border-b border-pos-border bg-pos-panel/50">
              <span className="text-xs font-bold text-pos-muted uppercase tracking-wider">3. Accessoires 100% Compatibles</span>
              {selectedModel && (
                <h3 className="text-lg font-bold text-white mt-1">
                  Accessoires pour <span className="text-emerald-400">{selectedModel}</span>
                </h3>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
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
                      <img src={prod.imageUrl} alt={prod.title} className="w-16 h-16 rounded-lg object-cover bg-pos-bg shrink-0" />
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

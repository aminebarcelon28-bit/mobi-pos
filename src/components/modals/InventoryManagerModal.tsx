import React, { useState } from 'react';
import { X, Search, Plus, Edit2, Trash2, Package, ChevronLeft } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';

export const InventoryManagerModal: React.FC = () => {
  const { activeModal, closeModal, products, setEditingProduct, deleteProduct } = usePosStore();
  const [managerSearch, setManagerSearch] = useState('');

  if (activeModal !== 'inventory_manager') return null;

  const filtered = products.filter(
    (p) =>
      p.title.toLowerCase().includes(managerSearch.toLowerCase()) ||
      p.sku.toLowerCase().includes(managerSearch.toLowerCase()) ||
      p.brand.toLowerCase().includes(managerSearch.toLowerCase()) ||
      p.compatibleModel.toLowerCase().includes(managerSearch.toLowerCase())
  );

  return (
    <div
      onClick={closeModal}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-0 sm:p-4 select-none cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border-0 sm:border border-pos-border rounded-none sm:rounded-2xl w-full sm:max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-full sm:h-[85vh] flex flex-col cursor-default font-sans"
      >
        {/* Header */}
        <div className="p-3 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            {/* Back button for mobile */}
            <button
              type="button"
              onClick={closeModal}
              className="sm:hidden p-1.5 rounded-lg bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text active:scale-95 transition"
              title="Retour"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>

            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <Package className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-sm font-bold text-pos-text truncate">
                Gestionnaire de Stock ({products.length} Articles)
              </h2>
              <p className="text-[10px] text-pos-muted truncate hidden sm:block">
                Gestion du stock à fort volume, modification et suivi des marges
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setEditingProduct(null)}
              className="px-3 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-md shadow-emerald-500/20 active:scale-95 transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Nouveau Produit</span>
              <span className="sm:hidden">Ajouter</span>
            </button>
            <button
              type="button"
              onClick={closeModal}
              className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer"
              title="Fermer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Real-Time Inventory Valuation & Profit Audit Banner (2x2 on mobile, 4 cols on desktop) */}
        <div className="p-2 sm:p-3 bg-pos-card/60 border-b border-pos-border grid grid-cols-2 lg:grid-cols-4 gap-2 shrink-0">
          <div className="bg-pos-bg border border-pos-border p-2 sm:p-2.5 rounded-xl">
            <span className="text-[8px] sm:text-[9px] font-bold uppercase text-pos-muted block truncate">
              Valeur Stock au Coût
            </span>
            <p className="text-xs sm:text-sm font-black font-mono text-pos-text mt-0.5 truncate">
              {formatDZD((products || []).reduce((sum, p) => sum + (p.stock || 0) * (p.costPrice || 0), 0))}
            </p>
          </div>

          <div className="bg-pos-bg border border-pos-border p-2 sm:p-2.5 rounded-xl">
            <span className="text-[8px] sm:text-[9px] font-bold uppercase text-pos-muted block truncate">
              Valeur Marchande
            </span>
            <p className="text-xs sm:text-sm font-black font-mono text-emerald-400 mt-0.5 truncate">
              {formatDZD((products || []).reduce((sum, p) => sum + (p.stock || 0) * p.price, 0))}
            </p>
          </div>

          <div className="bg-pos-bg border border-pos-border p-2 sm:p-2.5 rounded-xl">
            <span className="text-[8px] sm:text-[9px] font-bold uppercase text-pos-muted block truncate">
              Marge Latente
            </span>
            <p className="text-xs sm:text-sm font-black font-mono text-cyan-400 mt-0.5 truncate">
              {formatDZD(
                (products || []).reduce((sum, p) => sum + (p.stock || 0) * (p.price - (p.costPrice || 0)), 0)
              )}
            </p>
          </div>

          <div className="bg-pos-bg border border-pos-border p-2 sm:p-2.5 rounded-xl">
            <span className="text-[8px] sm:text-[9px] font-bold uppercase text-pos-muted block truncate">
              Volume Pièces
            </span>
            <p className="text-xs sm:text-sm font-black font-mono text-amber-400 mt-0.5 truncate">
              {(products || []).reduce((sum, p) => sum + (p.stock || 0), 0)} un. ({(products || []).length} réf.)
            </p>
          </div>
        </div>

        {/* Toolbar & Filter Bar */}
        <div className="p-2.5 sm:p-3 border-b border-pos-border bg-pos-bg flex items-center justify-between gap-2.5 shrink-0">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
            <input
              type="text"
              value={managerSearch}
              onChange={(e) => setManagerSearch(e.target.value)}
              placeholder="Rechercher Titre, SKU, Marque..."
              className="w-full bg-pos-card border border-pos-border rounded-xl pl-8 pr-3 py-1.5 text-xs text-pos-text placeholder-pos-muted focus:outline-none focus:border-emerald-400"
            />
            {managerSearch && (
              <button
                type="button"
                onClick={() => setManagerSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs p-0.5"
              >
                ✕
              </button>
            )}
          </div>
          <span className="text-[11px] text-pos-muted shrink-0 whitespace-nowrap">
            <strong className="text-pos-text font-mono">{filtered.length}</strong> / {products.length}
          </span>
        </div>

        {/* Product Items: Mobile Cards View (md:hidden) */}
        <div className="md:hidden flex-1 overflow-y-auto p-2.5 space-y-2 bg-pos-bg">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-pos-muted space-y-2">
              <Package className="w-10 h-10 mx-auto opacity-30" />
              <p className="text-xs">Aucun article ne correspond à votre recherche.</p>
            </div>
          ) : (
            filtered.map((product) => (
              <div
                key={product.id}
                className="bg-pos-card border border-pos-border rounded-xl p-3 shadow-sm flex flex-col gap-2 transition active:border-emerald-500/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-pos-panel border border-pos-border flex items-center justify-center shrink-0 text-emerald-400">
                      <Package className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-bold text-xs text-pos-text truncate">{product.title}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[10px] font-mono text-pos-muted bg-pos-panel px-1.5 py-0.2 rounded border border-pos-border/60">
                          {product.sku}
                        </span>
                        {product.brand && (
                          <span className="text-[10px] text-pos-muted font-medium truncate">
                            {product.brand}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Stock Badge */}
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono shrink-0 ${
                      product.stock <= 5
                        ? 'bg-red-500/15 text-red-400 border border-red-500/30'
                        : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                    }`}
                  >
                    {product.stock} un.
                  </span>
                </div>

                {/* Card Bottom Row: Price & Actions */}
                <div className="flex items-center justify-between pt-1 border-t border-pos-border/40">
                  <div>
                    <span className="text-[9px] uppercase font-bold text-pos-muted block">Prix de Vente</span>
                    <span className="text-sm font-black text-emerald-400 font-mono">
                      {formatDZD(product.price)}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setEditingProduct(product)}
                      className="p-2 rounded-lg bg-pos-panel hover:bg-emerald-500/20 text-pos-muted hover:text-emerald-400 border border-pos-border active:scale-95 transition cursor-pointer"
                      title="Modifier Produit"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`Supprimer ${product.title} ?`)) deleteProduct(product.id);
                      }}
                      className="p-2 rounded-lg bg-pos-panel hover:bg-red-500/20 text-pos-muted hover:text-red-400 border border-pos-border active:scale-95 transition cursor-pointer"
                      title="Supprimer Produit"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Product Items: Desktop Table View (hidden md:block) */}
        <div className="hidden md:block flex-1 overflow-y-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-pos-card border-b border-pos-border text-pos-muted sticky top-0 uppercase tracking-wider text-[10px]">
              <tr>
                <th className="p-3">Produit</th>
                <th className="p-3">Réf / SKU</th>
                <th className="p-3">Marque</th>
                <th className="p-3">Modèle Compatible</th>
                <th className="p-3 text-right">Prix (DA)</th>
                <th className="p-3 text-center">Stock</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-pos-border/40">
              {filtered.map((product) => (
                <tr key={product.id} className="hover:bg-pos-hover/50 transition group">
                  <td className="p-3 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-pos-card border border-pos-border flex items-center justify-center shrink-0 text-emerald-400">
                      <Package className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-bold text-pos-text line-clamp-1">{product.title}</p>
                      <span className="text-[10px] text-pos-muted">{product.category}</span>
                    </div>
                  </td>

                  <td className="p-3 font-mono text-[11px] text-pos-muted">{product.sku}</td>

                  <td className="p-3">
                    <span className="font-semibold text-pos-text">{product.brand}</span>
                  </td>

                  <td className="p-3 text-pos-muted">{product.compatibleModel}</td>

                  <td className="p-3 text-right font-bold text-emerald-400">{formatDZD(product.price)}</td>

                  <td className="p-3 text-center">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        product.stock <= 5
                          ? 'bg-red-950 text-red-300 border border-red-800'
                          : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                      }`}
                    >
                      {product.stock} un.
                    </span>
                  </td>

                  <td className="p-3 text-right space-x-1">
                    <button
                      type="button"
                      onClick={() => setEditingProduct(product)}
                      className="p-1.5 hover:bg-emerald-500/20 text-pos-muted hover:text-emerald-400 rounded-lg transition"
                      title="Modifier Produit"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`Supprimer ${product.title} ?`)) deleteProduct(product.id);
                      }}
                      className="p-1.5 hover:bg-red-500/20 text-pos-muted hover:text-red-400 rounded-lg transition"
                      title="Supprimer Produit"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="p-2.5 sm:p-3 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
          <span className="text-[11px]">MobiPOS Stock • {products.length} articles au catalogue</span>
          <button
            type="button"
            onClick={closeModal}
            className="px-4 py-1.5 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border text-pos-text font-bold active:scale-95 transition cursor-pointer"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};

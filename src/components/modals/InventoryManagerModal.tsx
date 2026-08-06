import React, { useState } from 'react';
import { X, Search, Plus, Edit2, Trash2, Package } from 'lucide-react';
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
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[85vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-pos-text">Gestionnaire de Stock & Catalogue Produits ({products.length} Articles)</h2>
              <p className="text-[10px] text-pos-muted">Gestion du stock à fort volume, modification et ajouts d'images</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditingProduct(null)}
              className="px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition"
            >
              <Plus className="w-4 h-4" /> Nouveau Produit
            </button>
            <button onClick={closeModal} className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toolbar & Filter Bar */}
        <div className="p-3 border-b border-pos-border bg-pos-bg flex items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
            <input
              type="text"
              value={managerSearch}
              onChange={(e) => setManagerSearch(e.target.value)}
              placeholder="Rechercher par Titre, SKU, Marque, Modèle..."
              className="w-full bg-pos-card border border-pos-border rounded-lg pl-9 pr-3 py-1.5 text-xs text-pos-text placeholder-pos-muted focus:outline-none focus:border-emerald-400"
            />
          </div>
          <span className="text-xs text-pos-muted">Affichage: <strong className="text-pos-text">{filtered.length}</strong> / {products.length} articles</span>
        </div>

        {/* Inventory Data Table */}
        <div className="flex-1 overflow-y-auto">
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
                    <img
                      src={product.imageUrl}
                      alt={product.title}
                      className="w-10 h-10 rounded-lg object-cover bg-pos-card border border-pos-border shrink-0"
                    />
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
                      onClick={() => setEditingProduct(product)}
                      className="p-1.5 hover:bg-emerald-500/20 text-pos-muted hover:text-emerald-400 rounded-lg transition"
                      title="Modifier Produit"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
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
        <div className="p-3 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted">
          <span>Gestionnaire de Stock MOBI POS v1.0</span>
          <button onClick={closeModal} className="px-4 py-1.5 rounded-lg bg-pos-hover text-pos-text font-semibold">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};

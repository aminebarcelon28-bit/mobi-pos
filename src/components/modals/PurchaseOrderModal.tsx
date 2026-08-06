import React, { useState } from 'react';
import { X, FileText, CheckCircle2, Printer, Smartphone } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { useToast } from '../ui/Toast';

export const PurchaseOrderModal: React.FC = () => {
  const { activeModal, closeModal, activeDraftPO, approvePurchaseOrder } = usePosStore();
  const { showToast } = useToast();
  
  const [imeis, setImeis] = useState<Record<string, string>>({});
  const [isApproved, setIsApproved] = useState(false);

  if (activeModal !== 'purchase_order' || !activeDraftPO) return null;

  const handleApprove = () => {
    approvePurchaseOrder(activeDraftPO.id);
    setIsApproved(true);
    showToast(`Bon de commande ${activeDraftPO.poNumber} approuvé ! Le stock a été incrémenté.`, 'success');
    
    // Close modal after a short delay
    setTimeout(() => {
      closeModal();
      setIsApproved(false);
      setImeis({});
    }, 2000);
  };

  const handlePrintPO = () => {
    // Replaced native window.print() with a toast/inline action as requested
    showToast("Impression du Bon de Commande lancée...", 'info');
  };

  const handleImeiChange = (productId: string, value: string) => {
    setImeis(prev => ({ ...prev, [productId]: value }));
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-pos-text">Bon de Commande Fournisseur #{activeDraftPO.poNumber}</h2>
              <p className="text-[10px] text-pos-muted">Fournisseur: {activeDraftPO.vendorName} • Date: {activeDraftPO.createdAt}</p>
            </div>
          </div>
          <button onClick={closeModal} className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Inline Success Message */}
        {isApproved && (
          <div className="bg-emerald-500/10 border-b border-emerald-500/20 p-3 flex items-center gap-2 text-emerald-400 text-sm font-semibold justify-center">
            <CheckCircle2 className="w-5 h-5" />
            Stock mis à jour avec succès. Fermeture du bon de commande...
          </div>
        )}

        {/* PO Line Items Table */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-pos-card text-pos-muted text-[10px] uppercase font-bold border-b border-pos-border">
              <tr>
                <th className="p-3">Désignation Produit</th>
                <th className="p-3">SKU</th>
                <th className="p-3 text-center">Stock Actuel</th>
                <th className="p-3 text-center">Qté Commandée</th>
                <th className="p-3">IMEI / Numéro de Série (optionnel)</th>
                <th className="p-3 text-right">Prix Achat Cost (DA)</th>
                <th className="p-3 text-right">Total Ligne (DA)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-pos-border/40">
              {activeDraftPO.items.map((item) => (
                <tr key={item.productId} className="hover:bg-pos-hover/50 transition-colors">
                  <td className="p-3 font-semibold text-pos-text">{item.title}</td>
                  <td className="p-3 font-mono text-pos-muted text-[11px]">{item.sku}</td>
                  <td className="p-3 text-center text-amber-400 font-bold">{item.currentStock} un.</td>
                  <td className="p-3 text-center font-bold text-emerald-400">{item.suggestedQty} un.</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2 bg-pos-bg border border-pos-border rounded-lg px-2 py-1.5 focus-within:border-emerald-500 transition-colors">
                      <Smartphone className="w-4 h-4 text-pos-muted" />
                      <input 
                        type="text" 
                        placeholder="Saisir IMEI..." 
                        value={imeis[item.productId] || ''}
                        onChange={(e) => handleImeiChange(item.productId, e.target.value)}
                        className="bg-transparent border-none outline-none text-pos-text text-xs w-full placeholder:text-pos-muted/50"
                        disabled={isApproved}
                      />
                    </div>
                  </td>
                  <td className="p-3 text-right text-pos-muted">{formatDZD(item.unitCost)}</td>
                  <td className="p-3 text-right font-bold text-pos-text">{formatDZD(item.totalCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Financial Footer & Approval Action */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex justify-between items-center">
          <div>
            <span className="text-xs text-pos-muted">Montant Total du Bon de Commande:</span>
            <p className="text-xl font-black text-emerald-400">{formatDZD(activeDraftPO.totalAmount)}</p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handlePrintPO}
              disabled={isApproved}
              className="px-4 py-2 rounded-xl bg-pos-hover border border-pos-border text-pos-text font-semibold text-xs flex items-center gap-1.5 hover:bg-pos-border transition-colors disabled:opacity-50"
            >
              <Printer className="w-4 h-4" /> Imprimer PO
            </button>
            <button
              onClick={handleApprove}
              disabled={isApproved}
              className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" /> {isApproved ? 'Approuvé' : 'Approuver & Incrémenter le Stock'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

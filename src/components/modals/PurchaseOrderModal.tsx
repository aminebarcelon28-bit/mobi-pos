import React, { useState } from 'react';
import { X, FileText, CheckCircle2, Printer, Smartphone } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { printCoordinator } from '../../utils/printCoordinator';

export const PurchaseOrderModal: React.FC = () => {
  const { activeModal, closeModal, activeDraftPO, approvePurchaseOrder, receiptSettings } = usePosStore();
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
    printCoordinator.printPurchaseOrder(50);
    showToast(`Impression Bon de Commande ${activeDraftPO.poNumber} routée vers imprimante A4`, 'info');
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
              <p className="text-[10px] text-pos-muted">Fournisseur: {activeDraftPO.vendorName} • Date: {formatDateTime(activeDraftPO.createdAt)}</p>
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
              <Printer className="w-4 h-4" /> Imprimer Bon de Commande (A4)
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

        {/* Dedicated A4 Purchase Order Print Template */}
        <div className="print-po-target hidden print:block bg-white text-black p-8 font-sans text-xs">
          {/* Header */}
          <div className="flex justify-between items-start border-b-2 border-black pb-4 mb-6">
            <div>
              <h1 className="text-xl font-black uppercase tracking-wider">{receiptSettings.storeName || 'MOBI ACCESSORIES'}</h1>
              <p className="text-gray-600 text-xs">{receiptSettings.address}</p>
              <p className="text-gray-600 text-xs">Tél: {receiptSettings.phone} • Email: {receiptSettings.email}</p>
            </div>
            <div className="text-right">
              <div className="bg-gray-100 p-3 rounded border border-gray-300">
                <p className="text-xs font-black uppercase text-black">BON DE COMMANDE FOURNISSEUR</p>
                <p className="text-sm font-bold text-gray-900 mt-1">N° : {activeDraftPO.poNumber}</p>
                <p className="text-[10px] text-gray-600">Date: {formatDateTime(activeDraftPO.createdAt)}</p>
              </div>
            </div>
          </div>

          {/* Vendor Details */}
          <div className="bg-gray-50 border border-gray-200 p-4 rounded mb-6 flex justify-between">
            <div>
              <p className="text-[10px] uppercase font-bold text-gray-500">Fournisseur Destinataire :</p>
              <p className="text-sm font-black text-black">{activeDraftPO.vendorName}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase font-bold text-gray-500">Conditions de Règlement :</p>
              <p className="text-xs font-bold text-black">Paiement à Réception / Espèces</p>
            </div>
          </div>

          {/* Line Items Table */}
          <table className="w-full text-left border-collapse mb-6">
            <thead>
              <tr className="bg-gray-200 border-y border-black text-[10px] uppercase font-bold">
                <th className="p-2">#</th>
                <th className="p-2">Désignation Produit</th>
                <th className="p-2">SKU</th>
                <th className="p-2 text-center">Quantité</th>
                <th className="p-2 text-right">Prix Unitaire (DA)</th>
                <th className="p-2 text-right">Total HT (DA)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-300">
              {activeDraftPO.items.map((item, idx) => (
                <tr key={item.productId}>
                  <td className="p-2 text-gray-500 font-mono">{idx + 1}</td>
                  <td className="p-2 font-bold">{item.title}</td>
                  <td className="p-2 font-mono text-[10px] text-gray-600">{item.sku}</td>
                  <td className="p-2 text-center font-bold">{item.suggestedQty}</td>
                  <td className="p-2 text-right font-mono">{formatDZD(item.unitCost)}</td>
                  <td className="p-2 text-right font-mono font-bold">{formatDZD(item.totalCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Total & Signatures */}
          <div className="flex justify-between items-start pt-4 border-t border-black">
            <div className="w-1/2 text-[10px] text-gray-600 space-y-1">
              <p>• Ce bon de commande engage l'approvisionnement des stocks listés ci-dessus.</p>
              <p>• Les prix convenus sont fermes et non révisables à la livraison.</p>
            </div>
            <div className="w-1/3 bg-gray-100 p-4 rounded border border-gray-300 space-y-2 text-right">
              <div className="flex justify-between font-black text-sm text-black">
                <span>TOTAL COMMANDE :</span>
                <span>{formatDZD(activeDraftPO.totalAmount)}</span>
              </div>
            </div>
          </div>

          {/* Signatures Area */}
          <div className="grid grid-cols-2 gap-8 pt-12 mt-6 border-t border-dashed border-gray-400 text-center">
            <div>
              <p className="text-xs font-bold uppercase text-gray-700">Cachet & Signature Magasin :</p>
              <div className="h-16 border-b border-gray-300 mt-2" />
            </div>
            <div>
              <p className="text-xs font-bold uppercase text-gray-700">Accusé de Réception Fournisseur :</p>
              <div className="h-16 border-b border-gray-300 mt-2" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

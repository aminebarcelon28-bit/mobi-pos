import React, { useState, useEffect, useRef } from 'react';
import { X, Banknote, CheckCircle2, CreditCard, AlertCircle, Plus, Trash2, Smartphone, FileText } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { PaymentTender, PaymentMethodType } from '../../types/pos';
import { useToast } from '../../components/ui/Toast';

export const PaymentModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    cart,
    processPayment,
    pricingTier,
    currentCustomer,
    setCartItemIMEI,
  } = usePosStore();
  
  const { showToast } = useToast();

  const [tenders, setTenders] = useState<PaymentTender[]>([]);
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodType>('Espèces');
  const [tenderAmount, setTenderAmount] = useState<string>('');
  const [tenderRef, setTenderRef] = useState<string>('');

  const amountInputRef = useRef<HTMLInputElement>(null);

  const grossSubtotal = cart.reduce((acc, item) => {
    const itemPrice = pricingTier === 'Wholesale' ? item.product.wholesalePrice || item.product.price * 0.75 : item.product.price;
    return acc + itemPrice * item.quantity - item.discount;
  }, 0);

  useEffect(() => {
    if (activeModal === 'payment') {
      if (cart.length === 0) {
        closeModal();
        showToast('Panier vide — Ajoutez des articles au panier avant d\'encaisser.', 'warning');
        return;
      }
      setTenders([]);
      setTenderRef('');
      setSelectedMethod('Espèces');
      setTenderAmount(grossSubtotal > 0 ? grossSubtotal.toString() : '');

      setTimeout(() => {
        if (amountInputRef.current) {
          amountInputRef.current.focus();
          amountInputRef.current.select();
        }
      }, 50);
    }
  }, [activeModal, cart.length, grossSubtotal, closeModal, showToast]);

  if (activeModal !== 'payment') return null;

  const montantTotal = grossSubtotal;
  const montantPaye = tenders.reduce((acc, t) => acc + t.amount, 0);
  const resteAPayer = Math.max(0, montantTotal - montantPaye);
  const changeDue = Math.max(0, montantPaye - montantTotal);

  const quickBillsDZD = [500, 1000, 2000, 5000, 10000];

  const serializedItems = cart.filter(item => item.product.isSerialized);
  const hasMissingIMEI = serializedItems.some(item => !item.imeiNumber);

  // Calculate available store credit (subtracting any Avoir already in tenders)
  const usedAvoir = tenders.filter(t => t.method === 'Avoir Client').reduce((acc, t) => acc + t.amount, 0);
  const availableAvoir = currentCustomer ? Math.max(0, currentCustomer.storeCredit - usedAvoir) : 0;

  const handleApplyMaxCredit = () => {
    if (availableAvoir > 0 && resteAPayer > 0) {
      const amountToAdd = Math.min(resteAPayer, availableAvoir);
      handleAddTender('Avoir Client', amountToAdd);
    }
  };

  const handleAddTender = (method: PaymentMethodType = selectedMethod, amount: number = parseFloat(tenderAmount)) => {
    if (isNaN(amount) || amount <= 0) {
      showToast('Montant invalide', 'warning');
      return;
    }
    
    if (method === 'Avoir Client' && amount > availableAvoir) {
      showToast('Solde avoir insuffisant', 'error');
      return;
    }

    if ((method === 'BaridiMob' || method === 'Chèque') && !tenderRef.trim()) {
      showToast(`Référence requise pour ${method}`, 'warning');
      return;
    }

    setTenders(prev => [...prev, { method, amount, reference: tenderRef.trim() || undefined }]);
    setTenderAmount('');
    setTenderRef('');
  };

  const handleRemoveTender = (index: number) => {
    setTenders(tenders.filter((_, i) => i !== index));
  };

  const handleProcess = () => {
    if (cart.length === 0) {
      showToast('Panier vide — Veuillez ajouter des articles au panier.', 'warning');
      closeModal();
      return;
    }

    if (hasMissingIMEI) {
      showToast('Veuillez saisir les numéros IMEI pour tous les articles sérialisés.', 'warning');
      return;
    }

    let finalTenders = [...tenders];
    const currentPaid = finalTenders.reduce((acc, t) => acc + t.amount, 0);
    const needed = Math.max(0, grossSubtotal - currentPaid);

    if (needed > 0) {
      const typedAmount = parseFloat(tenderAmount);
      const amountToTender = !isNaN(typedAmount) && typedAmount > 0 ? typedAmount : needed;
      if (amountToTender > 0) {
        finalTenders.push({
          method: selectedMethod,
          amount: amountToTender,
          reference: tenderRef.trim() || undefined,
        });
      }
    }

    const totalPaid = finalTenders.reduce((acc, t) => acc + t.amount, 0);
    if (totalPaid < grossSubtotal) {
      showToast('Le montant payé est insuffisant.', 'error');
      return;
    }

    const result = processPayment(finalTenders);
    if (result && !result.success) {
      if (result.reason === 'INSUFFICIENT_CASH') {
        showToast('Montant insuffisant', 'error');
      } else if (result.reason?.startsWith('IMEI_REQUIRED')) {
        showToast('Veuillez saisir les numéros IMEI pour tous les articles sérialisés.', 'warning');
      } else if (result.reason === 'EMPTY_CART') {
        showToast('Panier vide — Veuillez ajouter des articles au panier.', 'warning');
        closeModal();
      } else {
        showToast('Échec du paiement', 'error');
      }
    } else {
      showToast('Paiement effectué avec succès.', 'success');
      closeModal();
    }
  };

  return (
    <div 
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleProcess();
        }
      }}
    >
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 text-emerald-400">
            <Banknote className="w-5 h-5" />
            <h2 className="text-base font-bold text-pos-text">
              Encaissement Multi-Tender (DZD)
            </h2>
          </div>
          <button
            onClick={closeModal}
            className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4">
          
          {/* Customer & Pricing Tier Badge */}
          <div className="flex justify-between items-center bg-pos-bg p-3 rounded-xl border border-pos-border text-xs">
            <div>
              <span className="text-pos-muted block text-[10px]">Profil Client:</span>
              <span className="font-bold text-pos-text">{currentCustomer ? currentCustomer.name : 'Client de Passage'}</span>
            </div>
            <div className="text-right">
              <span className="text-pos-muted block text-[10px]">Grille Tarifaire:</span>
              <span className="font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                {pricingTier === 'Wholesale' ? 'Gros B2B' : 'Détail Standard'}
              </span>
            </div>
          </div>

          {/* Store Credit Split Payment Option */}
          {currentCustomer && availableAvoir > 0 && resteAPayer > 0 && (
            <div className="bg-emerald-950/40 border border-emerald-500/40 p-3 rounded-xl flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-emerald-400" />
                <div>
                  <p className="font-bold text-emerald-300">Solde Avoir Client Disponible</p>
                  <p className="text-[10px] text-pos-muted">{formatDZD(availableAvoir)} disponible</p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleApplyMaxCredit}
                className="px-3 py-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-lg transition"
              >
                Appliquer Avoir ({formatDZD(Math.min(resteAPayer, availableAvoir))})
              </button>
            </div>
          )}

          {/* IMEI Requirements for Serialized Items */}
          {serializedItems.length > 0 && (
            <div className="bg-amber-950/30 border border-amber-500/30 rounded-xl p-3 space-y-2">
              <h4 className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" /> Articles avec IMEI requis
              </h4>
              <div className="space-y-2">
                {serializedItems.map(item => (
                  <div key={item.product.id} className="flex items-center gap-2 bg-pos-bg p-2 rounded-lg border border-pos-border">
                    <span className="text-xs text-pos-text flex-1 truncate">{item.product.title}</span>
                    <input
                      type="text"
                      placeholder="Saisir l'IMEI..."
                      value={item.imeiNumber || ''}
                      onChange={(e) => setCartItemIMEI(item.product.id, e.target.value)}
                      className={`text-xs px-2 py-1 rounded border ${!item.imeiNumber ? 'border-amber-500 bg-amber-500/10' : 'border-pos-border bg-pos-card'} text-pos-text focus:outline-none focus:border-emerald-500 w-32`}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Totals Summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-pos-bg border border-pos-border rounded-xl p-3 text-center">
              <p className="text-[10px] uppercase text-pos-muted font-bold">Montant Total</p>
              <p className="text-lg font-black text-pos-text">{formatDZD(montantTotal)}</p>
            </div>
            <div className="bg-pos-bg border border-pos-border rounded-xl p-3 text-center">
              <p className="text-[10px] uppercase text-pos-muted font-bold">Montant Payé</p>
              <p className="text-lg font-black text-emerald-400">{formatDZD(montantPaye)}</p>
            </div>
            <div className={`border rounded-xl p-3 text-center transition-colors ${resteAPayer > 0 ? 'bg-red-950/20 border-red-500/50' : 'bg-emerald-950/20 border-emerald-500/50'}`}>
              <p className={`text-[10px] uppercase font-bold ${resteAPayer > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                {resteAPayer > 0 ? 'Reste à Payer' : 'Rendu Monnaie'}
              </p>
              <p className={`text-lg font-black ${resteAPayer > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                {resteAPayer > 0 ? formatDZD(resteAPayer) : formatDZD(changeDue)}
              </p>
            </div>
          </div>

          {/* Multi-Tender Entry */}
          <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-4">
            
            <div className="flex gap-2">
              {/* Method Selector */}
              <div className="w-1/3">
                <label className="text-xs text-pos-muted block mb-1">Méthode</label>
                <select
                  value={selectedMethod}
                  onChange={(e) => setSelectedMethod(e.target.value as PaymentMethodType)}
                  className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-sm font-semibold text-pos-text focus:border-emerald-400 focus:outline-none h-[42px]"
                >
                  <option value="Espèces">Espèces</option>
                  <option value="BaridiMob">BaridiMob</option>
                  <option value="Chèque">Chèque</option>
                  {currentCustomer && availableAvoir > 0 && <option value="Avoir Client">Avoir Client</option>}
                </select>
              </div>

              {/* Amount Input */}
              <div className="flex-1">
                <label className="text-xs text-pos-muted block mb-1">Montant (DA)</label>
                <div className="flex gap-2">
                  <input
                    ref={amountInputRef}
                    type="number"
                    value={tenderAmount}
                    onChange={(e) => setTenderAmount(e.target.value)}
                    placeholder={resteAPayer.toString()}
                    className="flex-1 bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-sm font-bold text-pos-text focus:border-emerald-400 focus:outline-none h-[42px]"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleProcess();
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => handleAddTender()}
                    className="px-4 bg-pos-hover border border-pos-border hover:border-emerald-500/50 rounded-lg text-emerald-400 transition flex items-center justify-center h-[42px]"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Reference Input for Non-Cash */}
            {(selectedMethod === 'BaridiMob' || selectedMethod === 'Chèque') && (
              <div className="animate-in slide-in-from-top-2">
                <label className="text-xs text-pos-muted block mb-1">Référence ({selectedMethod === 'BaridiMob' ? 'ID Transaction' : 'N° Chèque'})</label>
                <input
                  type="text"
                  value={tenderRef}
                  onChange={(e) => setTenderRef(e.target.value)}
                  placeholder="Saisir la référence..."
                  className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-sm text-pos-text focus:border-emerald-400 focus:outline-none"
                />
              </div>
            )}

            {/* Quick Bills for Cash */}
            {selectedMethod === 'Espèces' && (
              <div>
                <p className="text-[10px] text-pos-muted mb-1.5 font-medium">Coupures Rapides (DA) :</p>
                <div className="grid grid-cols-6 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (resteAPayer > 0) {
                        setTenders([...tenders, { method: 'Espèces', amount: resteAPayer }]);
                      }
                    }}
                    className="py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 rounded-lg text-xs font-bold text-emerald-300 transition col-span-2"
                  >
                    Exact ({formatDZD(resteAPayer)})
                  </button>
                  {quickBillsDZD.map((amount) => (
                    <button
                      key={amount}
                      type="button"
                      onClick={() => handleAddTender('Espèces', amount)}
                      className="py-1.5 bg-pos-bg hover:bg-emerald-950/40 border border-pos-border hover:border-emerald-500/50 rounded-lg text-xs font-bold text-pos-text hover:text-emerald-300 transition"
                    >
                      {amount.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Applied Tenders Table */}
          {tenders.length > 0 && (
            <div className="bg-pos-bg border border-pos-border rounded-xl overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-pos-card border-b border-pos-border text-pos-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Méthode</th>
                    <th className="px-3 py-2 font-medium">Référence</th>
                    <th className="px-3 py-2 font-medium text-right">Montant</th>
                    <th className="px-3 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-pos-border">
                  {tenders.map((tender, index) => (
                    <tr key={index} className="hover:bg-pos-hover/50">
                      <td className="px-3 py-2 text-pos-text flex items-center gap-1.5">
                        {tender.method === 'Espèces' && <Banknote className="w-3 h-3 text-emerald-400" />}
                        {tender.method === 'Avoir Client' && <CreditCard className="w-3 h-3 text-emerald-400" />}
                        {tender.method === 'BaridiMob' && <Smartphone className="w-3 h-3 text-blue-400" />}
                        {tender.method === 'Chèque' && <FileText className="w-3 h-3 text-amber-400" />}
                        {tender.method}
                      </td>
                      <td className="px-3 py-2 text-pos-muted">{tender.reference || '-'}</td>
                      <td className="px-3 py-2 font-bold text-pos-text text-right">{formatDZD(tender.amount)}</td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => handleRemoveTender(index)}
                          className="text-red-400 hover:text-red-300 p-1 rounded hover:bg-red-400/10 transition"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex justify-end gap-3 shrink-0">
          <button
            onClick={closeModal}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={handleProcess}
            className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs shadow-lg shadow-emerald-500/20 flex items-center gap-2 transition cursor-pointer"
          >
            <CheckCircle2 className="w-4 h-4" /> Valider la Vente (Entrée)
          </button>
        </div>
      </div>
    </div>
  );
};

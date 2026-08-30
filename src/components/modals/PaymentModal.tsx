import React, { useState, useEffect, useRef } from 'react';
import { X, Banknote, CheckCircle2, CreditCard, AlertCircle, Trash2, Smartphone, FileText, Zap } from 'lucide-react';
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
    const itemPrice =
      item.appliedPrice !== undefined
        ? item.appliedPrice
        : pricingTier === 'Wholesale'
        ? item.product.wholesalePrice || item.product.price * 0.75
        : item.product.price;
    return acc + itemPrice * item.quantity - (item.discount || 0);
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
  const currentTypedAmount = parseFloat(tenderAmount) || 0;
  const basePaidFromTenders = tenders.reduce((acc, t) => acc + t.amount, 0);
  const totalGiven = basePaidFromTenders + currentTypedAmount;
  
  const resteAPayer = Math.max(0, montantTotal - totalGiven);
  const changeDue = Math.max(0, totalGiven - montantTotal);

  const quickBillsDZD = [500, 1000, 2000, 5000, 10000];

  const serializedItems = cart.filter(item => item.product.isSerialized);
  const hasMissingIMEI = serializedItems.some(item => !item.imeiNumber);

  // Calculate available store credit
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

    if (needed > 0 || currentTypedAmount > 0) {
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
      showToast(`Montant insuffisant — Il manque ${formatDZD(grossSubtotal - totalPaid)}`, 'error');
      return;
    }

    const calculatedChange = Math.max(0, totalPaid - grossSubtotal);

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
      // Close modal immediately with zero blocking windows
      closeModal();

      // Silent direct print to thermal printer in background
      setTimeout(() => {
        window.print();
      }, 50);

      // Instant confirmation toast with change returned
      if (calculatedChange > 0) {
        showToast(`✅ Vente validée • Rendu Monnaie : ${formatDZD(calculatedChange)} • Ticket imprimé`, 'success');
      } else {
        showToast('✅ Vente validée avec succès • Ticket imprimé', 'success');
      }
    }
  };

  return (
    <div 
      className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleProcess();
        }
      }}
    >
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-black text-pos-text">
                Encaissement & Paiement (F3)
              </h2>
              <p className="text-[10px] text-pos-muted">Tapez le montant reçu puis appuyez sur Entrée ↵</p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4">
          
          {/* Total Net Banner */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-4 flex items-center justify-between shadow-sm">
            <div>
              <span className="text-[11px] uppercase tracking-wider text-pos-muted font-bold block">
                Total Net à Payer
              </span>
              <span className="text-xs text-pos-muted">
                {currentCustomer ? `Client: ${currentCustomer.name}` : 'Client de passage'} • {pricingTier === 'Wholesale' ? 'Tarif Gros' : 'Tarif Détail'}
              </span>
            </div>
            <div className="text-right">
              <span className="text-3xl font-black text-emerald-400 tracking-tight">
                {formatDZD(montantTotal)}
              </span>
            </div>
          </div>

          {/* Real-time Change Due / Remaining Box */}
          <div className={`p-4 rounded-2xl border-2 transition-all duration-150 shadow-lg ${
            totalGiven >= montantTotal
              ? 'bg-gradient-to-br from-emerald-950/80 to-teal-950/80 border-emerald-500 text-emerald-300 shadow-emerald-950/50'
              : 'bg-red-950/30 border-red-500/60 text-red-300 shadow-red-950/40'
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-black uppercase tracking-wider block">
                  {totalGiven >= montantTotal ? '⚡ À Rendre au Client (Rendu Monnaie)' : '⚠️ Reste à Payer (Manquant)'}
                </span>
                <span className="text-[10px] opacity-80">
                  {totalGiven >= montantTotal ? 'Calculé automatiquement en temps réel' : 'Saisissez le montant reçu'}
                </span>
              </div>
              <div className="text-right">
                <span className={`text-3xl font-black tracking-tight ${
                  totalGiven >= montantTotal ? 'text-emerald-300' : 'text-red-400'
                }`}>
                  {totalGiven >= montantTotal ? formatDZD(changeDue) : formatDZD(resteAPayer)}
                </span>
              </div>
            </div>
          </div>

          {/* Amount Given Input */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-extrabold text-pos-text uppercase tracking-wide flex items-center gap-1.5">
                <Banknote className="w-4 h-4 text-emerald-400" />
                Montant Reçu du Client (DA) :
              </label>
              <div className="flex items-center gap-1 flex-wrap">
                {(['Espèces', 'BaridiMob', 'Chèque', 'Crédit Client'] as PaymentMethodType[]).map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setSelectedMethod(method)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition cursor-pointer ${
                      selectedMethod === method
                        ? method === 'Crédit Client'
                          ? 'bg-amber-500 text-slate-950 font-black'
                          : 'bg-emerald-500 text-slate-950 font-black'
                        : 'bg-pos-bg text-pos-muted hover:text-pos-text border border-pos-border'
                    }`}
                  >
                    {method}
                  </button>
                ))}
              </div>
            </div>

            {/* Credit Sale Info Banner */}
            {selectedMethod === 'Crédit Client' && (
              <div className="p-3 rounded-xl border text-xs animate-in fade-in bg-amber-500/10 border-amber-500/30 text-amber-300">
                {currentCustomer ? (
                  <div className="space-y-1">
                    <p className="font-bold flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5" /> Vente à Crédit / Acompte pour {currentCustomer.name}
                    </p>
                    <div className="flex justify-between text-[11px] opacity-90 pt-1 border-t border-amber-500/20">
                      <span>Dette Actuelle : <b>{formatDZD(currentCustomer.currentDebt || 0)}</b></span>
                      <span>Nouveau Solde Dette : <b>{formatDZD((currentCustomer.currentDebt || 0) + (parseFloat(tenderAmount) || resteAPayer))}</b></span>
                    </div>
                  </div>
                ) : (
                  <p className="font-bold text-red-400 flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    Client non sélectionné ! Veuillez identifier un client dans la caisse avant d'autoriser un crédit.
                  </p>
                )}
              </div>
            )}

            <div className="relative">
              <input
                ref={amountInputRef}
                type="number"
                value={tenderAmount}
                onChange={(e) => setTenderAmount(e.target.value)}
                placeholder={montantTotal.toString()}
                className="w-full bg-pos-bg border-2 border-pos-border focus:border-emerald-400 rounded-xl px-4 py-3 text-2xl font-black font-mono text-pos-text focus:outline-none transition"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleProcess();
                  }
                }}
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-bold text-pos-muted font-mono pointer-events-none">
                DA
              </span>
            </div>

            {/* Quick Bill Tap Buttons */}
            <div className="space-y-1.5 pt-1">
              <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
                Coupures Rapides :
              </span>
              <div className="grid grid-cols-6 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setTenderAmount(montantTotal.toString());
                    amountInputRef.current?.focus();
                  }}
                  className="py-2 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 rounded-xl text-xs font-black text-emerald-300 transition cursor-pointer"
                  title="Montant exact"
                >
                  Exact
                </button>
                {quickBillsDZD.map((bill) => (
                  <button
                    key={bill}
                    type="button"
                    onClick={() => {
                      setTenderAmount(bill.toString());
                      amountInputRef.current?.focus();
                    }}
                    className={`py-2 rounded-xl text-xs font-extrabold border transition cursor-pointer ${
                      bill >= montantTotal
                        ? 'bg-pos-bg hover:bg-emerald-500/20 border-pos-border hover:border-emerald-500/50 text-pos-text hover:text-emerald-300'
                        : 'bg-pos-bg border-pos-border opacity-40 text-pos-muted'
                    }`}
                  >
                    {bill.toLocaleString('fr-DZ')}
                  </button>
                ))}
              </div>
            </div>

            {/* Reference Input for Non-Cash */}
            {(selectedMethod === 'BaridiMob' || selectedMethod === 'Chèque') && (
              <div className="pt-2 animate-in slide-in-from-top-2 space-y-1">
                <label className="text-[11px] font-bold text-pos-muted block">
                  Référence ({selectedMethod === 'BaridiMob' ? 'ID Transaction' : 'N° Chèque'}) :
                </label>
                <input
                  type="text"
                  value={tenderRef}
                  onChange={(e) => setTenderRef(e.target.value)}
                  placeholder="Saisir la référence obligatoire..."
                  className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                />
              </div>
            )}
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
                className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-lg transition cursor-pointer"
              >
                Appliquer Avoir ({formatDZD(Math.min(resteAPayer, availableAvoir))})
              </button>
            </div>
          )}

          {/* Customer Debt Quick Action (Kredy) */}
          {currentCustomer && resteAPayer > 0 && (
            <div className="bg-amber-950/30 border border-amber-500/40 p-3 rounded-xl flex items-center justify-between text-xs animate-in fade-in">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-amber-400" />
                <div>
                  <p className="font-bold text-amber-300">Vente Partielle / À Crédit ({currentCustomer.name})</p>
                  <p className="text-[10px] text-amber-200/80">Ajouter le montant manquant ({formatDZD(resteAPayer)}) en dette client</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleAddTender('Crédit Client', resteAPayer)}
                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-lg transition cursor-pointer"
              >
                + Mettre en Crédit
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

          {/* Applied Tenders Table (if multi-split) */}
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
                          className="text-red-400 hover:text-red-300 p-1 rounded hover:bg-red-400/10 transition cursor-pointer"
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
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between shrink-0">
          <button
            onClick={closeModal}
            className="px-4 py-2.5 rounded-xl text-xs font-bold text-pos-muted hover:text-pos-text hover:bg-pos-hover transition cursor-pointer"
          >
            Annuler (Échap)
          </button>
          <button
            type="button"
            onClick={handleProcess}
            className="glow-btn px-7 py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-black text-sm shadow-xl shadow-emerald-600/25 flex items-center gap-2 transition cursor-pointer"
          >
            <CheckCircle2 className="w-5 h-5" />
            <span>Valider & Imprimer</span>
            <span className="bg-black/40 text-emerald-200 border border-white/20 px-2 py-0.5 rounded text-xs font-mono">
              Entrée ↵
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};


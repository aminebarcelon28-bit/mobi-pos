import React, { useState, useEffect, useRef } from 'react';
import { X, Banknote, CheckCircle2, AlertCircle, FileText, UserCheck, ShieldCheck } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { PaymentTender, PaymentMethodType } from '../../types/pos';
import { useToast } from '../../components/ui/Toast';
import { printCoordinator } from '../../utils/printCoordinator';

export const PaymentModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    cart,
    processPayment,
    pricingTier,
    currentCustomer,
    openModal,
    setCartItemIMEI,
  } = usePosStore();
  
  const { showToast } = useToast();
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodType>('Espèces');
  const [cashTenderAmount, setCashTenderAmount] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
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
      setSelectedMethod('Espèces');
      setCashTenderAmount(grossSubtotal > 0 ? grossSubtotal.toString() : '');
      setIsProcessing(false);

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
  const currentCashGiven = parseFloat(cashTenderAmount) || 0;
  
  const resteAPayer = Math.max(0, montantTotal - currentCashGiven);
  const changeDue = Math.max(0, currentCashGiven - montantTotal);

  const quickBillsDZD = [500, 1000, 2000, 5000, 10000];

  const serializedItems = cart.filter(item => item.product.isSerialized);
  const hasMissingIMEI = serializedItems.some(item => !item.imeiNumber);

  // Credit limits & calculations
  const customerCurrentDebt = currentCustomer?.currentDebt || 0;
  const customerDebtLimit = currentCustomer?.debtLimit || 100000;
  const projectedDebtOnCredit = customerCurrentDebt + (selectedMethod === 'Crédit Client' ? montantTotal : resteAPayer);
  const isOverDebtLimit = currentCustomer ? projectedDebtOnCredit > customerDebtLimit : false;

  const handleProcessPayment = async (isCreditSplit: boolean = false) => {
    if (isProcessing) return;

    if (cart.length === 0) {
      showToast('Panier vide — Veuillez ajouter des articles au panier.', 'warning');
      closeModal();
      return;
    }

    if (hasMissingIMEI) {
      showToast('Veuillez saisir les numéros IMEI pour tous les articles sérialisés.', 'warning');
      return;
    }

    setIsProcessing(true);

    let finalTenders: PaymentTender[] = [];

    if (selectedMethod === 'Crédit Client' || isCreditSplit) {
      if (!currentCustomer) {
        showToast('Client non identifié ! Sélectionnez un client pour autoriser le crédit.', 'error');
        setIsProcessing(false);
        return;
      }

      if (isCreditSplit) {
        // Split: Part paid in cash, remaining placed on credit
        if (currentCashGiven > 0) {
          finalTenders.push({ method: 'Espèces', amount: currentCashGiven });
        }
        if (resteAPayer > 0) {
          finalTenders.push({ method: 'Crédit Client', amount: resteAPayer });
        }
      } else {
        // 100% Credit sale
        finalTenders.push({ method: 'Crédit Client', amount: montantTotal });
      }
    } else {
      // 100% Cash payment
      const cashAmount = currentCashGiven > 0 ? currentCashGiven : montantTotal;
      if (cashAmount < montantTotal) {
        showToast(`Montant espèces insuffisant — Il manque ${formatDZD(montantTotal - cashAmount)}`, 'error');
        setIsProcessing(false);
        return;
      }
      finalTenders.push({ method: 'Espèces', amount: cashAmount });
    }

    const totalTendered = finalTenders.reduce((acc, t) => acc + t.amount, 0);
    const calculatedChange = Math.max(0, totalTendered - montantTotal);

    const result = await processPayment(finalTenders);
    if (result && !result.success) {
      setIsProcessing(false);
      if (result.reason === 'INSUFFICIENT_CASH') {
        showToast('Montant insuffisant pour valider la vente.', 'error');
      } else if (result.reason?.startsWith('IMEI_REQUIRED')) {
        showToast('Veuillez saisir les numéros IMEI pour tous les articles sérialisés.', 'warning');
      } else if (result.reason === 'PERSISTENCE_FAILED') {
        showToast('Erreur d\'écriture base de données. Vente non enregistrée.', 'error');
      } else {
        showToast('Échec de validation de la vente.', 'error');
      }
    } else {
      setIsProcessing(false);
      closeModal();

      // Isolated thermal receipt print
      printCoordinator.printReceipt(50);

      if (selectedMethod === 'Crédit Client' || isCreditSplit) {
        showToast(`📋 Vente enregistrée avec solde Crédit pour ${currentCustomer?.name} • Reçu imprimé`, 'success');
      } else if (calculatedChange > 0) {
        showToast(`✅ Vente Espèces validée • Rendu : ${formatDZD(calculatedChange)} • Reçu imprimé`, 'success');
      } else {
        showToast('✅ Vente validée en Espèces • Reçu imprimé', 'success');
      }
    }
  };

  return (
    <div 
      className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleProcessPayment();
        }
      }}
    >
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
              <Banknote className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-pos-text">
                  Encaissement & Règlement
                </h2>
                <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold text-[10px]">
                  Caisse Active
                </span>
              </div>
              <p className="text-[10px] text-pos-muted">Encaissement Espèces & Gestion Rigoureuse des Dettes Clients</p>
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
                Total Net à Régler
              </span>
              <span className="text-xs text-pos-muted">
                {currentCustomer ? `Client : ${currentCustomer.name}` : 'Client de passage (Comptant)'} • {pricingTier === 'Wholesale' ? 'Tarif Gros' : 'Tarif Détail'}
              </span>
            </div>
            <div className="text-right">
              <span className="text-3xl font-black text-emerald-400 tracking-tight font-mono">
                {formatDZD(montantTotal)}
              </span>
            </div>
          </div>

          {/* Payment Method Selector Tabs */}
          <div className="grid grid-cols-2 gap-2 bg-pos-bg p-1 rounded-xl border border-pos-border">
            <button
              type="button"
              onClick={() => setSelectedMethod('Espèces')}
              className={`py-2 px-3 rounded-lg text-xs font-black flex items-center justify-center gap-2 transition cursor-pointer ${
                selectedMethod === 'Espèces'
                  ? 'bg-emerald-500 text-slate-950 shadow-md'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <Banknote className="w-4 h-4" />
              <span>Espèces (Cash)</span>
            </button>
            <button
              type="button"
              onClick={() => setSelectedMethod('Crédit Client')}
              className={`py-2 px-3 rounded-lg text-xs font-black flex items-center justify-center gap-2 transition cursor-pointer ${
                selectedMethod === 'Crédit Client'
                  ? 'bg-amber-500 text-slate-950 shadow-md'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <FileText className="w-4 h-4" />
              <span>Carnet de Dettes (Kredy)</span>
            </button>
          </div>

          {/* Mode 1: Cash Payment View */}
          {selectedMethod === 'Espèces' && (
            <div className="space-y-4 animate-in fade-in">
              {/* Real-time Change Due / Remaining Box */}
              <div className={`p-4 rounded-2xl border-2 transition-all duration-150 shadow-lg ${
                currentCashGiven >= montantTotal
                  ? 'bg-gradient-to-br from-emerald-950/80 to-teal-950/80 border-emerald-500 text-emerald-300 shadow-emerald-950/50'
                  : 'bg-red-950/30 border-red-500/60 text-red-300 shadow-red-950/40'
              }`}>
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-black uppercase tracking-wider block">
                      {currentCashGiven >= montantTotal ? '⚡ À Rendre au Client (Rendu Monnaie)' : '⚠️ Reste à Encaisser'}
                    </span>
                    <span className="text-[10px] opacity-80">
                      {currentCashGiven >= montantTotal ? 'Calculé automatiquement en temps réel' : 'Espèces reçues insuffisantes'}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className={`text-3xl font-black tracking-tight font-mono ${
                      currentCashGiven >= montantTotal ? 'text-emerald-300' : 'text-red-400'
                    }`}>
                      {currentCashGiven >= montantTotal ? formatDZD(changeDue) : formatDZD(resteAPayer)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Cash Input */}
              <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3">
                <label className="text-xs font-extrabold text-pos-text uppercase tracking-wide flex items-center gap-1.5">
                  <Banknote className="w-4 h-4 text-emerald-400" />
                  Espèces Reçues du Client (DA) :
                </label>

                <div className="relative">
                  <input
                    ref={amountInputRef}
                    type="number"
                    value={cashTenderAmount}
                    onChange={(e) => setCashTenderAmount(e.target.value)}
                    onWheel={(e) => (e.target as HTMLElement).blur()}
                    placeholder={montantTotal.toString()}
                    className="w-full bg-pos-bg border-2 border-pos-border focus:border-emerald-400 rounded-xl px-4 py-3 text-3xl font-black font-mono text-pos-text focus:outline-none transition"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-base font-black text-pos-muted font-mono pointer-events-none">
                    DA
                  </span>
                </div>

                {/* Quick Bill Tap Buttons */}
                <div className="space-y-1.5 pt-1">
                  <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
                    Coupures Rapides (1-Clic) :
                  </span>
                  <div className="grid grid-cols-6 gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setCashTenderAmount(montantTotal.toString());
                        amountInputRef.current?.focus();
                      }}
                      className="py-2.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 rounded-xl text-xs font-black text-emerald-300 transition cursor-pointer"
                      title="Montant exact"
                    >
                      Exact
                    </button>
                    {quickBillsDZD.map((bill) => (
                      <button
                        key={bill}
                        type="button"
                        onClick={() => {
                          setCashTenderAmount(bill.toString());
                          amountInputRef.current?.focus();
                        }}
                        className={`py-2.5 rounded-xl text-xs font-black border transition cursor-pointer font-mono ${
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
              </div>

              {/* Partial Payment: Put Remaining Balance on Credit */}
              {currentCustomer && resteAPayer > 0 && currentCashGiven > 0 && (
                <div className="bg-amber-950/30 border border-amber-500/40 p-3.5 rounded-xl flex items-center justify-between text-xs animate-in fade-in">
                  <div>
                    <p className="font-bold text-amber-300">Paiement Partiel pour {currentCustomer.name}</p>
                    <p className="text-[10px] text-amber-200/80">
                      Encaisser {formatDZD(currentCashGiven)} en espèces + ajouter le reste ({formatDZD(resteAPayer)}) en dette
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleProcessPayment(true)}
                    className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl transition cursor-pointer shadow-md"
                  >
                    + Valider Vente Mixte
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Mode 2: Strict Customer Credit View */}
          {selectedMethod === 'Crédit Client' && (
            <div className="space-y-4 animate-in fade-in">
              {currentCustomer ? (
                <div className="bg-amber-950/20 border border-amber-500/40 rounded-2xl p-4 space-y-3">
                  <div className="flex items-center justify-between pb-3 border-b border-amber-500/20">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center font-black">
                        <UserCheck className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="font-black text-amber-300 text-sm">{currentCustomer.name}</h4>
                        <p className="text-[10px] text-amber-200/70">Tél: {currentCustomer.phone} • Réf: {currentCustomer.id.slice(0, 8)}</p>
                      </div>
                    </div>
                    <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-black">
                      Vente 100% Crédit
                    </span>
                  </div>

                  {/* Debt Status Grid */}
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
                      <span className="text-[9px] uppercase font-bold text-pos-muted block">Dette Actuelle</span>
                      <span className="font-black text-amber-400 font-mono text-sm">{formatDZD(customerCurrentDebt)}</span>
                    </div>
                    <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
                      <span className="text-[9px] uppercase font-bold text-pos-muted block">Montant Vente</span>
                      <span className="font-black text-pos-text font-mono text-sm">+{formatDZD(montantTotal)}</span>
                    </div>
                    <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
                      <span className="text-[9px] uppercase font-bold text-pos-muted block">Nouveau Solde</span>
                      <span className="font-black text-red-400 font-mono text-sm">{formatDZD(projectedDebtOnCredit)}</span>
                    </div>
                  </div>

                  {/* Credit Ceiling Guardrail */}
                  {isOverDebtLimit && (
                    <div className="p-2.5 rounded-xl bg-red-950/40 border border-red-500/50 text-red-300 text-xs flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                      <span>⚠️ Attention : Le solde projeté dépasse le plafond autorisé de {formatDZD(customerDebtLimit)}.</span>
                    </div>
                  )}

                  <p className="text-[10px] text-pos-muted italic">
                    • L'enregistrement ajoutera cette créance dans le Grand Livre des Dettes et sur le ticket imprimé.
                  </p>
                </div>
              ) : (
                <div className="p-6 bg-red-950/20 border border-red-500/40 rounded-2xl text-center space-y-3">
                  <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
                  <div>
                    <h4 className="font-bold text-red-300 text-sm">Client Non Identifié</h4>
                    <p className="text-xs text-pos-muted mt-1 max-w-sm mx-auto">
                      Les ventes à crédit nécessitent obligatoirement un compte client enregistré pour la traçabilité des créances.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openModal('customers')}
                    className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl transition cursor-pointer"
                  >
                    🔍 Sélectionner un Client
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Serialized Items IMEI Gate */}
          {serializedItems.length > 0 && (
            <div className="bg-amber-950/30 border border-amber-500/30 rounded-xl p-3 space-y-2">
              <h4 className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" /> Numéros IMEI requis pour validation
              </h4>
              <div className="space-y-2">
                {serializedItems.map(item => (
                  <div key={item.product.id} className="flex items-center gap-2 bg-pos-bg p-2 rounded-lg border border-pos-border">
                    <span className="text-xs text-pos-text flex-1 truncate font-bold">{item.product.title}</span>
                    <input
                      type="text"
                      placeholder="Saisir l'IMEI..."
                      value={item.imeiNumber || ''}
                      onChange={(e) => setCartItemIMEI(item.product.id, e.target.value)}
                      className={`text-xs px-2.5 py-1.5 rounded-lg border ${!item.imeiNumber ? 'border-amber-500 bg-amber-500/10' : 'border-pos-border bg-pos-card'} text-pos-text focus:outline-none focus:border-emerald-500 w-40 font-mono`}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Legal / Policy Indicator */}
          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between text-xs text-pos-muted">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span className="text-[11px] font-semibold text-pos-text">Traçabilité & Impression Thermique Automatique</span>
            </div>
            <span className="text-[10px] text-emerald-400 font-bold">Routage 80mm</span>
          </div>

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
            onClick={() => handleProcessPayment(false)}
            disabled={selectedMethod === 'Crédit Client' && !currentCustomer}
            className={`glow-btn px-8 py-3.5 rounded-xl text-white font-black text-sm shadow-xl flex items-center gap-2 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
              selectedMethod === 'Crédit Client'
                ? 'bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 shadow-amber-600/25'
                : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-emerald-600/25'
            }`}
          >
            <CheckCircle2 className="w-5 h-5" />
            <span>{selectedMethod === 'Crédit Client' ? 'Valider Vente à Crédit' : 'Valider & Imprimer Reçu'}</span>
            <span className="bg-black/40 text-emerald-200 border border-white/20 px-2 py-0.5 rounded text-xs font-mono">
              Entrée ↵
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};



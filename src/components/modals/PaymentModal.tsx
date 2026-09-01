import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Banknote,
  CheckCircle2,
  AlertCircle,
  FileText,
  UserCheck,
  ShieldCheck,
  Gift,
  Sparkles,
  Star,
  Check,
  Search,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { PaymentTender, PaymentMethodType } from '../../types/pos';
import { useToast } from '../../components/ui/Toast';
import { printCoordinator } from '../../utils/printCoordinator';
import { soundEngine } from '../../utils/audioFeedback';

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
    storeCreditApplied,
    setStoreCreditApplied,
  } = usePosStore();

  const { showToast } = useToast();
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodType>('Espèces');
  const [cashTenderAmount, setCashTenderAmount] = useState<string>('');
  const [appliedCredit, setAppliedCredit] = useState<number>(0);
  const [isCustomCreditOpen, setIsCustomCreditOpen] = useState(false);
  const [customCreditInput, setCustomCreditInput] = useState<string>('');
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
      setIsProcessing(false);
      setIsCustomCreditOpen(false);

      // Auto-populate initial store credit if available
      const initialCredit = Math.min(
        currentCustomer?.storeCredit || 0,
        storeCreditApplied || 0,
        grossSubtotal
      );
      setAppliedCredit(initialCredit);

      const initialNet = Math.max(0, grossSubtotal - initialCredit);
      setCashTenderAmount(initialNet > 0 ? initialNet.toString() : '0');

      setTimeout(() => {
        if (amountInputRef.current) {
          amountInputRef.current.focus();
          amountInputRef.current.select();
        }
      }, 50);
    }
  }, [activeModal, cart.length, grossSubtotal, currentCustomer, storeCreditApplied, closeModal, showToast]);

  if (activeModal !== 'payment') return null;

  // Real-time net calculations
  const maxAvailableCredit = currentCustomer ? Math.min(currentCustomer.storeCredit || 0, grossSubtotal) : 0;
  const netToPay = Math.max(0, grossSubtotal - appliedCredit);
  const currentCashGiven = parseFloat(cashTenderAmount) || 0;

  const resteAPayer = Math.max(0, netToPay - currentCashGiven);
  const changeDue = Math.max(0, currentCashGiven - netToPay);

  const quickBillsDZD = [500, 1000, 2000, 5000, 10000];

  const serializedItems = cart.filter((item) => item.product.isSerialized);
  const hasMissingIMEI = serializedItems.some((item) => !item.imeiNumber || !item.imeiNumber.trim());

  // Credit limits & calculations
  const customerCurrentDebt = currentCustomer?.currentDebt || 0;
  const customerDebtLimit = currentCustomer?.debtLimit || 100000;
  const projectedDebtOnCredit = customerCurrentDebt + (selectedMethod === 'Crédit Client' ? netToPay : resteAPayer);
  const isOverDebtLimit = currentCustomer ? projectedDebtOnCredit > customerDebtLimit : false;

  // Handlers for Store Credit / Loyalty application
  const handleApplyFullCredit = () => {
    if (!currentCustomer || maxAvailableCredit <= 0) return;
    setAppliedCredit(maxAvailableCredit);
    setStoreCreditApplied(maxAvailableCredit);
    const newNet = Math.max(0, grossSubtotal - maxAvailableCredit);
    setCashTenderAmount(newNet > 0 ? newNet.toString() : '0');
    soundEngine.playSuccess();
    showToast(`🎁 Avoir Client appliqué : -${formatDZD(maxAvailableCredit)}`, 'success');
  };

  const handleApplyCustomCredit = (amount: number) => {
    if (!currentCustomer) return;
    const clamped = Math.max(0, Math.min(amount, currentCustomer.storeCredit || 0, grossSubtotal));
    setAppliedCredit(clamped);
    setStoreCreditApplied(clamped);
    const newNet = Math.max(0, grossSubtotal - clamped);
    setCashTenderAmount(newNet > 0 ? newNet.toString() : '0');
    setIsCustomCreditOpen(false);
    soundEngine.playKeyBeep?.();
    if (clamped > 0) {
      showToast(`🎁 Avoir Client partiel appliqué : -${formatDZD(clamped)}`, 'info');
    } else {
      showToast('Avoir Client retiré.', 'info');
    }
  };

  const handleRemoveCredit = () => {
    setAppliedCredit(0);
    setStoreCreditApplied(0);
    setCashTenderAmount(grossSubtotal > 0 ? grossSubtotal.toString() : '0');
    soundEngine.playKeyBeep?.();
    showToast('Avoir Client retiré de la vente.', 'info');
  };

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

    const finalTenders: PaymentTender[] = [];

    // 1. Add Store Credit tender if applied
    if (appliedCredit > 0) {
      finalTenders.push({ method: 'Avoir Client', amount: appliedCredit });
    }

    // 2. Handle remaining balance
    if (netToPay === 0) {
      // 100% paid by Store Credit!
    } else if (selectedMethod === 'Crédit Client' || isCreditSplit) {
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
        // 100% Credit sale for remaining net
        finalTenders.push({ method: 'Crédit Client', amount: netToPay });
      }
    } else {
      // Cash payment
      const cashAmount = currentCashGiven > 0 ? currentCashGiven : netToPay;
      if (cashAmount < netToPay) {
        showToast(`Montant espèces insuffisant — Il manque ${formatDZD(netToPay - cashAmount)}`, 'error');
        setIsProcessing(false);
        return;
      }
      finalTenders.push({ method: 'Espèces', amount: cashAmount });
    }

    const totalTendered = finalTenders.reduce((acc, t) => acc + t.amount, 0);
    const calculatedChange = Math.max(0, totalTendered - grossSubtotal);

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

      if (appliedCredit > 0 && netToPay === 0) {
        showToast(`🎁 Vente 100% réglée via Avoir Client (${formatDZD(appliedCredit)}) • Reçu imprimé`, 'success');
      } else if (selectedMethod === 'Crédit Client' || isCreditSplit) {
        showToast(`📋 Vente enregistrée avec solde Crédit pour ${currentCustomer?.name} • Reçu imprimé`, 'success');
      } else if (calculatedChange > 0) {
        showToast(`✅ Vente validée • Rendu : ${formatDZD(calculatedChange)} • Reçu imprimé`, 'success');
      } else {
        showToast('✅ Vente validée avec succès • Reçu imprimé', 'success');
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
          {/* Total Net Banner & Breakdown */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[11px] uppercase tracking-wider text-pos-muted font-bold block">
                  {appliedCredit > 0 ? 'Net Restant à Encaisser' : 'Total Net à Régler'}
                </span>
                <span className="text-xs text-pos-muted">
                  {currentCustomer ? `Client : ${currentCustomer.name}` : 'Client de passage (Comptant)'} •{' '}
                  {pricingTier === 'Wholesale' ? 'Tarif Gros' : 'Tarif Détail'}
                </span>
              </div>
              <div className="text-right">
                <span className="text-3xl font-black text-emerald-400 tracking-tight font-mono">
                  {formatDZD(netToPay)}
                </span>
              </div>
            </div>

            {/* Subtotal & Store Credit breakdown pill */}
            {appliedCredit > 0 && (
              <div className="pt-2 border-t border-pos-border/60 flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-2 text-pos-muted">
                  <span>Sous-total: {formatDZD(grossSubtotal)}</span>
                  <span className="text-purple-400 font-bold flex items-center gap-1">
                    <Gift className="w-3.5 h-3.5" /> Avoir Déduit: -{formatDZD(appliedCredit)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleRemoveCredit}
                  className="text-[10px] text-red-400 hover:text-red-300 font-sans font-bold transition cursor-pointer underline"
                >
                  Annuler Avoir
                </button>
              </div>
            )}
          </div>

          {/* ══════════════════════════════════════════════════════════════ */}
          {/* LOYALTY & STORE CREDIT DEDUCTION CARD */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {currentCustomer ? (
            <div className="bg-gradient-to-br from-purple-950/30 to-indigo-950/30 border border-purple-500/40 rounded-2xl p-3.5 space-y-2.5 animate-in fade-in">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-purple-500/20 text-purple-300 flex items-center justify-center font-bold">
                    <Gift className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-purple-200">Avoir & Crédit Fidélité Disponible</span>
                      <span className="bg-purple-500/20 text-purple-300 text-[10px] font-mono font-black px-2 py-0.5 rounded-full border border-purple-500/30">
                        {formatDZD(currentCustomer.storeCredit || 0)}
                      </span>
                    </div>
                    <span className="text-[10px] text-pos-muted flex items-center gap-1">
                      <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                      {currentCustomer.loyaltyPoints || 0} Points accumulés • Palier {currentCustomer.loyaltyTier || 'Bronze'}
                    </span>
                  </div>
                </div>

                {/* Quick Action Button */}
                {(currentCustomer.storeCredit || 0) > 0 && appliedCredit === 0 && (
                  <button
                    type="button"
                    onClick={handleApplyFullCredit}
                    className="px-3 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl text-xs font-black flex items-center gap-1.5 shadow-md shadow-purple-900/30 transition cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-purple-200" />
                    <span>Appliquer Tout ({formatDZD(maxAvailableCredit)})</span>
                  </button>
                )}

                {appliedCredit > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold px-2.5 py-1 rounded-xl flex items-center gap-1">
                      <Check className="w-3.5 h-3.5" /> Appliqué (-{formatDZD(appliedCredit)})
                    </span>
                    <button
                      type="button"
                      onClick={handleRemoveCredit}
                      className="p-1 hover:bg-red-500/20 text-pos-muted hover:text-red-400 rounded-lg transition cursor-pointer"
                      title="Retirer l'avoir"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              {/* Partial / Custom Credit Presets */}
              {(currentCustomer.storeCredit || 0) > 0 && (
                <div className="flex items-center gap-1.5 pt-1 border-t border-purple-500/20 text-xs">
                  <span className="text-[10px] text-purple-300 font-bold uppercase tracking-wider">Montants Rapides :</span>
                  {[500, 1000, 2000, 5000].map((amt) => {
                    if (amt > (currentCustomer.storeCredit || 0) || amt > grossSubtotal) return null;
                    const isSelected = appliedCredit === amt;
                    return (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => handleApplyCustomCredit(amt)}
                        className={`px-2 py-1 rounded-lg text-[10.5px] font-mono font-bold border transition cursor-pointer ${
                          isSelected
                            ? 'bg-purple-500 text-white border-purple-400 shadow-sm'
                            : 'bg-purple-950/40 hover:bg-purple-500/20 text-purple-200 border-purple-500/30'
                        }`}
                      >
                        {amt.toLocaleString('fr-DZ')} DA
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => setIsCustomCreditOpen(!isCustomCreditOpen)}
                    className="ml-auto text-[10px] text-purple-300 hover:text-purple-200 underline font-semibold transition cursor-pointer"
                  >
                    {isCustomCreditOpen ? 'Fermer' : 'Autre montant...'}
                  </button>
                </div>
              )}

              {/* Custom Credit Amount Input */}
              {isCustomCreditOpen && (
                <div className="flex items-center gap-2 pt-1 animate-in fade-in slide-in-from-top-1">
                  <input
                    type="number"
                    value={customCreditInput}
                    onChange={(e) => setCustomCreditInput(e.target.value)}
                    placeholder={`Max ${maxAvailableCredit} DA`}
                    className="flex-1 bg-pos-bg border border-purple-500/50 rounded-xl px-3 py-1.5 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-purple-400"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const val = parseFloat(customCreditInput) || 0;
                      handleApplyCustomCredit(val);
                    }}
                    className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold transition cursor-pointer"
                  >
                    Valider Avoir
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-pos-muted">
                <UserCheck className="w-4 h-4 text-emerald-400" />
                <span className="text-[11px]">Client Comptant de Passage</span>
              </div>
              <button
                type="button"
                onClick={() => openModal('customers')}
                className="px-2.5 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg text-[11px] font-bold flex items-center gap-1 transition cursor-pointer"
              >
                <Search className="w-3 h-3" />
                <span>Identifier Client (Avoir / Dette)</span>
              </button>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════ */}
          {/* 100% STORE CREDIT COVERAGE NOTIFICATION */}
          {/* ══════════════════════════════════════════════════════════════ */}
          {netToPay === 0 && appliedCredit > 0 ? (
            <div className="p-4 rounded-2xl bg-gradient-to-br from-purple-950/80 to-emerald-950/80 border-2 border-emerald-500 text-emerald-300 shadow-lg space-y-1.5 animate-in fade-in">
              <div className="flex items-center gap-2 font-black text-sm text-emerald-300">
                <Sparkles className="w-5 h-5 text-purple-300" />
                <span>Panier 100% Couvert par l'Avoir Client !</span>
              </div>
              <p className="text-xs text-emerald-200/80">
                Le montant total de {formatDZD(grossSubtotal)} est intégralement déduit du solde de {currentCustomer?.name}. Aucun encaissement en espèces n'est requis.
              </p>
            </div>
          ) : (
            <>
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
                  <div
                    className={`p-4 rounded-2xl border-2 transition-all duration-150 shadow-lg ${
                      currentCashGiven >= netToPay
                        ? 'bg-gradient-to-br from-emerald-950/80 to-teal-950/80 border-emerald-500 text-emerald-300 shadow-emerald-950/50'
                        : 'bg-red-950/30 border-red-500/60 text-red-300 shadow-red-950/40'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-xs font-black uppercase tracking-wider block">
                          {currentCashGiven >= netToPay
                            ? '⚡ À Rendre au Client (Rendu Monnaie)'
                            : '⚠️ Reste à Encaisser en Espèces'}
                        </span>
                        <span className="text-[10px] opacity-80">
                          {currentCashGiven >= netToPay
                            ? 'Calculé automatiquement en temps réel'
                            : 'Espèces reçues insuffisantes'}
                        </span>
                      </div>
                      <div className="text-right">
                        <span
                          className={`text-3xl font-black tracking-tight font-mono ${
                            currentCashGiven >= netToPay ? 'text-emerald-300' : 'text-red-400'
                          }`}
                        >
                          {currentCashGiven >= netToPay ? formatDZD(changeDue) : formatDZD(resteAPayer)}
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
                        placeholder={netToPay.toString()}
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
                            setCashTenderAmount(netToPay.toString());
                            amountInputRef.current?.focus();
                          }}
                          className="py-2.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 rounded-xl text-xs font-black text-emerald-300 transition cursor-pointer"
                          title="Montant exact net"
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
                              bill >= netToPay
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
                            <p className="text-[10px] text-amber-200/70">
                              Tél: {currentCustomer.phone} • Réf: {currentCustomer.id.slice(0, 8)}
                            </p>
                          </div>
                        </div>
                        <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-black">
                          Vente à Crédit
                        </span>
                      </div>

                      {/* Debt Status Grid */}
                      <div className="grid grid-cols-3 gap-2 text-center text-xs">
                        <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
                          <span className="text-[9px] uppercase font-bold text-pos-muted block">Dette Actuelle</span>
                          <span className="font-black text-amber-400 font-mono text-sm">{formatDZD(customerCurrentDebt)}</span>
                        </div>
                        <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
                          <span className="text-[9px] uppercase font-bold text-pos-muted block">Montant Net Vente</span>
                          <span className="font-black text-pos-text font-mono text-sm">+{formatDZD(netToPay)}</span>
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
            </>
          )}

          {/* Serialized Items IMEI Gate */}
          {serializedItems.length > 0 && (
            <div className="bg-amber-950/30 border border-amber-500/30 rounded-xl p-3 space-y-2">
              <h4 className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" /> Numéros IMEI requis pour validation
              </h4>
              <div className="space-y-2">
                {serializedItems.map((item) => (
                  <div key={item.product.id} className="flex items-center gap-2 bg-pos-bg p-2 rounded-lg border border-pos-border">
                    <span className="text-xs text-pos-text flex-1 truncate font-bold">{item.product.title}</span>
                    <input
                      type="text"
                      placeholder="Saisir l'IMEI..."
                      value={item.imeiNumber || ''}
                      onChange={(e) => setCartItemIMEI(item.product.id, e.target.value)}
                      className={`text-xs px-2.5 py-1.5 rounded-lg border ${
                        !item.imeiNumber ? 'border-amber-500 bg-amber-500/10' : 'border-pos-border bg-pos-card'
                      } text-pos-text focus:outline-none focus:border-emerald-500 w-40 font-mono`}
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
            disabled={selectedMethod === 'Crédit Client' && !currentCustomer && netToPay > 0}
            className={`glow-btn px-8 py-3.5 rounded-xl text-white font-black text-sm shadow-xl flex items-center gap-2 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
              netToPay === 0 && appliedCredit > 0
                ? 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-purple-600/25'
                : selectedMethod === 'Crédit Client'
                ? 'bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 shadow-amber-600/25'
                : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-emerald-600/25'
            }`}
          >
            <CheckCircle2 className="w-5 h-5" />
            <span>
              {netToPay === 0 && appliedCredit > 0
                ? 'Valider Paiement Avoir (100%)'
                : selectedMethod === 'Crédit Client'
                ? 'Valider Vente à Crédit'
                : 'Valider & Imprimer Reçu'}
            </span>
            <span className="bg-black/40 text-emerald-200 border border-white/20 px-2 py-0.5 rounded text-xs font-mono">
              Entrée ↵
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};



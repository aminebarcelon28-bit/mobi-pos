import React, { useState, useMemo } from 'react';
import {
  X,
  CreditCard,
  Search,
  DollarSign,
  Printer,
  MessageSquare,
  AlertTriangle,
  CheckCircle2,
  Phone,
  User,
  History,
  TrendingDown,
  Lock,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import type { Customer, PaymentMethodType } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { buildWhatsAppUrl } from '../../utils/phoneUtils';
import { soundEngine } from '../../utils/audioFeedback';

export const DebtLedgerModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    customers,
    customerDebts,
    recordCustomerDebtPayment,
    updateCustomer,
    verifyManagerPin,
  } = usePosStore();

  const { showToast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'overdue' | 'high_debt' | 'over_limit'>('all');
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);

  // Payment Sub-Modal State
  const [payingCustomer, setPayingCustomer] = useState<Customer | null>(null);
  const [paymentAmount, setPaymentAmount] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('Espèces');
  const [paymentNotes, setPaymentNotes] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  // Credit Limit Adjustment State
  const [adjustingCustomer, setAdjustingCustomer] = useState<Customer | null>(null);
  const [newLimitInput, setNewLimitInput] = useState<string>('');
  const [managerPin, setManagerPin] = useState<string>('');

  if (activeModal !== 'debt_ledger') return null;

  // ══════════════════════════════════════════════════════════════
  // AGGREGATIONS & METRICS
  // ══════════════════════════════════════════════════════════════
  const allIndebted = (customers || []).filter((c) => (c.currentDebt || 0) > 0);
  const totalOutstandingDebt = allIndebted.reduce((sum, c) => sum + (c.currentDebt || 0), 0);
  const totalCreditLimits = allIndebted.reduce((sum, c) => sum + (c.debtLimit || 50000), 0);
  const overLimitCount = allIndebted.filter((c) => (c.currentDebt || 0) >= (c.debtLimit || 50000)).length;

  const filteredDebtors = useMemo(() => {
    let list = allIndebted.filter(
      (c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.phone.includes(searchQuery) ||
        (c.registeredDevice || '').toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (filterType === 'over_limit') {
      list = list.filter((c) => (c.currentDebt || 0) >= (c.debtLimit || 50000));
    } else if (filterType === 'high_debt') {
      list = list.filter((c) => (c.currentDebt || 0) >= 20000);
    }

    return list.sort((a, b) => (b.currentDebt || 0) - (a.currentDebt || 0));
  }, [allIndebted, searchQuery, filterType]);

  // ══════════════════════════════════════════════════════════════
  // ACTIONS: REPAYMENT & WHATSAPP
  // ══════════════════════════════════════════════════════════════
  const handleOpenPayment = (customer: Customer) => {
    setPayingCustomer(customer);
    setPaymentAmount(String(customer.currentDebt || 0));
    setPaymentMethod('Espèces');
    setPaymentNotes('Règlement direct au comptoir');
  };

  const handleConfirmRepayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payingCustomer) return;
    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
      showToast('Veuillez saisir un montant de versement valide.', 'warning');
      return;
    }

    setIsProcessing(true);
    const res = await recordCustomerDebtPayment(
      payingCustomer.id,
      amount,
      paymentMethod,
      paymentNotes
    );
    setIsProcessing(false);

    if (res.success) {
      soundEngine.playSuccess();
      showToast(`Versement de ${formatDZD(amount)} enregistré avec succès !`, 'success');
      setPayingCustomer(null);
    } else {
      soundEngine.playError();
      showToast('Erreur lors de l\'enregistrement du versement.', 'error');
    }
  };

  const handleSendWhatsAppReminder = (customer: Customer) => {
    const debt = customer.currentDebt || 0;
    const msg = `*RELEVÉ DE COMPTE CLIENT - MOBI POS*\n*Client :* ${customer.name}\n*Date :* ${new Date().toLocaleDateString('fr-DZ')}\n\nBonjour, nous vous informons que le solde de votre compte présente un encours de *${formatDZD(debt)}*.\n\nMerci de bien vouloir passer en boutique pour régulariser votre situation.\nCordialement,\n*L'Équipe MobiPOS*`;
    const url = buildWhatsAppUrl(customer.phone, msg);
    window.open(url, '_blank');
  };

  const handlePrintStatement = (customer: Customer) => {
    window.print();
    showToast(`Impression du relevé de compte lancée pour ${customer.name}.`, 'info');
  };

  const handleSaveNewLimit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustingCustomer) return;
    if (!verifyManagerPin(managerPin)) {
      showToast('Code PIN Manager incorrect.', 'error');
      soundEngine.playError();
      return;
    }

    const newLimit = parseFloat(newLimitInput);
    if (isNaN(newLimit) || newLimit < 0) {
      showToast('Plafond invalide.', 'warning');
      return;
    }

    await updateCustomer(adjustingCustomer.id, { debtLimit: newLimit });
    showToast(`Nouveau plafond de ${formatDZD(newLimit)} appliqué à ${adjustingCustomer.name}.`, 'success');
    soundEngine.playSuccess();
    setAdjustingCustomer(null);
    setManagerPin('');
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-6xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col h-[90vh]">
        {/* ══════════════════════════════════════════════════════════════ */}
        {/* HEADER */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center text-white shadow-lg shadow-rose-500/20">
              <CreditCard className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-pos-text uppercase tracking-wider">
                  Registre des Dettes & Crédits Clients (Kredy)
                </h2>
                <span className="px-2.5 py-0.5 rounded-full bg-rose-500/15 border border-rose-500/30 text-rose-300 font-bold text-xs">
                  {allIndebted.length} Débiteurs
                </span>
              </div>
              <p className="text-xs text-pos-muted">
                Suivi des encours, règlements, relances WhatsApp et gestion des plafonds autorisés
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TOP METRICS CARDS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-4 border-b border-pos-border bg-pos-bg grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0">
          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Total Encours Dettes
              </span>
              <span className="text-xl font-black text-rose-400 font-mono">{formatDZD(totalOutstandingDebt)}</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-rose-500/10 text-rose-400 flex items-center justify-center">
              <TrendingDown className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Clients Débiteurs
              </span>
              <span className="text-xl font-black text-amber-400 font-mono">{allIndebted.length}</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <User className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Plafond Dépassé
              </span>
              <span className="text-xl font-black text-red-500 font-mono">{overLimitCount}</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-red-500/10 text-red-500 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Plafond Global Alloué
              </span>
              <span className="text-xl font-black text-cyan-400 font-mono">{formatDZD(totalCreditLimits)}</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
              <CreditCard className="w-5 h-5" />
            </div>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* SEARCH & FILTER CONTROLS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-3 border-b border-pos-border bg-pos-panel flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs w-full sm:w-auto">
            <button
              onClick={() => setFilterType('all')}
              className={`px-3 py-1.5 rounded-xl font-bold border transition cursor-pointer ${
                filterType === 'all'
                  ? 'bg-rose-500 text-slate-950 border-rose-400'
                  : 'bg-pos-card text-pos-muted hover:text-pos-text border-pos-border'
              }`}
            >
              Tous les Débiteurs ({allIndebted.length})
            </button>
            <button
              onClick={() => setFilterType('over_limit')}
              className={`px-3 py-1.5 rounded-xl font-bold border transition cursor-pointer ${
                filterType === 'over_limit'
                  ? 'bg-red-500 text-white border-red-400'
                  : 'bg-pos-card text-pos-muted hover:text-pos-text border-pos-border'
              }`}
            >
              🚨 Plafond Dépassé ({overLimitCount})
            </button>
            <button
              onClick={() => setFilterType('high_debt')}
              className={`px-3 py-1.5 rounded-xl font-bold border transition cursor-pointer ${
                filterType === 'high_debt'
                  ? 'bg-amber-500 text-slate-950 border-amber-400'
                  : 'bg-pos-card text-pos-muted hover:text-pos-text border-pos-border'
              }`}
            >
              ⏳ Dettes Élevées (&gt; 20k DA)
            </button>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Rechercher débiteur, téléphone..."
              className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-1.5 text-xs text-pos-text focus:outline-none focus:border-rose-500"
            />
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* DEBTORS LIST */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {filteredDebtors.length === 0 ? (
            <div className="p-12 text-center bg-pos-card border border-pos-border rounded-2xl space-y-3">
              <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto opacity-60" />
              <h3 className="font-bold text-sm text-pos-text">Aucun débiteur dans cette catégorie</h3>
              <p className="text-xs text-pos-muted max-w-sm mx-auto">
                Toutes les créances clients sont à jour ou correspondent aux critères sélectionnés.
              </p>
            </div>
          ) : (
            filteredDebtors.map((customer) => {
              const debt = customer.currentDebt || 0;
              const limit = customer.debtLimit || 50000;
              const ratio = Math.min(100, Math.round((debt / limit) * 100));
              const isOver = debt >= limit;
              const isExpanded = expandedCustomerId === customer.id;

              const customerHistory = (customerDebts || []).filter((d) => d.customerId === customer.id);

              return (
                <div
                  key={customer.id}
                  className={`bg-pos-card border rounded-2xl overflow-hidden transition-all duration-150 shadow-sm ${
                    isOver ? 'border-red-500/50 hover:border-red-500/70' : 'border-pos-border hover:border-rose-500/40'
                  }`}
                >
                  <div className="p-4 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3 bg-pos-panel/50">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-sm ${
                          isOver ? 'bg-red-500/20 text-red-400' : 'bg-rose-500/20 text-rose-400'
                        }`}
                      >
                        <User className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-bold text-sm text-pos-text">{customer.name}</h4>
                          <span className="text-xs text-pos-muted font-mono flex items-center gap-1">
                            <Phone className="w-3 h-3" /> {customer.phone}
                          </span>
                          {isOver && (
                            <span className="px-2 py-0.5 rounded-md text-[9px] font-black uppercase bg-red-500/20 border border-red-500/40 text-red-300 animate-pulse">
                              Plafond Atteint
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-pos-muted">
                          Appareil : {customer.registeredDevice || 'Non spécifié'} • Tarif : {customer.pricingTier} • Rang : {customer.loyaltyTier || 'Bronze'}
                        </p>
                      </div>
                    </div>

                    {/* Progress Bar & Amount */}
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full lg:w-auto justify-between lg:justify-end">
                      <div className="w-44 space-y-1">
                        <div className="flex justify-between text-[10px] font-bold">
                          <span className="text-pos-muted">Plafond : {formatDZD(limit)}</span>
                          <span className={isOver ? 'text-red-400' : 'text-rose-400'}>{ratio}%</span>
                        </div>
                        <div className="w-full h-2 bg-pos-bg rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${
                              isOver ? 'bg-red-500' : ratio > 75 ? 'bg-amber-500' : 'bg-rose-500'
                            }`}
                            style={{ width: `${ratio}%` }}
                          />
                        </div>
                      </div>

                      <div className="text-right pr-2">
                        <span className="text-[9px] uppercase font-bold text-pos-muted block">Dette Actuelle</span>
                        <span className="text-base font-black text-rose-400 font-mono">{formatDZD(debt)}</span>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleOpenPayment(customer)}
                          className="px-3 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-black rounded-xl flex items-center gap-1 shadow-md transition cursor-pointer"
                          title="Enregistrer un versement / remboursement"
                        >
                          <DollarSign className="w-3.5 h-3.5" />
                          <span>Versement</span>
                        </button>

                        <button
                          onClick={() => handleSendWhatsAppReminder(customer)}
                          className="p-2 bg-pos-bg hover:bg-emerald-500/20 border border-pos-border hover:border-emerald-500/40 text-emerald-400 rounded-xl transition cursor-pointer"
                          title="Envoyer un rappel de solde via WhatsApp"
                        >
                          <MessageSquare className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handlePrintStatement(customer)}
                          className="p-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
                          title="Imprimer le relevé de compte 80mm"
                        >
                          <Printer className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => {
                            setAdjustingCustomer(customer);
                            setNewLimitInput(String(customer.debtLimit || 50000));
                          }}
                          className="p-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
                          title="Ajuster le plafond de crédit autorisé (PIN Manager)"
                        >
                          <Lock className="w-4 h-4 text-cyan-400" />
                        </button>

                        <button
                          onClick={() => setExpandedCustomerId(isExpanded ? null : customer.id)}
                          className="p-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
                          title="Voir l'historique des opérations"
                        >
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Expandable History Timeline */}
                  {isExpanded && (
                    <div className="p-4 border-t border-pos-border bg-pos-bg space-y-2 animate-in fade-in">
                      <div className="flex items-center justify-between pb-1 border-b border-pos-border">
                        <h5 className="text-xs font-bold text-pos-muted uppercase tracking-wider flex items-center gap-1.5">
                          <History className="w-3.5 h-3.5 text-rose-400" /> Historique des Écritures ({customerHistory.length}) :
                        </h5>
                      </div>

                      {customerHistory.length === 0 ? (
                        <p className="text-xs text-pos-muted py-2 italic">Aucun mouvement enregistré dans le grand livre.</p>
                      ) : (
                        <div className="divide-y divide-pos-border/40 font-mono text-xs max-h-48 overflow-y-auto pr-1">
                          {customerHistory.map((h) => (
                            <div key={h.id} className="py-1.5 flex items-center justify-between">
                              <div>
                                <span className="font-bold text-pos-text">
                                  {h.type === 'DEBT_ACQUIRED' ? '➕ Achat à Crédit' : '➖ Versement / Remboursement'}
                                </span>
                                <span className="text-[10px] text-pos-muted block font-sans">
                                  {formatDateTime(h.createdAt)} • {h.notes || 'Sans note'}
                                </span>
                              </div>
                              <div className="text-right">
                                <span
                                  className={`font-black ${
                                    h.type === 'DEBT_ACQUIRED' ? 'text-rose-400' : 'text-emerald-400'
                                  }`}
                                >
                                  {h.type === 'DEBT_ACQUIRED' ? '+' : '-'}
                                  {formatDZD(h.amount)}
                                </span>
                                <span className="text-[10px] text-pos-muted block">Solde après: {formatDZD(h.balanceAfter)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* PAYMENT SUB-MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {payingCustomer && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-60 flex items-center justify-center p-4">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col">
              <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
                    <DollarSign className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-black text-sm text-pos-text">Enregistrer un Versement</h3>
                    <p className="text-[10px] text-pos-muted">Client : {payingCustomer.name}</p>
                  </div>
                </div>
                <button
                  onClick={() => setPayingCustomer(null)}
                  className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleConfirmRepayment} className="p-4 space-y-3 text-xs">
                <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex justify-between items-center">
                  <span className="text-pos-muted">Dette Restante Actuelle :</span>
                  <span className="font-mono font-black text-base text-rose-400">
                    {formatDZD(payingCustomer.currentDebt || 0)}
                  </span>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Montant du Versement (DA) :
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="any"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base font-mono font-black text-emerald-400 focus:outline-none focus:border-emerald-500"
                    placeholder="0"
                    autoFocus
                    required
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Mode de Règlement :
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['Espèces', 'BaridiMob', 'Chèque'] as PaymentMethodType[]).map((meth) => (
                      <button
                        key={meth}
                        type="button"
                        onClick={() => setPaymentMethod(meth)}
                        className={`py-2 rounded-xl text-xs font-bold border transition cursor-pointer ${
                          paymentMethod === meth
                            ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-sm'
                            : 'bg-pos-bg text-pos-muted border-pos-border'
                        }`}
                      >
                        {meth}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">Note / Justificatif :</label>
                  <input
                    type="text"
                    value={paymentNotes}
                    onChange={(e) => setPaymentNotes(e.target.value)}
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-1.5 text-xs text-pos-text focus:outline-none focus:border-emerald-500"
                    placeholder="Ex: Versement partiel en espèces"
                  />
                </div>

                <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between -mx-4 -mb-4 mt-4">
                  <button
                    type="button"
                    onClick={() => setPayingCustomer(null)}
                    className="px-4 py-2 text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    disabled={isProcessing}
                    className="px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-black text-xs rounded-xl shadow-lg transition cursor-pointer flex items-center gap-2"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{isProcessing ? 'Validation...' : 'Valider & Imprimer Reçu'}</span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* CREDIT LIMIT ADJUSTMENT SUB-MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {adjustingCustomer && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-60 flex items-center justify-center p-4">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col">
              <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
                <div className="flex items-center gap-2">
                  <Lock className="w-5 h-5 text-cyan-400" />
                  <h3 className="font-black text-sm text-pos-text">Modifier Plafond de Crédit</h3>
                </div>
                <button
                  onClick={() => setAdjustingCustomer(null)}
                  className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleSaveNewLimit} className="p-4 space-y-3 text-xs">
                <p className="text-pos-muted">
                  Client : <span className="font-bold text-pos-text">{adjustingCustomer.name}</span>
                </p>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Nouveau Plafond Autorisé (DA) :
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    value={newLimitInput}
                    onChange={(e) => setNewLimitInput(e.target.value)}
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base font-mono font-black text-cyan-400 focus:outline-none focus:border-cyan-500"
                    required
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Code PIN Manager Requis :
                  </label>
                  <input
                    type="password"
                    maxLength={4}
                    value={managerPin}
                    onChange={(e) => setManagerPin(e.target.value)}
                    placeholder="••••"
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-center text-lg font-mono tracking-widest text-pos-text focus:outline-none focus:border-cyan-500"
                    required
                  />
                </div>

                <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between -mx-4 -mb-4 mt-4">
                  <button
                    type="button"
                    onClick={() => setAdjustingCustomer(null)}
                    className="px-4 py-2 text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white font-black text-xs rounded-xl shadow-lg transition cursor-pointer"
                  >
                    Enregistrer Plafond
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* FOOTER */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between shrink-0">
          <span className="text-xs text-pos-muted">
            • Tous les versements mettent à jour automatiquement le journal comptable et la balance client.
          </span>
          <button
            onClick={closeModal}
            className="px-5 py-2 rounded-xl text-xs font-bold bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text transition cursor-pointer"
          >
            Fermer (Échap)
          </button>
        </div>
      </div>
    </div>
  );
};

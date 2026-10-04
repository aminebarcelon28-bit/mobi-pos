import React, { useState, useMemo, useEffect, useRef } from 'react';
import { parseLocalizedAmount } from '../../utils/moneyInput';

const foldForSearch = (s: string | undefined | null): string =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Tab candidates for the modal focus trap (defect I6). */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
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
import { DEFAULT_CREDIT_LIMIT } from '../../store/slices/createCustomerSlice';
import { formatDZD, formatDateTime } from '../../types/pos';
import type { Customer, PaymentMethodType } from '../../types/pos';
import { calculateCustomerTier, normalizeLoyaltyConfig } from '../../utils/loyaltyEngine';

/** Display-only tier resolution — the cached loyaltyTier string may be stale after renames. */
const resolveCustomerTierName = (customer: Customer): string => {
  try {
    return calculateCustomerTier(
      customer.totalSpent || 0,
      normalizeLoyaltyConfig(usePosStore.getState().receiptSettings?.loyaltyConfig)
    ).name;
  } catch {
    return customer.loyaltyTier || 'Bronze';
  }
};
import { useToast } from '../ui/Toast';
import { openWhatsApp } from '../../utils/phoneUtils';
import { soundEngine } from '../../utils/audioFeedback';
import { printCoordinator } from '../../utils/printCoordinator';
import { isMobileDevice, isTauriEnvironment } from '../../utils/platform';
import { verifyManagerGate } from '../../utils/pinGate';

export const DebtLedgerModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    customers,
    customerDebts,
    recordCustomerDebtPayment,
    updateCustomer,
    // Phase 1: manager checks route through the native gate (no local
    // verifyManagerPin reads here — see utils/pinGate).
    receiptSettings,
    activeShift,
  } = usePosStore();
  // Part 1 seller rule for the statement slip (shift opener, never fallback).
  const debtSeller =
    (activeShift?.openedBy || '').trim() ||
    (activeShift?.cashierName || '').trim() ||
    'Caisse Principale';

  const { showToast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'overdue' | 'high_debt' | 'over_limit'>('all');
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);

  // Debounced search: input stays instant, the full-list scan runs 200ms after
  // the last keystroke instead of on every keypress.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

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

  // Statement print target (rendered, then printed via the debt channel).
  const [printingCustomer, setPrintingCustomer] = useState<Customer | null>(null);

  // ══════════════════════════════════════════════════════════════
  // AGGREGATIONS & METRICS
  // ══════════════════════════════════════════════════════════════
  const allIndebted = useMemo(() => {
    return (customers || []).filter((c) => (c.currentDebt || 0) > 0);
  }, [customers]);

  const totalOutstandingDebt = allIndebted.reduce((sum, c) => sum + (c.currentDebt || 0), 0);
  const totalCreditLimits = allIndebted.reduce((sum, c) => sum + (c.debtLimit ?? DEFAULT_CREDIT_LIMIT), 0);
  const overLimitCount = allIndebted.filter((c) => (c.currentDebt || 0) >= (c.debtLimit ?? DEFAULT_CREDIT_LIMIT)).length;

  // customerId -> history rows, built once per customerDebts identity.
  // Previously each rendered row ran a full filter over the ledger (O(rows*N)).
  const historyByCustomerId = useMemo(() => {
    const map = new Map<string, typeof customerDebts>();
    for (const entry of customerDebts || []) {
      const key = entry.customerId;
      const bucket = map.get(key);
      if (bucket) bucket.push(entry);
      else map.set(key, [entry]);
    }
    return map;
  }, [customerDebts]);

  const filteredDebtors = useMemo(() => {
    const q = foldForSearch(debouncedSearch.trim());
    let list = !q
      ? [...allIndebted]
      : allIndebted.filter(
          (c) =>
            foldForSearch(c.name).includes(q) ||
            (c.phone || '').includes(debouncedSearch.trim()) ||
            foldForSearch(c.registeredDevice).includes(q)
        );

    if (filterType === 'over_limit') {
      list = list.filter((c) => (c.currentDebt || 0) >= (c.debtLimit ?? DEFAULT_CREDIT_LIMIT));
    } else if (filterType === 'high_debt') {
      list = list.filter((c) => (c.currentDebt || 0) >= 20000);
    }

    return list.sort((a, b) => (b.currentDebt || 0) - (a.currentDebt || 0));
  }, [allIndebted, debouncedSearch, filterType]);

  useEffect(() => { if (activeModal !== 'debt_ledger') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  // ══════════════════════════════════════════════════════════════
  // FOCUS MANAGEMENT (WCAG 2.4.3 — defect I6)
  // Capture the trigger, move focus into the ledger on open, keep Tab
  // inside the topmost panel, restore the trigger on close. Escape keeps
  // its shipped behaviour (closes the whole stack) — see the effect above.
  // ══════════════════════════════════════════════════════════════
  const modalRootRef = useRef<HTMLDivElement>(null);
  const versementRootRef = useRef<HTMLDivElement>(null);
  const plafondRootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (activeModal !== 'debt_ledger') return;
    const trigger = document.activeElement;
    triggerRef.current = trigger instanceof HTMLElement ? trigger : null;
    // After paint: the overlay is mounted, so the input can take focus.
    const focusTimer = window.setTimeout(() => searchInputRef.current?.focus(), 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // The sub-panels are nested in the overlay, so the topmost one owns
      // the trap: Tab can never reach the (visually inert) ledger behind.
      const panel = plafondRootRef.current ?? versementRootRef.current ?? modalRootRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.tabIndex !== -1 && el.getClientRects().length > 0
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeModal, closeModal]);

  // Restore focus to whatever opened the ledger once it unmounts.
  useEffect(() => {
    if (activeModal === 'debt_ledger') return;
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger && document.contains(trigger)) trigger.focus();
  }, [activeModal]);

  if (activeModal !== 'debt_ledger') return null;

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
    const amount = Math.round(parseLocalizedAmount(paymentAmount));
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('Veuillez saisir un montant de versement valide.', 'warning');
      return;
    }

    setIsProcessing(true);
    const debtPaymentResult = await recordCustomerDebtPayment(
      payingCustomer.id,
      amount,
      paymentMethod,
      paymentNotes
    );
    setIsProcessing(false);

    if (debtPaymentResult.success) {
      soundEngine.playSuccess();
      // recordCustomerDebtPayment clamps to the outstanding debt: surface the
      // applied amount + change explicitly instead of silently converting.
      const { appliedAmount, changeDue } = debtPaymentResult as typeof debtPaymentResult & {
        appliedAmount?: number;
        changeDue?: number;
      };
      showToast(
        (changeDue || 0) > 0
          ? `Versement enregistré : ${formatDZD(appliedAmount ?? amount)} appliqués — monnaie à rendre : ${formatDZD(changeDue || 0)}.`
          : `Versement de ${formatDZD(amount)} enregistré avec succès !`,
        'success'
      );
      setPayingCustomer(null);
    } else {
      soundEngine.playError();
      showToast('Erreur lors de l\'enregistrement du versement.', 'error');
    }
  };

  const handleSendWhatsAppReminder = async (customer: Customer) => {
    const debt = customer.currentDebt || 0;
    const msg = `*RELEVÉ DE COMPTE CLIENT - MOBI POS*\n*Client :* ${customer.name}\n*Date :* ${new Date().toLocaleDateString('fr-DZ')}\n\nBonjour, nous vous informons que le solde de votre compte présente un encours de *${formatDZD(debt)}*.\n\nMerci de bien vouloir passer en boutique pour régulariser votre situation.\nCordialement,\n*L'Équipe MobiPOS*`;
    const ok = await openWhatsApp(customer.phone, msg);
    if (!ok) {
      showToast("Impossible d'ouvrir WhatsApp", 'error');
    }
  };

  const handlePrintStatement = async (customer: Customer) => {
    setPrintingCustomer(customer);
    const inTauri = isTauriEnvironment();
    const onMobile = isMobileDevice();

    // Mobile app: no window.print route — thermal ESC/POS bytes first
    // (BT/Wi-Fi), Android sheet fallback via the shared text twin.
    if (inTauri && onMobile) {
      try {
        const { SavPrintCoordinator } = await import('../../utils/savPrintCoordinator');
        const debts = (customerDebts || []).filter((d) => d.customerId === customer.id);
        const via = await SavPrintCoordinator.printDebtStatement(customer, debts, receiptSettings);
        showToast(
          via === 'thermal'
            ? `Relevé thermique imprimé pour ${customer.name}.`
            : via === 'sheet'
              ? `🖨️ Feuille d'impression Android ouverte pour ${customer.name}.`
              : `Impression indisponible sur cet appareil.`,
          via === 'failed' ? 'error' : 'success'
        );
      } catch {
        showToast(`Impression indisponible sur cet appareil.`, 'error');
      }
      return;
    }

    // Thermal ticket first (activates DebtStatementTicketBuilder); fall back
    // to the existing A4 debt_statement channel when no thermal route answers.
    const { SavPrintCoordinator } = await import('../../utils/savPrintCoordinator');
    const debts = (customerDebts || []).filter((d) => d.customerId === customer.id);
    const via = await SavPrintCoordinator.printDebtStatement(customer, debts, receiptSettings);
    if (via === 'thermal') {
      showToast(`Relevé thermique imprimé pour ${customer.name}.`, 'success');
      return;
    }
    // Browser: coordinated channel print. Desktop app: direct channel print
    // (the coordinator stays silent in Tauri — no hardware route exists for
    // statements — so bypass it and call window.print ourselves).
    if (inTauri) {
      printCoordinator.printChannelDirect('debt_statement', 200);
    } else {
      printCoordinator.printDebtStatement(200);
    }
    showToast(`Impression du relevé de compte lancée pour ${customer.name}.`, 'info');
  };

  const handleSaveNewLimit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustingCustomer) return;
    // Phase 1: native gate (fail-closed); Locked shows the countdown.
    const gate = await verifyManagerGate(managerPin);
    if (!gate.ok) {
      showToast(
        gate.locked
          ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
          : 'Code PIN Manager incorrect.',
        'error'
      );
      soundEngine.playError();
      return;
    }

    const newLimit = Math.round(parseLocalizedAmount(newLimitInput));
    if (!Number.isFinite(newLimit) || newLimit < 0) {
      showToast('Plafond invalide.', 'warning');
      return;
    }

    // updateCustomer resolves {success, reason?} on the new contract and void
    // on the old one — handle both without narrowing the store signature.
    const limitResult = (await updateCustomer(adjustingCustomer.id, { debtLimit: newLimit })) as unknown as
      | { success?: boolean; reason?: string }
      | void;
    if (limitResult && typeof limitResult === 'object' && 'success' in limitResult && limitResult.success === false) {
      soundEngine.playError();
      showToast(
        `Échec de la mise à jour du plafond${limitResult.reason ? ` : ${limitResult.reason}` : '.'}`,
        'error'
      );
      return;
    }
    showToast(`Nouveau plafond de ${formatDZD(newLimit)} appliqué à ${adjustingCustomer.name}.`, 'success');
    soundEngine.playSuccess();
    setAdjustingCustomer(null);
    setManagerPin('');
  };

  return (
    <div
      ref={modalRootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="kredy-modal-title"
      data-testid="kredy-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-900/50 backdrop-blur-sm select-none"
    >
      <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-2xl bg-pos-panel border border-pos-border shadow-2xl overflow-hidden animate-in zoom-in-95">
        {/* ══════════════════════════════════════════════════════════════ */}
        {/* HEADER */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="px-6 py-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center text-white shadow-lg shadow-rose-500/20 shrink-0">
              <CreditCard className="w-5 h-5 sm:w-6 sm:h-6 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <h2 id="kredy-modal-title" className="text-xs sm:text-base font-black text-pos-text uppercase tracking-wider truncate">
                  Grand Livre Dettes Clients (Kredy)
                </h2>
                <span className="px-2 py-0.2 rounded-full bg-rose-500/15 border border-rose-500/30 text-rose-300 font-bold text-[10px] sm:text-xs shrink-0">
                  {allIndebted.length} Débiteurs
                </span>
              </div>
              <p className="text-[11px] text-pos-muted hidden sm:block">
                Suivi des encours, règlements, relances WhatsApp et gestion des plafonds autorisés
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TOP METRICS CARDS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="px-6 py-4 border-b border-pos-border bg-pos-bg grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
          <div data-testid="kredy-card-encours" className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
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

          <div data-testid="kredy-card-debiteurs" className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
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

          <div data-testid="kredy-card-plafond-depasse" className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
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

          <div data-testid="kredy-card-plafond-global" className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
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
        <div className="px-6 py-3.5 border-b border-pos-border bg-pos-panel flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-1.5 overflow-x-auto overscroll-contain pb-1 text-xs w-full sm:w-auto">
            <button
              data-testid="kredy-tab-tous"
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
              data-testid="kredy-tab-plafond"
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
              data-testid="kredy-tab-elevees"
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
              ref={searchInputRef}
              data-testid="kredy-search"
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
        <div className="flex-1 overflow-y-auto overscroll-contain p-6 space-y-6">
          {filteredDebtors.length === 0 ? (
            <div data-testid="kredy-empty" className="p-12 text-center bg-pos-card border border-pos-border rounded-2xl space-y-3">
              <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto opacity-60" />
              <h3 className="font-bold text-sm text-pos-text">Aucun débiteur dans cette catégorie</h3>
              <p className="text-xs text-pos-muted max-w-sm mx-auto">
                Toutes les créances clients sont à jour ou correspondent aux critères sélectionnés.
              </p>
            </div>
          ) : (
            filteredDebtors.map((customer) => {
              const debt = customer.currentDebt || 0;
              const limit = customer.debtLimit ?? DEFAULT_CREDIT_LIMIT;
              const ratio = Math.min(100, Math.round((debt / limit) * 100));
              const isOver = debt >= limit;
              const isExpanded = expandedCustomerId === customer.id;

              const customerHistory = historyByCustomerId.get(customer.id) || [];

              return (
                <div
                  key={customer.id}
                  data-testid="kredy-row"
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
                            <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-red-500/20 border border-red-500/40 text-red-300 animate-pulse">
                              Plafond Atteint
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-pos-muted">
                          Appareil : {customer.registeredDevice || 'Non spécifié'} • Tarif : {customer.pricingTier} • Rang : {resolveCustomerTierName(customer)}
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
                            data-testid="kredy-bar"
                            className={`h-full rounded-full transition-all duration-300 ${
                              isOver ? 'bg-red-500' : ratio > 75 ? 'bg-amber-500' : 'bg-rose-500'
                            }`}
                            style={{ width: `${ratio}%` }}
                          />
                        </div>
                      </div>

                      <div className="text-right pr-2">
                        <span className="text-[9px] uppercase font-bold text-pos-muted block">Dette Actuelle</span>
                        <span data-testid="kredy-dette" className="text-base font-black text-rose-400 font-mono">{formatDZD(debt)}</span>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 w-full sm:w-auto justify-end">
                        <button
                          onClick={() => handleOpenPayment(customer)}
                          className="min-h-[38px] px-3 py-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-black rounded-xl flex items-center justify-center gap-1 shadow-md transition cursor-pointer active:scale-95 flex-1 sm:flex-none"
                          title="Enregistrer un versement / remboursement"
                        >
                          <DollarSign className="w-3.5 h-3.5" />
                          <span>Versement</span>
                        </button>

                        <button
                          onClick={() => handleSendWhatsAppReminder(customer)}
                          className="min-h-[38px] min-w-[38px] p-2 bg-pos-bg hover:bg-emerald-500/20 border border-pos-border hover:border-emerald-500/40 text-emerald-400 rounded-xl transition cursor-pointer flex items-center justify-center active:scale-95"
                          aria-label="Envoyer un rappel de solde via WhatsApp"
                          title="Envoyer un rappel de solde via WhatsApp"
                        >
                          <MessageSquare className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handlePrintStatement(customer)}
                          className="min-h-[38px] min-w-[38px] p-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer flex items-center justify-center active:scale-95"
                          aria-label="Imprimer le relevé de compte 80mm"
                          title="Imprimer le relevé de compte 80mm"
                        >
                          <Printer className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => {
                            setAdjustingCustomer(customer);
                            setNewLimitInput(String(customer.debtLimit ?? DEFAULT_CREDIT_LIMIT));
                          }}
                          className="min-h-[38px] min-w-[38px] p-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer flex items-center justify-center active:scale-95"
                          aria-haspopup="dialog"
                          aria-label="Ajuster le plafond de crédit autorisé (PIN Manager)"
                          title="Ajuster le plafond de crédit autorisé (PIN Manager)"
                        >
                          <Lock className="w-4 h-4 text-cyan-400" />
                        </button>

                        <button
                          onClick={() => setExpandedCustomerId(isExpanded ? null : customer.id)}
                          className="min-h-[38px] min-w-[38px] p-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer flex items-center justify-center active:scale-95"
                          data-testid="kredy-expand"
                          aria-expanded={isExpanded}
                          aria-label="Voir l'historique des opérations"
                          title="Voir l'historique des opérations"
                        >
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Expandable History Timeline */}
                  {isExpanded && (
                    <div data-testid="kredy-historique" className="p-4 border-t border-pos-border bg-pos-bg space-y-2 animate-in fade-in">
                      <div className="flex items-center justify-between pb-1 border-b border-pos-border">
                        <h5 className="text-xs font-bold text-pos-muted uppercase tracking-wider flex items-center gap-1.5">
                          <History className="w-3.5 h-3.5 text-rose-400" /> Historique des Écritures ({customerHistory.length}) :
                        </h5>
                      </div>

                      {customerHistory.length === 0 ? (
                        <p className="text-xs text-pos-muted py-2 italic">Aucun mouvement enregistré dans le grand livre.</p>
                      ) : (
                        <div className="divide-y divide-pos-border/40 font-mono text-xs max-h-48 overflow-y-auto overscroll-contain pr-1">
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
          <div
            ref={versementRootRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="kredy-versement-title"
            data-testid="kredy-versement-modal"
            className="fixed inset-0 bg-black/90 backdrop-blur-md z-[60] flex items-center justify-center p-4"
          >
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col">
              <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
                    <DollarSign className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 id="kredy-versement-title" className="font-black text-sm text-pos-text">Enregistrer un Versement</h3>
                    <p className="text-[10px] text-pos-muted">Client : {payingCustomer.name}</p>
                  </div>
                </div>
                <button
                  onClick={() => setPayingCustomer(null)}
                  aria-label="Fermer l'encaissement du versement"
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
                  {(() => {
                    const entered = parseLocalizedAmount(paymentAmount);
                    const outstanding = payingCustomer.currentDebt || 0;
                    if (!isNaN(entered) && entered > outstanding && outstanding > 0) {
                      return (
                        <p className="mt-1.5 text-[11px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1.5">
                          ⚠️ Montant supérieur à la dette ({formatDZD(outstanding)}) — seuls{' '}
                          {formatDZD(outstanding)} seront appliqués, monnaie à rendre :{' '}
                          {formatDZD(Math.round(entered - outstanding))}. Le surplus n'est PAS converti en
                          avoir sans confirmation.
                        </p>
                      );
                    }
                    return null;
                  })()}
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
                        className={`min-h-[48px] py-2 rounded-xl text-xs font-bold border transition cursor-pointer active:scale-95 ${
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
                    data-testid="kredy-submit"
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
          <div
            ref={plafondRootRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="kredy-plafond-title"
            className="fixed inset-0 bg-black/90 backdrop-blur-md z-[60] flex items-center justify-center p-4"
          >
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col">
              <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
                <div className="flex items-center gap-2">
                  <Lock className="w-5 h-5 text-cyan-400" />
                  <h3 id="kredy-plafond-title" className="font-black text-sm text-pos-text">Modifier Plafond de Crédit</h3>
                </div>
                <button
                  onClick={() => setAdjustingCustomer(null)}
                  aria-label="Fermer la modification du plafond"
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
                    step="any"
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
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="current-password"
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
        <div className="px-6 py-3.5 bg-pos-card border-t border-pos-border flex items-center justify-between shrink-0 print:hidden">
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

        {/* Dedicated 80mm Customer Statement Print Template */}
        {printingCustomer && (
          <div className="print-debt-target hidden print:block bg-white text-black p-1 font-mono tabular-nums text-[11px] leading-snug">
            <div className="text-center pb-2 border-b border-dashed border-gray-500">
              <p className="font-extrabold text-sm uppercase tracking-wider">{receiptSettings?.storeName || 'MOBI ACCESSORIES'}</p>
              <p className="font-black text-xs uppercase mt-1">*** RELEVÉ DE COMPTE CLIENT ***</p>
              <p className="text-[10px]">{new Date().toLocaleString('fr-DZ')}</p>
              <p className="text-[10px]">Caisse: {activeShift?.id ? `Caisse ${activeShift.id.slice(-8)}` : 'Caisse Principale'} • Vendeur: {debtSeller}</p>
            </div>
            <div className="py-2 border-b border-dashed border-gray-500">
              <div className="flex justify-between"><span>Client :</span><span className="font-bold">{printingCustomer.name}</span></div>
              <div className="flex justify-between"><span>Tél :</span><span className="font-bold">{printingCustomer.phone || '—'}</span></div>
              <div className="flex justify-between"><span>Plafond :</span><span className="font-bold">{formatDZD(printingCustomer.debtLimit ?? DEFAULT_CREDIT_LIMIT)}</span></div>
            </div>
            <div className="py-2 border-b border-dashed border-gray-500">
              <div className="flex justify-between font-extrabold text-[13px]">
                <span>DETTE ACTUELLE :</span>
                <span>{formatDZD(printingCustomer.currentDebt || 0)}</span>
              </div>
            </div>
            {(historyByCustomerId.get(printingCustomer.id) || []).length > 0 && (
              <div className="py-2 border-b border-dashed border-gray-500">
                <p className="font-bold text-[10px] uppercase mb-1">Dernières opérations :</p>
                {(historyByCustomerId.get(printingCustomer.id) || []).slice(-5).reverse().map((entry) => (
                  <div key={entry.id} className="flex justify-between text-[10px]">
                    <span>
                      {entry.type === 'PAYMENT_SETTLED' ? 'Versement' : 'Dette'} • {entry.createdAt ? formatDateTime(entry.createdAt) : ''}
                      {entry.paymentMethod ? ` • ${entry.paymentMethod}` : ''}
                    </span>
                    <span className="font-bold">
                      {entry.type === 'PAYMENT_SETTLED' ? '-' : '+'}{formatDZD(entry.amount)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="pt-2 text-center">
              <p className="text-[10px]">Merci de régulariser votre situation.</p>
              <p className="text-[10px] mt-1">Signature : ____________________</p>
              <p className="text-[9px] text-gray-600 mt-2">Document généré par Mobi-POS • Vendeur: {debtSeller}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

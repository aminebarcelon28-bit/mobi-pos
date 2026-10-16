import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Users,
  Search,
  Phone,
  MessageSquare,
  X,
  CreditCard,
  UserPlus,
  BookOpen,
  DollarSign,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Wallet,
  ChevronDown,
  ChevronUp,
  History,
  ShieldAlert,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { DEFAULT_CREDIT_LIMIT } from '../../../store/slices/createCustomerSlice';
import { AppTabContent } from '../AppScreenLayout';
import type { Customer, CustomerDebtEntry, PaymentMethodType } from '../../../types/pos';
import { formatDZD, formatDateTime } from '../../../types/pos';
import { soundEngine } from '../../../utils/audioFeedback';
import { normalizeAlgerianPhone, openDialer, openWhatsApp } from '../../../utils/phoneUtils';
import { useToast } from '../../ui/Toast';
import { MoneyInput } from '../../ui/MoneyInput';
import { dinarsToMinor, toLegacyReal } from '../../../utils/money';
import { useTranslation, Bdi } from '../../../i18n';
import { useRegisterMobileBackHandler } from '../../../hooks/useMobileBackNavigation';

// Normalisation diacritique insensible aux accents et à la casse
const foldForSearch = (s: string | undefined | null): string =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

type KredyFilter = 'debtors' | 'over_limit' | 'aging' | 'all';

interface CustomerDebtMeta {
  lastActivityDate?: string;
  daysSinceActivity: number;
  totalMovements: number;
  recentEntries: CustomerDebtEntry[];
}

export const KredyTab: React.FC = () => {
  const { customers, customerDebts, receiptSettings, openModal, recordCustomerDebtPayment } =
    usePosStore();
  const { showToast } = useToast();
  const { t } = useTranslation();

  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<KredyFilter>('debtors');
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);

  // Recherche anti-rebond : champ instantané, filtrage 200 ms après la frappe
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(timer);
  }, [search]);

  // État du modal de règlement de dette
  const [payingCustomer, setPayingCustomer] = useState<Customer | null>(null);
  const [paymentMinor, setPaymentMinor] = useState<number>(0);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('Espèces');
  const [paymentNotes, setPaymentNotes] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const submittingRef = useRef<boolean>(false);
  const paymentEntryId = useRef<string>('');

  useRegisterMobileBackHandler(
    Boolean(payingCustomer),
    () => setPayingCustomer(null),
    'kredy-settlement',
  );

  // Fermeture du modal par la touche Échap
  useEffect(() => {
    if (!payingCustomer) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPayingCustomer(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [payingCustomer]);

  // Indexation chronologique et métadonnées d'ancienneté pour chaque client
  const [referenceTime] = useState(() => Date.now());
  const customerDebtMetaMap = useMemo(() => {
    const map = new Map<string, CustomerDebtMeta>();
    const now = referenceTime;
    const sorted = [...(customerDebts || [])].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    for (const entry of sorted) {
      const existing = map.get(entry.customerId);
      if (!existing) {
        const entryTime = new Date(entry.createdAt).getTime();
        const days = isNaN(entryTime) ? 0 : Math.floor((now - entryTime) / (1000 * 60 * 60 * 24));
        map.set(entry.customerId, {
          lastActivityDate: entry.createdAt,
          daysSinceActivity: Math.max(0, days),
          totalMovements: 1,
          recentEntries: [entry],
        });
      } else {
        existing.totalMovements += 1;
        if (existing.recentEntries.length < 3) {
          existing.recentEntries.push(entry);
        }
      }
    }
    return map;
  }, [customerDebts, referenceTime]);

  // Métriques globales
  const totalOutstandingDebt = useMemo(() => {
    return (customers || []).reduce((acc, c) => acc + (c.currentDebt || 0), 0);
  }, [customers]);

  const debtorsCount = useMemo(() => {
    return (customers || []).filter((c) => (c.currentDebt || 0) > 0).length;
  }, [customers]);

  const overLimitCount = useMemo(() => {
    return (customers || []).filter((c) => {
      const debt = c.currentDebt || 0;
      const limit = c.debtLimit ?? DEFAULT_CREDIT_LIMIT;
      return debt > 0 && debt >= limit;
    }).length;
  }, [customers]);

  const agingCount = useMemo(() => {
    return (customers || []).filter((c) => {
      const debt = c.currentDebt || 0;
      if (debt <= 0) return false;
      const meta = customerDebtMetaMap.get(c.id);
      return (meta?.daysSinceActivity ?? 0) >= 30;
    }).length;
  }, [customers, customerDebtMetaMap]);

  // Clients filtrés avec normalisation NFD (nom) et normalisation numérique (téléphone)
  const filteredCustomers = useMemo(() => {
    const q = foldForSearch(debouncedSearch.trim());
    const rawQ = debouncedSearch.trim();
    const digitsQ = rawQ.replace(/\D/g, '');

    return (customers || []).filter((c) => {
      const debt = c.currentDebt || 0;
      const debtLimit = c.debtLimit ?? DEFAULT_CREDIT_LIMIT;
      const isOverLimit = debtLimit > 0 && debt >= debtLimit;
      const meta = customerDebtMetaMap.get(c.id);
      const isAgingOver30 = (meta?.daysSinceActivity ?? 0) >= 30 && debt > 0;

      // Filtres d'onglets
      if (activeFilter === 'debtors' && debt <= 0) return false;
      if (activeFilter === 'over_limit' && (!isOverLimit || debt <= 0)) return false;
      if (activeFilter === 'aging' && !isAgingOver30) return false;

      if (!rawQ) return true;

      // Recherche multi-critère
      const nameMatch = foldForSearch(c.name).includes(q);
      const rawPhoneMatch = (c.phone || '').includes(rawQ);
      const custDigits = (c.phone || '').replace(/\D/g, '');
      const digitsMatch = digitsQ.length >= 2 && custDigits.includes(digitsQ);
      const deviceMatch = foldForSearch(c.registeredDevice).includes(q);

      return nameMatch || rawPhoneMatch || digitsMatch || deviceMatch;
    });
  }, [customers, debouncedSearch, activeFilter, customerDebtMetaMap]);

  // Ouverture du modal de versement
  const handleOpenPayment = useCallback((customer: Customer, e?: React.MouseEvent) => {
    e?.stopPropagation();
    soundEngine.playKeyBeep?.();
    setPayingCustomer(customer);
    const debtDinars = customer.currentDebt || 0;
    // Initialisation exacte en unités mineures entières
    setPaymentMinor(dinarsToMinor(debtDinars));
    setPaymentMethod('Espèces');
    setPaymentNotes('Règlement direct au comptoir');
    paymentEntryId.current = `kredy-pay-${customer.id}-${Date.now()}`;
  }, []);

  // Validation et enregistrement du versement
  const handleConfirmRepayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payingCustomer) return;
    if (submittingRef.current) return;

    if (paymentMinor <= 0) {
      showToast('Veuillez saisir un montant de versement supérieur à 0.', 'warning');
      return;
    }

    submittingRef.current = true;
    setIsProcessing(true);
    try {
      const tenderedDinars = toLegacyReal(paymentMinor);
      const result = await recordCustomerDebtPayment(
        payingCustomer.id,
        tenderedDinars,
        paymentMethod,
        paymentNotes.trim(),
        { entryId: paymentEntryId.current || undefined }
      );

      if (result.success) {
        soundEngine.playSuccess?.();
        const applied =
          result.appliedAmount ?? Math.min(tenderedDinars, payingCustomer.currentDebt || 0);
        const change = result.changeDue ?? Math.max(0, tenderedDinars - applied);
        showToast(
          change > 0
            ? `Versement enregistré : ${formatDZD(applied)} appliqués — monnaie à rendre : ${formatDZD(change)}.`
            : `Versement de ${formatDZD(applied)} enregistré avec succès !`,
          'success'
        );
        setPayingCustomer(null);
      } else {
        soundEngine.playError?.();
        showToast(
          result.reason
            ? `Échec du règlement : ${result.reason}`
            : "Erreur lors de l'enregistrement du versement.",
          'error'
        );
      }
    } catch (err) {
      soundEngine.playError?.();
      console.error('[KredyTab] Debt settlement failed:', err);
      showToast("Erreur inattendue lors de l'enregistrement.", 'error');
    } finally {
      submittingRef.current = false;
      setIsProcessing(false);
    }
  };

  // Expédition instantanée de relevé de compte par WhatsApp
  const handleWhatsApp = async (customer: Customer, e?: React.MouseEvent) => {
    e?.stopPropagation();
    soundEngine.playKeyBeep?.();
    if (!customer.phone) {
      showToast(`Numéro de téléphone non renseigné pour ${customer.name}.`, 'warning');
      return;
    }

    const storeName = receiptSettings?.storeName || 'MobiPOS';
    const storePhone = receiptSettings?.phone ? `\n📞 Contact boutique : ${receiptSettings.phone}` : '';
    const debt = customer.currentDebt || 0;
    const debtLimit = customer.debtLimit ?? DEFAULT_CREDIT_LIMIT;
    const today = new Date().toLocaleDateString('fr-DZ', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    let message = '';
    if (debt > 0) {
      const meta = customerDebtMetaMap.get(customer.id);
      const agingNotice =
        meta?.daysSinceActivity && meta.daysSinceActivity >= 30
          ? `\n⚠️ *Avis d'échéance :* Ce solde est en attente depuis ${meta.daysSinceActivity} jours.`
          : '';

      message =
        `*RELEVÉ DE COMPTE CRÉANCE — ${storeName}*\n` +
        `📅 Date : ${today}\n` +
        `👤 Client : *${customer.name}*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💰 *Solde Restant Dû :* *${formatDZD(debt)}*\n` +
        `🛡️ Plafond autorisé : ${formatDZD(debtLimit)}` +
        `${agingNotice}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Merci de bien vouloir vous rapprocher de notre boutique pour régulariser votre compte.\n` +
        `L'équipe ${storeName}${storePhone}`;
    } else {
      message =
        `*ATTESTATION DE SOLDE À JOUR — ${storeName}*\n` +
        `📅 Date : ${today}\n` +
        `👤 Client : *${customer.name}*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `✅ *Votre compte est parfaitement à jour (Solde : 0 DA).*\n` +
        `Merci pour votre confiance et votre fidélité !\n` +
        `L'équipe ${storeName}${storePhone}`;
    }

    const ok = await openWhatsApp(customer.phone, message);
    if (!ok) {
      showToast("Impossible d'ouvrir WhatsApp sur cet appareil.", 'error');
    }
  };

  // Appel téléphonique direct vers le composeur natif
  const handleCall = async (phone?: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    soundEngine.playKeyBeep?.();
    if (!phone) {
      showToast('Aucun numéro de téléphone disponible', 'warning');
      return;
    }
    const ok = await openDialer(phone);
    if (!ok) {
      showToast("Impossible d'ouvrir le composeur téléphonique", 'error');
    }
  };

  const getOperatorStyle = (operator: string) => {
    switch (operator) {
      case 'Mobilis':
        return 'text-emerald-800 dark:text-emerald-300 bg-emerald-500/10 border-emerald-500/30';
      case 'Djezzy':
        return 'text-amber-800 dark:text-amber-300 bg-amber-500/10 border-amber-500/30';
      case 'Ooredoo':
        return 'text-rose-800 dark:text-rose-300 bg-rose-500/10 border-rose-500/30';
      case 'Fixe':
        return 'text-cyan-800 dark:text-cyan-300 bg-cyan-500/10 border-cyan-500/30';
      default:
        return 'text-pos-muted bg-pos-panel border-pos-border';
    }
  };

  return (
    <AppTabContent
      pinnedTop={
        <div className="px-3.5 pt-3 pb-2.5 space-y-2.5 bg-pos-bg">
          {/* Bannière récapitulative des créances */}
          <div className="bg-gradient-to-br from-amber-500/15 via-pos-card to-pos-panel border border-amber-500/30 rounded-3xl p-4 shadow-sm space-y-2.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-black text-amber-800 dark:text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                <CreditCard className="w-4 h-4 shrink-0" aria-hidden="true" />
                {t.kredy.headerTitle}
              </span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {overLimitCount > 0 && (
                  <span className="text-[10px] font-black px-2 py-0.5 rounded-full pos-status-danger border flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <Bdi>{t('kredy.atCeilingBadge', { count: overLimitCount })}</Bdi>
                  </span>
                )}
                <span className="text-[10px] font-black px-2.5 py-0.5 rounded-full pos-status-warn border">
                  <Bdi>{debtorsCount > 1 ? t('kredy.debtorsCountBadgePlural', { count: debtorsCount }) : t('kredy.debtorsCountBadge', { count: debtorsCount })}</Bdi>
                </span>
              </div>
            </div>

            <div>
              <Bdi mono className="text-3xl font-black text-amber-700 dark:text-amber-400 block tracking-tight">
                {formatDZD(totalOutstandingDebt)}
              </Bdi>
              <span className="text-[11px] text-pos-muted font-medium mt-0.5 block">
                {t.kredy.totalActiveReceivablesSubtitle}
              </span>
            </div>

            {/* Boutons d'accès rapide aux outils globaux */}
            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-amber-500/20">
              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  openModal('debt_ledger');
                }}
                className="min-h-[48px] px-3 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-sm shadow-amber-500/20"
                title={t.kredy.generalLedgerTitle}
              >
                <BookOpen className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{t.kredy.generalLedgerButton}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  openModal('customers');
                }}
                className="min-h-[48px] px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-cyan-400/50 text-cyan-700 dark:text-cyan-400 active-press font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                title={t.kredy.newCustomerTitle}
              >
                <UserPlus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{t.kredy.newCustomerButton}</span>
              </button>
            </div>
          </div>

          {/* Recherche & Filtres ergonomiques */}
          <div className="space-y-2">
            <div className="relative">
              <Search
                className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-pos-muted pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t.kredy.searchPlaceholder}
                className="w-full min-h-[48px] bg-pos-panel border border-pos-border focus:border-amber-400 rounded-xl ps-10 pe-12 py-2 text-base sm:text-xs text-pos-text placeholder-pos-muted focus:outline-none transition-all shadow-xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute end-1.5 top-1/2 -translate-y-1/2 p-1.5 text-pos-muted hover:text-pos-text min-h-[48px] min-w-[48px] flex items-center justify-center active-press cursor-pointer"
                  aria-label={t.common.clearSearch}
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              )}
            </div>

            {/* Piles de filtrage rapide */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
              <button
                type="button"
                onClick={() => setActiveFilter('debtors')}
                className={`min-h-[48px] px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer flex items-center justify-center gap-1.5 shrink-0 active-press ${
                  activeFilter === 'debtors'
                    ? 'bg-amber-500 text-slate-950 font-black shadow-md shadow-amber-500/20'
                    : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                <span>{t('kredy.filterDebtors', { count: debtorsCount })}</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFilter('over_limit')}
                className={`min-h-[48px] px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer flex items-center justify-center gap-1.5 shrink-0 active-press ${
                  activeFilter === 'over_limit'
                    ? 'bg-rose-600 text-white font-black shadow-md shadow-rose-500/20'
                    : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                <span>{t('kredy.filterOverLimit', { count: overLimitCount })}</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFilter('aging')}
                className={`min-h-[48px] px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer flex items-center justify-center gap-1.5 shrink-0 active-press ${
                  activeFilter === 'aging'
                    ? 'bg-orange-500 text-slate-950 font-black shadow-md shadow-orange-500/20'
                    : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                <span>{t('kredy.filterAging', { count: agingCount })}</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFilter('all')}
                className={`min-h-[48px] px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer flex items-center justify-center gap-1.5 shrink-0 active-press ${
                  activeFilter === 'all'
                    ? 'bg-amber-500 text-slate-950 font-black shadow-md shadow-amber-500/20'
                    : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                <span>{t('kredy.filterAll', { count: customers?.length || 0 })}</span>
              </button>
            </div>

            {/* Annonce vocale des résultats */}
            <p aria-live="polite" className="text-[11px] text-pos-muted font-medium px-1">
              {debouncedSearch.trim()
                ? `${filteredCustomers.length} résultat${filteredCustomers.length > 1 ? 's' : ''} pour « ${debouncedSearch.trim()} »`
                : `${filteredCustomers.length} client${filteredCustomers.length > 1 ? 's' : ''} affiché${filteredCustomers.length > 1 ? 's' : ''}`}
            </p>
          </div>
        </div>
      }
      contentClassName="px-3.5 pb-4 select-none"
    >
      {/* Liste des fiches créances clients */}
      <div className="space-y-3 pt-1">
        {filteredCustomers.length === 0 &&
        activeFilter === 'debtors' &&
        debtorsCount === 0 &&
        !debouncedSearch.trim() ? (
          /* État de félicitation : toutes les dettes sont soldées */
          <div className="p-8 my-4 text-center bg-emerald-500/10 border border-emerald-500/30 rounded-3xl flex flex-col items-center justify-center space-y-3 shadow-xs">
            <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="w-8 h-8" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-black text-emerald-800 dark:text-emerald-300">
                {t.kredy.allSettledTitle}
              </p>
              <p className="text-xs text-pos-muted mt-1 max-w-xs mx-auto leading-relaxed">
                {t.kredy.allSettledSubtitle}
              </p>
            </div>
          </div>
        ) : filteredCustomers.length === 0 && debouncedSearch.trim() ? (
          /* État aucun résultat de recherche */
          <div className="p-8 my-4 text-center bg-pos-panel/60 border border-dashed border-pos-border rounded-3xl flex flex-col items-center justify-center space-y-3 shadow-xs">
            <div className="w-14 h-14 rounded-2xl bg-pos-card border border-pos-border flex items-center justify-center text-pos-muted">
              <Search className="w-7 h-7 opacity-60" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-black text-pos-text">{t.common.noResultsFound}</p>
              <p className="text-xs text-pos-muted mt-1">
                {t('kredy.noCustomerMatchesQuery', { query: debouncedSearch.trim() })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSearch('')}
              className="min-h-[48px] px-4 rounded-xl bg-pos-card border border-pos-border hover:border-amber-400 text-amber-700 dark:text-amber-400 text-xs font-bold transition active-press cursor-pointer"
            >
              <span>{t.common.clearSearch}</span>
            </button>
          </div>
        ) : filteredCustomers.length === 0 ? (
          /* État aucun client dans le filtre */
          <div className="p-8 my-4 text-center bg-pos-panel/60 border border-dashed border-pos-border rounded-3xl flex flex-col items-center justify-center space-y-3 shadow-xs">
            <div className="w-14 h-14 rounded-2xl bg-pos-card border border-pos-border flex items-center justify-center text-pos-muted">
              <Users className="w-7 h-7 opacity-60" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-black text-pos-text">{t.kredy.noCustomerInFilterTitle}</p>
              <p className="text-xs text-pos-muted mt-1">
                {activeFilter === 'over_limit'
                  ? t.kredy.noCustomerOverLimitDesc
                  : activeFilter === 'aging'
                    ? t.kredy.noCustomerAgingDesc
                    : t.kredy.noCustomerGenericDesc}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveFilter('debtors')}
              className="min-h-[48px] px-4 rounded-xl bg-pos-card border border-pos-border hover:border-amber-400 text-amber-700 dark:text-amber-400 text-xs font-bold transition active-press cursor-pointer"
            >
              <span>{t.kredy.showAllDebtorsButton}</span>
            </button>
          </div>
        ) : (
          filteredCustomers.map((c) => {
            const debt = c.currentDebt || 0;
            const hasDebt = debt > 0;
            const debtLimit = c.debtLimit ?? DEFAULT_CREDIT_LIMIT;
            const isNearLimit = debtLimit > 0 && debt >= debtLimit * 0.8 && debt < debtLimit;
            const isOverLimit = debtLimit > 0 && debt >= debtLimit;
            const limitUsagePct =
              debtLimit > 0 ? Math.min(100, Math.round((debt / debtLimit) * 100)) : 0;
            const initials = (c.name || 'C').slice(0, 2).toUpperCase();

            const meta = customerDebtMetaMap.get(c.id);
            const isAgingOver30 = (meta?.daysSinceActivity ?? 0) >= 30 && hasDebt;
            const isAgingOver15 = (meta?.daysSinceActivity ?? 0) >= 15 && hasDebt && !isAgingOver30;
            const isExpanded = expandedCustomerId === c.id;

            const phoneInfo = c.phone ? normalizeAlgerianPhone(c.phone) : null;

            return (
              <div
                key={c.id}
                className={`bg-pos-card border rounded-2xl p-4 space-y-3.5 shadow-xs transition-all overflow-hidden ${
                  isOverLimit
                    ? 'border-rose-500/70 shadow-rose-500/5'
                    : isNearLimit
                      ? 'border-amber-500/50'
                      : 'border-pos-border hover:border-amber-500/40'
                }`}
              >
                {/* En-tête : Identité client & Indicateurs de solde */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    {/* Avatar avec initiales */}
                    <div
                      className={`w-11 h-11 rounded-2xl border flex items-center justify-center font-black text-xs shrink-0 shadow-xs ${
                        hasDebt
                          ? 'bg-gradient-to-br from-amber-500/20 to-orange-500/10 border-amber-500/30 text-amber-800 dark:text-amber-300'
                          : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
                      }`}
                    >
                      {initials}
                    </div>

                    <div className="min-w-0">
                      <h4 className="text-sm font-black text-pos-text leading-tight truncate">
                        {c.name}
                      </h4>

                      <div className="flex flex-wrap items-center gap-1.5 mt-1 font-mono">
                        {phoneInfo ? (
                          <>
                            <Bdi mono className="text-[11px] text-pos-muted font-bold">
                              {phoneInfo.formattedDisplay}
                            </Bdi>
                            {phoneInfo.operator !== 'Inconnu' && (
                              <span
                                className={`text-[9px] font-bold px-1.5 py-0.2 rounded border ${getOperatorStyle(
                                  phoneInfo.operator
                                )}`}
                              >
                                {phoneInfo.operator}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-[10px] text-pos-muted/80 italic">
                            {t.kredy.noPhoneRegistered}
                          </span>
                        )}
                      </div>

                      {/* Avoir client disponible si présent */}
                      {c.storeCredit != null && c.storeCredit > 0 && (
                        <div className="mt-1 flex items-center gap-1 text-[10px] font-bold text-cyan-800 dark:text-cyan-300">
                          <Wallet className="w-3 h-3 shrink-0" aria-hidden="true" />
                          <span>{t.kredy.availableStoreCreditPrefix} <Bdi mono>{formatDZD(c.storeCredit)}</Bdi></span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Bloc Montant de dette et Plafond */}
                  <div className="text-end shrink-0">
                    <Bdi
                      mono
                      className={`text-base font-black block tracking-tight ${
                        isOverLimit
                          ? 'text-rose-700 dark:text-rose-400'
                          : hasDebt
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {formatDZD(debt)}
                    </Bdi>

                    <span
                      className={`text-[10px] font-bold block mt-0.5 ${
                        isNearLimit ? 'text-amber-800 dark:text-amber-300' : 'text-pos-muted'
                      }`}
                    >
                      {t.kredy.ceilingPrefix} <Bdi mono>{formatDZD(debtLimit)}</Bdi>
                      {c.debtLimit == null ? ` ${t.kredy.defaultCeilingSuffix}` : ''}
                    </span>

                    {/* Badges d'alerte et d'ancienneté */}
                    <div className="flex flex-col items-end gap-1 mt-1">
                      {hasDebt && (
                        <span
                          className={`inline-block text-[9px] font-black px-2 py-0.5 rounded border ${
                            isOverLimit
                              ? 'pos-status-danger'
                              : isNearLimit
                                ? 'pos-status-warn'
                                : 'bg-pos-panel text-pos-muted border-pos-border'
                          }`}
                        >
                          {isOverLimit
                            ? t.kredy.ceilingReachedPaymentRequired
                            : isNearLimit
                              ? t.kredy.ceilingAlmostReached
                              : t.kredy.toCollectBadge}
                        </span>
                      )}

                      {/* Indicateur de retard d'échéance */}
                      {isAgingOver30 ? (
                        <span className="inline-flex items-center gap-1 text-[9px] font-black px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-800 dark:text-orange-300 border border-orange-500/40">
                          <Clock className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                          <span>{t.kredy.overdueMoreThan30d}</span>
                        </span>
                      ) : isAgingOver15 ? (
                        <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded pos-status-warn border">
                          <Clock className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                          <span>{t.kredy.overdue15To30d}</span>
                        </span>
                      ) : !hasDebt ? (
                        <span className="inline-block text-[9px] font-black px-2 py-0.5 rounded pos-status-ok border">
                          {t.kredy.accountUpToDateBadge}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>

                {/* Jauge visuelle de consommation du plafond */}
                {debtLimit > 0 && (
                  <div
                    role="progressbar"
                    aria-valuenow={limitUsagePct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={t('kredy.ceilingUsedProgressBarAria', { pct: limitUsagePct })}
                    className="h-1.5 rounded-full bg-pos-panel border border-pos-border/60 overflow-hidden"
                  >
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        isOverLimit
                          ? 'bg-rose-500 dark:bg-rose-400'
                          : isNearLimit
                            ? 'bg-amber-500 dark:bg-amber-400'
                            : 'bg-emerald-500 dark:bg-emerald-400'
                      }`}
                      style={{ width: `${limitUsagePct}%` }}
                    />
                  </div>
                )}

                {/* Rangée ergonomique d'actions de communication et d'encaissement — grille 2x2 sur mobile étroit pour zéro débordement */}
                <div className="grid grid-cols-2 sm:flex sm:items-center gap-2 pt-2 border-t border-pos-border/50">
                  {hasDebt && (
                    <button
                      type="button"
                      onClick={(e) => handleOpenPayment(c, e)}
                      aria-label={`${t.kredy.settleAction} — ${c.name}`}
                      className="min-h-[48px] min-w-0 px-3 rounded-xl bg-amber-500/15 border border-amber-500/40 hover:bg-amber-500/25 active:bg-amber-500/35 text-amber-800 dark:text-amber-300 text-xs font-black flex items-center justify-center gap-1.5 transition active-press cursor-pointer shadow-xs sm:shrink-0"
                    >
                      <DollarSign className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0" aria-hidden="true" />
                      <span className="truncate">{t.kredy.settleAction}</span>
                    </button>
                  )}

                  {c.phone ? (
                    <>
                      <button
                        type="button"
                        onClick={(e) => handleCall(c.phone, e)}
                        aria-label={`${t.kredy.callAction} — ${c.name}`}
                        className="sm:flex-1 min-h-[48px] min-w-0 px-3 rounded-xl bg-pos-panel border border-cyan-500/40 hover:bg-cyan-500/10 active:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 text-xs font-bold flex items-center justify-center gap-1.5 transition active-press cursor-pointer shadow-xs"
                      >
                        <Phone className="w-4 h-4 stroke-[2.2] shrink-0" aria-hidden="true" />
                        <span className="truncate">{t.kredy.callAction}</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => handleWhatsApp(c, e)}
                        aria-label={`${t.kredy.whatsAppAction} — ${c.name}`}
                        className="sm:flex-1 min-h-[48px] min-w-0 px-3 rounded-xl bg-emerald-500/15 border border-emerald-500/40 hover:bg-emerald-500/25 active:bg-emerald-500/35 text-emerald-800 dark:text-emerald-300 text-xs font-bold flex items-center justify-center gap-1.5 transition active-press cursor-pointer shadow-xs"
                      >
                        <MessageSquare
                          className="w-4 h-4 text-emerald-700 dark:text-emerald-400 stroke-[2.2] shrink-0"
                          aria-hidden="true"
                        />
                        <span className="truncate">{t.kredy.whatsAppAction}</span>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playKeyBeep?.();
                        openModal('customers');
                      }}
                      className="col-span-2 sm:flex-1 min-h-[48px] min-w-0 px-3 rounded-xl bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer transition active-press"
                    >
                      <UserPlus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{t.kredy.addPhoneNumberButton}</span>
                    </button>
                  )}

                  {/* Bouton dépliant de l'historique rapide */}
                  {meta && meta.totalMovements > 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        soundEngine.playKeyBeep?.();
                        setExpandedCustomerId((prev) => (prev === c.id ? null : c.id));
                      }}
                      aria-label={
                        isExpanded
                          ? `${t('kredy.hideHistoryToggle', { count: meta.totalMovements })} — ${c.name}`
                          : `${t('kredy.showHistoryToggle', { count: meta.totalMovements })} — ${c.name}`
                      }
                      className="min-h-[48px] min-w-0 px-2.5 rounded-xl bg-pos-panel border border-pos-border hover:border-pos-muted text-pos-muted hover:text-pos-text text-xs font-bold flex items-center justify-center gap-1 transition active-press cursor-pointer sm:shrink-0"
                      title={t.kredy.historyToggleTitle}
                    >
                      <History className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate text-[11px]">
                        {isExpanded
                          ? t('kredy.hideHistoryToggle', { count: meta.totalMovements })
                          : t('kredy.showHistoryToggle', { count: meta.totalMovements })}
                      </span>
                      {isExpanded ? (
                        <ChevronUp className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>

                {/* Historique rapide des écritures déplié */}
                {isExpanded && meta && (
                  <div className="pt-2 border-t border-pos-border/40 space-y-2 bg-pos-panel/40 -mx-4 -mb-4 p-3.5 rounded-b-2xl animate-in fade-in">
                    <div className="flex items-center justify-between text-[11px] font-bold text-pos-muted uppercase tracking-wider">
                      <span className="flex items-center gap-1.5">
                        <History className="w-3 h-3 text-amber-700 dark:text-amber-400" aria-hidden="true" />
                        {t('kredy.recentEntriesHeading', { count: meta.totalMovements })}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.playKeyBeep?.();
                          openModal('debt_ledger');
                        }}
                        className="min-h-[48px] px-2 flex items-center text-amber-700 dark:text-amber-400 hover:underline cursor-pointer lowercase"
                      >
                        {t.kredy.openGeneralLedgerLink}
                      </button>
                    </div>

                    <div className="space-y-1.5 font-mono text-xs">
                      {meta.recentEntries.map((entry) => (
                        <div
                          key={entry.id}
                          className="flex items-center justify-between p-2 rounded-xl bg-pos-card border border-pos-border/50 text-[11px]"
                        >
                          <div>
                            <span
                              className={`font-black ${
                                entry.type === 'DEBT_ACQUIRED'
                                  ? 'text-rose-700 dark:text-rose-400'
                                  : 'text-emerald-700 dark:text-emerald-400'
                              }`}
                            >
                              {entry.type === 'DEBT_ACQUIRED' ? t.kredy.creditPurchaseEntry : t.kredy.paymentReceivedEntry}
                            </span>
                            <Bdi className="text-[10px] text-pos-muted block font-sans">
                              {formatDateTime(entry.createdAt)}
                            </Bdi>
                          </div>
                          <div className="text-end">
                            <Bdi mono className="font-black text-pos-text block">
                              {formatDZD(entry.amount)}
                            </Bdi>
                            <span className="text-[10px] text-pos-muted">
                              {t.kredy.balanceAfterPrefix} <Bdi mono>{formatDZD(entry.balanceAfter)}</Bdi>
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* MODAL DE RÈGLEMENT DE DETTE DÉDIÉ (PORTAL TOP-LEVEL)           */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {payingCustomer &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none animate-in fade-in"
            onClick={() => setPayingCustomer(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="kredy-settlement-title"
              onClick={(e) => e.stopPropagation()}
              className="bg-pos-panel border-t sm:border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-md p-5 pb-[max(1.5rem,var(--safe-bottom))] sm:pb-5 space-y-4 shadow-2xl animate-in slide-in-from-bottom-5 max-h-[94dvh] sm:max-h-[92dvh] overflow-y-auto overscroll-contain"
            >
              {/* M3 Standard Drag Handle */}
              <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto -mt-1 mb-2 sm:hidden shrink-0" aria-hidden="true" />

              {/* En-tête du modal */}
              <div className="flex items-center justify-between border-b border-pos-border pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/30 flex items-center justify-center font-bold">
                    <DollarSign className="w-5 h-5" aria-hidden="true" />
                  </div>
                  <div>
                    <h3
                      id="kredy-settlement-title"
                      className="text-sm font-black text-pos-text leading-tight"
                    >
                      {t.kredy.debtSettlementModalTitle}
                    </h3>
                    <p className="text-[11px] text-pos-muted">
                      {t.kredy.debtSettlementModalSubtitle}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setPayingCustomer(null)}
                  aria-label={t.kredy.closeSettlementAria}
                  className="min-h-[48px] min-w-[48px] flex items-center justify-center rounded-xl hover:bg-pos-hover text-pos-muted hover:text-pos-text transition shrink-0 active-press cursor-pointer"
                >
                  <X className="w-5 h-5" aria-hidden="true" />
                </button>
              </div>

              {/* Fiche récapitulative du client sélectionné */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-black text-pos-text">{payingCustomer.name}</p>
                    <p className="text-[10px] text-pos-muted font-mono">
                      {payingCustomer.phone ? (
                        <Bdi mono>{normalizeAlgerianPhone(payingCustomer.phone).formattedDisplay}</Bdi>
                      ) : (
                        t.checkout.noPhoneNumber
                      )}
                    </p>
                  </div>
                  <div className="text-end">
                    <span className="text-[9px] uppercase tracking-wider text-amber-700 dark:text-amber-400 font-bold block">
                      {t.kredy.currentDebtLabel}
                    </span>
                    <Bdi mono className="text-base font-black text-amber-700 dark:text-amber-400">
                      {formatDZD(payingCustomer.currentDebt || 0)}
                    </Bdi>
                  </div>
                </div>

                {/* Indication d'avoir client disponible */}
                {payingCustomer.storeCredit != null && payingCustomer.storeCredit > 0 && (
                  <div className="pt-2 border-t border-pos-border/60 flex items-center justify-between text-[11px]">
                    <span className="text-pos-muted flex items-center gap-1">
                      <Wallet className="w-3 h-3 text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
                      {t.kredy.availableCustomerStoreCredit}
                    </span>
                    <Bdi mono className="font-bold text-cyan-700 dark:text-cyan-400">
                      {formatDZD(payingCustomer.storeCredit)}
                    </Bdi>
                  </div>
                )}
              </div>

              {/* Formulaire de saisie du montant et du mode de versement */}
              <form onSubmit={handleConfirmRepayment} className="space-y-4">
                <div>
                  <div className="flex items-center justify-between gap-2 flex-wrap mb-1.5">
                    <label
                      htmlFor="kredy-payment-amount"
                      className="text-[10px] uppercase font-bold text-pos-muted"
                    >
                      {t.kredy.paymentAmountLabel}
                    </label>

                    {/* Raccourcis de remplissage rapide (48dp touch targets) */}
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          const half = Math.round((payingCustomer.currentDebt || 0) / 2);
                          setPaymentMinor(dinarsToMinor(half));
                        }}
                        className="min-h-[48px] px-3 rounded-xl bg-pos-card border border-pos-border text-pos-text text-xs font-bold hover:border-amber-400 transition cursor-pointer active-press"
                      >
                        {t.kredy.preset50Pct}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPaymentMinor(dinarsToMinor(payingCustomer.currentDebt || 0));
                        }}
                        className="min-h-[48px] px-3 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-800 dark:text-amber-300 text-xs font-black hover:bg-amber-500/25 transition cursor-pointer active-press"
                      >
                        {t.kredy.presetFullAmount}
                      </button>
                    </div>
                  </div>

                  <MoneyInput
                    id="kredy-payment-amount"
                    label={t.kredy.paymentAmountLabel}
                    valueMinor={paymentMinor}
                    onChangeMinor={(minor) => setPaymentMinor(minor)}
                    className="w-full bg-pos-bg border-2 border-pos-border focus:border-amber-400 rounded-xl px-4 py-2.5 text-xl font-black font-mono text-pos-text focus:outline-none transition"
                    placeholder="0"
                    required
                  />
                </div>

                {/* Calcul et prévisualisation du solde restant & monnaie à rendre */}
                {(() => {
                  const debtDinars = payingCustomer.currentDebt || 0;
                  const debtMinor = dinarsToMinor(debtDinars);
                  const appliedMinor = Math.min(paymentMinor, debtMinor);
                  const remainingDebtMinor = Math.max(0, debtMinor - appliedMinor);
                  const changeDueMinor = Math.max(0, paymentMinor - debtMinor);

                  return (
                    <div className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-pos-muted">{t.kredy.amountAppliedToDebt}</span>
                        <Bdi mono className="font-bold text-pos-text">
                          {formatDZD(toLegacyReal(appliedMinor))}
                        </Bdi>
                      </div>

                      <div className="flex items-center justify-between border-t border-pos-border/60 pt-2">
                        <span className="text-pos-muted">{t.kredy.remainingBalanceAfterPayment}</span>
                        {remainingDebtMinor === 0 ? (
                          <span className="text-emerald-700 dark:text-emerald-400 font-black flex items-center gap-1 font-mono">
                            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <Bdi mono>{t.kredy.settledZeroBadge}</Bdi>
                          </span>
                        ) : (
                          <Bdi mono className="font-black text-amber-700 dark:text-amber-400">
                            {formatDZD(toLegacyReal(remainingDebtMinor))}
                          </Bdi>
                        )}
                      </div>

                      {/* Alerte si le montant versé dépasse la dette totale */}
                      {changeDueMinor > 0 && (
                        <div className="mt-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-300 text-[11px] leading-relaxed">
                          <p className="font-bold flex items-center gap-1 text-amber-700 dark:text-amber-400">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                            <span>{t('kredy.overpaymentWarningTitle', { debt: formatDZD(debtDinars) })}</span>
                          </p>
                          <p className="mt-0.5">
                            {t('kredy.overpaymentWarningBody', { debt: formatDZD(debtDinars) })}{' '}
                            <strong className="text-amber-900 dark:text-amber-200">
                              {t.kredy.changeDueToCustomerPrefix} <Bdi mono>{formatDZD(toLegacyReal(changeDueMinor))}</Bdi>
                            </strong>
                            .
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Sélection du mode de règlement */}
                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1.5">
                    {t.kredy.paymentMethodLabel}
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['Espèces', 'BaridiMob', 'Chèque'] as PaymentMethodType[]).map((meth) => (
                      <button
                        key={meth}
                        type="button"
                        onClick={() => setPaymentMethod(meth)}
                        className={`min-h-[48px] py-2 px-2 rounded-xl text-xs font-bold border transition cursor-pointer active-press flex items-center justify-center ${
                          paymentMethod === meth
                            ? 'bg-amber-500 text-slate-950 border-amber-400 font-black shadow-sm'
                            : 'bg-pos-card text-pos-muted border-pos-border hover:text-pos-text'
                        }`}
                      >
                        {meth === 'Espèces'
                          ? t.kredy.methodCash
                          : meth === 'BaridiMob'
                          ? t.kredy.methodBaridiMob
                          : t.kredy.methodCheck}
                      </button>
                    ))}
                  </div>
                  {paymentMethod === 'Espèces' && (
                    <p className="text-[10px] text-pos-muted mt-1 px-1">
                      {t.kredy.cashRecordedInDrawerHint}
                    </p>
                  )}
                </div>

                {/* Justificatif / Note facultative */}
                <div>
                  <label
                    htmlFor="kredy-payment-note"
                    className="text-[10px] uppercase font-bold text-pos-muted block mb-1"
                  >
                    {t.kredy.paymentNoteLabel}
                  </label>
                  <input
                    id="kredy-payment-note"
                    type="text"
                    value={paymentNotes}
                    onChange={(e) => setPaymentNotes(e.target.value)}
                    placeholder={t.kredy.paymentNotePlaceholder}
                    className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs text-pos-text focus:border-amber-400 focus:outline-none"
                  />
                </div>

                {/* Boutons d'action du modal */}
                <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-pos-border">
                  <button
                    type="button"
                    onClick={() => setPayingCustomer(null)}
                    disabled={isProcessing}
                    className="min-h-[48px] px-4 rounded-xl bg-pos-card hover:bg-pos-hover text-pos-muted hover:text-pos-text text-xs font-bold transition active-press cursor-pointer"
                  >
                    {t.common.cancel}
                  </button>

                  <button
                    type="submit"
                    disabled={isProcessing || paymentMinor <= 0}
                    className="min-h-[48px] px-5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-black text-xs flex items-center justify-center gap-2 transition active-press cursor-pointer shadow-md shadow-amber-500/20"
                  >
                    <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>
                      {isProcessing
                        ? t.common.saving
                        : paymentMinor >= dinarsToMinor(payingCustomer.currentDebt || 0)
                          ? t.kredy.settleFullDebtButton
                          : t.kredy.confirmPaymentButton}
                    </span>
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}
    </AppTabContent>
  );
};

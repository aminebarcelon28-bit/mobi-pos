import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { createPortal } from 'react-dom';
import {
  X, User, Star, Phone, Mail, Check, Plus, Edit2, Trash2, Search,
  CheckCircle2, TrendingUp, ShoppingBag, CreditCard, Award,
  UserPlus, History, Crown, FileText, MessageSquare, DollarSign,
  ArrowDownLeft, ArrowUpRight, Copy, ExternalLink, MoreHorizontal,
  Wrench, Smartphone, Ticket, AlertCircle, RefreshCw, Tag
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import type { Customer, PricingTier, SaleTransaction, PaymentMethodType, RepairOrder, TradeInItem, CreditVoucher, CustomerDebtEntry } from '../../types/pos';
import { calculateNextTierProgress, calculateCustomerTier, normalizeLoyaltyConfig, STORE_CREDIT_PIN_THRESHOLD_DZD, convertPointsToCredit } from '../../utils/loyaltyEngine';
import { normalizeAlgerianPhone, openWhatsApp } from '../../utils/phoneUtils';
import { toLegacyReal, dinarsToMinor } from '../../utils/money';
import { MoneyInput } from '../ui/MoneyInput';
import { DzPhoneInput } from '../ui/DzPhoneInput';
import { useToast } from '../ui/Toast';
import { Kbd } from '../../design-system/desktop/Kbd';
import { PriceBooksModal } from './PriceBooksModal';

const foldForSearch = (s: string | undefined | null): string =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

type SortField = 'name' | 'loyaltyPoints' | 'storeCredit' | 'totalSpent';
type SortDir = 'asc' | 'desc';
type ViewMode = 'list' | 'form' | 'profile';
type TierFilter = 'Tous' | PricingTier;
type ProfileSubTab = 'purchases' | 'repairs' | 'tradeins' | 'vouchers' | 'debt' | 'loyalty';

export const CustomersModal: React.FC = () => {
  const { showToast } = useToast();
  const {
    activeModal, closeModal, openModal, customers, currentCustomer, setCurrentCustomer,
    addCustomer, updateCustomer, deleteCustomer, transactions, receiptSettings,
    customerDebts, recordCustomerDebtPayment,
    repairOrders, tradeIns, creditVouchers,
    issueStoreCredit, redeemLoyaltyPoints, adjustCustomerPoints
  } = usePosStore();

  const [mainTab, setMainTab] = useState<'directory' | 'debts'>('directory');
  // UPGRADE-04: dedicated management surface for contract price books.
  const [isPriceBooksOpen, setIsPriceBooksOpen] = useState(false);
  const [profileTab, setProfileTab] = useState<ProfileSubTab>('purchases');
  const [searchQuery, setSearchQuery] = useState('');
  // Debounced scan input: the text field stays instant, list filtering follows 200ms later.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const [successMsg, setSuccessMsg] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<TierFilter>('Tous');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [profileCustomer, setProfileCustomer] = useState<Customer | null>(null);

  // Form return stack: saving/cancelling from a profile returns to that profile.
  const [formOrigin, setFormOrigin] = useState<{ view: ViewMode; profileId: string | null }>({ view: 'list', profileId: null });

  // Portaled overflow menus (card ••• + profile •••) — portaled-menu pattern:
  // fixed position from the anchor with auto flip, viewport clamp, and dismiss
  // on outside click / Escape / scroll / resize, with focus management.
  const [cardMenuId, setCardMenuId] = useState<string | null>(null);
  const [cardMenuPos, setCardMenuPos] = useState({ top: 0, left: 0, openUp: false });
  const cardMenuAnchors = useRef(new Map<string, HTMLButtonElement>());
  const cardMenuRef = useRef<HTMLDivElement>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileMenuPos, setProfileMenuPos] = useState({ top: 0, left: 0, openUp: false });
  const profileMenuAnchorRef = useRef<HTMLButtonElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  // Menus anchor into scrolling content: any navigation invalidates them.
  const dismissMenus = () => {
    setCardMenuId(null);
    setProfileMenuOpen(false);
  };

  // Debt Payment & WhatsApp State
  const [debtPaymentCustomer, setDebtPaymentCustomer] = useState<Customer | null>(null);
  const [debtPaymentAmount, setDebtPaymentAmount] = useState<number>(0);
  const [debtPaymentMethod, setDebtPaymentMethod] = useState<PaymentMethodType>('Espèces');
  const [debtPaymentNotes, setDebtPaymentNotes] = useState<string>('');
  // Synchronous reentrancy latch (double-submit race guard — same rationale
  // as DebtLedgerModal.submittingRef): state-only guards flip after the next
  // render, so burst clicks all proceed. This ref flips synchronously.
  const debtPayLatch = useRef(false);
  // Per-open idempotency key (KREDY-02 pattern): repeats of one intent share
  // the ledger row id AND the deterministic drawer id (MOV-DEBT-<entry>),
  // collapsing via upsert instead of doubling.
  const debtPayEntryId = useRef('');
  const [whatsappDebtCustomer, setWhatsappDebtCustomer] = useState<Customer | null>(null);
  const [whatsappCopied, setWhatsappCopied] = useState(false);

  // Form State
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [registeredDevice, setRegisteredDevice] = useState('');
  const [pricingTier, setPricingTier] = useState<PricingTier>('Retail');
  const [debtLimit, setDebtLimit] = useState<string>('');

  // Customer 360 Action Dialogs State
  const [creditModalOpen, setCreditModalOpen] = useState(false);
  const [creditAmount, setCreditAmount] = useState<number>(0);
  const [creditManagerPin, setCreditManagerPin] = useState<string>('');

  const [redeemModalOpen, setRedeemModalOpen] = useState(false);
  const [redeemPoints, setRedeemPoints] = useState<number>(0);

  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [adjustPoints, setAdjustPoints] = useState<number>(0);
  const [adjustReason, setAdjustReason] = useState<string>('');

  // Input ref for auto-focusing search on F3
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeModal === 'customers' && viewMode === 'list') {
      const timer = setTimeout(() => {
        if (searchInputRef.current) {
          searchInputRef.current.focus();
          searchInputRef.current.select();
        }
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [activeModal, viewMode]);

  // Shared anchor placement: flip upward near the bottom edge, clamp to viewport.
  const placeAnchoredMenu = (
    anchor: HTMLButtonElement | null | undefined,
    setPos: React.Dispatch<React.SetStateAction<{ top: number; left: number; openUp: boolean }>>,
    menuHeightEst: number,
    menuWidth = 264,
  ) => {
    const r = anchor?.getBoundingClientRect();
    if (!r) return;
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < menuHeightEst + 16;
    const top = openUp
      ? Math.max(8, r.top - menuHeightEst - 8)
      : Math.min(r.bottom + 8, window.innerHeight - 16);
    const isMobile = window.innerWidth < 640;
    const left = isMobile
      ? 8
      : Math.max(8, Math.min(r.right - menuWidth, window.innerWidth - menuWidth - 8));
    setPos({ top, left, openUp });
  };

  // Portaled card ••• menu: position + dismiss + focus management.
  useEffect(() => {
    if (!cardMenuId) return;
    const place = () => placeAnchoredMenu(cardMenuAnchors.current.get(cardMenuId), setCardMenuPos, 220);
    place();
    const handleClickOutside = (event: MouseEvent) => {
      const t = event.target as Node;
      const anchor = cardMenuAnchors.current.get(cardMenuId);
      if (
        cardMenuRef.current && !cardMenuRef.current.contains(t) &&
        anchor && !anchor.contains(t)
      ) {
        setCardMenuId(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCardMenuId(null);
        cardMenuAnchors.current.get(cardMenuId)?.focus();
      }
    };
    const handleScroll = () => setCardMenuId(null);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', place);
    // Capture phase: any inner scroll (card list) invalidates the anchor.
    window.addEventListener('scroll', handleScroll, true);
    cardMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [cardMenuId]);

  // Portaled profile ••• menu: position + dismiss + focus management.
  useEffect(() => {
    if (!profileMenuOpen) return;
    const place = () => placeAnchoredMenu(profileMenuAnchorRef.current, setProfileMenuPos, 140);
    place();
    const handleClickOutside = (event: MouseEvent) => {
      const t = event.target as Node;
      const anchor = profileMenuAnchorRef.current;
      if (
        profileMenuRef.current && !profileMenuRef.current.contains(t) &&
        anchor && !anchor.contains(t)
      ) {
        setProfileMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setProfileMenuOpen(false);
        profileMenuAnchorRef.current?.focus();
      }
    };
    const handleScroll = () => setProfileMenuOpen(false);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', handleScroll, true);
    profileMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [profileMenuOpen]);

  // Stacked Escape dismissal: innermost overlay first, main modal last.
  // (Overflow menus self-dismiss with anchor refocus, so they are skipped here.)
  useEffect(() => {
    if (activeModal !== 'customers') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (whatsappDebtCustomer) { setWhatsappDebtCustomer(null); return; }
      if (debtPaymentCustomer) { setDebtPaymentCustomer(null); return; }
      if (cardMenuId || profileMenuOpen) return;
      closeModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activeModal, whatsappDebtCustomer, debtPaymentCustomer, cardMenuId, profileMenuOpen, closeModal]);

  // UPGRADE-01: full-history read on open — per-customer money stats must not
  // silently shrink to the newest 200 tickets. One read per modal opening
  // (released on close); never part of the boot/pull lane.
  const [allTxns, setAllTxns] = useState<SaleTransaction[] | null>(null);
  useEffect(() => {
    if (activeModal !== 'customers') {
      setAllTxns(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const { sqliteAdapter } = await import('../../db/sqliteAdapter');
        const list = await sqliteAdapter.getTransactionsByDateRange({});
        if (alive) setAllTxns(list);
      } catch (e) {
        console.warn('[customers] full history read failed, using window:', e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeModal]);

  // Pre-calculate customer metrics lookup map once to avoid O(N * M) recalculation during render
  const customerMetricsMap = useMemo(() => {
    const map = new Map<string, {
      totalSpent: number;
      totalOrders: number;
      avgBasket: number;
      lastPurchase: string | null;
      transactions: typeof transactions;
    }>();
    const source = allTxns ?? transactions;
    if (!source) return map;

    for (const t of source) {
      const custId = t.customer?.id;
      if (!custId) continue;
      let entry = map.get(custId);
      if (!entry) {
        entry = { totalSpent: 0, totalOrders: 0, avgBasket: 0, lastPurchase: null, transactions: [] };
        map.set(custId, entry);
      }
      entry.transactions.push(t);
      if (t.status !== 'VOIDED' && !t.isRefund) {
        entry.totalSpent += (t.total || 0);
      }
      entry.totalOrders += 1;
      if (!entry.lastPurchase && t.createdAt) {
        entry.lastPurchase = t.createdAt;
      }
    }

    for (const entry of map.values()) {
      entry.avgBasket = entry.totalOrders > 0 ? entry.totalSpent / entry.totalOrders : 0;
    }

    return map;
  }, [allTxns, transactions]);

  const defaultMetrics = useMemo(() => ({
    totalSpent: 0,
    totalOrders: 0,
    avgBasket: 0,
    lastPurchase: null as string | null,
    transactions: [] as NonNullable<typeof transactions>,
  }), []);

  // Compute customer metrics from transaction history via O(1) Map lookup
  const getCustomerMetrics = React.useCallback((customerId: string) => {
    return customerMetricsMap.get(customerId) || defaultMetrics;
  }, [customerMetricsMap, defaultMetrics]);

  const activeProfile = useMemo(() => {
    if (!profileCustomer) return null;
    return (customers || []).find(c => c.id === profileCustomer.id) || profileCustomer;
  }, [customers, profileCustomer]);

  const customerPurchases = useMemo(() => {
    if (!activeProfile) return [];
    return (allTxns ?? transactions ?? [])
      .filter(
        t => t.customer?.id === activeProfile.id || (activeProfile.phone && t.customer?.phone === activeProfile.phone)
      )
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  }, [allTxns, transactions, activeProfile]);

  const customerRepairs = useMemo(() => {
    if (!activeProfile) return [];
    const profDigits = normalizeAlgerianPhone(activeProfile.phone).digitsOnly;
    return (repairOrders || [])
      .filter(
        r => r.customerId === activeProfile.id ||
             (profDigits && normalizeAlgerianPhone(r.customerPhone).digitsOnly === profDigits) ||
             (activeProfile.name && r.customerName && r.customerName.toLowerCase() === activeProfile.name.toLowerCase())
      )
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  }, [repairOrders, activeProfile]);

  const customerTradeIns = useMemo(() => {
    if (!activeProfile) return [];
    const profDigits = normalizeAlgerianPhone(activeProfile.phone).digitsOnly;
    return (tradeIns || [])
      .filter(
        t => t.customerId === activeProfile.id ||
             (profDigits && normalizeAlgerianPhone(t.customerPhone).digitsOnly === profDigits) ||
             (activeProfile.name && t.customerName && t.customerName.toLowerCase() === activeProfile.name.toLowerCase())
      )
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  }, [tradeIns, activeProfile]);

  const customerVouchers = useMemo(() => {
    if (!activeProfile) return [];
    const profDigits = normalizeAlgerianPhone(activeProfile.phone).digitsOnly;
    return (creditVouchers || [])
      .filter(
        v => (profDigits && normalizeAlgerianPhone(v.customerPhone).digitsOnly === profDigits) ||
             (activeProfile.name && v.customerName && v.customerName.toLowerCase() === activeProfile.name.toLowerCase())
      )
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  }, [creditVouchers, activeProfile]);

  const customerDebtsFiltered = useMemo(() => {
    if (!activeProfile) return [];
    return (customerDebts || [])
      .filter(d => d.customerId === activeProfile.id)
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  }, [customerDebts, activeProfile]);

  // Filtered & Sorted Customers (hook must be above early return)
  const filteredCustomers = useMemo(() => {
    const lowerQ = foldForSearch(debouncedSearch.trim());
    const rawQ = debouncedSearch.trim();
    let results = !lowerQ
      ? [...(customers || [])]
      : (customers || []).filter(c =>
        foldForSearch(c.name).includes(lowerQ) ||
        (c.phone || '').includes(rawQ) ||
        foldForSearch(c.phone).includes(lowerQ) ||
        foldForSearch(c.email).includes(lowerQ) ||
        foldForSearch(c.registeredDevice).includes(lowerQ)
      );

    if (tierFilter !== 'Tous') {
      results = results.filter(c => c.pricingTier === tierFilter);
    }

    results.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'loyaltyPoints': cmp = (a.loyaltyPoints || 0) - (b.loyaltyPoints || 0); break;
        case 'storeCredit': cmp = (a.storeCredit || 0) - (b.storeCredit || 0); break;
        case 'totalSpent': {
          const aSpent = customerMetricsMap.get(a.id)?.totalSpent ?? a.totalSpent ?? 0;
          const bSpent = customerMetricsMap.get(b.id)?.totalSpent ?? b.totalSpent ?? 0;
          cmp = aSpent - bSpent;
          break;
        }
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return results;
  }, [customers, debouncedSearch, tierFilter, sortField, sortDir, customerMetricsMap]);

  // Virtualization: chunk filtered customers into rows of 2 for grid rendering
  const customerRows = useMemo(() => {
    const chunks: Customer[][] = [];
    for (let i = 0; i < filteredCustomers.length; i += 2) {
      chunks.push(filteredCustomers.slice(i, i + 2));
    }
    return chunks;
  }, [filteredCustomers]);

  const contentBodyRef = useRef<HTMLDivElement>(null);

  const customerRowVirtualizer = useVirtualizer({
    count: customerRows.length,
    getScrollElement: () => contentBodyRef.current,
    estimateSize: () => 200,
    overscan: 6,
  });

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  // Aggregate KPI metrics
  const totalCreditOutstanding = (customers || []).reduce((acc, c) => acc + (c.storeCredit || 0), 0);
  const totalLoyaltyPoints = (customers || []).reduce((acc, c) => acc + (c.loyaltyPoints || 0), 0);
  const totalDebtOutstanding = (customers || []).reduce((acc, c) => acc + (c.currentDebt || 0), 0);
  const indebtedCount = (customers || []).filter(c => (c.currentDebt || 0) > 0).length;
  const wholesaleCount = (customers || []).filter(c => c.pricingTier === 'Wholesale').length;
  const vipCount = (customers || []).filter(c => c.pricingTier === 'VIP').length;

  // Filtered Indebted Customers
  const indebtedCustomers = useMemo(() => {
    const lowerQ = foldForSearch(debouncedSearch.trim());
    const rawQ = debouncedSearch.trim();
    return (customers || []).filter(c =>
      (c.currentDebt || 0) > 0 &&
      (!lowerQ ||
        foldForSearch(c.name).includes(lowerQ) ||
        (c.phone || '').includes(rawQ) ||
        foldForSearch(c.phone).includes(lowerQ) ||
        foldForSearch(c.registeredDevice).includes(lowerQ))
    );
  }, [customers, debouncedSearch]);

  const handleRecordDebtPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!debtPaymentCustomer) return;
    if (debtPayLatch.current) return;
    const amount = debtPaymentAmount;
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('Veuillez saisir un montant valide.');
      return;
    }
    debtPayLatch.current = true;
    try {
      const debtPaymentResult = await recordCustomerDebtPayment(
        debtPaymentCustomer.id,
        amount,
        debtPaymentMethod,
        debtPaymentNotes,
        { entryId: debtPayEntryId.current || undefined }
      );
    if (debtPaymentResult.success) {
      const { appliedAmount, changeDue } = debtPaymentResult as typeof debtPaymentResult & {
        appliedAmount?: number;
        changeDue?: number;
      };
      showSuccess(
        (changeDue || 0) > 0
          ? `Versement enregistré : ${formatDZD(appliedAmount ?? amount)} appliqués — monnaie à rendre : ${formatDZD(changeDue || 0)}.`
          : `Versement de ${formatDZD(amount)} enregistré avec succès !`
      );
      setDebtPaymentCustomer(null);
      setDebtPaymentAmount(0);
      setDebtPaymentNotes('');
    }
    } finally {
      debtPayLatch.current = false;
    }
  };

  const getWhatsAppDebtMessage = (c: Customer) => {
    const storeName = usePosStore.getState().receiptSettings.storeName || 'MOBI ACCESSORIES';
    const storePhone = usePosStore.getState().receiptSettings.phone || '';
    const debtAmount = c.currentDebt || 0;
    return `Salam ${c.name} !\n\nRappel amical de votre boutique *${storeName}* :\n\n📌 *Solde Dette Actuelle :* ${formatDZD(debtAmount)}\n\nVous pouvez passer au magasin pour régler votre solde en espèces. Merci pour votre fidélité !\n\n📞 Contact : ${storePhone}`;
  };

  const resetForm = (updated?: Customer) => {
    setEditingId(null);
    setName('');
    setPhone('');
    setEmail('');
    setRegisteredDevice('');
    setPricingTier('Retail');
    setDebtLimit('');
    dismissMenus();
    // Return to the origin view: editing from a profile goes back to that profile.
    if (formOrigin.view === 'profile' && formOrigin.profileId) {
      const origin = updated && updated.id === formOrigin.profileId
        ? updated
        : (customers || []).find(c => c.id === formOrigin.profileId);
      if (origin) {
        setProfileCustomer(origin);
        setViewMode('profile');
        return;
      }
    }
    setViewMode('list');
  };

  const handleEditClick = (c: Customer) => {
    setFormOrigin({ view: viewMode, profileId: viewMode === 'profile' ? c.id : null });
    dismissMenus();
    setEditingId(c.id);
    setName(c.name);
    setPhone(c.phone);
    setEmail(c.email);
    setRegisteredDevice(c.registeredDevice);
    setPricingTier(c.pricingTier);
    setDebtLimit(c.debtLimit !== undefined && c.debtLimit !== null ? String(c.debtLimit) : '');
    setViewMode('form');
  };

  const handleSaveCustomer = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedDebtLimit = debtLimit.trim() === '' ? undefined : Math.max(0, Number(debtLimit));
    if (editingId) {
      const editNorm = normalizeAlgerianPhone(phone);
      const cleanEditPhone = editNorm.isValid ? editNorm.local : (editNorm.digitsOnly || phone.trim());
      updateCustomer(editingId, { name, phone: cleanEditPhone, email, registeredDevice, pricingTier, debtLimit: parsedDebtLimit });
      showSuccess('Profil client mis à jour avec succès !');
      // Sync the open profile snapshot so the return navigation shows fresh data.
      const target = (customers || []).find(c => c.id === editingId);
      const updated: Customer | undefined = target
        ? { ...target, name, phone: cleanEditPhone, email, registeredDevice, pricingTier, debtLimit: parsedDebtLimit }
        : undefined;
      if (updated) setProfileCustomer(prev => (prev?.id === updated.id ? updated : prev));
      resetForm(updated);
    } else {
      // Intake normalization: canonical local form when valid, else trimmed
      // digit-strip fallback so the ledger never stores formatted noise.
      const norm = normalizeAlgerianPhone(phone);
      const cleanPhone = norm.isValid ? norm.local : (norm.digitsOnly || phone.trim());
      addCustomer({
        name, phone: cleanPhone, email, registeredDevice, pricingTier, debtLimit: parsedDebtLimit, loyaltyPoints: 0, storeCredit: 0
      });
      showSuccess('Nouveau client ajouté au CRM !');
      resetForm();
    }
  };

  const handleDelete = (id: string) => {
    const target = customers.find((c) => c.id === id);
    if (target && (target.currentDebt || 0) > 0) {
      alert(`⚠️ Impossible de supprimer ce client : une dette active de ${target.currentDebt} DA est en cours sur son compte. Veuillez solder ou transférer la créance avant suppression.`);
      return;
    }
    // A positive store credit is a customer asset: require an explicit
    // forfeit note before the delete proceeds (enforced in deleteCustomer).
    let forfeitNote: string | undefined;
    if (target && (target.storeCredit || 0) > 0) {
      const note = window.prompt(
        `⚠️ Ce client possède un Avoir de ${formatDZD(target.storeCredit || 0)} qui sera DÉFINITIVEMENT perdu.\n\nTapez une note de confiscation (motif) pour confirmer, ou Annuler pour garder le client :`
      );
      if (note === null) return;
      if (!note.trim()) {
        alert('Suppression annulée : une note de confiscation explicite est requise pour abandonner un avoir client.');
        return;
      }
      forfeitNote = note.trim();
    }
    if (window.confirm("Êtes-vous sûr de vouloir supprimer définitivement ce client et son historique ?")) {
      (deleteCustomer as (deleteId: string, opts?: { forfeitNote?: string }) => Promise<unknown>)(
        id,
        forfeitNote ? { forfeitNote } : undefined
      );
      if (profileCustomer?.id === id) setProfileCustomer(null);
      dismissMenus();
      setFormOrigin({ view: 'list', profileId: null });
      setViewMode('list');
      showSuccess('Client supprimé du CRM.');
    }
  };

  const openProfile = (c: Customer) => {
    dismissMenus();
    setProfileCustomer(c);
    setViewMode('profile');
  };

  const tierBadge = (tier: PricingTier) => {
    const styles: Record<PricingTier, string> = {
      'Retail': 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      'Wholesale': 'bg-sky-500/15 text-sky-400 border-sky-500/30',
      'VIP': 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    };
    const icons: Record<PricingTier, React.ReactNode> = {
      'Retail': <User className="w-3 h-3" />,
      'Wholesale': <ShoppingBag className="w-3 h-3" />,
      'VIP': <Crown className="w-3 h-3" />,
    };
    const labels: Record<PricingTier, string> = {
      'Retail': 'Détail',
      'Wholesale': 'Gros',
      'VIP': 'Demi-Gros',
    };
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border ${styles[tier]}`}>
        {icons[tier]} {labels[tier] || tier}
      </span>
    );
  };

  const handleSortSelect = (value: string) => {
    const [field, dir] = value.split(':') as [SortField, SortDir];
    setSortField(field);
    setSortDir(dir);
  };

  if (activeModal !== 'customers') return null;

  return (
    <div
      onClick={closeModal}
      role="dialog"
      data-testid="customers-dialog"
      aria-modal="true"
      aria-label="CRM et fichier clients"
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:zoom-in-95 h-[94dvh] sm:h-[90dvh] flex flex-col cursor-default"
      >
        {/* Mobile drag handle */}
        <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" aria-hidden="true" />

        {/* ═══ Header ═══ */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2">
          <div className="flex items-center gap-2.5 text-emerald-400 min-w-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30 shadow-sm shrink-0">
              <User className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-base font-extrabold text-pos-text tracking-wide truncate">
                CRM & FICHIER CLIENTS
              </h2>
              <p className="text-[10px] text-pos-muted truncate hidden xs:block">
                {(customers || []).length} clients enregistrés • Fidélité, Avoirs & Historique
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {viewMode === 'list' && (
              <div className="relative hidden md:flex items-center">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                <input
                  ref={searchInputRef}
                  data-testid="customer-search"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && filteredCustomers.length > 0) {
                      e.preventDefault();
                      const target = filteredCustomers[0];
                      if (target) {
                        setCurrentCustomer(target);
                        showSuccess(`${target.name} sélectionné pour la vente.`);
                        closeModal();
                      }
                    }
                  }}
                  placeholder="Rechercher nom, tél, appareil..."
                  className="bg-pos-bg border border-pos-border rounded-full pl-9 pr-20 py-1.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none w-64 lg:w-80 transition-all shadow-inner"
                />
                {filteredCustomers.length > 0 && searchQuery && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 pointer-events-none">
                    Entrée ↵
                  </span>
                )}
              </div>
            )}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="hidden sm:inline-flex">
                <Kbd size="sm">Esc</Kbd>
              </span>
              <button
                onClick={closeModal}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition shrink-0 cursor-pointer"
                aria-label="Fermer"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        {/* ═══ KPI Summary Bar ═══ */}
        <div className="flex sm:grid sm:grid-cols-5 overflow-x-auto no-scrollbar gap-2 sm:gap-2.5 px-3 sm:px-4 py-2.5 sm:py-3 border-b border-pos-border bg-pos-card/50 shrink-0">
          <div className="min-w-[140px] sm:min-w-0 flex-1 bg-pos-card p-2 sm:p-2.5 rounded-xl border border-pos-border shadow-sm flex items-center gap-2 sm:gap-2.5 shrink-0 sm:shrink">
            <div className="w-8 h-8 rounded-lg bg-sky-500/20 text-sky-400 flex items-center justify-center shrink-0">
              <User className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] text-pos-muted uppercase font-bold block truncate">Total Clients</span>
              <span className="text-sm font-black text-pos-text font-mono num">{(customers || []).length}</span>
            </div>
          </div>

          <div className="min-w-[140px] sm:min-w-0 flex-1 bg-pos-card p-2 sm:p-2.5 rounded-xl border border-pos-border shadow-sm flex items-center gap-2.5 shrink-0 sm:shrink">
            <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
              <Star className="w-4 h-4 stroke-[2.5] fill-amber-400" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] text-pos-muted uppercase font-bold block truncate">Points Fidélité</span>
              <span className="text-sm font-black text-amber-400 font-mono num">{totalLoyaltyPoints.toLocaleString('fr-DZ')}</span>
            </div>
          </div>

          <div className="min-w-[140px] sm:min-w-0 flex-1 bg-pos-card p-2 sm:p-2.5 rounded-xl border border-pos-border shadow-sm flex items-center gap-2.5 shrink-0 sm:shrink">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <CreditCard className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] text-pos-muted uppercase font-bold block truncate">Avoirs en Cours</span>
              <span className="text-sm font-black text-emerald-400 font-mono num">{formatDZD(totalCreditOutstanding)}</span>
            </div>
          </div>

          <div className="min-w-[140px] sm:min-w-0 flex-1 bg-pos-card p-2 sm:p-2.5 rounded-xl border border-pos-border shadow-sm flex items-center gap-2.5 shrink-0 sm:shrink">
            <div className="w-8 h-8 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center shrink-0">
              <ShoppingBag className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] text-pos-muted uppercase font-bold block truncate">Grossistes</span>
              <span className="text-sm font-black text-purple-400 font-mono num">{wholesaleCount}</span>
            </div>
          </div>

          <div className="min-w-[140px] sm:min-w-0 flex-1 bg-pos-card p-2 sm:p-2.5 rounded-xl border border-pos-border shadow-sm flex items-center gap-2.5 shrink-0 sm:shrink">
            <div className="w-8 h-8 rounded-lg bg-rose-500/20 text-rose-400 flex items-center justify-center shrink-0">
              <Crown className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] text-pos-muted uppercase font-bold block truncate">VIP</span>
              <span className="text-sm font-black text-rose-400 font-mono num">{vipCount}</span>
            </div>
          </div>
        </div>

        {/* ═══ Sub-Tab Navigation ═══ */}
        <div className="flex border-b border-pos-border px-4 bg-pos-card shrink-0 gap-2 overflow-x-auto no-scrollbar">
          <button
            onClick={() => { dismissMenus(); setMainTab('directory'); }}
            className={`py-2.5 px-4 text-xs font-black border-b-2 transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0 ${
              mainTab === 'directory'
                ? 'border-emerald-500 text-emerald-400 bg-emerald-500/10 rounded-t-lg'
                : 'border-transparent text-pos-muted hover:text-pos-text'
            }`}
          >
            <User className="w-4 h-4" />
            Répertoire & Profils Clients ({(customers || []).length})
          </button>

          <button
            onClick={() => { dismissMenus(); setMainTab('debts'); }}
            className={`py-2.5 px-4 text-xs font-black border-b-2 transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0 ${
              mainTab === 'debts'
                ? 'border-amber-500 text-amber-400 bg-amber-500/10 rounded-t-lg'
                : 'border-transparent text-pos-muted hover:text-pos-text'
            }`}
          >
            <FileText className="w-4 h-4" />
            Carnet de Dettes & Règlements (Kredy)
            {totalDebtOutstanding > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-mono text-[10px] border border-amber-500/30">
                {formatDZD(totalDebtOutstanding)}
              </span>
            )}
          </button>

          {/* UPGRADE-04: contract price books management (opens dedicated modal) */}
          <button
            onClick={() => { dismissMenus(); setIsPriceBooksOpen(true); }}
            className="py-2.5 px-4 text-xs font-black border-b-2 border-transparent transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap shrink-0 text-pos-muted hover:text-pos-text"
            aria-haspopup="dialog"
          >
            <Tag className="w-4 h-4" aria-hidden="true" />
            Grilles Tarifaires (Prix Négociés)
          </button>
        </div>

        {/* ═══ Content Body ═══ */}
        <div ref={contentBodyRef} className="flex-1 overflow-y-auto p-4 relative flex flex-col gap-4">
          {successMsg && (
            <div className="sticky top-2 z-20 mx-auto w-fit bg-emerald-500 text-slate-950 px-4 py-2 rounded-full text-xs font-black flex items-center gap-2 shadow-xl animate-in fade-in slide-in-from-top-4">
              <CheckCircle2 className="w-4 h-4" /> {successMsg}
            </div>
          )}

          {/* ═══ Directory Tab Views ═══ */}
          {mainTab === 'directory' && viewMode === 'form' && (
            <div className="bg-pos-card border border-pos-border rounded-xl p-6 max-w-2xl mx-auto w-full shadow-sm">
              <div className="flex justify-between items-center mb-5">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                    <UserPlus className="w-4 h-4 stroke-[2.5]" />
                  </div>
                  <h3 className="text-sm font-extrabold text-pos-text">{editingId ? 'Modifier le Profil Client' : 'Créer un Nouveau Client'}</h3>
                </div>
                <button onClick={() => resetForm()} className="text-xs text-pos-muted hover:text-pos-text bg-pos-hover px-3 py-1 rounded-lg font-semibold transition">Annuler</button>
              </div>
              <form onSubmit={handleSaveCustomer} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] text-pos-muted uppercase font-bold block mb-1.5">Nom Complet *</label>
                    <input type="text" required value={name} onChange={e => setName(e.target.value)}
                      placeholder="Ex: Mohamed Leila"
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none transition" />
                  </div>
                  <div>
                    <label htmlFor="customer-phone" className="text-[10px] text-pos-muted uppercase font-bold block mb-1.5">Téléphone *</label>
                    <DzPhoneInput
                      id="customer-phone"
                      required
                      value={phone}
                      onChange={setPhone}
                      placeholder="Ex: 0550 00 22 22"
                      inputClassName="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none transition"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="text-[10px] text-pos-muted uppercase font-bold block mb-1.5">Email</label>
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                      placeholder="Ex: email@domaine.dz"
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none transition" />
                  </div>
                  <div>
                    <label className="text-[10px] text-pos-muted uppercase font-bold block mb-1.5">Appareil Principal</label>
                    <input type="text" value={registeredDevice} onChange={e => setRegisteredDevice(e.target.value)}
                      placeholder="Ex: iPhone 15 Pro Max"
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none transition" />
                  </div>
                  <div>
                    <label className="text-[10px] text-pos-muted uppercase font-bold block mb-1.5">Plafond Dette (DA)</label>
                    <input type="number" min="0" step="500" value={debtLimit} onChange={e => setDebtLimit(e.target.value)}
                      placeholder="0 ou vide = illimité"
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2.5 text-xs text-pos-text font-mono focus:border-emerald-400 focus:outline-none transition" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-pos-muted uppercase font-bold block mb-1.5">Niveau de Tarification</label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {(['Retail', 'VIP', 'Wholesale'] as PricingTier[]).map(tier => (
                      <button key={tier} type="button" onClick={() => setPricingTier(tier)}
                        className={`min-h-[52px] p-3 rounded-lg border text-xs font-bold transition-all text-center active:scale-95 ${
                          pricingTier === tier
                            ? tier === 'VIP' ? 'bg-violet-500/20 border-violet-500 text-violet-400 shadow-md shadow-violet-500/10'
                            : tier === 'Wholesale' ? 'bg-sky-500/20 border-sky-500 text-sky-400 shadow-md shadow-sky-500/10'
                            : 'bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-md shadow-emerald-500/10'
                            : 'bg-pos-bg border-pos-border text-pos-muted hover:border-pos-text/30'
                        }`}
                      >
                        {tier === 'VIP' && <Crown className="w-4 h-4 mx-auto mb-1" />}
                        {tier === 'Wholesale' && <ShoppingBag className="w-4 h-4 mx-auto mb-1" />}
                        {tier === 'Retail' && <User className="w-4 h-4 mx-auto mb-1" />}
                        {tier === 'Retail' ? 'Détail (Public)' : tier === 'VIP' ? 'Demi-Gros (Réparateur)' : 'Gros (Commerçant)'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-3 border-t border-pos-border">
                  <button type="button" onClick={() => resetForm()} className="px-4 py-2.5 min-h-[44px] rounded-lg bg-pos-hover text-pos-text font-semibold text-xs transition">Annuler</button>
                  <button type="submit" className="px-5 py-2.5 min-h-[44px] rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition cursor-pointer">
                    <CheckCircle2 className="w-4 h-4" /> {editingId ? 'Mettre à Jour' : 'Créer le Client'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* ═══ Customer Profile Detail View ═══ */}
          {mainTab === 'directory' && viewMode === 'profile' && profileCustomer && (() => {
            const customer = activeProfile || profileCustomer;
            const metrics = getCustomerMetrics(customer.id);
            return (
              <div className="max-w-3xl mx-auto w-full space-y-4">
                {/* Back Button */}
                <button onClick={() => { dismissMenus(); setViewMode('list'); }} aria-label="Retour à la Liste" className="min-h-[44px] px-1 rounded-lg text-xs text-pos-muted hover:text-pos-text flex items-center gap-1 font-semibold transition self-start">
                  <span aria-hidden="true">←</span> Retour à la Liste
                </button>

                {/* Profile Header Card */}
                <div className="bg-pos-card border border-pos-border rounded-xl shadow-sm p-5 flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-emerald-500/30 to-sky-500/30 border border-pos-border flex items-center justify-center overflow-hidden shadow-sm">
                      {customer.avatarUrl
                        ? <img src={customer.avatarUrl} alt={customer.name} className="w-full h-full object-cover" />
                        : <User className="w-8 h-8 text-sky-400" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-black text-pos-text">{customer.name}</h3>
                        {tierBadge(customer.pricingTier)}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-pos-muted mt-1">
                        <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {customer.phone}</span>
                        {customer.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {customer.email}</span>}
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-pos-muted mt-1">
                        {customer.registeredDevice && (
                          <span>Appareil : {customer.registeredDevice}</span>
                        )}
                        {customer.debtLimit ? (
                          <span className="font-bold text-amber-400">Plafond Crédit : {formatDZD(customer.debtLimit)}</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => {
                        if (currentCustomer?.id === customer.id) {
                          setCurrentCustomer(null);
                          showSuccess('Client détaché de la vente.');
                        } else {
                          setCurrentCustomer(customer);
                          showSuccess(`${customer.name} sélectionné pour la vente.`);
                          closeModal();
                        }
                      }}
                      aria-label={currentCustomer?.id === customer.id ? `Sélectionné — Désélectionner ${customer.name}` : `Sélectionner ${customer.name} pour la vente`}
                      className={`px-4 py-2 min-h-[44px] rounded-lg text-xs font-bold flex items-center gap-1.5 transition cursor-pointer ${
                        currentCustomer?.id === customer.id
                          ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                          : 'bg-sky-500 hover:bg-sky-400 text-white shadow-md shadow-sky-500/20'
                      }`}
                    >
                      {currentCustomer?.id === customer.id ? <><Check className="w-3.5 h-3.5" /> Sélectionné</> : <><Check className="w-3.5 h-3.5" /> Sélectionner</>}
                    </button>
                    <button
                      ref={profileMenuAnchorRef}
                      onClick={() => setProfileMenuOpen(v => !v)}
                      aria-haspopup="menu"
                      aria-expanded={profileMenuOpen}
                      aria-label={`Plus d'actions pour ${customer.name}`}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-pos-hover border border-pos-border text-pos-text hover:border-pos-text/30 transition cursor-pointer"
                    >
                      <MoreHorizontal className="w-5 h-5" />
                    </button>
                  </div>
                </div>

                {/* Metrics Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                  <div className="bg-pos-card border border-pos-border shadow-sm p-3 rounded-xl text-center">
                    <TrendingUp className="w-5 h-5 text-emerald-400 mx-auto mb-1" />
                    <span className="text-[9px] text-pos-muted uppercase font-bold block">CA Total</span>
                    <span className="text-sm font-black text-emerald-400">{formatDZD(metrics.totalSpent)}</span>
                  </div>
                  <div className="bg-pos-card border border-pos-border shadow-sm p-3 rounded-xl text-center">
                    <ShoppingBag className="w-5 h-5 text-sky-400 mx-auto mb-1" />
                    <span className="text-[9px] text-pos-muted uppercase font-bold block">Commandes</span>
                    <span className="text-sm font-black text-sky-400">{metrics.totalOrders}</span>
                  </div>
                  <div className="bg-pos-card border border-pos-border shadow-sm p-3 rounded-xl text-center">
                    <Star className="w-5 h-5 text-amber-400 fill-amber-400 mx-auto mb-1" />
                    <span className="text-[9px] text-pos-muted uppercase font-bold block">Points</span>
                    <span className="text-sm font-black text-amber-400">{(customer.loyaltyPoints || 0).toLocaleString('fr-DZ')}</span>
                  </div>
                  <div className={`bg-pos-card border shadow-sm p-3 rounded-xl text-center ${
                    (customer.currentDebt || 0) > 0 ? 'border-amber-500/50 bg-amber-500/5' : 'border-pos-border'
                  }`}>
                    <FileText className={`w-5 h-5 mx-auto mb-1 ${
                      (customer.currentDebt || 0) > 0 ? 'text-amber-400' : 'text-sky-400'
                    }`} />
                    <span className="text-[9px] text-pos-muted uppercase font-bold block">
                      {(customer.currentDebt || 0) > 0 ? 'Dette En Cours' : 'Avoir'}
                    </span>
                    <span className={`text-sm font-black ${
                      (customer.currentDebt || 0) > 0 ? 'text-amber-400 font-mono' : 'text-sky-400'
                    }`}>
                      {(customer.currentDebt || 0) > 0
                        ? formatDZD(customer.currentDebt || 0)
                        : formatDZD(customer.storeCredit || 0)}
                    </span>
                    {customer.debtLimit ? (
                      <span className="text-[9px] text-pos-muted block mt-0.5 truncate font-mono">
                        Max : {formatDZD(customer.debtLimit)}
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Loyalty Tier Progress */}
                <div className="bg-pos-card border border-pos-border shadow-sm rounded-xl p-4">
                  {(() => {
                    const currentSpent = customer.totalSpent || 0;
                    const loyaltyCfg = normalizeLoyaltyConfig(receiptSettings?.loyaltyConfig);
                    const currentTier = calculateCustomerTier(currentSpent, loyaltyCfg);
                    const progress = calculateNextTierProgress(currentSpent, loyaltyCfg);
                    const nextTier = progress.nextTier;

                    return (
                      <div className="space-y-3">
                        <div className="flex justify-between items-center">
                          <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                            <Award className="w-4 h-4 text-amber-400" /> Programme de Fidélité
                          </span>
                          <span className="text-xs font-extrabold text-amber-400">{currentTier.name} ({currentTier.icon})</span>
                        </div>

                        {nextTier ? (
                          <div className="space-y-1.5">
                            <div className="flex justify-between text-[10px] font-semibold">
                              <span className="text-pos-muted">Niveau Suivant: <strong className="text-pos-text">{nextTier.name}</strong> ({nextTier.icon})</span>
                              <span className="text-amber-400 font-bold">{progress.progressPercent}%</span>
                            </div>
                            <div className="w-full bg-pos-bg rounded-full h-2 overflow-hidden border border-pos-border">
                              <div className="bg-gradient-to-r from-amber-500 to-emerald-400 h-full transition-all duration-500 rounded-full" style={{ width: `${progress.progressPercent}%` }} />
                            </div>
                            <p className="text-[9.5px] text-pos-muted">
                              Plus que <strong className="text-emerald-400">{formatDZD(progress.remainingSpend)}</strong> pour passer au statut {nextTier.name}
                            </p>
                          </div>
                        ) : (
                          <div className="text-[10px] text-purple-400 font-bold bg-purple-500/10 border border-purple-500/30 p-2 rounded-lg text-center">
                            👑 Statut Maximal Atteint - Multiplicateur {currentTier.pointsMultiplier}x
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* ═══ Customer 360 Sub-Tabs ═══ */}
                <div className="bg-pos-card border border-pos-border shadow-sm rounded-xl p-4 space-y-4">
                  {/* Tab Navigation */}
                  <div className="flex items-center gap-1.5 border-b border-pos-border pb-3 overflow-x-auto no-scrollbar" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={profileTab === 'purchases'}
                      onClick={() => setProfileTab('purchases')}
                      className={`px-3 py-1.5 min-h-[44px] rounded-lg text-xs font-bold flex items-center gap-1.5 transition whitespace-nowrap cursor-pointer ${
                        profileTab === 'purchases'
                          ? 'bg-sky-500 text-white shadow-sm shadow-sky-500/20'
                          : 'bg-pos-bg text-pos-muted hover:text-pos-text border border-pos-border'
                      }`}
                    >
                      <ShoppingBag className="w-3.5 h-3.5" /> Achats ({customerPurchases.length})
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={profileTab === 'repairs'}
                      onClick={() => setProfileTab('repairs')}
                      className={`px-3 py-1.5 min-h-[44px] rounded-lg text-xs font-bold flex items-center gap-1.5 transition whitespace-nowrap cursor-pointer ${
                        profileTab === 'repairs'
                          ? 'bg-amber-500 text-slate-950 shadow-sm shadow-amber-500/20'
                          : 'bg-pos-bg text-pos-muted hover:text-pos-text border border-pos-border'
                      }`}
                    >
                      <Wrench className="w-3.5 h-3.5" /> SAV ({customerRepairs.length})
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={profileTab === 'tradeins'}
                      onClick={() => setProfileTab('tradeins')}
                      className={`px-3 py-1.5 min-h-[44px] rounded-lg text-xs font-bold flex items-center gap-1.5 transition whitespace-nowrap cursor-pointer ${
                        profileTab === 'tradeins'
                          ? 'bg-emerald-500 text-slate-950 shadow-sm shadow-emerald-500/20'
                          : 'bg-pos-bg text-pos-muted hover:text-pos-text border border-pos-border'
                      }`}
                    >
                      <Smartphone className="w-3.5 h-3.5" /> Reprises ({customerTradeIns.length})
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={profileTab === 'vouchers'}
                      onClick={() => setProfileTab('vouchers')}
                      className={`px-3 py-1.5 min-h-[44px] rounded-lg text-xs font-bold flex items-center gap-1.5 transition whitespace-nowrap cursor-pointer ${
                        profileTab === 'vouchers'
                          ? 'bg-purple-500 text-white shadow-sm shadow-purple-500/20'
                          : 'bg-pos-bg text-pos-muted hover:text-pos-text border border-pos-border'
                      }`}
                    >
                      <Ticket className="w-3.5 h-3.5" /> Bons d'Avoir ({customerVouchers.length})
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={profileTab === 'debt'}
                      onClick={() => setProfileTab('debt')}
                      className={`px-3 py-1.5 min-h-[44px] rounded-lg text-xs font-bold flex items-center gap-1.5 transition whitespace-nowrap cursor-pointer ${
                        profileTab === 'debt'
                          ? 'bg-rose-500 text-white shadow-sm shadow-rose-500/20'
                          : 'bg-pos-bg text-pos-muted hover:text-pos-text border border-pos-border'
                      }`}
                    >
                      <FileText className="w-3.5 h-3.5" /> Grand Livre Dette ({customerDebtsFiltered.length})
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={profileTab === 'loyalty'}
                      onClick={() => setProfileTab('loyalty')}
                      className={`px-3 py-1.5 min-h-[44px] rounded-lg text-xs font-bold flex items-center gap-1.5 transition whitespace-nowrap cursor-pointer ${
                        profileTab === 'loyalty'
                          ? 'bg-amber-400 text-slate-950 shadow-sm shadow-amber-400/20'
                          : 'bg-pos-bg text-pos-muted hover:text-pos-text border border-pos-border'
                      }`}
                    >
                      <Star className="w-3.5 h-3.5" /> Fidélité & Actions ({(customer.ledger || []).length})
                    </button>
                  </div>

                  {/* 1. Achats */}
                  {profileTab === 'purchases' && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-pos-text">Ventes en Caisse</span>
                        <span className="text-pos-muted">{customerPurchases.length} transactions</span>
                      </div>
                      {customerPurchases.length === 0 ? (
                        <p className="text-xs text-pos-muted text-center py-6">Aucun achat enregistré pour ce client.</p>
                      ) : (
                        <div className="space-y-2 max-h-60 overflow-y-auto overscroll-contain">
                          {customerPurchases.map((t: SaleTransaction) => (
                            <div key={t.id} className="flex items-center justify-between bg-pos-bg p-2.5 rounded-lg border border-pos-border text-xs hover:border-pos-text/20 transition">
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-[11px] font-bold text-sky-400">{t.receiptNumber}</span>
                                  <span className="text-[10px] text-pos-muted">{formatDateTime(t.createdAt)}</span>
                                </div>
                                <span className="text-[10px] text-pos-muted">
                                  {(t.items || []).length} article(s) • Règlement : {t.paymentMethod || 'Espèces'}
                                </span>
                              </div>
                              <span className="font-mono font-bold text-sm text-emerald-400">{formatDZD(t.total)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 2. Réparations SAV */}
                  {profileTab === 'repairs' && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-pos-text">Dossiers Réparation SAV</span>
                        <span className="text-pos-muted">{customerRepairs.length} dossiers</span>
                      </div>
                      {customerRepairs.length === 0 ? (
                        <p className="text-xs text-pos-muted text-center py-6">Aucun dossier SAV enregistré pour ce client.</p>
                      ) : (
                        <div className="space-y-2 max-h-60 overflow-y-auto overscroll-contain">
                          {customerRepairs.map((ro: RepairOrder) => (
                            <div key={ro.id} className="flex items-center justify-between bg-pos-bg p-2.5 rounded-lg border border-pos-border text-xs hover:border-pos-text/20 transition">
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-[11px] font-bold text-amber-400">{ro.ticketNumber}</span>
                                  <span className="font-semibold text-pos-text">{ro.deviceModel}</span>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-pos-card border border-pos-border text-pos-muted font-bold">
                                    {ro.status}
                                  </span>
                                </div>
                                <span className="text-[10px] text-pos-muted truncate max-w-sm">
                                  {ro.problemDescription || 'Aucune description'}
                                </span>
                                {ro.depositAmount ? (
                                  <span className="text-[9.5px] text-emerald-400">
                                    Acompte versé : {formatDZD(ro.depositAmount)}
                                  </span>
                                ) : null}
                              </div>
                              <div className="text-right">
                                <span className="font-mono font-bold text-sm text-amber-400 block">{formatDZD(ro.totalCost)}</span>
                                <span className="text-[9.5px] text-pos-muted">Main d'œuvre: {formatDZD(ro.laborCost)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 3. Reprises Appareils */}
                  {profileTab === 'tradeins' && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-pos-text">Rachats & Reprises d'Appareils</span>
                        <span className="text-pos-muted">{customerTradeIns.length} reprises</span>
                      </div>
                      {customerTradeIns.length === 0 ? (
                        <p className="text-xs text-pos-muted text-center py-6">Aucune reprise d'appareil enregistrée pour ce client.</p>
                      ) : (
                        <div className="space-y-2 max-h-60 overflow-y-auto overscroll-contain">
                          {customerTradeIns.map((ti: TradeInItem) => (
                            <div key={ti.id} className="flex items-center justify-between bg-pos-bg p-2.5 rounded-lg border border-pos-border text-xs hover:border-pos-text/20 transition">
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-pos-text">{ti.brand} {ti.deviceModel}</span>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold">
                                    Grade {ti.conditionGrade}
                                  </span>
                                </div>
                                <span className="font-mono text-[10px] text-pos-muted">
                                  IMEI : {ti.imei} • {formatDateTime(ti.createdAt)}
                                </span>
                              </div>
                              <div className="text-right">
                                <span className="font-mono font-bold text-sm text-emerald-400 block">{formatDZD(ti.buybackValue)}</span>
                                <span className="text-[9.5px] text-pos-muted">
                                  {ti.creditToWallet ? 'Crédité Portefeuille' : 'Espèces Comptant'}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 4. Bons d'Avoir */}
                  {profileTab === 'vouchers' && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-pos-text">Bons d'Achat & Avoirs Disponibles</span>
                        <span className="text-pos-muted">{customerVouchers.length} bons</span>
                      </div>
                      {customerVouchers.length === 0 ? (
                        <p className="text-xs text-pos-muted text-center py-6">Aucun bon d'achat ou avoir pour ce client.</p>
                      ) : (
                        <div className="space-y-2 max-h-60 overflow-y-auto overscroll-contain">
                          {customerVouchers.map((v: CreditVoucher) => (
                            <div key={v.id} className="flex items-center justify-between bg-pos-bg p-2.5 rounded-lg border border-pos-border text-xs hover:border-pos-text/20 transition">
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono font-bold text-xs text-purple-400">{v.code}</span>
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                                    v.status === 'ACTIVE'
                                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                      : 'bg-pos-card text-pos-muted border border-pos-border'
                                  }`}>
                                    {v.status}
                                  </span>
                                </div>
                                <span className="text-[10px] text-pos-muted">
                                  Émis le : {formatDateTime(v.createdAt)} {v.expiresAt ? `• Expire : ${formatDateTime(v.expiresAt)}` : ''}
                                </span>
                              </div>
                              <div className="text-right">
                                <span className="font-mono font-bold text-sm text-purple-400 block">{formatDZD(v.remainingAmount)}</span>
                                <span className="text-[9.5px] text-pos-muted">Initial : {formatDZD(v.initialAmount)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 5. Grand Livre Dette */}
                  {profileTab === 'debt' && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <div>
                          <span className="font-bold text-pos-text">Grand Livre des Créances</span>
                          <span className="text-pos-muted text-[10px] ml-2">
                            Solde actuel : <strong className="text-amber-400 font-mono">{formatDZD(customer.currentDebt || 0)}</strong>
                            {customer.debtLimit ? ` (Plafond : ${formatDZD(customer.debtLimit)})` : ''}
                          </span>
                        </div>
                        {(customer.currentDebt || 0) > 0 && (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setWhatsappDebtCustomer(customer)}
                              className="px-2.5 py-1.5 min-h-[36px] bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400 font-bold text-xs rounded-lg transition cursor-pointer flex items-center gap-1"
                              title="Envoyer un rappel de solde via WhatsApp"
                              aria-label={`Relance WhatsApp — ${customer.name}`}
                            >
                              <MessageSquare className="w-3.5 h-3.5" aria-hidden="true" /> Relance WhatsApp
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDebtPaymentCustomer(customer);
                                setDebtPaymentAmount(customer.currentDebt || 0);
                              }}
                              className="px-3 py-1.5 min-h-[36px] bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-lg transition shadow-sm cursor-pointer flex items-center gap-1"
                            >
                              <DollarSign className="w-3.5 h-3.5" /> Encaisser Versement
                            </button>
                          </div>
                        )}
                      </div>
                      {customerDebtsFiltered.length === 0 ? (
                        <p className="text-xs text-pos-muted text-center py-6">Aucune écriture de dette enregistrée pour ce client.</p>
                      ) : (
                        <div className="space-y-2 max-h-60 overflow-y-auto overscroll-contain">
                          {customerDebtsFiltered.map((d: CustomerDebtEntry) => (
                            <div key={d.id} className="flex items-center justify-between bg-pos-bg p-2.5 rounded-lg border border-pos-border text-xs hover:border-pos-text/20 transition">
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                                    d.type === 'DEBT_ACQUIRED'
                                      ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                                      : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                                  }`}>
                                    {d.type === 'DEBT_ACQUIRED' ? 'Créance Prise' : 'Règlement Encaissé'}
                                  </span>
                                  <span className="text-[10px] text-pos-muted">{formatDateTime(d.createdAt)}</span>
                                  {d.receiptNumber && <span className="font-mono text-[10px] text-pos-muted">#{d.receiptNumber}</span>}
                                </div>
                                {d.notes && <span className="text-[10px] text-pos-muted">{d.notes}</span>}
                              </div>
                              <div className="text-right">
                                <span className={`font-mono font-bold text-sm ${d.type === 'DEBT_ACQUIRED' ? 'text-amber-400' : 'text-emerald-400'}`}>
                                  {d.type === 'DEBT_ACQUIRED' ? '+' : '-'}{formatDZD(d.amount)}
                                </span>
                                <span className="text-[9.5px] text-pos-muted block">
                                  Solde : {formatDZD(d.balanceAfter)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 6. Points & Fidélité */}
                  {profileTab === 'loyalty' && (
                    <div className="space-y-4">
                      {/* Action Bar */}
                      <div className="flex items-center justify-between flex-wrap gap-2 p-2.5 bg-pos-bg rounded-lg border border-pos-border">
                        <div className="text-xs">
                          <span className="text-pos-muted">Solde Points : </span>
                          <strong className="text-amber-400 font-bold text-sm">{(customer.loyaltyPoints || 0).toLocaleString('fr-DZ')} pts</strong>
                          <span className="text-pos-muted ml-2">Avoir : </span>
                          <strong className="text-sky-400 font-bold text-sm">{formatDZD(customer.storeCredit || 0)}</strong>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button
                            type="button"
                            onClick={() => {
                              setCreditAmount(0);
                              setCreditManagerPin('');
                              setCreditModalOpen(true);
                            }}
                            className="px-2.5 py-1.5 min-h-[36px] bg-sky-500 hover:bg-sky-400 text-white font-bold text-[11px] rounded-lg transition flex items-center gap-1 cursor-pointer"
                          >
                            <CreditCard className="w-3 h-3" /> Émettre Avoir
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRedeemPoints(customer.loyaltyPoints || 0);
                              setRedeemModalOpen(true);
                            }}
                            className="px-2.5 py-1.5 min-h-[36px] bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-[11px] rounded-lg transition flex items-center gap-1 cursor-pointer"
                          >
                            <RefreshCw className="w-3 h-3" /> Convertir Points
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setAdjustPoints(0);
                              setAdjustReason('');
                              setAdjustModalOpen(true);
                            }}
                            className="px-2.5 py-1.5 min-h-[36px] bg-pos-hover hover:bg-pos-border text-pos-text font-bold text-[11px] rounded-lg border border-pos-border transition flex items-center gap-1 cursor-pointer"
                          >
                            <Edit2 className="w-3 h-3" /> Ajuster Points
                          </button>
                        </div>
                      </div>

                      {/* Loyalty Ledger Entries */}
                      <div className="space-y-2">
                        <span className="text-xs font-bold text-pos-text block">Historique du Grand Livre Fidélité</span>
                        {(!customer.ledger || customer.ledger.length === 0) ? (
                          <p className="text-xs text-pos-muted text-center py-6">Aucune opération fidélité pour ce client.</p>
                        ) : (
                          <div className="space-y-2 max-h-60 overflow-y-auto overscroll-contain">
                            {customer.ledger.map((entry) => (
                              <div key={entry.id} className="flex items-center justify-between bg-pos-bg p-2.5 rounded-lg border border-pos-border text-xs hover:border-pos-text/20 transition">
                                <div className="flex flex-col gap-0.5">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 uppercase">
                                      {entry.type}
                                    </span>
                                    <span className="text-[10px] text-pos-muted">{formatDateTime(entry.timestamp)}</span>
                                  </div>
                                  <span className="text-[10px] text-pos-muted">{entry.description}</span>
                                </div>
                                <div className="text-right">
                                  <span className={`font-mono font-bold text-xs ${entry.points >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {entry.points >= 0 ? '+' : ''}{entry.points} pts
                                  </span>
                                  <span className="text-[9.5px] text-pos-muted block">
                                    Solde : {entry.balanceAfter} pts
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ═══ Customer List View ═══ */}
          {mainTab === 'directory' && viewMode === 'list' && (
            <>
              {/* Toolbar */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-bold text-pos-muted uppercase tracking-wider shrink-0">Liste des Clients</h3>
                  <button onClick={() => { setFormOrigin({ view: 'list', profileId: null }); resetForm(); setViewMode('form'); }}
                    className="px-4 py-2 min-h-[44px] bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-lg text-xs font-bold flex items-center gap-1.5 transition shadow-lg shadow-emerald-500/20 cursor-pointer shrink-0">
                    <Plus className="w-4 h-4" /> Ajouter un Client
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {/* Tier Filter Pills */}
                  <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto no-scrollbar py-0.5" role="group" aria-label="Filtrer par niveau de tarification">
                    {(['Tous', 'Retail', 'Wholesale', 'VIP'] as TierFilter[]).map(f => (
                      <button key={f} onClick={() => setTierFilter(f)}
                        className={`px-3 py-1 min-h-[44px] rounded-full text-[10px] font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
                          tierFilter === f ? 'bg-emerald-500 text-slate-950 shadow-md' : 'bg-pos-hover text-pos-muted hover:text-pos-text border border-pos-border'
                        }`}
                      >{f} {f !== 'Tous' && `(${(customers || []).filter(c => c.pricingTier === f).length})`}</button>
                    ))}
                  </div>

                  {/* Sort Dropdown */}
                  <select
                    aria-label="Trier les clients"
                    value={`${sortField}:${sortDir}`}
                    onChange={(e) => handleSortSelect(e.target.value)}
                    className="min-h-[44px] bg-pos-bg border border-pos-border rounded-lg px-2.5 text-[11px] font-bold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer shrink-0 max-w-[150px]"
                  >
                    <option value="name:asc">Nom (A→Z)</option>
                    <option value="name:desc">Nom (Z→A)</option>
                    <option value="loyaltyPoints:desc">Points ↓</option>
                    <option value="loyaltyPoints:asc">Points ↑</option>
                    <option value="storeCredit:desc">Avoir ↓</option>
                    <option value="storeCredit:asc">Avoir ↑</option>
                  </select>
                </div>
              </div>

              {/* Customer Cards Grid */}
              {filteredCustomers.length === 0 ? (
                <div className="text-center py-16">
                  <User className="w-10 h-10 text-pos-muted/30 mx-auto mb-3" />
                  <p className="text-sm font-bold text-pos-muted">Aucun client trouvé</p>
                  <p className="text-xs text-pos-muted/60 mt-1">Ajustez votre recherche ou ajoutez un nouveau client.</p>
                </div>
              ) : (
                <div
                  style={{
                    height: `${customerRowVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {customerRowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const rowPair = customerRows[virtualRow.index] || [];
                    return (
                      <div
                        key={virtualRow.key}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                        className="grid grid-cols-1 sm:grid-cols-2 gap-3 pb-3"
                      >
                        {rowPair.map((customer) => {
                          const metrics = getCustomerMetrics(customer.id);
                          const isSelected = currentCustomer?.id === customer.id;
                          const hasDebt = (customer.currentDebt || 0) > 0;

                          return (
                            <div
                              key={customer.id}
                              className={`bg-pos-card border rounded-xl p-4 flex flex-col gap-3 relative transition-all shadow-sm hover:shadow-md cursor-pointer ${
                                isSelected ? 'border-emerald-500 shadow-sm shadow-emerald-500/20 ring-1 ring-emerald-500/30' : 'border-pos-border hover:border-pos-text/20'
                              }`}
                              onClick={() => openProfile(customer)}
                            >
                              {/* Selected Indicator */}
                              {isSelected && (
                                <div className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center shadow-md shadow-emerald-500/40 z-10">
                                  <Check className="w-3.5 h-3.5 text-slate-950 stroke-[3]" />
                                </div>
                              )}

                              {/* Customer Info Row */}
                              <div className="flex items-start">
                                <div className="flex items-center gap-3">
                                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500/20 to-sky-500/20 border border-pos-border flex items-center justify-center overflow-hidden shrink-0">
                                    {customer.avatarUrl
                                      ? <img src={customer.avatarUrl} alt={customer.name} className="w-full h-full object-cover" />
                                      : <User className="w-5 h-5 text-sky-400" />}
                                  </div>
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <h3 className="text-sm font-bold text-pos-text truncate">{customer.name}</h3>
                                      {tierBadge(customer.pricingTier)}
                                      {hasDebt && (
                                        <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[9px] font-black animate-pulse shrink-0">
                                          Dette: {formatDZD(customer.currentDebt || 0)}
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 text-[10px] text-pos-muted mt-0.5">
                                      <span className="flex items-center gap-0.5"><Phone className="w-3 h-3" /> {customer.phone}</span>
                                      {customer.email && <span className="flex items-center gap-0.5 truncate max-w-[150px]"><Mail className="w-3 h-3" /> {customer.email}</span>}
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Metrics Strip */}
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 bg-pos-bg rounded-lg p-2 border border-pos-border text-xs">
                                <div className="flex flex-col items-center">
                                  <span className="text-[8px] text-pos-muted uppercase font-bold">Points</span>
                                  <span className="font-bold text-amber-400 flex items-center gap-0.5 text-[11px]">
                                    <Star className="w-3 h-3 fill-amber-400" /> {(customer.loyaltyPoints || 0).toLocaleString('fr-DZ')}
                                  </span>
                                </div>
                                <div className="flex flex-col items-center">
                                  <span className="text-[8px] text-pos-muted uppercase font-bold">
                                    {hasDebt ? 'Dette' : 'Avoir'}
                                  </span>
                                  <span className={`font-bold text-[11px] ${hasDebt ? 'text-amber-400' : 'text-emerald-400'}`}>
                                    {hasDebt ? formatDZD(customer.currentDebt || 0) : formatDZD(customer.storeCredit || 0)}
                                  </span>
                                </div>
                                <div className="flex flex-col items-center">
                                  <span className="text-[8px] text-pos-muted uppercase font-bold">Achats</span>
                                  <span className="font-bold text-sky-400 text-[11px]">{metrics.totalOrders}</span>
                                </div>
                                <div className="flex flex-col items-center">
                                  <span className="text-[8px] text-pos-muted uppercase font-bold">CA</span>
                                  <span className="font-bold text-sky-400 text-[11px]">{formatDZD(metrics.totalSpent)}</span>
                                </div>
                              </div>

                              {/* Footer Row — single action row */}
                              <div className="flex justify-between items-center gap-2 pt-1">
                                <span className="text-[10px] text-pos-muted truncate min-w-0 hidden xs:block">
                                  {customer.registeredDevice ? `📱 ${customer.registeredDevice}` : 'Appareil non renseigné'}
                                </span>
                                <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                                  {customer.storeCredit > 0 && (
                                    <button
                                      onClick={() => {
                                        setCurrentCustomer(customer);
                                        showSuccess(`Avoir de ${formatDZD(customer.storeCredit)} activé pour ${customer.name}. Choisissez un produit dans le catalogue.`);
                                        closeModal();
                                      }}
                                      aria-label={`Utiliser Avoir — l'avoir de ${customer.name} (${formatDZD(customer.storeCredit)})`}
                                      title="Activer l'avoir client et choisir un produit dans le catalogue"
                                      className="px-2.5 min-h-[44px] rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/40 text-xs font-extrabold flex items-center gap-1 transition cursor-pointer shadow-sm shadow-emerald-500/10"
                                    >
                                      <CreditCard className="w-3.5 h-3.5" /> Utiliser Avoir
                                    </button>
                                  )}
                                  <button
                                    onClick={() => {
                                      if (isSelected) {
                                        setCurrentCustomer(null);
                                        showSuccess('Client détaché de la vente.');
                                      } else {
                                        setCurrentCustomer(customer);
                                        showSuccess(`${customer.name} sélectionné pour la vente.`);
                                        closeModal();
                                      }
                                    }}
                                    aria-label={isSelected ? `Actif — Désélectionner ${customer.name}` : `Sélectionner ${customer.name} pour la vente`}
                                    className={`px-3 min-h-[44px] rounded-lg text-xs font-bold transition flex items-center gap-1 cursor-pointer ${
                                      isSelected
                                        ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                                        : 'bg-pos-hover text-pos-text hover:bg-pos-border'
                                    }`}
                                  >
                                    {isSelected ? (
                                      <><Check className="w-3.5 h-3.5" /> Actif</>
                                    ) : (
                                      'Sélectionner'
                                    )}
                                  </button>
                                  <button
                                    ref={(el) => { if (el) cardMenuAnchors.current.set(customer.id, el); else cardMenuAnchors.current.delete(customer.id); }}
                                    onClick={() => setCardMenuId(cardMenuId === customer.id ? null : customer.id)}
                                    aria-haspopup="menu"
                                    aria-expanded={cardMenuId === customer.id}
                                    aria-label={`Plus d'actions pour ${customer.name}`}
                                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-pos-hover text-pos-text hover:bg-pos-border transition cursor-pointer"
                                  >
                                    <MoreHorizontal className="w-5 h-5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* ═══ CARNET DE DETTES & RÈGLEMENTS (KREDY) ═══ */}
          {mainTab === 'debts' && (
            <div className="space-y-5 animate-in fade-in">
              {/* Executive Debt Summary Banner */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-gradient-to-br from-amber-950/60 to-orange-950/60 border border-amber-500/60 rounded-xl p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[11px] uppercase tracking-wider text-amber-300 font-bold block">
                        Total Créances Clients (En Cours)
                      </span>
                      <span className="text-2xl font-black text-amber-400 font-mono tracking-tight block mt-0.5">
                        {formatDZD(totalDebtOutstanding)}
                      </span>
                    </div>
                    <div className="w-10 h-10 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-300">
                      <FileText className="w-5 h-5" />
                    </div>
                  </div>
                  <p className="text-[10px] text-amber-200/70 mt-2">
                    Somme totale des dettes non encore recouvrées
                  </p>
                </div>

                <div className="bg-pos-card border border-pos-border rounded-xl shadow-sm p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[11px] uppercase tracking-wider text-pos-muted font-bold block">
                        Clients Débiteurs
                      </span>
                      <span className="text-2xl font-black text-pos-text block mt-0.5">
                        {indebtedCount} client{indebtedCount > 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="w-10 h-10 rounded-lg bg-red-500/20 border border-red-500/40 flex items-center justify-center text-red-400">
                      <User className="w-5 h-5" />
                    </div>
                  </div>
                  <p className="text-[10px] text-pos-muted mt-2">
                    Sur un total de {(customers || []).length} clients enregistrés
                  </p>
                </div>

                <div className="bg-pos-card border border-pos-border rounded-xl shadow-sm p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[11px] uppercase tracking-wider text-pos-muted font-bold block">
                        Total Versements Reçus
                      </span>
                      <span className="text-2xl font-black text-emerald-400 font-mono tracking-tight block mt-0.5">
                        {formatDZD((customerDebts || []).filter(d => d.type === 'PAYMENT_SETTLED').reduce((a, b) => a + b.amount, 0))}
                      </span>
                    </div>
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                      <ArrowDownLeft className="w-5 h-5" />
                    </div>
                  </div>
                  <p className="text-[10px] text-pos-muted mt-2">
                    Règlements cumulés enregistrés en caisse
                  </p>
                </div>
              </div>

              {/* Indebted Customers Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-black uppercase tracking-wider text-pos-text flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
                    Liste des Clients avec Solde Débiteur ({indebtedCustomers.length})
                  </h3>
                  <span className="text-[11px] text-pos-muted">
                    Cliquez sur "Encaisser un Versement" ou "WhatsApp" pour relancer
                  </span>
                </div>

                {indebtedCustomers.length === 0 ? (
                  <div className="bg-pos-card border border-pos-border rounded-xl shadow-sm p-8 text-center space-y-2">
                    <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto" />
                    <h4 className="text-sm font-bold text-pos-text">Aucune dette en cours !</h4>
                    <p className="text-xs text-pos-muted max-w-sm mx-auto">
                      Toutes les créances clients sont soldées ou aucun client ne correspond à votre filtre de recherche.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(indebtedCustomers || []).map(customer => {
                      const debt = customer.currentDebt || 0;
                      return (
                        <div
                          key={customer.id}
                          className="bg-pos-card border border-amber-500/40 hover:border-amber-500 rounded-xl p-4 flex flex-col justify-between gap-3 shadow-sm transition-all"
                        >
                          <div className="flex items-start justify-between">
                            <div>
                              <div className="flex items-center gap-2">
                                <h4 className="text-sm font-black text-pos-text">{customer.name}</h4>
                                {tierBadge(customer.pricingTier)}
                              </div>
                              <p className="text-xs text-pos-muted flex items-center gap-1 mt-0.5">
                                <Phone className="w-3 h-3 text-emerald-400" /> {customer.phone}
                              </p>
                              {customer.registeredDevice && (
                                <p className="text-[10px] text-pos-muted mt-0.5 truncate max-w-[200px]">
                                  📱 {customer.registeredDevice}
                                </p>
                              )}
                            </div>
                            <div className="text-right">
                              <span className="text-[10px] text-amber-300 font-bold block uppercase tracking-wider">
                                Dette à Recouvrer
                              </span>
                              <span className="text-lg font-black text-amber-400 font-mono">
                                {formatDZD(debt)}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 pt-2 border-t border-pos-border/60">
                            <button
                              type="button"
                              onClick={() => {
                                setDebtPaymentCustomer(customer);
                                setDebtPaymentAmount(debt);
                                setDebtPaymentMethod('Espèces');
                                setDebtPaymentNotes('');
                                debtPayEntryId.current = `debt-pay-${customer.id}-${Date.now()}`;
                              }}
                              className="flex-1 px-3 py-2 min-h-[44px] rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black flex items-center justify-center gap-1.5 transition shadow-md shadow-emerald-500/20 cursor-pointer"
                            >
                              <DollarSign className="w-4 h-4" /> Encaisser Versement
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setWhatsappDebtCustomer(customer);
                                setWhatsappCopied(false);
                              }}
                              className="px-3 py-2 min-h-[44px] rounded-lg bg-emerald-950/60 hover:bg-emerald-900 text-emerald-300 border border-emerald-500/40 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                              aria-label={`WhatsApp — Envoyer le relevé à ${customer.name}`}
                              title="Envoyer relevé WhatsApp au client"
                            >
                              <MessageSquare className="w-4 h-4" /> WhatsApp
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Debt Transactions Ledger */}
              <div className="bg-pos-card border border-pos-border rounded-xl shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-pos-text flex items-center gap-1.5">
                    <History className="w-4 h-4 text-sky-400" />
                    Grand Livre des Dettes & Règlements ({(customerDebts || []).length} écritures)
                  </h3>
                </div>

                {(customerDebts || []).length === 0 ? (
                  <p className="text-xs text-pos-muted text-center py-6">
                    Aucun mouvement de dette ou règlement enregistré pour le moment.
                  </p>
                ) : (
                  <div className="overflow-x-auto max-h-60 overflow-y-auto overscroll-contain">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="sticky top-0 bg-pos-card z-10">
                        <tr className="border-b border-pos-border text-[10px] text-pos-muted uppercase font-bold">
                          <th className="py-2 px-3">Date</th>
                          <th className="py-2 px-3">Client</th>
                          <th className="py-2 px-3">Type Écriture</th>
                          <th className="py-2 px-3">Mode</th>
                          <th className="py-2 px-3 text-right">Montant</th>
                          <th className="py-2 px-3 text-right">Solde Après</th>
                          <th className="py-2 px-3">Réf / Note</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pos-border/40 font-mono">
                        {(customerDebts || []).slice(0, 30).map((d) => {
                          const isPayment = d.type === 'PAYMENT_SETTLED';
                          return (
                            <tr key={d.id} className="hover:bg-pos-bg/50 transition">
                              <td className="py-2 px-3 text-pos-muted text-[11px] font-sans">
                                {new Date(d.createdAt).toLocaleDateString('fr-DZ', {
                                  day: '2-digit',
                                  month: '2-digit',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </td>
                              <td className="py-2 px-3 font-bold font-sans text-pos-text">
                                {d.customerName}
                              </td>
                              <td className="py-2 px-3">
                                {isPayment ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-bold">
                                    <ArrowDownLeft className="w-3 h-3" /> Règlement
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[10px] font-bold">
                                    <ArrowUpRight className="w-3 h-3" /> Vente Crédit
                                  </span>
                                )}
                              </td>
                              <td className="py-2 px-3 text-pos-muted font-sans text-[11px]">
                                {d.paymentMethod || 'Espèces'}
                              </td>
                              <td className={`py-2 px-3 text-right font-black ${
                                isPayment ? 'text-emerald-400' : 'text-amber-400'
                              }`}>
                                {isPayment ? '-' : '+'}{formatDZD(d.amount)}
                              </td>
                              <td className="py-2 px-3 text-right text-pos-muted font-bold">
                                {formatDZD(d.balanceAfter)}
                              </td>
                              <td className="py-2 px-3 text-pos-muted font-sans text-[11px] truncate max-w-[150px]">
                                {d.receiptNumber ? `N° ${d.receiptNumber}` : d.notes || '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ═══ Debt Settlement Payment Modal Dialog (portaled to body: escapes the
            z-50 overflow-hidden ancestor + zoom animation so it never clips) ═══ */}
        {debtPaymentCustomer && createPortal(
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4" onClick={() => setDebtPaymentCustomer(null)}>
            <div role="dialog" aria-modal="true" aria-label="Règlement de dette client" onClick={(e) => e.stopPropagation()} className="bg-pos-panel border border-pos-border rounded-xl w-full max-w-md p-6 space-y-4 shadow-2xl animate-in zoom-in-95 max-h-[90dvh] overflow-y-auto overscroll-contain">
              <div className="flex items-center justify-between border-b border-pos-border pb-3">
                <div className="flex items-center gap-2 text-emerald-400">
                  <DollarSign className="w-5 h-5" />
                  <h3 className="text-sm font-black text-pos-text">Règlement de Dette Client</h3>
                </div>
                <button
                  onClick={() => setDebtPaymentCustomer(null)}
                  aria-label="Fermer le règlement de dette"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Customer Header */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex justify-between items-center">
                <div>
                  <p className="text-xs font-black text-pos-text">{debtPaymentCustomer.name}</p>
                  <p className="text-[10px] text-pos-muted">Tél : {debtPaymentCustomer.phone}</p>
                </div>
                <div className="text-right">
                  <span className="text-[9px] uppercase tracking-wider text-amber-300 font-bold block">
                    Dette Actuelle
                  </span>
                  <span className="text-base font-black text-amber-400 font-mono">
                    {formatDZD(debtPaymentCustomer.currentDebt || 0)}
                  </span>
                </div>
              </div>

              <form onSubmit={handleRecordDebtPayment} className="space-y-4">
                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Montant du Versement (DA) *
                  </label>
                  <MoneyInput
                    label="Montant du Versement (DA)"
                    valueMinor={dinarsToMinor(debtPaymentAmount || 0)}
                    onChangeMinor={(minor) => {
                      const v = toLegacyReal(minor);
                      const cap = debtPaymentCustomer.currentDebt || 0;
                      setDebtPaymentAmount(cap > 0 ? Math.min(v, cap) : v);
                    }}
                    className="w-full bg-pos-bg border-2 border-pos-border focus:border-emerald-400 rounded-lg px-4 py-2.5 text-xl font-black font-mono text-pos-text focus:outline-none"
                    placeholder="5000"
                    required
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Mode de Règlement
                  </label>
                  <div className="p-3 rounded-xl bg-pos-card border border-pos-border flex items-center justify-between text-xs">
                    <span className="font-bold text-pos-text">Espèces (Tiroir-Caisse)</span>
                    <span className="text-[10px] text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                      Règlement Comptant
                    </span>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Note / Remarque (Facultatif)
                  </label>
                  <input
                    type="text"
                    value={debtPaymentNotes}
                    onChange={(e) => setDebtPaymentNotes(e.target.value)}
                    placeholder="Ex: Versement partiel reçu au comptoir"
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-pos-border">
                  <button
                    type="button"
                    onClick={() => setDebtPaymentCustomer(null)}
                    className="px-4 py-2 min-h-[44px] bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg text-xs font-bold"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 min-h-[44px] bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-lg shadow-lg shadow-emerald-500/20 transition cursor-pointer flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="w-4 h-4" /> Valider le Versement
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

        {/* ═══ WhatsApp Debt Generator Dialog (portaled to body) ═══ */}
        {whatsappDebtCustomer && createPortal(
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4" onClick={() => setWhatsappDebtCustomer(null)}>
            <div role="dialog" aria-modal="true" aria-label="Rappel WhatsApp de dette client" onClick={(e) => e.stopPropagation()} className="bg-pos-panel border border-pos-border rounded-xl w-full max-w-md p-6 space-y-4 shadow-2xl animate-in zoom-in-95 max-h-[90dvh] overflow-y-auto overscroll-contain">
              <div className="flex items-center justify-between border-b border-pos-border pb-3">
                <div className="flex items-center gap-2 text-emerald-400">
                  <MessageSquare className="w-5 h-5" />
                  <h3 className="text-sm font-black text-pos-text">Rappel WhatsApp — {whatsappDebtCustomer.name}</h3>
                </div>
                <button
                  onClick={() => setWhatsappDebtCustomer(null)}
                  aria-label="Fermer le rappel WhatsApp"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] uppercase font-bold text-pos-muted block">
                  Aperçu du message WhatsApp généré :
                </label>
                <div className="bg-pos-bg border border-pos-border rounded-xl p-3.5 text-xs text-pos-text whitespace-pre-line font-sans select-text">
                  {getWhatsAppDebtMessage(whatsappDebtCustomer)}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-pos-border">
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(getWhatsAppDebtMessage(whatsappDebtCustomer));
                    setWhatsappCopied(true);
                    setTimeout(() => setWhatsappCopied(false), 2500);
                  }}
                  className="px-4 py-2 min-h-[44px] bg-pos-hover hover:bg-pos-border text-pos-text rounded-lg text-xs font-bold flex items-center gap-1.5 cursor-pointer transition"
                >
                  <Copy className="w-4 h-4" /> {whatsappCopied ? 'Copié !' : 'Copier le Texte'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await openWhatsApp(
                      whatsappDebtCustomer.phone,
                      getWhatsAppDebtMessage(whatsappDebtCustomer)
                    );
                    if (!ok) {
                      showToast("Impossible d'ouvrir WhatsApp", 'error');
                    }
                  }}
                  className="px-5 py-2 min-h-[44px] bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-lg shadow-lg shadow-emerald-500/20 transition flex items-center gap-1.5 cursor-pointer"
                >
                  <ExternalLink className="w-4 h-4" /> Ouvrir WhatsApp
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

        {/* ═══ Portaled card ••• menu (Select, Avoir, Edit, Delete) ═══ */}
        {cardMenuId && (() => {
          const menuCustomer = (customers || []).find(c => c.id === cardMenuId);
          if (!menuCustomer) return null;
          const menuSelected = currentCustomer?.id === menuCustomer.id;
          return createPortal(
            <>
              <div
                className="fixed inset-0"
                style={{ zIndex: 9998 }}
                onClick={() => setCardMenuId(null)}
                aria-hidden="true"
              />
              <div
                ref={cardMenuRef}
                role="menu"
                aria-label={`Plus d'actions pour ${menuCustomer.name}`}
                style={{ position: 'fixed', top: cardMenuPos.top, left: cardMenuPos.left, zIndex: 9999 }}
                className="w-[calc(100vw-16px)] sm:w-64 bg-pos-panel border border-pos-border rounded-lg shadow-md overflow-hidden animate-in fade-in zoom-in-95"
                data-open-up={cardMenuPos.openUp ? 'true' : 'false'}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (menuSelected) {
                      setCurrentCustomer(null);
                      showSuccess('Client détaché de la vente.');
                    } else {
                      setCurrentCustomer(menuCustomer);
                      showSuccess(`${menuCustomer.name} sélectionné pour la vente.`);
                      closeModal();
                    }
                    setCardMenuId(null);
                  }}
                  className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-pos-text hover:bg-pos-hover transition text-left"
                  aria-label={menuSelected ? `Désélectionner (Actif) — ${menuCustomer.name}` : `Sélectionner pour la vente — ${menuCustomer.name}`}
                >
                  <Check className="w-4 h-4 shrink-0" /> {menuSelected ? 'Désélectionner (Actif)' : 'Sélectionner pour la vente'}
                </button>
                {menuCustomer.storeCredit > 0 && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setCurrentCustomer(menuCustomer);
                      showSuccess(`Avoir de ${formatDZD(menuCustomer.storeCredit)} activé pour ${menuCustomer.name}. Choisissez un produit dans le catalogue.`);
                      closeModal();
                      setCardMenuId(null);
                    }}
                    className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-emerald-400 hover:bg-emerald-500/10 transition text-left"
                    aria-label={`Utiliser l'Avoir — ${menuCustomer.name} (${formatDZD(menuCustomer.storeCredit)})`}
                  >
                    <CreditCard className="w-4 h-4 shrink-0" /> Utiliser l'Avoir
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setCardMenuId(null); handleEditClick(menuCustomer); }}
                  className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-pos-text hover:bg-pos-hover transition text-left"
                  aria-label={`Modifier ${menuCustomer.name}`}
                >
                  <Edit2 className="w-4 h-4 shrink-0" /> Modifier
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setCardMenuId(null); handleDelete(menuCustomer.id); }}
                  className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-rose-400 hover:bg-rose-500/10 transition text-left"
                  aria-label={`Supprimer ${menuCustomer.name}`}
                >
                  <Trash2 className="w-4 h-4 shrink-0" /> Supprimer
                </button>
              </div>
            </>,
            document.body,
          );
        })()}

        {/* ═══ Portaled profile ••• menu ═══ */}
        {profileMenuOpen && profileCustomer && (() => {
          const curCustomer = activeProfile || profileCustomer;
          return createPortal(
            <>
              <div
                className="fixed inset-0"
                style={{ zIndex: 9998 }}
                onClick={() => setProfileMenuOpen(false)}
                aria-hidden="true"
              />
              <div
                ref={profileMenuRef}
                role="menu"
                aria-label={`Plus d'actions pour ${curCustomer.name}`}
                style={{ position: 'fixed', top: profileMenuPos.top, left: profileMenuPos.left, zIndex: 9999 }}
                className="w-[calc(100vw-16px)] sm:w-64 bg-pos-panel border border-pos-border rounded-lg shadow-md overflow-hidden animate-in fade-in zoom-in-95 divide-y divide-pos-border/40"
                data-open-up={profileMenuPos.openUp ? 'true' : 'false'}
              >
                <div className="py-1">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setProfileMenuOpen(false); handleEditClick(curCustomer); }}
                    className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-pos-text hover:bg-pos-hover transition text-left cursor-pointer"
                    aria-label={`Modifier le Profil — ${curCustomer.name}`}
                  >
                    <Edit2 className="w-4 h-4 shrink-0 text-sky-400" aria-hidden="true" /> Modifier le Profil
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      setCurrentCustomer(curCustomer);
                      openModal('loyalty_card');
                    }}
                    className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-amber-400 hover:bg-amber-500/10 transition text-left cursor-pointer"
                    aria-label={`Carte PVC / Pass Digital — ${curCustomer.name}`}
                  >
                    <CreditCard className="w-4 h-4 shrink-0" /> Carte PVC / Pass Digital
                  </button>
                </div>

                <div className="py-1">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      setCreditAmount(0);
                      setCreditManagerPin('');
                      setCreditModalOpen(true);
                    }}
                    className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-sky-400 hover:bg-sky-500/10 transition text-left cursor-pointer"
                  >
                    <CreditCard className="w-4 h-4 shrink-0" /> Émettre un Avoir
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      setRedeemPoints(curCustomer.loyaltyPoints || 0);
                      setRedeemModalOpen(true);
                    }}
                    className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-amber-400 hover:bg-amber-500/10 transition text-left cursor-pointer"
                  >
                    <RefreshCw className="w-4 h-4 shrink-0" /> Convertir Points en Avoir
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      setAdjustPoints(0);
                      setAdjustReason('');
                      setAdjustModalOpen(true);
                    }}
                    className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-pos-text hover:bg-pos-hover transition text-left cursor-pointer"
                  >
                    <Edit2 className="w-4 h-4 shrink-0 text-pos-muted" /> Ajuster les Points
                  </button>
                  {(curCustomer.currentDebt || 0) > 0 && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setProfileMenuOpen(false);
                          setWhatsappDebtCustomer(curCustomer);
                        }}
                        className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-emerald-400 hover:bg-emerald-500/10 transition text-left cursor-pointer"
                      >
                        <MessageSquare className="w-4 h-4 shrink-0" aria-hidden="true" /> Relance WhatsApp ({formatDZD(curCustomer.currentDebt || 0)})
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setProfileMenuOpen(false);
                          setDebtPaymentCustomer(curCustomer);
                          setDebtPaymentAmount(curCustomer.currentDebt || 0);
                        }}
                        className="w-full min-h-[44px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-amber-400 hover:bg-amber-500/10 transition text-left cursor-pointer"
                      >
                        <DollarSign className="w-4 h-4 shrink-0" /> Encaisser Dette ({formatDZD(curCustomer.currentDebt || 0)})
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>,
            document.body,
          );
        })()}

        {/* ═══ Modal: Émettre un Avoir Client ═══ */}
        {creditModalOpen && activeProfile && createPortal(
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4" onClick={() => setCreditModalOpen(false)}>
            <div role="dialog" aria-modal="true" aria-label="Émettre un Avoir Client" onClick={(e) => e.stopPropagation()} className="bg-pos-panel border border-pos-border rounded-xl w-full max-w-md p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
              <div className="flex items-center justify-between border-b border-pos-border pb-3">
                <div className="flex items-center gap-2 text-sky-400">
                  <CreditCard className="w-5 h-5" />
                  <h3 className="text-sm font-black text-pos-text">Émettre un Avoir Client</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setCreditModalOpen(false)}
                  aria-label="Fermer"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex justify-between items-center text-xs">
                <div>
                  <p className="font-bold text-pos-text">{activeProfile.name}</p>
                  <p className="text-[10px] text-pos-muted">Tél : {activeProfile.phone}</p>
                </div>
                <div className="text-right">
                  <span className="text-[10px] text-pos-muted block uppercase font-bold">Avoir Actuel</span>
                  <span className="font-mono font-bold text-sky-400 text-sm">{formatDZD(activeProfile.storeCredit || 0)}</span>
                </div>
              </div>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (creditAmount <= 0) {
                    showToast('Veuillez saisir un montant valide.', 'warning');
                    return;
                  }
                  if (creditAmount > STORE_CREDIT_PIN_THRESHOLD_DZD && !creditManagerPin) {
                    showToast('Code PIN Manager requis pour un montant supérieur à 5 000 DA.', 'warning');
                    return;
                  }
                  const res = await issueStoreCredit(activeProfile.id, creditAmount, creditManagerPin || undefined);
                  if (res.success) {
                    showSuccess(`Avoir de ${formatDZD(creditAmount)} crédité avec succès !`);
                    setCreditModalOpen(false);
                    setCreditAmount(0);
                    setCreditManagerPin('');
                  } else {
                    showToast(`Échec émission avoir : ${res.reason === 'INVALID_MANAGER_PIN' ? 'Code PIN Manager incorrect.' : res.reason}`, 'error');
                  }
                }}
                className="space-y-4"
              >
                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Montant de l'Avoir à Émettre (DA) *
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="100"
                    required
                    value={creditAmount || ''}
                    onChange={(e) => setCreditAmount(Math.max(0, Number(e.target.value)))}
                    placeholder="Ex: 2500"
                    className="w-full bg-pos-bg border-2 border-pos-border focus:border-sky-400 rounded-lg px-4 py-2.5 text-xl font-black font-mono text-pos-text focus:outline-none"
                  />
                </div>

                {creditAmount > STORE_CREDIT_PIN_THRESHOLD_DZD && (
                  <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-2">
                    <div className="flex items-center gap-1.5 text-xs text-amber-400 font-bold">
                      <AlertCircle className="w-4 h-4 shrink-0" /> Validation Manager Requise (&gt; 5 000 DA)
                    </div>
                    <label className="text-[10px] uppercase font-bold text-pos-muted block">
                      Code PIN Manager *
                    </label>
                    <input
                      type="password"
                      required
                      value={creditManagerPin}
                      onChange={(e) => setCreditManagerPin(e.target.value)}
                      placeholder="••••"
                      className="w-full bg-pos-bg border border-pos-border focus:border-amber-400 rounded-lg px-3 py-2 text-xs font-mono text-pos-text focus:outline-none"
                    />
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-3 border-t border-pos-border">
                  <button
                    type="button"
                    onClick={() => setCreditModalOpen(false)}
                    className="px-4 py-2 min-h-[44px] bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg text-xs font-bold"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 min-h-[44px] bg-sky-500 hover:bg-sky-400 text-white font-black text-xs rounded-lg shadow-lg shadow-sky-500/20 transition cursor-pointer flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="w-4 h-4" /> Valider l'Avoir
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}

        {/* ═══ Modal: Convertir Points en Avoir ═══ */}
        {redeemModalOpen && activeProfile && (() => {
          const maxPts = activeProfile.loyaltyPoints || 0;
          const loyaltyCfg = normalizeLoyaltyConfig(receiptSettings?.loyaltyConfig);
          const previewCredit = convertPointsToCredit(redeemPoints || 0, loyaltyCfg).creditAmount;
          return createPortal(
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4" onClick={() => setRedeemModalOpen(false)}>
              <div role="dialog" aria-modal="true" aria-label="Convertir des Points en Avoir" onClick={(e) => e.stopPropagation()} className="bg-pos-panel border border-pos-border rounded-xl w-full max-w-md p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
                <div className="flex items-center justify-between border-b border-pos-border pb-3">
                  <div className="flex items-center gap-2 text-amber-400">
                    <RefreshCw className="w-5 h-5" />
                    <h3 className="text-sm font-black text-pos-text">Convertir des Points en Avoir</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRedeemModalOpen(false)}
                    aria-label="Fermer"
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex justify-between items-center text-xs">
                  <div>
                    <p className="font-bold text-pos-text">{activeProfile.name}</p>
                    <p className="text-[10px] text-pos-muted">Solde disponible : <strong className="text-amber-400 font-mono">{maxPts.toLocaleString('fr-DZ')} pts</strong></p>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-pos-muted block uppercase font-bold">Valeur Estimée</span>
                    <span className="font-mono font-bold text-emerald-400 text-sm">+{formatDZD(previewCredit)}</span>
                  </div>
                </div>

                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (redeemPoints <= 0 || redeemPoints > maxPts) {
                      showToast(`Veuillez saisir un nombre de points entre 1 et ${maxPts}.`, 'warning');
                      return;
                    }
                    const res = await redeemLoyaltyPoints(activeProfile.id, redeemPoints);
                    if (res.success) {
                      showSuccess(`${redeemPoints} points convertis en ${formatDZD(res.creditAdded || 0)} d'avoir !`);
                      setRedeemModalOpen(false);
                      setRedeemPoints(0);
                    } else {
                      showToast(`Échec conversion points : ${res.reason || 'Erreur'}`, 'error');
                    }
                  }}
                  className="space-y-4"
                >
                  <div>
                    <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                      Nombre de Points à Échanger *
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="1"
                        max={maxPts}
                        required
                        value={redeemPoints || ''}
                        onChange={(e) => setRedeemPoints(Math.min(maxPts, Math.max(0, Number(e.target.value))))}
                        placeholder="Ex: 500"
                        className="w-full bg-pos-bg border-2 border-pos-border focus:border-amber-400 rounded-lg px-4 py-2 text-lg font-black font-mono text-pos-text focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setRedeemPoints(maxPts)}
                        className="px-3 py-2 min-h-[44px] bg-pos-hover hover:bg-pos-border text-pos-text rounded-lg text-xs font-bold transition whitespace-nowrap cursor-pointer"
                      >
                        Max
                      </button>
                    </div>
                  </div>

                  <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-center justify-between text-xs">
                    <span className="text-pos-text font-bold">Crédit Avoir Généré :</span>
                    <span className="font-mono font-black text-emerald-400 text-base">+{formatDZD(previewCredit)}</span>
                  </div>

                  <div className="flex justify-end gap-2 pt-3 border-t border-pos-border">
                    <button
                      type="button"
                      onClick={() => setRedeemModalOpen(false)}
                      className="px-4 py-2 min-h-[44px] bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg text-xs font-bold"
                    >
                      Annuler
                    </button>
                    <button
                      type="submit"
                      disabled={maxPts === 0 || redeemPoints <= 0}
                      className="px-5 py-2 min-h-[44px] bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-black text-xs rounded-lg shadow-lg shadow-amber-500/20 transition cursor-pointer flex items-center gap-1.5"
                    >
                      <CheckCircle2 className="w-4 h-4" /> Convertir
                    </button>
                  </div>
                </form>
              </div>
            </div>,
            document.body
          );
        })()}

        {/* ═══ Modal: Ajuster les Points Client ═══ */}
        {adjustModalOpen && activeProfile && createPortal(
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4" onClick={() => setAdjustModalOpen(false)}>
            <div role="dialog" aria-modal="true" aria-label="Ajustement Manuel des Points" onClick={(e) => e.stopPropagation()} className="bg-pos-panel border border-pos-border rounded-xl w-full max-w-md p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
              <div className="flex items-center justify-between border-b border-pos-border pb-3">
                <div className="flex items-center gap-2 text-pos-text">
                  <Edit2 className="w-5 h-5 text-amber-400" />
                  <h3 className="text-sm font-black text-pos-text">Ajustement Manuel des Points</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setAdjustModalOpen(false)}
                  aria-label="Fermer"
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex justify-between items-center text-xs">
                <div>
                  <p className="font-bold text-pos-text">{activeProfile.name}</p>
                  <p className="text-[10px] text-pos-muted">Tél : {activeProfile.phone}</p>
                </div>
                <div className="text-right">
                  <span className="text-[10px] text-pos-muted block uppercase font-bold">Solde Actuel</span>
                  <span className="font-mono font-bold text-amber-400 text-sm">{(activeProfile.loyaltyPoints || 0).toLocaleString('fr-DZ')} pts</span>
                </div>
              </div>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (adjustPoints === 0) {
                    showToast('Veuillez saisir une variation de points différente de zéro.', 'warning');
                    return;
                  }
                  if (!adjustReason.trim()) {
                    showToast('Un motif d\'ajustement est obligatoire.', 'warning');
                    return;
                  }
                  const res = await adjustCustomerPoints(activeProfile.id, adjustPoints, adjustReason.trim());
                  if (res.success) {
                    showSuccess(`Points ajustés (${adjustPoints > 0 ? '+' : ''}${adjustPoints} pts) avec succès !`);
                    setAdjustModalOpen(false);
                    setAdjustPoints(0);
                    setAdjustReason('');
                  } else {
                    showToast(`Échec ajustement points : ${res.reason || 'Erreur'}`, 'error');
                  }
                }}
                className="space-y-4"
              >
                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Variation de Points (+ pour ajouter, - pour déduire) *
                  </label>
                  <input
                    type="number"
                    step="10"
                    required
                    value={adjustPoints || ''}
                    onChange={(e) => setAdjustPoints(Number(e.target.value))}
                    placeholder="Ex: +100 ou -50"
                    className="w-full bg-pos-bg border border-pos-border focus:border-amber-400 rounded-lg px-4 py-2 text-base font-bold font-mono text-pos-text focus:outline-none"
                  />
                  <p className="text-[10px] text-pos-muted mt-1">
                    Nouveau solde prévu : <strong className="text-pos-text font-mono">{Math.max(0, (activeProfile.loyaltyPoints || 0) + (adjustPoints || 0))} pts</strong>
                  </p>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Motif / Justification *
                  </label>
                  <input
                    type="text"
                    required
                    value={adjustReason}
                    onChange={(e) => setAdjustReason(e.target.value)}
                    placeholder="Ex: Geste commercial retard SAV, correction saisie..."
                    className="w-full bg-pos-bg border border-pos-border focus:border-amber-400 rounded-lg px-3 py-2 text-xs text-pos-text focus:outline-none"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-pos-border">
                  <button
                    type="button"
                    onClick={() => setAdjustModalOpen(false)}
                    className="px-4 py-2 min-h-[44px] bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg text-xs font-bold"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 min-h-[44px] bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-lg shadow-lg shadow-emerald-500/20 transition cursor-pointer flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="w-4 h-4" /> Appliquer l'Ajustement
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}

        {/* ═══ UPGRADE-04: Grilles Tarifaires (contract price books) ═══ */}
        <PriceBooksModal isOpen={isPriceBooksOpen} onClose={() => setIsPriceBooksOpen(false)} />

        {/* ═══ Footer ═══ */}
        <div className="p-3 sm:p-4 pb-[max(1rem,var(--safe-bottom))] sm:pb-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-2 text-xs text-pos-muted shrink-0">
          <span className="truncate max-w-[280px] sm:max-w-none">
            CRM Clientèle • {(customers || []).length} profils • {formatDZD(totalCreditOutstanding)} avoirs • {formatDZD(totalDebtOutstanding)} dettes
          </span>
          <button
            onClick={closeModal}
            className="px-5 py-2.5 rounded-lg bg-pos-hover hover:bg-pos-border text-pos-text font-bold min-h-[44px] flex items-center justify-center active-press cursor-pointer"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};

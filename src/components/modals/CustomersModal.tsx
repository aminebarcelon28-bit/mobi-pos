import React, { useState, useMemo } from 'react';
import {
  X, User, Star, Phone, Mail, Check, Plus, Edit2, Trash2, Search,
  CheckCircle2, TrendingUp, ShoppingBag, CreditCard, Award,
  UserPlus, History, Crown, FileText, MessageSquare, DollarSign,
  ArrowDownLeft, ArrowUpRight, Copy, ExternalLink
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import type { Customer, PricingTier, SaleTransaction, PaymentMethodType } from '../../types/pos';
import { calculateNextTierProgress, calculateCustomerTier } from '../../utils/loyaltyEngine';
import { buildWhatsAppUrl } from '../../utils/phoneUtils';

type SortField = 'name' | 'loyaltyPoints' | 'storeCredit' | 'totalSpent';
type SortDir = 'asc' | 'desc';
type ViewMode = 'list' | 'form' | 'profile';
type TierFilter = 'Tous' | PricingTier;

export const CustomersModal: React.FC = () => {
  const {
    activeModal, closeModal, openModal, customers, currentCustomer, setCurrentCustomer,
    addCustomer, updateCustomer, deleteCustomer, transactions,
    customerDebts, recordCustomerDebtPayment
  } = usePosStore();

  const [mainTab, setMainTab] = useState<'directory' | 'debts'>('directory');
  const [searchQuery, setSearchQuery] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<TierFilter>('Tous');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [profileCustomer, setProfileCustomer] = useState<Customer | null>(null);

  // Debt Payment & WhatsApp State
  const [debtPaymentCustomer, setDebtPaymentCustomer] = useState<Customer | null>(null);
  const [debtPaymentAmount, setDebtPaymentAmount] = useState<string>('');
  const [debtPaymentMethod, setDebtPaymentMethod] = useState<PaymentMethodType>('Espèces');
  const [debtPaymentNotes, setDebtPaymentNotes] = useState<string>('');
  const [whatsappDebtCustomer, setWhatsappDebtCustomer] = useState<Customer | null>(null);
  const [whatsappCopied, setWhatsappCopied] = useState(false);

  // Form State
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [registeredDevice, setRegisteredDevice] = useState('');
  const [pricingTier, setPricingTier] = useState<PricingTier>('Retail');

  // Compute customer metrics from transaction history
  const getCustomerMetrics = React.useCallback((customerId: string) => {
    const customerTxns = (transactions || []).filter(t => t.customer?.id === customerId);
    const totalSpent = customerTxns.reduce((acc, t) => acc + (t.total || 0), 0);
    const totalOrders = customerTxns.length;
    const avgBasket = totalOrders > 0 ? totalSpent / totalOrders : 0;
    const lastPurchase = customerTxns.length > 0 ? customerTxns[0]?.createdAt : null;
    return { totalSpent, totalOrders, avgBasket, lastPurchase, transactions: customerTxns };
  }, [transactions]);

  // Filtered & Sorted Customers (hook must be above early return)
  const filteredCustomers = useMemo(() => {
    const lowerQ = searchQuery.toLowerCase();
    let results = (customers || []).filter(c =>
      (c.name || '').toLowerCase().includes(lowerQ) ||
      (c.phone || '').toLowerCase().includes(lowerQ) ||
      (c.email || '').toLowerCase().includes(lowerQ) ||
      (c.registeredDevice || '').toLowerCase().includes(lowerQ)
    );

    if (tierFilter !== 'Tous') {
      results = results.filter(c => c.pricingTier === tierFilter);
    }

    // Pre-calculate spent lookup map once to avoid O(N log N * M) recalculation during sort
    const spentMap = new Map<string, number>();
    if (sortField === 'totalSpent') {
      (transactions || []).forEach(t => {
        if (t.customer?.id && t.status !== 'VOIDED' && !t.isRefund) {
          spentMap.set(t.customer.id, (spentMap.get(t.customer.id) || 0) + (t.total || 0));
        }
      });
    }

    results.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'loyaltyPoints': cmp = (a.loyaltyPoints || 0) - (b.loyaltyPoints || 0); break;
        case 'storeCredit': cmp = (a.storeCredit || 0) - (b.storeCredit || 0); break;
        case 'totalSpent': {
          const aSpent = spentMap.get(a.id) ?? a.totalSpent ?? 0;
          const bSpent = spentMap.get(b.id) ?? b.totalSpent ?? 0;
          cmp = aSpent - bSpent;
          break;
        }
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return results;
  }, [customers, searchQuery, tierFilter, sortField, sortDir, transactions]);

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
    const lowerQ = searchQuery.toLowerCase();
    return (customers || []).filter(c =>
      (c.currentDebt || 0) > 0 &&
      ((c.name || '').toLowerCase().includes(lowerQ) ||
       (c.phone || '').toLowerCase().includes(lowerQ) ||
       (c.registeredDevice || '').toLowerCase().includes(lowerQ))
    );
  }, [customers, searchQuery]);

  const handleRecordDebtPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!debtPaymentCustomer) return;
    const amount = parseFloat(debtPaymentAmount);
    if (isNaN(amount) || amount <= 0) {
      alert('Veuillez saisir un montant valide.');
      return;
    }
    const res = await recordCustomerDebtPayment(
      debtPaymentCustomer.id,
      amount,
      debtPaymentMethod,
      debtPaymentNotes
    );
    if (res.success) {
      showSuccess(`Versement de ${formatDZD(amount)} enregistré avec succès !`);
      setDebtPaymentCustomer(null);
      setDebtPaymentAmount('');
      setDebtPaymentNotes('');
    }
  };

  const getWhatsAppDebtMessage = (c: Customer) => {
    const storeName = usePosStore.getState().receiptSettings.storeName || 'MOBI ACCESSORIES';
    const storePhone = usePosStore.getState().receiptSettings.phone || '';
    const debtAmount = c.currentDebt || 0;
    return `Salam ${c.name} !\n\nRappel amical de votre boutique *${storeName}* :\n\n📌 *Solde Dette Actuelle :* ${formatDZD(debtAmount)}\n\nVous pouvez passer au magasin pour régler votre solde en espèces. Merci pour votre fidélité !\n\n📞 Contact : ${storePhone}`;
  };

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setPhone('');
    setEmail('');
    setRegisteredDevice('');
    setPricingTier('Retail');
    setViewMode('list');
  };

  const handleEditClick = (c: Customer) => {
    setEditingId(c.id);
    setName(c.name);
    setPhone(c.phone);
    setEmail(c.email);
    setRegisteredDevice(c.registeredDevice);
    setPricingTier(c.pricingTier);
    setViewMode('form');
  };

  const handleSaveCustomer = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingId) {
      updateCustomer(editingId, { name, phone, email, registeredDevice, pricingTier });
      showSuccess('Profil client mis à jour avec succès !');
    } else {
      addCustomer({
        name, phone, email, registeredDevice, pricingTier, loyaltyPoints: 0, storeCredit: 0
      });
      showSuccess('Nouveau client ajouté au CRM !');
    }
    resetForm();
  };

  const handleDelete = (id: string) => {
    const target = customers.find((c) => c.id === id);
    if (target && (target.currentDebt || 0) > 0) {
      alert(`⚠️ Impossible de supprimer ce client : une dette active de ${target.currentDebt} DA est en cours sur son compte. Veuillez solder ou transférer la créance avant suppression.`);
      return;
    }
    if (window.confirm("Êtes-vous sûr de vouloir supprimer définitivement ce client et son historique ?")) {
      deleteCustomer(id);
      if (profileCustomer?.id === id) setProfileCustomer(null);
      setViewMode('list');
      showSuccess('Client supprimé du CRM.');
    }
  };

  const openProfile = (c: Customer) => {
    setProfileCustomer(c);
    setViewMode('profile');
  };

  const tierBadge = (tier: PricingTier) => {
    const styles: Record<PricingTier, string> = {
      'Retail': 'bg-slate-500/15 text-slate-400 border-slate-500/30',
      'Wholesale': 'bg-blue-500/15 text-blue-400 border-blue-500/30',
      'VIP': 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    };
    const icons: Record<PricingTier, React.ReactNode> = {
      'Retail': <User className="w-3 h-3" />,
      'Wholesale': <ShoppingBag className="w-3 h-3" />,
      'VIP': <Crown className="w-3 h-3" />,
    };
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase border ${styles[tier]}`}>
        {icons[tier]} {tier}
      </span>
    );
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  if (activeModal !== 'customers') return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[90vh] flex flex-col">

        {/* ═══ Header ═══ */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2.5 text-blue-400">
            <div className="w-9 h-9 rounded-xl bg-blue-500/20 flex items-center justify-center border border-blue-500/30 shadow-lg">
              <User className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-pos-text tracking-wide">
                CRM & GESTION CLIENTÈLE
              </h2>
              <p className="text-[10px] text-pos-muted">
                {(customers || []).length} clients enregistrés • Fidélité, Avoirs & Historique d'Achats
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {viewMode === 'list' && (
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Rechercher nom, tél, email, appareil..."
                  className="bg-pos-bg border border-pos-border rounded-full pl-9 pr-4 py-1.5 text-xs text-pos-text focus:border-blue-400 focus:outline-none w-72 transition-all"
                />
              </div>
            )}
            <button onClick={closeModal} className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ═══ KPI Summary Bar ═══ */}
        <div className="grid grid-cols-5 gap-2.5 px-4 py-3 border-b border-pos-border bg-pos-card/50 shrink-0">
          <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
              <User className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div>
              <span className="text-[9px] text-pos-muted uppercase font-bold block">Total Clients</span>
              <span className="text-sm font-black text-pos-text">{(customers || []).length}</span>
            </div>
          </div>

          <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
              <Star className="w-4 h-4 stroke-[2.5] fill-amber-400" />
            </div>
            <div>
              <span className="text-[9px] text-pos-muted uppercase font-bold block">Points Fidélité</span>
              <span className="text-sm font-black text-amber-400">{totalLoyaltyPoints.toLocaleString('fr-DZ')}</span>
            </div>
          </div>

          <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <CreditCard className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div>
              <span className="text-[9px] text-pos-muted uppercase font-bold block">Avoirs en Cours</span>
              <span className="text-sm font-black text-emerald-400">{formatDZD(totalCreditOutstanding)}</span>
            </div>
          </div>

          <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center shrink-0">
              <ShoppingBag className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div>
              <span className="text-[9px] text-pos-muted uppercase font-bold block">Grossistes</span>
              <span className="text-sm font-black text-purple-400">{wholesaleCount}</span>
            </div>
          </div>

          <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-rose-500/20 text-rose-400 flex items-center justify-center shrink-0">
              <Crown className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div>
              <span className="text-[9px] text-pos-muted uppercase font-bold block">VIP</span>
              <span className="text-sm font-black text-rose-400">{vipCount}</span>
            </div>
          </div>
        </div>

        {/* ═══ Sub-Tab Navigation ═══ */}
        <div className="flex border-b border-pos-border px-4 bg-pos-card shrink-0 gap-2">
          <button
            onClick={() => setMainTab('directory')}
            className={`py-2.5 px-4 text-xs font-black border-b-2 transition-all flex items-center gap-2 cursor-pointer ${
              mainTab === 'directory'
                ? 'border-blue-500 text-blue-400 bg-blue-500/10 rounded-t-lg'
                : 'border-transparent text-pos-muted hover:text-pos-text'
            }`}
          >
            <User className="w-4 h-4" />
            Répertoire & Profils Clients ({(customers || []).length})
          </button>

          <button
            onClick={() => setMainTab('debts')}
            className={`py-2.5 px-4 text-xs font-black border-b-2 transition-all flex items-center gap-2 cursor-pointer ${
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
        </div>

        {/* ═══ Content Body ═══ */}
        <div className="flex-1 overflow-y-auto p-4 relative flex flex-col gap-4">
          {successMsg && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-emerald-500 text-slate-950 px-4 py-2 rounded-full text-xs font-black flex items-center gap-2 z-20 shadow-xl animate-in fade-in slide-in-from-top-4">
              <CheckCircle2 className="w-4 h-4" /> {successMsg}
            </div>
          )}

          {/* ═══ Directory Tab Views ═══ */}
          {mainTab === 'directory' && viewMode === 'form' && (
            <div className="bg-pos-card border border-pos-border rounded-xl p-6 max-w-2xl mx-auto w-full shadow-lg">
              <div className="flex justify-between items-center mb-5">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                    <UserPlus className="w-4 h-4 stroke-[2.5]" />
                  </div>
                  <h3 className="text-sm font-extrabold text-pos-text">{editingId ? 'Modifier le Profil Client' : 'Créer un Nouveau Client'}</h3>
                </div>
                <button onClick={resetForm} className="text-xs text-pos-muted hover:text-pos-text bg-pos-hover px-3 py-1 rounded-lg font-semibold transition">Annuler</button>
              </div>
              <form onSubmit={handleSaveCustomer} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] text-pos-muted uppercase font-bold block mb-1.5">Nom Complet *</label>
                    <input type="text" required value={name} onChange={e => setName(e.target.value)}
                      placeholder="Ex: Mohamed Amine"
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none transition" />
                  </div>
                  <div>
                    <label className="text-[10px] text-pos-muted uppercase font-bold block mb-1.5">Téléphone *</label>
                    <input type="tel" required value={phone} onChange={e => setPhone(e.target.value)}
                      placeholder="Ex: 0550 12 34 56"
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none transition" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] text-pos-muted uppercase font-bold block mb-1.5">Email</label>
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                      placeholder="Ex: email@domaine.dz"
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none transition" />
                  </div>
                  <div>
                    <label className="text-[10px] text-pos-muted uppercase font-bold block mb-1.5">Appareil Principal</label>
                    <input type="text" value={registeredDevice} onChange={e => setRegisteredDevice(e.target.value)}
                      placeholder="Ex: iPhone 15 Pro Max"
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none transition" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-pos-muted uppercase font-bold block mb-1.5">Niveau de Tarification</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['Retail', 'Wholesale', 'VIP'] as PricingTier[]).map(tier => (
                      <button key={tier} type="button" onClick={() => setPricingTier(tier)}
                        className={`p-3 rounded-xl border text-xs font-bold transition-all text-center ${
                          pricingTier === tier
                            ? tier === 'VIP' ? 'bg-amber-500/20 border-amber-500 text-amber-400 shadow-md shadow-amber-500/10'
                            : tier === 'Wholesale' ? 'bg-blue-500/20 border-blue-500 text-blue-400 shadow-md shadow-blue-500/10'
                            : 'bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-md shadow-emerald-500/10'
                            : 'bg-pos-bg border-pos-border text-pos-muted hover:border-pos-text/30'
                        }`}
                      >
                        {tier === 'VIP' && <Crown className="w-4 h-4 mx-auto mb-1" />}
                        {tier === 'Wholesale' && <ShoppingBag className="w-4 h-4 mx-auto mb-1" />}
                        {tier === 'Retail' && <User className="w-4 h-4 mx-auto mb-1" />}
                        {tier === 'Retail' ? 'Retail (Public)' : tier === 'Wholesale' ? 'Wholesale (Gros)' : 'VIP (Privilège)'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-3 border-t border-pos-border">
                  <button type="button" onClick={resetForm} className="px-4 py-2.5 rounded-xl bg-pos-hover text-pos-text font-semibold text-xs transition">Annuler</button>
                  <button type="submit" className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition cursor-pointer">
                    <CheckCircle2 className="w-4 h-4" /> {editingId ? 'Mettre à Jour' : 'Créer le Client'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* ═══ Customer Profile Detail View ═══ */}
          {mainTab === 'directory' && viewMode === 'profile' && profileCustomer && (() => {
            const metrics = getCustomerMetrics(profileCustomer.id);
            return (
              <div className="max-w-3xl mx-auto w-full space-y-4">
                {/* Back Button */}
                <button onClick={() => setViewMode('list')} className="text-xs text-pos-muted hover:text-pos-text flex items-center gap-1 font-semibold transition">
                  ← Retour à la Liste
                </button>

                {/* Profile Header Card */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-5 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500/30 to-purple-500/30 border border-pos-border flex items-center justify-center overflow-hidden shadow-lg">
                      {profileCustomer.avatarUrl
                        ? <img src={profileCustomer.avatarUrl} alt={profileCustomer.name} className="w-full h-full object-cover" />
                        : <User className="w-8 h-8 text-blue-400" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-black text-pos-text">{profileCustomer.name}</h3>
                        {tierBadge(profileCustomer.pricingTier)}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-pos-muted mt-1">
                        <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {profileCustomer.phone}</span>
                        {profileCustomer.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {profileCustomer.email}</span>}
                      </div>
                      {profileCustomer.registeredDevice && (
                        <p className="text-[10px] text-pos-muted mt-1">Appareil : {profileCustomer.registeredDevice}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleEditClick(profileCustomer)} className="px-3 py-2 rounded-xl bg-pos-hover border border-pos-border text-pos-text text-xs font-bold flex items-center gap-1.5 hover:border-blue-400 transition cursor-pointer">
                      <Edit2 className="w-3.5 h-3.5" /> Modifier
                    </button>
                    <button
                      onClick={() => {
                        if (currentCustomer?.id === profileCustomer.id) {
                          setCurrentCustomer(null);
                          showSuccess('Client détaché de la vente.');
                        } else {
                          setCurrentCustomer(profileCustomer);
                          showSuccess(`${profileCustomer.name} sélectionné pour la vente.`);
                          closeModal();
                        }
                      }}
                      className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition cursor-pointer ${
                        currentCustomer?.id === profileCustomer.id
                          ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                          : 'bg-blue-500 hover:bg-blue-400 text-white shadow-md shadow-blue-500/20'
                      }`}
                    >
                      {currentCustomer?.id === profileCustomer.id ? <><Check className="w-3.5 h-3.5" /> Sélectionné</> : <><Check className="w-3.5 h-3.5" /> Sélectionner</>}
                    </button>
                    
                    <button
                      onClick={() => {
                        setCurrentCustomer(profileCustomer);
                        openModal('loyalty_card');
                      }}
                      className="px-3.5 py-2 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                    >
                      <CreditCard className="w-3.5 h-3.5" /> Carte PVC / Pass Digital
                    </button>
                  </div>
                </div>

                {/* Metrics Cards */}
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-pos-card border border-pos-border p-3 rounded-xl text-center">
                    <TrendingUp className="w-5 h-5 text-emerald-400 mx-auto mb-1" />
                    <span className="text-[9px] text-pos-muted uppercase font-bold block">CA Total</span>
                    <span className="text-sm font-black text-emerald-400">{formatDZD(metrics.totalSpent)}</span>
                  </div>
                  <div className="bg-pos-card border border-pos-border p-3 rounded-xl text-center">
                    <ShoppingBag className="w-5 h-5 text-blue-400 mx-auto mb-1" />
                    <span className="text-[9px] text-pos-muted uppercase font-bold block">Commandes</span>
                    <span className="text-sm font-black text-blue-400">{metrics.totalOrders}</span>
                  </div>
                  <div className="bg-pos-card border border-pos-border p-3 rounded-xl text-center">
                    <Star className="w-5 h-5 text-amber-400 fill-amber-400 mx-auto mb-1" />
                    <span className="text-[9px] text-pos-muted uppercase font-bold block">Points</span>
                    <span className="text-sm font-black text-amber-400">{(profileCustomer.loyaltyPoints || 0).toLocaleString('fr-DZ')}</span>
                  </div>
                  <div className={`bg-pos-card border p-3 rounded-xl text-center ${
                    (profileCustomer.currentDebt || 0) > 0 ? 'border-amber-500/50 bg-amber-500/5' : 'border-pos-border'
                  }`}>
                    <FileText className={`w-5 h-5 mx-auto mb-1 ${
                      (profileCustomer.currentDebt || 0) > 0 ? 'text-amber-400' : 'text-cyan-400'
                    }`} />
                    <span className="text-[9px] text-pos-muted uppercase font-bold block">
                      {(profileCustomer.currentDebt || 0) > 0 ? 'Dette En Cours' : 'Avoir'}
                    </span>
                    <span className={`text-sm font-black ${
                      (profileCustomer.currentDebt || 0) > 0 ? 'text-amber-400 font-mono' : 'text-cyan-400'
                    }`}>
                      {(profileCustomer.currentDebt || 0) > 0
                        ? formatDZD(profileCustomer.currentDebt || 0)
                        : formatDZD(profileCustomer.storeCredit || 0)}
                    </span>
                  </div>
                </div>

                {/* Loyalty Tier Progress */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-4">
                  {(() => {
                    const currentSpent = profileCustomer.totalSpent || 0;
                    const currentTier = calculateCustomerTier(currentSpent);
                    const progress = calculateNextTierProgress(currentSpent);
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

                {/* Recent Transactions */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-4">
                  <h4 className="text-xs font-bold text-pos-text mb-3 flex items-center gap-1.5">
                    <History className="w-4 h-4 text-cyan-400" /> Historique d'Achats Récents
                    <span className="ml-auto text-[10px] text-pos-muted font-normal">{metrics.transactions.length} transactions</span>
                  </h4>
                  {metrics.transactions.length === 0 ? (
                    <p className="text-xs text-pos-muted text-center py-4">Aucune transaction enregistrée pour ce client.</p>
                  ) : (
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {metrics.transactions.slice(0, 10).map((t: SaleTransaction) => (
                        <div key={t.id} className="flex items-center justify-between bg-pos-bg p-2.5 rounded-lg border border-pos-border text-xs hover:border-pos-text/20 transition">
                          <div className="flex items-center gap-2.5">
                            <span className="font-mono text-[10px] text-pos-muted">{t.receiptNumber}</span>
                            <span className="text-pos-muted">{formatDateTime(t.createdAt)}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-[10px] text-pos-muted">{(t.items || []).length} art.</span>
                            <span className="font-bold text-emerald-400">{formatDZD(t.total)}</span>
                          </div>
                        </div>
                      ))}
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
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-bold text-pos-muted uppercase tracking-wider">Liste des Clients</h3>

                  {/* Tier Filter Pills */}
                  <div className="flex items-center gap-1 ml-3">
                    {(['Tous', 'Retail', 'Wholesale', 'VIP'] as TierFilter[]).map(f => (
                      <button key={f} onClick={() => setTierFilter(f)}
                        className={`px-2.5 py-1 rounded-full text-[10px] font-bold transition cursor-pointer ${
                          tierFilter === f ? 'bg-blue-500 text-white shadow-md' : 'bg-pos-hover text-pos-muted hover:text-pos-text border border-pos-border'
                        }`}
                      >{f} {f !== 'Tous' && `(${(customers || []).filter(c => c.pricingTier === f).length})`}</button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Sort Dropdown */}
                  <div className="flex items-center gap-1">
                    <button onClick={() => toggleSort('name')} className={`px-2 py-1 rounded-md text-[10px] font-bold transition cursor-pointer ${sortField === 'name' ? 'bg-pos-card border border-blue-400/50 text-blue-400' : 'text-pos-muted hover:text-pos-text'}`}>
                      A→Z {sortField === 'name' && (sortDir === 'asc' ? '↑' : '↓')}
                    </button>
                    <button onClick={() => toggleSort('loyaltyPoints')} className={`px-2 py-1 rounded-md text-[10px] font-bold transition cursor-pointer ${sortField === 'loyaltyPoints' ? 'bg-pos-card border border-amber-400/50 text-amber-400' : 'text-pos-muted hover:text-pos-text'}`}>
                      Points {sortField === 'loyaltyPoints' && (sortDir === 'asc' ? '↑' : '↓')}
                    </button>
                    <button onClick={() => toggleSort('storeCredit')} className={`px-2 py-1 rounded-md text-[10px] font-bold transition cursor-pointer ${sortField === 'storeCredit' ? 'bg-pos-card border border-emerald-400/50 text-emerald-400' : 'text-pos-muted hover:text-pos-text'}`}>
                      Avoir {sortField === 'storeCredit' && (sortDir === 'asc' ? '↑' : '↓')}
                    </button>
                  </div>

                  <button onClick={() => { resetForm(); setViewMode('form'); }}
                    className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-xs font-bold flex items-center gap-1.5 transition shadow-lg shadow-emerald-500/20 cursor-pointer">
                    <Plus className="w-4 h-4" /> Ajouter un Client
                  </button>
                </div>
              </div>

              {/* Customer Cards Grid */}
              <div className="grid grid-cols-2 gap-3">
                {filteredCustomers.map(customer => {
                  const metrics = getCustomerMetrics(customer.id);
                  const isSelected = currentCustomer?.id === customer.id;
                  const hasDebt = (customer.currentDebt || 0) > 0;

                  return (
                    <div key={customer.id}
                      className={`bg-pos-card border rounded-xl p-4 flex flex-col gap-3 relative transition-all hover:shadow-md group cursor-pointer ${
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
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-pos-border flex items-center justify-center overflow-hidden">
                            {customer.avatarUrl
                              ? <img src={customer.avatarUrl} alt={customer.name} className="w-full h-full object-cover" />
                              : <User className="w-5 h-5 text-blue-400" />}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="text-sm font-bold text-pos-text">{customer.name}</h3>
                              {tierBadge(customer.pricingTier)}
                              {hasDebt && (
                                <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[9px] font-black animate-pulse">
                                  Dette: {formatDZD(customer.currentDebt || 0)}
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-[10px] text-pos-muted mt-0.5">
                              <span className="flex items-center gap-0.5"><Phone className="w-3 h-3" /> {customer.phone}</span>
                              {customer.email && <span className="flex items-center gap-0.5"><Mail className="w-3 h-3" /> {customer.email}</span>}
                            </div>
                          </div>
                        </div>

                        {/* Action Icons */}
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                          <button onClick={() => handleEditClick(customer)} className="p-1.5 text-pos-muted hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => handleDelete(customer.id)} className="p-1.5 text-pos-muted hover:text-red-400 hover:bg-red-500/10 rounded-lg transition">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Metrics Strip */}
                      <div className="grid grid-cols-4 gap-1.5 bg-pos-bg rounded-lg p-2 border border-pos-border text-xs">
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
                          <span className="font-bold text-blue-400 text-[11px]">{metrics.totalOrders}</span>
                        </div>
                        <div className="flex flex-col items-center">
                          <span className="text-[8px] text-pos-muted uppercase font-bold">CA</span>
                          <span className="font-bold text-cyan-400 text-[11px]">{formatDZD(metrics.totalSpent)}</span>
                        </div>
                      </div>

                      {/* Footer Row */}
                      <div className="flex justify-between items-center pt-1">
                        <span className="text-[10px] text-pos-muted truncate max-w-[140px]">
                          {customer.registeredDevice ? `📱 ${customer.registeredDevice}` : 'Appareil non renseigné'}
                        </span>
                        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          {customer.storeCredit > 0 && (
                            <button
                              onClick={() => {
                                setCurrentCustomer(customer);
                                showSuccess(`Avoir de ${formatDZD(customer.storeCredit)} activé pour ${customer.name}. Choisissez un produit dans le catalogue.`);
                                closeModal();
                              }}
                              className="px-2.5 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/40 text-xs font-extrabold flex items-center gap-1 transition cursor-pointer shadow-sm shadow-emerald-500/10"
                              title="Activer l'avoir client et choisir un produit dans le catalogue"
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
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 cursor-pointer ${
                              isSelected
                                ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                                : 'bg-pos-hover text-pos-text hover:bg-pos-border'
                            }`}
                          >
                            {isSelected ? <><Check className="w-3.5 h-3.5" /> Actif</> : 'Sélectionner'}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {filteredCustomers.length === 0 && (
                  <div className="col-span-2 text-center py-16">
                    <User className="w-10 h-10 text-pos-muted/30 mx-auto mb-3" />
                    <p className="text-sm font-bold text-pos-muted">Aucun client trouvé</p>
                    <p className="text-xs text-pos-muted/60 mt-1">Ajustez votre recherche ou ajoutez un nouveau client.</p>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ═══ CARNET DE DETTES & RÈGLEMENTS (KREDY) ═══ */}
          {mainTab === 'debts' && (
            <div className="space-y-5 animate-in fade-in">
              {/* Executive Debt Summary Banner */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-gradient-to-br from-amber-950/60 to-orange-950/60 border-2 border-amber-500/60 rounded-2xl p-4 shadow-xl">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[11px] uppercase tracking-wider text-amber-300 font-bold block">
                        Total Créances Clients (En Cours)
                      </span>
                      <span className="text-2xl font-black text-amber-400 font-mono tracking-tight block mt-0.5">
                        {formatDZD(totalDebtOutstanding)}
                      </span>
                    </div>
                    <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-300">
                      <FileText className="w-5 h-5" />
                    </div>
                  </div>
                  <p className="text-[10px] text-amber-200/70 mt-2">
                    Somme totale des dettes non encore recouvrées
                  </p>
                </div>

                <div className="bg-pos-card border border-pos-border rounded-2xl p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[11px] uppercase tracking-wider text-pos-muted font-bold block">
                        Clients Débiteurs
                      </span>
                      <span className="text-2xl font-black text-pos-text block mt-0.5">
                        {indebtedCount} client{indebtedCount > 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="w-10 h-10 rounded-xl bg-red-500/20 border border-red-500/40 flex items-center justify-center text-red-400">
                      <User className="w-5 h-5" />
                    </div>
                  </div>
                  <p className="text-[10px] text-pos-muted mt-2">
                    Sur un total de {(customers || []).length} clients enregistrés
                  </p>
                </div>

                <div className="bg-pos-card border border-pos-border rounded-2xl p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[11px] uppercase tracking-wider text-pos-muted font-bold block">
                        Total Versements Reçus
                      </span>
                      <span className="text-2xl font-black text-emerald-400 font-mono tracking-tight block mt-0.5">
                        {formatDZD((customerDebts || []).filter(d => d.type === 'PAYMENT_SETTLED').reduce((a, b) => a + b.amount, 0))}
                      </span>
                    </div>
                    <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
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
                  <div className="bg-pos-card border border-pos-border rounded-2xl p-8 text-center space-y-2">
                    <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto" />
                    <h4 className="text-sm font-bold text-pos-text">Aucune dette en cours !</h4>
                    <p className="text-xs text-pos-muted max-w-sm mx-auto">
                      Toutes les créances clients sont soldées ou aucun client ne correspond à votre filtre de recherche.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {indebtedCustomers.map(customer => {
                      const debt = customer.currentDebt || 0;
                      return (
                        <div
                          key={customer.id}
                          className="bg-pos-card border-2 border-amber-500/40 hover:border-amber-500 rounded-2xl p-4 flex flex-col justify-between gap-3 shadow-md transition-all"
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
                                setDebtPaymentAmount(debt.toString());
                                setDebtPaymentMethod('Espèces');
                                setDebtPaymentNotes('');
                              }}
                              className="flex-1 px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black flex items-center justify-center gap-1.5 transition shadow-md shadow-emerald-500/20 cursor-pointer"
                            >
                              <DollarSign className="w-4 h-4" /> Encaisser Versement
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setWhatsappDebtCustomer(customer);
                                setWhatsappCopied(false);
                              }}
                              className="px-3 py-2 rounded-xl bg-emerald-950/60 hover:bg-emerald-900 text-emerald-300 border border-emerald-500/40 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
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
              <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-pos-text flex items-center gap-1.5">
                    <History className="w-4 h-4 text-cyan-400" />
                    Grand Livre des Dettes & Règlements ({(customerDebts || []).length} écritures)
                  </h3>
                </div>

                {(customerDebts || []).length === 0 ? (
                  <p className="text-xs text-pos-muted text-center py-6">
                    Aucun mouvement de dette ou règlement enregistré pour le moment.
                  </p>
                ) : (
                  <div className="overflow-x-auto max-h-60 overflow-y-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
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

        {/* ═══ Debt Settlement Payment Modal Dialog ═══ */}
        {debtPaymentCustomer && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
              <div className="flex items-center justify-between border-b border-pos-border pb-3">
                <div className="flex items-center gap-2 text-emerald-400">
                  <DollarSign className="w-5 h-5" />
                  <h3 className="text-sm font-black text-pos-text">Règlement de Dette Client</h3>
                </div>
                <button
                  onClick={() => setDebtPaymentCustomer(null)}
                  className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg"
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
                  <input
                    type="number"
                    required
                    min="1"
                    max={debtPaymentCustomer.currentDebt || undefined}
                    value={debtPaymentAmount}
                    onChange={(e) => setDebtPaymentAmount(e.target.value)}
                    className="w-full bg-pos-bg border-2 border-pos-border focus:border-emerald-400 rounded-xl px-4 py-2.5 text-xl font-black font-mono text-pos-text focus:outline-none"
                    placeholder="5000"
                    autoFocus
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Mode de Règlement
                  </label>
                  <div className="p-3 rounded-xl bg-pos-card border border-pos-border flex items-center justify-between text-xs">
                    <span className="font-bold text-pos-text">Espèces (Tiroir-Caisse)</span>
                    <span className="text-[10px] text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
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
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-pos-border">
                  <button
                    type="button"
                    onClick={() => setDebtPaymentCustomer(null)}
                    className="px-4 py-2 bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl text-xs font-bold"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl shadow-lg shadow-emerald-500/20 transition cursor-pointer flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="w-4 h-4" /> Valider le Versement
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ═══ WhatsApp Debt Generator Dialog ═══ */}
        {whatsappDebtCustomer && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
              <div className="flex items-center justify-between border-b border-pos-border pb-3">
                <div className="flex items-center gap-2 text-emerald-400">
                  <MessageSquare className="w-5 h-5" />
                  <h3 className="text-sm font-black text-pos-text">Rappel WhatsApp — {whatsappDebtCustomer.name}</h3>
                </div>
                <button
                  onClick={() => setWhatsappDebtCustomer(null)}
                  className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg"
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
                  className="px-4 py-2 bg-pos-hover hover:bg-pos-border text-pos-text rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer transition"
                >
                  <Copy className="w-4 h-4" /> {whatsappCopied ? 'Copié !' : 'Copier le Texte'}
                </button>
                <a
                  href={buildWhatsAppUrl(whatsappDebtCustomer.phone, getWhatsAppDebtMessage(whatsappDebtCustomer))}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl shadow-lg shadow-emerald-500/20 transition flex items-center gap-1.5 cursor-pointer"
                >
                  <ExternalLink className="w-4 h-4" /> Ouvrir WhatsApp
                </a>
              </div>
            </div>
          </div>
        )}

        {/* ═══ Footer ═══ */}
        <div className="p-3 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
          <span>CRM Clientèle • {(customers || []).length} profils • {formatDZD(totalCreditOutstanding)} avoirs • {formatDZD(totalDebtOutstanding)} dettes actives</span>
          <button onClick={closeModal} className="px-4 py-1.5 rounded-xl bg-pos-hover text-pos-text font-semibold cursor-pointer">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};

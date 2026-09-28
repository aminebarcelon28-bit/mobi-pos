import React, { useState, useEffect, useMemo } from 'react';
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
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { DEFAULT_CREDIT_LIMIT } from '../../../store/slices/createCustomerSlice';
import { AppTabContent } from '../AppScreenLayout';
import type { Customer } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { soundEngine } from '../../../utils/audioFeedback';
import { normalizeAlgerianPhone, openDialer, openWhatsApp } from '../../../utils/phoneUtils';
import { useToast } from '../../ui/Toast';

export const KredyTab: React.FC = () => {
  const { customers, receiptSettings, openModal } = usePosStore();
  const { showToast } = useToast();
  const [search, setSearch] = useState('');
  const [filterDebtorsOnly, setFilterDebtorsOnly] = useState(true);
  // Recherche anti-rebond : champ instantané, filtrage 200 ms après la frappe
  // (même motif que CatalogSearchTab — affichage seul, aucune logique métier).
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  // Debt calculations
  const totalOutstandingDebt = useMemo(() => {
    return (customers || []).reduce((acc, c) => acc + (c.currentDebt || 0), 0);
  }, [customers]);

  const debtorsCount = useMemo(() => {
    return (customers || []).filter((c) => (c.currentDebt || 0) > 0).length;
  }, [customers]);

  // Filtered customers (diacritic-insensitive on names; raw substring on phones)
  const filteredCustomers = useMemo(() => {
    const q = (debouncedSearch.trim() || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const rawQ = debouncedSearch.trim();
    return (customers || []).filter((c) => {
      if (filterDebtorsOnly && (c.currentDebt || 0) <= 0) return false;
      if (!q) return true;
      const nameFold = (c.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return (
        nameFold.includes(q) ||
        (c.phone || '').includes(rawQ)
      );
    });
  }, [customers, debouncedSearch, filterDebtorsOnly]);

  const handleWhatsApp = async (customer: Customer, e?: React.MouseEvent) => {
    e?.stopPropagation();
    soundEngine.playKeyBeep?.();
    if (!customer.phone) {
      showToast(`Numéro de téléphone non renseigné pour ${customer.name}.`, 'warning');
      return;
    }

    const storeName = receiptSettings?.storeName || 'MobiPOS';
    const message = `Bonjour ${customer.name},\nNous vous rappelons que votre solde de créance auprès de ${storeName} est de ${formatDZD(
      customer.currentDebt || 0
    )}.\nMerci pour votre fidélité !`;

    const ok = await openWhatsApp(customer.phone, message);
    if (!ok) {
      showToast("Impossible d'ouvrir WhatsApp", 'error');
    }
  };

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

  return (
    <AppTabContent
      pinnedTop={
        <div className="px-3.5 pt-3 pb-2.5 space-y-2.5 bg-pos-bg">
          {/* Total Debt Hero Banner */}
          <div className="bg-gradient-to-br from-amber-500/15 via-pos-card to-pos-panel border border-amber-500/30 rounded-3xl p-4 shadow-sm space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-black text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                <CreditCard className="w-4 h-4" />
                Créances Clients (Kredy)
              </span>
              <span className="text-[10px] font-black px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                {debtorsCount} débiteur{debtorsCount > 1 ? 's' : ''}
              </span>
            </div>

            <div className="pt-1">
              <span className="text-3xl font-black font-mono text-amber-400 block tracking-tight">
                {formatDZD(totalOutstandingDebt)}
              </span>
              <span className="text-[11px] text-pos-muted font-medium mt-0.5 block">
                Total des créances actives en attente de recouvrement
              </span>
            </div>

            {/* Quick Action Buttons for Parity */}
            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-amber-500/20">
              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  openModal('debt_ledger');
                }}
                className="min-h-[44px] px-3 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-sm shadow-amber-500/20"
                title="Ouvrir le Grand Livre des créances et règlements"
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>Grand Livre</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  openModal('customers');
                }}
                className="min-h-[44px] px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-cyan-400/50 text-cyan-400 active-press font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                title="Gérer les clients et créer un compte (CRM)"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>+ Nouveau Client</span>
              </button>
            </div>

            {/* Guide de règlement — point d'entrée du flux de paiement. */}
            <p className="text-[11px] text-pos-muted leading-relaxed pt-1 border-t border-amber-500/20">
              Pour encaisser un versement, touchez <strong className="text-amber-300">« Régler »</strong> sur la fiche du client — le Grand Livre enregistre le reçu.
            </p>
          </div>

          {/* Search Input & Filter Pills */}
          <div className="space-y-2">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Rechercher nom ou téléphone du client..."
                className="w-full min-h-[44px] bg-pos-panel border border-pos-border focus:border-amber-400 rounded-xl pl-9 pr-9 py-2 text-xs text-pos-text placeholder-pos-muted focus:outline-none transition-all shadow-xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-pos-muted hover:text-pos-text min-h-[44px] min-w-[44px] flex items-center justify-center active-press cursor-pointer"
                  aria-label="Effacer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFilterDebtorsOnly(true)}
                className={`flex-1 min-h-[44px] px-3 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer flex items-center justify-center gap-1.5 active-press ${
                  filterDebtorsOnly
                    ? 'bg-amber-500 text-slate-950 font-black shadow-md shadow-amber-500/20'
                    : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                <span>Débiteurs Actifs ({debtorsCount})</span>
              </button>

              <button
                type="button"
                onClick={() => setFilterDebtorsOnly(false)}
                className={`flex-1 min-h-[44px] px-3 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer flex items-center justify-center gap-1.5 active-press ${
                  !filterDebtorsOnly
                    ? 'bg-amber-500 text-slate-950 font-black shadow-md shadow-amber-500/20'
                    : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                <span>Tous ({customers?.length || 0})</span>
              </button>
            </div>

            {/* Compteur de résultats (annoncé aux lecteurs d'écran). */}
            <p aria-live="polite" className="text-[11px] text-pos-muted font-medium px-1">
              {debouncedSearch.trim()
                ? `${filteredCustomers.length} résultat${filteredCustomers.length > 1 ? 's' : ''} pour « ${debouncedSearch.trim()} »`
                : `${filteredCustomers.length} fiche${filteredCustomers.length > 1 ? 's' : ''} affichée${filteredCustomers.length > 1 ? 's' : ''}`}
            </p>
          </div>
        </div>
      }
      contentClassName="px-3.5 pb-4 select-none"
    >
      {/* Customer Cards List */}
      <div className="space-y-2.5 pt-1">
        {filteredCustomers.length === 0 && filterDebtorsOnly && debtorsCount === 0 && !debouncedSearch.trim() ? (
          /* État de fête : aucune dette en cours (distinct du « sans résultat »). */
          <div className="p-8 my-4 text-center bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex flex-col items-center justify-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
              <CreditCard className="w-6 h-6" />
            </div>
            <div>
              <p className="text-xs font-black text-emerald-300">Aucune dette en cours — tout est réglé ! 🎉</p>
              <p className="text-[11px] text-pos-muted mt-0.5">
                Tous les clients sont à jour. Les nouvelles créances apparaîtront ici automatiquement.
              </p>
            </div>
          </div>
        ) : filteredCustomers.length === 0 ? (
          <div className="p-8 my-4 text-center bg-pos-panel/60 border border-dashed border-pos-border rounded-2xl flex flex-col items-center justify-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-pos-card border border-pos-border flex items-center justify-center text-pos-muted">
              <Users className="w-6 h-6 opacity-60" />
            </div>
            <div>
              <p className="text-xs font-black text-pos-text">Aucun client trouvé</p>
              <p className="text-[11px] text-pos-muted mt-0.5">
                {filterDebtorsOnly
                  ? 'Aucun client avec une dette active ne correspond à ce critère.'
                  : 'Aucun profil client enregistré pour cette recherche.'}
              </p>
            </div>
          </div>
        ) : (
          filteredCustomers.map((c) => {
            const debt = c.currentDebt || 0;
            const hasDebt = debt > 0;
            // Unified default ceiling — an absent debtLimit means the standard
            // limit, not "no limit".
            const debtLimit = c.debtLimit ?? DEFAULT_CREDIT_LIMIT;
            const isNearLimit = debtLimit && debt >= debtLimit * 0.8;
            // Gravité plafond (affichage seul — aucune donnée d'échéance n'existe
            // sur Customer, donc pas de vieillissement réel possible sans schéma).
            const isOverLimit = debtLimit > 0 && debt >= debtLimit;
            const limitUsagePct = debtLimit > 0 ? Math.min(100, Math.round((debt / debtLimit) * 100)) : 0;
            const initials = (c.name || 'C').slice(0, 2).toUpperCase();

            return (
              <div
                key={c.id}
                className={`bg-pos-card border rounded-2xl p-3.5 space-y-3 shadow-xs transition-all ${
                  isOverLimit
                    ? 'border-rose-500/60'
                    : 'border-pos-border hover:border-amber-500/40 active:border-amber-500/60'
                }`}
              >
                {/* Header: Customer info & Debt pill */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Customer Avatar */}
                    <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center font-black text-xs shrink-0 shadow-xs">
                      {initials}
                    </div>

                    <div className="min-w-0">
                      <h4 className="text-xs font-black text-pos-text leading-tight truncate">
                        {c.name}
                      </h4>
                      <div className="flex items-center gap-1.5 mt-1 font-mono">
                        <span className="text-[10px] text-pos-muted">
                          {c.phone ? (normalizeAlgerianPhone(c.phone).formattedDisplay || c.phone) : 'Aucun numéro'}
                        </span>
                        {c.phone && normalizeAlgerianPhone(c.phone).operator !== 'Inconnu' && (
                          <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-pos-panel border border-pos-border text-pos-muted">
                            {normalizeAlgerianPhone(c.phone).operator}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span
                      className={`font-mono text-sm font-black block ${
                        hasDebt ? 'text-amber-400' : 'text-emerald-400'
                      }`}
                    >
                      {formatDZD(debt)}
                    </span>
                    <span
                      className={`text-[9px] font-bold block mt-0.5 ${
                        isNearLimit ? 'text-rose-400' : 'text-pos-muted'
                      }`}
                    >
                      Plafond : {formatDZD(debtLimit)}
                      {c.debtLimit == null ? ' (défaut)' : ''}
                    </span>
                    {hasDebt && (
                      <span
                        className={`inline-block text-[9px] font-black px-1.5 py-0.5 rounded mt-1 border ${
                          isOverLimit
                            ? 'bg-rose-500/15 text-rose-300 border-rose-500/40'
                            : isNearLimit
                              ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                              : 'bg-pos-panel text-pos-muted border-pos-border'
                        }`}
                      >
                        {isOverLimit
                          ? 'Plafond atteint — exiger un versement'
                          : isNearLimit
                            ? 'Plafond presque atteint'
                            : 'À recouvrer'}
                      </span>
                    )}
                  </div>
                </div>

                {/* Jauge du plafond consommé (affichage seul). */}
                {hasDebt && debtLimit > 0 && (
                  <div
                    role="img"
                    aria-label={`Plafond consommé à ${limitUsagePct} %`}
                    className="h-1.5 rounded-full bg-pos-panel border border-pos-border/60 overflow-hidden"
                  >
                    <div
                      className={`h-full rounded-full ${isOverLimit ? 'bg-rose-400' : isNearLimit ? 'bg-amber-400' : 'bg-emerald-400'}`}
                      style={{ width: `${limitUsagePct}%` }}
                    />
                  </div>
                )}

                {/* Communication & Payment Actions */}
                <div className="flex items-center gap-2 pt-1 border-t border-pos-border/50">
                  {hasDebt && (
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playKeyBeep?.();
                        openModal('debt_ledger');
                      }}
                      className="min-h-[44px] px-3.5 rounded-xl bg-amber-500/15 border border-amber-500/40 hover:bg-amber-500/25 text-amber-300 text-xs font-black flex items-center justify-center gap-1.5 transition active-press cursor-pointer shadow-xs shrink-0"
                      title="Encaisser un versement sur la dette de ce client"
                    >
                      <DollarSign className="w-4 h-4 text-amber-400" />
                      <span>Régler</span>
                    </button>
                  )}

                  {c.phone ? (
                    <>
                      <button
                        type="button"
                        onClick={(e) => {
                          handleCall(c.phone, e);
                        }}
                        className="flex-1 min-h-[44px] px-3 rounded-xl bg-pos-panel border border-cyan-500/40 hover:bg-cyan-500/10 text-cyan-400 text-xs font-bold flex items-center justify-center gap-2 transition active-press cursor-pointer shadow-xs"
                      >
                        <Phone className="w-4 h-4 stroke-[2.2]" />
                        <span>Appeler</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          handleWhatsApp(c, e);
                        }}
                        className="flex-1 min-h-[44px] px-3 rounded-xl bg-emerald-500/15 border border-emerald-500/40 hover:bg-emerald-500/25 text-emerald-300 text-xs font-bold flex items-center justify-center gap-2 transition active-press cursor-pointer shadow-xs"
                      >
                        <MessageSquare className="w-4 h-4 text-emerald-400 stroke-[2.2]" />
                        <span>WhatsApp</span>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playKeyBeep?.();
                        openModal('customers');
                      }}
                      className="flex-1 min-h-[44px] px-3 rounded-xl bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer transition active-press"
                    >
                      <span>Ajouter n° de téléphone</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </AppTabContent>
  );
};

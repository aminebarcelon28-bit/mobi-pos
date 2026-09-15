import React, { useState, useMemo } from 'react';
import {
  Users,
  Search,
  Phone,
  MessageSquare,
  X,
  CreditCard,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import type { Customer } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { soundEngine } from '../../../utils/audioFeedback';
import { normalizeAlgerianPhone, buildWhatsAppUrl } from '../../../utils/phoneUtils';
import { useToast } from '../../ui/Toast';

export const KredyTab: React.FC = () => {
  const { customers, receiptSettings } = usePosStore();
  const { showToast } = useToast();
  const [search, setSearch] = useState('');
  const [filterDebtorsOnly, setFilterDebtorsOnly] = useState(true);

  // Debt calculations
  const totalOutstandingDebt = useMemo(() => {
    return (customers || []).reduce((acc, c) => acc + (c.currentDebt || 0), 0);
  }, [customers]);

  const debtorsCount = useMemo(() => {
    return (customers || []).filter((c) => (c.currentDebt || 0) > 0).length;
  }, [customers]);

  // Filtered customers
  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (customers || []).filter((c) => {
      if (filterDebtorsOnly && (c.currentDebt || 0) <= 0) return false;
      if (!q) return true;
      return (
        (c.name || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q)
      );
    });
  }, [customers, search, filterDebtorsOnly]);

  const handleWhatsApp = (customer: Customer, e?: React.MouseEvent) => {
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

    const waUrl = buildWhatsAppUrl(customer.phone, message);
    try {
      const a = document.createElement('a');
      a.href = waUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      window.open(waUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const handleCall = (phone?: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    soundEngine.playKeyBeep?.();
    if (!phone) {
      showToast('Aucun numéro de téléphone disponible', 'warning');
      return;
    }
    const norm = normalizeAlgerianPhone(phone);
    const dialDigits = norm.local || norm.digitsOnly || phone.replace(/\D/g, '');
    if (!dialDigits) {
      showToast('Format de numéro non valide', 'error');
      return;
    }
    const telUrl = `tel:${dialDigits}`;
    try {
      const a = document.createElement('a');
      a.href = telUrl;
      a.target = '_self';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      window.location.href = telUrl;
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-3.5 space-y-3 pb-24 select-none">
      {/* Total Debt Hero Banner */}
      <div className="bg-gradient-to-br from-amber-500/10 to-pos-panel border border-amber-500/30 rounded-2xl p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
            <CreditCard className="w-4 h-4" />
            Créances Clients (Kredy)
          </span>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300">
            {debtorsCount} débiteurs
          </span>
        </div>

        <div className="mt-2">
          <span className="text-2xl font-black font-mono text-amber-400 block tracking-tight">
            {formatDZD(totalOutstandingDebt)}
          </span>
          <span className="text-[11px] text-pos-muted font-medium mt-0.5 block">
            Total des dettes actives en attente de recouvrement
          </span>
        </div>
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
            className="w-full bg-pos-panel border border-pos-border focus:border-amber-400 rounded-xl pl-9 pr-8 py-2.5 text-xs text-pos-text placeholder-pos-muted focus:outline-none transition-all"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-pos-muted hover:text-pos-text"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFilterDebtorsOnly(true)}
            className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
              filterDebtorsOnly
                ? 'bg-amber-500 text-slate-950 font-black shadow-sm'
                : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text'
            }`}
          >
            Débiteurs uniquement ({debtorsCount})
          </button>

          <button
            type="button"
            onClick={() => setFilterDebtorsOnly(false)}
            className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
              !filterDebtorsOnly
                ? 'bg-cyan-500 text-slate-950 font-black shadow-sm'
                : 'bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text'
            }`}
          >
            Tous les clients ({customers?.length || 0})
          </button>
        </div>
      </div>

      {/* Customer Cards List */}
      <div className="space-y-2">
        {filteredCustomers.length === 0 ? (
          <div className="p-8 text-center bg-pos-panel border border-pos-border rounded-2xl">
            <Users className="w-8 h-8 text-pos-muted mx-auto mb-2 opacity-50" />
            <p className="text-xs font-bold text-pos-muted">Aucun client trouvé.</p>
          </div>
        ) : (
          filteredCustomers.map((c) => {
            const debt = c.currentDebt || 0;
            const hasDebt = debt > 0;
            const debtLimit = c.debtLimit;
            const isNearLimit = debtLimit && debt >= debtLimit * 0.8;

            return (
              <div
                key={c.id}
                className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-2.5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="text-xs font-black text-pos-text">{c.name}</h4>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-pos-muted font-mono">
                        {c.phone ? (normalizeAlgerianPhone(c.phone).formattedDisplay || c.phone) : 'Aucun numéro'}
                      </span>
                      {c.phone && normalizeAlgerianPhone(c.phone).operator !== 'Inconnu' && (
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-pos-panel border border-pos-border text-pos-muted">
                          {normalizeAlgerianPhone(c.phone).operator}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-right">
                    <span
                      className={`font-mono text-sm font-black block ${
                        hasDebt ? 'text-amber-400' : 'text-emerald-400'
                      }`}
                    >
                      {formatDZD(debt)}
                    </span>
                    {debtLimit ? (
                      <span
                        className={`text-[9px] font-bold block ${
                          isNearLimit ? 'text-rose-400' : 'text-pos-muted'
                        }`}
                      >
                        Plafond : {formatDZD(debtLimit)}
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Communication Actions */}
                <div className="flex items-center gap-2 pt-1 border-t border-pos-border/50">
                  {c.phone ? (
                    (() => {
                      const norm = normalizeAlgerianPhone(c.phone);
                      const dialDigits = norm.local || norm.digitsOnly || c.phone.replace(/\D/g, '');
                      const telUrl = `tel:${dialDigits}`;
                      const storeName = receiptSettings?.storeName || 'MobiPOS';
                      const message = `Bonjour ${c.name},\nNous vous rappelons que votre solde de créance auprès de ${storeName} est de ${formatDZD(
                        debt
                      )}.\nMerci pour votre fidélité !`;
                      const waUrl = buildWhatsAppUrl(c.phone, message);

                      return (
                        <>
                          <a
                            href={telUrl}
                            onClick={(e) => {
                              soundEngine.playKeyBeep?.();
                              if (!dialDigits) {
                                e.preventDefault();
                                handleCall(c.phone, e);
                              }
                            }}
                            className="flex-1 py-2 rounded-xl bg-pos-panel border border-cyan-500/40 hover:bg-cyan-500/10 text-cyan-400 text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-95 no-underline cursor-pointer shadow-sm"
                          >
                            <Phone className="w-3.5 h-3.5" />
                            <span>Appeler</span>
                          </a>

                          <a
                            href={waUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => {
                              soundEngine.playKeyBeep?.();
                              if (!c.phone) {
                                e.preventDefault();
                                handleWhatsApp(c, e);
                              }
                            }}
                            className="flex-1 py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/40 hover:bg-emerald-500/25 text-emerald-300 text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-95 no-underline cursor-pointer shadow-sm"
                          >
                            <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />
                            <span>WhatsApp</span>
                          </a>
                        </>
                      );
                    })()
                  ) : (
                    <span className="text-[10px] text-pos-muted italic py-1">
                      Ajoutez un numéro de téléphone pour activer les appels et rappels WhatsApp.
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

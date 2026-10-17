import React, { useEffect, useRef, useState } from 'react';
import { X, Play, Clock, User, AlertTriangle, Trash2 } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import { formatDZD } from '../../types/pos';
import type { HeldSale } from '../../types/pos';

// ─── Affichage seul : seuils calés sur le TTL 48 h du store (createCartSlice) ───

const HOLD_URGENT_MS = 6 * 60 * 60 * 1000; // rouge : expire dans ≤ 6 h
const HOLD_SOON_MS = 24 * 60 * 60 * 1000; // ambre : expire dans ≤ 24 h

type HoldUrgency = 'expired' | 'urgent' | 'soon' | 'later' | 'unknown';

interface HoldExpiryInfo {
  status: HoldUrgency;
  remainingMs: number | null;
  expiresAtMs: number | null;
}

/** Lecture défensive de l'expiresAt ISO posé par holdSale() — les tickets historiques n'en ont pas. */
function holdExpiryInfo(sale: unknown): HoldExpiryInfo {
  const raw = (sale as { expiresAt?: unknown }).expiresAt;
  if (typeof raw !== 'string' || !raw) return { status: 'unknown', remainingMs: null, expiresAtMs: null };
  const t = new Date(raw).getTime();
  if (Number.isNaN(t)) return { status: 'unknown', remainingMs: null, expiresAtMs: null };
  const remaining = t - Date.now();
  if (remaining <= 0) return { status: 'expired', remainingMs: remaining, expiresAtMs: t };
  if (remaining <= HOLD_URGENT_MS) return { status: 'urgent', remainingMs: remaining, expiresAtMs: t };
  if (remaining <= HOLD_SOON_MS) return { status: 'soon', remainingMs: remaining, expiresAtMs: t };
  return { status: 'later', remainingMs: remaining, expiresAtMs: t };
}

/** « 45 min », « 5 h 20 min », « 5 h » — pour le compte à rebours d'expiration. */
function formatCountdownFr(remainingMs: number): string {
  const totalMin = Math.max(1, Math.ceil(remainingMs / 60000));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Total du panier suspendu — même formule que le tableau de bord (affichage seul). */
function holdTotal(sale: HeldSale): number {
  return (sale.items || []).reduce(
    (sum, item) => sum + (item.appliedPrice || item.product.price) * item.quantity - (item.discount || 0),
    0
  );
}

export const HoldSalesModal: React.FC = () => {
  const { activeModal, closeModal, heldSales } = usePosStore();
  const { showToast } = useToast();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  // Rafraîchit les comptes à rebours toutes les 30 s (affichage seul).
  const [, setTick] = useState(0);

  useEffect(() => {
    if (activeModal !== 'hold') return;
    const timer = setTimeout(() => closeBtnRef.current?.focus(), 60);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeModal, closeModal]);

  useEffect(() => {
    if (activeModal !== 'hold') return;
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [activeModal]);

  if (activeModal !== 'hold') return null;

  const handleRetrieve = async (saleId: string) => {
    // retrieveSale purges expired holds, blocks double-restore and returns
    // price-revalidation warnings — surfaced here via the toast system.
    // (Async since UPGRADE-04: it resolves the customer's contract price
    // book before revalidating hold prices.)
    const res = await usePosStore.getState().retrieveSale(saleId);
    if (!res || !res.success) {
      const reason = res?.reason;
      if (reason === 'HOLD_EXPIRED') {
        showToast('Vente expirée (48 h) — ticket supprimé.', 'warning');
      } else if (reason === 'ALREADY_RESTORED') {
        showToast('Ticket déjà repris en caisse.', 'warning');
      } else if (reason === 'HOLD_ALL_LINES_REMOVED') {
        for (const w of res?.warnings ?? []) {
          showToast(w, 'warning', 5000);
        }
        showToast('Ticket non repris : tous les articles ont été retirés du catalogue.', 'error');
      } else {
        showToast('Ticket en attente introuvable.', 'warning');
      }
      return;
    }
    for (const w of res.warnings ?? []) {
      showToast(w, 'warning', 5000);
    }
    showToast('Vente en attente reprise en caisse.', 'success');
  };

  const handleDelete = (saleId: string) => {
    usePosStore.getState().deleteHeldSale(saleId);
    showToast('Vente en attente supprimée.', 'info');
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Ventes en attente" className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:zoom-in-95 max-h-[94dvh] sm:max-h-[90dvh] flex flex-col">
        {/* Mobile drag handle */}
        <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" aria-hidden="true" />

        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-black text-pos-text flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" aria-hidden="true" />
              <span className="truncate">Ventes en Attente ({(heldSales || []).length})</span>
            </h2>
            <p className="text-[11px] text-pos-muted truncate hidden sm:block">
              Tickets suspendus par F6 • conservés 48 h puis purgés
            </p>
          </div>
          <button
            ref={closeBtnRef}
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition min-h-[48px] min-w-[48px] flex items-center justify-center cursor-pointer shrink-0"
            aria-label="Fermer"
            title="Fermer (Échap)"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 sm:p-5 pb-[max(1rem,var(--safe-bottom))] sm:pb-5 space-y-3 flex-1 overflow-y-auto overscroll-contain">
          {(heldSales || []).length === 0 ? (
            <div className="text-center py-8 text-pos-muted space-y-2">
              <Clock className="w-10 h-10 mx-auto opacity-40 text-emerald-400" />
              <p className="text-sm font-bold text-pos-text">Aucune vente en attente</p>
              <p className="text-xs max-w-xs mx-auto leading-relaxed">
                En plein rush, appuyez sur <span className="text-emerald-400 font-bold">F6</span> pour
                suspendre le panier en cours et servir le client suivant. Chaque ticket est conservé 48 h.
              </p>
            </div>
          ) : (
            (heldSales || []).map((sale) => {
              const expiry = holdExpiryInfo(sale);
              const total = holdTotal(sale);
              const expiryDateLabel =
                expiry.expiresAtMs !== null
                  ? new Date(expiry.expiresAtMs).toLocaleString('fr-FR', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : null;
              return (
              <div
                key={sale.id}
                className={`bg-pos-card border rounded-xl p-4 flex items-center justify-between hover:border-emerald-500/50 transition gap-2 ${
                  expiry.status === 'expired' || expiry.status === 'urgent'
                    ? 'border-red-500/50'
                    : expiry.status === 'soon'
                    ? 'border-amber-500/40'
                    : 'border-pos-border'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <User className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                      <span className="text-sm font-black text-pos-text truncate">
                        {sale.customer ? sale.customer.name : 'Client Passage'}
                      </span>
                    </div>
                    <span className="font-mono font-black text-base text-emerald-700 dark:text-emerald-400 shrink-0 tabular-nums">
                      {formatDZD(total)}
                    </span>
                  </div>
                  <p className="text-[11px] text-pos-muted mt-1 flex items-center gap-1.5">
                    <span className="flex items-center gap-1 shrink-0">
                      <Clock className="w-3 h-3" aria-hidden="true" /> Suspendu à {sale.timestamp}
                    </span>
                    <span aria-hidden="true">•</span>
                    <span className="truncate">
                      {(sale.items || []).length} article{(sale.items || []).length > 1 ? 's' : ''}
                    </span>
                  </p>
                  <p className="text-[11px] text-pos-muted truncate">
                    {(sale.items || []).map((i) => i.product?.title || '').filter(Boolean).join(', ')}
                  </p>
                  {expiry.status !== 'unknown' && expiryDateLabel && (
                    <p
                      className={`text-[11px] mt-1 flex items-center gap-1 font-bold ${
                        expiry.status === 'expired' || expiry.status === 'urgent'
                          ? 'text-rose-700 dark:text-rose-400'
                          : expiry.status === 'soon'
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-pos-muted'
                      }`}
                      role="status"
                    >
                      {(expiry.status === 'expired' || expiry.status === 'urgent') && (
                        <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                      )}
                      {expiry.status === 'expired'
                        ? `Expiré — sera purgé à la reprise`
                        : expiry.status === 'urgent' && expiry.remainingMs !== null
                        ? `Expire dans ${formatCountdownFr(expiry.remainingMs)} (le ${expiryDateLabel})`
                        : expiry.status === 'soon' && expiry.remainingMs !== null
                        ? `Expire dans ${formatCountdownFr(expiry.remainingMs)}`
                        : `Expire le ${expiryDateLabel}`}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleDelete(sale.id)}
                    className="p-2.5 rounded-xl border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 transition min-h-[48px] min-w-[48px] flex items-center justify-center cursor-pointer active-press"
                    aria-label="Supprimer la vente en attente"
                    title="Supprimer la vente en attente"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRetrieve(sale.id)}
                    className="px-3.5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition shadow-md shadow-amber-500/20 min-h-[48px] active-press cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-slate-950" aria-hidden="true" /> Reprendre
                  </button>
                </div>
              </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

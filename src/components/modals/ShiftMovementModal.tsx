import React, { useState } from 'react';
import { X, ArrowDownCircle, ArrowUpCircle, FileText, CheckCircle2, AlertTriangle } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { parseLocalizedAmount } from '../../utils/moneyInput';
import { MANUAL_MOVEMENT_TAG } from '../../utils/cashTerms';

// Lock-screen cashier fallback (createUISlice owns `activeCashier`; absent
// from the shared PosState type, so read via structural cast).
function readLockScreenCashierName(): string {
  const state = usePosStore.getState() as unknown as { activeCashier?: { name?: string } | null };
  return state.activeCashier?.name?.trim() || '';
}

export const ShiftMovementModal: React.FC = () => {
  const { activeModal, closeModal, activeShift, logCashMovement } = usePosStore();
  const { showToast } = useToast();

  const [type, setType] = useState<'EXPENSE' | 'MANUAL_DEPOSIT'>('EXPENSE');
  const [amount, setAmount] = useState<number>(0);
  const [reason, setReason] = useState<string>('');
  const [cashierName, setCashierName] = useState<string>(
    () => activeShift?.cashierName || readLockScreenCashierName()
  );
  // Double-submit guard: two taps would book the movement twice (no natural
  // idempotency key on cash movements).
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (activeModal !== 'shift_movement') return null;

  // NOTE: this modal is the ONLY legitimate path for MANUAL_DEPOSIT entries —
  // incl. repair-balance deposits prompted via the REPAIR_BALANCE_DUE_EVENT
  // (see createRepairSlice). Never auto-fabricate deposits from status
  // changes; the cashier always confirms amount + motif explicitly here.
  const handleSaveMovement = async () => {
    if (isSubmitting) return;
    const validAmount = Math.max(0, isNaN(amount) ? 0 : amount);
    if (validAmount <= 0) {
      showToast('Veuillez saisir un montant supérieur à 0 DA.', 'warning');
      return;
    }

    if (!reason.trim()) {
      showToast('Le motif du mouvement de caisse est obligatoire.', 'warning');
      return;
    }

    setIsSubmitting(true);
    try {
      // Standalone-movement tag: this modal is the only writer of movements
      // WITHOUT a source-table twin, and Reports counts exactly the tagged
      // rows (cashTerms standalone helpers). Twin writers never carry the
      // tag, so tagged rows can never double-count.
      const movementResult = await logCashMovement(
        validAmount,
        type,
        `${reason.trim()} ${MANUAL_MOVEMENT_TAG}`,
        cashierName.trim() || undefined
      );

      if (movementResult.success) {
        showToast(
          `${type === 'EXPENSE' ? 'Dépense' : 'Apport'} de ${formatDZD(validAmount)} enregistré avec succès.`,
          'success'
        );
        closeModal();
      } else {
        showToast(movementResult.reason || 'Erreur enregistrement mouvement', 'error');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:fade-in sm:zoom-in-95 max-h-[94vh] sm:max-h-[92vh] flex flex-col">
        {/* Mobile drag handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {type === 'EXPENSE' ? (
              <ArrowDownCircle className="w-5 h-5 text-red-400 shrink-0" />
            ) : (
              <ArrowUpCircle className="w-5 h-5 text-emerald-400 shrink-0" />
            )}
            <div className="min-w-0">
              <h2 className="text-xs sm:text-sm font-bold text-pos-text truncate">
                Mouvement de Caisse en Shift
              </h2>
              <p className="text-[10px] sm:text-[11px] text-pos-muted truncate">
                Dépense d'exploitation ou apport manuel
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer min-h-[38px] min-w-[38px] flex items-center justify-center shrink-0"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Segmented Type Toggle */}
          <div className="grid grid-cols-2 gap-1.5 bg-pos-bg p-1 rounded-xl border border-pos-border">
            <button
              type="button"
              onClick={() => setType('EXPENSE')}
              className={`py-2 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition ${
                type === 'EXPENSE'
                  ? 'bg-red-500/20 border border-red-500/40 text-red-400 font-black shadow-sm'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <ArrowDownCircle className="w-4 h-4" /> Dépense / Retrait
            </button>
            <button
              type="button"
              onClick={() => setType('MANUAL_DEPOSIT')}
              className={`py-2 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition ${
                type === 'MANUAL_DEPOSIT'
                  ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 font-black shadow-sm'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <ArrowUpCircle className="w-4 h-4" /> Apport de Fonds
            </button>
          </div>

          {/* Amount Input */}
          <div className="bg-pos-card border border-pos-border p-3.5 rounded-xl space-y-1.5">
            <label className="text-[10px] text-pos-muted uppercase font-bold">
              Montant du Mouvement (DA)
            </label>
            <input
              type="number"
              min="0"
              step="any"
              value={amount || ''}
              onChange={(e) => setAmount(Math.round(parseLocalizedAmount(e.target.value) || 0))}
              placeholder="0 DA"
              className={`w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-lg font-mono font-bold focus:outline-none ${
                type === 'EXPENSE' ? 'text-red-400 focus:border-red-400' : 'text-emerald-400 focus:border-emerald-400'
              }`}
            />
          </div>

          {/* Cashier Name & Reason */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="bg-pos-card border border-pos-border p-3 rounded-xl space-y-1">
              <label className="text-[10px] text-pos-muted uppercase font-bold">
                Caissier
              </label>
              <input
                type="text"
                value={cashierName}
                onChange={(e) => setCashierName(e.target.value)}
                placeholder="Nom du caissier…"
                className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>
            <div className="bg-pos-card border border-pos-border p-3 rounded-xl space-y-1">
              <label className="text-[10px] text-pos-muted uppercase font-bold flex items-center gap-1">
                <FileText className="w-3 h-3 text-pos-muted" /> Motif Obligatoire
              </label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={type === 'EXPENSE' ? 'Ex: Achat café, fournitures...' : 'Ex: Apport monnaie...'}
                className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>
          </div>

          {/* Impact Alert */}
          <div className="bg-pos-bg border border-pos-border p-3 rounded-xl flex items-start gap-2.5 text-[11px] text-pos-muted">
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <p>
              Ce mouvement sera immutablement lié à la session active (
              <strong className="text-pos-text font-mono">{activeShift?.id || 'Session Active'}</strong>). Il sera pris en compte dans le calcul automatisé du solde théorique de fin de journée.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 sm:p-4 border-t border-pos-border bg-pos-card flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={closeModal}
            className="flex-1 sm:flex-none min-h-[42px] px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text bg-pos-hover/50 sm:bg-transparent transition cursor-pointer"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={handleSaveMovement}
            disabled={isSubmitting}
            className={`flex-2 sm:flex-none min-h-[44px] px-5 py-2.5 rounded-xl font-black text-xs flex items-center justify-center gap-1.5 shadow-lg transition active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
              type === 'EXPENSE'
                ? 'bg-red-500 hover:bg-red-400 text-white shadow-red-500/20'
                : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20'
            }`}
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>Enregistrer le Mouvement</span>
          </button>
        </div>
      </div>
    </div>
  );
};

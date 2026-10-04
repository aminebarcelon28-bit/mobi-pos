import React, { useState, useMemo, useEffect } from 'react';
import { X, Play, Calculator, Sparkles, User, FileText, CheckCircle2, AlertTriangle } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime, type DenominationCount } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { MoneyInput } from '../ui/MoneyInput';
import { toLegacyReal, dinarsToMinor } from '../../utils/money';

// Lock-screen cashier (createUISlice owns `activeCashier`; absent from the
// shared PosState type, so read via structural cast). Used as the default
// shift cashier instead of any hardcoded name.
function readLockScreenCashierName(): string {
  const state = usePosStore.getState() as unknown as { activeCashier?: { name?: string } | null };
  return state.activeCashier?.name?.trim() || '';
}

export const ShiftOpenModal: React.FC = () => {
  const { activeModal, closeModal, startShift } = usePosStore();
  const { showToast } = useToast();

  const [useDenominations, setUseDenominations] = useState<boolean>(true);
  const [cashierName, setCashierName] = useState<string>('');
  const [openingNote, setOpeningNote] = useState<string>('');
  const [directFloat, setDirectFloat] = useState<number>(20000);
  const [alreadyOpen, setAlreadyOpen] = useState<{ id: string; cashier: string; openedAt: string } | null>(null);
  // Double-submit guard: opening twice races two shift rows — the adapter
  // refuses the second, but the button must not fire it at all.
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Refresh the cashier default (and clear any stale double-open banner)
  // every time the modal opens — the lock-screen cashier may have changed.
  useEffect(() => {
    if (activeModal === 'shift_open') {
      setCashierName((prev) => prev.trim() || readLockScreenCashierName());
      setAlreadyOpen(null);
    }
  }, [activeModal]);

  const [denominations, setDenominations] = useState<DenominationCount>({
    qty2000: 5,
    qty1000: 10,
    qty500: 0,
    qty200: 0,
    qty100: 0,
    qty50: 0,
    qty20: 0,
    qty10: 0,
    coins: 0,
  });

  const talliedTotal = useMemo(() => {
    return (
      (denominations.qty2000 || 0) * 2000 +
      (denominations.qty1000 || 0) * 1000 +
      (denominations.qty500 || 0) * 500 +
      (denominations.qty200 || 0) * 200 +
      (denominations.qty100 || 0) * 100 +
      (denominations.qty50 || 0) * 50 +
      (denominations.qty20 || 0) * 20 +
      (denominations.qty10 || 0) * 10 +
      (denominations.coins || 0)
    );
  }, [denominations]);

  const finalFloat = useDenominations ? talliedTotal : directFloat;

  if (activeModal !== 'shift_open') return null;

  const handleDenomChange = (key: keyof DenominationCount, val: string) => {
    const parsed = parseInt(val, 10);
    setDenominations((prev) => ({
      ...prev,
      [key]: isNaN(parsed) ? 0 : Math.max(0, parsed),
    }));
  };

  const handlePreset = (amount: number) => {
    setDirectFloat(amount);
    if (amount === 20000) {
      setDenominations({
        qty2000: 5,
        qty1000: 10,
        qty500: 0,
        qty200: 0,
        qty100: 0,
        qty50: 0,
        qty20: 0,
        qty10: 0,
        coins: 0,
      });
    } else if (amount === 10000) {
      setDenominations({
        qty2000: 3,
        qty1000: 4,
        qty500: 0,
        qty200: 0,
        qty100: 0,
        qty50: 0,
        qty20: 0,
        qty10: 0,
        coins: 0,
      });
    } else if (amount === 50000) {
      setDenominations({
        qty2000: 15,
        qty1000: 20,
        qty500: 0,
        qty200: 0,
        qty100: 0,
        qty50: 0,
        qty20: 0,
        qty10: 0,
        coins: 0,
      });
    }
  };

  const handleOpenShift = async () => {
    if (isSubmitting) return;
    if (finalFloat < 0) {
      showToast('Le fond de caisse initial ne peut pas être négatif.', 'warning');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await startShift(
        finalFloat,
        cashierName.trim() || readLockScreenCashierName() || 'Caissier Principal',
        openingNote.trim() || undefined,
        useDenominations ? denominations : undefined
      );

      if (result.success) {
        setAlreadyOpen(null);
        showToast(`Session ouverte avec succès ! Fond initial : ${formatDZD(finalFloat)}`, 'success');
        closeModal();
      } else if (result.reason === 'SHIFT_ALREADY_OPEN' && result.session) {
        // Double-open refused by the adapter: show WHO/WHEN instead of
        // inserting an orphaned second session.
        setAlreadyOpen({
          id: result.session.id,
          cashier: result.session.cashierName,
          openedAt: result.session.openedAt,
        });
        showToast(
          `Session déjà ouverte par ${result.session.cashierName} — clôturez-la avant d'en ouvrir une.`,
          'error'
        );
      } else {
        setAlreadyOpen(null);
        showToast(result.reason || "Échec de l'ouverture de session", 'error');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:fade-in sm:zoom-in-95 max-h-[94vh] sm:max-h-[92vh] flex flex-col">
        {/* Mobile drag handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2">
          <div className="flex items-center gap-2 text-emerald-400 min-w-0">
            <Play className="w-5 h-5 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-xs sm:text-sm font-bold text-pos-text truncate">
                Ouverture de Session Caisse (Start Shift)
              </h2>
              <p className="text-[10px] sm:text-[11px] text-pos-muted truncate">
                Décompte du fond de caisse initial et attribution du caissier
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
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {alreadyOpen && (
            <div className="bg-red-500/10 border border-red-500/40 p-3.5 rounded-xl flex items-start gap-3 text-xs text-red-200">
              <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5 text-red-400" />
              <div>
                <strong className="block text-red-300 font-bold mb-0.5">
                  Session déjà ouverte — ouverture refusée
                </strong>
                Une session est déjà en cours (ID : <span className="font-mono">{alreadyOpen.id}</span> •
                Caissier : <strong>{alreadyOpen.cashier}</strong> • Ouverte le : {formatDateTime(alreadyOpen.openedAt)}).
                Clôturez la session en cours avant d'en ouvrir une nouvelle.
              </div>
            </div>
          )}
          {/* Top Bar: Cashier & Mode Toggle */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-pos-card border border-pos-border p-3 rounded-xl space-y-1.5">
              <label className="text-[10px] text-pos-muted uppercase font-bold flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-cyan-400" /> Nom du Caissier
              </label>
              <input
                type="text"
                value={cashierName}
                onChange={(e) => setCashierName(e.target.value)}
                placeholder="Nom du caissier de garde…"
                className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-1.5 text-xs text-pos-text font-semibold focus:border-emerald-400 focus:outline-none"
              />
            </div>

            <div className="bg-pos-card border border-pos-border p-3 rounded-xl space-y-1.5">
              <label className="text-[10px] text-pos-muted uppercase font-bold flex items-center gap-1.5">
                <Calculator className="w-3.5 h-3.5 text-amber-400" /> Mode de Saisie
              </label>
              <div className="grid grid-cols-2 gap-1 bg-pos-bg p-1 rounded-lg border border-pos-border">
                <button
                  type="button"
                  onClick={() => setUseDenominations(true)}
                  className={`py-1 text-xs font-bold rounded-md transition ${
                    useDenominations
                      ? 'bg-emerald-500 text-slate-950 shadow-sm'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  Billets & Pièces
                </button>
                <button
                  type="button"
                  onClick={() => setUseDenominations(false)}
                  className={`py-1 text-xs font-bold rounded-md transition ${
                    !useDenominations
                      ? 'bg-emerald-500 text-slate-950 shadow-sm'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  Montant Direct
                </button>
              </div>
            </div>
          </div>

          {/* Quick Preset Badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-pos-muted font-semibold flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Préréglages rapides :
            </span>
            {[10000, 20000, 30000, 50000].map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => handlePreset(amt)}
                className="px-2.5 py-1 text-xs font-bold bg-pos-card hover:bg-pos-hover border border-pos-border rounded-lg text-pos-text transition"
              >
                {formatDZD(amt)}
              </button>
            ))}
          </div>

          {/* Denomination Engine */}
          {useDenominations ? (
            <div className="bg-pos-card border border-pos-border p-4 rounded-xl space-y-3">
              <div className="flex items-center justify-between border-b border-pos-border pb-2">
                <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                  <Calculator className="w-4 h-4 text-emerald-400" /> Moteur de Coupures Monétaires (DZD)
                </span>
                <span className="text-xs text-pos-muted font-mono">
                  Total calculé : <strong className="text-emerald-400 font-bold">{formatDZD(talliedTotal)}</strong>
                </span>
              </div>

              {/* Billets */}
              <div>
                <p className="text-[10px] font-extrabold uppercase text-pos-muted tracking-wider mb-2">
                  Billets de Banque
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {[
                    { key: 'qty2000', label: '2 000 DA', val: 2000, color: 'text-emerald-400' },
                    { key: 'qty1000', label: '1 000 DA', val: 1000, color: 'text-cyan-400' },
                    { key: 'qty500', label: '500 DA', val: 500, color: 'text-purple-400' },
                  ].map((item) => (
                    <div
                      key={item.key}
                      className="bg-pos-bg border border-pos-border p-2 rounded-lg flex items-center justify-between gap-2"
                    >
                      <div>
                        <span className={`text-xs font-bold ${item.color}`}>{item.label}</span>
                        <p className="text-[10px] text-pos-muted font-mono">
                          = {formatDZD((denominations[item.key as keyof DenominationCount] || 0) * item.val)}
                        </p>
                      </div>
                      <input
                        type="number"
                        min="0"
                        value={denominations[item.key as keyof DenominationCount] || ''}
                        onChange={(e) =>
                          handleDenomChange(item.key as keyof DenominationCount, e.target.value)
                        }
                        placeholder="0"
                        className="w-16 bg-pos-card border border-pos-border rounded px-2 py-1 text-right text-xs font-mono font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Pièces et Menue Monnaie */}
              <div>
                <p className="text-[10px] font-extrabold uppercase text-pos-muted tracking-wider mb-2">
                  Pièces Métalliques & Coupures Secondaires
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  {[
                    { key: 'qty200', label: '200 DA', val: 200 },
                    { key: 'qty100', label: '100 DA', val: 100 },
                    { key: 'qty50', label: '50 DA', val: 50 },
                    { key: 'qty20', label: '20 DA', val: 20 },
                    { key: 'qty10', label: '10 DA', val: 10 },
                  ].map((item) => (
                    <div
                      key={item.key}
                      className="bg-pos-bg border border-pos-border p-2 rounded-lg flex items-center justify-between gap-2"
                    >
                      <div>
                        <span className="text-xs font-bold text-amber-400">{item.label}</span>
                        <p className="text-[10px] text-pos-muted font-mono">
                          = {formatDZD((denominations[item.key as keyof DenominationCount] || 0) * item.val)}
                        </p>
                      </div>
                      <input
                        type="number"
                        min="0"
                        value={denominations[item.key as keyof DenominationCount] || ''}
                        onChange={(e) =>
                          handleDenomChange(item.key as keyof DenominationCount, e.target.value)
                        }
                        placeholder="0"
                        className="w-16 bg-pos-card border border-pos-border rounded px-2 py-1 text-right text-xs font-mono font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                      />
                    </div>
                  ))}
                  <div className="bg-pos-bg border border-pos-border p-2 rounded-lg flex items-center justify-between gap-2">
                    <div>
                      <span className="text-xs font-bold text-pos-muted">Pièces Div.</span>
                      <p className="text-[10px] text-pos-muted font-mono">Monnaie vrac</p>
                    </div>
                    <MoneyInput
                      label="Pièces Div."
                      valueMinor={dinarsToMinor(denominations.coins || 0)}
                      onChangeMinor={(minor) =>
                        setDenominations((prev) => ({ ...prev, coins: toLegacyReal(minor) }))
                      }
                      placeholder="0 DA"
                      className="w-16 bg-pos-card border border-pos-border rounded px-2 py-1 text-right text-xs font-mono font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-pos-card border border-pos-border p-4 rounded-xl space-y-2">
              <label className="text-xs font-bold text-pos-text block">
                Fond de Caisse Initial Direct (DA)
              </label>
              <MoneyInput
                label="Fond de Caisse Initial Direct (DA)"
                valueMinor={dinarsToMinor(directFloat || 0)}
                onChangeMinor={(minor) => setDirectFloat(toLegacyReal(minor))}
                placeholder="20 000 DA"
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-4 py-3 text-lg font-mono font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
              />
            </div>
          )}

          {/* Optional Note */}
          <div className="bg-pos-card border border-pos-border p-3 rounded-xl space-y-1">
            <label className="text-[10px] text-pos-muted uppercase font-bold flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-pos-muted" /> Note d'Ouverture (Optionnelle)
            </label>
            <input
              type="text"
              value={openingNote}
              onChange={(e) => setOpeningNote(e.target.value)}
              placeholder="Ex: Réception rouleaux de 100 DA, monnaie appoint..."
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-1.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shrink-0">
          <div className="flex items-center justify-between sm:block">
            <span className="text-[10px] uppercase font-bold text-pos-muted block">
              Fond de Caisse Validé
            </span>
            <span className="text-base font-black text-emerald-400 font-mono">
              {formatDZD(finalFloat)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeModal}
              className="flex-1 sm:flex-none min-h-[42px] px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text bg-pos-hover/50 sm:bg-transparent transition cursor-pointer"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={handleOpenShift}
              disabled={isSubmitting}
              className="flex-2 sm:flex-none min-h-[44px] px-4 sm:px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/20 transition active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{isSubmitting ? 'Ouverture en cours…' : 'Valider & Ouvrir la Session Caisse'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

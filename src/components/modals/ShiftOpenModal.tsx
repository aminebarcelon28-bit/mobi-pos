import React, { useState, useMemo } from 'react';
import { X, Play, Calculator, Sparkles, User, FileText, CheckCircle2 } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, type DenominationCount } from '../../types/pos';
import { useToast } from '../ui/Toast';

export const ShiftOpenModal: React.FC = () => {
  const { activeModal, closeModal, startShift } = usePosStore();
  const { showToast } = useToast();

  const [useDenominations, setUseDenominations] = useState<boolean>(true);
  const [cashierName, setCashierName] = useState<string>('Yacine');
  const [openingNote, setOpeningNote] = useState<string>('');
  const [directFloat, setDirectFloat] = useState<number>(20000);

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
    if (finalFloat < 0) {
      showToast('Le fond de caisse initial ne peut pas être négatif.', 'warning');
      return;
    }

    const result = await startShift(
      finalFloat,
      cashierName.trim() || 'Caissier Principal',
      openingNote.trim() || undefined,
      useDenominations ? denominations : undefined
    );

    if (result.success) {
      showToast(`Session ouverte avec succès ! Fond initial : ${formatDZD(finalFloat)}`, 'success');
      closeModal();
    } else {
      showToast(result.reason || "Échec de l'ouverture de session", 'error');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-2 text-emerald-400">
            <Play className="w-5 h-5" />
            <div>
              <h2 className="text-sm font-bold text-pos-text">
                Ouverture de Session Caisse (Start Shift)
              </h2>
              <p className="text-[11px] text-pos-muted">
                Décompte du fond de caisse initial et attribution du caissier
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
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
                placeholder="Ex: Yacine, Amina..."
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
                    <input
                      type="number"
                      min="0"
                      value={denominations.coins || ''}
                      onChange={(e) => handleDenomChange('coins', e.target.value)}
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
              <input
                type="number"
                step="100"
                min="0"
                value={directFloat || ''}
                onChange={(e) => setDirectFloat(parseFloat(e.target.value) || 0)}
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
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between">
          <div>
            <span className="text-[10px] uppercase font-bold text-pos-muted block">
              Fond de Caisse Validé
            </span>
            <span className="text-base font-black text-emerald-400 font-mono">
              {formatDZD(finalFloat)}
            </span>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={closeModal}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text hover:bg-pos-hover transition"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={handleOpenShift}
              className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition active:scale-[0.98]"
            >
              <CheckCircle2 className="w-4 h-4" /> Valider & Ouvrir la Session Caisse
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

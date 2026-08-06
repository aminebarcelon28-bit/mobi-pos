import React, { useState } from 'react';
import { X, Printer, ShieldAlert, CheckCircle2, ArrowDownCircle } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { useToast } from '../../components/ui/Toast';

export const ShiftZReportModal: React.FC = () => {
  const { activeModal, closeModal, shiftFloat, transactions, cashDrops, payouts, addCashDrop } = usePosStore();
  const [actualCountedCash, setActualCountedCash] = useState<number>(0);
  const [isBlindRevealed, setIsBlindRevealed] = useState<boolean>(false);
  const [cashDropInput, setCashDropInput] = useState<number>(0);
  const [cashDropReason, setCashDropReason] = useState<string>('Dépôt coffre-fort mi-journée');
  const { showToast } = useToast();

  if (activeModal !== 'shift_zreport') return null;

  // Financial Shift Auditing
  const totalCashSales = transactions.reduce((acc, t) => acc + t.total, 0);
  const totalDrops = cashDrops.reduce((acc, d) => acc + d.amount, 0);
  const totalPayouts = payouts.reduce((acc, p) => acc + p.amount, 0);
  const expectedCash = shiftFloat + totalCashSales - totalDrops - totalPayouts;
  const variance = actualCountedCash - expectedCash;

  const handlePrintZReport = () => {
    window.print();
  };

  const handleAddCashDrop = () => {
    if (cashDropInput > 0) {
      addCashDrop({
        amount: cashDropInput,
        reason: cashDropReason,
        user: 'Yacine'
      });
      showToast(`Dépôt coffre-fort de ${formatDZD(cashDropInput)} enregistré.`, 'success');
      setCashDropInput(0);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-2 text-emerald-400">
            <ShieldAlert className="w-5 h-5" />
            <h2 className="text-sm font-bold text-pos-text">
              Clôture de Caisse & Rapport Z de Fin de Journée
            </h2>
          </div>
          <button onClick={closeModal} className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div data-printable="true" className="printable-area p-5 overflow-y-auto space-y-5 flex-1">
          {/* Shift Cash Summary Cards */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
              <span className="text-[10px] text-pos-muted uppercase font-bold">Fond de Caisse Initial</span>
              <p className="text-sm font-bold text-pos-text mt-0.5">{formatDZD(shiftFloat)}</p>
            </div>

            <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
              <span className="text-[10px] text-pos-muted uppercase font-bold">Ventes Espèces</span>
              <p className="text-sm font-bold text-emerald-400 mt-0.5">{formatDZD(totalCashSales)}</p>
            </div>

            <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
              <span className="text-[10px] text-pos-muted uppercase font-bold">Dépôts Coffre (Drops)</span>
              <p className="text-sm font-bold text-amber-400 mt-0.5">-{formatDZD(totalDrops)}</p>
            </div>

            <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
              <span className="text-[10px] text-pos-muted uppercase font-bold">Décaissements Payouts</span>
              <p className="text-sm font-bold text-red-400 mt-0.5">-{formatDZD(totalPayouts)}</p>
            </div>
          </div>

          {/* Blind Till Reconciliation Section */}
          <div className="bg-pos-card border border-emerald-500/30 p-4 rounded-xl space-y-3">
            <h3 className="text-xs font-bold text-pos-text flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Réconciliation à Aveugle (Blind Till Count)
            </h3>
            <p className="text-[11px] text-pos-muted">
              Le caissier doit saisir le montant physique exact compté dans le tiroir-caisse avant que le logiciel ne révèle le solde théorique calculé.
            </p>

            <div className="grid grid-cols-2 gap-3 items-center">
              <div>
                <label className="text-xs text-pos-muted block mb-1 font-semibold">Montant Physique Compté (DA)</label>
                <input
                  type="number"
                  step="100"
                  value={actualCountedCash}
                  onChange={(e) => {
                    setActualCountedCash(parseFloat(e.target.value) || 0);
                    setIsBlindRevealed(true);
                  }}
                  placeholder="ex: 31 305 DA"
                  className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-base font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
                />
              </div>

              {isBlindRevealed ? (
                <div className="bg-pos-bg border border-pos-border p-3 rounded-lg text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-pos-muted">Espèces Théoriques Attendues:</span>
                    <span className="font-bold text-pos-text">{formatDZD(expectedCash)}</span>
                  </div>
                  <div className="flex justify-between items-baseline pt-1 border-t border-pos-border">
                    <span className="font-bold">Écart de Caisse (Variance):</span>
                    <span
                      className={`text-sm font-black ${
                        variance === 0
                          ? 'text-emerald-400'
                          : variance > 0
                          ? 'text-cyan-400'
                          : 'text-red-400'
                      }`}
                    >
                      {variance >= 0 ? `+${formatDZD(variance)}` : formatDZD(variance)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="bg-pos-bg border border-pos-border p-3 rounded-lg text-center text-xs text-pos-muted">
                  Saisissez le montant compté pour révéler le solde attendu et l'écart.
                </div>
              )}
            </div>
          </div>

          {/* Cash Drop Manager */}
          <div className="bg-pos-bg border border-pos-border p-4 rounded-xl space-y-3">
            <h4 className="text-xs font-bold text-pos-text flex items-center gap-1.5">
              <ArrowDownCircle className="w-4 h-4 text-amber-400" /> Enregistrer un Dépôt Coffre-fort (Cash Drop)
            </h4>
            <div className="grid grid-cols-3 gap-2">
              <input
                type="number"
                value={cashDropInput}
                onChange={(e) => setCashDropInput(parseFloat(e.target.value) || 0)}
                placeholder="Montant (DA)"
                className="bg-pos-card border border-pos-border rounded-lg px-3 py-1.5 text-xs text-pos-text"
              />
              <input
                type="text"
                value={cashDropReason}
                onChange={(e) => setCashDropReason(e.target.value)}
                placeholder="Motif dépôt"
                className="bg-pos-card border border-pos-border rounded-lg px-3 py-1.5 text-xs text-pos-text"
              />
              <button
                onClick={handleAddCashDrop}
                className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-lg py-1.5 transition"
              >
                Enregistrer Dépôt
              </button>
            </div>
            {cashDrops.length > 0 && (
              <div className="mt-4">
                <h5 className="text-xs font-semibold text-pos-muted mb-2">Dépôts récents</h5>
                <ul className="space-y-1 text-xs">
                  {cashDrops.map((drop) => (
                    <li key={drop.id} className="flex justify-between items-center bg-pos-card p-2 rounded-lg border border-pos-border">
                      <span className="text-pos-text">{drop.reason}</span>
                      <span className="font-bold text-amber-400">{formatDZD(drop.amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex justify-between items-center">
          <span className="text-xs text-pos-muted">Shift ID: SHIFT-20260801 • Caissier: Yacine</span>
          <div className="flex gap-2">
            <button onClick={closeModal} className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text">
              Annuler
            </button>
            <button
              onClick={handlePrintZReport}
              className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20"
            >
              <Printer className="w-4 h-4" /> Valider Clôture & Imprimer Rapport Z (F9)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

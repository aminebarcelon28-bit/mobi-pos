import React, { useState, useMemo } from 'react';
import {
  X,
  Printer,
  ShieldCheck,
  CheckCircle2,
  Lock,
  Calculator,
  Download,
  AlertTriangle,
  FileText,
  TrendingUp,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, type DenominationCount } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { printCoordinator } from '../../utils/printCoordinator';
import { sqliteAdapter } from '../../db/sqliteAdapter';

export const ShiftCloseModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    activeShift,
    closeShift,
    transactions,
  } = usePosStore();
  const { showToast } = useToast();

  const [step, setStep] = useState<'BLIND_COUNT' | 'RECONCILIATION'>('BLIND_COUNT');
  const [useDenom, setUseDenom] = useState<boolean>(false);
  const [directPhysicalCount, setDirectPhysicalCount] = useState<number>(0);
  const [closingNote, setClosingNote] = useState<string>('');
  const [cashierName, setCashierName] = useState<string>(activeShift?.cashierName || 'Yacine');
  const [backupDownloaded, setBackupDownloaded] = useState<boolean>(false);

  const [denominations, setDenominations] = useState<DenominationCount>({
    qty2000: 0,
    qty1000: 0,
    qty500: 0,
    qty200: 0,
    qty100: 0,
    qty50: 0,
    qty20: 0,
    qty10: 0,
    coins: 0,
  });

  const talliedDenoms = useMemo(() => {
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

  const physicalCount = useDenom ? talliedDenoms : directPhysicalCount;

  // Compute live system metrics for the active shift
  const openingFloat = activeShift?.openingFloat || 0;
  const openedAt = activeShift?.openedAt || new Date().toISOString();

  const sessionTxns = useMemo(() => {
    return transactions.filter((t) => {
      return (
        t.status !== 'VOIDED' &&
        !t.isRefund &&
        (!openedAt || t.createdAt >= openedAt)
      );
    });
  }, [transactions, openedAt]);

  const totalCashSales = useMemo(() => {
    return sessionTxns.reduce((sum, t) => {
      if (t.tenders && Array.isArray(t.tenders) && t.tenders.length > 0) {
        const cashTenderTotal = t.tenders
          .filter((tender) => tender.method === 'Espèces')
          .reduce((acc, tender) => acc + tender.amount, 0);
        return sum + cashTenderTotal;
      }
      return t.paymentMethod === 'Espèces' ? sum + t.total : sum;
    }, 0);
  }, [sessionTxns]);

  const totalSaleMargins = useMemo(() => {
    return sessionTxns.reduce((sum, t) => sum + (t.profit || 0), 0);
  }, [sessionTxns]);

  const manualDeposits = useMemo(() => {
    return (activeShift?.movements || [])
      .filter((m) => m.type === 'MANUAL_DEPOSIT')
      .reduce((sum, m) => sum + m.amount, 0);
  }, [activeShift?.movements]);

  const expenses = useMemo(() => {
    return (activeShift?.movements || [])
      .filter((m) => m.type === 'EXPENSE')
      .reduce((sum, m) => sum + m.amount, 0);
  }, [activeShift?.movements]);

  // Formula: opening_float + cash_sales + manual_deposits - expenses
  const expectedCash = openingFloat + totalCashSales + manualDeposits - expenses;
  const variance = physicalCount - expectedCash;
  const dailyNetProfit = totalSaleMargins - expenses;

  if (activeModal !== 'shift_close') return null;

  const handleDenomChange = (key: keyof DenominationCount, val: string) => {
    const parsed = parseInt(val, 10);
    setDenominations((prev) => ({
      ...prev,
      [key]: isNaN(parsed) ? 0 : Math.max(0, parsed),
    }));
  };

  const handleRevealReconciliation = () => {
    if (physicalCount <= 0) {
      if (!window.confirm('Le montant physique saisi est de 0 DA. Confirmez-vous ce comptage aveugle ?')) {
        return;
      }
    }
    setStep('RECONCILIATION');
  };

  const handleDownloadBackup = async () => {
    if (!activeShift) return;
    try {
      const jsonString = await sqliteAdapter.generateSessionBackupJson(activeShift.id);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mobi_pos_shift_backup_${activeShift.id}_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupDownloaded(true);
      showToast('Sauvegarde JSON de la session générée avec succès.', 'success');
    } catch (e) {
      console.error('Backup generation error:', e);
      showToast('Erreur lors de la génération de sauvegarde JSON.', 'error');
    }
  };

  const handleFinalizeClosure = async () => {
    // Variance Enforcement Guard: If variance !== 0, mandatory explanatory note is required!
    if (variance !== 0 && !closingNote.trim()) {
      showToast(
        "Écart de caisse détecté ! Une note justificative explicative est obligatoire pour clôturer la session.",
        'error'
      );
      return;
    }

    const res = await closeShift(
      physicalCount,
      closingNote.trim() || undefined,
      cashierName.trim() || undefined
    );

    if (res.success) {
      // Print official Z-Report
      printCoordinator.printZReport(40);
      showToast('Session caisse clôturée avec succès. Rapport Z imprimé.', 'success');
      closeModal();
    } else {
      showToast(res.reason || 'Erreur lors de la clôture de caisse.', 'error');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-2 text-emerald-400">
            <ShieldCheck className="w-5 h-5" />
            <div>
              <h2 className="text-sm font-bold text-pos-text">
                Clôture de Caisse & Audit de Réconciliation (Rapport Z)
              </h2>
              <p className="text-[11px] text-pos-muted">
                Protocole de comptage à l'aveugle, audit des écarts et sauvegarde comptable
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
          {step === 'BLIND_COUNT' ? (
            /* ═══ STEP 1: BLIND RECONCILIATION COUNT ═══ */
            <div className="space-y-4 animate-in fade-in">
              <div className="bg-amber-500/10 border border-amber-500/30 p-3.5 rounded-xl flex items-start gap-3 text-xs text-amber-300">
                <Lock className="w-5 h-5 flex-shrink-0 mt-0.5 text-amber-400" />
                <div>
                  <strong className="block text-amber-200 font-bold mb-0.5">
                    Protocole de Sécurité : Comptage à l'Aveugle
                  </strong>
                  Conformément aux normes d'audit interne, le caissier doit compter et déclarer le montant physique réel présent dans le tiroir-caisse <strong>avant</strong> que le système ne calcule et ne dévoile le solde théorique.
                </div>
              </div>

              {/* Mode Toggle: Direct vs Denomination */}
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-pos-text">
                  Comptage Physique des Espèces en Caisse
                </label>
                <div className="flex bg-pos-bg p-1 rounded-lg border border-pos-border">
                  <button
                    type="button"
                    onClick={() => setUseDenom(false)}
                    className={`px-3 py-1 text-xs font-bold rounded transition ${
                      !useDenom ? 'bg-emerald-500 text-slate-950 shadow-sm' : 'text-pos-muted hover:text-pos-text'
                    }`}
                  >
                    Montant Global (DA)
                  </button>
                  <button
                    type="button"
                    onClick={() => setUseDenom(true)}
                    className={`px-3 py-1 text-xs font-bold rounded transition ${
                      useDenom ? 'bg-emerald-500 text-slate-950 shadow-sm' : 'text-pos-muted hover:text-pos-text'
                    }`}
                  >
                    Détail par Coupure
                  </button>
                </div>
              </div>

              {!useDenom ? (
                <div className="bg-pos-card border border-pos-border p-4 rounded-xl space-y-2">
                  <label className="text-[11px] text-pos-muted font-bold block uppercase">
                    Total Espèces Comptées Physiquement (DA)
                  </label>
                  <input
                    type="number"
                    step="100"
                    min="0"
                    value={directPhysicalCount || ''}
                    onChange={(e) => setDirectPhysicalCount(parseFloat(e.target.value) || 0)}
                    placeholder="Ex: 48 500 DA"
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-4 py-3 text-xl font-mono font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
                    autoFocus
                  />
                </div>
              ) : (
                <div className="bg-pos-card border border-pos-border p-4 rounded-xl space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                    {[
                      { key: 'qty2000', label: '2 000 DA', val: 2000, color: 'text-emerald-400' },
                      { key: 'qty1000', label: '1 000 DA', val: 1000, color: 'text-cyan-400' },
                      { key: 'qty500', label: '500 DA', val: 500, color: 'text-purple-400' },
                      { key: 'qty200', label: '200 DA', val: 200, color: 'text-amber-400' },
                      { key: 'qty100', label: '100 DA', val: 100, color: 'text-amber-400' },
                      { key: 'qty50', label: '50 DA', val: 50, color: 'text-amber-400' },
                      { key: 'qty20', label: '20 DA', val: 20, color: 'text-amber-400' },
                      { key: 'qty10', label: '10 DA', val: 10, color: 'text-amber-400' },
                    ].map((item) => (
                      <div
                        key={item.key}
                        className="bg-pos-bg border border-pos-border p-2 rounded-lg flex items-center justify-between gap-2"
                      >
                        <div>
                          <span className={`text-xs font-bold ${item.color}`}>{item.label}</span>
                          <p className="text-[9px] text-pos-muted font-mono">
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
                          className="w-14 bg-pos-card border border-pos-border rounded px-2 py-1 text-right text-xs font-mono font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                        />
                      </div>
                    ))}
                    <div className="bg-pos-bg border border-pos-border p-2 rounded-lg flex items-center justify-between gap-2">
                      <div>
                        <span className="text-xs font-bold text-pos-muted">Pièces Div.</span>
                        <p className="text-[9px] text-pos-muted font-mono">Monnaie vrac</p>
                      </div>
                      <input
                        type="number"
                        min="0"
                        value={denominations.coins || ''}
                        onChange={(e) => handleDenomChange('coins', e.target.value)}
                        placeholder="0 DA"
                        className="w-14 bg-pos-card border border-pos-border rounded px-2 py-1 text-right text-xs font-mono font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Physical Count Summary */}
              <div className="bg-pos-bg border border-pos-border p-3.5 rounded-xl flex items-center justify-between">
                <span className="text-xs font-bold text-pos-muted">
                  Total Physique Déclaré :
                </span>
                <span className="text-lg font-black text-emerald-400 font-mono">
                  {formatDZD(physicalCount)}
                </span>
              </div>
            </div>
          ) : (
            /* ═══ STEP 2: RECONCILIATION & VARIANCE ENFORCEMENT ═══ */
            <div className="space-y-4 animate-in fade-in">
              {/* Financial Metrics Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                  <span className="text-[10px] text-pos-muted uppercase font-bold">Fond Initial</span>
                  <p className="text-sm font-bold text-pos-text mt-0.5">{formatDZD(openingFloat)}</p>
                </div>

                <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                  <span className="text-[10px] text-pos-muted uppercase font-bold">Ventes Espèces</span>
                  <p className="text-sm font-bold text-emerald-400 mt-0.5">+{formatDZD(totalCashSales)}</p>
                </div>

                <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                  <span className="text-[10px] text-pos-muted uppercase font-bold">Apports Caisse</span>
                  <p className="text-sm font-bold text-cyan-400 mt-0.5">+{formatDZD(manualDeposits)}</p>
                </div>

                <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                  <span className="text-[10px] text-pos-muted uppercase font-bold">Dépenses & Retraits</span>
                  <p className="text-sm font-bold text-red-400 mt-0.5">−{formatDZD(expenses)}</p>
                </div>
              </div>

              {/* Theoretical Expected vs Counted Comparison */}
              <div className="bg-pos-card border border-pos-border p-4 rounded-xl space-y-3">
                <div className="flex items-center justify-between border-b border-pos-border pb-2">
                  <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                    <Calculator className="w-4 h-4 text-cyan-400" /> Bilan de Réconciliation Caisse
                  </span>
                  <span className="text-[11px] text-pos-muted font-mono">
                    Formule: Fond + Ventes + Apports − Dépenses
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="bg-pos-bg border border-pos-border p-3 rounded-xl">
                    <span className="text-[10px] text-pos-muted uppercase font-bold">Espèces Attendues</span>
                    <p className="text-base font-black text-pos-text font-mono mt-0.5">
                      {formatDZD(expectedCash)}
                    </p>
                  </div>

                  <div className="bg-pos-bg border border-pos-border p-3 rounded-xl">
                    <span className="text-[10px] text-pos-muted uppercase font-bold">Espèces Comptées</span>
                    <p className="text-base font-black text-emerald-400 font-mono mt-0.5">
                      {formatDZD(physicalCount)}
                    </p>
                  </div>

                  <div
                    className={`border p-3 rounded-xl ${
                      variance === 0
                        ? 'bg-emerald-500/10 border-emerald-500/30'
                        : variance > 0
                        ? 'bg-cyan-500/10 border-cyan-500/30'
                        : 'bg-red-500/10 border-red-500/30'
                    }`}
                  >
                    <span className="text-[10px] uppercase font-bold text-pos-muted">
                      Écart de Caisse (Variance)
                    </span>
                    <p
                      className={`text-base font-black font-mono mt-0.5 ${
                        variance === 0
                          ? 'text-emerald-400'
                          : variance > 0
                          ? 'text-cyan-400'
                          : 'text-red-400'
                      }`}
                    >
                      {variance > 0 ? `+${formatDZD(variance)} (Excédent)` : variance < 0 ? `${formatDZD(variance)} (Déficit)` : '0 DA (Parfait)'}
                    </p>
                  </div>
                </div>

                {/* Net Profit Summary */}
                <div className="bg-pos-bg border border-pos-border p-3 rounded-xl flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-emerald-400" />
                    <div>
                      <span className="text-xs font-bold text-pos-text">Profit Net Commercial du Shift :</span>
                      <p className="text-[10px] text-pos-muted">Marges brutes des ventes − Dépenses d'exploitation</p>
                    </div>
                  </div>
                  <span className="text-sm font-black text-emerald-400 font-mono">
                    {formatDZD(dailyNetProfit)}
                  </span>
                </div>
              </div>

              {/* Variance Enforcement Alert & Mandatory Note */}
              {variance !== 0 ? (
                <div className="bg-red-500/10 border border-red-500/40 p-4 rounded-xl space-y-2">
                  <div className="flex items-center gap-2 text-red-400">
                    <AlertTriangle className="w-4 h-4" />
                    <span className="text-xs font-bold">
                      Justification Obligatoire de l'Écart de Caisse
                    </span>
                  </div>
                  <p className="text-[11px] text-red-200">
                    La caisse présente un écart de <strong>{formatDZD(variance)}</strong>. Vous devez obligatoirement saisir une note explicative pour pouvoir valider la clôture.
                  </p>
                  <input
                    type="text"
                    value={closingNote}
                    onChange={(e) => setClosingNote(e.target.value)}
                    placeholder="Ex: Erreur rendu de monnaie ticket REC-124, pourboire..."
                    className="w-full bg-pos-bg border border-red-500/50 rounded-lg px-3 py-2 text-xs text-pos-text focus:border-red-400 focus:outline-none"
                    autoFocus
                  />
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div className="bg-pos-card border border-pos-border p-3 rounded-xl space-y-1">
                    <label className="text-[10px] text-pos-muted uppercase font-bold">
                      Nom du Caissier
                    </label>
                    <input
                      type="text"
                      value={cashierName}
                      onChange={(e) => setCashierName(e.target.value)}
                      placeholder="Yacine"
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                    />
                  </div>
                  <div className="sm:col-span-2 bg-pos-card border border-pos-border p-3 rounded-xl space-y-1">
                    <label className="text-[10px] text-pos-muted uppercase font-bold flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-pos-muted" /> Note de Clôture (Optionnelle)
                    </label>
                    <input
                      type="text"
                      value={closingNote}
                      onChange={(e) => setClosingNote(e.target.value)}
                      placeholder="Ex: RAS, fin de shift normale..."
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-1.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                    />
                  </div>
                </div>
              )}

              {/* Automated Backup Generator Trigger */}
              <div className="bg-pos-card border border-pos-border p-3.5 rounded-xl flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-pos-text block">
                    Sauvegarde JSON Automatisée (Audit Sync)
                  </span>
                  <span className="text-[11px] text-pos-muted">
                    Exporte les métriques, mouvements et l'état des stocks pour archivage
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadBackup}
                  className="px-3 py-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center gap-1.5 transition"
                >
                  <Download className="w-3.5 h-3.5 text-cyan-400" />
                  {backupDownloaded ? 'Sauvegardé' : 'Exporter JSON'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between">
          {step === 'BLIND_COUNT' ? (
            <>
              <button
                type="button"
                onClick={closeModal}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={handleRevealReconciliation}
                className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition active:scale-[0.98]"
              >
                <CheckCircle2 className="w-4 h-4" /> Valider le Comptage & Voir l'Audit
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStep('BLIND_COUNT')}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition"
              >
                ← Recompter
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={handleFinalizeClosure}
                  disabled={variance !== 0 && !closingNote.trim()}
                  className={`px-5 py-2.5 rounded-xl font-bold text-xs flex items-center gap-1.5 shadow-lg transition active:scale-[0.98] ${
                    variance !== 0 && !closingNote.trim()
                      ? 'bg-slate-700 text-slate-400 cursor-not-allowed opacity-60'
                      : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20'
                  }`}
                >
                  <Printer className="w-4 h-4" /> Clôturer Caisse & Imprimer Rapport Z
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

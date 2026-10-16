import React, { useState, useEffect, useRef } from 'react';
import { X, Printer, ShieldAlert, CheckCircle2, ArrowDownCircle } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { useToast } from '../../components/ui/Toast';
import { MoneyInput } from '../ui/MoneyInput';
import { toLegacyReal, dinarsToMinor } from '../../utils/money';
import { printCoordinator } from '../../utils/printCoordinator';
import { isMobileDevice } from '../../utils/platform';
import { isTxInCloseScope } from '../../db/adapters/shiftAdapter';
import {
  cashSalesFromTxns,
  cashRefundsFromTxns,
  exchangeCashOutFromMovements,
  standaloneDepositsFromMovements,
  standaloneExpensesFromMovements,
  savDepositsFromRepairs,
  savSettledFromTxns,
  zTicketNumber,
  DRAWER_REASON_PREFIXES,
} from '../../utils/cashTerms';
import { ZReportPaper, type ZReportSnapshot } from '../receipt/ZReportPaper';
import { blindRevealAuditDetail, buildZSnapshot } from '../../utils/zReportSnapshot';
import { Kbd } from '../../design-system/desktop/Kbd';

export const ShiftZReportModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    shiftFloat,
    activeShift,
    allShifts,
    transactions,
    cashDrops,
    payouts,
    addCashDrop,
    customerDebts,
    storeExpenses,
    repairOrders,
    tradeIns,
    receiptSettings,
    logSecurityAction,
  } = usePosStore();
  const [actualCountedCash, setActualCountedCash] = useState<number>(0);
  const [isBlindRevealed, setIsBlindRevealed] = useState<boolean>(false);
  // One audit line per REVEAL, not per keystroke: `onChangeMinor` fires on every
  // digit, and a journal that grows with the length of the number is noise that
  // hides the event it exists to record.
  const blindRevealAuditedRef = useRef(false);
  const [cashDropInput, setCashDropInput] = useState<number>(0);
  const [cashDropReason, setCashDropReason] = useState<string>('Dépôt coffre-fort mi-journée');
  const { showToast } = useToast();

  // Lock-screen cashier fallback (createUISlice owns `activeCashier`; absent
  // from the shared PosState type, so read via structural cast).
  const lockScreenCashier =
    (usePosStore.getState() as unknown as { activeCashier?: { name?: string } | null })
      .activeCashier?.name?.trim() || 'Caissier';

  useEffect(() => { if (activeModal !== 'shift_zreport') return; blindRevealAuditedRef.current = false; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  if (activeModal !== 'shift_zreport') return null;

  // Financial Shift Auditing (Strict zero-variance accounting).
  // Cash terms share one definition with booking, the close preview and
  // Reports (utils/cashTerms). Scope: the open shift window — the previous
  // code summed ALL-TIME history against one shift's float, inflating
  // expected cash by every past debt settlement, expense and drop. Without
  // an open shift there is no window to scope to, so legacy all-time
  // behavior is kept as the fallback. Non-txn lanes carry no shiftId, so
  // they scope by createdAt >= openedAt; txns use the stamp-aware booking
  // rule (isTxInCloseScope) exactly like preview + booking.
  const openedAt = activeShift?.openedAt ?? null;
  const inShiftWindow = (iso: string | undefined) => {
    if (!openedAt) return true;
    if (!iso) return true;
    return iso >= openedAt;
  };
  const safeTransactions = transactions || [];
  const shiftTxns = openedAt
    ? safeTransactions.filter((t) =>
        isTxInCloseScope(t, { id: activeShift?.id, openedAt })
      )
    : safeTransactions;
  const totalCashSales = cashSalesFromTxns(shiftTxns);
  const totalCashRefunds = cashRefundsFromTxns(shiftTxns);

  const todayDebtSettlements = (customerDebts || [])
    .filter((d) => d.type === 'PAYMENT_SETTLED' && d.paymentMethod === 'Espèces' && inShiftWindow(d.createdAt))
    .reduce((acc, d) => acc + (d.amount || 0), 0);

  const todayCashExpenses = (storeExpenses || [])
    .filter((e) => e.paymentMethod === 'Espèces' && inShiftWindow(e.createdAt))
    .reduce((acc, e) => acc + (e.amount || 0), 0);

  // SAV deposits actually taken (never imputed unpaid balances) + cash
  // trade-in payouts — both were missing here, understating and overstating
  // expected cash respectively. Settled balances are informational only
  // (cash already inside cashSalesFromTxns — never added to expected cash).
  const closedShiftCount = (allShifts || []).filter((s) => s.status === 'CLOSED').length;
  const zNumber = zTicketNumber(closedShiftCount);
  const tradeInCashOut = (tradeIns || [])
    .filter((t) => !t.creditToWallet && inShiftWindow(t.createdAt))
    .reduce((acc, t) => acc + (t.buybackValue || 0), 0);

  const totalDrops = (cashDrops || []).filter((d) => inShiftWindow(d.timestamp)).reduce((acc, d) => acc + (d.amount || 0), 0);
  const totalPayouts = (payouts || []).filter((p) => inShiftWindow(p.timestamp)).reduce((acc, p) => acc + (p.amount || 0), 0);

  // Movement-only terms from the open session's in-store movements (same
  // rows booking reads): exchange cash-outs + twin-less manual movements.
  const sessionMovements = activeShift?.movements || [];
  const exchangeOut = exchangeCashOutFromMovements(sessionMovements);
  const soulteOut = sessionMovements
    .filter(
      (m) => m.type === 'EXPENSE' && (m.reason || '').startsWith(DRAWER_REASON_PREFIXES.SOULTE_CASHOUT)
    )
    .reduce((acc, m) => acc + Math.max(0, Math.round(Number(m.amount) || 0)), 0);
  const exchangeOutPure = Math.max(0, exchangeOut - soulteOut);
  const manualIn = standaloneDepositsFromMovements(sessionMovements);
  const manualOut = standaloneExpensesFromMovements(sessionMovements);
  const openingFloat = activeShift?.openingFloat ?? shiftFloat;

  // Unified print and display snapshot — single definition shared across all Z surfaces
  const zSnapshot: ZReportSnapshot = buildZSnapshot({
    settings: receiptSettings,
    shift: activeShift,
    shiftFloat,
    transactions: safeTransactions,
    customerDebts: customerDebts || [],
    storeExpenses: storeExpenses || [],
    repairOrders: repairOrders || [],
    tradeIns: tradeIns || [],
    cashDrops: cashDrops || [],
    payouts: payouts || [],
    countedCash: actualCountedCash,
    blindCountPerformed: isBlindRevealed,
    closedAtISO: new Date().toISOString(),
    closedShiftCount,
    fallbackCashier: lockScreenCashier,
  });

  const savDeposits = zSnapshot.savDeposits;
  const savSettled = zSnapshot.savSettled;
  const expectedCash = zSnapshot.expectedCash;
  const variance = isBlindRevealed ? zSnapshot.variance : 0;
  const responsibleName = zSnapshot.responsibleName;
  const turnover = { card: zSnapshot.cardSales, credit: zSnapshot.creditSales, reprise: zSnapshot.repriseTake };
  const netSales = zSnapshot.netSales;

  const handlePrintZReport = async () => {
    // Mobile: no window.print dialog — text Z via the Android print sheet.
    if (isMobileDevice()) {
      const { openNativePrint } = await import('../../utils/phoneUtils');
      const { zReportText } = await import('../../utils/mobileDocPrint');
      const ok = await openNativePrint(
        `Rapport Z ${lockScreenCashier}`,
        zReportText({
          storeName: receiptSettings?.storeName,
          zNumber,
          cashierName: lockScreenCashier,
          responsibleName,
          registerLabel: zSnapshot.registerLabel,
          openedAtISO: zSnapshot.openedAtISO,
          closedAtISO: zSnapshot.closedAtISO,
          dateStr: new Date().toLocaleString('fr-DZ'),
          openingFloat,
          cashSales: totalCashSales,
          cardSales: turnover.card,
          creditSales: turnover.credit,
          repriseTake: turnover.reprise,
          netSales,
          debtSettlements: todayDebtSettlements,
          savDeposits,
          savSettled,
          refunds: totalCashRefunds,
          expenses: todayCashExpenses,
          tradeIns: tradeInCashOut,
          drops: totalDrops,
          payouts: totalPayouts,
          exchangeOut: exchangeOutPure,
          soulteOut,
          manualIn,
          manualOut,
          expectedCash,
          countedCash: actualCountedCash,
          variance,
          blindCountPerformed: isBlindRevealed,
        })
      );
      showToast(
        ok ? '🖨️ Feuille d’impression Android ouverte.' : 'Impression indisponible sur cet appareil.',
        ok ? 'success' : 'error'
      );
      return;
    }
    printCoordinator.printZReport(40);
  };

  const handleAddCashDrop = () => {
    const validDrop = Math.max(0, isNaN(cashDropInput) ? 0 : cashDropInput);
    if (validDrop <= 0) {
      showToast('Veuillez saisir un montant de transfert supérieur à 0 DA.', 'warning');
      return;
    }
    if (!window.confirm(`Confirmer l’enregistrement du dépôt coffre-fort de ${formatDZD(validDrop)} ?`)) {
      return;
    }
    addCashDrop({
      amount: validDrop,
      reason: cashDropReason.trim() || 'Dépôt coffre-fort régulier',
      user: lockScreenCashier,
    });
    showToast(`Dépôt coffre-fort de ${formatDZD(validDrop)} enregistré.`, 'success');
    setCashDropInput(0);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Clôture de caisse et rapport Z" className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:fade-in sm:zoom-in-95 max-h-[94dvh] sm:max-h-[90dvh] flex flex-col">
        {/* Mobile drag handle */}
        <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0 print:hidden" aria-hidden="true" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2 print:hidden">
          <div className="flex items-center gap-2 text-emerald-400 min-w-0">
            <ShieldAlert className="w-5 h-5 shrink-0" />
            <h2 className="text-xs sm:text-sm font-bold text-pos-text truncate">
              Clôture de Caisse & Rapport Z de Fin de Journée
            </h2>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="hidden sm:inline-flex">
              <Kbd size="sm">Esc</Kbd>
            </span>
            <button
              onClick={closeModal}
              className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer min-h-[48px] min-w-[48px] flex items-center justify-center shrink-0"
              aria-label="Fermer"
              title="Fermer"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        {/* Scrollable Body (screen only — print uses the dedicated doc below) */}
        <div className="print-zreport-target p-5 overflow-y-auto overscroll-contain space-y-5 flex-1 print:hidden">
          {/* Shift Cash Summary Cards — Concealed until blind count is validated */}
          {!isBlindRevealed ? (
            <div className="bg-pos-card border border-dashed border-pos-border rounded-xl p-6 text-center space-y-2">
              <ShieldAlert className="w-8 h-8 text-amber-500 mx-auto" />
              <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider">
                Comptage Physique à l'Aveugle
              </h4>
              <p className="text-[11px] text-pos-muted max-w-md mx-auto">
                Les totaux d'encaissement et le solde théorique sont masqués jusqu'à la validation du montant physique réel compté dans le tiroir-caisse.
              </p>
            </div>
          ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
              <span className="text-[10px] text-pos-muted uppercase font-bold">Fond Initial</span>
              <p className="text-sm font-bold text-pos-text mt-0.5 num">{formatDZD(openingFloat)}</p>
            </div>

            <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
              <span className="text-[10px] text-pos-muted uppercase font-bold">Ventes Espèces</span>
              <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 mt-0.5 num">{formatDZD(totalCashSales)}</p>
            </div>

            {todayDebtSettlements > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Règlements Dettes</span>
                <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 mt-0.5 num">+{formatDZD(todayDebtSettlements)}</p>
              </div>
            )}

            {todayCashExpenses > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Dépenses Espèces</span>
                <p className="text-sm font-bold text-rose-600 dark:text-rose-400 mt-0.5 num">−{formatDZD(todayCashExpenses)}</p>
              </div>
            )}

            {totalCashRefunds > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Remboursements</span>
                <p className="text-sm font-bold text-purple-600 dark:text-purple-400 mt-0.5">-{formatDZD(totalCashRefunds)}</p>
              </div>
            )}

            {savDeposits > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Acomptes SAV</span>
                <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">+{formatDZD(savDeposits)}</p>
              </div>
            )}

            {savSettled > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Soldes SAV Encaissés</span>
                <p className="text-sm font-bold text-emerald-400 mt-0.5">+{formatDZD(savSettled)}</p>
                <p className="text-[9px] text-pos-muted mt-0.5">Informatif — déjà compté dans les ventes</p>
              </div>
            )}

            {tradeInCashOut > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Rachats Occasions</span>
                <p className="text-sm font-bold text-red-400 mt-0.5">-{formatDZD(tradeInCashOut)}</p>
              </div>
            )}

            {exchangeOutPure > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Retours Échanges</span>
                <p className="text-sm font-bold text-red-400 mt-0.5">-{formatDZD(exchangeOutPure)}</p>
              </div>
            )}

            {soulteOut > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Soulte Échange (Reprise)</span>
                <p className="text-sm font-bold text-red-400 mt-0.5">-{formatDZD(soulteOut)}</p>
              </div>
            )}

            {(manualIn > 0 || manualOut > 0) && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Mouvements Manuels</span>
                <p className="text-sm font-bold text-pos-text mt-0.5">
                  {manualIn > 0 && <span className="text-emerald-400">+{formatDZD(manualIn)}</span>}
                  {manualIn > 0 && manualOut > 0 && <span className="text-pos-muted"> / </span>}
                  {manualOut > 0 && <span className="text-red-400">-{formatDZD(manualOut)}</span>}
                </p>
              </div>
            )}

            <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
              <span className="text-[10px] text-pos-muted uppercase font-bold">Dépôts Coffre</span>
              <p className="text-sm font-bold text-amber-400 mt-0.5">-{formatDZD(totalDrops)}</p>
            </div>

            <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
              <span className="text-[10px] text-pos-muted uppercase font-bold">Décaissements</span>
              <p className="text-sm font-bold text-red-400 mt-0.5">-{formatDZD(totalPayouts)}</p>
            </div>
          </div>
          )}

          {/* Blind Till Reconciliation Section */}
          <div className="bg-pos-card border border-emerald-500/30 p-4 rounded-xl space-y-3">
            <h3 className="text-xs font-bold text-pos-text flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Réconciliation à Aveugle (Blind Till Count)
            </h3>
            <p className="text-[11px] text-pos-muted">
              Le caissier doit saisir le montant physique exact compté dans le tiroir-caisse avant que le logiciel ne révèle le solde théorique calculé.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
              <div>
                <label className="text-xs text-pos-muted block mb-1 font-semibold">Montant Physique Compté (DA)</label>
                <MoneyInput
                  label="Montant Physique Compté (DA)"
                  valueMinor={dinarsToMinor(actualCountedCash || 0)}
                  onChangeMinor={(minor) => {
                    setActualCountedCash(toLegacyReal(minor));
                  }}
                  disabled={isBlindRevealed}
                  placeholder="ex: 31 305 DA"
                  className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-base font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none disabled:opacity-75"
                />
                {!isBlindRevealed && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!blindRevealAuditedRef.current) {
                        blindRevealAuditedRef.current = true;
                        void logSecurityAction(
                          'Révélation du solde théorique — Z à Aveugle',
                          blindRevealAuditDetail({ zNumber, cashier: lockScreenCashier }),
                          lockScreenCashier
                        );
                      }
                      setIsBlindRevealed(true);
                      showToast('Comptage verrouillé. Écarts et solde théorique révélés.', 'info');
                    }}
                    className="mt-2.5 w-full py-2 px-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-lg transition active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Valider et Révéler le Solde Théorique</span>
                  </button>
                )}
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <MoneyInput
                label="Montant (DA)"
                valueMinor={dinarsToMinor(cashDropInput || 0)}
                onChangeMinor={(minor) => setCashDropInput(toLegacyReal(minor))}
                placeholder="Montant (DA)"
                className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-1.5 text-base sm:text-xs text-pos-text"
              />
              <input
                type="text"
                value={cashDropReason}
                onChange={(e) => setCashDropReason(e.target.value)}
                placeholder="Motif dépôt"
                className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-1.5 text-base sm:text-xs text-pos-text"
              />
              <button
                onClick={handleAddCashDrop}
                className="w-full min-h-[48px] bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-lg py-1.5 transition active:scale-95"
              >
                Enregistrer Dépôt
              </button>
            </div>
            {(cashDrops || []).length > 0 && (
              <div className="mt-4">
                <h5 className="text-xs font-semibold text-pos-muted mb-2">Dépôts récents</h5>
                <ul className="space-y-1 text-xs">
                  {(cashDrops || []).map((drop) => (
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

        {/* Print-only Z document — shared paper (single print target). */}
        <div className="hidden print:flex print:justify-center print:bg-white">
          <ZReportPaper snapshot={zSnapshot} />
        </div>

        {/* Footer Actions */}
        <div className="p-3.5 sm:p-4 pb-[max(1rem,var(--safe-bottom))] sm:pb-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-2.5 shrink-0 print:hidden">
          <span className="text-[11px] text-pos-muted text-center sm:text-left">Z-TICKET N°: {zNumber} • Caissier: {lockScreenCashier}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={closeModal}
              className="flex-1 sm:flex-none min-h-[44px] px-4 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text bg-pos-hover/50 sm:bg-transparent transition cursor-pointer active:scale-95"
            >
              Annuler
            </button>
            {activeShift && activeShift.status === 'OPEN' && (
              <button
                type="button"
                onClick={async () => {
                  if (!isBlindRevealed) {
                    showToast("Veuillez d'abord valider le comptage physique à l'aveugle.", 'warning');
                    return;
                  }
                  try {
                    const res = await (usePosStore.getState().closeShift as any)(
                      actualCountedCash,
                      'Clôture directe depuis rapport Z',
                      lockScreenCashier
                    );
                    if (res?.success) {
                      showToast('Session de caisse clôturée avec succès.', 'success');
                      handlePrintZReport();
                      closeModal();
                    } else {
                      showToast(res?.reason || 'Erreur lors de la clôture', 'error');
                    }
                  } catch (err: unknown) {
                    showToast(err instanceof Error ? err.message : 'Erreur clôture', 'error');
                  }
                }}
                className="flex-2 sm:flex-none min-h-[44px] px-4 sm:px-5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-black text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-rose-600/20 active:scale-95 transition cursor-pointer"
              >
                <ShieldAlert className="w-4 h-4" aria-hidden="true" />
                <span>Clôturer Session & Imprimer Z</span>
              </button>
            )}
            <button
              onClick={handlePrintZReport}
              aria-label="Imprimer Rapport Z (F9) — imprimer le ticket de clôture 80mm"
              className="flex-2 sm:flex-none min-h-[44px] px-4 sm:px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/20 active:scale-95 transition cursor-pointer"
            >
              <Printer className="w-4 h-4" aria-hidden="true" />
              <span>Imprimer Rapport Z</span>
              <span className="hidden sm:inline"> (F9)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

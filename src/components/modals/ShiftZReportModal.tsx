import React, { useState, useEffect } from 'react';
import { X, Printer, ShieldAlert, CheckCircle2, ArrowDownCircle } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { useToast } from '../../components/ui/Toast';
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
import { buildZSnapshot } from '../../utils/zReportSnapshot';

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
  } = usePosStore();
  const [actualCountedCash, setActualCountedCash] = useState<number>(0);
  const [isBlindRevealed, setIsBlindRevealed] = useState<boolean>(false);
  const [cashDropInput, setCashDropInput] = useState<number>(0);
  const [cashDropReason, setCashDropReason] = useState<string>('Dépôt coffre-fort mi-journée');
  const { showToast } = useToast();

  // Lock-screen cashier fallback (createUISlice owns `activeCashier`; absent
  // from the shared PosState type, so read via structural cast).
  const lockScreenCashier =
    (usePosStore.getState() as unknown as { activeCashier?: { name?: string } | null })
      .activeCashier?.name?.trim() || 'Caissier';

  useEffect(() => { if (activeModal !== 'shift_zreport') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

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
  const savDeposits = savDepositsFromRepairs((repairOrders || []).filter((r) => inShiftWindow(r.createdAt)));
  const savSettled = savSettledFromTxns(shiftTxns);
  const closedShiftCount = (allShifts || []).filter((s) => s.status === 'CLOSED').length;
  const zNumber = zTicketNumber(closedShiftCount);
  const tradeInCashOut = (tradeIns || [])
    .filter((t) => !t.creditToWallet && inShiftWindow(t.createdAt))
    .reduce((acc, t) => acc + (t.buybackValue || 0), 0);

  const totalDrops = (cashDrops || []).filter((d) => inShiftWindow(d.timestamp)).reduce((acc, d) => acc + (d.amount || 0), 0);
  const totalPayouts = (payouts || []).filter((p) => inShiftWindow(p.timestamp)).reduce((acc, p) => acc + (p.amount || 0), 0);

  // Movement-only terms from the open session's in-store movements (same
  // rows booking reads): exchange cash-outs + twin-less manual movements.
  // Soulte payouts ride inside the unified exchange lane for expected-cash
  // math but display on their own Z line (no double-show).
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
  const expectedCash =
    openingFloat + totalCashSales + todayDebtSettlements + savDeposits + manualIn
    - totalCashRefunds - totalDrops - totalPayouts - todayCashExpenses - tradeInCashOut - exchangeOut - manualOut;
  const variance = actualCountedCash - expectedCash;

  // Frozen print snapshot — single definition shared with the close ticket,
  // the ESC/POS twin and the mobile text (see utils/zReportSnapshot). Preview
  // locals above stay untouched; this feeds print paths only.
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
    closedAtISO: new Date().toISOString(),
    closedShiftCount,
    fallbackCashier: lockScreenCashier,
  });
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
    if (expectedCash > 0 && validDrop > expectedCash) {
      if (!window.confirm(`⚠️ Attention : Le montant du dépôt (${formatDZD(validDrop)}) est supérieur au solde de caisse théorique (${formatDZD(expectedCash)}). Souhaitez-vous confirmer ce transfert ?`)) {
        return;
      }
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
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-2xl sm:rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:fade-in sm:zoom-in-95 max-h-[94dvh] sm:max-h-[90dvh] flex flex-col">
        {/* Mobile drag handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0 print:hidden" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2 print:hidden">
          <div className="flex items-center gap-2 text-emerald-400 min-w-0">
            <ShieldAlert className="w-5 h-5 shrink-0" />
            <h2 className="text-xs sm:text-sm font-bold text-pos-text truncate">
              Clôture de Caisse & Rapport Z de Fin de Journée
            </h2>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
            aria-label="Fermer — fermer le rapport Z"
            title="Fermer"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable Body */}
        {/* Scrollable Body (screen only — print uses the dedicated doc below) */}
        <div className="print-zreport-target p-5 overflow-y-auto overscroll-contain space-y-5 flex-1 print:hidden">
          {/* Shift Cash Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
              <span className="text-[10px] text-pos-muted uppercase font-bold">Fond Initial</span>
              <p className="text-sm font-bold text-pos-text mt-0.5">{formatDZD(openingFloat)}</p>
            </div>

            <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
              <span className="text-[10px] text-pos-muted uppercase font-bold">Ventes Espèces</span>
              <p className="text-sm font-bold text-emerald-400 mt-0.5">{formatDZD(totalCashSales)}</p>
            </div>

            {todayDebtSettlements > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Règlements Dettes</span>
                <p className="text-sm font-bold text-emerald-400 mt-0.5">+{formatDZD(todayDebtSettlements)}</p>
              </div>
            )}

            {todayCashExpenses > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Dépenses Espèces</span>
                <p className="text-sm font-bold text-red-400 mt-0.5">−{formatDZD(todayCashExpenses)}</p>
              </div>
            )}

            {totalCashRefunds > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Remboursements</span>
                <p className="text-sm font-bold text-purple-400 mt-0.5">-{formatDZD(totalCashRefunds)}</p>
              </div>
            )}

            {savDeposits > 0 && (
              <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                <span className="text-[10px] text-pos-muted uppercase font-bold">Acomptes SAV</span>
                <p className="text-sm font-bold text-emerald-400 mt-0.5">+{formatDZD(savDeposits)}</p>
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
                  step="any"
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="number"
                inputMode="decimal"
                value={cashDropInput}
                onChange={(e) => setCashDropInput(parseFloat(e.target.value) || 0)}
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
        <div className="p-3.5 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-2.5 shrink-0 print:hidden">
          <span className="text-[11px] text-pos-muted text-center sm:text-left">Z-TICKET N°: {zNumber} • Caissier: {lockScreenCashier}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={closeModal}
              className="flex-1 sm:flex-none min-h-[42px] px-4 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text bg-pos-hover/50 sm:bg-transparent transition cursor-pointer"
            >
              Annuler
            </button>
            <button
              onClick={handlePrintZReport}
              aria-label="Imprimer Rapport Z (F9) — imprimer le ticket de clôture 80mm"
              className="flex-2 sm:flex-none min-h-[42px] px-4 sm:px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/20 active:scale-95 transition cursor-pointer"
            >
              <Printer className="w-4 h-4" aria-hidden="true" />
              <span>Imprimer Rapport Z (F9)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

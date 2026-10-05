import React, { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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
import { ZReportPaper, type ZReportSnapshot } from '../receipt/ZReportPaper';
import { buildZSnapshot } from '../../utils/zReportSnapshot';
import type { CloseShiftWithPin } from '../../store/slices/createShiftSlice';
import { SHIFT_VARIANCE_MANAGER_PIN_THRESHOLD } from '../../db/adapters/shiftAdapter';
import { formatDZD, type DenominationCount } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { MoneyInput } from '../ui/MoneyInput';
import { toLegacyReal, dinarsToMinor } from '../../utils/money';
import { printCoordinator } from '../../utils/printCoordinator';
import { maintenanceService } from '../../services/maintenanceService';
import { isMobileDevice } from '../../utils/platform';
import { verifyManagerGate } from '../../utils/pinGate';
import { useAllocationCogs } from '../../hooks/useAllocationCogs';
import { isExchangeSaleTx } from '../../utils/receiptMath';
import { DRAWER_REASON_PREFIXES } from '../../utils/cashTerms';
import { utcNowIso } from '../../utils/dateUtils';

// Lock-screen cashier fallback (createUISlice owns `activeCashier`; absent
// from the shared PosState type, so read via structural cast).
function readLockScreenCashierName(): string {
  const state = usePosStore.getState() as unknown as { activeCashier?: { name?: string } | null };
  return state.activeCashier?.name?.trim() || '';
}

// Adapter coded errors → cashier-facing French messages.
function closeErrorMessage(reason?: string): string {
  switch (reason) {
    case 'NO_OPEN_SHIFT':
      return 'Aucune session de caisse ouverte à clôturer.';
    case 'CLOSING_NOTE_REQUIRED':
      return "Écart de caisse détecté : une note justificative est obligatoire pour clôturer.";
    case 'MANAGER_PIN_REQUIRED':
      return `Écart ≥ ${formatDZD(SHIFT_VARIANCE_MANAGER_PIN_THRESHOLD)} : validation par code PIN Manager requise.`;
    case 'MANAGER_PIN_INVALID':
      return 'Code PIN Manager incorrect — clôture à écart refusée.';
    default:
      return reason || 'Erreur lors de la clôture de caisse.';
  }
}

export const ShiftCloseModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    openModal,
    activeShift,
    closeShift,
    transactions,
    printXReport,
    // Phase 1: manager checks route through the native gate (no local
    // verifyManagerPin reads here — see utils/pinGate).
    logSecurityAction,
  } = usePosStore();
  const { showToast } = useToast();

  const [step, setStep] = useState<'BLIND_COUNT' | 'RECONCILIATION'>('BLIND_COUNT');
  const [useDenom, setUseDenom] = useState<boolean>(false);
  const [directPhysicalCount, setDirectPhysicalCount] = useState<number>(0);
  const [closingNote, setClosingNote] = useState<string>('');
  const [cashierName, setCashierName] = useState<string>(
    () => activeShift?.cashierName || readLockScreenCashierName()
  );
  const [backupDownloaded, setBackupDownloaded] = useState<boolean>(false);

  // Manager-PIN gate for large variances (threshold enforced in the adapter;
  // this UI only collects the PIN and forwards it).
  const [managerPinInput, setManagerPinInput] = useState('');
  const [managerPinError, setManagerPinError] = useState<string | null>(null);
  // If the adapter demands a PIN the modal didn't anticipate (its live totals
  // can lag the adapter's authoritative recompute), force the PIN block open
  // so the cashier is never stuck with an error and no input.
  const [forcePinGate, setForcePinGate] = useState(false);

  const [recountPinOpen, setRecountPinOpen] = useState(false);
  const [recountPinInput, setRecountPinInput] = useState('');
  const [recountPinError, setRecountPinError] = useState<string | null>(null);
  // Double-submit guard: closing twice fires two Z-reports and two close
  // writes — the button locks while the adapter call is in flight.
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Frozen close-ticket snapshot (B3 blank-page fix): captured BEFORE the
  // slice nulls the session/modal, then printed from a remounted print-only
  // view so the `z_report` channel always has a mounted target.
  const [zSnapshot, setZSnapshot] = useState<ZReportSnapshot | null>(null);

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
  const openedAt = activeShift?.openedAt || utcNowIso();

  const sessionTxns = useMemo(() => {
    return transactions.filter((t) => {
      return (
        t.status !== 'VOIDED' &&
        !t.isRefund &&
        (!openedAt || t.createdAt >= openedAt)
      );
    });
  }, [transactions, openedAt]);

  const sessionRefunds = useMemo(() => {
    return transactions.filter((t) => {
      return (
        t.status !== 'VOIDED' &&
        t.isRefund &&
        (!openedAt || t.createdAt >= openedAt)
      );
    });
  }, [transactions, openedAt]);

  const totalCashRefunds = useMemo(() => {
    return sessionRefunds.reduce((sum, t) => {
      return (t.refundMethod === 'Espèces' || t.paymentMethod === 'Espèces') ? sum + t.total : sum;
    }, 0);
  }, [sessionRefunds]);

  const totalCashSales = useMemo(() => {
    return sessionTxns.reduce((sum, t) => {
      if (t.tenders && Array.isArray(t.tenders) && t.tenders.length > 0) {
        const cashTenderTotal = t.tenders
          .filter((tender) => tender.method === 'Espèces')
          .reduce((acc, tender) => acc + tender.amount, 0);
        const netCash = Math.max(0, cashTenderTotal - (t.changeDue || 0));
        return sum + netCash;
      }
      return t.paymentMethod === 'Espèces' ? sum + Math.max(0, t.total) : sum;
    }, 0);
  }, [sessionTxns]);

  const { allocCogsBySaleId } = useAllocationCogs();

  const totalSaleMargins = useMemo(() => {
    // Same unified rule as computeSalesMetrics (receiptMath): exchanges use
    // the signed row cost first (ledger only freezes sale legs), pure sales
    // use the frozen allocation sum, legacy rows keep stored profit. Order
    // matters — mirror it exactly so preview, KPIs, exports and the booked
    // close can never disagree on basis choice.
    return sessionTxns.reduce((sum, t) => {
      if (isExchangeSaleTx(t)) {
        const row = Number(t.costTotal);
        if (Number.isFinite(row)) return sum + (Number(t.total ?? 0) - Math.round(row));
      }
      const raw = allocCogsBySaleId[t.id];
      const alloc = Number(raw);
      if (Number.isFinite(alloc) && alloc >= 0) {
        return sum + (Number(t.total ?? 0) - Math.round(alloc));
      }
      return sum + (t.profit || 0);
    }, 0);
  }, [sessionTxns, allocCogsBySaleId]);

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

  // Phase 3: mobile Z must not drop trade-in legs (audit §5c gap) — same
  // shift-window rule as ShiftZReportModal (source table) + soulte cash
  // payouts (movement lane, SOULTE_CASHOUT tag).
  const tradeInCashOut = useMemo(() => {
    const st = usePosStore.getState();
    return (st.tradeIns || [])
      .filter((t) => !t.creditToWallet && (!openedAt || (t.createdAt || '') >= openedAt))
      .reduce((sum, t) => sum + (t.buybackValue || 0), 0);
  }, [openedAt]);
  const soulteCashOut = useMemo(() => {
    return (activeShift?.movements || [])
      .filter(
        (m) =>
          m.type === 'EXPENSE' &&
          (m.reason || '').startsWith(DRAWER_REASON_PREFIXES.SOULTE_CASHOUT)
      )
      .reduce((sum, m) => sum + m.amount, 0);
  }, [activeShift?.movements]);

  // Formula: opening_float + cash_sales + manual_deposits - expenses - cash_refunds
  const expectedCash = openingFloat + totalCashSales + manualDeposits - expenses - totalCashRefunds;
  const variance = physicalCount - expectedCash;
  const dailyNetProfit = totalSaleMargins - expenses;

  // Portaled recount-PIN popover: the trigger lives in a footer nested inside
  // an overflow-hidden modal shell, so an absolutely-positioned child would be
  // clipped. The popover is portaled to document.body with position:fixed,
  // anchored to its trigger button with auto flip-up when near the bottom
  // edge, viewport clamped, dismissed on outside click / Escape / scroll /
  // resize.
  const recountAnchorRef = useRef<HTMLButtonElement>(null);
  const recountMenuRef = useRef<HTMLDivElement>(null);
  const [recountPos, setRecountPos] = useState({ top: 0, left: 0, openUp: false });
  useEffect(() => {
    if (!recountPinOpen) return;
    const MENU_W = 288; // w-72
    const MENU_H_EST = 260;
    const place = () => {
      const r = recountAnchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < MENU_H_EST + 16;
      const top = openUp
        ? Math.max(8, r.top - MENU_H_EST - 8)
        : Math.min(r.bottom + 8, window.innerHeight - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 8));
      setRecountPos({ top, left, openUp });
    };
    place();
    const handleClickOutside = (event: MouseEvent) => {
      const t = event.target as Node;
      const anchor = recountAnchorRef.current;
      if (
        recountMenuRef.current && !recountMenuRef.current.contains(t) &&
        anchor && !anchor.contains(t)
      ) {
        setRecountPinOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setRecountPinOpen(false);
        recountAnchorRef.current?.focus();
      }
    };
    const handleDismiss = () => setRecountPinOpen(false);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', handleDismiss);
    // Capture phase: any inner scroll (modal body) invalidates the anchor.
    window.addEventListener('scroll', handleDismiss, true);
    recountMenuRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', handleDismiss);
      window.removeEventListener('scroll', handleDismiss, true);
    };
  }, [recountPinOpen]);

  useEffect(() => { if (activeModal !== 'shift_close') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  // Reopen-print effect: once the frozen snapshot is armed, the print-only
  // view below is mounted — print first, then dismiss (channel cleanup rides
  // printCoordinator's afterprint + fallback timers).
  useEffect(() => {
    if (!zSnapshot || activeModal !== 'shift_close') return;
    const t1 = setTimeout(() => {
      printCoordinator.printChannelDirect('z_report', 120);
    }, 250);
    const t2 = setTimeout(() => {
      setZSnapshot(null);
      setIsSubmitting(false);
      closeModal();
    }, 1600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [zSnapshot, activeModal, closeModal]);

  // Print-only view: mounted (via reopen below) with the frozen snapshot so
  // the desktop Z print can never fire on an empty target (blank page).
  if (zSnapshot) {
    return (
      <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
        <div className="flex flex-col items-center gap-3">
          <div className="bg-slate-950 p-6 flex justify-center max-h-[70vh] overflow-y-auto">
            <ZReportPaper snapshot={zSnapshot} />
          </div>
          <p className="text-[11px] text-emerald-400 font-bold">Impression du rapport Z…</p>
        </div>
      </div>
    );
  }

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
      const jsonString = await maintenanceService.generateSessionBackupJson(activeShift.id);
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
    if (isSubmitting) return;
    // Variance Enforcement Guard: If variance !== 0, mandatory explanatory note is required!
    if (variance !== 0 && !closingNote.trim()) {
      showToast(
        "Écart de caisse détecté ! Une note justificative explicative est obligatoire pour clôturer la session.",
        'error'
      );
      return;
    }

    // Large-variance gate: |discrepancy| >= threshold requires a manager PIN,
    // verified inside the adapter (same verifyPin helper as price overrides).
    // forcePinGate covers the stale-totals case where the adapter (source of
    // truth) demands a PIN the modal's live variance didn't anticipate.
    const needsManagerPin = forcePinGate || Math.abs(variance) >= SHIFT_VARIANCE_MANAGER_PIN_THRESHOLD;
    if (needsManagerPin && !managerPinInput.trim()) {
      setManagerPinError(
        `Écart de ${formatDZD(variance)} (seuil ${formatDZD(SHIFT_VARIANCE_MANAGER_PIN_THRESHOLD)}) : saisissez le code PIN Manager.`
      );
      showToast('Écart important : code PIN Manager obligatoire pour clôturer.', 'error');
      return;
    }

    setIsSubmitting(true);
    // B3 blank-page fix: freeze the Z identity BEFORE the slice nulls the
    // session + modal on success (zNumber, opener, counted, closed-at).
    const shiftBefore = activeShift;
    const preClosedCount = (usePosStore.getState().allShifts || []).filter(
      (s) => s.status === 'CLOSED'
    ).length;
    const closedAtISO = utcNowIso();
    try {
      const closeShiftResult = await (closeShift as CloseShiftWithPin)(
        physicalCount,
        closingNote.trim() || undefined,
        cashierName.trim() || undefined,
        needsManagerPin ? managerPinInput.trim() : undefined
      );

      if (closeShiftResult.success) {
        if (needsManagerPin) {
          logSecurityAction(
            'Clôture à Écart Validée (Manager)',
            `Écart de ${variance} DA validé par code PIN Manager • Session: ${activeShift?.id || 'Active'}`,
            'Manager',
            true
          );
        }
        // Print official Z-Report (native text sheet on mobile).
        if (isMobileDevice()) {
          const st = usePosStore.getState();
          const { openNativePrint } = await import('../../utils/phoneUtils');
          const { zReportText } = await import('../../utils/mobileDocPrint');
          const drops = (st.cashDrops || []).reduce((s, d) => s + (d.amount || 0), 0);
          const payouts = (st.payouts || []).reduce((s, p) => s + (p.amount || 0), 0);
          const debtSettlements = (st.customerDebts || [])
            .filter((d) => d.type === 'PAYMENT_SETTLED' && d.paymentMethod === 'Espèces')
            .reduce((s, d) => s + (d.amount || 0), 0);
          const cashExpenses = (st.storeExpenses || [])
            .filter((e) => e.paymentMethod === 'Espèces')
            .reduce((s, e) => s + (e.amount || 0), 0);
          const ok = await openNativePrint(
            `Rapport Z ${cashierName.trim() || 'Caisse'}`,
            zReportText({
              storeName: st.receiptSettings?.storeName,
              cashierName: cashierName.trim() || 'Caissier',
              dateStr: new Date().toLocaleString('fr-DZ'),
              openingFloat,
              cashSales: totalCashSales,
              debtSettlements,
              refunds: totalCashRefunds,
              expenses: cashExpenses,
              tradeIns: tradeInCashOut,
              soulteOut: soulteCashOut,
              drops,
              payouts,
              expectedCash,
              countedCash: physicalCount,
              variance,
            })
          );
          showToast(
            ok ? 'Session caisse clôturée avec succès. Rapport Z envoyé à l’impression.' : 'Session clôturée. Impression indisponible sur cet appareil.',
            ok ? 'success' : 'warning'
          );
        } else {
          // Desktop: arm the frozen snapshot and remount in print-only mode
          // BEFORE firing the channel — the target is therefore mounted when
          // window.print runs (never a blank page). Dismissal rides the
          // reopen-print effect above, not an immediate closeModal().
          const st = usePosStore.getState();
          setZSnapshot(
            buildZSnapshot({
              settings: st.receiptSettings,
              shift: shiftBefore,
              shiftFloat: st.shiftFloat ?? openingFloat,
              transactions: st.transactions,
              customerDebts: st.customerDebts ?? [],
              storeExpenses: st.storeExpenses ?? [],
              repairOrders: st.repairOrders ?? [],
              tradeIns: st.tradeIns ?? [],
              cashDrops: st.cashDrops ?? [],
              payouts: st.payouts ?? [],
              countedCash: physicalCount,
              closedAtISO,
              closedShiftCount: preClosedCount,
              fallbackCashier: cashierName.trim() || readLockScreenCashierName(),
            })
          );
          showToast('Session caisse clôturée avec succès. Rapport Z imprimé.', 'success');
          openModal('shift_close');
          return;
        }
        closeModal();
      } else {
        if (closeShiftResult.reason === 'MANAGER_PIN_REQUIRED' || closeShiftResult.reason === 'MANAGER_PIN_INVALID') {
          setForcePinGate(true);
          setManagerPinError(closeErrorMessage(closeShiftResult.reason));
        }
        showToast(closeErrorMessage(closeShiftResult.reason), 'error');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAuthorizeRecount = async () => {
    if (!recountPinInput.trim()) {
      setRecountPinError('Veuillez saisir le code PIN.');
      return;
    }
    // Phase 1: native gate (fail-closed); Locked shows the countdown.
    const gate = await verifyManagerGate(recountPinInput.trim());
    if (!gate.ok) {
      setRecountPinError(
        gate.locked
          ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
          : 'Code PIN Manager incorrect.'
      );
      showToast('PIN Manager incorrect — Recomptage refusé.', 'error');
      return;
    }

    logSecurityAction(
      'Dérogation Recomptage Clôture',
      `Recomptage autorisé par le Manager après affichage de l'écart (${variance} DA)`,
      'Manager',
      true
    );
    setStep('BLIND_COUNT');
    setRecountPinOpen(false);
    setRecountPinInput('');
    setRecountPinError(null);
    showToast('Autorisation Manager confirmée : recomptage autorisé.', 'info');
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-2xl sm:rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:fade-in sm:zoom-in-95 max-h-[94dvh] sm:max-h-[92dvh] flex flex-col">
        {/* Mobile drag handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2">
          <div className="flex items-center gap-2 text-emerald-400 min-w-0">
            <ShieldCheck className="w-5 h-5 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-xs sm:text-sm font-bold text-pos-text truncate">
                Clôture de Caisse & Audit de Réconciliation
              </h2>
              <p className="text-[10px] sm:text-[11px] text-pos-muted truncate">
                Comptage à l'aveugle, audit des écarts et Rapport Z
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto overscroll-contain space-y-4 flex-1">
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
                  <MoneyInput
                    label="Total Espèces Comptées Physiquement (DA)"
                    valueMinor={dinarsToMinor(directPhysicalCount || 0)}
                    onChangeMinor={(minor) => setDirectPhysicalCount(toLegacyReal(minor))}
                    placeholder="Ex: 48 500 DA"
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-4 py-3 text-xl font-mono font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
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
                      <MoneyInput
                        label="Pièces Div."
                        valueMinor={dinarsToMinor(denominations.coins || 0)}
                        onChangeMinor={(minor) =>
                          setDenominations((prev) => ({ ...prev, coins: toLegacyReal(minor) }))
                        }
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
                      placeholder="Nom du caissier…"
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

              {/* Manager-PIN gate for large variances (adapter-enforced) */}
              {(forcePinGate || Math.abs(variance) >= SHIFT_VARIANCE_MANAGER_PIN_THRESHOLD) && (
                <div className="bg-amber-500/10 border border-amber-500/40 p-4 rounded-xl space-y-2">
                  <div className="flex items-center gap-2 text-amber-400">
                    <Lock className="w-4 h-4" />
                    <span className="text-xs font-bold">
                      Validation Manager Requise — Écart ≥ {formatDZD(SHIFT_VARIANCE_MANAGER_PIN_THRESHOLD)}
                    </span>
                  </div>
                  <p className="text-[11px] text-amber-200">
                    L'écart de <strong>{formatDZD(variance)}</strong> dépasse le seuil autorisé.
                    Saisissez le code PIN Manager pour autoriser la clôture (vérifié côté base, comme pour les remises).
                  </p>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="current-password"
                    value={managerPinInput}
                    onChange={(e) => {
                      setManagerPinInput(e.target.value);
                      setManagerPinError(null);
                    }}
                    placeholder="Code PIN Manager"
                    className="w-full bg-pos-bg border border-amber-500/50 rounded-lg px-3 py-2 text-xs text-pos-text font-mono focus:border-amber-400 focus:outline-none"
                  />
                  {managerPinError && (
                    <p className="text-[10px] text-red-400 font-bold">{managerPinError}</p>
                  )}
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
        <div className="p-3.5 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 shrink-0">
          {step === 'BLIND_COUNT' ? (
            <>
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
                  onClick={async () => {
                    const success = await printXReport();
                    if (success) {
                      showToast('Rapport X (Mid-Shift) envoyé à l\'imprimante', 'success');
                    } else {
                      showToast("Impossible d'imprimer le Rapport X (aucune session active ou imprimante déconnectée)", 'error');
                    }
                  }}
                  className="flex-1 sm:flex-none min-h-[42px] px-3.5 py-2 rounded-xl border border-pos-border hover:bg-pos-hover text-xs font-bold text-pos-text flex items-center justify-center gap-1.5 transition cursor-pointer active:scale-95"
                  title="Imprimer un snapshot financier intermédiaire sans clôturer la caisse"
                >
                  <Printer className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Rapport X</span>
                </button>
              </div>
              <button
                type="button"
                onClick={handleRevealReconciliation}
                className="w-full sm:w-auto min-h-[44px] px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/20 transition active:scale-[0.98] cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Valider le Comptage & Voir l'Audit</span>
              </button>
            </>
          ) : (
            <>
              <div>
                <button
                  ref={recountAnchorRef}
                  type="button"
                  onClick={() => setRecountPinOpen(true)}
                  aria-expanded={recountPinOpen}
                  className="min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-bold text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 transition cursor-pointer flex items-center gap-1.5"
                  title="Recompter la caisse (Exige le code PIN Manager)"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>← Recompter (PIN Requis)</span>
                </button>

                {recountPinOpen && createPortal(
                  <>
                    <div
                      className="fixed inset-0"
                      style={{ zIndex: 9998 }}
                      onClick={() => setRecountPinOpen(false)}
                      aria-hidden="true"
                    />
                    <div
                      ref={recountMenuRef}
                      role="dialog"
                      aria-label="Autorisation Manager Requise"
                      style={{ position: 'fixed', top: recountPos.top, left: recountPos.left, zIndex: 9999 }}
                      data-open-up={recountPos.openUp ? 'true' : 'false'}
                      className="p-3 bg-pos-panel border border-amber-500/50 rounded-xl shadow-2xl w-72 space-y-2 animate-in fade-in"
                    >
                    <div className="flex items-center justify-between text-xs font-bold text-amber-400">
                      <span>Autorisation Manager Requise</span>
                      <button
                        type="button"
                        onClick={() => {
                          setRecountPinOpen(false);
                          setRecountPinInput('');
                          setRecountPinError(null);
                        }}
                        className="text-pos-muted hover:text-pos-text"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <p className="text-[10px] text-pos-muted">
                      La caisse a déjà été comptée à l'aveugle. Saisissez le code PIN Manager pour autoriser un nouveau comptage.
                    </p>
                    <input
                      type="password"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="current-password"
                      autoFocus
                      value={recountPinInput}
                      onChange={(e) => {
                        setRecountPinInput(e.target.value);
                        setRecountPinError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAuthorizeRecount();
                        }
                      }}
                      placeholder="Code PIN Manager"
                      className="w-full bg-pos-card border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-mono focus:outline-none focus:border-amber-400"
                    />
                    {recountPinError && (
                      <p className="text-[10px] text-red-400 font-bold">{recountPinError}</p>
                    )}
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={handleAuthorizeRecount}
                        className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-lg transition cursor-pointer"
                      >
                        Déverrouiller
                      </button>
                    </div>
                    </div>
                  </>,
                  document.body,
                )}
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
                  onClick={handleFinalizeClosure}
                  disabled={isSubmitting || (variance !== 0 && !closingNote.trim())}
                  className={`flex-2 sm:flex-none min-h-[44px] px-5 py-2.5 rounded-xl font-black text-xs flex items-center justify-center gap-1.5 shadow-lg transition active:scale-[0.98] cursor-pointer ${
                    isSubmitting || (variance !== 0 && !closingNote.trim())
                      ? 'bg-slate-700 text-slate-400 cursor-not-allowed opacity-60'
                      : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20'
                  }`}
                >
                  <Printer className="w-4 h-4" />
                  <span>Clôturer Caisse & Imprimer Rapport Z</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

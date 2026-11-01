import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createSubmitGuard, pinAuthorisesTicket } from '../../utils/refundGuards';
import { beginRefundFlight, endRefundFlight } from '../../utils/refundFlight';
import { refundDiag } from '../../utils/refundDiag';
import { refundRefusalMessage } from '../../i18n/refundMessages';

import { foldForSearch } from '../../utils/catalogSearch';
import {
  X,
  RotateCcw,
  Search,
  CheckCircle2,
  AlertTriangle,
  Receipt,
  Wallet,
  Coins,
  ShieldCheck,
  PackageCheck,
  PackageX,
  Key,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import { sortTransactionsNewestFirst } from '../../utils/dateUtils';
import type { SaleTransaction, PaymentMethodType, RefundItem } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { computeRefundFundingSplit, refundLaneTotalsOf } from '../../utils/receiptMath';
import type { RefundLaneTotals } from '../../utils/receiptMath';
import { refundableValueOf } from '../../utils/receiptMath';
import { clampCashRefund, physicalCashTendered, cashDisbursedOf } from '../../utils/cashTerms';
import { isOwnShiftTicket } from '../../sync/refundLockPolicy';
import { verifyManagerGate } from '../../utils/pinGate';
import { Kbd } from '../../design-system/desktop/Kbd';

/**
 * Per-line refundable remainder for a ticket, keyed `${productId}_${lineIdx}`
 * (the modal's itemKey format). Consumption is read from every refund row of
 * the ticket via `saleItemId` (`${txnId}-item-${idx}`) so partial refunds of
 * a same-SKU sibling line never mask the other line; legacy identity-less
 * rows fall back to consuming their product's lines FIFO (conservative —
 * can only under-offer, never over-refund).
 */
function computeRefundableRemaining(
  txn: SaleTransaction,
  transactions: SaleTransaction[] | undefined
): Map<string, number> {
  const refundedByLine = new Map<string, number>();
  const legacyByProduct = new Map<string, number>();
  for (const t of transactions || []) {
    if (!t.isRefund || t.originalTransactionId !== txn.id) continue;
    for (const ri of t.refundedItems || []) {
      if (ri.saleItemId) {
        refundedByLine.set(ri.saleItemId, (refundedByLine.get(ri.saleItemId) || 0) + ri.quantity);
      } else {
        legacyByProduct.set(ri.productId, (legacyByProduct.get(ri.productId) || 0) + ri.quantity);
      }
    }
  }
  const remainingByKey = new Map<string, number>();
  txn.items.forEach((item, idx) => {
    const itemKey = `${item.product.id}_${idx}`;
    const sid = `${txn.id}-item-${idx}`;
    remainingByKey.set(itemKey, Math.max(0, item.quantity - (refundedByLine.get(sid) || 0)));
  });
  for (const [productId, legacyQty] of legacyByProduct) {
    let left = legacyQty;
    txn.items.forEach((item, idx) => {
      if (left <= 0 || item.product.id !== productId) return;
      const itemKey = `${item.product.id}_${idx}`;
      const cur = remainingByKey.get(itemKey) || 0;
      const take = Math.min(cur, left);
      remainingByKey.set(itemKey, cur - take);
      left -= take;
    });
  }
  return remainingByKey;
}

export const RefundModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    transactions,
    selectedTransactionForRefund,
    setSelectedTransactionForRefund,
    processRefund,
    activeShift,
    activeCashier,
    // Phase 1: manager checks route through the native gate (no local
    // verifyManagerPin reads here — see utils/pinGate).
  } = usePosStore();

  const { showToast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTxn, setSelectedTxn] = useState<SaleTransaction | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<Record<string, boolean>>({});
  const [refundQuantities, setRefundQuantities] = useState<Record<string, number>>({});
  const [restockMap, setRestockMap] = useState<Record<string, boolean>>({});
  const [refundMethod, setRefundMethod] = useState<PaymentMethodType>('Espèces');
  const [refundReason, setRefundReason] = useState('Erreur de choix client / Échange');
  const [customReason, setCustomReason] = useState('');
  const [managerPin, setManagerPin] = useState('');
  const [pinRequired, setPinRequired] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // REF-87: synchronous re-entrancy guard. A slow mega-refund keeps the button
  // clickable long enough for a second click in the same tick; two processRefund
  // calls make the second one fail as ALREADY_REFUNDED (correctly deduped) but
  // leave a misleading refusal on screen and block the next legitimate chunk.
  useEffect(() => {
    refundDiag('mount');
    return () => refundDiag('unmount');
  }, []);

  // Who closes the modal? A stack at the transition names the caller (E-0114:
  // the dialog was torn down 27 ms after the cap switch on a huge ticket).
  useEffect(() => {
    const store = usePosStore as unknown as {
      subscribe?: (fn: (s: { activeModal?: string }, p: { activeModal?: string }) => void) => () => void;
    };
    const unsubscribe = store.subscribe?.((state, prev) => {
      if (prev?.activeModal === 'refund' && state?.activeModal !== 'refund') {
        refundDiag('modal:closed', {
          to: String(state?.activeModal ?? 'null'),
          stack: (new Error().stack ?? '').split('\n').slice(1, 5).join(' | '),
        });
      }
    });
    return () => unsubscribe?.();
  }, []);

  const submitGuardRef = useRef(createSubmitGuard());
  // REF-87: the PIN is bound to the ticket it was typed for; a PIN typed for
  // another ticket (or for an earlier refund) never authorises this one.
  const [managerPinTicket, setManagerPinTicket] = useState<string | null>(null);

  // Fix 3 (UI hint — the slice + adapter enforce): offline status and device
  // identity, loaded when the modal opens. Remote/past-shift tickets show a
  // lock badge and cannot be selected while offline.
  const [onlineNow, setOnlineNow] = useState<boolean | null>(null);
  const [deviceIdNow, setDeviceIdNow] = useState('');
  // Offline containment policy knobs (Module B/C hints — enforcement is
  // native; these only drive messaging, with the same defaults).
  const [offlinePinThreshold, setOfflinePinThreshold] = useState(5_000);
  useEffect(() => {
    if (activeModal !== 'refund') return;
    let alive = true;
    const updateNet = () => {
      try {
        setOnlineNow(typeof navigator !== 'undefined' ? navigator.onLine : true);
      } catch {
        /* ignore */
      }
    };
    updateNet();
    window.addEventListener('online', updateNet);
    window.addEventListener('offline', updateNet);
    (async () => {
      try {
        const { probeOnline } = await import('../../sync/tursoClient');
        const ok = await probeOnline(2500).catch(() => false);
        if (alive) setOnlineNow(ok);
      } catch {
        if (alive) setOnlineNow(true);
      }
      try {
        const { getStableDeviceId } = await import('../../sync/device');
        const id = await getStableDeviceId().catch(() => '');
        if (alive) setDeviceIdNow(id);
      } catch {
        /* unknown device locks everything offline (fail-closed) */
      }
      try {
        const { readOfflinePolicy } = await import('../../db/adapters/refundNative');
        const t = await readOfflinePolicy('policy.offline_pin_threshold').catch(() => 5_000);
        if (alive) setOfflinePinThreshold(t);
      } catch {
        /* policy read unavailable — default hint stands, native enforces */
      }
    })();
    return () => {
      alive = false;
      window.removeEventListener('online', updateNet);
      window.removeEventListener('offline', updateNet);
    };
  }, [activeModal]);

  // Debounced search: instant input, filtered scan 200ms after last keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Progressive data windowing: the panel renders the newest
  // REFUND_PAGE_SIZE tickets first instead of truncating the list at a
  // fixed slice (which previously severed the latest receipts past 30).
  const REFUND_PAGE_SIZE = 30;
  const [visibleCount, setVisibleCount] = useState(REFUND_PAGE_SIZE);

  // Memoized on debounced input so fast typing does not rescan per keystroke.
  // Hooks must stay above the early return below.
  // Newest-first (canonical comparator — defensive: the store is sorted at
  // every writer, but the panel must never depend on producer order).
  // Zero-value guard (Fix 1): tickets with no remaining refundable value
  // (0 DA comps, unclaimable trade-ins, fully-exhausted tickets) never reach
  // the list. Same money-truth basis as the slice/adapter submit gates
  // (refundableValueOf) — the list can never offer what submit refuses.
  const eligibleTransactionsMemo = useMemo(
    () =>
      sortTransactionsNewestFirst(
        (transactions || []).filter(
          (t) =>
            t.status !== 'VOIDED' &&
            t.status !== 'REFUNDED' &&
            !t.isRefund &&
            refundableValueOf(t, transactions) > 0
        )
      ),
    [transactions]
  );
  const filteredTransactionsMemo = useMemo(() => {
    const q = foldForSearch(debouncedSearch.trim());
    if (!q) return eligibleTransactionsMemo;
    return eligibleTransactionsMemo.filter((t) => {
      return (
        foldForSearch(t.receiptNumber).includes(q) ||
        (t.customer?.name ? foldForSearch(t.customer.name).includes(q) : false) ||
        (t.customer?.phone ? (t.customer.phone.includes(debouncedSearch.trim()) || foldForSearch(t.customer.phone).includes(q)) : false) ||
        (t.items || []).some(
          (i) => foldForSearch(i.product?.title).includes(q) || foldForSearch(i.product?.sku).includes(q)
        )
      );
    });
  }, [eligibleTransactionsMemo, debouncedSearch]);

  // UPGRADE-01 safety rail: a typed receipt/id that found nothing in the RAM
  // window resolves through SQLite (idx_transactions_receipt / PK) and is
  // offered like any windowed ticket — subject to the same eligibility gates.
  const [manualTxnHits, setManualTxnHits] = useState<SaleTransaction[]>([]);
  useEffect(() => {
    if (activeModal !== 'refund' || debouncedSearch.trim().length < 8) {
      setManualTxnHits([]);
      return;
    }
    if (filteredTransactionsMemo.length > 0) {
      setManualTxnHits([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const { sqliteAdapter } = await import('../../db/sqliteAdapter');
        const q = debouncedSearch.trim();
        // D5-A: projection read, never the full payload (139 MB on a 4e9 ticket)
        const hit =
          (await sqliteAdapter.getRefundCandidateByReceipt(q)) ??
          (await sqliteAdapter.getTransactionByReceipt(q)) ??
          (await sqliteAdapter.getTransactionById(q));
        if (!alive) return;
        const eligible = Boolean(
          hit &&
            hit.status !== 'VOIDED' &&
            hit.status !== 'REFUNDED' &&
            !hit.isRefund &&
            refundableValueOf(hit, transactions) > 0
        );
        setManualTxnHits(eligible && hit ? [hit] : []);
      } catch (lookupErr) {
        console.warn('[refund] direct receipt search failed:', lookupErr);
        if (alive) setManualTxnHits([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeModal, debouncedSearch, filteredTransactionsMemo.length, transactions]);

  // The ticket the modal last initialised. A sync-driven re-init of the SAME
  // ticket must not wipe the PIN the operator is about to revalidate with.
  const lastInitTxnRef = useRef<string | null>(null);
  const initializeRefundState = useCallback((txn: SaleTransaction) => {
    // REF-87: a manager PIN belongs to the ticket it was typed for. Selecting a
    // DIFFERENT ticket (or reopening the modal) starts with an empty PIN, or a
    // PIN typed for an earlier refund silently authorises this one.
    const sameTicket = lastInitTxnRef.current === txn.id;
    lastInitTxnRef.current = txn.id;
    refundDiag('init', { txn: txn.id, sameTicket });
    if (!sameTicket) {
      setManagerPin('');
      setManagerPinTicket(null);
      setPinRequired(false);
    }
    const initialSelected: Record<string, boolean> = {};
    const initialQty: Record<string, number> = {};
    const initialRestock: Record<string, boolean> = {};

    // Quantities must be bounded by what is STILL refundable — PER ORIGINAL
    // LINE (see computeRefundableRemaining): refunding IMEI-A1 of a
    // dual-IMEI SKU no longer masks the A2 line, and one line can never
    // exceed its purchased quantity across partials.
    const remainingByKey = computeRefundableRemaining(txn, transactions);
    txn.items.forEach((item, idx) => {
      const itemKey = `${item.product.id}_${idx}`;
      const remaining = remainingByKey.get(itemKey) || 0;
      initialSelected[itemKey] = remaining > 0;
      initialQty[itemKey] = remaining;
      initialRestock[itemKey] = true;
    });

    setSelectedItemIds(initialSelected);
    setRefundQuantities(initialQty);
    setRestockMap(initialRestock);
  }, [transactions]);

  // Sync with selectedTransactionForRefund when opening from ReportsModal
  const [prevRefundSyncKey, setPrevRefundSyncKey] = useState<string | null>(null);
  const refundSyncKey = activeModal === 'refund' ? `${activeModal}_${selectedTransactionForRefund?.id ?? 'none'}` : null;
  if (refundSyncKey !== prevRefundSyncKey) {
    setPrevRefundSyncKey(refundSyncKey);
    if (activeModal === 'refund') {
      if (selectedTransactionForRefund) {
        setSelectedTxn(selectedTransactionForRefund);
        initializeRefundState(selectedTransactionForRefund);
      } else {
        refundDiag('close', { reason: 'sync-cleared', key: String(refundSyncKey) });
        setSelectedTxn(null);
        setSelectedItemIds({});
        setRefundQuantities({});
        setRestockMap({});
      }
      setManagerPin('');
    setManagerPinTicket(null);
      setManagerPinTicket(null);
      setPinRequired(false);
      setVisibleCount(REFUND_PAGE_SIZE);
    }
  }

  useEffect(() => { if (activeModal !== 'refund') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  useEffect(() => {
    if (activeModal !== 'refund') return;

    const handleRefundBarcodeScanned = async (e: Event) => {
      const customEvent = e as CustomEvent<{ code: string }>;
      const code = customEvent.detail?.code?.trim();
      if (!code) return;

      let matchedTxn = (transactions || []).find(
        (t) =>
          t.id === code ||
          t.receiptNumber === code ||
          ((code.startsWith('REC-') || code.startsWith('TXN-') || code.startsWith('REF-')) &&
            (t.receiptNumber === code ||
              t.id === code ||
              t.receiptNumber?.includes(code) ||
              t.id.includes(code)))
      );

      // UPGRADE-01 safety rail: the RAM window holds the newest 200 tickets; a
      // receipt scan for anything older must still load straight from SQLite
      // (idx_transactions_receipt / PK) instead of falling through to
      // "not found".
      if (
        !matchedTxn &&
        (code.startsWith('REC-') ||
          code.startsWith('TXN-') ||
          code.startsWith('REF-') ||
          code.length >= 8)
      ) {
        try {
          const { sqliteAdapter } = await import('../../db/sqliteAdapter');
          matchedTxn =
            (await sqliteAdapter.getTransactionByReceipt(code)) ??
            (await sqliteAdapter.getTransactionById(code));
        } catch (lookupErr) {
          console.warn('[refund] direct receipt lookup failed:', lookupErr);
        }
      }

      if (matchedTxn) {
        setSelectedTxn(matchedTxn);
        setSelectedTransactionForRefund(matchedTxn);
        initializeRefundState(matchedTxn);
        showToast(`Ticket #${matchedTxn.receiptNumber || matchedTxn.id} identifié et chargé`, 'success');
      } else {
        setSearchQuery(code);
        showToast(`Recherche ticket / article : ${code}`, 'info');
      }
    };

    window.addEventListener('pos:refund-barcode-scanned', handleRefundBarcodeScanned);
    window.addEventListener('pos:barcode-scanned', handleRefundBarcodeScanned);
    return () => {
      window.removeEventListener('pos:refund-barcode-scanned', handleRefundBarcodeScanned);
      window.removeEventListener('pos:barcode-scanned', handleRefundBarcodeScanned);
    };
  }, [activeModal, transactions, setSelectedTransactionForRefund, showToast, initializeRefundState]);

  // Live per-line refundable remainder driving the steppers' max: the same
  // union the slice + native quota enforce, so the UI can never offer a
  // quantity the write path would refuse (dual-IMEI SKU included).
  const remainingByItemKey = useMemo(
    () =>
      selectedTxn ? computeRefundableRemaining(selectedTxn, transactions) : new Map<string, number>(),
    [selectedTxn, transactions]
  );

  if (activeModal !== 'refund') return null;

  // Eligible transactions (exclude already voided or fully refunded)

  const filteredTransactions =
    manualTxnHits.length > 0 && filteredTransactionsMemo.length === 0
      ? manualTxnHits
      : filteredTransactionsMemo;

  const handleSelectTransaction = (txn: SaleTransaction) => {
    setSelectedTxn(txn);
    setSelectedTransactionForRefund(txn);
    initializeRefundState(txn);
  };

  // Calculate refund items
  const activeRefundItems: RefundItem[] = selectedTxn
    ? (selectedTxn.items || [])
        .map((item, lineIdx) => {
          const itemKey = `${item.product.id}_${lineIdx}`;
          return { item, lineIdx, itemKey };
        })
        .filter(({ itemKey }) => selectedItemIds[itemKey])
        .map(({ item, lineIdx, itemKey }) => {
          const qty = Math.min(item.quantity, refundQuantities[itemKey] || item.quantity);
          const unitPrice = item.appliedPrice || item.product.price;
          // Apply proportion of line discount if any
          const discountPerUnit = item.discount > 0 && item.quantity > 0 ? item.discount / item.quantity : 0;
          const netUnitPrice = Math.max(0, unitPrice - discountPerUnit);
          const totalRefundAmount = netUnitPrice * qty;
          // Services carry no stock identity — never default them to restock
          // (the slice also refuses service restock; this just stops offering it).
          const pid = item.product?.id || '';
          const isServiceLine =
            pid.startsWith('qt-') ||
            pid.startsWith('prod-misc-') ||
            (item.product?.category as string) === 'Services';
          const restock = restockMap[itemKey] ?? !isServiceLine;

          return {
            productId: item.product.id,
            title: item.product.title,
            sku: item.product.sku,
            unitPrice: netUnitPrice,
            quantity: qty,
            totalRefundAmount,
            restock,
            imeiNumber: item.imeiNumber,
            // Transaction-linked batch restoration: pin the exact original
            // sale line so restitution restores historical batches per line.
            saleItemId: `${selectedTxn.id}-item-${lineIdx}`,
            condition: restock ? 'restock' : 'defective',
          } as RefundItem;
        })
    : [];

  const totalRefundAmount = activeRefundItems.reduce((acc, i) => acc + i.totalRefundAmount, 0);

  // Module A submit gate (defense in depth — the list already locks foreign
  // tickets, but selection can predate a network drop): offline, only the
  // originating terminal's tickets stay submittable.
  const submitForeignLocked =
    onlineNow === false &&
    selectedTxn != null &&
    (selectedTxn.deviceId || selectedTxn.device_id || '') !== deviceIdNow;


  // Funding preview (anti-arbitrage): the till only ever disburses the
  // cash-funded share — voucher/avoir/debt shares return to their origins.
  // Same helper as processRefund, so the preview can never disagree. Plain
  // computation (not a hook): this sits below the modal's early return.
  const fundingPreview = (() => {
    if (!selectedTxn || totalRefundAmount <= 0) return null;
    const priorRefunds = (transactions || []).filter(
      (t) => t.isRefund && t.originalTransactionId === selectedTxn.id
    );
    const priorRecovery = priorRefunds.reduce((acc, t) => acc + (Number(t.total) || 0), 0);
    // Same cumulative lanes as the slice (D3): the preview must show what the
    // commit writes, partial refund after partial refund.
    const priorLanes = priorRefunds.reduce<RefundLaneTotals>(
      (acc, t) => {
        const l = refundLaneTotalsOf(t as unknown as Record<string, unknown>);
        acc.cash += l.cash;
        acc.avoir += l.avoir;
        acc.voucher += l.voucher;
        acc.debt += l.debt;
        acc.digital += l.digital;
        acc.gross = (acc.gross ?? 0) + (l.gross ?? 0);
        if (l.basis === 'legacy') acc.basis = 'legacy';
        return acc;
      },
      { cash: 0, avoir: 0, voucher: 0, debt: 0, digital: 0, gross: 0, basis: 'explicit', anomalies: [] }
    );
    return computeRefundFundingSplit(selectedTxn, totalRefundAmount, priorRecovery, priorLanes);
  })();
  const previewCashOut = refundMethod === 'Espèces' ? fundingPreview?.cashShare ?? 0 : 0;

  // Fix 2 (UI mirror of the slice tender clamp): cumulative drawer cash out
  // can never exceed the net physical cash tendered on the ticket. Same
  // helpers as execution (cashTerms) — the preview can never promise what
  // the write path refuses. Store-only basis here; the slice unions Dexie.
  const previewClamp = (() => {
    if (!selectedTxn || !fundingPreview) return null;
    let prior = 0;
    for (const t of transactions || []) {
      if (t.isRefund && t.originalTransactionId === selectedTxn.id) prior += cashDisbursedOf(t);
    }
    return clampCashRefund({
      cashShare: fundingPreview.cashShare,
      cashTenderedNet: physicalCashTendered(selectedTxn),
      priorCashOut: prior,
    });
  })();
  // Module C hint: large offline cash carries a recorded supervisor
  // authorization (the mandatory manager PIN below is verified natively and
  // its timestamp rides the in-txn audit row).
  const offlineCashNeedsSupervisor =
    onlineNow === false && refundMethod === 'Espèces' && previewCashOut > offlinePinThreshold;

  const handleQuantityChange = (key: string, newQty: number, maxQty: number) => {
    const validQty = Math.max(1, Math.min(maxQty, newQty));
    setRefundQuantities((prev) => ({ ...prev, [key]: validQty }));
  };

  const handleToggleItem = (key: string) => {
    setSelectedItemIds((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleToggleRestock = (key: string) => {
    setRestockMap((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSubmitRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    refundDiag('submit:start', { txn: selectedTxn?.id ?? null, method: refundMethod });
    beginRefundFlight();
    if (!selectedTxn) {
      showToast('Veuillez d\'abord sélectionner un ticket de caisse.', 'warning');
      return;
    }

    // Fix 4: accounting-period gate (mirrors the slice + adapter gates).
    if (!activeShift || !activeShift.id) {
      showToast('Ouvrez la caisse avant tout remboursement (traçabilité de période).', 'error');
      return;
    }

    // Module A submit gate (defense in depth — the button is already
    // disabled, but selection can predate a network drop or devtools can
    // re-enable it; the native gate decides regardless).
    if (submitForeignLocked) {
      showToast('Offline Terminal Lock: Cross-terminal refunds require an active sync connection.', 'error');
      return;
    }

    if (activeRefundItems.length === 0) {
      showToast('Veuillez sélectionner au moins un article à rembourser.', 'warning');
      return;
    }

    if (totalRefundAmount <= 0) {
      showToast('Le montant total à rembourser doit être supérieur à 0 DA.', 'warning');
      return;
    }

    // Check Manager PIN — Phase 1: native gate (fail-closed).
    if (!managerPin || !pinAuthorisesTicket(managerPinTicket, selectedTxn?.id ?? null)) {
      setPinRequired(true);
      showToast('Code PIN Manager requis. Autorisation requise pour émettre un remboursement.', 'error');
      return;
    }
    const gate = await verifyManagerGate(managerPin);
    if (!gate.ok) {
      setPinRequired(true);
      showToast(
        gate.locked
          ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
          : 'Code PIN Manager incorrect. Autorisation requise pour émettre un remboursement.',
        'error'
      );
      return;
    }
    // Module C: supervisor authorization instant, captured immediately after
    // the native gate pass. Rides the refund request into the atomic commit,
    // where large offline cash requires it and records it in-txn.
    const supervisorPinVerifiedAt = new Date().toISOString();

    if (!submitGuardRef.current.tryEnter()) return; // second click in the same tick
    setIsSubmitting(true);
    try {
      const finalReason = refundReason === 'Autre' && customReason.trim() ? customReason.trim() : refundReason;
      // Rebut sans restock: a reason note is mandatory (also enforced slice-side).
      const needsNote = activeRefundItems.some((i) => !i.restock);
      // REF-36: "Autre" is a CATEGORY, not a motive. With the category selected and
      // the free-text empty there is no operator-authored note; the bare
      // placeholder must not satisfy the mandatory-note gate (the modal itself
      // promises "Précisez le motif exact..." for Autre).
      const authoredNote = refundReason === 'Autre' ? customReason.trim() : finalReason.trim();
      if (needsNote && !authoredNote) {
        showToast('Article(s) sans remise en stock : précisez un motif (note obligatoire).', 'error');
        setIsSubmitting(false);
        return;
      }
      // REF-65: a PURE CREDIT sale (its only funding lane is the debt) cannot be
      // paid out in cash — the native lane refuses it (INVALID: cash refund
      // without drawer movement, no cash was ever taken). Its value returns by
      // relieving the debt, which the funding split applies regardless of the
      // channel, so the request submits on the non-cash channel.
      // Deliberately NARROW: a card/voucher/avoir-funded ticket keeps the
      // cashier's channel (a forced switch there double-delivers — REF-42).
      const debtOnlyTicket =
        (fundingPreview?.debtShare ?? 0) > 0 &&
        (fundingPreview?.cashShare ?? 0) <= 0 &&
        (fundingPreview?.digitalShare ?? 0) <= 0 &&
        (fundingPreview?.voucherShare ?? 0) <= 0 &&
        (fundingPreview?.avoirShare ?? 0) <= 0;
      const effectiveRefundMethod =
        refundMethod === 'Espèces' && debtOnlyTicket ? 'Avoir Client' : refundMethod;
      const refundResult = (await processRefund({
        originalTransaction: selectedTxn,
        refundItems: activeRefundItems,
        refundMethod: effectiveRefundMethod,
        refundReason: finalReason,
        cashierName: activeCashier?.name || 'Caissier',
        supervisorPinVerifiedAt,
        supervisorUserId: activeCashier?.role === 'admin' ? activeCashier.id : 'manager',
      })) as unknown as { success: boolean; reason?: string; warnings?: string[]; refundTransaction?: { total?: number; cashDisbursed?: number } };
      refundDiag('submit:result', { ok: refundResult.success, reason: refundResult.reason ?? null });

      if (refundResult.success) {
        for (const w of refundResult.warnings ?? []) {
          showToast(w, 'warning', 5000);
        }
        const netDone = Math.round(Number(refundResult.refundTransaction?.total ?? totalRefundAmount));
        const cashDone = Math.round(Number(refundResult.refundTransaction?.cashDisbursed ?? 0));
        showToast(
          refundMethod === 'Espèces' && cashDone !== netDone
            ? `Remboursement net ${formatDZD(netDone)} validé — espèces décaissées : ${formatDZD(cashDone)} (le solde retourne à ses origines).`
            : `Remboursement de ${formatDZD(netDone)} validé avec succès (${effectiveRefundMethod}).`,
          'success'
        );
        refundDiag('close', { reason: 'success' });
        setSelectedTxn(null);
        setSelectedTransactionForRefund(null);
        // A committed refund consumes the supervisor authorisation: the next
        // refund must re-enter the PIN. A REFUSED one must NOT - hiding the gate
        // on failure made a retry (e.g. the offline cash-cap switch to Avoir)
        // impossible: the field was gone and no revalidation could be authorised.
        setManagerPin('');
        setManagerPinTicket(null);
        setPinRequired(false);
        } else if (refundResult.reason === 'CUSTOMER_UNAVAILABLE') {
          showToast(
            'Client archivé (profil supprimé) : aucun avoir ne peut être recrédité. Remboursez en espèces, ou réactivez le client avant de créditer son avoir.',
            'error',
          );
        } else if (refundResult.reason === 'REFUND_EXCEEDS_PURCHASED') {
          showToast('Quantité à rembourser supérieure à la quantité restante non remboursée.', 'error');
        } else if (refundResult.reason === 'RESTOCK_REASON_REQUIRED') {
          showToast('Sans remise en stock, un motif de rebut est obligatoire.', 'error');
        } else if (refundResult.reason === 'REFUND_ALREADY_IN_PROGRESS') {
          showToast('Ce remboursement est déjà en cours sur un autre appareil — synchronisez puis vérifiez avant de réessayer.', 'warning');
        } else if (refundResult.reason === 'ALREADY_REFUNDED') {
          showToast('Ce retour a déjà été remboursé (même onglet ou autre caisse) — aucun second versement effectué. Vérifiez le ticket d\u2019avoir.', 'warning');
        } else if (refundResult.reason === 'VOUCHER_RESTORE_FAILED') {
          showToast('Remboursement enregistré, mais le bon d\u2019avoir n\u2019a pas pu être recrédité (solde modifié entre-temps) — réémission manuelle requise.', 'warning');
        } else if (refundResult.reason === 'ZERO_REFUNDABLE') {
          showToast('Ticket sans solde remboursable (0 DA ou déjà intégralement retourné).', 'error');
        } else if (refundResult.reason === 'CASH_CAP_EXCEEDED') {
          showToast('Plafond espèces dépassé — le décaissement demandé excède les espèces encaissées sur ce ticket.', 'error');
        } else if (refundResult.reason === 'OFFLINE_REMOTE_TICKET') {
          showToast('Hors ligne : seuls les tickets de cette caisse et de la session en cours sont remboursables.', 'error');
        } else if (refundResult.reason === 'OFFLINE_FOREIGN_TICKET') {
          showToast('Offline Terminal Lock: Cross-terminal refunds require an active sync connection.', 'error');
        } else if (refundResult.reason === 'OFFLINE_CASH_CAP_EXCEEDED') {
          if (refundMethod === 'Espèces' && selectedTxn?.customer?.id) {
            // Fallback path (Module B): value that cannot leave the drawer
            // offline returns as a store credit for the customer on the ticket.
            refundDiag('switch', { to: 'Avoir Client' });
        setRefundMethod('Avoir Client');
            showToast('Plafond espèces hors-ligne atteint — méthode basculée en Avoir Client : vérifiez puis validez à nouveau.', 'warning', 6000);
          showToast(`[diag] refund method sent: ${effectiveRefundMethod}`, 'warning', 4000);
          } else if (refundMethod === 'Espèces') {
            // P0 (owner ruling): no customer -> an Avoir would credit nobody.
            // Terminal refusal, NOT a method switch (no switch loop).
            showToast(refundRefusalMessage('avoirRecipientOffline'), 'error', 8000);
          } else {
            showToast('Plafond espèces hors-ligne atteint — resynchronisez avant tout nouveau décaissement.', 'error');
          }
        } else if (refundResult.reason === 'CARD_REFUND_LANE_UNAVAILABLE') {
          showToast(
            'Ticket paye par carte/cheque : aucun remboursement en especes possible. Remboursez en Avoir Client (le montant est credite au client).',
            'error',
            8000,
          );
        } else if (refundResult.reason === 'REFUND_EXCEEDS_VALUE') {
          showToast('Montant du remboursement supérieur à ce qui reste remboursable sur ce ticket.', 'error');
        } else if (refundResult.reason === 'AVOIR_RECIPIENT_REQUIRED') {
          // P0 (owner ruling): fail closed, terminal, no switch loop.
          showToast(refundRefusalMessage('avoirRecipientRequired'), 'error', 8000);
        } else if (refundResult.reason === 'SUPERVISOR_PIN_REQUIRED') {
          showToast('Remboursement espèces hors-ligne élevé : autorisation superviseur requise et non reconnue — ressaisissez le PIN Manager.', 'error');
        } else if (refundResult.reason === 'SUPERVISOR_AUTH_EXPIRED') {
          showToast('Autorisation superviseur expirée (plus de 2 minutes) — ressaisissez le PIN Manager et validez à nouveau.', 'error');
        } else if (refundResult.reason === 'SYSTEM_CLOCK_REGRESSION') {
          showToast('Horloge appareil incohérente — vérification requise avant tout remboursement.', 'error');
        } else if (refundResult.reason === 'DEVICE_IDENTITY_SPOOFED') {
          showToast('Identité terminal refusée par le noyau — redémarrez l’application et resynchronisez.', 'error');
        } else if (refundResult.reason === 'NO_OPEN_SHIFT') {
          showToast('Ouvrez la caisse avant tout remboursement (traçabilité de période).', 'error');
      } else {
        // Include the native detail: a generic reason hides the cause in the
        // field log (REF-87 surfaced only PERSISTENCE_FAILED for hours).
        const refundDetail = String((refundResult as { detail?: unknown }).detail ?? '').trim();
        showToast(
          `Erreur lors du remboursement: ${refundResult.reason}${refundDetail ? ` :: ${refundDetail.slice(0, 180)}` : ''}`,
          'error'
        );
      }
    } catch (err) {
      console.error('Refund submission error:', err);
      showToast('Une erreur est survenue lors de l\'enregistrement du remboursement.', 'error');
    } finally {
      endRefundFlight();
      submitGuardRef.current.leave();
      // PIN state is cleared ONLY on success (above). A failure keeps the gate
      // open so the operator can correct the request and resubmit - the PIN is
      // consumed by the committed refund, not by an attempt.
      setIsSubmitting(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Retours marchandise et avoirs" data-testid="refund-dialog" className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:zoom-in-95 h-[94dvh] sm:h-[90dvh] flex flex-col relative">
        {/* Mobile drag handle */}
        <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" aria-hidden="true" />
        
        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2">
          <div className="flex items-center gap-2.5 text-purple-400 min-w-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-purple-500/20 flex items-center justify-center border border-purple-500/30 shadow-inner shrink-0">
              <RotateCcw className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2 truncate">
                <span>RETOURS & AVOIRS</span>
                <span className="hidden sm:inline-block text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30 uppercase font-black shrink-0">
                  F11
                </span>
              </h2>
              <p className="text-[10px] text-pos-muted truncate">Gestion des retours articles et émission d'avoirs</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="hidden sm:inline-flex">
              <Kbd size="sm">Esc</Kbd>
            </span>
            <button
              onClick={() => {
                setSelectedTxn(null);
                setSelectedTransactionForRefund(null);
                closeModal();
              }}
              className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
              aria-label="Fermer"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Modal Main Content */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Left Column: Transaction Selector / Search */}
          <div className={`border-r border-pos-border flex flex-col bg-pos-card shrink-0 ${selectedTxn ? 'hidden sm:flex sm:w-80' : 'w-full sm:w-80'}`}>
            <div className="p-3 border-b border-pos-border">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                <input
                  type="text"
                  data-testid="refund-search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Rechercher N° Ticket, Client..."
                  className="w-full bg-pos-bg border border-pos-border rounded-xl pl-8 pr-3 py-1.5 text-xs text-pos-text placeholder-pos-muted focus:border-purple-400 focus:outline-none"
                />
              </div>
              <p className="mt-1.5 text-[10px] text-pos-muted" aria-live="polite">
                Affichage de {Math.min(visibleCount, filteredTransactions.length)} sur {filteredTransactions.length} tickets éligibles
              </p>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain divide-y divide-pos-border/40 p-1">
              {(filteredTransactions || []).length === 0 ? (
                <div className="p-6 text-center text-xs text-pos-muted">
                  <Receipt className="w-8 h-8 mx-auto mb-2 text-pos-muted/40" />
                  Aucun ticket éligible trouvé.
                </div>
              ) : (
                (filteredTransactions || []).slice(0, visibleCount).map((t) => {
                  const isSelected = selectedTxn?.id === t.id;
                  // Fix 3 (UI hint — slice + adapter enforce): offline, only
                  // own-shift tickets are selectable. Unknown device locks
                  // everything (fail-closed); online shows no badge.
                  const offlineLocked =
                    onlineNow === false &&
                    !isOwnShiftTicket(t, {
                      localDeviceId: deviceIdNow,
                      activeShiftId: activeShift?.id ?? null,
                    });
                  return (
                    <button
                      key={t.id}
                      data-testid="refund-sale-row"
                      onClick={() => handleSelectTransaction(t)}
                      disabled={offlineLocked}
                      title={offlineLocked ? 'Hors ligne : ticket distant ou hors session — verrouillé' : undefined}
                      className={`w-full text-left p-3 rounded-xl transition cursor-pointer flex flex-col gap-1 ${
                        isSelected
                          ? 'bg-purple-500/20 border border-purple-500/40 text-purple-300'
                          : 'hover:bg-pos-hover/50 text-pos-text'
                      } ${offlineLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <div className="flex justify-between items-center">
                        <span className="font-mono font-bold text-xs text-purple-400 num">{t.receiptNumber}</span>
                        <span className="font-black text-xs text-emerald-400 num">{formatDZD(t.total)}</span>
                      </div>
                      <div className="flex justify-between text-[11px] text-pos-muted">
                        <span>{t.customer?.name || 'Client de passage'}</span>
                        <span className="font-mono text-[10px] whitespace-nowrap num">{formatDateTime(t.createdAt)}</span>
                      </div>
                      {t.status === 'PARTIALLY_REFUNDED' && (
                        <span className="text-[9px] text-amber-400 font-bold">Partiellement Remboursé</span>
                      )}
                      {offlineLocked && (
                        <span className="text-[9px] text-red-400 font-bold">Hors ligne — verrouillé</span>
                      )}
                    </button>
                  );
                })
              )}
              {filteredTransactions.length > visibleCount && (
                <button
                  type="button"
                  onClick={() => {
                    setVisibleCount((c) => c + REFUND_PAGE_SIZE);
                    // UPGRADE-01: keep the underlying window ahead of the
                    // viewport — once the user nears its end, fetch the next
                    // older page (keyset) so older tickets stay reachable.
                    const st = usePosStore.getState();
                    if (
                      st.transactionsHasMore &&
                      visibleCount + REFUND_PAGE_SIZE >= (st.transactions || []).length
                    ) {
                      void st.loadMoreTransactions();
                    }
                  }}
                  className="w-full p-2.5 mt-1 text-xs font-bold text-purple-300 bg-purple-500/10 border border-purple-500/30 rounded-xl hover:bg-purple-500/20 transition cursor-pointer"
                >
                  Afficher plus ({filteredTransactions.length - visibleCount} restants)
                </button>
              )}
            </div>
          </div>

          {/* Right Column: Refund Configuration & Form */}
          <div className={`flex-1 flex flex-col overflow-y-auto overscroll-contain p-3.5 sm:p-5 bg-pos-bg space-y-4 ${!selectedTxn ? 'hidden sm:flex' : 'flex'}`}>
            {!selectedTxn ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-3">
                <div className="w-16 h-16 rounded-2xl bg-purple-500/10 text-purple-400 flex items-center justify-center border border-purple-500/20">
                  <RotateCcw className="w-8 h-8 stroke-[1.5]" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-pos-text">Sélectionnez un ticket pour initier un retour</h3>
                  <p className="text-xs text-pos-muted mt-1 max-w-sm">
                    Recherchez le ticket par son numéro de reçu ou sélectionnez-le dans la liste de gauche.
                  </p>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmitRefund} className="space-y-4 flex-1 flex flex-col justify-between">
                
                <div className="space-y-4">
                  {/* Selected Transaction Summary Banner */}
                  <div className="bg-pos-card border border-pos-border p-3.5 rounded-2xl flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-[10px] text-pos-muted uppercase font-bold block">Ticket Source Sélectionné</span>
                      <div className="flex items-center gap-1.5 sm:gap-2 mt-0.5 flex-wrap">
                        <span className="font-mono font-black text-xs sm:text-sm text-purple-400 num">{selectedTxn.receiptNumber}</span>
                        <span className="text-xs text-pos-muted">•</span>
                        <span className="text-xs font-bold text-pos-text truncate">{selectedTxn.customer?.name || 'Client de passage'}</span>
                      </div>
                    </div>
                    <div className="text-right flex items-center gap-2 shrink-0">
                      <div>
                        <span className="text-[10px] text-pos-muted uppercase font-bold block">Total Payé</span>
                        <span className="text-xs sm:text-sm font-black text-emerald-400 num">{formatDZD(selectedTxn.total)}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedTxn(null)}
                        className="sm:hidden min-h-[36px] px-2.5 rounded-xl bg-pos-panel border border-pos-border text-xs font-bold text-cyan-400 active:scale-95 cursor-pointer"
                      >
                        Changer
                      </button>
                    </div>
                  </div>

                  {/* Item Selection Table */}
                  <div className="bg-pos-card border border-pos-border rounded-2xl overflow-hidden shadow-sm">
                    <div className="p-3 bg-pos-bg/80 border-b border-pos-border flex justify-between items-center">
                      <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider flex items-center gap-1.5">
                        <PackageCheck className="w-4 h-4 text-purple-400" /> Articles à Rembourser ({activeRefundItems.length}/{selectedTxn.items.length})
                      </h4>
                      <span className="text-[10px] text-pos-muted">Cochez les articles et ajustez les quantités</span>
                    </div>

                    {/* Mobile Card List View (<sm) */}
                    <div className="sm:hidden divide-y divide-pos-border/40">
                      {(selectedTxn.items || []).map((item, idx) => {
                        const itemKey = `${item.product.id}_${idx}`;
                        const isChecked = Boolean(selectedItemIds[itemKey]);
                        const isRestocked = Boolean(restockMap[itemKey]);
                        // Stepper max = what this LINE still owes (per-line
                        // identity), never the original quantity.
                        const maxQty = Math.max(1, remainingByItemKey.get(itemKey) ?? item.quantity);
                        const qty = Math.min(maxQty, refundQuantities[itemKey] || maxQty);
                        const unitPrice = item.appliedPrice || item.product.price;
                        const discountPerUnit = item.discount > 0 && item.quantity > 0 ? item.discount / item.quantity : 0;
                        const netUnitPrice = Math.max(0, unitPrice - discountPerUnit);
                        const lineRefundTotal = netUnitPrice * qty;

                        return (
                          <div
                            key={itemKey}
                            className={`p-3.5 space-y-3 transition ${
                              isChecked ? 'bg-purple-500/5' : 'opacity-60 bg-pos-bg/40'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              <input
                                type="checkbox"
                                data-testid={`refund-check-${itemKey}`}
                                checked={isChecked}
                                onChange={() => handleToggleItem(itemKey)}
                                aria-label={`Sélectionner ${item.product.title}`}
                                className="w-5 h-5 mt-0.5 rounded border-pos-border text-purple-500 focus:ring-purple-400 cursor-pointer shrink-0"
                              />
                              <div className="flex-1 min-w-0">
                                <p className="font-bold text-xs text-pos-text leading-snug">{item.product.title}</p>
                                <div className="flex items-center gap-2 text-[10px] text-pos-muted mt-0.5">
                                  <span>SKU: {item.product.sku}</span>
                                  {item.imeiNumber && (
                                    <span className="font-mono text-emerald-400">IMEI: {item.imeiNumber}</span>
                                  )}
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <span className="text-xs font-black text-purple-400 block num">{formatDZD(lineRefundTotal)}</span>
                                <span className="text-[10px] text-pos-muted num">{formatDZD(netUnitPrice)} /u</span>
                              </div>
                            </div>

                            {/* Stepper + Restock Controls */}
                            <div className="flex items-center justify-between gap-2 pt-2 border-t border-pos-border/30">
                              <div className="flex items-center gap-1.5 bg-pos-bg border border-pos-border rounded-xl p-1 shrink-0">
                                <button
                                  type="button"
                                  data-testid={`refund-dec-${itemKey}`}
                                  disabled={!isChecked || qty <= 1}
                                  onClick={() => handleQuantityChange(itemKey, qty - 1, maxQty)}
                                  className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg bg-pos-card border border-pos-border text-pos-text font-bold disabled:opacity-30 cursor-pointer active:scale-95"
                                  aria-label={`Diminuer quantité ${item.product.title}`}
                                >
                                  <span aria-hidden="true">-</span>
                                </button>
                                <span className="w-8 text-center text-xs font-black text-pos-text tabular-nums num">{qty}</span>
                                <button
                                  type="button"
                                  data-testid={`refund-inc-${itemKey}`}
                                  disabled={!isChecked || qty >= maxQty}
                                  onClick={() => handleQuantityChange(itemKey, qty + 1, maxQty)}
                                  className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg bg-pos-card border border-pos-border text-pos-text font-bold disabled:opacity-30 cursor-pointer active:scale-95"
                                  aria-label={`Augmenter quantité ${item.product.title}`}
                                >
                                  <span aria-hidden="true">+</span>
                                </button>
                                <span className="text-[10px] text-pos-muted pr-1.5">(max {maxQty})</span>
                              </div>

                              <button
                                type="button"
                                disabled={!isChecked}
                                onClick={() => handleToggleRestock(itemKey)}
                                className={`min-h-[40px] px-3 py-1.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer shrink-0 ${
                                  isRestocked
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                    : 'bg-red-500/20 text-red-400 border border-red-500/40'
                                }`}
                              >
                                {isRestocked ? (
                                  <>
                                    <PackageCheck className="w-3.5 h-3.5" aria-hidden="true" />
                                    <span>Remettre Stock (+{qty})</span>
                                  </>
                                ) : (
                                  <>
                                    <PackageX className="w-3.5 h-3.5" aria-hidden="true" />
                                    <span>Rebut / Défectueux</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Desktop Table View (>=sm) */}
                    <table className="hidden sm:table w-full text-left text-xs">
                      <thead className="bg-pos-bg text-pos-muted text-[10px] uppercase font-bold border-b border-pos-border">
                        <tr>
                          <th className="p-3 w-10 text-center">Sélection</th>
                          <th className="p-3">Article / SKU</th>
                          <th className="p-3 text-center w-28">Qté Retournée</th>
                          <th className="p-3 text-center w-36">Remettre en Stock ?</th>
                          <th className="p-3 text-right">Prix Net Unit.</th>
                          <th className="p-3 text-right">Total Remboursement</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pos-border/40">
                        {(selectedTxn.items || []).map((item, idx) => {
                          const itemKey = `${item.product.id}_${idx}`;
                          const isChecked = Boolean(selectedItemIds[itemKey]);
                          const isRestocked = Boolean(restockMap[itemKey]);
                          // Stepper max = per-line remainder (identity-aware).
                          const maxQty = Math.max(1, remainingByItemKey.get(itemKey) ?? item.quantity);
                          const qty = Math.min(maxQty, refundQuantities[itemKey] || maxQty);
                          const unitPrice = item.appliedPrice || item.product.price;
                          const discountPerUnit = item.discount > 0 && item.quantity > 0 ? item.discount / item.quantity : 0;
                          const netUnitPrice = Math.max(0, unitPrice - discountPerUnit);
                          const lineRefundTotal = netUnitPrice * qty;

                          return (
                            <tr
                              key={itemKey}
                              className={`transition ${
                                isChecked ? 'bg-purple-500/5' : 'opacity-50 bg-pos-bg/30'
                              }`}
                            >
                              <td className="p-3 text-center">
                                <input
                                  type="checkbox"
                                  data-testid={`refund-check-${itemKey}`}
                                  checked={isChecked}
                                  onChange={() => handleToggleItem(itemKey)}
                                  aria-label={`Sélectionner ${item.product.title}`}
                                  className="w-4 h-4 rounded border-pos-border text-purple-500 focus:ring-purple-400 cursor-pointer"
                                />
                              </td>
                              <td className="p-3">
                                <p className="font-bold text-pos-text">{item.product.title}</p>
                                <div className="flex items-center gap-2 text-[10px] text-pos-muted">
                                  <span>SKU: {item.product.sku}</span>
                                  {item.imeiNumber && (
                                    <span className="font-mono text-emerald-400">IMEI: {item.imeiNumber}</span>
                                  )}
                                </div>
                              </td>
                              <td className="p-3 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  <button
                                    type="button"
                                    data-testid={`refund-dec-${itemKey}`}
                                    disabled={!isChecked || qty <= 1}
                                    onClick={() => handleQuantityChange(itemKey, qty - 1, maxQty)}
                                    className="w-6 h-6 rounded-lg bg-pos-bg border border-pos-border text-pos-text font-bold disabled:opacity-30"
                                  >
                                    -
                                  </button>
                                  <span className="w-8 text-center font-bold text-pos-text num">{qty}</span>
                                  <button
                                    type="button"
                                    disabled={!isChecked || qty >= maxQty}
                                    onClick={() => handleQuantityChange(itemKey, qty + 1, maxQty)}
                                    className="w-6 h-6 rounded-lg bg-pos-bg border border-pos-border text-pos-text font-bold disabled:opacity-30"
                                  >
                                    +
                                  </button>
                                </div>
                                <span className="text-[9px] text-pos-muted block mt-0.5">(Max: {maxQty})</span>
                              </td>
                              <td className="p-3 text-center">
                                <button
                                  type="button"
                                  disabled={!isChecked}
                                  onClick={() => handleToggleRestock(itemKey)}
                                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5 mx-auto transition cursor-pointer ${
                                    isRestocked
                                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                      : 'bg-red-500/20 text-red-400 border border-red-500/30'
                                  }`}
                                >
                                  {isRestocked ? (
                                    <>
                                      <PackageCheck className="w-3 h-3" /> Remettre Stock (+{qty})
                                    </>
                                  ) : (
                                    <>
                                      <PackageX className="w-3 h-3" /> Rebut / Défectueux
                                    </>
                                  )}
                                </button>
                              </td>
                              <td className="p-3 text-right font-medium text-pos-muted num">{formatDZD(netUnitPrice)}</td>
                              <td className="p-3 text-right font-black text-purple-400 num">{formatDZD(lineRefundTotal)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Rebut sans restock: motif obligatoire */}
                  {activeRefundItems.some((i) => !i.restock) && (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-3 flex items-start gap-2 text-xs">
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-amber-200">
                        Article(s) marqué(s) « Rebut / Défectueux » (sans remise en stock) : le motif
                        ci-dessous est obligatoire et sera conservé comme note de rebut.
                      </p>
                    </div>
                  )}

                  {/* Refund Options & Reason */}
                  <div className="grid grid-cols-2 gap-4">
                    
                    {/* Method Selector */}
                    <div className="bg-pos-card border border-pos-border p-3.5 rounded-2xl space-y-2.5">
                      <span className="text-xs font-bold text-pos-text block flex items-center gap-1.5">
                        <Wallet className="w-4 h-4 text-purple-400" /> Mode de Remboursement
                      </span>
                      
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setRefundMethod('Espèces')}
                          className={`p-2.5 rounded-xl border text-left flex items-center gap-2 transition cursor-pointer ${
                            refundMethod === 'Espèces'
                              ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 shadow-sm'
                              : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                          }`}
                        >
                          <Coins className="w-4 h-4 text-emerald-400" />
                          <div>
                            <p className="text-xs font-bold">Espèces (Cash)</p>
                            <p className="text-[9px] text-pos-muted">Sortie tiroir-caisse directe</p>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => setRefundMethod('Avoir Client')}
                          className={`p-2.5 rounded-xl border text-left flex items-center gap-2 transition cursor-pointer ${
                            refundMethod === 'Avoir Client'
                              ? 'bg-purple-500/20 border-purple-500/50 text-purple-300 shadow-sm'
                              : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                          }`}
                        >
                          <Wallet className="w-4 h-4 text-purple-400" />
                          <div>
                            <p className="text-xs font-bold">Avoir Magasin</p>
                            <p className="text-[9px] text-pos-muted">Bon d'achat / Échange</p>
                          </div>
                        </button>
                      </div>

                      {refundMethod === 'Avoir Client' && !selectedTxn.customer && (
                        <p className="text-[10px] text-amber-400 flex items-center gap-1 bg-amber-500/10 p-2 rounded-lg border border-amber-500/20">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          Note : Ticket sans client enregistré. L'avoir sera imprimé sous forme de Bon d'Avoir avec code-barres.
                        </p>
                      )}
                    </div>

                    {/* Reason & Security Gate */}
                    <div className="bg-pos-card border border-pos-border p-3.5 rounded-2xl space-y-2.5">
                      <span className="text-xs font-bold text-pos-text block flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-purple-400" /> Motif & Autorisation PIN
                      </span>

                      <div>
                        <label className="text-[10px] text-pos-muted font-bold block mb-1">Motif du Retour :</label>
                        <select
                          value={refundReason}
                          onChange={(e) => setRefundReason(e.target.value)}
                          className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text font-semibold focus:border-purple-400 focus:outline-none cursor-pointer"
                        >
                          <option value="Erreur de choix client / Échange">Erreur de choix client / Échange</option>
                          <option value="Article défectueux / Panne sous garantie">Article défectueux / Panne sous garantie</option>
                          <option value="Incompatible avec l'appareil">Incompatible avec l'appareil</option>
                          <option value="Insatisfaction produit">Insatisfaction produit</option>
                          <option value="Autre">Autre motif personnalisé...</option>
                        </select>
                      </div>

                      {refundReason === 'Autre' && (
                        <input
                          type="text"
                          value={customReason}
                          onChange={(e) => setCustomReason(e.target.value)}
                          placeholder="Précisez le motif exact..."
                          className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-1.5 text-xs text-pos-text focus:border-purple-400 focus:outline-none"
                        />
                      )}

                      {offlineCashNeedsSupervisor && (
                        <div className="text-[10px] text-amber-400 font-bold bg-amber-500/10 border border-amber-500/30 rounded-xl px-2.5 py-1.5">
                          Hors ligne : remboursement espèces de {formatDZD(previewCashOut)} — l’autorisation superviseur (PIN ci-dessous) sera enregistrée dans l’audit du ticket.
                        </div>
                      )}
                      <div className="pt-1">
                        <label className="text-[10px] text-pos-muted font-bold block mb-1">PIN Manager d'Autorisation :</label>
                        <div className="relative">
                          <Key className="w-3.5 h-3.5 text-pos-muted absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="password"
                            data-testid="refund-pin"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            autoComplete="current-password"
                            value={managerPin}
                            onChange={(e) => {
                              setManagerPin(e.target.value);
                              setManagerPinTicket(selectedTxn?.id ?? null);
                              setPinRequired(false);
                            }}
                            placeholder="Saisir PIN Manager"
                            className={`w-full bg-pos-bg border rounded-xl pl-8 pr-3 py-2 text-xs font-bold text-pos-text focus:outline-none ${
                              pinRequired ? 'border-red-500' : 'border-pos-border focus:border-purple-400'
                            }`}
                          />
                        </div>
                      </div>
                    </div>

                  </div>
                </div>

                {/* Footer Action Bar */}
                <div className="pt-3 border-t border-pos-border flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-pos-card p-3.5 sm:p-4 pb-[max(1rem,var(--safe-bottom))] sm:pb-4 rounded-t-2xl sm:rounded-2xl shadow-xl shrink-0">
                  <div>
                    <span className="text-[10px] text-pos-muted uppercase font-bold block">Montant Total à Rembourser</span>
                    <span data-testid="refund-total" className="text-lg sm:text-xl font-black text-purple-400 num">{formatDZD(totalRefundAmount)}</span>
                    {fundingPreview && (fundingPreview.anomalies ?? []).includes('voucher-lane-unrestorable') && (
                      <span
                        data-testid="refund-voucher-unrestorable"
                        role="status"
                        className="text-[10px] text-amber-300 block mt-1"
                      >
                        Bon d’achat non restituable : le ticket ne porte pas de code, aucun bon ne peut être recrédité.
                        Ce montant n’est pas remboursé.
                      </span>
                    )}
                    {fundingPreview && fundingPreview.netRefund !== Math.round(totalRefundAmount) && (
                      <span className="text-[10px] text-pos-muted block">
                        Net reversé : {formatDZD(fundingPreview.netRefund)}
                        {refundMethod === 'Espèces' && !(previewClamp && previewClamp.avoirOverflow > 0) && ` • Espèces décaissées : ${formatDZD(previewCashOut)}`}
                        {refundMethod === 'Espèces' && previewClamp && previewClamp.avoirOverflow > 0 && (
                          <span className="text-amber-300 block">
                            Plafond espèces : {formatDZD(previewClamp.cashOut)} décaissés • {formatDZD(previewClamp.avoirOverflow)} reverrouillé en avoir
                          </span>
                        )}
                        {fundingPreview.voucherShare > 0 && ` • Bon recrédité : ${formatDZD(fundingPreview.voucherShare)}`}
                        {fundingPreview.avoirShare > 0 && ` • Avoir recrédité : ${formatDZD(fundingPreview.avoirShare)}`}
                        {fundingPreview.debtShare > 0 && ` • Dette réduite : ${formatDZD(fundingPreview.debtShare)}`}
                        {fundingPreview.digitalShare > 0 && ` • Rail d’origine à reverser : ${formatDZD(fundingPreview.digitalShare)} (jamais en espèces)`}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
                    {!activeShift || !activeShift.id ? (
                      <span className="text-[10px] text-red-400 font-bold max-w-[220px]">
                        Caisse fermée — ouvrez la caisse pour rembourser (traçabilité de période).
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTxn(null);
                        setSelectedTransactionForRefund(null);
                        closeModal();
                      }}
                      className="min-h-[44px] px-4 py-2.5 rounded-xl border border-pos-border bg-pos-bg hover:bg-pos-hover text-pos-muted hover:text-pos-text text-xs font-bold transition cursor-pointer active:scale-95 shrink-0"
                    >
                      Annuler
                    </button>

                    <button
                      type="submit"
                      data-testid="refund-submit"
                      disabled={isSubmitting || activeRefundItems.length === 0 || totalRefundAmount <= 0 || submitForeignLocked}
                      title={submitForeignLocked ? 'Offline Terminal Lock: Cross-terminal refunds require an active sync connection.' : undefined}
                      className="flex-1 sm:flex-initial min-h-[48px] px-5 sm:px-6 py-2.5 rounded-xl bg-purple-500 hover:bg-purple-400 text-slate-950 font-black text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg shadow-purple-500/20 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
                    >
                      <CheckCircle2 className="w-4 h-4 stroke-[2.5]" aria-hidden="true" />
                      <span>Valider le Remboursement</span>
                    </button>
                  </div>
                </div>

              </form>
            )}
          </div>

        </div>

      </div>
    </div>
  );
};

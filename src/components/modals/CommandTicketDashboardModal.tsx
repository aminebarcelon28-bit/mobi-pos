import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Clock,
  Truck,
  CheckCircle2,
  Search,
  Printer,
  Download,
  MessageSquare,
  PlusCircle,
  PackageCheck,
  ChevronDown,
  ChevronUp,
  Trash2,
  ExternalLink,
  Play,
  Wrench,
  ShoppingBag,
  FileText,
  Eye,
  MoreHorizontal,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime, REPAIR_STATUS_BADGE_TOKENS, repairRemainingBalance } from '../../types/pos';
import type { PurchaseOrder, PaymentMethodType } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { buildWhatsAppUrl } from '../../utils/phoneUtils';
import { soundEngine } from '../../utils/audioFeedback';
import { PurchaseOrderA4Document } from './PurchaseOrderA4Document';

// ─── Affichage seul : ancienneté relative en français ───
// TTL 48 h des paniers suspendus (miroir lecture-seule de createCartSlice).

const HOLD_TTL_MS = 48 * 60 * 60 * 1000;

function parseIsoMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : t;
}

/** « à l'instant », « il y a X min », « il y a X h », « il y a X j » — null si date absente/illisible. */
function formatAgeFr(createdAtMs: number | null, nowMs: number): string | null {
  if (createdAtMs === null) return null;
  const diffMin = Math.max(0, Math.floor((nowMs - createdAtMs) / 60000));
  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `il y a ${diffH} h`;
  return `il y a ${Math.floor(diffH / 24)} j`;
}

type AgeTone = 'fresh' | 'watch' | 'old' | 'unknown';

/** Code couleur d'ancienneté : récent < 1 h, à surveiller < 24 h, ancien au-delà. */
function ageTone(createdAtMs: number | null, nowMs: number): AgeTone {
  if (createdAtMs === null) return 'unknown';
  const ageMs = nowMs - createdAtMs;
  if (ageMs < 60 * 60 * 1000) return 'fresh';
  if (ageMs < 24 * 60 * 60 * 1000) return 'watch';
  return 'old';
}

const AGE_TONE_CLASSES: Record<AgeTone, string> = {
  fresh: 'bg-teal-500/15 border-teal-500/30 text-teal-300',
  watch: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
  old: 'bg-red-500/15 border-red-500/30 text-red-300 animate-pulse',
  unknown: 'bg-pos-bg border-pos-border text-pos-muted',
};

/** Instant de suspension déduit de l'expiresAt (48 h TTL) — null pour les tickets historiques sans TTL. */
function heldSaleCreatedAtMs(hs: unknown): number | null {
  const exp = parseIsoMs((hs as { expiresAt?: unknown }).expiresAt);
  return exp === null ? null : exp - HOLD_TTL_MS;
}

export const CommandTicketDashboardModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    openModal,
    purchaseOrders,
    heldSales,
    repairOrders,
    retrieveSale,
    deleteHeldSale,
    validateAndReceivePO,
    cancelPO,
    deletePO,
    updateRepairOrderStatus,
    receiptSettings,
    setPendingRepairPrint,
  } = usePosStore();
  const { showToast } = useToast();
  const [showRepairArchive, setShowRepairArchive] = useState(false);

  const handleSettleAndDeliver = async (orderId: string, ticketNumber: string) => {
    const { settleAndDeliverRepair, markRepairDelivered } = usePosStore.getState();
    const res = await settleAndDeliverRepair(orderId);
    if (res.action === 'cart') {
      showToast(`Solde ${formatDZD(res.remainingBalance)} injecté au panier — encaissez pour livrer ${ticketNumber}.`, 'success');
      closeModal();
      return;
    }
    if (window.confirm(`Livrer ${ticketNumber} ? Solde à zéro confirmé.`)) {
      const ok = await markRepairDelivered(orderId);
      showToast(ok ? `Ticket ${ticketNumber} livré.` : 'Livraison impossible — solde restant.', ok ? 'success' : 'warning');
    }
  };

  // Navigation Tabs
  const [activeTab, setActiveTab] = useState<'waiting_pos' | 'held_sales' | 'repairs'>('waiting_pos');

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'Waiting List' | 'Draft' | 'Partially Received' | 'Completed'>('all');
  const [expandedPoId, setExpandedPoId] = useState<string | null>(null);

  // Receiving Sub-Modal State
  const [receivingPO, setReceivingPO] = useState<PurchaseOrder | null>(null);
  const [printingPO, setPrintingPO] = useState<PurchaseOrder | null>(null);
  const [previewingPO, setPreviewingPO] = useState<PurchaseOrder | null>(null);
  const [verifiedQtyMap, setVerifiedQtyMap] = useState<Record<string, number>>({});
  const [verifiedCostMap, setVerifiedCostMap] = useState<Record<string, number>>({});
  const [discrepancyReasons, setDiscrepancyReasons] = useState<Record<string, string>>({});
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState<string>('');
  const [receptionSnapshot, setReceptionSnapshot] = useState<import('../../types/pos').POReceptionSnapshot | null>(null);
  const [autoRecordExpense, setAutoRecordExpense] = useState<boolean>(true);
  const [expensePaymentMethod, setExpensePaymentMethod] = useState<PaymentMethodType>('Espèces');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Rafraîchit les anciennetés « il y a X min » toutes les 30 s (affichage seul).
  const [, setAgeTick] = useState(0);

  // Portaled overflow menus — meatball triggers live inside cards that sit in
  // an overflow-y-auto scroller, so an absolutely-positioned child would be
  // clipped. Menus are portaled to document.body with position:fixed.
  // Keys: `po:<id>` (row actions), `repair:<id>` (SAV), `header:waiting`, `preview:<poNumber>`.
  const [overflowKey, setOverflowKey] = useState<string | null>(null);
  const overflowAnchorRefs = useRef(new Map<string, HTMLButtonElement>());
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const [overflowPos, setOverflowPos] = useState<{ top: number; left: number; openUp: boolean }>({
    top: 0,
    left: 0,
    openUp: false,
  });
  const setOverflowAnchor = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) overflowAnchorRefs.current.set(key, el);
    else overflowAnchorRefs.current.delete(key);
  };

  useEffect(() => {
    if (activeModal !== 'command_tickets') return;
    const timer = setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 60);
    return () => clearTimeout(timer);
  }, [activeModal]);

  useEffect(() => {
    if (activeModal !== 'command_tickets') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Overflow menu handles its own Escape (focus back to anchor).
      if (overflowKey) return;
      if (previewingPO) {
        e.preventDefault();
        setPreviewingPO(null);
        return;
      }
      if (receivingPO) {
        e.preventDefault();
        setReceivingPO(null);
        return;
      }
      e.preventDefault();
      closeModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeModal, closeModal, overflowKey, previewingPO, receivingPO]);

  // Portaled overflow menu: compute fixed position from the meatball anchor
  // with auto flip (open upward when near the bottom viewport edge), clamp to
  // the viewport, and dismiss on outside click / Escape / scroll / resize.
  useEffect(() => {
    if (!overflowKey || activeModal !== 'command_tickets') return;
    const MENU_W = 288;
    const MENU_H_EST = 264;
    const place = () => {
      const anchor = overflowAnchorRefs.current.get(overflowKey);
      const r = anchor?.getBoundingClientRect();
      if (!r) return;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < MENU_H_EST + 16;
      const top = openUp
        ? Math.max(8, r.top - MENU_H_EST - 8)
        : Math.min(r.bottom + 8, window.innerHeight - 16);
      const isMobile = window.innerWidth < 640;
      const left = isMobile ? 8 : Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
      setOverflowPos({ top, left, openUp });
    };
    place();
    const handleClickOutside = (event: MouseEvent) => {
      const t = event.target as Node;
      const anchor = overflowAnchorRefs.current.get(overflowKey);
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(t) && anchor && !anchor.contains(t)) {
        setOverflowKey(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOverflowKey(null);
        overflowAnchorRefs.current.get(overflowKey)?.focus();
      }
    };
    const handleScroll = () => setOverflowKey(null);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', place);
    // Capture phase: any inner scroll (card list) invalidates the anchor.
    window.addEventListener('scroll', handleScroll, true);
    overflowMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [overflowKey, activeModal]);

  useEffect(() => {
    if (activeModal !== 'command_tickets') return;
    const id = setInterval(() => setAgeTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [activeModal]);

  if (activeModal !== 'command_tickets') return null;

  // ══════════════════════════════════════════════════════════════
  // GLOBAL KPIS CALCULATIONS
  // ══════════════════════════════════════════════════════════════
  const nowMs = Date.now();
  const waitingPOs = (purchaseOrders || []).filter(
    (po) => po.status === 'Waiting List' || po.status === 'Draft' || po.status === 'Partially Received'
  );

  const totalWaitingUnits = waitingPOs.reduce(
    (acc, po) =>
      acc +
      (po.items || []).reduce(
        (sum, item) => sum + Math.max(0, item.suggestedQty - (item.receivedQty || 0)),
        0
      ),
    0
  );

  const totalEstimatedCost = waitingPOs.reduce((acc, po) => acc + (po.totalAmount || 0), 0);

  const pendingRepairs = (repairOrders || []).filter(
    (r) => r.status === 'Diagnostic' || r.status === 'En attente de pièces' || r.status === 'En cours'
  );

  // Filtered Purchase Orders — newest first (creation timestamp DESC).
  // Enterprise rule: a "Bons Fournisseur" waiting list must surface the most
  // recently created order at the top, never oldest-first.
  const filteredPOs = (purchaseOrders || [])
    .filter((po) => {
      const matchesSearch =
        po.poNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        po.vendorName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        po.items.some((item) => item.title.toLowerCase().includes(searchQuery.toLowerCase()) || item.sku.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesStatus = statusFilter === 'all' ? true : po.status === statusFilter;
      return matchesSearch && matchesStatus;
    })
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return tb - ta;
    });

  // Filtered Held Sales
  const filteredHeldSales = (heldSales || []).filter((hs) => {
    const custName = hs.customer?.name || 'Client Comptant';
    return (
      custName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      hs.items.some((item) => item.product.title.toLowerCase().includes(searchQuery.toLowerCase()))
    );
  });

  // Filtered Repair Orders — active lane excludes Livré/Annulé (archive toggle).
  const filteredRepairs = (repairOrders || []).filter((r) => {
    const isArchived = r.status === 'Livré' || r.status === 'Annulé';
    if (isArchived !== showRepairArchive) return false;
    return (
      r.ticketNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.customerPhone.includes(searchQuery) ||
      r.deviceModel.toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

  // ══════════════════════════════════════════════════════════════
  // ACTIONS: RECEPTION & VERIFICATION
  // ══════════════════════════════════════════════════════════════
  const handleOpenReceivingModal = (po: PurchaseOrder) => {
    setReceivingPO(po);
    setSupplierInvoiceNo('');
    setReceptionSnapshot(null);
    const initQty: Record<string, number> = {};
    const initCost: Record<string, number> = {};
    const initReasons: Record<string, string> = {};

    po.items.forEach((item) => {
      // Default to REMAINING qty (0 for complete lines): defaulting to the
      // full suggestedQty re-added complete lines on re-validation,
      // double-counting stock + batches + ledger (receivedQty accumulates).
      const remaining = Math.max(0, item.suggestedQty - (item.receivedQty || 0));
      initQty[item.productId] = remaining;
      initCost[item.productId] = item.actualUnitCost || item.unitCost;
      initReasons[item.productId] = item.discrepancyReason || '';
    });

    setVerifiedQtyMap(initQty);
    setVerifiedCostMap(initCost);
    setDiscrepancyReasons(initReasons);
  };

  const handleConfirmReception = async () => {
    if (!receivingPO) return;
    setIsProcessing(true);

    const verifiedItems = (receivingPO.items || []).map((item) => {
      const receivedQty = verifiedQtyMap[item.productId] !== undefined ? verifiedQtyMap[item.productId] : item.suggestedQty;
      const actualUnitCost = verifiedCostMap[item.productId] !== undefined ? verifiedCostMap[item.productId] : item.unitCost;
      const discrepancyReason = discrepancyReasons[item.productId] || '';

      return {
        productId: item.productId,
        receivedQty,
        actualUnitCost,
        discrepancyReason: receivedQty < item.suggestedQty && !discrepancyReason ? 'Quantité partielle reçue' : discrepancyReason,
      };
    });

    const poReceiveResult = await validateAndReceivePO({
      poId: receivingPO.id,
      verifiedItems,
      recordExpense: autoRecordExpense,
      expensePaymentMethod,
    });

    setIsProcessing(false);

    if (poReceiveResult.success) {
      soundEngine.playSuccess();
      if (poReceiveResult.isPartial) {
        showToast(
          `📦 Réception partielle validée pour Bon #${receivingPO.poNumber}. Le reliquat reste sur la Liste d'Attente.`,
          'info'
        );
      } else {
        showToast(
          `✅ Bon #${receivingPO.poNumber} entièrement réceptionné & stock incrémenté avec succès !`,
          'success'
        );
      }

      if (autoRecordExpense && poReceiveResult.totalReceivedCost > 0) {
        showToast(`💶 Charge Fournisseur de ${formatDZD(poReceiveResult.totalReceivedCost)} liée à l'EBITDA.`, 'success');
      }

      setReceivingPO(null);
    } else {
      soundEngine.playError();
      showToast('Erreur lors de la validation du bon de commande.', 'error');
    }
  };

  // ══════════════════════════════════════════════════════════════
  // ACTIONS: EXPORT & WHATSAPP
  // ══════════════════════════════════════════════════════════════
  const handleExportExcel = (po: PurchaseOrder) => {
    try {
      // Professionally styled .xlsx: branded emerald headers, thin table
      // borders, auto-fitted columns, DA currency formatting and dynamic
      // =SUM() formulas for line amounts + grand total.
      void import('../../utils/purchaseOrderXlsx').then(({ downloadPurchaseOrderXlsx }) => {
        const filename = downloadPurchaseOrderXlsx(po, {
          storeName: receiptSettings?.storeName,
          address: receiptSettings?.address,
          phone: receiptSettings?.phone,
          email: receiptSettings?.email,
        });
        showToast(`Bon de commande #${po.poNumber} exporté en Excel (${filename}).`, 'success');
      });
    } catch (err) {
      console.error('Failed to export purchase order to Excel:', err);
      showToast('Échec de l’export Excel du bon de commande.', 'error');
    }
  };

  const handleSendWhatsApp = (po: PurchaseOrder) => {
    let itemsText = '';
    po.items.forEach((item, idx) => {
      itemsText += `${idx + 1}. *${item.title}*\n   • Réf: \`${item.sku}\` | Qté: *${item.suggestedQty} pcs* (${formatDZD(item.unitCost)}/u)\n`;
    });

    const msg = `*BON DE COMMANDE N° ${po.poNumber}*\n*Fournisseur :* ${po.vendorName}\n*Date :* ${new Date(po.createdAt).toLocaleDateString('fr-DZ')}\n\n*Articles en attente :*\n${itemsText}\n*TOTAL ESTIMÉ : ${formatDZD(po.totalAmount)}*\n\nMerci de confirmer la livraison.`;
    const url = buildWhatsAppUrl('0550000000', msg);
    window.open(url, '_blank');
  };

  const handlePrintPO = async (po: PurchaseOrder) => {
    setReceptionSnapshot(null);
    setPrintingPO(po);
    const { printCoordinator } = await import('../../utils/printCoordinator');
    const printed = printCoordinator.printPurchaseOrder(100);
    if (!printed) {
      const { openNativePrint } = await import('../../utils/phoneUtils');
      const { purchaseOrderText } = await import('../../utils/mobileDocPrint');
      const st = usePosStore.getState();
      await openNativePrint(`Bon ${po.poNumber}`, purchaseOrderText(po, st.receiptSettings));
    }
    showToast(`Impression Bon #${po.poNumber} (Format A4) lancée.`, 'info');
  };

  const handleDeleteOrCancelPO = async (po: PurchaseOrder) => {
    if (confirm(`Confirmez-vous l'annulation et suppression du bon #${po.poNumber} (${po.vendorName}) ?`)) {
      await cancelPO(po.id, 'Supprimé par l\'administrateur');
      await deletePO(po.id);
      showToast(`Bon #${po.poNumber} supprimé.`, 'info');
    }
  };

  const handleRestoreHeldSaleClick = (saleId: string) => {
    // retrieveSale returns { success, warnings } at runtime (expired /
    // double-restore guards) — surface failures instead of toasting success.
    const res = retrieveSale(saleId) as unknown as { success: boolean; reason?: string; warnings?: string[] };
    if (!res || res.success === false) {
      soundEngine.playError();
      const reason = res?.reason;
      showToast(
        reason === 'HOLD_EXPIRED'
          ? 'Ticket en attente expiré — il a été purgé.'
          : reason === 'ALREADY_RESTORED'
          ? 'Ticket déjà restauré (double-clic ignoré).'
          : reason === 'HOLD_NOT_FOUND'
          ? 'Ticket en attente introuvable.'
          : 'Restauration du panier impossible.',
        'error'
      );
      return;
    }
    closeModal();
    soundEngine.playSuccess();
    for (const w of res.warnings ?? []) {
      showToast(w, 'warning', 5000);
    }
    showToast('Panier en attente restauré avec succès dans la caisse !', 'success');
  };

  const handleDeleteHeldSaleClick = (saleId: string) => {
    if (confirm('Voulez-vous vraiment supprimer ce ticket en attente ?')) {
      deleteHeldSale(saleId);
      showToast('Ticket en attente supprimé.', 'info');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-900/50 backdrop-blur-sm select-none">
      <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-2xl bg-pos-panel border border-pos-border overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:zoom-in-95">
        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL HEADER */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="px-6 py-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 shadow-lg shadow-emerald-500/20 shrink-0">
              <Clock className="w-5 h-5 sm:w-6 sm:h-6 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xs sm:text-base font-black text-pos-text uppercase tracking-wider truncate">
                  Commandes & File d'Attente
                </h2>
                <span className="px-2 py-0.2 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold text-[10px] sm:text-xs shrink-0">
                  {waitingPOs.length} En Attente
                </span>
              </div>
              <p className="text-[11px] text-pos-muted truncate hidden sm:block">
                Suivi centralisé des Bons de Commande Fournisseur, Paniers Suspendus et SAV
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition shrink-0 cursor-pointer"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TOP KPI SUMMARY — compact strip (divide-x, label+value baseline) */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div
          className="grid grid-cols-2 md:grid-cols-4 divide-x divide-pos-border py-3 bg-pos-card/50 border-b border-pos-border shrink-0 select-none"
          role="status"
          aria-label={`${waitingPOs.length} bons en attente, ${totalWaitingUnits} unités, budget ${formatDZD(totalEstimatedCost)}, ${heldSales.length} paniers suspendus`}
        >
          <div className="flex-1 min-w-0 px-2 sm:px-4 py-1.5 flex items-baseline justify-center gap-1.5" title={`${waitingPOs.length} bons en file d'attente`}>
            <span className="text-[10px] uppercase font-bold text-pos-muted truncate">Bons</span>
            <span className="text-sm font-black text-amber-300 tabular-nums">{waitingPOs.length}</span>
          </div>
          <div className="flex-1 min-w-0 px-2 sm:px-4 py-1.5 flex items-baseline justify-center gap-1.5" title={`${totalWaitingUnits} unités attendues`}>
            <span className="text-[10px] uppercase font-bold text-pos-muted truncate">Unités</span>
            <span className="text-sm font-black text-emerald-400 tabular-nums">+{totalWaitingUnits}</span>
          </div>
          <div className="flex-1 min-w-0 px-2 sm:px-4 py-1.5 flex items-baseline justify-center gap-1.5" title={`Budget estimé : ${formatDZD(totalEstimatedCost)}`}>
            <span className="text-[10px] uppercase font-bold text-pos-muted truncate">Budget</span>
            <span className="text-sm font-black text-emerald-400 tabular-nums truncate">{formatDZD(totalEstimatedCost)}</span>
          </div>
          <div className="flex-1 min-w-0 px-2 sm:px-4 py-1.5 flex items-baseline justify-center gap-1.5" title={`${heldSales.length} paniers suspendus`}>
            <span className="text-[10px] uppercase font-bold text-pos-muted truncate">Paniers</span>
            <span className="text-sm font-black text-emerald-400 tabular-nums">{heldSales.length}</span>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* NAVIGATION TABS & SEARCH CONTROLS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-4 pb-3 border-b border-pos-border bg-pos-panel shrink-0">
          {/* Tab Selection — scroll row on mobile */}
          <div className="flex items-center gap-1.5 bg-pos-bg p-1 rounded-lg border border-pos-border w-full sm:w-auto overflow-x-auto no-scrollbar whitespace-nowrap overscroll-contain">
            <button
              onClick={() => setActiveTab('waiting_pos')}
              className={`min-h-[44px] px-3.5 py-1.5 rounded-lg text-xs font-black flex items-center gap-2 transition cursor-pointer shrink-0 active:scale-95 ${
                activeTab === 'waiting_pos'
                  ? 'bg-amber-500 text-slate-950 shadow-md'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <Truck className="w-4 h-4" />
              <span>Bons Fournisseur ({waitingPOs.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('held_sales')}
              className={`min-h-[44px] px-3.5 py-1.5 rounded-lg text-xs font-black flex items-center gap-2 transition cursor-pointer shrink-0 active:scale-95 ${
                activeTab === 'held_sales'
                  ? 'bg-emerald-500 text-slate-950 shadow-md'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <ShoppingBag className="w-4 h-4" />
              <span>Paniers en Attente ({heldSales.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('repairs')}
              className={`min-h-[44px] px-3.5 py-1.5 rounded-lg text-xs font-black flex items-center gap-2 transition cursor-pointer shrink-0 active:scale-95 ${
                activeTab === 'repairs'
                  ? 'bg-emerald-500 text-slate-950 shadow-md'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <Wrench className="w-4 h-4" />
              <span>File SAV ({pendingRepairs.length})</span>
            </button>
          </div>

          {/* Search Bar & Actions */}
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <div className="relative flex-1 sm:w-64">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Rechercher bon, fournisseur, SKU..."
                aria-label="Rechercher dans la file d'attente"
                className="w-full bg-pos-bg border border-pos-border rounded-lg pl-9 pr-3 py-1.5 text-xs text-pos-text focus:outline-none focus:border-amber-400 min-h-[44px]"
              />
            </div>

            {activeTab === 'waiting_pos' && (
              <>
                <button
                  onClick={() => openModal('vendor_procurement')}
                  className="min-h-[44px] px-3 py-1.5 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-bold text-xs rounded-lg flex items-center gap-1.5 shadow-md shadow-emerald-900/20 transition cursor-pointer shrink-0"
                >
                  <PlusCircle className="w-4 h-4" />
                  <span>+ Réapprovisionnement</span>
                </button>
                <button
                  type="button"
                  ref={setOverflowAnchor('header:waiting')}
                  onClick={() => setOverflowKey((k) => (k === 'header:waiting' ? null : 'header:waiting'))}
                  className="min-h-[44px] min-w-[44px] w-11 h-11 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text font-bold text-sm flex items-center justify-center transition cursor-pointer shrink-0"
                  aria-expanded={overflowKey === 'header:waiting'}
                  aria-haspopup="menu"
                  aria-label="Plus d'actions bons fournisseur"
                  title="Plus d'actions bons fournisseur"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MAIN CONTENT AREA */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="overflow-y-auto overscroll-contain p-6 space-y-3 flex-1 min-h-0">
          {/* TAB 1: PURCHASE ORDERS & WAITING LIST */}
          {activeTab === 'waiting_pos' && (
            <div className="space-y-3">
              {/* Status Filter Pills — scroll row on mobile */}
              <div className="flex items-center gap-2 pb-2 overflow-x-auto no-scrollbar overscroll-contain text-xs">
                {(['all', 'Waiting List', 'Draft', 'Partially Received', 'Completed'] as const).map((st) => (
                  <button
                    key={st}
                    onClick={() => setStatusFilter(st)}
                    className={`min-h-[44px] px-3 py-1 rounded-lg font-bold border transition cursor-pointer shrink-0 flex items-center ${
                      statusFilter === st
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                        : 'bg-pos-card text-pos-muted hover:text-pos-text border-pos-border'
                    }`}
                  >
                    {st === 'all'
                      ? 'Tous les Bons'
                      : st === 'Waiting List'
                      ? '⏳ En Liste d\'Attente'
                      : st === 'Draft'
                      ? '📝 Brouillons'
                      : st === 'Partially Received'
                      ? '📦 Partiels'
                      : '✅ Réceptionnés'}
                  </button>
                ))}
              </div>

              {filteredPOs.length === 0 ? (
                <div className="p-12 text-center bg-pos-card border border-pos-border rounded-xl shadow-sm space-y-3">
                  <Clock className="w-12 h-12 text-pos-muted mx-auto opacity-40" />
                  <h3 className="font-bold text-sm text-pos-text">Aucun bon de commande trouvé</h3>
                  <p className="text-xs text-pos-muted max-w-sm mx-auto">
                    Tous les réapprovisionnements en attente apparaîtront ici dès leur validation depuis le module Fournisseurs.
                    Astuce : le réapprovisionnement intelligent propose les quantités depuis les alertes de stock.
                  </p>
                  <button
                    onClick={() => openModal('vendor_procurement')}
                    className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-lg transition cursor-pointer min-h-[44px]"
                  >
                    Lancer un Réapprovisionnement Intelligent
                  </button>
                </div>
              ) : (
                (filteredPOs || []).map((po) => {
                  const isExpanded = expandedPoId === po.id;
                  const isWaiting = po.status === 'Waiting List' || po.status === 'Draft' || po.status === 'Partially Received';
                  const totalUnits = (po.items || []).reduce((sum, item) => sum + item.suggestedQty, 0);
                  const receivedUnits = (po.items || []).reduce((sum, item) => sum + (item.receivedQty || 0), 0);
                  // Ancienneté relative calculée du createdAt déjà présent (affichage seul).
                  const poCreatedMs = parseIsoMs(po.createdAt);
                  const poAgeLabel = formatAgeFr(poCreatedMs, nowMs);
                  const poAgeTone = ageTone(poCreatedMs, nowMs);

                  return (
                    <div
                      key={po.id}
                      className={`bg-pos-card border border-pos-border rounded-xl overflow-hidden transition-all duration-150 shadow-sm ${
                        isWaiting ? 'border-amber-500/40 hover:border-amber-500/60' : 'border-pos-border'
                      }`}
                    >
                      {/* Ticket Header Bar */}
                      <div className="p-4 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3 bg-pos-panel/60">
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm ${
                              po.status === 'Completed' || po.status === 'Received'
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : po.status === 'Partially Received'
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : 'bg-amber-500/20 text-amber-400'
                            }`}
                          >
                            <Truck className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono font-black text-sm text-pos-text">{po.poNumber}</span>
                              <span className="font-extrabold text-sm text-amber-300">• {po.vendorName}</span>
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                                  po.status === 'Completed' || po.status === 'Received'
                                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                                    : po.status === 'Partially Received'
                                    ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
                                    : 'bg-amber-500/15 border border-amber-500/30 text-amber-300 animate-pulse'
                                }`}
                              >
                                {po.status === 'Waiting List' ? 'En Liste d\'Attente' : po.status}
                              </span>
                              {poAgeLabel && (
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${AGE_TONE_CLASSES[poAgeTone]}`}
                                  title={`Créé le ${formatDateTime(po.createdAt)}`}
                                >
                                  🕓 {poAgeLabel}
                                </span>
                              )}
                            </div>
                            <span className="text-[11px] text-pos-muted">
                              Créé le : {formatDateTime(po.createdAt)} • {po.items.length} références ({receivedUnits}/{totalUnits} pcs reçues)
                            </span>
                          </div>
                        </div>

                        {/* Cost & Actions — primary Réceptionner kept visible, 5 icon actions in portaled ••• */}
                        <div className="flex items-center gap-2 w-full lg:w-auto justify-between lg:justify-end">
                          <div className="text-right pr-2">
                            <span className="text-[9px] uppercase font-bold text-pos-muted block">Total Estimé</span>
                            <span className="text-base font-black text-emerald-400 font-mono">
                              {formatDZD(po.totalAmount)}
                            </span>
                          </div>

                          {/* Quick Receive Button */}
                          {isWaiting && (
                            <button
                              onClick={() => handleOpenReceivingModal(po)}
                              className="min-h-[44px] px-3.5 py-2 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white text-xs font-black rounded-lg flex items-center gap-1.5 shadow-md shadow-emerald-900/20 transition cursor-pointer"
                              title="Vérifier et Réceptionner les marchandises en stock"
                              aria-label={`Réceptionner le bon ${po.poNumber}`}
                            >
                              <PackageCheck className="w-4 h-4" />
                              <span>Réceptionner</span>
                            </button>
                          )}

                          {/* Compact 32px visual / 44px hitbox meatball — portaled menu, never clipped */}
                          <button
                            type="button"
                            ref={setOverflowAnchor(`po:${po.id}`)}
                            onClick={() => setOverflowKey((k) => (k === `po:${po.id}` ? null : `po:${po.id}`))}
                            className="min-h-[44px] min-w-[44px] w-11 h-11 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text font-bold text-sm flex items-center justify-center transition cursor-pointer shrink-0"
                            aria-expanded={overflowKey === `po:${po.id}`}
                            aria-haspopup="menu"
                            aria-label={`Plus d'actions pour le bon ${po.poNumber}`}
                            title={`Plus d'actions pour le bon ${po.poNumber}`}
                          >
                            <MoreHorizontal className="w-4 h-4" />
                          </button>

                          {/* Toggle expand */}
                          <button
                            onClick={() => setExpandedPoId(isExpanded ? null : po.id)}
                            className="min-h-[44px] min-w-[44px] flex items-center justify-center bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer shrink-0"
                            aria-label={isExpanded ? `Replier le détail du bon ${po.poNumber}` : `Déplier le détail du bon ${po.poNumber}`}
                            title={isExpanded ? 'Replier le détail' : 'Déplier le détail'}
                          >
                            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      {/* Expandable Line Items Table */}
                      {isExpanded && (
                        <div className="p-4 border-t border-pos-border bg-pos-bg space-y-2 animate-in fade-in">
                          <h4 className="text-xs font-bold text-pos-muted uppercase tracking-wider">
                            Détail des Articles Commandés ({po.items.length}) :
                          </h4>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs text-left">
                              <thead>
                                <tr className="border-b border-pos-border text-pos-muted uppercase text-[10px]">
                                  <th className="py-2 px-3">Article / SKU</th>
                                  <th className="py-2 px-2 text-center">Qté Demandée</th>
                                  <th className="py-2 px-2 text-center">Qté Reçue</th>
                                  <th className="py-2 px-3 text-right">Prix Achat Unitaire</th>
                                  <th className="py-2 px-3 text-right">Total Ligne</th>
                                  <th className="py-2 px-3 text-center">Statut Ligne</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-pos-border/40 font-mono">
                                {(po.items || []).map((item) => (
                                  <tr key={item.productId} className="hover:bg-pos-card/50">
                                    <td className="py-2 px-3">
                                      <span className="font-sans font-bold text-pos-text block">{item.title}</span>
                                      <span className="text-[10px] text-pos-muted font-mono">{item.sku}</span>
                                    </td>
                                    <td className="py-2 px-2 text-center font-bold text-pos-text">{item.suggestedQty} pcs</td>
                                    <td className="py-2 px-2 text-center font-bold text-emerald-400">{item.receivedQty || 0} pcs</td>
                                    <td className="py-2 px-3 text-right">{formatDZD(item.unitCost)}</td>
                                    <td className="py-2 px-3 text-right font-black text-pos-text">{formatDZD(item.unitCost * item.suggestedQty)}</td>
                                    <td className="py-2 px-3 text-center font-sans">
                                      <span
                                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                          item.status === 'Received'
                                            ? 'bg-emerald-500/20 text-emerald-400'
                                            : item.status === 'Partially Received'
                                            ? 'bg-emerald-500/15 text-emerald-300'
                                            : item.status === 'Discrepancy'
                                            ? 'bg-red-500/20 text-red-400'
                                            : 'bg-amber-500/20 text-amber-300'
                                        }`}
                                      >
                                        {item.status || 'En attente'}
                                      </span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* TAB 2: HELD SALES (PANIERS EN ATTENTE) */}
          {activeTab === 'held_sales' && (
            <div className="space-y-3">
              {filteredHeldSales.length === 0 ? (
                <div className="p-12 text-center bg-pos-card border border-pos-border rounded-xl shadow-sm space-y-3">
                  <ShoppingBag className="w-12 h-12 text-pos-muted mx-auto opacity-40" />
                  <h3 className="font-bold text-sm text-pos-text">Aucun panier en attente</h3>
                  <p className="text-xs text-pos-muted max-w-sm mx-auto">
                    En plein rush, appuyez sur <span className="text-emerald-400 font-bold">F6</span> pour suspendre
                    le panier en cours et servir le client suivant. Les tickets sont conservés 48 h.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {(filteredHeldSales || []).map((hs) => {
                    const custName = hs.customer?.name || 'Client Comptant (Passage)';
                    const totalAmount = (hs.items || []).reduce(
                      (sum, item) => sum + (item.appliedPrice || item.product.price) * item.quantity - (item.discount || 0),
                      0
                    );
                    // Ancienneté déduite de l'expiresAt (TTL 48 h) — affichage seul.
                    const hsCreatedMs = heldSaleCreatedAtMs(hs);
                    const hsAgeLabel = formatAgeFr(hsCreatedMs, nowMs);
                    const hsAgeTone = ageTone(hsCreatedMs, nowMs);

                    return (
                      <div
                        key={hs.id}
                        className="bg-pos-card border border-pos-border border-emerald-500/30 hover:border-emerald-500/60 rounded-xl p-4 space-y-3 shadow-sm transition"
                      >
                        <div className="flex items-center justify-between pb-2 border-b border-pos-border">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center font-bold">
                              <ShoppingBag className="w-4 h-4" />
                            </div>
                            <div>
                              <h4 className="font-black text-sm text-pos-text">{custName}</h4>
                              <span className="text-[10px] text-pos-muted flex items-center gap-1 flex-wrap">
                                <Clock className="w-3 h-3 text-emerald-400" /> {hs.timestamp}
                                {hsAgeLabel && (
                                  <span
                                    className={`px-1.5 py-px rounded-full text-[9px] font-bold border whitespace-nowrap ${AGE_TONE_CLASSES[hsAgeTone]}`}
                                    title="Ancienneté du ticket suspendu"
                                  >
                                    {hsAgeLabel}
                                  </span>
                                )}
                              </span>
                            </div>
                          </div>
                          <span className="font-mono font-black text-base text-emerald-400">{formatDZD(totalAmount)}</span>
                        </div>

                        {/* Items list preview */}
                        <div className="space-y-1 max-h-32 overflow-y-auto overscroll-contain pr-1 text-xs">
                          {(hs.items || []).map((it) => (
                            <div key={it.product.id} className="flex justify-between text-pos-muted">
                              <span className="truncate pr-2 font-medium">
                                {it.quantity}x {it.product.title}
                              </span>
                              <span className="font-mono">{formatDZD((it.appliedPrice || it.product.price) * it.quantity)}</span>
                            </div>
                          ))}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center justify-between pt-2 border-t border-pos-border">
                          <button
                            onClick={() => handleDeleteHeldSaleClick(hs.id)}
                            className="min-h-[44px] px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-bold rounded-lg transition cursor-pointer"
                          >
                            Supprimer
                          </button>
                            <button
                              onClick={() => handleRestoreHeldSaleClick(hs.id)}
                              className="min-h-[44px] px-4 py-2 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-black text-xs rounded-lg flex items-center gap-1.5 shadow-md shadow-emerald-900/30 transition cursor-pointer"
                            >
                              <Play className="w-3.5 h-3.5" />
                              <span>Reprendre la Vente (F6)</span>
                            </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: SAV & REPAIR WORK ORDERS IN QUEUE */}
          {activeTab === 'repairs' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
                <button
                  type="button"
                  onClick={() => setShowRepairArchive(false)}
                  className={`min-h-[44px] px-3 rounded-lg text-xs font-bold border transition shrink-0 ${!showRepairArchive ? 'bg-emerald-500 text-slate-950 border-emerald-400' : 'bg-pos-card text-pos-muted border-pos-border'}`}
                >
                  File active
                </button>
                <button
                  type="button"
                  onClick={() => setShowRepairArchive(true)}
                  className={`min-h-[44px] px-3 rounded-lg text-xs font-bold border transition shrink-0 ${showRepairArchive ? 'bg-emerald-500 text-slate-950 border-emerald-400' : 'bg-pos-card text-pos-muted border-pos-border'}`}
                >
                  Archive (Livrés / Annulés)
                </button>
              </div>
              {filteredRepairs.length === 0 ? (
                <div className="p-12 text-center bg-pos-card border border-pos-border rounded-xl shadow-sm space-y-3">
                  <Wrench className="w-12 h-12 text-pos-muted mx-auto opacity-40" />
                  <h3 className="font-bold text-sm text-pos-text">{showRepairArchive ? 'Archive vide' : 'Aucun ticket SAV en attente'}</h3>
                  <p className="text-xs text-pos-muted max-w-sm mx-auto">
                    Créez des ordres de réparation et imprimez les étiquettes SAV depuis le bouton Réparation du menu supérieur.
                    Les tickets « En cours » et « En attente de pièces » apparaissent ici avec leur ancienneté.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {(filteredRepairs || []).map((repair) => {
                    // Ancienneté relative calculée du createdAt déjà présent (affichage seul).
                    const repCreatedMs = parseIsoMs(repair.createdAt);
                    const repAgeLabel = formatAgeFr(repCreatedMs, nowMs);
                    const repAgeTone = ageTone(repCreatedMs, nowMs);
                    return (
                    <div
                      key={repair.id}
                      className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-sm hover:border-emerald-500/40 transition"
                    >
                      <div className="flex items-center justify-between pb-2 border-b border-pos-border">
                        <div>
                          <span className="font-mono font-black text-xs text-emerald-400 block">
                            #{repair.ticketNumber}
                          </span>
                          <h4 className="font-bold text-sm text-pos-text">{repair.deviceModel}</h4>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                        <span
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold border ${REPAIR_STATUS_BADGE_TOKENS[repair.status] ?? 'bg-amber-500/20 text-amber-300 border-amber-500/40'}`}
                        >
                          {repair.status}
                        </span>
                        {repAgeLabel && (
                          <span
                            className={`px-2 py-px rounded-full text-[9px] font-bold border whitespace-nowrap ${AGE_TONE_CLASSES[repAgeTone]}`}
                            title="Ancienneté du ticket SAV"
                          >
                            🕓 {repAgeLabel}
                          </span>
                        )}
                        </div>
                      </div>

                      <div className="space-y-1 text-xs">
                        <p className="text-pos-muted">
                          <span className="font-semibold text-pos-text">Client :</span> {repair.customerName} ({repair.customerPhone})
                        </p>
                        <p className="text-pos-muted">
                          <span className="font-semibold text-pos-text">Problème :</span> {repair.problemDescription}
                        </p>
                        {repair.imei && (
                          <p className="text-[10px] text-pos-muted font-mono">IMEI: {repair.imei}</p>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-pos-border">
                        <div>
                          <span className="text-[9px] uppercase font-bold text-pos-muted block">Devis Total</span>
                          <span className="font-mono font-black text-sm text-pos-text">{formatDZD(repair.totalCost)}</span>
                          {repair.status === 'Prêt / Terminé' && repairRemainingBalance(repair) > 0 && (
                            <span className="text-[10px] text-amber-300 font-bold block">Reste: {formatDZD(repairRemainingBalance(repair))}</span>
                          )}
                        </div>

                        {/* Status actions — primary kept visible, archive/secondary in portaled ••• */}
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {repair.status === 'Prêt / Terminé' && (
                            <button
                              onClick={() => void handleSettleAndDeliver(repair.id, repair.ticketNumber)}
                              className="min-h-[44px] px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-lg text-xs font-black transition cursor-pointer active:scale-95"
                              title="Injecter le solde au panier ou livrer si soldé"
                              aria-label={`Régler & Livrer le ticket ${repair.ticketNumber}`}
                            >
                              Régler & Livrer
                            </button>
                          )}
                          {repair.status !== 'Prêt / Terminé' && repair.status !== 'Livré' && repair.status !== 'Annulé' && (
                            <button
                              onClick={() => {
                                updateRepairOrderStatus(repair.id, 'Prêt / Terminé');
                                showToast(`Ticket SAV #${repair.ticketNumber} marqué comme Prêt / Terminé !`, 'success');
                              }}
                              className="min-h-[44px] px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition cursor-pointer"
                            >
                              Marquer Prêt
                            </button>
                          )}
                          <button
                            type="button"
                            ref={setOverflowAnchor(`repair:${repair.id}`)}
                            onClick={() => setOverflowKey((k) => (k === `repair:${repair.id}` ? null : `repair:${repair.id}`))}
                            className="min-h-[44px] min-w-[44px] w-11 h-11 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text font-bold text-sm flex items-center justify-center transition cursor-pointer shrink-0"
                            aria-expanded={overflowKey === `repair:${repair.id}`}
                            aria-haspopup="menu"
                            aria-label={`Plus d'actions pour le ticket SAV ${repair.ticketNumber}`}
                            title={`Plus d'actions pour le ticket SAV ${repair.ticketNumber}`}
                          >
                            <MoreHorizontal className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* RECEPTION VERIFICATION SUB-MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {receivingPO && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-[60] flex items-center justify-center p-4">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col max-h-[90dvh]">
              <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
                    <PackageCheck className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-black text-sm text-pos-text">
                      Réception & Contrôle Marchandises • Bon #{receivingPO.poNumber}
                    </h3>
                    <p className="text-[10px] text-pos-muted">Fournisseur : {receivingPO.vendorName}</p>
                  </div>
                </div>
                <button
                  onClick={() => setReceivingPO(null)}
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer shrink-0"
                  aria-label="Fermer la réception"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-4 overflow-y-auto overscroll-contain space-y-3">
                <p className="text-xs text-pos-muted">
                  Vérifiez les quantités réelles livrées et ajustez les prix d'achat en cas de fluctuation fournisseur. Les stocks de la caisse seront automatiquement incrémentés.
                </p>

                <div className="bg-pos-card border border-pos-border rounded-xl p-3 text-xs">
                  <label className="text-[9px] uppercase font-bold text-pos-muted block">N° Facture / BL Fournisseur :</label>
                  <input
                    type="text"
                    value={supplierInvoiceNo}
                    onChange={(e) => setSupplierInvoiceNo(e.target.value)}
                    placeholder="Ex: FA-2026-0451"
                    aria-label="N° Facture / BL Fournisseur"
                    className="mt-1 w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-emerald-500 min-h-[44px]"
                  />
                </div>

                <div className="space-y-2">
                  {(receivingPO?.items || []).map((item) => {
                    const currentQty = verifiedQtyMap[item.productId] !== undefined ? verifiedQtyMap[item.productId] : item.suggestedQty;
                    const currentCost = verifiedCostMap[item.productId] !== undefined ? verifiedCostMap[item.productId] : item.unitCost;

                    return (
                      <div
                        key={item.productId}
                        className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-2 text-xs"
                      >
                        <div className="flex justify-between items-start">
                          <div>
                            <span className="font-bold text-pos-text block">{item.title}</span>
                            <span className="text-[10px] text-pos-muted font-mono">
                              SKU: {item.sku} • Commandé: {item.suggestedQty} pcs
                            </span>
                          </div>
                          <span className="font-mono font-black text-emerald-400">
                            {formatDZD(currentCost * currentQty)}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 gap-2 pt-1">
                          <div>
                            <label className="text-[9px] uppercase font-bold text-pos-muted block">Qté Reçue :</label>
                            <input
                              type="number"
                              min="0"
                              value={currentQty}
                              onChange={(e) => {
                                const val = parseInt(e.target.value) || 0;
                                setVerifiedQtyMap((prev) => ({ ...prev, [item.productId]: val }));
                              }}
                              aria-label={`Qté Reçue pour ${item.title}`}
                              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-emerald-500 min-h-[44px]"
                            />
                          </div>

                          <div>
                            <label className="text-[9px] uppercase font-bold text-pos-muted block">Prix Achat Réel (DA) :</label>
                            <input
                              type="number"
                              min="0"
                              value={currentCost}
                              onChange={(e) => {
                                const val = parseFloat(e.target.value) || 0;
                                setVerifiedCostMap((prev) => ({ ...prev, [item.productId]: val }));
                              }}
                              aria-label={`Prix Achat Réel (DA) pour ${item.title}`}
                              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-emerald-500 min-h-[44px]"
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Expense recording toggle */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-2 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                    <input
                      type="checkbox"
                      checked={autoRecordExpense}
                      onChange={(e) => setAutoRecordExpense(e.target.checked)}
                      className="rounded text-emerald-500 focus:ring-0 w-4 h-4 cursor-pointer"
                    />
                    <span className="font-bold text-pos-text">
                      Enregistrer automatiquement comme Dépense Fournisseur (EBITDA / Trésorerie)
                    </span>
                  </label>

                  {autoRecordExpense && (
                    <div className="flex items-center gap-2 pt-2 border-t border-pos-border/40 flex-wrap">
                      <span className="text-[10px] text-pos-muted font-bold">Règlement Dépense :</span>
                      {(['Espèces', 'BaridiMob', 'Chèque'] as PaymentMethodType[]).map((meth) => (
                        <button
                          key={meth}
                          type="button"
                          onClick={() => setExpensePaymentMethod(meth)}
                          className={`min-h-[44px] px-2.5 py-1 rounded-lg text-[10.5px] font-bold border transition cursor-pointer ${
                            expensePaymentMethod === meth
                              ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-sm'
                              : 'bg-pos-bg text-pos-muted border-pos-border'
                          }`}
                        >
                          {meth}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="p-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 shrink-0">
                <button
                  onClick={() => setReceivingPO(null)}
                  className="min-h-[44px] px-4 py-2 text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer rounded-lg"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (!receivingPO) return;
                    setReceptionSnapshot({
                      receivedQty: { ...verifiedQtyMap },
                      actualCosts: { ...verifiedCostMap },
                      reasons: { ...discrepancyReasons },
                      supplierInvoice: supplierInvoiceNo.trim() || undefined,
                      receivedAt: new Date().toISOString(),
                    });
                    setPrintingPO(receivingPO);
                    const { printCoordinator } = await import('../../utils/printCoordinator');
                    const printed = printCoordinator.printPurchaseOrder(100);
                    if (!printed) {
                      const { openNativePrint } = await import('../../utils/phoneUtils');
                      const { purchaseOrderText } = await import('../../utils/mobileDocPrint');
                      await openNativePrint(
                          `PV Réception ${receivingPO.poNumber}`,
                          purchaseOrderText(receivingPO, receiptSettings)
                        );
                      }
                      showToast(`PV de réception Bon #${receivingPO.poNumber} lancé.`, 'info');
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-lg bg-transparent hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text text-xs font-bold transition cursor-pointer flex items-center justify-center gap-1.5"
                  title="Imprimer le Bon de Réception et Contrôle (quantités vérifiées, sans valider le stock)"
                  aria-label={`PV Réception — Imprimer le PV de réception du bon ${receivingPO.poNumber}`}
                >
                  <Printer className="w-4 h-4" /> PV Réception
                </button>
                <button
                  onClick={handleConfirmReception}
                  disabled={isProcessing}
                  className="min-h-[44px] px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-black text-xs rounded-lg shadow-lg transition cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{isProcessing ? 'Validation...' : 'Valider Entrée en Stock'}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL FOOTER */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="px-6 py-3.5 bg-pos-card/80 border-t border-pos-border flex items-center justify-between shrink-0">
          <span className="text-xs text-pos-muted">
            • Tous les tickets et bons de commande sont synchronisés en temps réel avec la base SQLite WAL.
          </span>
          <button
            onClick={closeModal}
            className="min-h-[44px] px-5 py-2 rounded-lg text-xs font-bold bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text transition cursor-pointer shrink-0"
          >
            Fermer (Échap)
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* INTERACTIVE A4 DOCUMENT PREVIEW MODAL */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {previewingPO && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-md flex flex-col items-center justify-center p-3 sm:p-6 animate-in fade-in">
          <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-4xl max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
            {/* Header bar */}
            <div className="p-4 border-b border-pos-border bg-pos-card flex flex-wrap items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
                  <FileText className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-pos-text">Aperçu Bon de Commande #{previewingPO.poNumber}</h3>
                  <p className="text-[11px] text-pos-muted">Fournisseur : {previewingPO.vendorName}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handlePrintPO(previewingPO)}
                  className="min-h-[44px] px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-1.5 transition cursor-pointer shadow-md"
                  aria-label={`Imprimer / PDF A4 le bon ${previewingPO.poNumber}`}
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Imprimer / PDF A4</span>
                </button>
                <button
                  type="button"
                  ref={setOverflowAnchor(`preview:${previewingPO.poNumber}`)}
                  onClick={() =>
                    setOverflowKey((k) => (k === `preview:${previewingPO.poNumber}` ? null : `preview:${previewingPO.poNumber}`))
                  }
                  className="min-h-[44px] min-w-[44px] w-11 h-11 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text font-bold text-sm flex items-center justify-center transition cursor-pointer shrink-0"
                  aria-expanded={overflowKey === `preview:${previewingPO.poNumber}`}
                  aria-haspopup="menu"
                  aria-label={`Plus d'exports pour le bon ${previewingPO.poNumber}`}
                  title={`Plus d'exports pour le bon ${previewingPO.poNumber}`}
                >
                  <MoreHorizontal className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewingPO(null)}
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center text-pos-muted hover:text-pos-text rounded-lg hover:bg-pos-hover transition cursor-pointer shrink-0"
                  title="Fermer l'aperçu"
                  aria-label="Fermer l'aperçu du bon de commande"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Body containing the realistic A4 paper */}
            <div className="flex-1 overflow-y-auto overscroll-contain p-4 sm:p-8 bg-slate-950/60 flex justify-center">
              <div className="w-full max-w-[210mm]">
                <PurchaseOrderA4Document po={previewingPO} receiptSettings={receiptSettings} previewMode={true} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modern full-page A4 Purchase Order (Bon de commande) — print / Save as PDF */}
      {printingPO && (
        <div className="print-po-target po-a4 hidden print:block bg-white text-black font-sans text-xs">
          <PurchaseOrderA4Document po={printingPO} receiptSettings={receiptSettings} reception={receptionSnapshot} />
        </div>
      )}

      {/* Portaled overflow menus — fixed to viewport, never clipped by cards */}
      {overflowKey &&
        createPortal(
          <>
            <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={() => setOverflowKey(null)} aria-hidden="true" />
            <div
              ref={overflowMenuRef}
              role="menu"
              aria-label={overflowKey.startsWith('po:') ? `Actions bon ${overflowKey.slice(3)}` : overflowKey.startsWith('repair:') ? 'Actions ticket SAV' : overflowKey.startsWith('preview:') ? 'Exports bon de commande' : 'Plus d’actions'}
              style={{ position: 'fixed', top: overflowPos.top, left: overflowPos.left, zIndex: 9999 }}
              className="w-[calc(100vw-16px)] sm:w-72 bg-pos-panel border border-pos-border rounded-lg shadow-md overflow-hidden animate-in fade-in zoom-in-95"
              data-open-up={overflowPos.openUp ? 'true' : 'false'}
            >
              {overflowKey.startsWith('po:') &&
                (() => {
                  const po = (purchaseOrders || []).find((p) => `po:${p.id}` === overflowKey);
                  if (!po) return null;
                  return (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOverflowKey(null);
                          handleSendWhatsApp(po);
                        }}
                        className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-emerald-400 hover:bg-emerald-500/10 transition text-left"
                        aria-label={`WhatsApp fournisseur — Envoyer le bon ${po.poNumber} via WhatsApp`}
                      >
                        <MessageSquare className="w-4 h-4 shrink-0" /> WhatsApp fournisseur
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOverflowKey(null);
                          setPreviewingPO(po);
                        }}
                        className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-pos-text hover:bg-pos-hover transition text-left"
                        aria-label={`Aperçu A4 Pro du bon ${po.poNumber}`}
                      >
                        <Eye className="w-4 h-4 shrink-0" /> Aperçu A4 Pro
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const target = po;
                          setOverflowKey(null);
                          void handlePrintPO(target);
                        }}
                        className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-pos-text hover:bg-pos-hover transition text-left"
                        aria-label={`Imprimer (A4 PDF) le bon ${po.poNumber}`}
                      >
                        <Printer className="w-4 h-4 shrink-0" /> Imprimer (A4 PDF)
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const target = po;
                          setOverflowKey(null);
                          handleExportExcel(target);
                        }}
                        className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-pos-text hover:bg-pos-hover transition text-left"
                        aria-label={`Export Excel (.xlsx) — Exporter le bon ${po.poNumber} en Excel`}
                      >
                        <Download className="w-4 h-4 shrink-0" /> Export Excel (.xlsx)
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const target = po;
                          setOverflowKey(null);
                          void handleDeleteOrCancelPO(target);
                        }}
                        className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-red-400 hover:bg-red-500/10 transition text-left"
                        aria-label={`Annuler / Supprimer le bon ${po.poNumber}`}
                      >
                        <Trash2 className="w-4 h-4 shrink-0" /> Annuler / Supprimer
                      </button>
                    </>
                  );
                })()}
              {overflowKey === 'header:waiting' && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOverflowKey(null);
                    openModal('purchase_order');
                  }}
                  className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-pos-text hover:bg-pos-hover transition text-left"
                  aria-label="Bons Détaillés — Ouvrir les bons de commande détaillés"
                >
                  <FileText className="w-4 h-4 shrink-0" /> Bons Détaillés
                </button>
              )}
              {overflowKey.startsWith('repair:') &&
                (() => {
                  const repair = (repairOrders || []).find((r) => `repair:${r.id}` === overflowKey);
                  if (!repair) return null;
                  return (
                    <>
                      {repair.status === 'Livré' && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setOverflowKey(null);
                            setPendingRepairPrint({ orderId: repair.id, kind: 'restitution' });
                            openModal('repair_work_order');
                          }}
                          className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-pos-text hover:bg-pos-hover transition text-left"
                          aria-label={`Fiche Restitution du ticket ${repair.ticketNumber}`}
                        >
                          <Printer className="w-4 h-4 shrink-0" /> Fiche Restitution
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOverflowKey(null);
                          openModal('repair_work_order');
                        }}
                        className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-pos-text hover:bg-pos-hover transition text-left"
                        aria-label={`Dossier SAV complet — Ouvrir le dossier SAV du ticket ${repair.ticketNumber}`}
                      >
                        <ExternalLink className="w-4 h-4 shrink-0" /> Dossier SAV complet
                      </button>
                    </>
                  );
                })()}
              {overflowKey.startsWith('preview:') && previewingPO && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const target = previewingPO;
                    setOverflowKey(null);
                    handleExportExcel(target);
                  }}
                  className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-2 text-xs font-bold text-pos-text hover:bg-pos-hover transition text-left"
                  aria-label={`Excel (.xlsx stylé) — Exporter le bon ${previewingPO.poNumber} en Excel`}
                >
                  <Download className="w-4 h-4 shrink-0" /> Excel (.xlsx stylé)
                </button>
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
};

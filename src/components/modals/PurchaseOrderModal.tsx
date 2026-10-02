import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  FileText,
  CheckCircle2,
  Printer,
  Smartphone,
  Clock,
  PackageCheck,
  AlertTriangle,
  Plus,
  Minus,
  Check,
  Ban,
  ShieldCheck,
  Truck,
  Search,
  Trash2,
  ShoppingCart,
  Calendar,
  Building2,
  Sparkles,
  Layers,
  Download,
  Eye,
  MoreHorizontal,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import { parseLocalizedAmount } from '../../utils/moneyInput';
import type { PurchaseOrder, PaymentMethodType, Product } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { printCoordinator } from '../../utils/printCoordinator';
import { isMobileDevice } from '../../utils/platform';
import { PurchaseOrderA4Document } from './PurchaseOrderA4Document';

interface DraftPOLineItem {
  productId: string;
  title: string;
  sku: string;
  currentStock: number;
  qty: number;
  unitCost: number;
}

export const PurchaseOrderModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    activeDraftPO,
    purchaseOrders,
    validateAndReceivePO,
    cancelPO,
    receiptSettings,
    products,
    createManualPurchaseOrder,
    poDraftBuilderRequested,
    consumePoDraftBuilder,
  } = usePosStore();
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<'waiting_list' | 'new_po' | 'active_po' | 'completed' | 'preview_a4'>('waiting_list');
  const [inspectingPO, setInspectingPO] = useState<PurchaseOrder | null>(null);

  // New Flexible PO Draft State
  const [newVendorName, setNewVendorName] = useState('');
  const [newOrderDate, setNewOrderDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [newOrderNotes, setNewOrderNotes] = useState('');
  const [newPoItems, setNewPoItems] = useState<DraftPOLineItem[]>([]);
  const [catalogSearchTerm, setCatalogSearchTerm] = useState('');
  const [catalogFilterMode, setCatalogFilterMode] = useState<'all' | 'suggested'>('all');
  const [isSubmittingPO, setIsSubmittingPO] = useState(false);

  const [verifiedQtyMap, setVerifiedQtyMap] = useState<Record<string, number>>({});
  const [verifiedCostMap, setVerifiedCostMap] = useState<Record<string, number>>({});
  const [discrepancyReasons, setDiscrepancyReasons] = useState<Record<string, string>>({});
  const [imeisMap, setImeisMap] = useState<Record<string, string>>({});
  const [autoRecordExpense, setAutoRecordExpense] = useState<boolean>(true);
  const [expensePaymentMethod, setExpensePaymentMethod] = useState<PaymentMethodType>('Espèces');
  const [isProcessing, setIsProcessing] = useState(false);

  // Newest-first ordering (creation timestamp DESC) — newest PO at the top.
  const byCreatedDesc = (a: PurchaseOrder, b: PurchaseOrder) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  };

  const waitingListOrders = (purchaseOrders || [])
    .filter(
      (po) => po.status === 'Waiting List' || po.status === 'Partially Received' || po.status === 'Draft'
    )
    .sort(byCreatedDesc);
  const completedOrders = (purchaseOrders || [])
    .filter((po) => po.status === 'Completed' || po.status === 'Received')
    .sort(byCreatedDesc);

  const selectedPO = inspectingPO || activeDraftPO || waitingListOrders[0];

  // Memoized: only stable setters are used, so the deep-link
  // effect below never re-fires on unrelated re-renders.
  const handleOpenVerification = useCallback((po: PurchaseOrder) => {
    setInspectingPO(po);
    const initQty: Record<string, number> = {};
    const initCost: Record<string, number> = {};
    const initReasons: Record<string, string> = {};

    po.items.forEach((item) => {
      // Default to the REMAINING quantity (0 for already-complete lines):
      // defaulting to the full suggestedQty re-added complete lines on every
      // re-validation, double-counting stock + batches + ledger deltas
      // (receivedQty accumulates in validateAndReceivePO).
      const remainingQty = Math.max(0, item.suggestedQty - (item.receivedQty || 0));
      initQty[item.productId] = remainingQty;
      initCost[item.productId] = item.actualUnitCost || item.unitCost;
      initReasons[item.productId] = item.discrepancyReason || '';
    });

    setVerifiedQtyMap(initQty);
    setVerifiedCostMap(initCost);
    setDiscrepancyReasons(initReasons);
    setImeisMap({});
    setActiveTab('active_po');
  }, []);

  const handleVerifyAndReceive = async () => {
    if (!selectedPO) return;
    setIsProcessing(true);

    const verifiedItems = (selectedPO.items || []).map((item) => {
      const receivedQty = verifiedQtyMap[item.productId] !== undefined ? verifiedQtyMap[item.productId] : item.suggestedQty;
      const actualUnitCost = verifiedCostMap[item.productId] !== undefined ? verifiedCostMap[item.productId] : item.unitCost;
      const discrepancyReason = discrepancyReasons[item.productId] || '';
      const imeiString = imeisMap[item.productId] || '';
      const imeis = imeiString
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      return {
        productId: item.productId,
        receivedQty,
        actualUnitCost,
        imeis,
        discrepancyReason: receivedQty < item.suggestedQty && !discrepancyReason ? 'Quantité partielle reçue' : discrepancyReason,
      };
    });

    const poReceiptResult = await validateAndReceivePO({
      poId: selectedPO.id,
      verifiedItems,
      recordExpense: autoRecordExpense,
      expensePaymentMethod,
    });

    setIsProcessing(false);

    if (poReceiptResult.success) {
      if (poReceiptResult.isPartial) {
        showToast(
          `📦 Réception partielle validée pour Bon #${selectedPO.poNumber}. Le reliquat reste sur la Liste d'Attente.`,
          'info'
        );
      } else {
        showToast(
          `✅ Bon de commande #${selectedPO.poNumber} entièrement réceptionné & stock incrémenté !`,
          'success'
        );
      }

      if (autoRecordExpense && poReceiptResult.totalReceivedCost > 0) {
        showToast(`💶 Dépense fournisseur de ${formatDZD(poReceiptResult.totalReceivedCost)} enregistrée avec succès.`, 'success');
      }

      setInspectingPO(null);
      setActiveTab('waiting_list');
    } else if (poReceiptResult.reason === 'PO_ALREADY_COMPLETED') {
      showToast(`Bon #${selectedPO.poNumber} déjà entièrement réceptionné — réception verrouillée.`, 'warning');
    } else {
      showToast('Erreur lors de la validation du bon de commande.', 'error');
    }
  };

  const handlePrintPO = async (po?: PurchaseOrder) => {
    const targetPO = po || selectedPO;
    if (!targetPO) return;
    if (po && (!selectedPO || selectedPO.id !== po.id)) {
      setInspectingPO(po);
    }
    const printed = printCoordinator.printPurchaseOrder(80);
    if (!printed && isMobileDevice()) {
      const { openNativePrint } = await import('../../utils/phoneUtils');
      const { purchaseOrderText } = await import('../../utils/mobileDocPrint');
      await openNativePrint(`Bon ${targetPO.poNumber}`, purchaseOrderText(targetPO, receiptSettings));
    }
    showToast(`Impression Bon #${targetPO.poNumber} A4 lancée`, 'info');
  };

  const handleExportExcel = async (po?: PurchaseOrder) => {
    const targetPO = po || selectedPO;
    if (!targetPO) {
      showToast('Aucun bon de commande à exporter.', 'error');
      return;
    }
    try {
      const { downloadPurchaseOrderXlsx } = await import('../../utils/purchaseOrderXlsx');
      const filename = downloadPurchaseOrderXlsx(targetPO, {
        storeName: receiptSettings?.storeName,
        address: receiptSettings?.address,
        phone: receiptSettings?.phone,
        email: receiptSettings?.email,
      });
      showToast(`Bon #${targetPO.poNumber} exporté en Excel (${filename}).`, 'success');
    } catch (err) {
      console.error('Failed to export purchase order to Excel:', err);
      showToast('Échec de l’export Excel du bon de commande.', 'error');
    }
  };

  const handleCancelOrder = async (poId: string) => {
    if (confirm('Êtes-vous sûr de vouloir annuler ce bon de commande ?')) {
      await cancelPO(poId, 'Annulé par l\'administrateur');
      showToast('Bon de commande annulé avec succès.', 'info');
      setInspectingPO(null);
    }
  };

  const totalVerifiedUnits = selectedPO && selectedPO.items
    ? selectedPO.items.reduce((acc, item) => {
        const qty = verifiedQtyMap[item.productId] !== undefined ? verifiedQtyMap[item.productId] : item.suggestedQty;
        return acc + qty;
      }, 0)
    : 0;

  const totalVerifiedCostAmount = selectedPO && selectedPO.items
    ? selectedPO.items.reduce((acc, item) => {
        const qty = verifiedQtyMap[item.productId] !== undefined ? verifiedQtyMap[item.productId] : item.suggestedQty;
        const cost = verifiedCostMap[item.productId] !== undefined ? verifiedCostMap[item.productId] : item.unitCost;
        return acc + qty * cost;
      }, 0)
    : 0;

  const existingVendors = useMemo(() => {
    return Array.from(
      new Set([
        ...(products || []).map((p) => p.vendorName).filter(Boolean),
        ...(purchaseOrders || []).map((po) => po.vendorName).filter(Boolean),
      ])
    ) as string[];
  }, [products, purchaseOrders]);

  const lowStockProducts = useMemo(() => {
    return (products || []).filter((p) => (p.stock || 0) <= (p.reorderPoint || 5));
  }, [products]);

  const filteredCatalogProducts = useMemo(() => {
    const q = catalogSearchTerm.trim().toLowerCase();
    let base = catalogFilterMode === 'suggested' ? lowStockProducts : (products || []);
    if (!q) return base.slice(0, 24);
    return base
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          (p.sku && p.sku.toLowerCase().includes(q)) ||
          (p.barcode && p.barcode.toLowerCase().includes(q)) ||
          (p.brand && p.brand.toLowerCase().includes(q)) ||
          (p.category && p.category.toLowerCase().includes(q))
      )
      .slice(0, 30);
  }, [products, catalogSearchTerm, catalogFilterMode, lowStockProducts]);

  // Shared portaled meatball menu (one implementation reused per cluster,
  // anchor per trigger): createPortal to document.body, position:fixed, flip,
  // clamp, outside/Escape/scroll/resize dismiss. Anchors live inside
  // overflow scrollers so absolute children would be clipped.
  const [overflowMenu, setOverflowMenu] = useState<string | null>(null);
  const overflowAnchorRefs = useRef(new Map<string, HTMLButtonElement>());
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const [overflowPos, setOverflowPos] = useState<{ top: number; left: number; openUp: boolean }>({ top: 0, left: 0, openUp: false });

  useEffect(() => {
    if (!overflowMenu) return;
    const MENU_W = 288;
    const MENU_H_EST = 176;
    const place = () => {
      const anchor = overflowAnchorRefs.current.get(overflowMenu);
      const r = anchor?.getBoundingClientRect();
      if (!r) return;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < MENU_H_EST + 16;
      const top = openUp
        ? Math.max(8, r.top - MENU_H_EST - 8)
        : Math.min(r.bottom + 8, window.innerHeight - 16);
      const isMobile = window.innerWidth < 640;
      const left = isMobile
        ? 8
        : Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
      setOverflowPos({ top, left, openUp });
    };
    place();
    const handleClickOutside = (event: MouseEvent) => {
      const t = event.target as Node;
      const anchor = overflowAnchorRefs.current.get(overflowMenu);
      if (
        overflowMenuRef.current && !overflowMenuRef.current.contains(t) &&
        anchor && !anchor.contains(t)
      ) {
        setOverflowMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOverflowMenu(null);
        overflowAnchorRefs.current.get(overflowMenu)?.focus();
      }
    };
    const handleScroll = () => setOverflowMenu(null);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', handleScroll, true);
    overflowMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [overflowMenu]);

  // Escape dismissal for the modal itself (ignored while a meatball menu is open).
  useEffect(() => {
    if (activeModal !== 'purchase_order') return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !overflowMenu) {
        closeModal();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [activeModal, closeModal, overflowMenu]);

  // Deep-link: an externally-set activeDraftPO (replenishment
  // "Voir Commande" or a container-created draft) selects that
  // order and opens its contrôle/réception view. The ref records
  // the last seen id so normal entry points keep landing on the
  // waiting list and the switch fires exactly once per change.
  const lastDraftIdRef = useRef<string | null>(null);
  useEffect(() => {
    const draft = activeDraftPO;
    const currentId = draft?.id ?? null;
    if (draft && currentId !== null && currentId !== lastDraftIdRef.current) {
      lastDraftIdRef.current = currentId;
      handleOpenVerification(draft);
    } else {
      lastDraftIdRef.current = currentId;
    }
  }, [activeDraftPO, handleOpenVerification]);

  // Draft-builder intent: the replenishment "Générer un bon de
  // commande" shortcut requests the manual PO form directly.
  // Consumed here so the flag never re-fires on re-render.
  useEffect(() => {
    if (!poDraftBuilderRequested) return;
    consumePoDraftBuilder();
    setInspectingPO(null);
    setActiveTab('new_po');
  }, [poDraftBuilderRequested, consumePoDraftBuilder]);

  const setOverflowAnchor = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) {
      overflowAnchorRefs.current.set(key, el);
    } else {
      overflowAnchorRefs.current.delete(key);
    }
  };

  const toggleOverflowMenu = (key: string) => {
    setOverflowMenu((prev) => (prev === key ? null : key));
  };

  if (activeModal !== 'purchase_order') return null;

  const handleAddProductToDraft = (product: Product, customQty?: number) => {
    setNewPoItems((prev) => {
      const existing = prev.find((i) => i.productId === product.id);
      const cost = product.costPrice || 0;
      if (existing) {
        return prev.map((i) =>
          i.productId === product.id ? { ...i, qty: i.qty + (customQty || 1) } : i
        );
      }
      const initialQty =
        customQty ||
        (product.reorderPoint
          ? Math.max(1, product.reorderPoint * 2 - (product.stock || 0))
          : 1);
      return [
        ...prev,
        {
          productId: product.id,
          title: product.title,
          sku: product.sku || 'SKU-N/A',
          currentStock: product.stock || 0,
          qty: initialQty,
          unitCost: cost,
        },
      ];
    });
  };

  const handleRemoveItemFromDraft = (productId: string) => {
    setNewPoItems((prev) => prev.filter((i) => i.productId !== productId));
  };

  const handleUpdateDraftQty = (productId: string, qty: number) => {
    setNewPoItems((prev) =>
      prev.map((i) => (i.productId === productId ? { ...i, qty: Math.max(1, qty) } : i))
    );
  };

  const handleUpdateDraftCost = (productId: string, cost: number) => {
    setNewPoItems((prev) =>
      prev.map((i) => (i.productId === productId ? { ...i, unitCost: Math.max(0, cost) } : i))
    );
  };

  const handleQuickAddAllSuggested = () => {
    lowStockProducts.forEach((p) => {
      handleAddProductToDraft(p);
    });
    showToast(`${lowStockProducts.length} articles suggérés ajoutés au bon.`, 'info');
  };

  const handleCreateManualPO = async () => {
    const vendor = newVendorName.trim() || 'Fournisseur Général';
    if (newPoItems.length === 0) {
      showToast('Veuillez ajouter au moins un produit au bon de commande.', 'error');
      return;
    }
    setIsSubmittingPO(true);
    try {
      const fullNotes = newOrderNotes.trim()
        ? `${newOrderNotes.trim()} (Date: ${newOrderDate})`
        : `Date: ${newOrderDate}`;

      const created = await createManualPurchaseOrder(
        vendor,
        newPoItems.map((item) => ({
          productId: item.productId,
          qty: item.qty,
          unitCost: item.unitCost,
        })),
        fullNotes
      );

      showToast(
        `✅ Bon de commande #${created.poNumber} créé (${newPoItems.length} réf.). Mis en attente sur la Liste d'Attente.`,
        'success'
      );

      setNewPoItems([]);
      setNewVendorName('');
      setNewOrderNotes('');
      setCatalogSearchTerm('');
      setActiveTab('waiting_list');
    } catch (err) {
      console.error('Failed to create purchase order:', err);
      showToast('Erreur lors de la création du bon de commande.', 'error');
    } finally {
      setIsSubmittingPO(false);
    }
  };

  const totalDraftUnits = newPoItems.reduce((acc, i) => acc + i.qty, 0);
  const totalDraftCostAmount = newPoItems.reduce((acc, i) => acc + i.qty * i.unitCost, 0);

  return (
    <div
      onClick={closeModal}
      className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-0 sm:p-4 select-none cursor-pointer pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:pt-0 sm:pb-0"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border-0 sm:border border-pos-border rounded-none sm:rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-dvh-shell sm:h-[90dvh] flex flex-col cursor-default"
      >
        
        {/* Header */}
        <div className="p-3 sm:p-4 border-b border-pos-border bg-pos-card shrink-0 flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold shrink-0">
                <Truck className="w-4 h-4 sm:w-5 sm:h-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm sm:text-base font-black text-pos-text truncate">
                    Approvisionnement & Réceptions
                  </h2>
                  <span className="hidden sm:inline-block px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold text-[10px]">
                    Staged Procurement V2
                  </span>
                </div>
                <p className="text-[10px] sm:text-[11px] text-pos-muted truncate">
                  Contrôle qualité à la livraison et imputation des dépenses
                </p>
              </div>
            </div>

            <button
              onClick={closeModal}
              className="min-h-[40px] min-w-[40px] flex items-center justify-center hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition-colors cursor-pointer shrink-0"
              aria-label="Fermer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Navigation Tabs Bar */}
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar bg-pos-bg p-1 rounded-xl border border-pos-border text-xs">
            <button
              type="button"
              onClick={() => {
                setActiveTab('waiting_list');
                setInspectingPO(null);
              }}
              className={`min-h-[44px] px-3 py-1.5 rounded-lg font-bold flex items-center gap-1.5 transition cursor-pointer shrink-0 ${
                activeTab === 'waiting_list'
                  ? 'bg-amber-500 text-slate-950 shadow-md'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              En Attente ({waitingListOrders.length})
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('new_po');
                setInspectingPO(null);
              }}
              className={`min-h-[44px] px-3 py-1.5 rounded-lg font-bold flex items-center gap-1.5 transition cursor-pointer shrink-0 ${
                activeTab === 'new_po'
                  ? 'bg-emerald-500 text-slate-950 shadow-md'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              + Nouveau Bon {newPoItems.length > 0 && `(${newPoItems.length})`}
            </button>

            {selectedPO && (
              <button
                type="button"
                onClick={() => setActiveTab('active_po')}
                className={`min-h-[44px] px-3 py-1.5 rounded-lg font-bold flex items-center gap-1.5 transition cursor-pointer shrink-0 ${
                  activeTab === 'active_po'
                    ? 'bg-emerald-500 text-slate-950 shadow-md'
                    : 'text-pos-muted hover:text-pos-text'
                }`}
              >
                <PackageCheck className="w-3.5 h-3.5" />
                Contrôle & Réception
              </button>
            )}

            {selectedPO && (
              <button
                type="button"
                onClick={() => setActiveTab('preview_a4')}
                className={`min-h-[44px] px-3 py-1.5 rounded-lg font-bold flex items-center gap-1.5 transition cursor-pointer shrink-0 ${
                  activeTab === 'preview_a4'
                    ? 'bg-emerald-500 text-slate-950 shadow-md'
                    : 'text-pos-muted hover:text-pos-text'
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                Aperçu Document A4
              </button>
            )}

            <button
              type="button"
              onClick={() => setActiveTab('completed')}
              className={`min-h-[44px] px-3 py-1.5 rounded-lg font-bold flex items-center gap-1.5 transition cursor-pointer shrink-0 ${
                activeTab === 'completed'
                  ? 'bg-emerald-500 text-slate-950 shadow-md'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Historique ({completedOrders.length})
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-5 bg-pos-bg">
          {activeTab === 'waiting_list' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-black text-pos-text flex items-center gap-2">
                    <Clock className="w-4 h-4 text-amber-400" />
                    Commandes Fournisseurs en Cours d'Acheminement (Liste d'Attente)
                  </h3>
                  <p className="text-xs text-pos-muted">
                    Les articles commandés restent en attente jusqu'à leur vérification physique et validation en magasin.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('new_po')}
                  className="px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-md shadow-emerald-500/20 transition cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  + Nouveau Bon
                </button>
              </div>

              {waitingListOrders.length === 0 ? (
                <div className="text-center py-16 text-pos-muted bg-pos-card border border-pos-border rounded-xl shadow-sm max-w-md mx-auto p-6 space-y-3">
                  <CheckCircle2 className="w-12 h-12 mx-auto mb-1 opacity-40 text-emerald-400" />
                  <p className="text-sm font-bold text-pos-text">Aucun bon de commande en attente</p>
                  <p className="text-xs text-pos-muted">
                    Toutes les commandes fournisseurs passées ont été réceptionnées et intégrées au stock.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('new_po')}
                    className="mt-2 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs inline-flex items-center gap-1.5 shadow-md shadow-emerald-500/20 transition cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    Créer un Nouveau Bon
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {(waitingListOrders || []).map((po) => {
                    const totalUnits = (po.items || []).reduce((acc, i) => acc + i.suggestedQty, 0);
                    const receivedUnits = (po.items || []).reduce((acc, i) => acc + (i.receivedQty || 0), 0);
                    const isPartial = po.status === 'Partially Received';

                    return (
                      <div
                        key={po.id}
                        className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-sm hover:border-amber-500/40 transition flex flex-col justify-between"
                      >
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-black text-pos-text text-sm">#{po.poNumber}</span>
                                <span
                                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                                    isPartial
                                      ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30'
                                      : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                                  }`}
                                >
                                  {isPartial ? 'Réception Partielle' : 'En Attente de Livraison'}
                                </span>
                              </div>
                              <p className="text-xs font-bold text-emerald-400 mt-0.5">{po.vendorName}</p>
                              <p className="text-[10px] text-pos-muted">Date: {formatDateTime(po.createdAt)}</p>
                            </div>

                            <div className="text-right">
                              <span className="text-xs text-pos-muted block">Budget Estimé</span>
                              <span className="text-base font-black text-pos-text">{formatDZD(po.totalAmount)}</span>
                            </div>
                          </div>

                          <div className="mt-3 bg-pos-bg p-2.5 rounded-xl border border-pos-border text-xs space-y-1">
                            <div className="flex justify-between text-[10px] font-bold text-pos-muted uppercase border-b border-pos-border/40 pb-1">
                              <span>{(po.items || []).length} Références Commandées</span>
                              <span>
                                {receivedUnits} / {totalUnits} unités reçues
                              </span>
                            </div>
                            <div className="max-h-24 overflow-y-auto overscroll-contain space-y-1 pt-1">
                              {(po.items || []).map((item) => (
                                <div key={item.productId} className="flex justify-between text-[11px]">
                                  <span className="text-pos-text truncate max-w-[200px]">{item.title}</span>
                                  <span className="font-mono text-emerald-400 font-bold">
                                    {item.receivedQty || 0} / {item.suggestedQty} un.
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-pos-border gap-2 flex-wrap">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <button
                              type="button"
                              onClick={() => handleCancelOrder(po.id)}
                              className="min-h-[44px] px-2.5 py-1.5 rounded-lg bg-pos-bg hover:bg-rose-500/10 text-pos-muted hover:text-rose-400 text-xs font-semibold flex items-center gap-1 transition cursor-pointer"
                              title="Annuler ce bon"
                            >
                              <Ban className="w-3.5 h-3.5" /> Annuler
                            </button>
                            <button
                              type="button"
                              ref={setOverflowAnchor(`waiting-${po.id}`)}
                              onClick={() => toggleOverflowMenu(`waiting-${po.id}`)}
                              className="w-8 h-8 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
                              aria-label={`Plus d'actions pour le bon ${po.poNumber}`}
                              aria-haspopup="menu"
                              aria-expanded={overflowMenu === `waiting-${po.id}`}
                              title="Plus d'actions (Aperçu, Excel, Impression)"
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleOpenVerification(po)}
                            className="min-h-[44px] px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-md shadow-amber-500/20 transition cursor-pointer"
                          >
                            <PackageCheck className="w-4 h-4" /> Vérifier & Réceptionner
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'new_po' && (
            <div className="space-y-4">
              {/* Header & Vendor Details */}
              <div className="bg-pos-card border border-pos-border rounded-xl shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-pos-border/50 pb-3">
                  <div>
                    <h3 className="text-sm font-black text-pos-text flex items-center gap-2">
                      <Plus className="w-4 h-4 text-emerald-400" />
                      Créer un Bon de Commande Fournisseur Flexible
                    </h3>
                    <p className="text-xs text-pos-muted">
                      Commandez n'importe quel article du catalogue ou suivez les alertes de réapprovisionnement. Le stock et les lots FIFO ne sont pas impactés avant la réception physique.
                    </p>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                    Statut : En Attente (Waiting List)
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1 flex items-center gap-1">
                      <Building2 className="w-3 h-3 text-emerald-400" /> Fournisseur
                    </label>
                    <input
                      type="text"
                      placeholder="Nom du fournisseur (ex: Grossiste Centre)..."
                      value={newVendorName}
                      onChange={(e) => setNewVendorName(e.target.value)}
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 min-h-[44px] text-xs font-bold text-pos-text focus:outline-none focus:border-emerald-400"
                    />
                    {existingVendors.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {existingVendors.slice(0, 4).map((v) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => setNewVendorName(v)}
                            className="text-[9px] px-2 py-1 min-h-[36px] rounded bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-emerald-400 transition cursor-pointer"
                          >
                            + {v}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1 flex items-center gap-1">
                      <Calendar className="w-3 h-3 text-cyan-400" /> Date Prévue de Livraison
                    </label>
                    <input
                      type="date"
                      value={newOrderDate}
                      onChange={(e) => setNewOrderDate(e.target.value)}
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 min-h-[44px] text-xs font-bold text-pos-text focus:outline-none focus:border-cyan-400"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1 flex items-center gap-1">
                      <FileText className="w-3 h-3 text-amber-400" /> Notes / Référence Fournisseur (Optionnel)
                    </label>
                    <input
                      type="text"
                      placeholder="Instructions, N° devis..."
                      value={newOrderNotes}
                      onChange={(e) => setNewOrderNotes(e.target.value)}
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 min-h-[44px] text-xs text-pos-text focus:outline-none focus:border-amber-400"
                    />
                  </div>
                </div>
              </div>

              {/* Product Catalog Search & Selection */}
              <div className="bg-pos-card border border-pos-border rounded-xl shadow-sm p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 flex-1 min-w-[260px] bg-pos-bg border border-pos-border rounded-lg px-3 py-2 min-h-[44px] focus-within:border-emerald-400">
                    <Search className="w-4 h-4 text-pos-muted shrink-0" />
                    <input
                      type="text"
                      placeholder="Rechercher TOUS les produits du catalogue (nom, SKU, code-barres, marque)..."
                      value={catalogSearchTerm}
                      onChange={(e) => setCatalogSearchTerm(e.target.value)}
                      className="w-full bg-transparent border-none outline-none text-xs text-pos-text placeholder-pos-muted/60"
                    />
                    {catalogSearchTerm && (
                      <button
                        type="button"
                        onClick={() => setCatalogSearchTerm('')}
                        className="text-pos-muted hover:text-pos-text text-xs p-0.5"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2 overflow-x-auto no-scrollbar max-w-full">
                    <button
                      type="button"
                      onClick={() => setCatalogFilterMode('all')}
                      className={`min-h-[44px] px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer shrink-0 ${
                        catalogFilterMode === 'all'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'bg-pos-bg text-pos-muted hover:text-pos-text border border-pos-border'
                      }`}
                    >
                      Catalogue Entier ({(products || []).length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setCatalogFilterMode('suggested')}
                      className={`min-h-[44px] px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition cursor-pointer shrink-0 ${
                        catalogFilterMode === 'suggested'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          : 'bg-pos-bg text-pos-muted hover:text-pos-text border border-pos-border'
                      }`}
                    >
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                      Articles Suggérés ({lowStockProducts.length})
                    </button>
                    {lowStockProducts.length > 0 && (
                      <button
                        type="button"
                        onClick={handleQuickAddAllSuggested}
                        className="min-h-[44px] px-2.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400 text-xs font-bold transition cursor-pointer flex items-center gap-1 shrink-0"
                        title="Ajouter tous les articles en stock bas en 1 clic"
                      >
                        <Sparkles className="w-3 h-3" /> Tout Ajouter
                      </button>
                    )}
                  </div>
                </div>

                {/* Quick Add Product Carousel / Grid */}
                <div className="max-h-48 overflow-y-auto overscroll-contain grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 p-1">
                  {filteredCatalogProducts.length === 0 ? (
                    <div className="col-span-full text-center py-6 text-xs text-pos-muted">
                      Aucun produit trouvé pour "{catalogSearchTerm}".
                    </div>
                  ) : (
                    filteredCatalogProducts.map((p) => {
                      const alreadyInDraft = newPoItems.find((i) => i.productId === p.id);
                      const isLowStock = (p.stock || 0) <= (p.reorderPoint || 5);
                      return (
                        <div
                          key={p.id}
                          className="bg-pos-bg border border-pos-border/70 hover:border-emerald-500/50 p-2.5 rounded-xl flex items-center justify-between gap-2 transition shadow-sm"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-pos-text text-xs truncate">{p.title}</p>
                            <div className="flex items-center gap-2 text-[10px] text-pos-muted font-mono mt-0.5">
                              <span>SKU: {p.sku || 'N/A'}</span>
                              <span>•</span>
                              <span className={isLowStock ? 'text-amber-400 font-bold' : 'text-pos-muted'}>
                                Stock: {p.stock || 0}
                              </span>
                              <span>•</span>
                              <span className="text-emerald-400 font-bold">{formatDZD(p.costPrice || 0)}</span>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleAddProductToDraft(p)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-bold shrink-0 transition flex items-center gap-1 cursor-pointer ${
                              alreadyInDraft
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30'
                                : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-sm'
                            }`}
                          >
                            {alreadyInDraft ? (
                              <>
                                <Check className="w-3 h-3" />
                                <span>{alreadyInDraft.qty}</span>
                              </>
                            ) : (
                              <>
                                <Plus className="w-3 h-3" />
                                <span>Ajouter</span>
                              </>
                            )}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Staged PO Items Table */}
              <div className="bg-pos-card border border-pos-border rounded-xl shadow-sm overflow-hidden">
                <div className="p-3 bg-pos-bg border-b border-pos-border flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShoppingCart className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-black uppercase text-pos-text tracking-wider">
                      Articles du Bon de Commande ({newPoItems.length})
                    </span>
                  </div>
                  {newPoItems.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setNewPoItems([])}
                      className="text-[11px] text-rose-400 hover:text-rose-300 font-bold flex items-center gap-1 transition cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" /> Vider la sélection
                    </button>
                  )}
                </div>

                {newPoItems.length === 0 ? (
                  <div className="text-center py-12 text-pos-muted p-4 space-y-2">
                    <Layers className="w-10 h-10 mx-auto opacity-30 text-pos-muted" />
                    <p className="text-xs font-bold text-pos-text">Aucun article dans ce bon de commande</p>
                    <p className="text-[11px] text-pos-muted max-w-sm mx-auto">
                      Recherchez et sélectionnez des articles ci-dessus ou cliquez sur "Tout Ajouter" pour réapprovisionner les stocks critiques.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="sticky top-0 z-10 bg-pos-bg text-pos-muted text-[10px] uppercase font-bold border-b border-pos-border">
                        <tr>
                          <th className="p-3">Produit & SKU</th>
                          <th className="p-3 text-center">Stock Actuel</th>
                          <th className="p-3 text-center">Quantité à Commander</th>
                          <th className="p-3 text-right">Coût Unitaire Estimé (DA)</th>
                          <th className="p-3 text-right">Total Ligne (DA)</th>
                          <th className="p-3 text-center w-12">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pos-border/40">
                        {newPoItems.map((item) => {
                          const lineTotal = item.qty * item.unitCost;
                          return (
                            <tr key={item.productId} className="hover:bg-pos-hover/30 transition">
                              <td className="p-3">
                                <p className="font-bold text-pos-text">{item.title}</p>
                                <span className="font-mono text-[10px] text-pos-muted">SKU: {item.sku}</span>
                              </td>

                              <td className="p-3 text-center font-bold text-pos-muted font-mono">
                                {item.currentStock} un.
                              </td>

                              <td className="p-3">
                                <div className="flex items-center justify-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleUpdateDraftQty(item.productId, item.qty - 1)}
                                    className="min-h-[44px] min-w-[44px] flex items-center justify-center p-1 hover:bg-pos-hover rounded-lg text-pos-text transition cursor-pointer"
                                  >
                                    <Minus className="w-3 h-3" />
                                  </button>

                                  <input
                                    type="number"
                                    min="1"
                                    value={item.qty}
                                    onChange={(e) =>
                                      handleUpdateDraftQty(item.productId, parseInt(e.target.value) || 1)
                                    }
                                    className="w-14 min-h-[44px] text-center bg-pos-bg border border-pos-border rounded-lg text-emerald-400 font-bold font-mono py-1 focus:outline-none focus:border-emerald-400"
                                  />

                                  <button
                                    type="button"
                                    onClick={() => handleUpdateDraftQty(item.productId, item.qty + 1)}
                                    className="min-h-[44px] min-w-[44px] flex items-center justify-center p-1 hover:bg-pos-hover rounded-lg text-pos-text transition cursor-pointer"
                                  >
                                    <Plus className="w-3 h-3" />
                                  </button>
                                </div>
                              </td>

                              <td className="p-3 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <input
                                    type="number"
                                    step="any"
                                    min="0"
                                    value={item.unitCost}
                                    onChange={(e) =>
                                      // Integer-DA cost input: parseLocalizedAmount honours
                                      // FR decimals ("400,50") where parseInt silently
                                      // truncated; Math.round lands whole dinars.
                                      handleUpdateDraftCost(item.productId, Math.max(0, Math.round(parseLocalizedAmount(e.target.value) || 0)))
                                    }
                                    className="w-24 min-h-[44px] text-right bg-pos-bg border border-pos-border rounded-lg text-pos-text font-bold font-mono py-1 px-1.5 focus:outline-none focus:border-emerald-400"
                                  />
                                  <span className="text-[10px] text-pos-muted">DA</span>
                                </div>
                              </td>

                              <td className="p-3 text-right font-black text-pos-text font-mono">
                                {formatDZD(lineTotal)}
                              </td>

                              <td className="p-3 text-center">
                                <button
                                  type="button"
                                  onClick={() => handleRemoveItemFromDraft(item.productId)}
                                  className="min-h-[44px] min-w-[44px] flex items-center justify-center p-1.5 rounded-lg hover:bg-rose-500/10 text-pos-muted hover:text-rose-400 transition cursor-pointer"
                                  title="Retirer de la commande"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Order Summary & Placement Footer */}
              <div className="bg-pos-card border border-pos-border rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4 shadow-sm">
                <div>
                  <span className="text-xs uppercase font-bold text-pos-muted block">Bilan du Bon à Placer</span>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="text-xs text-pos-text font-bold">
                      Références : <span className="font-mono text-emerald-400">{newPoItems.length}</span>
                    </span>
                    <span className="text-xs text-pos-text font-bold">
                      Volume : <span className="font-mono text-emerald-400">{totalDraftUnits} pièces</span>
                    </span>
                  </div>
                  <p className="text-[10px] text-pos-muted mt-1">
                    ℹ️ Statut "En Attente". Les stocks réels et lots d'inventaire FIFO restent inchangés jusqu'à la réception.
                  </p>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <span className="text-xs uppercase font-bold text-pos-muted block">Budget Estimé Total</span>
                    <span className="text-2xl font-black text-emerald-400 font-mono">
                      {formatDZD(totalDraftCostAmount)}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={handleCreateManualPO}
                    disabled={isSubmittingPO || newPoItems.length === 0}
                    className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/20 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    Créer le Bon de Commande (En Attente)
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'active_po' && selectedPO && (
            <div className="space-y-4">
              <div className="bg-pos-card border border-pos-border rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-black text-pos-text">Contrôle Réception #{selectedPO.poNumber}</span>
                    <span className="text-xs px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-400 font-bold border border-amber-500/30">
                      {selectedPO.status}
                    </span>
                  </div>
                  <p className="text-xs text-pos-muted">
                    Fournisseur : <span className="font-bold text-emerald-400">{selectedPO.vendorName}</span> • Date création :{' '}
                    {formatDateTime(selectedPO.createdAt)}
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setActiveTab('preview_a4')}
                    className="px-3.5 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                    title="Voir l'aperçu du document A4"
                  >
                    <Eye className="w-4 h-4 text-emerald-400" /> Aperçu A4
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePrintPO()}
                    className="px-3.5 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                  >
                    <Printer className="w-4 h-4 text-emerald-400" /> Imprimer Bon A4
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExportExcel()}
                    className="px-3.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                    title="Télécharger en Excel (.xlsx stylé)"
                  >
                    <Download className="w-4 h-4" /> Excel (.xlsx)
                  </button>
                </div>
              </div>

              <div className="bg-pos-card border border-pos-border rounded-2xl overflow-hidden">
                <div className="p-3 bg-pos-bg border-b border-pos-border flex items-center justify-between">
                  <span className="text-xs font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" /> Grille de Contrôle Physique des Articles
                  </span>
                  <span className="text-xs text-pos-muted font-bold">
                    Ajustez les quantités reçues et le coût unitaire réel constaté sur la facture
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-pos-bg/50 text-pos-muted text-[10px] uppercase font-bold border-b border-pos-border">
                      <tr>
                        <th className="p-3">Produit / Référence SKU</th>
                        <th className="p-3 text-center">Stock Initial</th>
                        <th className="p-3 text-center">Qté Commandée</th>
                        <th className="p-3 text-center">Qté Conforme Reçue</th>
                        <th className="p-3 text-right">Prix Achat Facturé (DA)</th>
                        <th className="p-3">Numéros de Série / IMEI</th>
                        <th className="p-3 text-right">Total Validé (DA)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-pos-border/40">
                      {(selectedPO?.items || []).map((item) => {
                        const verifiedQty =
                          verifiedQtyMap[item.productId] !== undefined
                            ? verifiedQtyMap[item.productId]
                            : Math.max(0, item.suggestedQty - (item.receivedQty || 0));
                        const verifiedCost =
                          verifiedCostMap[item.productId] !== undefined
                            ? verifiedCostMap[item.productId]
                            : item.actualUnitCost || item.unitCost;
                        const lineTotal = verifiedQty * verifiedCost;
                        const hasDiscrepancy = verifiedQty < item.suggestedQty;
                        const priceChanged = verifiedCost !== item.unitCost;

                        return (
                          <tr key={item.productId} className="hover:bg-pos-hover/40 transition">
                            <td className="p-3">
                              <p className="font-bold text-pos-text">{item.title}</p>
                              <span className="font-mono text-[10px] text-pos-muted">SKU: {item.sku}</span>
                              {hasDiscrepancy && (
                                <div className="mt-1 flex items-center gap-1">
                                  <span className="text-[9px] bg-rose-500/15 text-rose-400 border border-rose-500/30 px-1.5 py-0.5 rounded font-bold flex items-center gap-0.5">
                                    <AlertTriangle className="w-2.5 h-2.5" /> Écart : -{item.suggestedQty - verifiedQty} un.
                                  </span>
                                  <input
                                    type="text"
                                    placeholder="Motif écart (ex: Rupture grossiste)..."
                                    value={discrepancyReasons[item.productId] || ''}
                                    onChange={(e) =>
                                      setDiscrepancyReasons({ ...discrepancyReasons, [item.productId]: e.target.value })
                                    }
                                    className="bg-pos-bg border border-pos-border rounded px-1.5 py-0.5 text-[10px] text-pos-text w-48 placeholder-pos-muted/50"
                                  />
                                </div>
                              )}
                            </td>

                            <td className="p-3 text-center text-pos-muted font-bold">{item.currentStock} un.</td>

                            <td className="p-3 text-center font-bold text-pos-text font-mono">
                              {item.suggestedQty} un.
                              {item.receivedQty ? (
                                <span className="block text-[9px] text-emerald-400">
                                  ({item.receivedQty} déjà reçus)
                                </span>
                              ) : null}
                            </td>

                            <td className="p-3">
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setVerifiedQtyMap({
                                      ...verifiedQtyMap,
                                      [item.productId]: Math.max(0, verifiedQty - 1),
                                    })
                                  }
                                  className="p-1 hover:bg-pos-hover rounded text-pos-text transition cursor-pointer"
                                >
                                  <Minus className="w-3 h-3" />
                                </button>

                                <input
                                  type="number"
                                  min="0"
                                  max={item.suggestedQty * 2}
                                  value={verifiedQty}
                                  onChange={(e) =>
                                    setVerifiedQtyMap({
                                      ...verifiedQtyMap,
                                      [item.productId]: Math.max(0, parseInt(e.target.value) || 0),
                                    })
                                  }
                                  className="w-12 text-center bg-pos-bg border border-pos-border rounded-lg text-emerald-400 font-bold font-mono py-1 focus:outline-none focus:border-emerald-400"
                                />

                                <button
                                  type="button"
                                  onClick={() =>
                                    setVerifiedQtyMap({
                                      ...verifiedQtyMap,
                                      [item.productId]: verifiedQty + 1,
                                    })
                                  }
                                  className="p-1 hover:bg-pos-hover rounded text-pos-text transition cursor-pointer"
                                >
                                  <Plus className="w-3 h-3" />
                                </button>
                              </div>
                            </td>

                            <td className="p-3 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <input
                                  type="number"
                                  step="any"
                                  value={verifiedCost}
                                  onChange={(e) =>
                                    setVerifiedCostMap({
                                      ...verifiedCostMap,
                                      // Integer-DA cost input (see draft input above).
                                      [item.productId]: Math.max(0, Math.round(parseLocalizedAmount(e.target.value) || 0)),
                                    })
                                  }
                                  className="w-24 text-right bg-pos-bg border border-pos-border rounded-lg text-pos-text font-bold font-mono py-1 px-1.5 focus:outline-none focus:border-emerald-400"
                                />
                                <span className="text-[10px] text-pos-muted">DA</span>
                              </div>
                              {priceChanged && (
                                <span className="text-[9px] text-amber-400 block mt-0.5">
                                  Écart prix : {verifiedCost > item.unitCost ? '+' : ''}
                                  {verifiedCost - item.unitCost} DA/u
                                </span>
                              )}
                            </td>

                            <td className="p-3">
                              <div className="flex items-center gap-1.5 bg-pos-bg border border-pos-border rounded-lg px-2 py-1 focus-within:border-emerald-400">
                                <Smartphone className="w-3.5 h-3.5 text-pos-muted shrink-0" />
                                <input
                                  type="text"
                                  placeholder="IMEIs séparés par virgule..."
                                  value={imeisMap[item.productId] || ''}
                                  onChange={(e) => setImeisMap({ ...imeisMap, [item.productId]: e.target.value })}
                                  className="bg-transparent border-none outline-none text-[11px] text-pos-text w-full placeholder-pos-muted/50"
                                />
                              </div>
                            </td>

                            <td className="p-3 text-right font-black text-pos-text font-mono text-xs">
                              {formatDZD(lineTotal)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Summary & Expense Auto-recording */}
              <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-4 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-pos-border pb-4">
                  <div>
                    <span className="text-xs uppercase font-bold text-pos-muted block">Bilan de la Réception Physique</span>
                    <p className="text-sm font-bold text-pos-text">
                      Total Réceptionné : <span className="text-emerald-400 font-mono">{totalVerifiedUnits} unités</span>
                    </p>
                  </div>

                  <div className="text-right">
                    <span className="text-xs uppercase font-bold text-pos-muted block">Montant Réceptionné Validé</span>
                    <span className="text-2xl font-black text-emerald-400 font-mono">
                      {formatDZD(totalVerifiedCostAmount)}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 bg-pos-bg p-3 rounded-xl border border-pos-border">
                  <label className="flex items-center gap-2.5 text-xs text-pos-text font-bold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoRecordExpense}
                      onChange={(e) => setAutoRecordExpense(e.target.checked)}
                      className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
                    />
                    <span>
                      Enregistrer automatiquement comme Charge / Dépense Fournisseur (EBITDA & Sortie de Caisse)
                    </span>
                  </label>

                  {autoRecordExpense && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-pos-muted font-bold text-[11px]">Mode de Règlement :</span>
                      <select
                        value={expensePaymentMethod}
                        onChange={(e) => setExpensePaymentMethod(e.target.value as PaymentMethodType)}
                        className="bg-pos-card border border-pos-border rounded-lg px-2.5 py-1 text-xs font-bold text-pos-text focus:outline-none focus:border-emerald-400 cursor-pointer"
                      >
                        <option value="Espèces">Espèces (Sortie Caisse Directe)</option>
                        <option value="BaridiMob">BaridiMob (Virement)</option>
                        <option value="Chèque">Chèque Commercial</option>
                        <option value="Autre">Autre Moyen</option>
                      </select>
                    </div>
                  )}
                </div>

                <div className="flex justify-end items-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setInspectingPO(null);
                      setActiveTab('waiting_list');
                    }}
                    className="px-4 py-2.5 rounded-xl bg-pos-bg hover:bg-pos-hover text-pos-muted hover:text-pos-text font-bold text-xs transition cursor-pointer"
                  >
                    Retour à la Liste d'Attente
                  </button>

                  <button
                    type="button"
                    onClick={handleVerifyAndReceive}
                    disabled={isProcessing || totalVerifiedUnits === 0 || selectedPO?.status === 'Completed'}
                    className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/20 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    title={selectedPO?.status === 'Completed' ? 'Bon déjà réceptionné — réception verrouillée' : undefined}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    Valider la Réception & Mettre en Stock ({formatDZD(totalVerifiedCostAmount)})
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'completed' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-black text-pos-text flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-cyan-400" />
                    Historique des Bons de Commande Validés & Réceptionnés
                  </h3>
                  <p className="text-xs text-pos-muted">
                    Tous les bons de commande dont le stock a été incrémenté et les dépenses comptabilisées.
                  </p>
                </div>
              </div>

              {completedOrders.length === 0 ? (
                <div className="text-center py-20 text-pos-muted bg-pos-card border border-pos-border rounded-2xl max-w-md mx-auto">
                  <FileText className="w-12 h-12 mx-auto mb-3 opacity-40 text-pos-muted" />
                  <p className="text-sm font-bold text-pos-text">Aucun bon archivé</p>
                  <p className="text-xs text-pos-muted mt-1">
                    Les réceptions validées apparaîtront automatiquement dans cet historique.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {(completedOrders || []).map((po) => (
                    <div
                      key={po.id}
                      className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 shadow-sm flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-black text-pos-text text-sm">#{po.poNumber}</span>
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                                Réception Complète
                              </span>
                            </div>
                            <p className="text-xs font-bold text-emerald-400 mt-0.5">{po.vendorName}</p>
                            <p className="text-[10px] text-pos-muted">
                              Validé le : {formatDateTime(po.validatedAt || po.createdAt)}
                            </p>
                          </div>

                          <div className="text-right">
                            <span className="text-xs text-pos-muted block">Montant Réceptionné</span>
                            <span className="text-base font-black text-emerald-400 font-mono">
                              {formatDZD(po.actualTotalAmount || po.totalAmount)}
                            </span>
                          </div>
                        </div>

                        <div className="mt-3 bg-pos-bg p-2.5 rounded-xl border border-pos-border text-xs space-y-1">
                          <span className="text-[10px] font-bold text-pos-muted uppercase block border-b border-pos-border/40 pb-1">
                            {(po.items || []).length} Références Intégrées en Stock
                          </span>
                          <div className="max-h-20 overflow-y-auto space-y-1 pt-1">
                            {(po.items || []).map((item) => (
                              <div key={item.productId} className="flex justify-between text-[11px]">
                                <span className="text-pos-text truncate max-w-[200px]">{item.title}</span>
                                <span className="font-mono text-emerald-400 font-bold">
                                  +{item.receivedQty || item.suggestedQty} un. ({formatDZD(item.actualUnitCost || item.unitCost)})
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="flex justify-between items-center pt-2 border-t border-pos-border text-xs gap-2 flex-wrap">
                        <span className="text-pos-muted flex items-center gap-1">
                          <Check className="w-3.5 h-3.5 text-emerald-400" /> Charge enregistrée
                        </span>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button
                            type="button"
                            onClick={() => {
                              setInspectingPO(po);
                              setActiveTab('preview_a4');
                            }}
                            className="px-2.5 py-1 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text font-bold text-xs flex items-center gap-1 transition cursor-pointer"
                            title="Aperçu A4 / PDF"
                          >
                            <Eye className="w-3.5 h-3.5 text-emerald-400" /> Aperçu A4
                          </button>
                          <button
                            type="button"
                            onClick={() => handleExportExcel(po)}
                            className="p-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-xs transition cursor-pointer"
                            title="Télécharger Excel (.xlsx stylé)"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handlePrintPO(po)}
                            className="p-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text text-xs transition cursor-pointer"
                            title="Imprimer / PDF A4"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setInspectingPO(po);
                              setActiveTab('active_po');
                            }}
                            className="px-3 py-1 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text font-bold text-xs transition cursor-pointer"
                          >
                            Consulter les Détails
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'preview_a4' && selectedPO && (
            <div className="space-y-4">
              {/* Top pro action bar */}
              <div className="bg-pos-card border border-pos-border rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-sm sticky top-0 z-10 backdrop-blur-md">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center font-bold">
                    <FileText className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-base font-black text-pos-text">Bon de Commande #{selectedPO.poNumber}</span>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 uppercase">
                        Document A4 Officiel
                      </span>
                    </div>
                    <p className="text-xs text-pos-muted mt-0.5">
                      Fournisseur : <strong className="text-pos-text">{selectedPO.vendorName}</strong> • {selectedPO.items?.length || 0} références
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => handlePrintPO(selectedPO)}
                    className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/20 transition cursor-pointer"
                    title="Imprimer ou enregistrer en PDF via la boîte de dialogue système"
                  >
                    <Printer className="w-4 h-4" />
                    <span>Imprimer / PDF (A4)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportExcel(selectedPO)}
                    className="px-3.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                    title="Télécharger en tableur Excel (.xlsx stylé avec formules =SUM)"
                  >
                    <Download className="w-4 h-4" />
                    <span>Exporter Excel (.xlsx)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('active_po')}
                    className="px-3.5 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                  >
                    <PackageCheck className="w-4 h-4 text-emerald-400" />
                    <span>Contrôle & Réception</span>
                  </button>
                </div>
              </div>

              {/* Realistic A4 Paper sheet preview */}
              <div className="bg-slate-950/50 border border-pos-border/60 rounded-2xl p-3 sm:p-8 overflow-x-auto flex justify-center">
                <div className="w-full max-w-[210mm] transition-all duration-200">
                  <PurchaseOrderA4Document
                    po={selectedPO}
                    receiptSettings={receiptSettings}
                    previewMode={true}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modern full-page A4 Purchase Order (Bon de commande) — print / Save as PDF */}
        {selectedPO && (
          <div className="print-po-target po-a4 hidden print:block bg-white text-black font-sans text-xs">
            <PurchaseOrderA4Document po={selectedPO} receiptSettings={receiptSettings} />
          </div>
        )}
        {/* Portaled overflow menu */}
        {overflowMenu && createPortal(
          <>
            <div
              className="fixed inset-0 z-[9998]"
              onClick={() => setOverflowMenu(null)}
              aria-hidden="true"
            />
            <div
              ref={overflowMenuRef}
              role="menu"
              style={{ position: 'fixed', top: overflowPos.top, left: overflowPos.left, zIndex: 9999 }}
              className="w-56 bg-pos-panel border border-pos-border rounded-lg shadow-xl overflow-hidden animate-in fade-in zoom-in-95 p-1"
            >
              {(() => {
                const poId = overflowMenu.replace('waiting-', '');
                const po = purchaseOrders.find((p) => p.id === poId);
                if (!po) return null;
                return (
                  <div className="flex flex-col gap-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setInspectingPO(po);
                        setActiveTab('preview_a4');
                        setOverflowMenu(null);
                      }}
                      className="px-3 py-2 rounded-md hover:bg-pos-hover text-pos-text text-left flex items-center gap-2 cursor-pointer font-bold"
                    >
                      <Eye className="w-3.5 h-3.5 text-emerald-400" />
                      Aperçu Document A4
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleExportExcel(po);
                        setOverflowMenu(null);
                      }}
                      className="px-3 py-2 rounded-md hover:bg-pos-hover text-pos-text text-left flex items-center gap-2 cursor-pointer font-bold"
                    >
                      <Download className="w-3.5 h-3.5 text-emerald-400" />
                      Exporter Excel (.xlsx)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handlePrintPO(po);
                        setOverflowMenu(null);
                      }}
                      className="px-3 py-2 rounded-md hover:bg-pos-hover text-pos-text text-left flex items-center gap-2 cursor-pointer font-bold"
                    >
                      <Printer className="w-3.5 h-3.5 text-emerald-400" />
                      Imprimer Bon A4
                    </button>
                  </div>
                );
              })()}
            </div>
          </>,
          document.body
        )}
      </div>
    </div>
  );
};
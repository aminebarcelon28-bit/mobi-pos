import React, { useState } from 'react';
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
  Boxes,
  Trash2,
  ExternalLink,
  Play,
  Wrench,
  ShoppingBag,
  FileText,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import type { PurchaseOrder, PaymentMethodType } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { printCoordinator } from '../../utils/printCoordinator';
import { buildWhatsAppUrl } from '../../utils/phoneUtils';
import { soundEngine } from '../../utils/audioFeedback';

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
  } = usePosStore();

  const { showToast } = useToast();

  // Navigation Tabs
  const [activeTab, setActiveTab] = useState<'waiting_pos' | 'held_sales' | 'repairs'>('waiting_pos');

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'Waiting List' | 'Draft' | 'Partially Received' | 'Completed'>('all');
  const [expandedPoId, setExpandedPoId] = useState<string | null>(null);

  // Receiving Sub-Modal State
  const [receivingPO, setReceivingPO] = useState<PurchaseOrder | null>(null);
  const [verifiedQtyMap, setVerifiedQtyMap] = useState<Record<string, number>>({});
  const [verifiedCostMap, setVerifiedCostMap] = useState<Record<string, number>>({});
  const [discrepancyReasons, setDiscrepancyReasons] = useState<Record<string, string>>({});
  const [autoRecordExpense, setAutoRecordExpense] = useState<boolean>(true);
  const [expensePaymentMethod, setExpensePaymentMethod] = useState<PaymentMethodType>('Espèces');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  if (activeModal !== 'command_tickets') return null;

  // ══════════════════════════════════════════════════════════════
  // GLOBAL KPIS CALCULATIONS
  // ══════════════════════════════════════════════════════════════
  const waitingPOs = (purchaseOrders || []).filter(
    (po) => po.status === 'Waiting List' || po.status === 'Draft' || po.status === 'Partially Received'
  );

  const totalWaitingUnits = waitingPOs.reduce(
    (acc, po) =>
      acc +
      po.items.reduce(
        (sum, item) => sum + Math.max(0, item.suggestedQty - (item.receivedQty || 0)),
        0
      ),
    0
  );

  const totalEstimatedCost = waitingPOs.reduce((acc, po) => acc + (po.totalAmount || 0), 0);

  const pendingRepairs = (repairOrders || []).filter(
    (r) => r.status === 'Diagnostic' || r.status === 'En attente de pièces' || r.status === 'En cours'
  );

  // Filtered Purchase Orders
  const filteredPOs = (purchaseOrders || []).filter((po) => {
    const matchesSearch =
      po.poNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      po.vendorName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      po.items.some((item) => item.title.toLowerCase().includes(searchQuery.toLowerCase()) || item.sku.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus = statusFilter === 'all' ? true : po.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // Filtered Held Sales
  const filteredHeldSales = (heldSales || []).filter((hs) => {
    const custName = hs.customer?.name || 'Client Comptant';
    return (
      custName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      hs.items.some((item) => item.product.title.toLowerCase().includes(searchQuery.toLowerCase()))
    );
  });

  // Filtered Repair Orders
  const filteredRepairs = (repairOrders || []).filter((r) => {
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
    const initQty: Record<string, number> = {};
    const initCost: Record<string, number> = {};
    const initReasons: Record<string, string> = {};

    po.items.forEach((item) => {
      const remaining = Math.max(0, item.suggestedQty - (item.receivedQty || 0));
      initQty[item.productId] = remaining > 0 ? remaining : item.suggestedQty;
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

    const verifiedItems = receivingPO.items.map((item) => {
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

    const res = await validateAndReceivePO({
      poId: receivingPO.id,
      verifiedItems,
      recordExpense: autoRecordExpense,
      expensePaymentMethod,
    });

    setIsProcessing(false);

    if (res.success) {
      soundEngine.playSuccess();
      if (res.isPartial) {
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

      if (autoRecordExpense && res.totalReceivedCost > 0) {
        showToast(`💶 Charge Fournisseur de ${formatDZD(res.totalReceivedCost)} liée à l'EBITDA.`, 'success');
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
  const handleExportCsv = (po: PurchaseOrder) => {
    const BOM = '\uFEFF';
    let csv = `${BOM}BON DE COMMANDE FOURNISSEUR\n`;
    csv += `N° Bon: ${po.poNumber}\nFournisseur: ${po.vendorName}\nDate: ${formatDateTime(po.createdAt)}\nStatut: ${po.status}\n\n`;
    csv += 'SKU;Désignation Article;Quantité Demandée;Quantité Reçue;Prix Unitaire Achat (DA);Total Ligne (DA)\n';

    let total = 0;
    po.items.forEach((item) => {
      const lineTotal = item.unitCost * item.suggestedQty;
      total += lineTotal;
      csv += `"${item.sku}";"${item.title}";${item.suggestedQty};${item.receivedQty || 0};${item.unitCost};${lineTotal}\n`;
    });

    csv += `\n;;;;TOTAL ESTIMÉ (DA);${total}\n`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Bon_Commande_${po.poNumber}_${po.vendorName.replace(/\s+/g, '_')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`Bon de commande #${po.poNumber} exporté en CSV.`, 'success');
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

  const handlePrintPO = (po: PurchaseOrder) => {
    printCoordinator.printPurchaseOrder(50);
    showToast(`Impression Bon #${po.poNumber} envoyée vers l'imprimante A4.`, 'info');
  };

  const handleDeleteOrCancelPO = async (po: PurchaseOrder) => {
    if (confirm(`Confirmez-vous l'annulation et suppression du bon #${po.poNumber} (${po.vendorName}) ?`)) {
      await cancelPO(po.id, 'Supprimé par l\'administrateur');
      await deletePO(po.id);
      showToast(`Bon #${po.poNumber} supprimé.`, 'info');
    }
  };

  const handleRestoreHeldSaleClick = (saleId: string) => {
    retrieveSale(saleId);
    closeModal();
    soundEngine.playSuccess();
    showToast('Panier en attente restauré avec succès dans la caisse !', 'success');
  };

  const handleDeleteHeldSaleClick = (saleId: string) => {
    if (confirm('Voulez-vous vraiment supprimer ce ticket en attente ?')) {
      deleteHeldSale(saleId);
      showToast('Ticket en attente supprimé.', 'info');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-6xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col h-[90vh]">
        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MODAL HEADER */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white shadow-lg shadow-amber-500/20">
              <Clock className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-pos-text uppercase tracking-wider">
                  Tableau de Bord des Commandes & File d'Attente
                </h2>
                <span className="px-2.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold text-xs">
                  {waitingPOs.length} En Attente
                </span>
              </div>
              <p className="text-xs text-pos-muted">
                Suivi centralisé des Bons de Commande Fournisseur, Paniers Suspendus et SAV
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TOP KPI SUMMARY METRICS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-4 border-b border-pos-border bg-pos-bg grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0">
          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Bons en File d'Attente
              </span>
              <span className="text-xl font-black text-amber-400 font-mono">{waitingPOs.length}</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <Clock className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Unités Attendues
              </span>
              <span className="text-xl font-black text-cyan-400 font-mono">+{totalWaitingUnits} pcs</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
              <Boxes className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Budget Réappro Estimé
              </span>
              <span className="text-xl font-black text-emerald-400 font-mono">{formatDZD(totalEstimatedCost)}</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
              <Truck className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Paniers Suspendus (F4)
              </span>
              <span className="text-xl font-black text-teal-400 font-mono">{heldSales.length}</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-teal-500/10 text-teal-400 flex items-center justify-center">
              <ShoppingBag className="w-5 h-5" />
            </div>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* NAVIGATION TABS & SEARCH CONTROLS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-3 border-b border-pos-border bg-pos-panel flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
          {/* Tab Selection */}
          <div className="flex items-center gap-1.5 bg-pos-bg p-1 rounded-xl border border-pos-border w-full sm:w-auto">
            <button
              onClick={() => setActiveTab('waiting_pos')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-black flex items-center gap-2 transition cursor-pointer ${
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
              className={`px-3.5 py-1.5 rounded-lg text-xs font-black flex items-center gap-2 transition cursor-pointer ${
                activeTab === 'held_sales'
                  ? 'bg-teal-500 text-slate-950 shadow-md'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <ShoppingBag className="w-4 h-4" />
              <span>Paniers en Attente ({heldSales.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('repairs')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-black flex items-center gap-2 transition cursor-pointer ${
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
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Rechercher bon, fournisseur, SKU..."
                className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-1.5 text-xs text-pos-text focus:outline-none focus:border-amber-400"
              />
            </div>

            {activeTab === 'waiting_pos' && (
              <>
                <button
                  onClick={() => openModal('vendor_procurement')}
                  className="px-3 py-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 shadow-md shadow-emerald-900/20 transition cursor-pointer shrink-0"
                >
                  <PlusCircle className="w-4 h-4" />
                  <span>+ Réapprovisionnement</span>
                </button>
                <button
                  onClick={() => openModal('purchase_order')}
                  className="px-3 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/40 text-xs font-bold rounded-xl flex items-center gap-1.5 transition cursor-pointer shrink-0"
                  title="Inspecter le Bon de Commande Détaillé"
                >
                  <FileText className="w-4 h-4" />
                  <span>Bons Détaillés</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MAIN CONTENT AREA */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* TAB 1: PURCHASE ORDERS & WAITING LIST */}
          {activeTab === 'waiting_pos' && (
            <div className="space-y-3">
              {/* Status Filter Pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
                {(['all', 'Waiting List', 'Draft', 'Partially Received', 'Completed'] as const).map((st) => (
                  <button
                    key={st}
                    onClick={() => setStatusFilter(st)}
                    className={`px-3 py-1 rounded-xl font-bold border transition cursor-pointer ${
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
                <div className="p-12 text-center bg-pos-card border border-pos-border rounded-2xl space-y-3">
                  <Clock className="w-12 h-12 text-pos-muted mx-auto opacity-40" />
                  <h3 className="font-bold text-sm text-pos-text">Aucun bon de commande trouvé</h3>
                  <p className="text-xs text-pos-muted max-w-sm mx-auto">
                    Tous les réapprovisionnements en attente apparaîtront ici dès leur validation depuis le module Fournisseurs.
                  </p>
                  <button
                    onClick={() => openModal('vendor_procurement')}
                    className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl transition cursor-pointer"
                  >
                    Lancer un Réapprovisionnement Intelligent
                  </button>
                </div>
              ) : (
                filteredPOs.map((po) => {
                  const isExpanded = expandedPoId === po.id;
                  const isWaiting = po.status === 'Waiting List' || po.status === 'Draft' || po.status === 'Partially Received';
                  const totalUnits = po.items.reduce((sum, item) => sum + item.suggestedQty, 0);
                  const receivedUnits = po.items.reduce((sum, item) => sum + (item.receivedQty || 0), 0);

                  return (
                    <div
                      key={po.id}
                      className={`bg-pos-card border rounded-2xl overflow-hidden transition-all duration-150 shadow-sm ${
                        isWaiting ? 'border-amber-500/40 hover:border-amber-500/60' : 'border-pos-border'
                      }`}
                    >
                      {/* Ticket Header Bar */}
                      <div className="p-4 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3 bg-pos-panel/60">
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm ${
                              po.status === 'Completed' || po.status === 'Received'
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : po.status === 'Partially Received'
                                ? 'bg-blue-500/20 text-blue-400'
                                : 'bg-amber-500/20 text-amber-400'
                            }`}
                          >
                            <Truck className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-black text-sm text-pos-text">{po.poNumber}</span>
                              <span className="font-extrabold text-sm text-amber-300">• {po.vendorName}</span>
                              <span
                                className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider ${
                                  po.status === 'Completed' || po.status === 'Received'
                                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                                    : po.status === 'Partially Received'
                                    ? 'bg-blue-500/15 border border-blue-500/30 text-blue-300'
                                    : 'bg-amber-500/15 border border-amber-500/30 text-amber-300 animate-pulse'
                                }`}
                              >
                                {po.status === 'Waiting List' ? 'En Liste d\'Attente' : po.status}
                              </span>
                            </div>
                            <span className="text-[11px] text-pos-muted">
                              Créé le : {formatDateTime(po.createdAt)} • {po.items.length} références ({receivedUnits}/{totalUnits} pcs reçues)
                            </span>
                          </div>
                        </div>

                        {/* Cost & Actions */}
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
                              className="px-3.5 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-black rounded-xl flex items-center gap-1.5 shadow-md shadow-emerald-900/20 transition cursor-pointer"
                              title="Vérifier et Réceptionner les marchandises en stock"
                            >
                              <PackageCheck className="w-4 h-4" />
                              <span>Réceptionner</span>
                            </button>
                          )}

                          {/* WhatsApp dispatch */}
                          <button
                            onClick={() => handleSendWhatsApp(po)}
                            className="p-2 bg-pos-bg hover:bg-emerald-500/20 border border-pos-border hover:border-emerald-500/40 text-emerald-400 rounded-xl transition cursor-pointer"
                            title="Envoyer le bon au fournisseur via WhatsApp"
                          >
                            <MessageSquare className="w-4 h-4" />
                          </button>

                          {/* Print PO */}
                          <button
                            onClick={() => handlePrintPO(po)}
                            className="p-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
                            title="Imprimer le bon de commande (A4 / 80mm)"
                          >
                            <Printer className="w-4 h-4" />
                          </button>

                          {/* Export CSV */}
                          <button
                            onClick={() => handleExportCsv(po)}
                            className="p-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
                            title="Télécharger en fichier CSV"
                          >
                            <Download className="w-4 h-4" />
                          </button>

                          {/* Delete PO */}
                          <button
                            onClick={() => handleDeleteOrCancelPO(po)}
                            className="p-2 bg-pos-bg hover:bg-red-500/20 border border-pos-border hover:border-red-500/40 text-pos-muted hover:text-red-400 rounded-xl transition cursor-pointer"
                            title="Annuler / Supprimer le bon"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>

                          {/* Toggle expand */}
                          <button
                            onClick={() => setExpandedPoId(isExpanded ? null : po.id)}
                            className="p-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
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
                                {po.items.map((item) => (
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
                                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                          item.status === 'Received'
                                            ? 'bg-emerald-500/20 text-emerald-400'
                                            : item.status === 'Partially Received'
                                            ? 'bg-blue-500/20 text-blue-400'
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
                <div className="p-12 text-center bg-pos-card border border-pos-border rounded-2xl space-y-3">
                  <ShoppingBag className="w-12 h-12 text-pos-muted mx-auto opacity-40" />
                  <h3 className="font-bold text-sm text-pos-text">Aucun panier en attente</h3>
                  <p className="text-xs text-pos-muted max-w-sm mx-auto">
                    Pour mettre une vente en attente pendant un rush caisse, appuyez simplement sur <span className="text-emerald-400 font-bold">F7</span> dans la caisse.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {filteredHeldSales.map((hs) => {
                    const custName = hs.customer?.name || 'Client Comptant (Passage)';
                    const totalAmount = hs.items.reduce(
                      (sum, item) => sum + (item.appliedPrice || item.product.price) * item.quantity - (item.discount || 0),
                      0
                    );

                    return (
                      <div
                        key={hs.id}
                        className="bg-pos-card border border-teal-500/30 hover:border-teal-500/60 rounded-2xl p-4 space-y-3 shadow-sm transition"
                      >
                        <div className="flex items-center justify-between pb-2 border-b border-pos-border">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-xl bg-teal-500/20 text-teal-400 flex items-center justify-center font-bold">
                              <ShoppingBag className="w-4 h-4" />
                            </div>
                            <div>
                              <h4 className="font-black text-sm text-pos-text">{custName}</h4>
                              <span className="text-[10px] text-pos-muted flex items-center gap-1">
                                <Clock className="w-3 h-3 text-teal-400" /> {hs.timestamp}
                              </span>
                            </div>
                          </div>
                          <span className="font-mono font-black text-base text-emerald-400">{formatDZD(totalAmount)}</span>
                        </div>

                        {/* Items list preview */}
                        <div className="space-y-1 max-h-32 overflow-y-auto pr-1 text-xs">
                          {hs.items.map((it) => (
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
                            className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-bold rounded-xl transition cursor-pointer"
                          >
                            Supprimer
                          </button>
                          <button
                            onClick={() => handleRestoreHeldSaleClick(hs.id)}
                            className="px-4 py-2 bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-500 hover:to-emerald-500 text-white font-black text-xs rounded-xl flex items-center gap-1.5 shadow-md shadow-teal-900/30 transition cursor-pointer"
                          >
                            <Play className="w-3.5 h-3.5" />
                            <span>Reprendre la Vente (F4)</span>
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
              {filteredRepairs.length === 0 ? (
                <div className="p-12 text-center bg-pos-card border border-pos-border rounded-2xl space-y-3">
                  <Wrench className="w-12 h-12 text-pos-muted mx-auto opacity-40" />
                  <h3 className="font-bold text-sm text-pos-text">Aucun ticket SAV en attente</h3>
                  <p className="text-xs text-pos-muted max-w-sm mx-auto">
                    Créez des ordres de réparation et imprimez les étiquettes SAV depuis le bouton Réparation du menu supérieur.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {filteredRepairs.map((repair) => (
                    <div
                      key={repair.id}
                      className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 shadow-sm hover:border-emerald-500/40 transition"
                    >
                      <div className="flex items-center justify-between pb-2 border-b border-pos-border">
                        <div>
                          <span className="font-mono font-black text-xs text-emerald-400 block">
                            #{repair.ticketNumber}
                          </span>
                          <h4 className="font-bold text-sm text-pos-text">{repair.deviceModel}</h4>
                        </div>
                        <span
                          className={`px-2.5 py-1 rounded-lg text-[10px] font-bold ${
                            repair.status === 'Prêt / Terminé'
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                              : repair.status === 'En cours'
                              ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                              : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          }`}
                        >
                          {repair.status}
                        </span>
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
                        </div>

                        {/* Status change actions */}
                        <div className="flex items-center gap-1.5">
                          {repair.status !== 'Prêt / Terminé' && (
                            <button
                              onClick={() => {
                                updateRepairOrderStatus(repair.id, 'Prêt / Terminé');
                                showToast(`Ticket SAV #${repair.ticketNumber} marqué comme Prêt / Terminé !`, 'success');
                              }}
                              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition cursor-pointer"
                            >
                              Marquer Prêt
                            </button>
                          )}
                          <button
                            onClick={() => openModal('repair_work_order')}
                            className="p-1.5 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
                            title="Ouvrir le dossier SAV complet"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* RECEPTION VERIFICATION SUB-MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {receivingPO && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-60 flex items-center justify-center p-4">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col max-h-[90vh]">
              <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
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
                  className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-4 overflow-y-auto space-y-3">
                <p className="text-xs text-pos-muted">
                  Vérifiez les quantités réelles livrées et ajustez les prix d'achat en cas de fluctuation fournisseur. Les stocks de la caisse seront automatiquement incrémentés.
                </p>

                <div className="space-y-2">
                  {receivingPO.items.map((item) => {
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
                              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-emerald-500"
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
                              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-emerald-500"
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Expense recording toggle */}
                <div className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-2 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer">
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
                    <div className="flex items-center gap-2 pt-2 border-t border-pos-border/40">
                      <span className="text-[10px] text-pos-muted font-bold">Règlement Dépense :</span>
                      {(['Espèces', 'BaridiMob', 'Chèque'] as PaymentMethodType[]).map((meth) => (
                        <button
                          key={meth}
                          type="button"
                          onClick={() => setExpensePaymentMethod(meth)}
                          className={`px-2.5 py-1 rounded-lg text-[10.5px] font-bold border transition cursor-pointer ${
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

              <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between">
                <button
                  onClick={() => setReceivingPO(null)}
                  className="px-4 py-2 text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  onClick={handleConfirmReception}
                  disabled={isProcessing}
                  className="px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-black text-xs rounded-xl shadow-lg transition cursor-pointer disabled:opacity-50 flex items-center gap-2"
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
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between shrink-0">
          <span className="text-xs text-pos-muted">
            • Tous les tickets et bons de commande sont synchronisés en temps réel avec la base SQLite WAL.
          </span>
          <button
            onClick={closeModal}
            className="px-5 py-2 rounded-xl text-xs font-bold bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text transition cursor-pointer"
          >
            Fermer (Échap)
          </button>
        </div>
      </div>
    </div>
  );
};

import React, { useState } from 'react';
import {
  X,
  Truck,
  AlertTriangle,
  ArrowRight,
  Phone,
  Mail,
  Search,
  CheckCircle2,
  PackageCheck,
  Plus,
  Minus,
  FileText,
  MessageSquare,
  Zap,
  Download,
  Copy,
  Clock,
  CheckSquare,
  Square,
  Target,
  PlusCircle,
  RotateCcw,
  Sparkles,
  ExternalLink,
  Edit2,
  Trash2,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { calculateStockAlerts } from '../../utils/alertEngine';
import { formatDZD } from '../../types/pos';
import type { Product, StockAlert } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { buildWhatsAppUrl } from '../../utils/phoneUtils';

export const VendorProcurementModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    products,
    createDraftPOForVendor,
    directRestockVendor,
    dismissedProcurementIds,
    dismissProcurementProduct,
    restoreDismissedProcurementProducts,
  } = usePosStore();

  const { showToast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<'all' | 'critical'>('all');
  
  // Custom reorder quantity state per product ID
  const [customQtyMap, setCustomQtyMap] = useState<Record<string, number>>({});
  // Selected items map (productId -> boolean, defaults to true)
  const [selectedItemsMap, setSelectedItemsMap] = useState<Record<string, boolean>>({});
  // Custom added products per vendor that weren't originally in alert
  const [extraVendorProducts, setExtraVendorProducts] = useState<Record<string, string[]>>({});
  // Custom MOQ target per vendor
  const [vendorMoqMap, setVendorMoqMap] = useState<Record<string, number>>({});
  const [editingMoqVendor, setEditingMoqVendor] = useState<string | null>(null);
  const [tempMoqInput, setTempMoqInput] = useState<number>(100000);

  // WhatsApp Order Preview Modal State
  const [whatsappModalVendor, setWhatsappModalVendor] = useState<string | null>(null);
  const [whatsappCopied, setWhatsappCopied] = useState(false);

  // Add Item Dropdown State per Vendor
  const [activeAddVendor, setActiveAddVendor] = useState<string | null>(null);

  if (activeModal !== 'vendor_procurement') return null;

  const allAlerts = calculateStockAlerts(products);
  const baseAlerts = allAlerts.filter(
    (alert) => !dismissedProcurementIds || !dismissedProcurementIds.includes(alert.productId)
  );

  // Group low stock alerts + extra added items by Wholesale Vendor
  const vendorGroups: Record<string, StockAlert[]> = {};

  baseAlerts.forEach((alert) => {
    const vendor = alert.vendorName || 'Fournisseur Général';
    if (!vendorGroups[vendor]) vendorGroups[vendor] = [];
    vendorGroups[vendor].push(alert);
  });

  // Inject extra added products into vendor groups
  Object.entries(extraVendorProducts).forEach(([vendor, prodIds]) => {
    if (!vendorGroups[vendor]) vendorGroups[vendor] = [];
    prodIds.forEach((pid) => {
      if (!vendorGroups[vendor].some((a) => a.productId === pid)) {
        const prod = products.find((p) => p.id === pid);
        if (prod) {
          vendorGroups[vendor].push({
            id: `extra-${prod.id}`,
            productId: prod.id,
            sku: prod.sku,
            title: prod.title,
            brand: prod.brand,
            currentStock: prod.stock,
            reorderPoint: prod.reorderPoint || 10,
            severity: prod.stock <= 0 ? 'critical' : 'warning',
            vendorName: vendor,
            dailyVelocity: prod.dailySalesVelocity || 1.5,
          });
        }
      }
    });
  });

  // Calculate Global Procurement KPIs
  const totalVendors = Object.keys(vendorGroups).length;
  const totalAlertItems = baseAlerts.length;
  const criticalItemsCount = baseAlerts.filter((a) => a.severity === 'critical').length;

  const globalEstimatedBudget = Object.entries(vendorGroups).reduce((total, [, vendorAlerts]) => {
    return (
      total +
      vendorAlerts.reduce((acc, a) => {
        const isSelected = selectedItemsMap[a.productId] !== false;
        if (!isSelected) return acc;
        const prod = products.find((p) => p.id === a.productId);
        const cost = prod ? prod.costPrice : 1500;
        const defaultQty = Math.max(1, (a.reorderPoint * 2) - a.currentStock);
        const qty = customQtyMap[a.productId] !== undefined ? customQtyMap[a.productId] : defaultQty;
        return acc + cost * qty;
      }, 0)
    );
  }, 0);

  const handleQtyChange = (productId: string, newQty: number) => {
    const validQty = Math.max(1, isNaN(newQty) ? 1 : newQty);
    setCustomQtyMap((prev) => ({ ...prev, [productId]: validQty }));
  };

  const handleToggleItem = (productId: string) => {
    setSelectedItemsMap((prev) => ({
      ...prev,
      [productId]: prev[productId] === undefined ? false : !prev[productId],
    }));
  };

  const handleToggleSelectAll = (vendorAlerts: StockAlert[], selectAll: boolean) => {
    const nextMap = { ...selectedItemsMap };
    vendorAlerts.forEach((a) => {
      nextMap[a.productId] = selectAll;
    });
    setSelectedItemsMap(nextMap);
  };

  // 1-Click Strategy Presets
  const applyStrategy = (
    vendorAlerts: StockAlert[],
    strategy: 'min' | 'optimal' | 'moq' | 'reset',
    vendorName: string
  ) => {
    const nextQtyMap = { ...customQtyMap };
    const moqTarget = vendorMoqMap[vendorName] || 100000;

    if (strategy === 'reset') {
      vendorAlerts.forEach((a) => {
        delete nextQtyMap[a.productId];
      });
      setCustomQtyMap(nextQtyMap);
      showToast(`Quantités réinitialisées aux valeurs JIT recommandées pour ${vendorName}.`, 'info');
      return;
    }

    if (strategy === 'min') {
      vendorAlerts.forEach((a) => {
        const minQty = Math.max(1, a.reorderPoint - a.currentStock);
        nextQtyMap[a.productId] = minQty;
      });
      setCustomQtyMap(nextQtyMap);
      showToast(`Stratégie "Stock Sécurité (Min)" appliquée pour ${vendorName}.`, 'success');
      return;
    }

    if (strategy === 'optimal') {
      vendorAlerts.forEach((a) => {
        const optimalQty = Math.max(1, a.reorderPoint * 2 - a.currentStock);
        nextQtyMap[a.productId] = optimalQty;
      });
      setCustomQtyMap(nextQtyMap);
      showToast(`Stratégie "Stock Optimal (x2 Seuil)" appliquée pour ${vendorName}.`, 'success');
      return;
    }

    if (strategy === 'moq') {
      let currentCost = 0;
      vendorAlerts.forEach((a) => {
        const prod = products.find((p) => p.id === a.productId);
        const cost = prod ? prod.costPrice : 1500;
        const defaultQty = Math.max(1, a.reorderPoint * 2 - a.currentStock);
        const qty = nextQtyMap[a.productId] !== undefined ? nextQtyMap[a.productId] : defaultQty;
        currentCost += cost * qty;
      });

      if (currentCost <= 0) currentCost = 1;
      const multiplier = Math.max(1, moqTarget / currentCost);

      vendorAlerts.forEach((a) => {
        const defaultQty = Math.max(1, a.reorderPoint * 2 - a.currentStock);
        const currentQty = nextQtyMap[a.productId] !== undefined ? nextQtyMap[a.productId] : defaultQty;
        nextQtyMap[a.productId] = Math.ceil(currentQty * multiplier);
      });

      setCustomQtyMap(nextQtyMap);
      showToast(`Quantités optimisées pour atteindre le seuil Franco/MOQ de ${formatDZD(moqTarget)} !`, 'success');
    }
  };

  const handleCreatePO = (vendorName: string, vendorAlerts: StockAlert[]) => {
    const selectedLineItems = vendorAlerts
      .filter((a) => selectedItemsMap[a.productId] !== false)
      .map((a) => {
        const prod = products.find((p) => p.id === a.productId);
        const unitCost = prod ? prod.costPrice : 1500;
        const defaultQty = Math.max(1, a.reorderPoint * 2 - a.currentStock);
        const qty = customQtyMap[a.productId] !== undefined ? customQtyMap[a.productId] : defaultQty;
        return {
          productId: a.productId,
          qty,
          unitCost,
        };
      });

    if (selectedLineItems.length === 0) {
      showToast('Veuillez sélectionner au moins un article pour générer le bon de commande.', 'error');
      return;
    }

    createDraftPOForVendor(vendorName, selectedLineItems);
    showToast(`Bon de Commande PO généré pour ${vendorName} (${selectedLineItems.length} articles).`, 'success');
  };

  const handleDirectRestock = async (vendorName: string, vendorAlerts: StockAlert[]) => {
    const selectedLineItems = vendorAlerts
      .filter((a) => selectedItemsMap[a.productId] !== false)
      .map((a) => {
        const defaultQty = Math.max(1, a.reorderPoint * 2 - a.currentStock);
        const qty = customQtyMap[a.productId] !== undefined ? customQtyMap[a.productId] : defaultQty;
        return { productId: a.productId, qty };
      });

    if (selectedLineItems.length === 0) {
      showToast('Veuillez sélectionner au moins un article à réceptionner.', 'error');
      return;
    }

    const totalUnits = selectedLineItems.reduce((acc, i) => acc + i.qty, 0);
    if (
      !confirm(
        `Confirmez-vous la réception directe de ${selectedLineItems.length} références (+${totalUnits} unités) en provenance de "${vendorName}" ?\nLe stock sera immédiatement incrémenté dans la caisse.`
      )
    ) {
      return;
    }

    const res = await directRestockVendor(vendorName, selectedLineItems);
    if (res.success) {
      showToast(`Réception réussie : +${res.count} unités ajoutées en stock pour ${vendorName} !`, 'success');
    } else {
      showToast('Erreur lors de la mise à jour des stocks.', 'error');
    }
  };

  const handleExportCsv = (vendorName: string, vendorAlerts: StockAlert[]) => {
    const BOM = '\uFEFF';
    let csv = `${BOM}Fournisseur: ${vendorName}\nDate: ${new Date().toLocaleDateString('fr-DZ')}\n\n`;
    csv += 'Référence SKU;Désignation Produit;Stock Actuel;Seuil Alerte;Qté à Commander;Prix Achat Unitaire (DA);Total Ligne (DA)\n';

    let totalAmount = 0;
    vendorAlerts
      .filter((a) => selectedItemsMap[a.productId] !== false)
      .forEach((a) => {
        const prod = products.find((p) => p.id === a.productId);
        const unitCost = prod ? prod.costPrice : 1500;
        const defaultQty = Math.max(1, a.reorderPoint * 2 - a.currentStock);
        const qty = customQtyMap[a.productId] !== undefined ? customQtyMap[a.productId] : defaultQty;
        const lineTotal = unitCost * qty;
        totalAmount += lineTotal;

        csv += `"${a.sku}";"${a.title}";${a.currentStock};${a.reorderPoint};${qty};${unitCost};${lineTotal}\n`;
      });

    csv += `\n;;;;;TOTAL COMMANDE (DA);${totalAmount}\n`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Reapprovisionnement_${vendorName.replace(/\s+/g, '_')}_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`Fichier CSV exporté pour ${vendorName}`, 'success');
  };

  const generateWhatsAppMessage = (vendorName: string, vendorAlerts: StockAlert[]) => {
    const dateStr = new Date().toLocaleDateString('fr-DZ');
    const selected = vendorAlerts.filter((a) => selectedItemsMap[a.productId] !== false);
    
    let total = 0;
    let itemsText = '';

    selected.forEach((a, idx) => {
      const prod = products.find((p) => p.id === a.productId);
      const unitCost = prod ? prod.costPrice : 1500;
      const defaultQty = Math.max(1, a.reorderPoint * 2 - a.currentStock);
      const qty = customQtyMap[a.productId] !== undefined ? customQtyMap[a.productId] : defaultQty;
      const lineTotal = unitCost * qty;
      total += lineTotal;

      itemsText += `${idx + 1}. *${a.title}*\n   • SKU: \`${a.sku}\` | Qté: *${qty} pcs* (${formatDZD(unitCost)}/u)\n`;
    });

    return `*BON DE COMMANDE - ACCESSOIRES MOBI*\nFournisseur: *${vendorName}*\nDate: ${dateStr}\n\n*Articles demandés :*\n${itemsText}\n*TOTAL ESTIMÉ : ${formatDZD(total)}*\n\nMerci de nous confirmer la disponibilité et le délai de livraison.`;
  };

  const handleCopyWhatsApp = (vendorName: string, vendorAlerts: StockAlert[]) => {
    const text = generateWhatsAppMessage(vendorName, vendorAlerts);
    navigator.clipboard.writeText(text);
    setWhatsappCopied(true);
    showToast('Message de commande WhatsApp copié dans le presse-papier !', 'success');
    setTimeout(() => setWhatsappCopied(false), 2500);
  };

  const handleOpenWhatsAppWeb = (vendorName: string, vendorAlerts: StockAlert[], phone: string) => {
    const text = generateWhatsAppMessage(vendorName, vendorAlerts);
    const url = buildWhatsAppUrl(phone, text);
    window.open(url, '_blank');
  };

  const handleAddExtraProductToVendor = (vendorName: string, prod: Product) => {
    setExtraVendorProducts((prev) => {
      const currentList = prev[vendorName] || [];
      if (currentList.includes(prod.id)) return prev;
      return { ...prev, [vendorName]: [...currentList, prod.id] };
    });
    setActiveAddVendor(null);
    showToast(`Produit "${prod.title}" ajouté au réapprovisionnement de ${vendorName}`, 'success');
  };

  const handleSaveMoq = (vendorName: string) => {
    if (tempMoqInput > 0) {
      setVendorMoqMap((prev) => ({ ...prev, [vendorName]: tempMoqInput }));
      setEditingMoqVendor(null);
      showToast(`Objectif Franco/MOQ pour "${vendorName}" mis à jour : ${formatDZD(tempMoqInput)}`, 'success');
    }
  };

  return (
    <div
      onClick={closeModal}
      className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-6xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[92vh] flex flex-col relative cursor-default"
      >
        
        {/* Modal Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20">
              <Truck className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-pos-text tracking-wide">
                  TABLEAU DE RÉAPPROVISIONNEMENT JIT PAR FOURNISSEUR
                </h2>
                <span className="text-[10px] bg-emerald-500/10 text-emerald-400 font-black px-2 py-0.5 rounded border border-emerald-500/30 uppercase">
                  ENTERPRISE v2
                </span>
              </div>
              <p className="text-[11px] text-pos-muted">
                Algorithme Just-In-Time (JIT) basé sur la vélocité des ventes, seuils de sécurité et optimisation Franco/MOQ
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

        {/* Executive KPI Summary Bar */}
        <div className="bg-pos-bg border-b border-pos-border px-4 py-2.5 grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0 text-center select-none">
          <div className="bg-pos-card border border-pos-border rounded-xl p-2.5">
            <span className="text-[9px] uppercase font-bold text-pos-muted block">Grossistes en Alerte</span>
            <span className="text-base font-black text-pos-text">{totalVendors}</span>
          </div>

          <div className="bg-pos-card border border-amber-500/30 rounded-xl p-2.5">
            <span className="text-[9px] uppercase font-bold text-amber-400 block">Références sous Seuil</span>
            <span className="text-base font-black text-amber-300">{totalAlertItems}</span>
          </div>

          <div className="bg-pos-card border border-rose-500/30 rounded-xl p-2.5">
            <span className="text-[9px] uppercase font-bold text-rose-400 block">Ruptures Totales (Stock 0)</span>
            <span className="text-base font-black text-rose-300">{criticalItemsCount}</span>
          </div>

          <div className="bg-pos-card border border-emerald-500/30 rounded-xl p-2.5">
            <span className="text-[9px] uppercase font-bold text-emerald-400 block">Budget d'Achat Global Estimé</span>
            <span className="text-base font-black text-emerald-400">{formatDZD(globalEstimatedBudget)}</span>
          </div>
        </div>

        {/* Toolbar Filter & Global Actions */}
        <div className="bg-pos-card border-b border-pos-border p-3 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="relative flex-1 min-w-[280px] max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filtrer par Grossiste, Produit, SKU, Modèle..."
              className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-1.5 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none font-medium"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSeverityFilter('all')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                severityFilter === 'all'
                  ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                  : 'bg-pos-bg text-pos-muted border border-pos-border hover:text-pos-text'
              }`}
            >
              Toutes les Alertes ({baseAlerts.length})
            </button>

            <button
              onClick={() => setSeverityFilter('critical')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                severityFilter === 'critical'
                  ? 'bg-rose-500 text-white shadow-md'
                  : 'bg-pos-bg text-pos-muted border border-pos-border hover:text-pos-text'
              }`}
            >
              Ruptures Seules ({criticalItemsCount})
            </button>
          </div>
        </div>

        {/* Dismissed Items Alert Banner */}
        {dismissedProcurementIds && dismissedProcurementIds.length > 0 && (
          <div className="bg-amber-500/10 border-b border-amber-500/20 px-5 py-2 flex items-center justify-between text-xs">
            <span className="text-amber-400 font-semibold flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              {dismissedProcurementIds.length} article(s) masqué(s) / exclu(s) de la proposition d'achat.
            </span>
            <button
              type="button"
              onClick={() => {
                restoreDismissedProcurementProducts();
                showToast('Tous les articles exclus ont été réintégrés à la proposition.', 'success');
              }}
              className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-bold flex items-center gap-1 transition cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" /> Réintégrer les articles
            </button>
          </div>
        )}

        {/* Content Body: Grouped by Vendor */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6 bg-pos-bg">
          {Object.keys(vendorGroups).length === 0 ? (
            <div className="text-center py-20 text-pos-muted bg-pos-card border border-pos-border rounded-2xl max-w-lg mx-auto">
              <PackageCheck className="w-14 h-14 mx-auto mb-3 opacity-40 text-emerald-400" />
              <p className="text-base font-black text-pos-text">Tous les niveaux de stock sont optimaux !</p>
              <p className="text-xs text-pos-muted mt-1">
                Aucune alerte de réapprovisionnement en cours sur l'ensemble de votre catalogue.
              </p>
            </div>
          ) : (
            Object.entries(vendorGroups)
              .filter(([vendorName, vendorAlerts]) => {
                const q = searchQuery.trim().toLowerCase();
                const matchesVendor = !q || vendorName.toLowerCase().includes(q);
                const matchesItem = vendorAlerts.some(
                  (a) =>
                    a.title.toLowerCase().includes(q) ||
                    a.sku.toLowerCase().includes(q)
                );
                const matchesSeverity =
                  severityFilter === 'all' ||
                  (severityFilter === 'critical' && vendorAlerts.some((a) => a.severity === 'critical'));

                return (matchesVendor || matchesItem) && matchesSeverity;
              })
              .map(([vendorName, vendorAlerts]) => {
                const totalItems = vendorAlerts.length;
                const criticalCount = vendorAlerts.filter((a) => a.severity === 'critical').length;

                // Estimated order value for selected items of this vendor
                const selectedAlerts = vendorAlerts.filter((a) => selectedItemsMap[a.productId] !== false);
                const vendorEstimatedOrderValue = selectedAlerts.reduce((acc, a) => {
                  const prod = products.find((p) => p.id === a.productId);
                  const cost = prod ? prod.costPrice : 1500;
                  const suggestedQty = Math.max(1, a.reorderPoint * 2 - a.currentStock);
                  const qty = customQtyMap[a.productId] !== undefined ? customQtyMap[a.productId] : suggestedQty;
                  return acc + cost * qty;
                }, 0);

                const moqTarget = vendorMoqMap[vendorName] || 100000;
                const moqPercentage = Math.min(100, Math.round((vendorEstimatedOrderValue / moqTarget) * 100));

                const contactPhone =
                  vendorName === 'Fournisseur Général' ? '+213 555 00 00 00' : '+213 555 12 34 56';
                const contactEmail =
                  vendorName === 'Fournisseur Général'
                    ? 'contact@fournisseur-general.dz'
                    : `commande@${vendorName.toLowerCase().replace(/[^a-z0-9]/g, '')}.dz`;

                // Available other products from this vendor that can be added
                const otherCatalogProducts = products.filter(
                  (p) =>
                    (p.vendorName || 'Fournisseur Général') === vendorName &&
                    !vendorAlerts.some((a) => a.productId === p.id)
                );

                return (
                  <div
                    key={vendorName}
                    className="bg-pos-card border border-pos-border rounded-2xl p-5 space-y-4 shadow-sm hover:border-emerald-500/40 transition"
                  >
                    {/* Vendor Header & Contact Toolbar */}
                    <div className="flex flex-wrap justify-between items-start gap-3 pb-3 border-b border-pos-border">
                      <div>
                        <div className="flex items-center gap-2 mb-1.5">
                          <Truck className="w-4 h-4 text-emerald-400" />
                          <h3 className="text-base font-black text-pos-text">{vendorName}</h3>
                          <span className="bg-pos-bg text-pos-muted text-[10px] font-bold px-2 py-0.5 rounded-md border border-pos-border">
                            {totalItems} Références
                          </span>
                          {criticalCount > 0 && (
                            <span className="bg-rose-500/10 text-rose-400 border border-rose-500/30 text-[10px] font-bold px-2 py-0.5 rounded-md flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" /> {criticalCount} Ruptures Totales
                            </span>
                          )}
                        </div>

                        {/* Vendor Contacts */}
                        <div className="flex items-center gap-4 text-xs text-pos-muted">
                          <div className="flex items-center gap-1 font-mono">
                            <Phone className="w-3.5 h-3.5 text-emerald-400" /> {contactPhone}
                          </div>
                          <div className="flex items-center gap-1 font-mono">
                            <Mail className="w-3.5 h-3.5 text-cyan-400" /> {contactEmail}
                          </div>
                        </div>
                      </div>

                      {/* Vendor Quick Actions: WhatsApp, Direct Restock, PO */}
                      <div className="flex flex-wrap items-center gap-2">
                        
                        {/* WhatsApp Generator Button */}
                        <button
                          type="button"
                          onClick={() => setWhatsappModalVendor(vendorName)}
                          className="px-3.5 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 font-bold text-xs flex items-center gap-1.5 border border-emerald-500/30 transition cursor-pointer shadow-sm"
                          title="Générer et envoyer la commande par WhatsApp"
                        >
                          <MessageSquare className="w-3.5 h-3.5" /> Commande WhatsApp
                        </button>

                        {/* CSV Export Button */}
                        <button
                          type="button"
                          onClick={() => handleExportCsv(vendorName, vendorAlerts)}
                          className="p-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
                          title="Télécharger Bon de Commande en CSV (Excel)"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>

                        {/* Direct Restock Button */}
                        <button
                          type="button"
                          onClick={() => handleDirectRestock(vendorName, vendorAlerts)}
                          className="px-3.5 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500 text-amber-400 hover:text-slate-950 font-bold text-xs flex items-center gap-1.5 border border-amber-500/30 transition cursor-pointer shadow-sm"
                          title="Réception directe en caisse sans passer par un bon de commande brouillon"
                        >
                          <Zap className="w-3.5 h-3.5" /> Réception Directe Stock
                        </button>

                        {/* Official PO Button */}
                        <button
                          type="button"
                          onClick={() => handleCreatePO(vendorName, vendorAlerts)}
                          className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5" /> Créer Bon PO <ArrowRight className="w-3.5 h-3.5" />
                        </button>

                      </div>
                    </div>

                    {/* Replenishment Strategy Presets Toolbar */}
                    <div className="bg-pos-bg p-3 rounded-xl border border-pos-border flex flex-wrap items-center justify-between gap-3 text-xs">
                      
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1">
                          <Sparkles className="w-3 h-3 text-emerald-400" /> Stratégies JIT :
                        </span>

                        <button
                          type="button"
                          onClick={() => applyStrategy(vendorAlerts, 'min', vendorName)}
                          className="px-2.5 py-1 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-text text-[11px] font-bold transition cursor-pointer"
                          title="Ajuste la commande pour atteindre exactement le seuil de sécurité"
                        >
                          🎯 Stock Sécurité (Min)
                        </button>

                        <button
                          type="button"
                          onClick={() => applyStrategy(vendorAlerts, 'optimal', vendorName)}
                          className="px-2.5 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/30 text-[11px] font-bold transition cursor-pointer"
                          title="Quantité optimale JIT (x2 seuil de sécurité)"
                        >
                          ⚡ Stock Optimal (x2)
                        </button>

                        <button
                          type="button"
                          onClick={() => applyStrategy(vendorAlerts, 'moq', vendorName)}
                          className="px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500 text-cyan-400 hover:text-slate-950 border border-cyan-500/30 text-[11px] font-bold transition cursor-pointer"
                          title="Adapte proportionnellement les quantités pour atteindre le seuil Franco de port"
                        >
                          🏆 Optimiser Franco / MOQ
                        </button>

                        <button
                          type="button"
                          onClick={() => applyStrategy(vendorAlerts, 'reset', vendorName)}
                          className="p-1 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
                          title="Réinitialiser les quantités"
                        >
                          <RotateCcw className="w-3 h-3" />
                        </button>
                      </div>

                      {/* Selection Toggle (Select All / Unselect All) */}
                      <div className="flex items-center gap-2 text-[11px] text-pos-muted font-semibold">
                        <span>Sélection :</span>
                        <button
                          type="button"
                          onClick={() => handleToggleSelectAll(vendorAlerts, true)}
                          className="text-emerald-400 hover:underline font-bold"
                        >
                          Tout cocher
                        </button>
                        <span>•</span>
                        <button
                          type="button"
                          onClick={() => handleToggleSelectAll(vendorAlerts, false)}
                          className="text-pos-muted hover:text-pos-text hover:underline"
                        >
                          Tout décocher
                        </button>
                      </div>

                    </div>

                    {/* MOQ Target Progress Bar & Inline Editor */}
                    <div className="bg-pos-bg p-3 rounded-xl border border-pos-border flex items-center justify-between gap-4 text-xs">
                      <div className="flex-1">
                        <div className="flex justify-between items-center text-[10px] font-bold mb-1">
                          <div className="flex items-center gap-1.5 text-pos-muted uppercase">
                            <Target className="w-3 h-3 text-emerald-400" />
                            <span>Objectif Commande Minimale (MOQ / Franco de Port) :</span>
                            {editingMoqVendor === vendorName ? (
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  step="10000"
                                  value={tempMoqInput}
                                  onChange={(e) => setTempMoqInput(parseInt(e.target.value) || 50000)}
                                  className="w-24 bg-pos-card border border-emerald-400 rounded px-1.5 py-0.5 text-[10px] text-emerald-400 font-bold focus:outline-none"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleSaveMoq(vendorName)}
                                  className="px-1.5 py-0.5 bg-emerald-500 text-slate-950 font-bold rounded text-[9px]"
                                >
                                  OK
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMoqVendor(vendorName);
                                  setTempMoqInput(moqTarget);
                                }}
                                className="text-pos-text hover:text-emerald-400 underline flex items-center gap-0.5 font-bold"
                              >
                                {formatDZD(moqTarget)} <Edit2 className="w-2.5 h-2.5 ml-0.5 text-pos-muted" />
                              </button>
                            )}
                          </div>

                          <span className={moqPercentage >= 100 ? 'text-emerald-400 font-black' : 'text-amber-400 font-bold'}>
                            {moqPercentage}% Atteint {moqPercentage >= 100 ? '✓ (Franco Validé)' : ''}
                          </span>
                        </div>
                        <div className="w-full h-2 bg-pos-card rounded-full overflow-hidden border border-pos-border">
                          <div
                            className={`h-full transition-all duration-500 ${
                              moqPercentage >= 100
                                ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                                : 'bg-gradient-to-r from-amber-500 to-emerald-400'
                            }`}
                            style={{ width: `${moqPercentage}%` }}
                          />
                        </div>
                      </div>

                      <div className="text-right shrink-0 pl-3 border-l border-pos-border">
                        <span className="text-[10px] text-pos-muted block font-semibold">Total Estimé Commande</span>
                        <span className="text-base font-black text-emerald-400">{formatDZD(vendorEstimatedOrderValue)}</span>
                      </div>
                    </div>

                    {/* List of Low Stock Items */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {vendorAlerts.map((alert) => {
                        const isSelected = selectedItemsMap[alert.productId] !== false;
                        const defaultSuggestedQty = Math.max(1, alert.reorderPoint * 2 - alert.currentStock);
                        const currentQty =
                          customQtyMap[alert.productId] !== undefined
                            ? customQtyMap[alert.productId]
                            : defaultSuggestedQty;
                        const prod = products.find((p) => p.id === alert.productId);
                        const unitCost = prod ? prod.costPrice : 1500;
                        const itemSubtotal = unitCost * currentQty;

                        // Days until stockout forecast
                        const velocity = alert.dailyVelocity || 1.5;
                        const daysLeft = velocity > 0 ? (alert.currentStock / velocity).toFixed(1) : '99';

                        return (
                          <div
                            key={alert.id}
                            className={`border p-3 rounded-xl flex flex-col justify-between text-xs space-y-2.5 transition ${
                              isSelected
                                ? 'bg-pos-bg border-pos-border'
                                : 'bg-pos-bg/40 border-pos-border/40 opacity-60'
                            }`}
                          >
                            <div className="flex items-start gap-2.5">
                              {/* Selection Checkbox */}
                              <button
                                type="button"
                                onClick={() => handleToggleItem(alert.productId)}
                                className="mt-0.5 text-pos-muted hover:text-emerald-400 transition cursor-pointer"
                              >
                                {isSelected ? (
                                  <CheckSquare className="w-4 h-4 text-emerald-400" />
                                ) : (
                                  <Square className="w-4 h-4 text-pos-muted" />
                                )}
                              </button>

                              <div className="flex-1 min-w-0">
                                <p className="font-bold text-pos-text truncate text-xs">{alert.title}</p>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[10px] font-mono text-pos-muted">SKU: {alert.sku}</span>
                                  <span className="text-[10px] text-pos-muted">
                                    • Coût: <span className="font-bold text-pos-text">{formatDZD(unitCost)}</span>
                                  </span>
                                </div>
                              </div>

                              {/* Stockout Warning Badge & Dismiss Action */}
                              <div className="text-right shrink-0 space-y-1 flex flex-col items-end">
                                <div className="flex items-center gap-1.5">
                                  <span
                                    className={`px-2 py-0.5 rounded-md text-[10px] font-bold block ${
                                      alert.currentStock <= 0
                                        ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                                        : 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                                    }`}
                                  >
                                    Stock: {alert.currentStock} (Seuil: {alert.reorderPoint})
                                  </span>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      dismissProcurementProduct(alert.productId);
                                      showToast(`"${alert.title}" masqué de la proposition.`, 'info');
                                    }}
                                    className="p-1 hover:bg-rose-500/15 text-pos-muted hover:text-rose-400 rounded-md transition cursor-pointer"
                                    title="Exclure / Masquer cet article de la proposition fournisseur"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>

                                <span className="text-[9px] text-pos-muted font-semibold flex items-center justify-end gap-1">
                                  <Clock className="w-2.5 h-2.5 text-amber-400" />
                                  {alert.currentStock <= 0 ? 'Rupture immédiate' : `Rupture dans ~${daysLeft}j`}
                                </span>
                              </div>
                            </div>

                            {/* Quantity Customizer & Line Subtotal */}
                            <div className="flex items-center justify-between pt-2 border-t border-pos-border/60 text-[11px]">
                              <div className="flex items-center gap-2">
                                <span className="text-pos-muted font-semibold text-[10px]">Commander :</span>
                                
                                <div className="flex items-center border border-pos-border rounded-lg bg-pos-card overflow-hidden">
                                  <button
                                    type="button"
                                    onClick={() => handleQtyChange(alert.productId, currentQty - 1)}
                                    className="px-2 py-1 hover:bg-pos-hover text-pos-text text-xs transition cursor-pointer"
                                  >
                                    <Minus className="w-3 h-3" />
                                  </button>

                                  <input
                                    type="number"
                                    min="1"
                                    value={currentQty}
                                    onChange={(e) => handleQtyChange(alert.productId, parseInt(e.target.value) || 1)}
                                    className="w-12 text-center bg-transparent text-emerald-400 font-mono font-bold text-xs focus:outline-none"
                                  />

                                  <button
                                    type="button"
                                    onClick={() => handleQtyChange(alert.productId, currentQty + 1)}
                                    className="px-2 py-1 hover:bg-pos-hover text-pos-text text-xs transition cursor-pointer"
                                  >
                                    <Plus className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>

                              <div className="text-right">
                                <span className="text-[9px] text-pos-muted font-semibold block uppercase">Sous-total</span>
                                <span className="font-black text-pos-text text-xs">
                                  {isSelected ? formatDZD(itemSubtotal) : 'Exclu (0 DA)'}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Add Other Product from Supplier */}
                    {otherCatalogProducts.length > 0 && (
                      <div className="pt-2 border-t border-pos-border/60">
                        {activeAddVendor === vendorName ? (
                          <div className="p-3 bg-pos-bg border border-pos-border rounded-xl space-y-2 animate-in fade-in">
                            <div className="flex justify-between items-center">
                              <span className="text-xs font-bold text-pos-text">
                                Sélectionner un article de "{vendorName}" à ajouter au réapprovisionnement :
                              </span>
                              <button
                                type="button"
                                onClick={() => setActiveAddVendor(null)}
                                className="text-xs text-pos-muted hover:text-pos-text font-bold"
                              >
                                Annuler
                              </button>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                              {otherCatalogProducts.map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  onClick={() => handleAddExtraProductToVendor(vendorName, p)}
                                  className="p-2 rounded-lg bg-pos-card border border-pos-border hover:border-emerald-400 text-left text-xs transition flex justify-between items-center"
                                >
                                  <div className="truncate pr-2">
                                    <p className="font-bold text-pos-text truncate">{p.title}</p>
                                    <span className="text-[10px] text-pos-muted">Stock: {p.stock} • Coût: {formatDZD(p.costPrice)}</span>
                                  </div>
                                  <PlusCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setActiveAddVendor(vendorName)}
                            className="text-xs font-bold text-emerald-400 hover:text-emerald-300 hover:underline flex items-center gap-1.5 cursor-pointer"
                          >
                            <PlusCircle className="w-3.5 h-3.5" /> Ajouter un autre article de ce grossiste au réapprovisionnement
                          </button>
                        )}
                      </div>
                    )}

                  </div>
                );
              })
          )}
        </div>

        {/* Footer */}
        <div className="p-3.5 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
          <span>Algorithme de Réapprovisionnement Just-In-Time (JIT) • Mobi-POS Enterprise</span>
          <button
            onClick={closeModal}
            className="px-5 py-2 rounded-xl bg-pos-hover text-pos-text font-bold hover:bg-pos-border transition cursor-pointer"
          >
            Fermer
          </button>
        </div>

        {/* WhatsApp Order Preview Modal Dialog */}
        {whatsappModalVendor && (
          <div className="absolute inset-0 bg-black/85 backdrop-blur-md z-30 flex items-center justify-center p-6 animate-in fade-in">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
              
              <div className="p-4 border-b border-pos-border bg-pos-card flex items-center justify-between">
                <div className="flex items-center gap-2 text-emerald-400">
                  <MessageSquare className="w-5 h-5" />
                  <h3 className="text-sm font-bold text-pos-text">
                    Aperçu Commande WhatsApp : {whatsappModalVendor}
                  </h3>
                </div>
                <button
                  onClick={() => setWhatsappModalVendor(null)}
                  className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-5 overflow-y-auto space-y-3 text-xs">
                <p className="text-pos-muted text-xs">
                  Ce texte est prêt à être envoyé directement à votre grossiste par WhatsApp ou SMS :
                </p>
                <textarea
                  readOnly
                  rows={10}
                  value={generateWhatsAppMessage(
                    whatsappModalVendor,
                    vendorGroups[whatsappModalVendor] || []
                  )}
                  className="w-full bg-pos-bg border border-pos-border rounded-xl p-3 font-mono text-xs text-emerald-400 focus:outline-none select-all"
                />
              </div>

              <div className="p-4 border-t border-pos-border bg-pos-card flex justify-between items-center">
                <button
                  type="button"
                  onClick={() => setWhatsappModalVendor(null)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text"
                >
                  Fermer
                </button>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyWhatsApp(whatsappModalVendor, vendorGroups[whatsappModalVendor] || [])
                    }
                    className="px-4 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
                  >
                    {whatsappCopied ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    {whatsappCopied ? 'Texte Copié !' : 'Copier le Texte'}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      handleOpenWhatsAppWeb(
                        whatsappModalVendor,
                        vendorGroups[whatsappModalVendor] || [],
                        whatsappModalVendor === 'Fournisseur Général' ? '+213555000000' : '+213555123456'
                      )
                    }
                    className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition cursor-pointer"
                  >
                    <ExternalLink className="w-4 h-4" /> Ouvrir WhatsApp Web
                  </button>
                </div>
              </div>

            </div>
          </div>
        )}

      </div>
    </div>
  );
};

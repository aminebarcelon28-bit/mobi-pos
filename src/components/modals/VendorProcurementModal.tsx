import React, { useMemo, useState } from 'react';
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
  Printer,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { calculateStockAlerts } from '../../utils/alertEngine';
import { formatDZD } from '../../types/pos';
import type { Product, StockAlert } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { openDialer, openNativePrint, openWhatsApp } from '../../utils/phoneUtils';

export const VendorProcurementModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    openModal,
    purchaseOrders,
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
  const [vendorProductSearch, setVendorProductSearch] = useState('');
  const [vendorProductScope, setVendorProductScope] = useState<'all' | 'vendor'>('all');

  // Supplier Selection Modal & Custom Active Vendors
  const [showAddSupplierModal, setShowAddSupplierModal] = useState(false);
  const [newSupplierInput, setNewSupplierInput] = useState('');
  const [supplierSearchTerm, setSupplierSearchTerm] = useState('');
  const [customActiveVendors, setCustomActiveVendors] = useState<string[]>([]);

  // Progressive disclosure keeps large supplier catalogs from mounting hundreds
  // of editable rows at once on low-memory phones.
  const [expandedVendors, setExpandedVendors] = useState<Set<string>>(new Set());

  const allAlerts = useMemo(() => calculateStockAlerts(products), [products]);
  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  );
  const baseAlerts = useMemo(
    () => allAlerts.filter(
      (alert) => !dismissedProcurementIds || !dismissedProcurementIds.includes(alert.productId)
    ),
    [allAlerts, dismissedProcurementIds]
  );

  // All known suppliers across products and historical POs
  const knownSuppliers = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => {
      if (p.vendorName && p.vendorName.trim()) {
        set.add(p.vendorName.trim());
      }
    });
    purchaseOrders.forEach((po) => {
      if (po.vendorName && po.vendorName.trim()) {
        set.add(po.vendorName.trim());
      }
    });
    if (!set.has('Fournisseur Général')) {
      set.add('Fournisseur Général');
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'fr'));
  }, [products, purchaseOrders]);

  // Group low stock alerts + extra added items by Wholesale Vendor
  const vendorGroups = useMemo(() => {
    const groups: Record<string, StockAlert[]> = {};

    // 1. Low stock alerts from catalog
    baseAlerts.forEach((alert) => {
      const vendor = alert.vendorName || 'Fournisseur Général';
      (groups[vendor] ||= []).push(alert);
    });

    // 2. Custom active suppliers chosen by user (even if 0 alerts)
    customActiveVendors.forEach((vendor) => {
      groups[vendor] ||= [];
    });

    // 3. Extra manually added catalog products
    Object.entries(extraVendorProducts).forEach(([vendor, productIds]) => {
      const group = (groups[vendor] ||= []);
      productIds.forEach((productId) => {
        if (group.some((alert) => alert.productId === productId)) return;
        const product = productsById.get(productId);
        if (!product) return;
        group.push({
          id: `extra-${product.id}`,
          productId: product.id,
          sku: product.sku,
          title: product.title,
          brand: product.brand,
          currentStock: product.stock,
          reorderPoint: product.reorderPoint || 10,
          severity: product.stock <= 0 ? 'critical' : 'warning',
          vendorName: vendor,
          dailyVelocity: product.dailySalesVelocity || 1.5,
        });
      });
    });

    return groups;
  }, [baseAlerts, customActiveVendors, extraVendorProducts, productsById]);

  // Computed candidate products for active vendor product picker
  const activeVendorAlerts = useMemo(
    () => (activeAddVendor ? (vendorGroups[activeAddVendor] || []) : []),
    [activeAddVendor, vendorGroups]
  );
  const activeVendorAlertIds = useMemo(
    () => new Set(activeVendorAlerts.map((a) => a.productId)),
    [activeVendorAlerts]
  );

  const availableCandidateProducts = useMemo(() => {
    if (!activeAddVendor) return [];
    const q = vendorProductSearch.trim().toLowerCase();

    return products.filter((p) => {
      if (activeVendorAlertIds.has(p.id)) return false;
      if (vendorProductScope === 'vendor') {
        const pVendor = p.vendorName || 'Fournisseur Général';
        if (pVendor !== activeAddVendor) return false;
      }
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        Boolean(p.barcode && p.barcode.toLowerCase().includes(q)) ||
        Boolean(p.brand && p.brand.toLowerCase().includes(q))
      );
    });
  }, [activeAddVendor, products, activeVendorAlertIds, vendorProductScope, vendorProductSearch]);

  // Early return AFTER all hooks: returning before the useMemos above changed
  // the hook order between renders and crashed React when opening/closing.
  if (activeModal !== 'vendor_procurement') return null;

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
        const prod = productsById.get(a.productId);
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
        const prod = productsById.get(a.productId);
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
        const prod = productsById.get(a.productId);
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

    const restockResult = await directRestockVendor(vendorName, selectedLineItems);
    if (restockResult.success) {
      showToast(`Réception réussie : +${restockResult.count} unités ajoutées en stock pour ${vendorName} !`, 'success');
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
        const prod = productsById.get(a.productId);
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
      const prod = productsById.get(a.productId);
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

  const handleOpenWhatsAppWeb = async (vendorName: string, vendorAlerts: StockAlert[], phone: string) => {
    const text = generateWhatsAppMessage(vendorName, vendorAlerts);
    const ok = await openWhatsApp(phone, text);
    if (!ok) {
      showToast("Impossible d'ouvrir WhatsApp", 'error');
    }
  };

  const buildVendorOrderText = (vendorName: string, vendorAlerts: StockAlert[]) => {
    const selected = vendorAlerts.filter((alert) => selectedItemsMap[alert.productId] !== false);
    const lines = selected.map((alert, index) => {
      const product = products.find((item) => item.id === alert.productId);
      const unitCost = product ? product.costPrice : 1500;
      const defaultQty = Math.max(1, alert.reorderPoint * 2 - alert.currentStock);
      const qty = customQtyMap[alert.productId] ?? defaultQty;
      return `${index + 1}. ${alert.title} | SKU ${alert.sku} | ${qty} pcs | ${formatDZD(unitCost * qty)}`;
    });
    return [
      'MOBIPOS - BON DE REAPPROVISIONNEMENT JIT',
      `Fournisseur: ${vendorName}`,
      `Date: ${new Date().toLocaleDateString('fr-DZ')}`,
      '',
      ...lines,
      '',
      'Merci de confirmer la disponibilite et le delai de livraison.',
    ].join('\n');
  };

  const handlePrintVendorOrder = async (vendorName: string, vendorAlerts: StockAlert[]) => {
    const selected = vendorAlerts.filter((alert) => selectedItemsMap[alert.productId] !== false);
    if (selected.length === 0) {
      showToast('Sélectionnez au moins un article avant impression.', 'error');
      return;
    }
    const printed = await openNativePrint(`MobiPOS - ${vendorName}`, buildVendorOrderText(vendorName, vendorAlerts));
    showToast(printed ? 'Bon fournisseur envoyé à l’impression.' : 'Impossible d’ouvrir l’impression.', printed ? 'success' : 'error');
  };

  const handleAddExtraProductToVendor = (vendorName: string, prod: Product) => {
    setExtraVendorProducts((prev) => {
      const currentList = prev[vendorName] || [];
      if (currentList.includes(prod.id)) return prev;
      return { ...prev, [vendorName]: [...currentList, prod.id] };
    });
    setExpandedVendors((prev) => new Set([...prev, vendorName]));
    setSelectedItemsMap((prev) => ({ ...prev, [prod.id]: true }));
    showToast(`Produit "${prod.title}" ajouté au réapprovisionnement de ${vendorName}`, 'success');
  };

  const handleRemoveExtraProductFromVendor = (vendorName: string, productId: string) => {
    setExtraVendorProducts((prev) => {
      const currentList = prev[vendorName] || [];
      return { ...prev, [vendorName]: currentList.filter((id) => id !== productId) };
    });
    showToast("Article retiré de la commande fournisseur", 'info');
  };

  const handleSelectOrCreateSupplier = (vendorName: string) => {
    const trimmed = vendorName.trim();
    if (!trimmed) return;
    if (!customActiveVendors.includes(trimmed)) {
      setCustomActiveVendors((prev) => [...prev, trimmed]);
    }
    setExpandedVendors((prev) => new Set([...prev, trimmed]));
    setActiveAddVendor(trimmed);
    setShowAddSupplierModal(false);
    setNewSupplierInput('');
    setSupplierSearchTerm('');
    showToast(`Grossiste "${trimmed}" activé. Choisissez vos articles.`, 'success');
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
      className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-0 sm:p-4 select-none cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border-0 sm:border border-pos-border rounded-none sm:rounded-2xl w-full max-w-6xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-full sm:h-[92vh] flex flex-col relative cursor-default pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:pt-0 sm:pb-0"
      >
        
        {/* Modal Header */}
        <div className="px-3 py-2.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2 sm:gap-3">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20 shrink-0">
              <Truck className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                <h2 className="text-xs sm:text-base font-black text-pos-text tracking-wide truncate">
                  RÉAPPROVISIONNEMENT FOURNISSEURS
                </h2>
                <span className="hidden sm:inline text-[10px] bg-emerald-500/10 text-emerald-400 font-black px-2 py-0.5 rounded border border-emerald-500/30 uppercase shrink-0">
                  ENTERPRISE v2
                </span>
              </div>
              <p className="hidden sm:block text-[11px] text-pos-muted truncate">
                Algorithme Just-In-Time (JIT) basé sur la vélocité des ventes, seuils de sécurité et optimisation Franco/MOQ
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition shrink-0 cursor-pointer"
            aria-label="Fermer le tableau de réapprovisionnement"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Executive KPI Summary Bar (Compact 2x2 grid on mobile) */}
        <div className="bg-pos-bg border-b border-pos-border px-2.5 sm:px-3 py-2 sm:py-2.5 grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-3 shrink-0 text-center select-none">
          <div className="bg-pos-card border border-pos-border rounded-xl p-1.5 sm:p-2.5">
            <span className="text-[8px] sm:text-[9px] uppercase font-bold text-pos-muted block truncate">Grossistes</span>
            <span className="text-xs sm:text-base font-black text-pos-text">{totalVendors}</span>
          </div>

          <div className="bg-pos-card border border-amber-500/30 rounded-xl p-1.5 sm:p-2.5">
            <span className="text-[8px] sm:text-[9px] uppercase font-bold text-amber-400 block truncate">Sous Seuil</span>
            <span className="text-xs sm:text-base font-black text-amber-300">{totalAlertItems}</span>
          </div>

          <div className="bg-pos-card border border-rose-500/30 rounded-xl p-1.5 sm:p-2.5">
            <span className="text-[8px] sm:text-[9px] uppercase font-bold text-rose-400 block truncate">Ruptures (0)</span>
            <span className="text-xs sm:text-base font-black text-rose-300">{criticalItemsCount}</span>
          </div>

          <div className="bg-pos-card border border-emerald-500/30 rounded-xl p-1.5 sm:p-2.5">
            <span className="text-[8px] sm:text-[9px] uppercase font-bold text-emerald-400 block truncate">Budget Estimé</span>
            <span className="text-xs sm:text-base font-black text-emerald-400 truncate">{formatDZD(globalEstimatedBudget)}</span>
          </div>
        </div>

        {/* Toolbar Filter & Global Actions */}
        <div className="bg-pos-card border-b border-pos-border p-2.5 sm:p-3 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 sm:gap-3 shrink-0">
          <div className="relative flex-1 min-w-0">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filtrer par Grossiste, Produit, SKU..."
              className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-8 py-2 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none font-medium min-h-[42px]"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs p-1 min-h-[32px] min-w-[32px] flex items-center justify-center cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto no-scrollbar pb-1 pt-0.5 -mx-1 px-1">
            <button
              onClick={() => setShowAddSupplierModal(true)}
              className="px-3.5 py-2 rounded-xl text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 active:scale-95 transition cursor-pointer flex items-center gap-1.5 shrink-0 min-h-[40px]"
              title="Commander chez un fournisseur spécifique ou ajouter un nouveau grossiste"
            >
              <Truck className="w-3.5 h-3.5 text-emerald-400" />
              <span>+ Choisir Grossiste</span>
            </button>

            <button
              onClick={() => setSeverityFilter('all')}
              className={`px-3 py-2 rounded-xl text-xs font-bold transition cursor-pointer shrink-0 min-h-[40px] active:scale-95 ${
                severityFilter === 'all'
                  ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                  : 'bg-pos-bg text-pos-muted border border-pos-border hover:text-pos-text'
              }`}
            >
              Toutes ({baseAlerts.length})
            </button>

            <button
              onClick={() => setSeverityFilter('critical')}
              className={`px-3 py-2 rounded-xl text-xs font-bold transition cursor-pointer shrink-0 min-h-[40px] active:scale-95 ${
                severityFilter === 'critical'
                  ? 'bg-rose-500 text-white shadow-md'
                  : 'bg-pos-bg text-pos-muted border border-pos-border hover:text-pos-text'
              }`}
            >
              Ruptures ({criticalItemsCount})
            </button>

            <button
              onClick={() => openModal('command_tickets')}
              className="px-3 py-2 rounded-xl text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30 active:scale-95 transition cursor-pointer flex items-center gap-1.5 shrink-0 min-h-[40px]"
              title="Ouvrir le Tableau de Bord des Commandes & File d'Attente"
            >
              <Clock className="w-3.5 h-3.5 text-amber-400" />
              <span>Attente ({purchaseOrders.filter((po) => po.status === 'Waiting List' || po.status === 'Draft').length})</span>
            </button>

            <button
              onClick={() => openModal('purchase_order')}
              className="px-3 py-2 rounded-xl text-xs font-bold bg-blue-500/20 text-blue-300 border border-blue-500/40 hover:bg-blue-500/30 active:scale-95 transition cursor-pointer flex items-center gap-1.5 shrink-0 min-h-[40px]"
              title="Ouvrir le Bon de Commande Détaillé & Réception Fournisseur"
            >
              <FileText className="w-3.5 h-3.5 text-blue-400" />
              <span>Bons PO</span>
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
        <div className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-4 sm:space-y-6 bg-pos-bg overscroll-contain">
          {Object.keys(vendorGroups).length === 0 ? (
            <div className="text-center py-16 px-4 text-pos-muted bg-pos-card border border-pos-border rounded-2xl max-w-lg mx-auto space-y-3">
              <PackageCheck className="w-14 h-14 mx-auto mb-2 opacity-40 text-emerald-400" />
              <p className="text-base font-black text-pos-text">Tous les niveaux de stock sont optimaux !</p>
              <p className="text-xs text-pos-muted">
                Aucune alerte de réapprovisionnement en cours sur l'ensemble de votre catalogue.
              </p>
              <div className="pt-2 flex flex-col sm:flex-row gap-2 justify-center">
                <button
                  type="button"
                  onClick={() => setShowAddSupplierModal(true)}
                  className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl transition inline-flex items-center justify-center gap-1.5 cursor-pointer shadow-md shadow-emerald-500/20"
                >
                  <Truck className="w-4 h-4" /> Commander chez un Grossiste
                </button>
                <button
                  type="button"
                  onClick={() => openModal('purchase_order')}
                  className="px-4 py-2 bg-pos-panel hover:bg-pos-hover border border-pos-border text-pos-text font-bold text-xs rounded-xl transition inline-flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <FileText className="w-4 h-4 text-blue-400" /> Nouveau Bon de Commande
                </button>
              </div>
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
                  const prod = productsById.get(a.productId);
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

                // Count of products explicitly linked to this vendor in catalog
                const vendorLinkedProductsCount = products.filter(
                  (p) =>
                    (p.vendorName || 'Fournisseur Général') === vendorName &&
                    !vendorAlerts.some((a) => a.productId === p.id)
                ).length;
                const isExpanded = expandedVendors.has(vendorName);

                return (
                  <div
                    key={vendorName}
                    className="bg-pos-card border border-pos-border rounded-2xl p-3 sm:p-5 space-y-4 shadow-sm hover:border-emerald-500/40 transition"
                  >
                    {/* Vendor Header & Contact Toolbar */}
                    <div className="flex flex-col sm:flex-row sm:flex-wrap justify-between items-start gap-3 pb-3 border-b border-pos-border">
                      <div>
                        <div className="flex items-center gap-2 mb-1.5 min-w-0 flex-wrap">
                          <Truck className="w-4 h-4 text-emerald-400" />
                          <h3 className="text-sm sm:text-base font-black text-pos-text truncate max-w-[16rem]">{vendorName}</h3>
                          <span className="bg-pos-bg text-pos-muted text-[10px] font-bold px-2 py-0.5 rounded-md border border-pos-border">
                            {totalItems} Références
                          </span>
                          {customActiveVendors.includes(vendorName) && totalItems === 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setCustomActiveVendors((prev) => prev.filter((v) => v !== vendorName));
                                showToast(`Fournisseur "${vendorName}" retiré.`, 'info');
                              }}
                              className="text-[10px] text-rose-400 hover:text-rose-300 underline font-semibold cursor-pointer ml-1"
                              title="Retirer ce fournisseur sans commande"
                            >
                              Retirer
                            </button>
                          )}
                          {criticalCount > 0 && (
                            <span className="bg-rose-500/10 text-rose-400 border border-rose-500/30 text-[10px] font-bold px-2 py-0.5 rounded-md flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" /> {criticalCount} Ruptures Totales
                            </span>
                          )}
                        </div>

                        {/* Vendor Contacts */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-pos-muted">
                          <button
                            type="button"
                            onClick={() => openDialer(contactPhone)}
                            className="flex items-center gap-1 font-mono hover:text-emerald-400 transition cursor-pointer min-h-[36px]"
                            title="Appeler ce fournisseur"
                          >
                            <Phone className="w-3.5 h-3.5 text-emerald-400" /> {contactPhone}
                          </button>
                          <a
                            href={`mailto:${contactEmail}`}
                            className="flex items-center gap-1 font-mono hover:text-cyan-400 transition min-h-[36px]"
                            title="Envoyer un e-mail"
                          >
                            <Mail className="w-3.5 h-3.5 text-cyan-400" /> {contactEmail}
                          </a>
                        </div>
                      </div>

                      {/* Vendor Quick Actions: WhatsApp, Direct Restock, PO */}
                      <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 w-full sm:w-auto">
                        <button
                          type="button"
                          onClick={() => setExpandedVendors((current) => {
                            const next = new Set(current);
                            if (next.has(vendorName)) next.delete(vendorName);
                            else next.add(vendorName);
                            return next;
                          })}
                          className="col-span-2 min-h-[44px] px-2.5 sm:px-3.5 py-2 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border text-pos-text font-bold text-[11px] sm:text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? <Minus className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                          {isExpanded ? 'Masquer les articles' : (totalItems === 0 ? 'Afficher / Choisir des articles' : `Voir les ${totalItems} articles`)}
                        </button>
                        
                        {/* WhatsApp Generator Button */}
                        <button
                          type="button"
                          onClick={() => setWhatsappModalVendor(vendorName)}
                          className="min-h-[44px] px-2.5 sm:px-3.5 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 font-bold text-[11px] sm:text-xs flex items-center justify-center gap-1.5 border border-emerald-500/30 transition cursor-pointer shadow-sm"
                          title="Générer et envoyer la commande par WhatsApp"
                        >
                          <MessageSquare className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">WhatsApp</span>
                        </button>

                        {/* CSV Export Button */}
                        <button
                          type="button"
                          onClick={() => handleExportCsv(vendorName, vendorAlerts)}
                          className="min-h-[44px] min-w-[44px] p-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer flex items-center justify-center"
                          title="Télécharger Bon de Commande en CSV (Excel)"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={() => void handlePrintVendorOrder(vendorName, vendorAlerts)}
                          className="min-h-[44px] min-w-[44px] p-2 rounded-xl bg-cyan-500/10 hover:bg-cyan-500 hover:text-slate-950 border border-cyan-500/30 text-cyan-400 transition cursor-pointer flex items-center justify-center"
                          title="Imprimer le bon fournisseur"
                          aria-label={`Imprimer la commande de ${vendorName}`}
                        >
                          <Printer className="w-3.5 h-3.5" />
                        </button>

                        {/* Direct Restock Button */}
                        <button
                          type="button"
                          onClick={() => handleDirectRestock(vendorName, vendorAlerts)}
                          className="min-h-[44px] px-2.5 sm:px-3.5 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500 text-amber-400 hover:text-slate-950 font-bold text-[11px] sm:text-xs flex items-center justify-center gap-1.5 border border-amber-500/30 transition cursor-pointer shadow-sm"
                          title="Réception directe en caisse sans passer par un bon de commande brouillon"
                        >
                          <Zap className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">Réception</span>
                        </button>

                        {/* Official PO Button */}
                        <button
                          type="button"
                          onClick={() => handleCreatePO(vendorName, vendorAlerts)}
                          className="min-h-[44px] px-2.5 sm:px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-[11px] sm:text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/20 transition cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">Créer PO</span> <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                        </button>

                      </div>
                    </div>

                    {isExpanded && <>
                    {/* Replenishment Strategy Presets Toolbar */}
                    <div className="bg-pos-bg p-2.5 sm:p-3 rounded-xl border border-pos-border flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-3 text-xs">
                      
                      <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar pb-1 sm:pb-0">
                        <span className="text-[10px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1 shrink-0 mr-1">
                          <Sparkles className="w-3 h-3 text-emerald-400" /> Stratégies :
                        </span>

                        <button
                          type="button"
                          onClick={() => applyStrategy(vendorAlerts, 'min', vendorName)}
                          className="min-h-[36px] px-2.5 py-1 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-text text-[11px] font-bold transition cursor-pointer shrink-0"
                          title="Ajuste la commande pour atteindre exactement le seuil de sécurité"
                        >
                          🎯 Sécurité (Min)
                        </button>

                        <button
                          type="button"
                          onClick={() => applyStrategy(vendorAlerts, 'optimal', vendorName)}
                          className="min-h-[36px] px-2.5 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/30 text-[11px] font-bold transition cursor-pointer shrink-0"
                          title="Quantité optimale JIT (x2 seuil de sécurité)"
                        >
                          ⚡ Optimal (x2)
                        </button>

                        <button
                          type="button"
                          onClick={() => applyStrategy(vendorAlerts, 'moq', vendorName)}
                          className="min-h-[36px] px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500 text-cyan-400 hover:text-slate-950 border border-cyan-500/30 text-[11px] font-bold transition cursor-pointer shrink-0"
                          title="Adapte proportionnellement les quantités pour atteindre le seuil Franco de port"
                        >
                          🏆 Franco / MOQ
                        </button>

                        <button
                          type="button"
                          onClick={() => applyStrategy(vendorAlerts, 'reset', vendorName)}
                          className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer shrink-0 flex items-center justify-center"
                          title="Réinitialiser les quantités"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Selection Toggle (Select All / Unselect All) */}
                      <div className="flex items-center gap-2 text-[11px] text-pos-muted font-semibold shrink-0 pt-1.5 sm:pt-0 border-t sm:border-t-0 border-pos-border/50">
                        <span>Sélection :</span>
                        <button
                          type="button"
                          onClick={() => handleToggleSelectAll(vendorAlerts, true)}
                          className="min-h-[32px] flex items-center text-emerald-400 hover:underline font-bold cursor-pointer"
                        >
                          Tout cocher
                        </button>
                        <span>•</span>
                        <button
                          type="button"
                          onClick={() => handleToggleSelectAll(vendorAlerts, false)}
                          className="min-h-[32px] flex items-center text-pos-muted hover:text-pos-text hover:underline cursor-pointer"
                        >
                          Tout décocher
                        </button>
                      </div>

                    </div>

                    {/* MOQ Target Progress Bar & Inline Editor */}
                    <div className="bg-pos-bg p-3 rounded-xl border border-pos-border flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-center text-[10px] font-bold mb-1.5 gap-2">
                          <div className="flex items-center gap-1.5 text-pos-muted uppercase truncate">
                            <Target className="w-3 h-3 text-emerald-400 shrink-0" />
                            <span className="truncate">Objectif Franco / MOQ :</span>
                            {editingMoqVendor === vendorName ? (
                              <div className="flex items-center gap-1 shrink-0">
                                <input
                                  type="number"
                                  step="10000"
                                  value={tempMoqInput}
                                  onChange={(e) => setTempMoqInput(parseInt(e.target.value) || 50000)}
                                  className="w-20 sm:w-24 bg-pos-card border border-emerald-400 rounded px-1.5 py-0.5 text-[10px] text-emerald-400 font-bold focus:outline-none"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleSaveMoq(vendorName)}
                                  className="px-2 py-0.5 bg-emerald-500 text-slate-950 font-bold rounded text-[9px] min-h-[26px]"
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
                                className="text-pos-text hover:text-emerald-400 underline flex items-center gap-0.5 font-bold shrink-0"
                              >
                                {formatDZD(moqTarget)} <Edit2 className="w-2.5 h-2.5 ml-0.5 text-pos-muted" />
                              </button>
                            )}
                          </div>

                          <span className={`shrink-0 ${moqPercentage >= 100 ? 'text-emerald-400 font-black' : 'text-amber-400 font-bold'}`}>
                            {moqPercentage}% Atteint {moqPercentage >= 100 ? '✓' : ''}
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

                      <div className="flex items-center justify-between sm:block text-left sm:text-right shrink-0 pt-2 sm:pt-0 sm:pl-3 border-t sm:border-t-0 sm:border-l border-pos-border">
                        <span className="text-[10px] text-pos-muted font-semibold">Total Estimé :</span>
                        <span className="text-base font-black text-emerald-400 ml-2 sm:ml-0 sm:block">{formatDZD(vendorEstimatedOrderValue)}</span>
                      </div>
                    </div>

                    {/* List of Low Stock Items */}
                    {vendorAlerts.length === 0 ? (
                      <div className="text-center py-6 px-4 bg-pos-bg/60 border border-dashed border-pos-border rounded-xl text-xs text-pos-muted space-y-1.5">
                        <PackageCheck className="w-7 h-7 mx-auto text-emerald-400 opacity-60" />
                        <p className="font-bold text-pos-text">Aucun article sous le seuil d'alerte pour ce fournisseur.</p>
                        <p className="text-[11px]">
                          Utilisez l'option ci-dessous pour choisir n'importe quel article du catalogue à commander.
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {vendorAlerts.map((alert) => {
                          const isSelected = selectedItemsMap[alert.productId] !== false;
                          const defaultSuggestedQty = Math.max(1, alert.reorderPoint * 2 - alert.currentStock);
                          const currentQty =
                            customQtyMap[alert.productId] !== undefined
                              ? customQtyMap[alert.productId]
                              : defaultSuggestedQty;
                          const prod = productsById.get(alert.productId);
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
                                  className="min-h-[38px] min-w-[38px] flex items-center justify-center -ml-1.5 -mt-1.5 text-pos-muted hover:text-emerald-400 transition cursor-pointer"
                                  aria-label={isSelected ? `Désélectionner ${alert.title}` : `Sélectionner ${alert.title}`}
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
                                        if (alert.id.startsWith('extra-')) {
                                          handleRemoveExtraProductFromVendor(vendorName, alert.productId);
                                        } else {
                                          dismissProcurementProduct(alert.productId);
                                          showToast(`"${alert.title}" masqué de la proposition.`, 'info');
                                        }
                                      }}
                                      className="min-h-[36px] min-w-[36px] flex items-center justify-center p-1 hover:bg-rose-500/15 text-pos-muted hover:text-rose-400 rounded-lg transition cursor-pointer"
                                      title={alert.id.startsWith('extra-') ? "Retirer cet article de la commande" : "Exclure / Masquer cet article de la proposition fournisseur"}
                                      aria-label="Supprimer ou masquer l'article"
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
                                      className="w-8 h-8 flex items-center justify-center hover:bg-pos-hover text-pos-text text-xs transition cursor-pointer"
                                      aria-label="Diminuer la quantité"
                                    >
                                      <Minus className="w-3 h-3" />
                                    </button>

                                    <input
                                      type="number"
                                      min="1"
                                      value={currentQty}
                                      onChange={(e) => handleQtyChange(alert.productId, parseInt(e.target.value) || 1)}
                                      className="w-12 h-8 text-center bg-transparent text-emerald-400 font-mono font-bold text-xs focus:outline-none"
                                      aria-label="Quantité à commander"
                                    />

                                    <button
                                      type="button"
                                      onClick={() => handleQtyChange(alert.productId, currentQty + 1)}
                                      className="w-8 h-8 flex items-center justify-center hover:bg-pos-hover text-pos-text text-xs transition cursor-pointer"
                                      aria-label="Augmenter la quantité"
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
                    )}

                    {/* Flexible Catalog Product Picker */}
                    <div className="pt-2 border-t border-pos-border/60">
                      {activeAddVendor === vendorName ? (
                        <div className="p-3 sm:p-4 bg-pos-bg border border-pos-border rounded-xl space-y-3 animate-in fade-in">
                          <div className="flex justify-between items-center pb-2 border-b border-pos-border/60">
                            <div className="flex items-center gap-2">
                              <PlusCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                              <span className="text-xs sm:text-sm font-bold text-pos-text">
                                Choisir un article du catalogue pour <span className="text-emerald-400 font-extrabold">{vendorName}</span> :
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setActiveAddVendor(null);
                                setVendorProductSearch('');
                              }}
                              className="text-xs text-pos-muted hover:text-pos-text font-bold px-2 py-1 rounded-lg hover:bg-pos-card transition cursor-pointer"
                            >
                              Fermer ✕
                            </button>
                          </div>

                          {/* Search bar & Scope selector */}
                          <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                            <div className="relative flex-1">
                              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                              <input
                                type="text"
                                value={vendorProductSearch}
                                onChange={(e) => setVendorProductSearch(e.target.value)}
                                placeholder="Rechercher par désignation, SKU, code-barres..."
                                className="w-full min-h-[42px] bg-pos-card border border-pos-border rounded-xl pl-9 pr-8 py-2 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none"
                                autoFocus
                              />
                              {vendorProductSearch && (
                                <button
                                  type="button"
                                  onClick={() => setVendorProductSearch('')}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs min-h-[32px] min-w-[32px] flex items-center justify-center"
                                  aria-label="Effacer la recherche"
                                >
                                  ✕
                                </button>
                              )}
                            </div>

                            <div className="grid grid-cols-2 sm:flex items-center gap-1 bg-pos-card p-1 rounded-xl border border-pos-border text-xs w-full sm:w-auto shrink-0">
                              <button
                                type="button"
                                onClick={() => setVendorProductScope('all')}
                                className={`min-h-[36px] px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer text-center ${
                                  vendorProductScope === 'all'
                                    ? 'bg-emerald-500 text-slate-950 shadow-sm'
                                    : 'text-pos-muted hover:text-pos-text'
                                }`}
                              >
                                Tout catalogue ({products.length})
                              </button>
                              <button
                                type="button"
                                onClick={() => setVendorProductScope('vendor')}
                                className={`min-h-[36px] px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer text-center ${
                                  vendorProductScope === 'vendor'
                                    ? 'bg-emerald-500 text-slate-950 shadow-sm'
                                    : 'text-pos-muted hover:text-pos-text'
                                }`}
                              >
                                Liés au grossiste ({vendorLinkedProductsCount})
                              </button>
                            </div>
                          </div>

                          {/* Candidate Products List */}
                          {availableCandidateProducts.length === 0 ? (
                            <div className="text-center py-6 text-xs text-pos-muted bg-pos-card/50 rounded-lg border border-dashed border-pos-border">
                              {vendorProductSearch ? (
                                <p>Aucun produit trouvé pour "{vendorProductSearch}".</p>
                              ) : (
                                <p>Tous les articles de cette sélection sont déjà présents dans la commande.</p>
                              )}
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-56 sm:max-h-64 overflow-y-auto pr-1 overscroll-contain">
                              {availableCandidateProducts.slice(0, 30).map((p) => (
                                <div
                                  key={p.id}
                                  className="p-2.5 rounded-lg bg-pos-card border border-pos-border hover:border-emerald-400 text-left text-xs transition flex flex-col justify-between gap-2 shadow-xs group"
                                >
                                  <div className="min-w-0">
                                    <p className="font-bold text-pos-text truncate group-hover:text-emerald-300" title={p.title}>
                                      {p.title}
                                    </p>
                                    <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-pos-muted flex-wrap">
                                      <span className="font-mono">SKU: {p.sku}</span>
                                      <span>•</span>
                                      <span className={p.stock <= (p.reorderPoint || 0) ? 'text-amber-400 font-bold' : ''}>
                                        Stock: {p.stock}
                                      </span>
                                      <span>•</span>
                                      <span className="font-semibold text-pos-text">{formatDZD(p.costPrice)}</span>
                                    </div>
                                    {p.vendorName && p.vendorName !== vendorName && (
                                      <span className="text-[9px] text-pos-muted/80 block mt-0.5 truncate">
                                        Grossiste habituel: {p.vendorName}
                                      </span>
                                    )}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleAddExtraProductToVendor(vendorName, p)}
                                    className="w-full min-h-[38px] py-1 px-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500 text-emerald-300 hover:text-slate-950 text-[11px] font-bold flex items-center justify-center gap-1 transition cursor-pointer"
                                  >
                                    <PlusCircle className="w-3.5 h-3.5" /> + Ajouter à la commande
                                  </button>
                                </div>
                              ))}
                              {availableCandidateProducts.length > 30 && (
                                <div className="col-span-full text-center text-[10px] text-pos-muted py-1 font-semibold">
                                  +{availableCandidateProducts.length - 30} autres articles disponibles (affinez la recherche pour filtrer)
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setActiveAddVendor(vendorName);
                            setVendorProductSearch('');
                            setVendorProductScope('all');
                          }}
                          className="min-h-[44px] text-xs font-bold text-emerald-400 hover:text-emerald-300 hover:underline flex items-center gap-1.5 cursor-pointer py-1"
                        >
                          <PlusCircle className="w-4 h-4" /> + Choisir un article du catalogue à commander chez ce fournisseur
                        </button>
                      )}
                    </div>
                    </>}

                  </div>
                );
              })
          )}
        </div>

        {/* Footer */}
        <div className="p-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
          <span className="hidden sm:inline">Algorithme de Réapprovisionnement Just-In-Time (JIT) • Mobi-POS Enterprise</span>
          <span className="sm:hidden text-[11px] font-medium">Mobi-POS • Approvisionnement</span>
          <button
            onClick={closeModal}
            className="min-h-[44px] px-5 py-2 rounded-xl bg-pos-hover text-pos-text font-bold hover:bg-pos-border transition cursor-pointer"
          >
            Fermer
          </button>
        </div>

        {/* WhatsApp Order Preview Modal Dialog */}
        {whatsappModalVendor && (
          <div className="absolute inset-0 bg-black/85 backdrop-blur-md z-30 flex items-center justify-center p-3 sm:p-6 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] animate-in fade-in">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
              
              <div className="p-3.5 sm:p-4 border-b border-pos-border bg-pos-card flex items-center justify-between">
                <div className="flex items-center gap-2 text-emerald-400">
                  <MessageSquare className="w-5 h-5" />
                  <h3 className="text-xs sm:text-sm font-bold text-pos-text truncate">
                    Aperçu Commande WhatsApp : {whatsappModalVendor}
                  </h3>
                </div>
                <button
                  onClick={() => setWhatsappModalVendor(null)}
                  className="min-h-[40px] min-w-[40px] flex items-center justify-center hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg cursor-pointer"
                  aria-label="Fermer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-4 sm:p-5 overflow-y-auto space-y-3 text-xs overscroll-contain">
                <p className="text-pos-muted text-xs">
                  Ce texte est prêt à être envoyé directement à votre grossiste par WhatsApp ou SMS :
                </p>
                <textarea
                  readOnly
                  rows={8}
                  value={generateWhatsAppMessage(
                    whatsappModalVendor,
                    vendorGroups[whatsappModalVendor] || []
                  )}
                  className="w-full bg-pos-bg border border-pos-border rounded-xl p-3 font-mono text-xs text-emerald-400 focus:outline-none select-all"
                />
              </div>

              <div className="p-3.5 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col-reverse sm:flex-row justify-between items-stretch sm:items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setWhatsappModalVendor(null)}
                  className="min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text text-center cursor-pointer"
                >
                  Fermer
                </button>

                <div className="grid grid-cols-1 sm:flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyWhatsApp(whatsappModalVendor, vendorGroups[whatsappModalVendor] || [])
                    }
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
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
                    className="min-h-[44px] px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/20 transition cursor-pointer"
                  >
                    <ExternalLink className="w-4 h-4" /> Ouvrir WhatsApp
                  </button>
                </div>
              </div>

            </div>
          </div>
        )}

        {/* Select / Add Supplier Modal Dialog */}
        {showAddSupplierModal && (
          <div className="absolute inset-0 bg-black/85 backdrop-blur-md z-30 flex items-center justify-center p-3 sm:p-6 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] animate-in fade-in">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
              <div className="p-3.5 sm:p-4 border-b border-pos-border bg-pos-card flex items-center justify-between">
                <div className="flex items-center gap-2 text-emerald-400">
                  <Truck className="w-5 h-5" />
                  <h3 className="text-xs sm:text-sm font-bold text-pos-text truncate">
                    Commander chez un Grossiste
                  </h3>
                </div>
                <button
                  onClick={() => {
                    setShowAddSupplierModal(false);
                    setNewSupplierInput('');
                    setSupplierSearchTerm('');
                  }}
                  className="min-h-[40px] min-w-[40px] flex items-center justify-center hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer"
                  aria-label="Fermer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-4 sm:p-5 overflow-y-auto space-y-4 text-xs overscroll-contain">
                <div>
                  <label className="block text-[11px] font-bold text-pos-muted uppercase tracking-wider mb-2">
                    1. Nouveau grossiste ou grossiste ponctuel :
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newSupplierInput}
                      onChange={(e) => setNewSupplierInput(e.target.value)}
                      placeholder="Ex: Grossiste Belouizdad, Sarl Import..."
                      className="flex-1 min-h-[44px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newSupplierInput.trim()) {
                          handleSelectOrCreateSupplier(newSupplierInput.trim());
                        }
                      }}
                    />
                    <button
                      type="button"
                      disabled={!newSupplierInput.trim()}
                      onClick={() => handleSelectOrCreateSupplier(newSupplierInput.trim())}
                      className="min-h-[44px] px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold rounded-xl text-xs transition cursor-pointer shrink-0"
                    >
                      + Ouvrir
                    </button>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-[11px] font-bold text-pos-muted uppercase tracking-wider">
                      2. Choisir parmi vos grossistes répertoriés ({knownSuppliers.length}) :
                    </label>
                  </div>

                  <div className="relative mb-2">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                    <input
                      type="text"
                      value={supplierSearchTerm}
                      onChange={(e) => setSupplierSearchTerm(e.target.value)}
                      placeholder="Filtrer les fournisseurs..."
                      className="w-full min-h-[42px] bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-2 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-2 max-h-52 overflow-y-auto pr-1 overscroll-contain">
                    {knownSuppliers
                      .filter((v) => !supplierSearchTerm || v.toLowerCase().includes(supplierSearchTerm.toLowerCase()))
                      .map((vendor) => {
                        const prodCount = products.filter((p) => (p.vendorName || 'Fournisseur Général') === vendor).length;
                        const isCurrentActive = Object.keys(vendorGroups).includes(vendor);
                        return (
                          <button
                            key={vendor}
                            type="button"
                            onClick={() => handleSelectOrCreateSupplier(vendor)}
                            className="w-full min-h-[50px] p-2.5 rounded-xl bg-pos-card border border-pos-border hover:border-emerald-400 text-left transition flex items-center justify-between group cursor-pointer"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <Truck className="w-4 h-4 text-emerald-400 shrink-0 group-hover:scale-110 transition" />
                              <div className="truncate">
                                <p className="font-bold text-pos-text text-xs group-hover:text-emerald-300 truncate">
                                  {vendor}
                                </p>
                                <span className="text-[10px] text-pos-muted">
                                  {prodCount} produit(s) associé(s)
                                </span>
                              </div>
                            </div>
                            <span className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-pos-bg border border-pos-border text-emerald-400 group-hover:bg-emerald-500 group-hover:text-slate-950 transition shrink-0">
                              {isCurrentActive ? 'Accéder →' : 'Sélectionner →'}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                </div>
              </div>

              <div className="p-3.5 sm:p-4 border-t border-pos-border bg-pos-card flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddSupplierModal(false);
                    setNewSupplierInput('');
                    setSupplierSearchTerm('');
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition cursor-pointer"
                >
                  Annuler
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

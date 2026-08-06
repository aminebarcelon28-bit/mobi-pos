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
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { calculateStockAlerts } from '../../utils/alertEngine';
import { formatDZD } from '../../types/pos';

export const VendorProcurementModal: React.FC = () => {
  const { activeModal, closeModal, products, createDraftPOForVendor } = usePosStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<'all' | 'critical'>('all');
  const [successMsg, setSuccessMsg] = useState('');
  
  // Custom reorder quantity state per product ID
  const [customQtyMap, setCustomQtyMap] = useState<Record<string, number>>({});

  if (activeModal !== 'vendor_procurement') return null;

  const alerts = calculateStockAlerts(products);

  // Group low stock alerts by Wholesale Vendor
  const vendorGroups: Record<string, typeof alerts> = {};
  alerts.forEach((alert) => {
    const vendor = alert.vendorName || 'Fournisseur Général';
    if (!vendorGroups[vendor]) vendorGroups[vendor] = [];
    vendorGroups[vendor].push(alert);
  });

  // Calculate Global Procurement KPIs
  const totalVendors = Object.keys(vendorGroups).length;
  const totalAlertItems = alerts.length;
  const criticalItemsCount = alerts.filter((a) => a.severity === 'critical').length;

  const globalEstimatedBudget = alerts.reduce((acc, a) => {
    const prod = products.find((p) => p.id === a.productId);
    const cost = prod ? prod.costPrice : 1500;
    const qty = customQtyMap[a.productId] !== undefined 
      ? customQtyMap[a.productId] 
      : Math.max(1, (a.reorderPoint * 2) - a.currentStock);
    return acc + cost * qty;
  }, 0);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3500);
  };

  const handleQtyChange = (productId: string, delta: number, defaultQty: number) => {
    const current = customQtyMap[productId] !== undefined ? customQtyMap[productId] : defaultQty;
    const next = Math.max(1, current + delta);
    setCustomQtyMap({ ...customQtyMap, [productId]: next });
  };

  const handleCreatePO = (vendorName: string) => {
    createDraftPOForVendor(vendorName);
    showSuccess(`Bon de Commande PO créé avec succès pour ${vendorName} !`);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[90vh] flex flex-col relative">
        
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20">
              <Truck className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2">
                TABLEAU DE RÉAPPROVISIONNEMENT JIT PAR FOURNISSEUR
                <span className="text-[10px] bg-emerald-500/10 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-500/30">
                  ENTERPRISE
                </span>
              </h2>
              <p className="text-[11px] text-pos-muted">Algorithme Just-In-Time (JIT) basé sur la vélocité des ventes et MOQ grossistes</p>
            </div>
          </div>
          <button onClick={closeModal} className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Executive KPI Summary Bar */}
        <div className="bg-pos-bg border-b border-pos-border px-4 py-2.5 grid grid-cols-4 gap-3 shrink-0 text-center select-none">
          <div className="bg-pos-card border border-pos-border rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-pos-muted block">Grossistes en Alerte</span>
            <span className="text-sm font-black text-pos-text">{totalVendors}</span>
          </div>

          <div className="bg-pos-card border border-amber-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-amber-400 block">Références sous Seuil</span>
            <span className="text-sm font-black text-amber-300">{totalAlertItems}</span>
          </div>

          <div className="bg-pos-card border border-rose-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-rose-400 block">Ruptures Imminentes (Stock 0)</span>
            <span className="text-sm font-black text-rose-300">{criticalItemsCount}</span>
          </div>

          <div className="bg-pos-card border border-emerald-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-emerald-400 block">Budget d'Achat Global Estimé</span>
            <span className="text-sm font-black text-emerald-300">{formatDZD(globalEstimatedBudget)}</span>
          </div>
        </div>

        {/* Toolbar Filter */}
        <div className="bg-pos-card border-b border-pos-border p-3 flex items-center justify-between gap-3 shrink-0">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filtrer par Grossiste, Produit, SKU..."
              className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-1.5 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSeverityFilter('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                severityFilter === 'all'
                  ? 'bg-emerald-500 text-slate-950 shadow-md'
                  : 'bg-pos-bg text-pos-muted border border-pos-border hover:text-pos-text'
              }`}
            >
              Toutes les Alertes ({alerts.length})
            </button>
            <button
              onClick={() => setSeverityFilter('critical')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                severityFilter === 'critical'
                  ? 'bg-rose-500 text-white shadow-md'
                  : 'bg-pos-bg text-pos-muted border border-pos-border hover:text-pos-text'
              }`}
            >
              Ruptures Seules ({criticalItemsCount})
            </button>
          </div>
        </div>

        {/* Notification Toast */}
        {successMsg && (
          <div className="absolute top-28 left-1/2 -translate-x-1/2 bg-emerald-500/90 text-slate-950 px-5 py-2.5 rounded-full text-xs font-black shadow-xl text-center z-20 animate-in fade-in slide-in-from-top-4">
            <CheckCircle2 className="w-4 h-4 inline mr-1.5" /> {successMsg}
          </div>
        )}

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 bg-pos-bg">
          {Object.keys(vendorGroups).length === 0 ? (
            <div className="text-center py-16 text-pos-muted bg-pos-card border border-pos-border rounded-2xl max-w-xl mx-auto">
              <PackageCheck className="w-12 h-12 mx-auto mb-3 opacity-40 text-emerald-400" />
              <p className="text-sm font-extrabold text-pos-text">Tous les niveaux de stock sont optimaux !</p>
              <p className="text-xs text-pos-muted mt-1">Aucune alerte de réapprovisionnement en cours sur l'ensemble de votre catalogue.</p>
            </div>
          ) : (
            Object.entries(vendorGroups)
              .filter(([vendorName, vendorAlerts]) => {
                const q = searchQuery.trim().toLowerCase();
                const matchesVendor = !q || vendorName.toLowerCase().includes(q);
                const matchesItem = vendorAlerts.some(
                  (a) => a.title.toLowerCase().includes(q) || a.sku.toLowerCase().includes(q)
                );
                const matchesSeverity = severityFilter === 'all' || vendorAlerts.some((a) => a.severity === 'critical');
                return (matchesVendor || matchesItem) && matchesSeverity;
              })
              .map(([vendorName, vendorAlerts]) => {
                const totalItems = vendorAlerts.length;
                const criticalCount = vendorAlerts.filter((a) => a.severity === 'critical').length;

                // Dynamic calculation of order value with quantity map
                const vendorEstimatedOrderValue = vendorAlerts.reduce((acc, a) => {
                  const prod = products.find((p) => p.id === a.productId);
                  const cost = prod ? prod.costPrice : 1500;
                  const suggestedQty = Math.max(1, (a.reorderPoint * 2) - a.currentStock);
                  const qty = customQtyMap[a.productId] !== undefined ? customQtyMap[a.productId] : suggestedQty;
                  return acc + cost * qty;
                }, 0);

                // Mock MOQ target threshold for grossiste
                const moqTarget = 100000;
                const moqPercentage = Math.min(100, Math.round((vendorEstimatedOrderValue / moqTarget) * 100));

                const contactPhone =
                  vendorName === 'Fournisseur Général' ? '+213 555 00 00 00' : '+213 555 12 34 56';
                const contactEmail =
                  vendorName === 'Fournisseur Général'
                    ? 'contact@fournisseur-general.dz'
                    : `commande@${vendorName.toLowerCase().replace(/\s+/g, '')}.dz`;

                return (
                  <div key={vendorName} className="bg-pos-card border border-pos-border rounded-2xl p-5 space-y-4 shadow-sm hover:border-emerald-500/40 transition">
                    
                    {/* Vendor Header */}
                    <div className="flex justify-between items-start pb-3 border-b border-pos-border">
                      <div>
                        <div className="flex items-center gap-2 mb-1.5">
                          <Truck className="w-4 h-4 text-emerald-400" />
                          <h3 className="text-base font-extrabold text-pos-text">{vendorName}</h3>
                          <span className="bg-pos-bg text-pos-muted text-[10px] font-bold px-2 py-0.5 rounded-md border border-pos-border">
                            {totalItems} Références en Alerte
                          </span>
                          {criticalCount > 0 && (
                            <span className="bg-rose-500/10 text-rose-400 border border-rose-500/30 text-[10px] font-bold px-2 py-0.5 rounded-md flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" /> {criticalCount} Ruptures Imminentes
                            </span>
                          )}
                        </div>

                        {/* Vendor Contact Details */}
                        <div className="flex items-center gap-4 text-xs text-pos-muted">
                          <div className="flex items-center gap-1">
                            <Phone className="w-3.5 h-3.5 text-emerald-400" /> {contactPhone}
                          </div>
                          <div className="flex items-center gap-1">
                            <Mail className="w-3.5 h-3.5 text-cyan-400" /> {contactEmail}
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={() => handleCreatePO(vendorName)}
                        className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 transition shadow-lg shadow-emerald-500/20 cursor-pointer"
                      >
                        <FileText className="w-4 h-4" /> Générer Bon de Commande PO <ArrowRight className="w-4 h-4" />
                      </button>
                    </div>

                    {/* MOQ Target Progress Bar */}
                    <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex items-center justify-between gap-4 text-xs">
                      <div className="flex-1">
                        <div className="flex justify-between items-center text-[10px] font-bold mb-1">
                          <span className="text-pos-muted uppercase">Objectif Commande Minimale (MOQ Grossiste)</span>
                          <span className="text-emerald-400">{moqPercentage}% Atteint</span>
                        </div>
                        <div className="w-full h-1.5 bg-pos-card rounded-full overflow-hidden border border-pos-border">
                          <div
                            className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-500"
                            style={{ width: `${moqPercentage}%` }}
                          />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="text-[10px] text-pos-muted block font-semibold">Total Estimé Commande</span>
                        <span className="text-sm font-black text-emerald-400">{formatDZD(vendorEstimatedOrderValue)}</span>
                      </div>
                    </div>

                    {/* List of Low Stock Items */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {vendorAlerts.map((alert) => {
                        const defaultSuggestedQty = Math.max(1, (alert.reorderPoint * 2) - alert.currentStock);
                        const currentQty = customQtyMap[alert.productId] !== undefined ? customQtyMap[alert.productId] : defaultSuggestedQty;
                        const prod = products.find((p) => p.id === alert.productId);
                        const unitCost = prod ? prod.costPrice : 1500;
                        const itemSubtotal = unitCost * currentQty;

                        return (
                          <div key={alert.id} className="bg-pos-bg border border-pos-border p-3 rounded-xl flex flex-col justify-between text-xs space-y-2">
                            <div className="flex justify-between items-start">
                              <div className="flex-1 pr-2">
                                <p className="font-bold text-pos-text line-clamp-1 text-xs">{alert.title}</p>
                                <span className="text-[10px] font-mono text-pos-muted block mt-0.5">SKU: {alert.sku}</span>
                              </div>

                              <span
                                className={`px-2 py-0.5 rounded-md text-[10px] font-bold shrink-0 ${
                                  alert.severity === 'critical'
                                    ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                                    : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                                }`}
                              >
                                Stock: {alert.currentStock} (Seuil: {alert.reorderPoint})
                              </span>
                            </div>

                            {/* Quantity Customizer Controls */}
                            <div className="flex items-center justify-between pt-2 border-t border-pos-border/50 text-[11px]">
                              <div className="flex items-center gap-1.5">
                                <span className="text-pos-muted font-semibold text-[10px]">Qté à commander:</span>
                                <div className="flex items-center border border-pos-border rounded-lg bg-pos-card">
                                  <button
                                    type="button"
                                    onClick={() => handleQtyChange(alert.productId, -1, defaultSuggestedQty)}
                                    className="px-2 py-0.5 hover:bg-pos-hover text-pos-text text-xs rounded-l-lg transition"
                                  >
                                    <Minus className="w-3 h-3" />
                                  </button>
                                  <span className="px-2 py-0.5 font-bold text-emerald-400 font-mono text-xs">{currentQty}</span>
                                  <button
                                    type="button"
                                    onClick={() => handleQtyChange(alert.productId, 1, defaultSuggestedQty)}
                                    className="px-2 py-0.5 hover:bg-pos-hover text-pos-text text-xs rounded-r-lg transition"
                                  >
                                    <Plus className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>

                              <div className="text-right">
                                <span className="text-[10px] text-pos-muted font-semibold block">Sous-total</span>
                                <span className="font-bold text-pos-text text-xs">{formatDZD(itemSubtotal)}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
          <span>Algorithme de Réapprovisionnement basé sur la Vélocité des Ventes (JIT)</span>
          <button onClick={closeModal} className="px-4 py-1.5 rounded-xl bg-pos-hover text-pos-text font-semibold hover:bg-pos-border transition-colors">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};


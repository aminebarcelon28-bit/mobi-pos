import React, { useState, useRef, useEffect, useMemo } from 'react';

const foldForSearch = (s: string | undefined | null): string =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
import {
  X,
  Search,
  Plus,
  Edit2,
  Trash2,
  Package,
  ChevronLeft,
  Barcode as BarcodeIcon,
  CheckCircle2,
  AlertTriangle,
  Minus,
  Check,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { soundEngine } from '../../utils/audioFeedback';
import { useToast } from '../ui/Toast';

type ViewMode = 'catalog' | 'stocktake';
type StocktakeFilter = 'all' | 'discrepancies' | 'counted';

export const InventoryManagerModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    products,
    setEditingProduct,
    deleteProduct,
    applyStocktakeAudit,
  } = usePosStore();

  const { showToast } = useToast();

  const [mode, setMode] = useState<ViewMode>('catalog');
  const [managerSearch, setManagerSearch] = useState('');
  // Debounced scan input: instant field, list scans follow 200ms after typing.
  const [debouncedManagerSearch, setDebouncedManagerSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedManagerSearch(managerSearch), 200);
    return () => clearTimeout(t);
  }, [managerSearch]);

  // Stocktake Audit State
  const [auditCounts, setAuditCounts] = useState<Record<string, number>>({});
  const [scannerInput, setScannerInput] = useState('');
  const [stocktakeFilter, setStocktakeFilter] = useState<StocktakeFilter>('all');
  const [lastScannedFeedback, setLastScannedFeedback] = useState<string | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);

  const scannerInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus barcode scanner input when switching to stocktake mode
  useEffect(() => {
    if (activeModal === 'inventory_manager' && mode === 'stocktake') {
      setTimeout(() => scannerInputRef.current?.focus(), 80);
    }
  }, [activeModal, mode]);

  // Memoized above the early return so typing does not rescan per keystroke.
  const filteredCatalogMemo = useMemo(() => {
    const q = foldForSearch(debouncedManagerSearch.trim());
    const rawQ = debouncedManagerSearch.trim();
    if (!q) return products;
    return products.filter(
      (p) =>
        foldForSearch(p.title).includes(q) ||
        foldForSearch(p.sku).includes(q) ||
        foldForSearch(p.brand).includes(q) ||
        foldForSearch(p.compatibleModel).includes(q) ||
        (p.barcode ? p.barcode.includes(rawQ) || foldForSearch(p.barcode).includes(q) : false)
    );
  }, [products, debouncedManagerSearch]);
  const filteredStocktakeMemo = useMemo(() => {
    const q = foldForSearch(debouncedManagerSearch.trim());
    const rawQ = debouncedManagerSearch.trim();
    return products.filter((p) => {
      const matchesSearch =
        !q ||
        foldForSearch(p.title).includes(q) ||
        foldForSearch(p.sku).includes(q) ||
        (p.barcode ? p.barcode.includes(rawQ) || foldForSearch(p.barcode).includes(q) : false);

      if (!matchesSearch) return false;

      const counted = auditCounts[p.id];
      const isCounted = counted !== undefined;
      const hasDiscrepancy = isCounted && counted !== p.stock;

      if (stocktakeFilter === 'discrepancies') return hasDiscrepancy;
      if (stocktakeFilter === 'counted') return isCounted;
      return true;
    });
  }, [products, debouncedManagerSearch, auditCounts, stocktakeFilter]);
  useEffect(() => { if (activeModal !== 'inventory_manager') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  if (activeModal !== 'inventory_manager') return null;

  // Catalog filtered list
  const filteredCatalog = filteredCatalogMemo;

  // Stocktake scan handler
  const handleScannerSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const query = scannerInput.trim().toLowerCase();
    if (!query) return;

    // Look for exact match by barcode, SKU or ID
    const found = products.find(
      (p) =>
        (p.barcode && p.barcode.trim().toLowerCase() === query) ||
        p.sku.trim().toLowerCase() === query ||
        p.id.toLowerCase() === query
    );

    if (found) {
      const currentCount = auditCounts[found.id] ?? 0;
      const nextCount = currentCount + 1;
      setAuditCounts((prev) => ({ ...prev, [found.id]: nextCount }));
      soundEngine.playScan();
      const variance = nextCount - found.stock;
      const sign = variance > 0 ? `+${variance}` : `${variance}`;
      setLastScannedFeedback(
        `✓ +1 "${found.title}" (Scanné: ${nextCount}, Théorique: ${found.stock}, Écart: ${sign})`
      );
    } else {
      soundEngine.playError();
      setLastScannedFeedback(`❌ Code inconnu: "${scannerInput.trim()}"`);
    }

    setScannerInput('');
    scannerInputRef.current?.focus();
  };

  const updateCount = (productId: string, newCount: number) => {
    const safeCount = Math.max(0, isNaN(newCount) ? 0 : Math.floor(newCount));
    setAuditCounts((prev) => ({ ...prev, [productId]: safeCount }));
  };

  // Stocktake Audit Reconciliation Metrics
  const auditedProductIds = Object.keys(auditCounts);
  const totalCountedUnits = Object.values(auditCounts).reduce((sum, qty) => sum + qty, 0);

  let totalVarianceUnits = 0;
  let totalFinancialVariance = 0;
  let discrepancyCount = 0;

  for (const pid of auditedProductIds) {
    const p = products.find((prod) => prod.id === pid);
    if (p) {
      const counted = auditCounts[pid];
      const diff = counted - p.stock;
      if (diff !== 0) {
        discrepancyCount++;
        totalVarianceUnits += diff;
        totalFinancialVariance += diff * (p.costPrice || 0);
      }
    }
  }

  // Stocktake filtered items
  const filteredStocktake = filteredStocktakeMemo;

  const handleResetAudit = () => {
    if (auditedProductIds.length === 0) return;
    if (confirm('Voulez-vous vraiment réinitialiser tout le comptage de cet inventaire ?')) {
      setAuditCounts({});
      setLastScannedFeedback(null);
      showToast('Comptage réinitialisé.', 'info');
    }
  };

  const handleApplyAudit = async () => {
    if (auditedProductIds.length === 0) {
      showToast('Aucun article n\'a été compté dans cet inventaire.', 'error');
      return;
    }

    const itemsToCommit = auditedProductIds.map((pid) => {
      const p = products.find((prod) => prod.id === pid);
      return {
        productId: pid,
        countedStock: auditCounts[pid],
        previousStock: p ? p.stock : 0,
      };
    });

    const changedItems = itemsToCommit.filter((i) => i.countedStock !== i.previousStock);

    if (changedItems.length === 0) {
      showToast('Inventaire parfait : Aucun écart détecté avec le stock théorique !', 'success');
      soundEngine.playSuccess?.();
      setAuditCounts({});
      setLastScannedFeedback(null);
      return;
    }

    const confirmMsg = `Confirmer l'ajustement de ${changedItems.length} article(s) ?\nÉcart net total : ${
      totalVarianceUnits >= 0 ? `+${totalVarianceUnits}` : totalVarianceUnits
    } pièces (${formatDZD(totalFinancialVariance)} au coût).`;

    if (!confirm(confirmMsg)) return;

    setIsCommitting(true);
    try {
      await applyStocktakeAudit(changedItems);
      soundEngine.playSuccess?.();
      showToast(
        `Inventaire validé : ${changedItems.length} article(s) mis à jour avec succès.`,
        'success'
      );
      setAuditCounts({});
      setLastScannedFeedback(null);
      setMode('catalog');
    } catch (err) {
      console.error('Failed to commit stocktake audit:', err);
      soundEngine.playError?.();
      showToast('Erreur lors de l\'enregistrement de l\'inventaire.', 'error');
    } finally {
      setIsCommitting(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Gestionnaire de stock"
      onClick={closeModal}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border-0 sm:border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full sm:max-w-5xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:zoom-in-95 max-h-[94dvh] sm:h-[88dvh] flex flex-col cursor-default font-sans pt-[max(0.5rem,var(--safe-top))] sm:pt-0"
      >
        {/* Mobile drag handle */}
        <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" aria-hidden="true" />
        {/* Header */}
        <div className="p-3 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              type="button"
              onClick={closeModal}
              className="sm:hidden p-1.5 rounded-lg bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text active:scale-95 transition"
              title="Retour"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>

            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
              mode === 'stocktake' ? 'bg-cyan-500/20 text-cyan-400' : 'bg-emerald-500/20 text-emerald-400'
            }`}>
              {mode === 'stocktake' ? <BarcodeIcon className="w-5 h-5" /> : <Package className="w-5 h-5" />}
            </div>

            <div className="min-w-0">
              <h2 className="text-xs sm:text-sm font-bold text-pos-text truncate">
                {mode === 'stocktake'
                  ? 'Inventaire Physique & Audit Douchette'
                  : `Gestionnaire de Stock (${products.length} Articles)`}
              </h2>
              <p className="text-[10px] text-pos-muted truncate hidden sm:block">
                {mode === 'stocktake'
                  ? 'Comptage physique des rayons au scanner et rapprochement d\'écarts'
                  : 'Gestion du stock à fort volume, modification et suivi des marges'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Mode Switcher Tabs */}
            <div className="flex items-center bg-pos-bg p-1 rounded-xl border border-pos-border">
              <button
                type="button"
                onClick={() => setMode('catalog')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
                  mode === 'catalog'
                    ? 'bg-emerald-500 text-slate-950 shadow-sm'
                    : 'text-pos-muted hover:text-pos-text'
                }`}
              >
                <Package className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Catalogue</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('stocktake')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
                  mode === 'stocktake'
                    ? 'bg-cyan-500 text-slate-950 shadow-sm'
                    : 'text-pos-muted hover:text-pos-text'
                }`}
              >
                <BarcodeIcon className="w-3.5 h-3.5" />
                <span><span className="hidden sm:inline">Mode </span>Inventaire</span>
                {auditedProductIds.length > 0 && (
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                )}
              </button>
            </div>

            {mode === 'catalog' && (
              <button
                type="button"
                onClick={() => setEditingProduct(null)}
                className="px-3 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-md shadow-emerald-500/20 active:scale-95 transition cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">Nouveau Produit</span>
              </button>
            )}

            <button
              type="button"
              onClick={closeModal}
              className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer"
              title="Fermer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* VIEW 1: CATALOG MODE                                              */}
        {/* ------------------------------------------------------------------ */}
        {mode === 'catalog' && (
          <>
            {/* Real-Time Inventory Valuation Banner */}
            <div className="p-2 sm:p-3 bg-pos-card/60 border-b border-pos-border grid grid-cols-2 lg:grid-cols-4 gap-2 shrink-0">
              <div className="bg-pos-bg border border-pos-border p-2 sm:p-2.5 rounded-xl">
                <span className="text-[8px] sm:text-[9px] font-bold uppercase text-pos-muted block truncate">
                  Valeur Stock au Coût
                </span>
                <p className="text-xs sm:text-sm font-black font-mono text-pos-text mt-0.5 truncate">
                  {formatDZD((products || []).reduce((sum, p) => sum + (p.stock || 0) * (p.costPrice || 0), 0))}
                </p>
              </div>

              <div className="bg-pos-bg border border-pos-border p-2 sm:p-2.5 rounded-xl">
                <span className="text-[8px] sm:text-[9px] font-bold uppercase text-pos-muted block truncate">
                  Valeur Marchande
                </span>
                <p className="text-xs sm:text-sm font-black font-mono text-emerald-400 mt-0.5 truncate">
                  {formatDZD((products || []).reduce((sum, p) => sum + (p.stock || 0) * p.price, 0))}
                </p>
              </div>

              <div className="bg-pos-bg border border-pos-border p-2 sm:p-2.5 rounded-xl">
                <span className="text-[8px] sm:text-[9px] font-bold uppercase text-pos-muted block truncate">
                  Marge Latente
                </span>
                <p className="text-xs sm:text-sm font-black font-mono text-cyan-400 mt-0.5 truncate">
                  {formatDZD(
                    (products || []).reduce((sum, p) => sum + (p.stock || 0) * (p.price - (p.costPrice || 0)), 0)
                  )}
                </p>
              </div>

              <div className="bg-pos-bg border border-pos-border p-2 sm:p-2.5 rounded-xl">
                <span className="text-[8px] sm:text-[9px] font-bold uppercase text-pos-muted block truncate">
                  Volume Pièces
                </span>
                <p className="text-xs sm:text-sm font-black font-mono text-amber-400 mt-0.5 truncate">
                  {(products || []).reduce((sum, p) => sum + (p.stock || 0), 0)} un. ({(products || []).length} réf.)
                </p>
              </div>
            </div>

            {/* Toolbar & Search */}
            <div className="p-2.5 sm:p-3 border-b border-pos-border bg-pos-bg flex items-center justify-between gap-2.5 shrink-0">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                <input
                  type="text"
                  value={managerSearch}
                  onChange={(e) => setManagerSearch(e.target.value)}
                  placeholder="Rechercher Titre, SKU, Marque, Code-barres..."
                  className="w-full bg-pos-card border border-pos-border rounded-xl pl-8 pr-3 py-1.5 text-xs text-pos-text placeholder-pos-muted focus:outline-none focus:border-emerald-400"
                />
                {managerSearch && (
                  <button
                    type="button"
                    onClick={() => setManagerSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs p-0.5"
                  >
                    ✕
                  </button>
                )}
              </div>
              <span className="text-[11px] text-pos-muted shrink-0 whitespace-nowrap">
                <strong className="text-pos-text font-mono">{filteredCatalog.length}</strong> / {products.length}
              </span>
            </div>

            {/* Catalog List: Mobile Cards + Desktop Table */}
            <div className="flex-1 overflow-y-auto overscroll-contain">
              {/* Mobile Card List */}
              <div className="sm:hidden p-2.5 space-y-2">
                {filteredCatalog.map((product) => (
                  <div
                    key={product.id}
                    className="bg-pos-card border border-pos-border rounded-xl p-3 shadow-sm hover:border-emerald-500/40 transition flex flex-col gap-2"
                  >
                    <div className="flex items-start justify-between gap-2.5">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <div className="w-10 h-10 rounded-lg bg-pos-bg border border-pos-border flex items-center justify-center shrink-0 text-emerald-400 mt-0.5">
                          <Package className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-xs text-pos-text line-clamp-2 leading-snug">{product.title}</p>
                          <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[10px]">
                            <span className="font-mono text-pos-muted bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">
                              {product.sku}
                            </span>
                            {product.brand && (
                              <span className="text-pos-text font-semibold bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">
                                {product.brand}
                              </span>
                            )}
                            {product.compatibleModel && (
                              <span className="text-pos-muted truncate max-w-[120px]">
                                {product.compatibleModel}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 ${
                          product.stock <= 5
                            ? 'bg-red-950 text-red-300 border border-red-800'
                            : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                        }`}
                      >
                        {product.stock} un.
                      </span>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-pos-border/50">
                      <div>
                        <span className="text-[10px] text-pos-muted uppercase font-bold block">Prix Vente</span>
                        <span className="font-mono font-black text-emerald-400 text-sm">
                          {formatDZD(product.price)}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setEditingProduct(product)}
                          className="min-h-[40px] px-3 py-1.5 rounded-lg bg-pos-bg hover:bg-emerald-500/20 border border-pos-border text-pos-text hover:text-emerald-400 font-bold text-xs flex items-center gap-1.5 transition active:scale-95 cursor-pointer"
                          title="Modifier Produit"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                          <span>Modifier</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`Supprimer ${product.title} ?`)) deleteProduct(product.id);
                          }}
                          className="min-h-[40px] min-w-[40px] p-2 rounded-lg bg-pos-bg hover:bg-red-500/20 border border-pos-border text-pos-muted hover:text-red-400 flex items-center justify-center transition active:scale-95 cursor-pointer"
                          title="Supprimer Produit"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop Table View */}
              <table className="hidden sm:table w-full text-left text-xs border-collapse">
                <thead className="bg-pos-card border-b border-pos-border text-pos-muted sticky top-0 uppercase tracking-wider text-[10px]">
                  <tr>
                    <th className="p-3">Produit</th>
                    <th className="p-3">Réf / SKU</th>
                    <th className="p-3">Marque</th>
                    <th className="p-3">Modèle Compatible</th>
                    <th className="p-3 text-right">Prix (DA)</th>
                    <th className="p-3 text-center">Stock</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-pos-border/40">
                  {filteredCatalog.map((product) => (
                    <tr key={product.id} className="hover:bg-pos-hover/50 transition group">
                      <td className="p-3 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-pos-card border border-pos-border flex items-center justify-center shrink-0 text-emerald-400">
                          <Package className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="font-bold text-pos-text line-clamp-1">{product.title}</p>
                          <span className="text-[10px] text-pos-muted">{product.category}</span>
                        </div>
                      </td>
                      <td className="p-3 font-mono text-[11px] text-pos-muted">{product.sku}</td>
                      <td className="p-3">
                        <span className="font-semibold text-pos-text">{product.brand}</span>
                      </td>
                      <td className="p-3 text-pos-muted">{product.compatibleModel}</td>
                      <td className="p-3 text-right font-bold text-emerald-400">{formatDZD(product.price)}</td>
                      <td className="p-3 text-center">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            product.stock <= 5
                              ? 'bg-red-950 text-red-300 border border-red-800'
                              : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                          }`}
                        >
                          {product.stock} un.
                        </span>
                      </td>
                      <td className="p-3 text-right space-x-1">
                        <button
                          type="button"
                          onClick={() => setEditingProduct(product)}
                          className="p-1.5 hover:bg-emerald-500/20 text-pos-muted hover:text-emerald-400 rounded-lg transition cursor-pointer"
                          title="Modifier Produit"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`Supprimer ${product.title} ?`)) deleteProduct(product.id);
                          }}
                          className="p-1.5 hover:bg-red-500/20 text-pos-muted hover:text-red-400 rounded-lg transition cursor-pointer"
                          title="Supprimer Produit"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* VIEW 2: STOCKTAKE AUDIT MODE                                      */}
        {/* ------------------------------------------------------------------ */}
        {mode === 'stocktake' && (
          <>
            {/* Live Audit Reconciliation Banner */}
            <div className="p-2.5 sm:p-3 bg-pos-card/60 border-b border-pos-border grid grid-cols-2 lg:grid-cols-4 gap-2 shrink-0">
              <div className="bg-pos-bg border border-pos-border p-2 rounded-xl text-center">
                <span className="text-[9px] font-bold uppercase text-pos-muted block">
                  Références Auditées
                </span>
                <p className="text-xs sm:text-sm font-black font-mono text-pos-text mt-0.5">
                  {auditedProductIds.length} / {products.length}
                </p>
              </div>

              <div className="bg-pos-bg border border-pos-border p-2 rounded-xl text-center">
                <span className="text-[9px] font-bold uppercase text-pos-muted block">
                  Total Unités Comptées
                </span>
                <p className="text-xs sm:text-sm font-black font-mono text-cyan-400 mt-0.5">
                  {totalCountedUnits} pièces
                </p>
              </div>

              <div className="bg-pos-bg border border-pos-border p-2 rounded-xl text-center">
                <span className="text-[9px] font-bold uppercase text-pos-muted block">
                  Écart Net en Pièces
                </span>
                <p className={`text-xs sm:text-sm font-black font-mono mt-0.5 ${
                  totalVarianceUnits < 0 ? 'text-red-400' : totalVarianceUnits > 0 ? 'text-cyan-300' : 'text-emerald-400'
                }`}>
                  {totalVarianceUnits > 0 ? `+${totalVarianceUnits}` : totalVarianceUnits} pièces
                </p>
              </div>

              <div className="bg-pos-bg border border-pos-border p-2 rounded-xl text-center">
                <span className="text-[9px] font-bold uppercase text-pos-muted block">
                  Impact Coût Global
                </span>
                <p className={`text-xs sm:text-sm font-black font-mono mt-0.5 ${
                  totalFinancialVariance < 0 ? 'text-red-400' : totalFinancialVariance > 0 ? 'text-cyan-300' : 'text-emerald-400'
                }`}>
                  {totalFinancialVariance > 0 ? `+${formatDZD(totalFinancialVariance)}` : formatDZD(totalFinancialVariance)}
                </p>
              </div>
            </div>

            {/* Hands-Free Scanner Bar */}
            <div className="p-3 bg-pos-card border-b border-pos-border flex flex-col sm:flex-row items-center gap-2 shrink-0">
              <form onSubmit={handleScannerSubmit} className="relative flex-1 w-full flex items-center">
                <BarcodeIcon className="w-5 h-5 absolute left-3 text-cyan-400 animate-pulse pointer-events-none" />
                <input
                  ref={scannerInputRef}
                  type="text"
                  value={scannerInput}
                  onChange={(e) => setScannerInput(e.target.value)}
                  placeholder="Scanner un code-barres USB douchette ou saisir un SKU..."
                  className="w-full bg-pos-bg border border-cyan-500/50 focus:border-cyan-400 rounded-xl pl-10 pr-24 py-2 text-xs font-mono font-bold text-pos-text placeholder-pos-muted focus:outline-none shadow-inner"
                />
                <button
                  type="submit"
                  className="absolute right-1.5 px-3 py-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black text-xs rounded-lg transition cursor-pointer"
                >
                  Scanner (Entrée)
                </button>
              </form>

              {/* Filter Tabs */}
              <div className="flex items-center gap-1 bg-pos-bg p-1 rounded-xl border border-pos-border shrink-0 w-full sm:w-auto justify-center">
                <button
                  type="button"
                  onClick={() => setStocktakeFilter('all')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                    stocktakeFilter === 'all'
                      ? 'bg-pos-card text-pos-text shadow-sm'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  Tous ({products.length})
                </button>
                <button
                  type="button"
                  onClick={() => setStocktakeFilter('discrepancies')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1 ${
                    stocktakeFilter === 'discrepancies'
                      ? 'bg-red-500/20 text-red-300 border border-red-500/40 shadow-sm'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <AlertTriangle className="w-3 h-3 text-amber-400" />
                  <span>Écarts ({discrepancyCount})</span>
                </button>
                <button
                  type="button"
                  onClick={() => setStocktakeFilter('counted')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                    stocktakeFilter === 'counted'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                      : 'text-pos-muted hover:text-pos-text'
                  }`}
                >
                  Comptés ({auditedProductIds.length})
                </button>
              </div>
            </div>

            {/* Live Scan Audio & Text Feedback */}
            {lastScannedFeedback && (
              <div className="px-4 py-1.5 bg-pos-bg/90 border-b border-pos-border/80 text-xs font-mono font-bold flex items-center justify-between animate-in fade-in">
                <span className={lastScannedFeedback.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}>
                  {lastScannedFeedback}
                </span>
                <button
                  type="button"
                  onClick={() => setLastScannedFeedback(null)}
                  className="text-[10px] text-pos-muted hover:text-pos-text"
                >
                  Effacer
                </button>
              </div>
            )}

            {/* Stocktake Comparison: Mobile Cards + Desktop Table */}
            <div className="flex-1 overflow-y-auto overscroll-contain">
              {/* Mobile Audit Card List */}
              <div className="sm:hidden p-2.5 space-y-2.5">
                {filteredStocktake.map((product) => {
                  const counted = auditCounts[product.id];
                  const isCounted = counted !== undefined;
                  const variance = isCounted ? counted - product.stock : 0;
                  const financialDiff = variance * (product.costPrice || 0);

                  return (
                    <div
                      key={product.id}
                      className={`p-3 rounded-xl border transition flex flex-col gap-2.5 ${
                        !isCounted
                          ? 'bg-pos-card border-pos-border'
                          : variance === 0
                          ? 'bg-emerald-500/[0.04] border-emerald-500/30'
                          : variance < 0
                          ? 'bg-rose-500/[0.05] border-rose-500/30'
                          : 'bg-cyan-500/[0.05] border-cyan-500/30'
                      }`}
                    >
                      {/* Product Header */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-bold text-xs text-pos-text leading-snug line-clamp-2">{product.title}</p>
                          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-pos-muted font-mono mt-0.5">
                            <span className="bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">SKU: {product.sku}</span>
                            {product.barcode && (
                              <span className="bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">EAN: {product.barcode}</span>
                            )}
                          </div>
                        </div>

                        {/* Variance badge */}
                        <div className="shrink-0">
                          {!isCounted ? (
                            <span className="text-[10px] text-pos-muted italic bg-pos-bg px-2 py-0.5 rounded-full border border-pos-border">
                              Non vérifié
                            </span>
                          ) : variance === 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950 text-emerald-300 border border-emerald-800">
                              <Check className="w-3 h-3" /> Conforme (0)
                            </span>
                          ) : variance < 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-950 text-rose-300 border border-rose-800">
                              {variance} un.
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-cyan-950 text-cyan-300 border border-cyan-800">
                              +{variance} un.
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Stock Comparison Grid */}
                      <div className="grid grid-cols-2 gap-2 bg-pos-bg/80 p-2 rounded-lg border border-pos-border/60 text-xs">
                        <div>
                          <span className="text-[9px] uppercase font-bold text-pos-muted block">Stock Théorique</span>
                          <span className="font-mono font-bold text-pos-muted">{product.stock} un.</span>
                        </div>
                        <div className="text-right">
                          <span className="text-[9px] uppercase font-bold text-pos-muted block">Impact Coût</span>
                          <span className={`font-mono font-bold ${
                            !isCounted || variance === 0
                              ? 'text-pos-muted'
                              : financialDiff < 0
                              ? 'text-rose-400'
                              : 'text-cyan-400'
                          }`}>
                            {!isCounted || variance === 0
                              ? '0 DA'
                              : financialDiff < 0
                              ? formatDZD(financialDiff)
                              : `+${formatDZD(financialDiff)}`}
                          </span>
                        </div>
                      </div>

                      {/* Touch Controls: Big Stepper & Quick Action */}
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <div className="inline-flex items-center bg-pos-bg border border-pos-border rounded-xl p-1 gap-1">
                          <button
                            type="button"
                            onClick={() => updateCount(product.id, (auditCounts[product.id] ?? product.stock) - 1)}
                            className="w-10 h-10 rounded-lg bg-pos-card hover:bg-pos-hover text-pos-muted hover:text-pos-text flex items-center justify-center transition active:scale-95"
                            aria-label={`Diminuer le comptage de ${product.title}`}
                          >
                            <Minus className="w-4 h-4" aria-hidden="true" />
                          </button>
                          <input
                            type="number"
                            min="0"
                            value={isCounted ? counted : ''}
                            placeholder={String(product.stock)}
                            onChange={(e) => updateCount(product.id, parseInt(e.target.value) || 0)}
                            className="w-14 h-10 text-center text-sm font-black font-mono bg-transparent text-pos-text focus:outline-none"
                            aria-label={`Comptage pour ${product.title}`}
                          />
                          <button
                            type="button"
                            onClick={() => updateCount(product.id, (auditCounts[product.id] ?? product.stock) + 1)}
                            className="w-10 h-10 rounded-lg bg-pos-card hover:bg-pos-hover text-pos-muted hover:text-pos-text flex items-center justify-center transition active:scale-95"
                            aria-label={`Augmenter le comptage de ${product.title}`}
                          >
                            <Plus className="w-4 h-4" aria-hidden="true" />
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => updateCount(product.id, product.stock)}
                          className="min-h-[44px] px-3.5 py-2 rounded-xl text-xs font-bold bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer active:scale-95 flex items-center gap-1.5"
                          title="Marquer comme conforme au stock théorique"
                        >
                          <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                          <span>= Conforme</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Desktop Table View */}
              <table className="hidden sm:table w-full text-left text-xs border-collapse">
                <thead className="bg-pos-card border-b border-pos-border text-pos-muted sticky top-0 uppercase tracking-wider text-[10px]">
                  <tr>
                    <th className="p-3">Article & Code-barres</th>
                    <th className="p-3 text-center">Stock Système</th>
                    <th className="p-3 text-center">Stock Compté (Douchette)</th>
                    <th className="p-3 text-center">Écart (Variance)</th>
                    <th className="p-3 text-right">Impact au Coût</th>
                    <th className="p-3 text-center">Action Rapide</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-pos-border/40">
                  {filteredStocktake.map((product) => {
                    const counted = auditCounts[product.id];
                    const isCounted = counted !== undefined;
                    const variance = isCounted ? counted - product.stock : 0;
                    const financialDiff = variance * (product.costPrice || 0);

                    return (
                      <tr
                        key={product.id}
                        className={`transition group ${
                          !isCounted
                            ? 'hover:bg-pos-hover/40'
                            : variance === 0
                            ? 'bg-emerald-500/[0.02] hover:bg-emerald-500/[0.05]'
                            : variance < 0
                            ? 'bg-rose-500/[0.04] hover:bg-rose-500/[0.08]'
                            : 'bg-cyan-500/[0.04] hover:bg-cyan-500/[0.08]'
                        }`}
                      >
                        {/* Title & Barcode */}
                        <td className="p-3">
                          <p className="font-bold text-pos-text leading-tight">{product.title}</p>
                          <div className="flex items-center gap-2 text-[10px] text-pos-muted font-mono mt-0.5">
                            <span>SKU: {product.sku}</span>
                            {product.barcode && <span>• EAN: {product.barcode}</span>}
                          </div>
                        </td>

                        {/* Theoretical Stock */}
                        <td className="p-3 text-center font-mono font-bold text-pos-muted">
                          {product.stock} un.
                        </td>

                        {/* Counted Quantity with Stepper */}
                        <td className="p-3 text-center">
                          <div className="inline-flex items-center gap-1 bg-pos-bg border border-pos-border rounded-lg p-0.5">
                            <button
                              type="button"
                              onClick={() => updateCount(product.id, (auditCounts[product.id] ?? product.stock) - 1)}
                              className="w-6 h-6 rounded bg-pos-card hover:bg-pos-hover text-pos-muted hover:text-pos-text flex items-center justify-center transition"
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                            <input
                              type="number"
                              min="0"
                              value={isCounted ? counted : ''}
                              placeholder={String(product.stock)}
                              onChange={(e) => updateCount(product.id, parseInt(e.target.value) || 0)}
                              className="w-12 h-6 text-center text-xs font-black font-mono bg-transparent text-pos-text focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => updateCount(product.id, (auditCounts[product.id] ?? product.stock) + 1)}
                              className="w-6 h-6 rounded bg-pos-card hover:bg-pos-hover text-pos-muted hover:text-pos-text flex items-center justify-center transition"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                        </td>

                        {/* Variance Display */}
                        <td className="p-3 text-center">
                          {!isCounted ? (
                            <span className="text-[10px] text-pos-muted font-italic">Non vérifié</span>
                          ) : variance === 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950 text-emerald-300 border border-emerald-800">
                              <Check className="w-3 h-3" /> Conforme (0)
                            </span>
                          ) : variance < 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-950 text-rose-300 border border-rose-800">
                              {variance} un. (Manquant)
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-cyan-950 text-cyan-300 border border-cyan-800">
                              +{variance} un. (Surplus)
                            </span>
                          )}
                        </td>

                        {/* Financial Impact */}
                        <td className="p-3 text-right font-mono font-bold">
                          {!isCounted || variance === 0 ? (
                            <span className="text-pos-muted">0 DA</span>
                          ) : financialDiff < 0 ? (
                            <span className="text-rose-400">{formatDZD(financialDiff)}</span>
                          ) : (
                            <span className="text-cyan-400">+{formatDZD(financialDiff)}</span>
                          )}
                        </td>

                        {/* Match Theoretical Action */}
                        <td className="p-3 text-center">
                          <button
                            type="button"
                            onClick={() => updateCount(product.id, product.stock)}
                            className="px-2 py-1 rounded text-[10px] font-bold bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition cursor-pointer"
                            title="Marquer comme conforme au stock théorique"
                          >
                            = Conforme
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Audit Bottom Action Bar */}
            <div className="p-3 pb-[max(1rem,var(--safe-bottom))] sm:pb-3 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row justify-between items-center gap-2 shrink-0">
              <div className="text-xs text-pos-muted flex items-center gap-3">
                <span>
                  <strong>{auditedProductIds.length}</strong> articles comptés
                </span>
                <span>•</span>
                <span>
                  <strong>{discrepancyCount}</strong> anomalie(s) détectée(s)
                </span>
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                <button
                  type="button"
                  onClick={handleResetAudit}
                  disabled={isCommitting || auditedProductIds.length === 0}
                  className="px-3 py-2 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text font-bold text-xs transition cursor-pointer disabled:opacity-50"
                >
                  Réinitialiser
                </button>

                <button
                  type="button"
                  onClick={handleApplyAudit}
                  disabled={isCommitting || auditedProductIds.length === 0}
                  className="px-4 sm:px-6 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black text-xs flex items-center gap-2 shadow-lg shadow-cyan-500/20 active:scale-95 transition cursor-pointer disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    {isCommitting
                      ? 'Application en cours...'
                      : `Valider et Appliquer l'Inventaire (${auditedProductIds.length})`}
                  </span>
                </button>
              </div>
            </div>
          </>
        )}

        {/* Footer (Common) */}
        {mode === 'catalog' && (
          <div className="p-2.5 sm:p-3 pb-[max(1rem,var(--safe-bottom))] sm:pb-3 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
            <span className="text-[11px]">MobiPOS Stock • {products.length} articles au catalogue</span>
            <button
              type="button"
              onClick={closeModal}
              className="px-4 py-1.5 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border text-pos-text font-bold active:scale-95 transition cursor-pointer"
            >
              Fermer
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

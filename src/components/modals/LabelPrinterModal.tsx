import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  X, Printer, Barcode, Search, Filter, Check, Tag, Sparkles, Sliders, Layers,
  ListPlus, Trash2, Plus, Minus, PackagePlus, ArrowRight
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { CategoryType, Product } from '../../types/pos';
import { renderBarcodeToCanvas } from '../../utils/barcodeGenerator';
import { resolvePrinterForDocument } from '../../utils/printerRoutingEngine';
import { directPrintProductLabels } from '../../utils/escpos';
import { renderLabelToCanvas, labelSizeToMm } from '../../utils/labelImageBuilder';
import { isMobileDevice } from '../../utils/platform';
import { useToast } from '../../components/ui/Toast';

type LabelSize = '50x25' | '60x40' | '100x50';

export interface LabelQueueItem {
  product: Product;
  quantity: number;
}

const foldForSearch = (s: string | undefined | null): string =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const CATEGORIES: CategoryType[] = [
  'Tous les produits',
  'Coques iPhone',
  'Coques Samsung',
  'Coques Google',
  'Chargeurs',
  'Câbles',
  'Protège-Écran',
];

export const LabelPrinterModal: React.FC = () => {
  const { activeModal, closeModal, products, receiptSettings } = usePosStore();
  const { showToast } = useToast();
  const targetPrinter = resolvePrinterForDocument('label', receiptSettings.printerRouting);
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [isPrinting, setIsPrinting] = useState<boolean>(false);
  const [printMode, setPrintMode] = useState<'single' | 'queue'>('single');
  const [labelQueue, setLabelQueue] = useState<LabelQueueItem[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  // Debounced scan input: instant field, filtered list follows 200ms later.
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const [categoryFilter, setCategoryFilter] = useState<string>('Tous les produits');
  const [brandFilter, setBrandFilter] = useState<string>('Toutes les marques');
  const [labelQuantity, setLabelQuantity] = useState<number>(10);
  const [labelSize, setLabelSize] = useState<LabelSize>('50x25');

  // Label element toggles
  const [showStoreName, setShowStoreName] = useState<boolean>(true);
  const [showPrice, setShowPrice] = useState<boolean>(true);
  const [showModel, setShowModel] = useState<boolean>(true);

  const barcodeCanvasRef = useRef<HTMLCanvasElement>(null);

  // Extract unique brands for filtering
  const availableBrands = useMemo(() => {
    const brands = new Set((products || []).map(p => p.brand).filter(Boolean));
    return ['Toutes les marques', ...Array.from(brands)];
  }, [products]);

  // Filtered product list based on search, category, brand
  const filteredProducts = useMemo(() => {
    const q = foldForSearch(debouncedSearch.trim());
    return (products || []).filter((p) => {
      const matchesCategory = categoryFilter === 'Tous les produits' || p.category === categoryFilter;
      const matchesBrand = brandFilter === 'Toutes les marques' || p.brand === brandFilter;
      const matchesSearch =
        !q ||
        foldForSearch(p.title).includes(q) ||
        foldForSearch(p.sku).includes(q) ||
        foldForSearch(p.barcode).includes(q) ||
        foldForSearch(p.brand).includes(q) ||
        (p.compatibleModel && foldForSearch(p.compatibleModel).includes(q));

      return matchesCategory && matchesBrand && matchesSearch;
    });
  }, [products, debouncedSearch, categoryFilter, brandFilter]);

  // Auto-select target product or first matching product
  const [prevModalSync, setPrevModalSync] = useState<string | null>(null);
  if (activeModal !== prevModalSync) {
    setPrevModalSync(activeModal);
    if (activeModal === 'label_printer') {
      const targetId = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('label_printer_target_id') : null;
      if (targetId) {
        sessionStorage.removeItem('label_printer_target_id');
        if (products.some((p) => p.id === targetId)) {
          setSelectedProductId(targetId);
        }
      } else if (!selectedProductId && products.length > 0) {
        setSelectedProductId(products[0].id);
      }
    }
  }

  const selectedProduct = products.find((p) => p.id === selectedProductId) || filteredProducts[0] || products[0];

  useEffect(() => {
    if (selectedProduct && selectedProduct.barcode && barcodeCanvasRef.current) {
      renderBarcodeToCanvas(barcodeCanvasRef.current, selectedProduct.barcode, 'code128', {
        height: labelSize === '100x50' ? 45 : labelSize === '60x40' ? 36 : 28,
        showText: false,
      });
    }
  }, [selectedProduct, labelSize, activeModal]);

  const totalQueueLabels = useMemo(() => {
    return labelQueue.reduce((acc, item) => acc + item.quantity, 0);
  }, [labelQueue]);

  useEffect(() => { if (activeModal !== 'label_printer') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  if (activeModal !== 'label_printer') return null;

  const addToQueue = (product: Product, quantity = 10) => {
    const safeQty = Math.max(1, Math.min(1000, isNaN(quantity) ? 1 : quantity));
    setLabelQueue((prev) => {
      const idx = prev.findIndex((item) => item.product.id === product.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = {
          ...copy[idx],
          quantity: Math.min(1000, copy[idx].quantity + safeQty),
        };
        return copy;
      }
      return [...prev, { product, quantity: safeQty }];
    });
    showToast(`Produit ajouté à la file : ${product.title} (+${safeQty})`, 'info');
  };

  const removeFromQueue = (productId: string) => {
    setLabelQueue((prev) => prev.filter((item) => item.product.id !== productId));
  };

  const updateQueueQuantity = (productId: string, delta: number) => {
    setLabelQueue((prev) =>
      prev.map((item) => {
        if (item.product.id !== productId) return item;
        return { ...item, quantity: Math.max(1, Math.min(1000, item.quantity + delta)) };
      })
    );
  };

  const setQueueItemQuantity = (productId: string, quantity: number) => {
    const safe = Math.max(1, Math.min(1000, isNaN(quantity) ? 1 : quantity));
    setLabelQueue((prev) =>
      prev.map((item) => {
        if (item.product.id !== productId) return item;
        return { ...item, quantity: safe };
      })
    );
  };

  const clearQueue = () => {
    setLabelQueue([]);
  };

  const handlePrintLabels = async () => {
    if (!selectedProduct) return;
    const safeQty = Math.max(1, Math.min(500, isNaN(labelQuantity) ? 1 : labelQuantity));
    if (safeQty !== labelQuantity) setLabelQuantity(safeQty);

    // Mobile route: no USB spooler on phones — render the label to PNG and
    // open the Android system print sheet (Wi-Fi/Bluetooth printer, PDF).
    if (isMobileDevice()) {
      await handleMobileLabelPrint(safeQty);
      return;
    }

    setIsPrinting(true);
    try {
      // Match the label language to the routed printer model: Zebra speaks
      // ZPL, TSC/Godex/Rongta speak TSPL, anything else falls back to the
      // ESC/POS sticker path readable by thermal receipt printers.
      const protocol = /zebra|zpl|dymo|brother/i.test(targetPrinter.printerName || targetPrinter.protocol || '')
        ? 'ZPL'
        : /tsc|tspl|tsp|godex|rongta|gprinter|gx-|da200|ttp-|da220|te200/i.test(targetPrinter.printerName || targetPrinter.protocol || '')
          ? 'TSPL'
          : 'ESCPOS';
      const success = await directPrintProductLabels(
        selectedProduct,
        {
          format: protocol,
          protocol,
          size: labelSize,
          quantity: safeQty,
          showPrice,
          showStoreName,
          showModel,
          storeName: receiptSettings?.storeName || 'MOBI-POS',
        },
        receiptSettings?.printerRouting
      );

      if (success) {
        showToast(`🖨️ ${safeQty} étiquette(s) envoyée(s) directement à l'imprimante (${targetPrinter.printerName}).`, 'success');
      } else {
        showToast(`⚠️ Étiquettes envoyées au spooler d'impression Windows.`, 'info');
      }
    } catch (err) {
      console.error('[Label Print Error]', err);
      showToast(`Erreur lors de l'impression directe des étiquettes.`, 'error');
    } finally {
      setIsPrinting(false);
    }
  };

  const handleMobileLabelPrint = async (quantity: number, productOverride?: Product) => {
    const targetProduct = productOverride || selectedProduct;
    if (!targetProduct) return;
    setIsPrinting(true);
    try {
      // Priority 1: configured Wi-Fi/Bluetooth printer — raw label language
      // (ZPL/TSPL/ESCPOS) straight to the hardware, no dialog.
      const { loadMobilePrinter, printBytesViaMobilePrinter } = await import('../../utils/mobilePrinter');
      const mobileConfig = loadMobilePrinter();
      if (mobileConfig.enabled) {
        const { ProductLabelBuilder } = await import('../../utils/productLabelBuilder');
        const raw = ProductLabelBuilder.build(targetProduct, {
          format: mobileConfig.labelProtocol,
          protocol: mobileConfig.labelProtocol,
          size: labelSize,
          quantity: Math.max(1, Math.min(200, quantity)),
          showPrice,
          showStoreName,
          showModel,
          storeName: receiptSettings?.storeName || 'MOBI-POS',
        });
        const direct = await printBytesViaMobilePrinter(raw);
        if (direct.sent) {
          showToast(`🖨️ ${quantity} étiquette(s) envoyée(s) à l'imprimante mobile (${mobileConfig.labelProtocol}).`, 'success');
          return;
        }
        if (direct.reason !== 'disabled') {
          showToast(`Imprimante mobile injoignable (${direct.reason}) — feuille système à la place.`, 'warning');
        }
      }
      // Priority 2: Android system print sheet with a rendered PNG label.
      // The native sheet renders one label page per copy (capped at 200).
      const copies = Math.max(1, Math.min(200, quantity));
      const { widthMm, heightMm } = labelSizeToMm(labelSize);
      const canvas = renderLabelToCanvas(targetProduct, {
        widthMm,
        heightMm,
        showStoreName,
        showPrice,
        showModel,
        storeName: receiptSettings?.storeName || 'MOBI-POS',
      });
      const dataUrl = canvas.toDataURL('image/png');
      const { printLabelImageNative, sharePngFile } = await import('../../utils/phoneUtils');

      const opened = await printLabelImageNative({
        title: `Étiquette ${targetProduct.title}`,
        imageBase64: dataUrl,
        widthMm,
        heightMm,
        copies,
      });
      if (opened) {
        showToast(`🖨️ Feuille d'impression Android ouverte — choisissez l'imprimante (${copies}× ${labelSize} mm).`, 'success');
        return;
      }
      // No native bridge (old APK, iOS, browser): hand the PNG to the OS
      // share sheet so it can reach a printer app, or download it.
      const shared = await sharePngFile(
        `etiquette-${targetProduct.sku || targetProduct.id}.png`,
        dataUrl,
        'Étiquette produit',
        `${copies}× ${targetProduct.title} — ${formatDZD(targetProduct.price)}`
      );
      if (shared) {
        showToast('📤 Étiquette partagée — envoyez-la vers votre imprimante.', 'success');
      } else {
        showToast("Impression indisponible sur cet appareil.", 'error');
      }
    } catch (err) {
      console.error('[Mobile Label Print Error]', err);
      showToast(`Échec de l'impression mobile des étiquettes.`, 'error');
    } finally {
      setIsPrinting(false);
    }
  };

  const handlePrintBatchQueue = async () => {
    if (labelQueue.length === 0) return;
    setIsPrinting(true);
    let printedCount = 0;
    try {
      for (const item of labelQueue) {
        const safeQty = Math.max(1, Math.min(500, item.quantity));
        if (isMobileDevice()) {
          await handleMobileLabelPrint(safeQty, item.product);
        } else {
          const protocol = /zebra|zpl|dymo|brother/i.test(targetPrinter.printerName || targetPrinter.protocol || '')
            ? 'ZPL'
            : /tsc|tspl|tsp|godex|rongta|gprinter|gx-|da200|ttp-|da220|te200/i.test(targetPrinter.printerName || targetPrinter.protocol || '')
              ? 'TSPL'
              : 'ESCPOS';
          await directPrintProductLabels(
            item.product,
            {
              format: protocol,
              protocol,
              size: labelSize,
              quantity: safeQty,
              showPrice,
              showStoreName,
              showModel,
              storeName: receiptSettings?.storeName || 'MOBI-POS',
            },
            receiptSettings?.printerRouting
          );
        }
        printedCount += safeQty;
      }
      showToast(`🖨️ Lot terminé : ${printedCount} étiquette(s) envoyée(s) (${labelQueue.length} SKU).`, 'success');
      setLabelQueue([]);
      setPrintMode('single');
    } catch (err) {
      console.error('[Batch Label Print Error]', err);
      showToast(`Erreur lors de l'impression du lot d'étiquettes.`, 'error');
    } finally {
      setIsPrinting(false);
    }
  };

  const getLabelDimensions = () => {
    switch (labelSize) {
      case '50x25':
        return 'w-[230px] h-[115px] p-2.5';
      case '60x40':
        return 'w-[280px] h-[175px] p-3.5';
      case '100x50':
        return 'w-[360px] h-[200px] p-4';
      default:
        return 'w-[230px] h-[115px] p-2.5';
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Studio d'impression d'étiquettes" className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none">
      <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col h-[94dvh] sm:max-h-[90dvh] pt-[max(0.5rem,var(--safe-top))] sm:py-0">
        <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" aria-hidden="true" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 text-emerald-400 min-w-0">
              <Barcode className="w-5 h-5 shrink-0" />
              <h2 className="text-sm sm:text-base font-extrabold text-pos-text truncate">
                Studio d'Étiquettes <span className="hidden sm:inline">Code-Barres & Prix</span>
              </h2>
            </div>

            {/* Mode Switcher Tabs */}
            <div className="flex items-center bg-pos-bg border border-pos-border rounded-xl p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setPrintMode('single')}
                className={`px-3 py-1.5 rounded-lg font-bold transition flex items-center gap-1.5 cursor-pointer ${
                  printMode === 'single'
                    ? 'bg-emerald-500 text-slate-950 shadow-sm'
                    : 'text-pos-muted hover:text-pos-text'
                }`}
              >
                <Tag className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Unitaire</span>
              </button>
              <button
                type="button"
                onClick={() => setPrintMode('queue')}
                className={`px-3 py-1.5 rounded-lg font-bold transition flex items-center gap-1.5 cursor-pointer ${
                  printMode === 'queue'
                    ? 'bg-emerald-500 text-slate-950 shadow-sm'
                    : 'text-pos-muted hover:text-pos-text'
                }`}
              >
                <ListPlus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>File de lot</span>
                {labelQueue.length > 0 && (
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-black ${
                    printMode === 'queue' ? 'bg-slate-950 text-emerald-400' : 'bg-emerald-500/20 text-emerald-400'
                  }`}>
                    {labelQueue.length}
                  </span>
                )}
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0 cursor-pointer active:scale-95"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Content Body: Split into Left Selection Panel & Right Label Preview Studio */}
        <div className="flex-1 flex flex-col lg:flex-row overflow-hidden divide-y lg:divide-y-0 lg:divide-x divide-pos-border">
          
          {/* Left Panel: Search & Product Picker Grid */}
          <div className="w-full lg:w-7/12 h-1/2 lg:h-auto flex flex-col p-3 sm:p-4 space-y-3 overflow-hidden bg-pos-bg shrink-0 lg:shrink">
            
            {/* Search & Filter Toolbar */}
            <div className="space-y-2 shrink-0">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Rechercher produit, Réf, Code-barres, Modèle..."
                  className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-xl pl-9 pr-3 py-2 text-base sm:text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs"
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Filters Dropdowns */}
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-1.5 bg-pos-card border border-pos-border rounded-lg px-2 py-1 text-xs min-h-[44px]">
                  <Filter className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="w-full bg-transparent text-pos-text text-xs font-medium focus:outline-none cursor-pointer"
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat} value={cat} className="bg-pos-card text-pos-text">
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-1.5 bg-pos-card border border-pos-border rounded-lg px-2 py-1 text-xs min-h-[44px]">
                  <Tag className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <select
                    value={brandFilter}
                    onChange={(e) => setBrandFilter(e.target.value)}
                    className="w-full bg-transparent text-pos-text text-xs font-medium focus:outline-none cursor-pointer"
                  >
                    {availableBrands.map((b) => (
                      <option key={b} value={b} className="bg-pos-card text-pos-text">
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Product Selection List */}
            <div className="flex-1 overflow-y-auto overscroll-contain space-y-2 pr-1">
              {filteredProducts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-pos-muted py-8 text-center">
                  <Search className="w-8 h-8 opacity-40 mb-2" />
                  <p className="text-xs font-semibold">Aucun article ne correspond</p>
                  <p className="text-[10px]">Essayez de modifier votre recherche ou vos filtres.</p>
                </div>
              ) : (
                (filteredProducts || []).map((p) => {
                  const isSelected = p.id === selectedProduct?.id;
                  const inQueue = labelQueue.find((q) => q.product.id === p.id);
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelectedProductId(p.id)}
                      className={`p-2.5 rounded-xl border transition cursor-pointer active:scale-[0.98] flex items-center justify-between gap-3 min-h-[64px] ${
                        isSelected
                          ? 'bg-emerald-500/10 border-emerald-500/80 shadow-sm'
                          : 'bg-pos-card border-pos-border hover:border-pos-hover hover:bg-pos-hover/40'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-10 h-10 rounded-lg bg-pos-bg border border-pos-border flex items-center justify-center shrink-0 text-emerald-400">
                          <Tag className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-xs font-bold text-pos-text truncate">{p.title}</h4>
                          <div className="flex items-center gap-2 text-[10px] text-pos-muted mt-0.5">
                            <span className="font-semibold text-emerald-400">{p.brand}</span>
                            <span>•</span>
                            <span>{p.compatibleModel}</span>
                            <span>•</span>
                            <span>SKU: {p.sku}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <div className="text-right">
                          <span className="text-xs font-black text-emerald-400 block">{formatDZD(p.price)}</span>
                          <span className="text-[9px] text-pos-muted">Stock: {p.stock}</span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            addToQueue(p, labelQuantity);
                          }}
                          className={`p-2 rounded-lg border transition active:scale-95 cursor-pointer min-h-[38px] min-w-[38px] flex items-center justify-center ${
                            inQueue
                              ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-sm'
                              : 'bg-pos-panel hover:bg-emerald-500/20 text-pos-muted hover:text-emerald-400 border-pos-border hover:border-emerald-500/40'
                          }`}
                          aria-label={`Ajouter à la file — ${p.title}`}
                          title={inQueue ? `Dans la file (${inQueue.quantity}) — Cliquez pour ajouter +${labelQuantity}` : "Ajouter à la file"}
                        >
                          <PackagePlus className="w-4 h-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Panel: Single Preview OR Queue Management Studio */}
          <div className="w-full lg:w-5/12 flex-1 lg:flex-initial flex flex-col p-3 sm:p-5 bg-pos-panel space-y-3 sm:space-y-4 overflow-y-auto overscroll-contain">
            
            {/* Format & Quantity Controls (Always accessible) */}
            <div className="space-y-3 bg-pos-card border border-pos-border p-3.5 rounded-xl shrink-0">
              <h3 className="text-xs font-bold text-pos-text flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Sliders className="w-4 h-4 text-emerald-400" /> Paramètres d'Impression
                </span>
                <span className="text-[10px] text-pos-muted font-normal">
                  {targetPrinter.printerName ? `Imprimante : ${targetPrinter.printerName}` : 'Imprimante par défaut'}
                </span>
              </h3>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Taille Rouleau</label>
                  <select
                    value={labelSize}
                    onChange={(e) => setLabelSize(e.target.value as LabelSize)}
                    className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-sm sm:text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                  >
                    <option value="50x25">50 × 25 mm (Standard)</option>
                    <option value="60x40">60 × 40 mm (Moyen)</option>
                    <option value="100x50">100 × 50 mm (Grand)</option>
                  </select>
                </div>

                {printMode === 'single' ? (
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Nombre d'Étiquettes</label>
                    <div className="flex gap-1.5 items-center">
                      <input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        max="1000"
                        value={labelQuantity}
                        onChange={(e) => setLabelQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-base sm:text-xs font-black text-emerald-400 focus:border-emerald-400 focus:outline-none"
                      />
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Total du Lot</label>
                    <div className="min-h-[48px] bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 flex items-center justify-between text-emerald-400 font-black text-sm">
                      <span>{totalQueueLabels} étiquettes</span>
                      <span className="text-pos-muted text-xs font-normal">({labelQueue.length} SKU)</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Preset Quantity Buttons (in single mode) */}
              {printMode === 'single' && (
                <div className="flex items-center gap-1.5 pt-1 overflow-x-auto no-scrollbar">
                  <span className="text-[10px] text-pos-muted font-semibold shrink-0">Presets:</span>
                  {[1, 5, 10, 20, 50, 100].map((qty) => (
                    <button
                      key={qty}
                      type="button"
                      onClick={() => setLabelQuantity(qty)}
                      className={`min-h-[44px] min-w-[42px] px-2.5 py-1.5 rounded-lg text-xs font-bold border transition active:scale-95 shrink-0 cursor-pointer ${
                        labelQuantity === qty
                          ? 'bg-emerald-500 text-slate-950 border-emerald-400 font-black shadow-sm'
                          : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                      }`}
                    >
                      {qty}
                    </button>
                  ))}
                </div>
              )}

              {/* Add to batch queue button from single config */}
              {printMode === 'single' && selectedProduct && (
                <button
                  type="button"
                  onClick={() => addToQueue(selectedProduct, labelQuantity)}
                  className="w-full mt-2 py-2 px-3 rounded-lg bg-pos-panel hover:bg-emerald-500/10 border border-pos-border hover:border-emerald-500/40 text-emerald-400 text-xs font-bold transition flex items-center justify-center gap-2 cursor-pointer active:scale-95"
                >
                  <PackagePlus className="w-4 h-4" aria-hidden="true" />
                  <span>Ajouter cet article à la file (+{labelQuantity})</span>
                </button>
              )}
            </div>

            {/* Element Display Toggles */}
            <div className="bg-pos-card border border-pos-border p-3.5 rounded-xl space-y-2 shrink-0">
              <h3 className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-cyan-400" /> Éléments sur l'Étiquette
              </h3>
              
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setShowStoreName(!showStoreName)}
                  className={`min-h-[44px] px-2 py-2 rounded-lg border text-[10px] font-bold transition flex items-center justify-center gap-1 active:scale-95 cursor-pointer ${
                    showStoreName ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'bg-pos-bg border-pos-border text-pos-muted'
                  }`}
                >
                  {showStoreName && <Check className="w-3 h-3" />} Magasin
                </button>

                <button
                  type="button"
                  onClick={() => setShowPrice(!showPrice)}
                  className={`min-h-[44px] px-2 py-2 rounded-lg border text-[10px] font-bold transition flex items-center justify-center gap-1 active:scale-95 cursor-pointer ${
                    showPrice ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'bg-pos-bg border-pos-border text-pos-muted'
                  }`}
                >
                  {showPrice && <Check className="w-3 h-3" />} Prix DA
                </button>

                <button
                  type="button"
                  onClick={() => setShowModel(!showModel)}
                  className={`min-h-[44px] px-2 py-2 rounded-lg border text-[10px] font-bold transition flex items-center justify-center gap-1 active:scale-95 cursor-pointer ${
                    showModel ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'bg-pos-bg border-pos-border text-pos-muted'
                  }`}
                >
                  {showModel && <Check className="w-3 h-3" />} Modèle
                </button>
              </div>
            </div>

            {/* DYNAMIC VIEW: Single Live Preview OR Batch Queue Manager */}
            {printMode === 'single' ? (
              /* Live Studio Tag Preview Box */
              <div className="flex-1 bg-slate-950 p-4 rounded-xl border border-pos-border flex flex-col items-center justify-center relative overflow-hidden min-h-[220px]">
                <span className="absolute top-2 left-2 text-[9px] font-bold text-pos-muted uppercase tracking-wider flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-emerald-400" /> Aperçu Étiquette Thermique
                </span>

                {selectedProduct ? (
                  <div className={`print-label-target bg-white text-black shadow-2xl rounded flex flex-col justify-between border border-gray-300 font-sans transition-all ${getLabelDimensions()}`}>
                    {/* Header */}
                    <div className="flex justify-between items-start">
                      {showStoreName ? (
                        <span className="text-[9px] font-extrabold uppercase tracking-wider text-gray-800 truncate max-w-[140px]">
                          {receiptSettings.storeName || 'ACCESSOIRES MOBI'}
                        </span>
                      ) : <span />}
                      <span className="text-[8px] font-bold text-gray-700 bg-gray-200 px-1 rounded-full">
                        {selectedProduct.brand}
                      </span>
                    </div>

                    {/* Title & Compatible Model */}
                    <div className="my-1 flex-1">
                      <p className="text-[10px] font-bold leading-tight text-gray-900 line-clamp-2">
                        {selectedProduct.title}
                      </p>
                      {showModel && selectedProduct.compatibleModel && (
                        <p className="text-[8px] text-gray-600 mt-0.5">Comp: {selectedProduct.compatibleModel}</p>
                      )}
                    </div>

                    {/* Price */}
                    {showPrice && (
                      <div className="text-right my-0.5">
                        <span className="text-sm font-black text-black tracking-tight">
                          {formatDZD(selectedProduct.price)}
                        </span>
                      </div>
                    )}

                    {/* Barcode Canvas */}
                    <div className="text-center pt-1 border-t border-gray-300 flex flex-col items-center">
                      <canvas ref={barcodeCanvasRef} className="max-w-full mix-blend-multiply" />
                      <div className="flex justify-between w-full text-[7px] font-mono text-gray-700 mt-0.5">
                        <span>SKU: {selectedProduct.sku}</span>
                        <span>EAN: {selectedProduct.barcode}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-pos-muted">Aucun produit sélectionné</p>
                )}
              </div>
            ) : (
              /* Batch Queue List */
              <div className="flex-1 bg-pos-card rounded-xl border border-pos-border flex flex-col overflow-hidden min-h-[260px]">
                <div className="p-3 border-b border-pos-border bg-pos-bg flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <ListPlus className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-bold text-pos-text">
                      File d'attente ({labelQueue.length} SKU • {totalQueueLabels} étiquettes)
                    </span>
                  </div>
                  {labelQueue.length > 0 && (
                    <button
                      type="button"
                      onClick={clearQueue}
                      className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1 font-semibold cursor-pointer active:scale-95"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Vider la file</span>
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto overscroll-contain p-2 space-y-2">
                  {labelQueue.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center p-6 text-center text-pos-muted space-y-2">
                      <ListPlus className="w-10 h-10 opacity-30 text-emerald-400 mb-1" />
                      <p className="text-xs font-bold text-pos-text">La file d'attente est vide</p>
                      <p className="text-[11px] max-w-xs text-pos-muted">
                        Ajoutez des articles depuis le catalogue à gauche en cliquant sur l'icône d'ajout pour composer un lot d'impression groupé.
                      </p>
                      <button
                        type="button"
                        onClick={() => setPrintMode('single')}
                        className="mt-2 px-3 py-1.5 rounded-lg bg-pos-panel border border-pos-border text-xs font-semibold text-emerald-400 hover:bg-pos-hover cursor-pointer"
                      >
                        Passer en mode unitaire
                      </button>
                    </div>
                  ) : (
                    labelQueue.map((item) => (
                      <div
                        key={item.product.id}
                        className="p-2.5 rounded-lg bg-pos-bg border border-pos-border flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0 flex-1">
                          <h5 className="text-xs font-bold text-pos-text truncate">{item.product.title}</h5>
                          <div className="flex items-center gap-2 text-[10px] text-pos-muted mt-0.5">
                            <span className="font-semibold text-emerald-400">{formatDZD(item.product.price)}</span>
                            <span>•</span>
                            <span>SKU: {item.product.sku}</span>
                          </div>
                        </div>

                        {/* Stepper Controls */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => updateQueueQuantity(item.product.id, -1)}
                            className="w-8 h-8 rounded-lg bg-pos-card border border-pos-border flex items-center justify-center text-pos-muted hover:text-pos-text cursor-pointer active:scale-95"
                            aria-label={`Diminuer la quantité — ${item.product.title}`}
                          >
                            <Minus className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <input
                            type="number"
                            inputMode="numeric"
                            min="1"
                            max="1000"
                            value={item.quantity}
                            onChange={(e) => setQueueItemQuantity(item.product.id, parseInt(e.target.value) || 1)}
                            className="w-12 h-8 text-center bg-pos-card border border-pos-border rounded-lg text-xs font-black text-emerald-400 focus:outline-none"
                            aria-label={`Quantité d'étiquettes — ${item.product.title}`}
                          />
                          <button
                            type="button"
                            onClick={() => updateQueueQuantity(item.product.id, 1)}
                            className="w-8 h-8 rounded-lg bg-pos-card border border-pos-border flex items-center justify-center text-pos-muted hover:text-pos-text cursor-pointer active:scale-95"
                            aria-label={`Augmenter la quantité — ${item.product.title}`}
                          >
                            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeFromQueue(item.product.id)}
                            className="w-8 h-8 ml-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center justify-center cursor-pointer active:scale-95"
                            aria-label={`Supprimer de la file — ${item.product.title}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-3 sm:p-4 pb-[max(1rem,var(--safe-bottom))] sm:pb-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-2 shrink-0">
          <div className="text-xs text-pos-muted flex items-center gap-2 truncate">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            {printMode === 'single' ? (
              <span className="truncate">
                Impression : <strong className="text-pos-text">{labelQuantity}× {selectedProduct?.title || 'Étiquette'}</strong> ({labelSize} mm)
                {labelQueue.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setPrintMode('queue')}
                    className="ml-2 font-bold text-emerald-400 hover:underline cursor-pointer inline-flex items-center gap-1"
                  >
                    <span>Voir la file ({labelQueue.length} SKU)</span>
                    <ArrowRight className="w-3 h-3" aria-hidden="true" />
                  </button>
                )}
              </span>
            ) : (
              <span className="truncate">
                Lot groupé : <strong className="text-pos-text">{totalQueueLabels} étiquettes au total</strong> ({labelQueue.length} SKU • {labelSize} mm)
              </span>
            )}
          </div>

          <div className="flex gap-2 items-center">
            <button
              onClick={closeModal}
              className="flex-1 sm:flex-initial px-4 py-2.5 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition-colors min-h-[44px] flex items-center justify-center active-press cursor-pointer"
            >
              Annuler
            </button>
            {printMode === 'single' ? (
              <button
                onClick={handlePrintLabels}
                disabled={isPrinting || !selectedProduct}
                className={`flex-1 sm:flex-initial px-6 py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-lg transition-all min-h-[44px] active-press ${
                  isPrinting || !selectedProduct
                    ? 'bg-emerald-500/50 text-slate-900 cursor-not-allowed'
                    : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20 cursor-pointer'
                }`}
              >
                <Printer className="w-4 h-4" /> {isPrinting ? 'Impression...' : `Imprimer (${labelQuantity})`}
              </button>
            ) : (
              <button
                onClick={handlePrintBatchQueue}
                disabled={isPrinting || labelQueue.length === 0}
                className={`flex-1 sm:flex-initial px-6 py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-lg transition-all min-h-[44px] active-press ${
                  isPrinting || labelQueue.length === 0
                    ? 'bg-emerald-500/50 text-slate-900 cursor-not-allowed'
                    : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20 cursor-pointer'
                }`}
              >
                <Printer className="w-4 h-4" /> {isPrinting ? 'Impression du lot...' : `Imprimer le Lot (${totalQueueLabels})`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};


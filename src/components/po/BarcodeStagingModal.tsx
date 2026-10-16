import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  X,
  Printer,
  Barcode as BarcodeIcon,
  Tag,
  CheckSquare,
  Square,
} from 'lucide-react';
import { formatDZD } from '../../types/pos';
import type { Product } from '../../types/pos';
import type { EditableReviewLine } from '../../types/po';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import { renderBarcodeToCanvas } from '../../utils/barcodeGenerator';
import { directPrintProductLabels } from '../../utils/escpos';
import { resolvePrinterForDocument } from '../../utils/printerRoutingEngine';

interface BarcodeStagingModalProps {
  lines: EditableReviewLine[];
  catalogMap: Map<string, { id: string; name: string; sku: string; price: number }>;
  onClose: () => void;
}

interface StagedLabelItem {
  clientId: string;
  productId: string;
  title: string;
  barcode: string;
  sellingPrice: number;
  unitCost: number;
  quantity: number;
  selected: boolean;
}

export const BarcodeStagingModal: React.FC<BarcodeStagingModalProps> = ({
  lines,
  catalogMap,
  onClose,
}) => {
  const { receiptSettings } = usePosStore();
  const { showToast } = useToast();
  const [labelSize, setLabelSize] = useState<'50x25' | '60x40' | '40x20'>('50x25');
  const [showStoreName] = useState(true);
  const [isPrinting, setIsPrinting] = useState(false);
  const barcodeCanvasRef = useRef<HTMLCanvasElement>(null);

  // Initialize staging items from lines
  const [stagedItems, setStagedItems] = useState<StagedLabelItem[]>(() => {
    return lines.map((l) => {
      const catProd = l.selected_product_id ? catalogMap.get(l.selected_product_id) : undefined;
      const title = catProd?.name || l.raw_description;
      const barcode = catProd?.sku || `200${Math.abs(l.raw_description.split('').reduce((a, b) => (a << 5) - a + b.charCodeAt(0), 0) % 1000000000).toString().padStart(9, '0')}`;
      const sellingPrice = l.selling_price && l.selling_price > 0
        ? l.selling_price
        : catProd?.price || Math.round(l.unit_cost * 1.35);

      return {
        clientId: l.client_id,
        productId: l.selected_product_id || l.client_id,
        title,
        barcode,
        sellingPrice,
        unitCost: l.unit_cost,
        quantity: Math.max(1, l.quantity),
        selected: true,
      };
    });
  });

  const totalLabelsCount = useMemo(() => {
    return stagedItems
      .filter((it) => it.selected)
      .reduce((sum, it) => sum + Math.max(0, it.quantity), 0);
  }, [stagedItems]);

  const toggleSelectAll = () => {
    const allSelected = stagedItems.every((it) => it.selected);
    setStagedItems((prev) => prev.map((it) => ({ ...it, selected: !allSelected })));
  };

  const updateItemQty = (clientId: string, qty: number) => {
    setStagedItems((prev) =>
      prev.map((it) => (it.clientId === clientId ? { ...it, quantity: Math.max(1, qty) } : it))
    );
  };

  const toggleItemSelect = (clientId: string) => {
    setStagedItems((prev) =>
      prev.map((it) => (it.clientId === clientId ? { ...it, selected: !it.selected } : it))
    );
  };

  const activePreviewItem = stagedItems.find((it) => it.selected) || stagedItems[0];

  useEffect(() => {
    if (activePreviewItem && activePreviewItem.barcode && barcodeCanvasRef.current) {
      renderBarcodeToCanvas(barcodeCanvasRef.current, activePreviewItem.barcode, 'code128', {
        height: 32,
        showText: false,
      });
    }
  }, [activePreviewItem, labelSize]);

  const handlePrint = async () => {
    setIsPrinting(true);
    try {
      const selectedList = stagedItems.filter((it) => it.selected && it.quantity > 0);
      if (selectedList.length === 0) return;

      const targetPrinter = resolvePrinterForDocument('label', receiptSettings?.printerRouting);
      const protocol = /zebra|zpl|dymo|brother/i.test(targetPrinter.printerName || targetPrinter.protocol || '')
        ? 'ZPL'
        : /tsc|tspl|tsp|godex|rongta|gprinter|gx-|da200|ttp-|da220|te200/i.test(targetPrinter.printerName || targetPrinter.protocol || '')
          ? 'TSPL'
          : 'ESCPOS';

      let totalPrinted = 0;
      for (const item of selectedList) {
        const syntheticProduct: Product = {
          id: item.productId,
          title: item.title,
          barcode: item.barcode,
          sku: item.barcode,
          price: item.sellingPrice,
          category: 'Tous les produits',
          brand: '',
          costPrice: item.unitCost || 0,
          stock: item.quantity,
        };

        await directPrintProductLabels(
          syntheticProduct,
          {
            format: protocol,
            protocol,
            size: labelSize === '40x20' ? '50x25' : labelSize,
            quantity: item.quantity,
            showPrice: true,
            showStoreName,
            storeName: receiptSettings?.storeName || 'MOBI-STORE DZ',
          },
          receiptSettings?.printerRouting
        );
        totalPrinted += item.quantity;
      }
      showToast(`${totalPrinted} étiquette(s) envoyée(s) à l'imprimante.`, 'success');
    } catch (err) {
      console.error('[BarcodeStagingModal Print Error]', err);
      showToast(`Erreur d'impression : ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setIsPrinting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 overflow-y-auto animate-in fade-in select-none">
      <div className="bg-slate-900 border-t sm:border border-slate-800 rounded-t-[28px] sm:rounded-3xl w-full max-w-3xl max-h-[94dvh] sm:max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
        {/* M3 Standard Drag Handle */}
        <div className="w-12 h-1.5 rounded-full bg-slate-700/60 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" aria-hidden="true" />

        {/* Header */}
        <div className="p-4 bg-gradient-to-r from-indigo-950/50 via-slate-900 to-slate-900 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Tag className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-extrabold text-white flex items-center gap-2">
                <span>File d'Attente Impression Étiquettes Thermal</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800">
                  {totalLabelsCount} étiquettes
                </span>
              </h2>
              <p className="text-[11px] text-slate-400">
                Génération groupée automatique pour étiquetage immédiat du stock réceptionné.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Fermer la file d'attente d'impression"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 sm:p-5 grid grid-cols-1 md:grid-cols-3 gap-4 overflow-y-auto flex-1 text-xs">
          {/* Left Column: Label Queue Table */}
          <div className="md:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={toggleSelectAll}
                className="text-[11px] font-bold text-slate-300 hover:text-white flex items-center gap-1.5 cursor-pointer"
              >
                {stagedItems.every((it) => it.selected) ? (
                  <CheckSquare className="w-4 h-4 text-indigo-400" />
                ) : (
                  <Square className="w-4 h-4 text-slate-500" />
                )}
                <span>Tout sélectionner ({stagedItems.length} articles)</span>
              </button>
              <span className="text-[10px] text-slate-500 font-mono">
                Total stickers : {totalLabelsCount}
              </span>
            </div>

            <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
              {stagedItems.map((item) => (
                <div
                  key={item.clientId}
                  className={`p-2.5 rounded-xl border transition flex items-center justify-between gap-2 ${
                    item.selected
                      ? 'bg-slate-950/80 border-slate-700'
                      : 'bg-slate-950/40 border-slate-800/60 opacity-60'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleItemSelect(item.clientId)}
                    className="cursor-pointer shrink-0"
                  >
                    {item.selected ? (
                      <CheckSquare className="w-4 h-4 text-indigo-400" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-600" />
                    )}
                  </button>

                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-white text-xs truncate">
                      {item.title}
                    </p>
                    <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono">
                      <span>Code : {item.barcode}</span>
                      <span>•</span>
                      <span className="text-emerald-400 font-bold">{formatDZD(item.sellingPrice)}</span>
                    </div>
                  </div>

                  {/* Quantity Stepper */}
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] text-slate-500">Nb:</span>
                    <input
                      type="number"
                      min={1}
                      max={999}
                      value={item.quantity}
                      onChange={(e) => updateItemQty(item.clientId, parseInt(e.target.value) || 1)}
                      className="w-14 bg-slate-900 border border-slate-700 rounded-lg px-1.5 py-1 text-center font-mono text-xs text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right Column: Print Configuration & Live Label Preview */}
          <div className="space-y-3 bg-slate-950 p-3.5 rounded-2xl border border-slate-800 flex flex-col justify-between">
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-white flex items-center gap-1.5">
                <BarcodeIcon className="w-4 h-4 text-indigo-400" />
                <span>Aperçu Étiquette Thermique</span>
              </h3>

              {/* Format selection */}
              <div>
                <label className="text-[10px] font-bold text-slate-400 block mb-1">
                  Format Étiquette Thermique
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['50x25', '60x40', '40x20'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setLabelSize(fmt)}
                      className={`py-1.5 px-2 rounded-xl text-[10px] font-bold border transition cursor-pointer text-center ${
                        labelSize === fmt
                          ? 'bg-indigo-600 border-indigo-500 text-white shadow-xs'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      {fmt} mm
                    </button>
                  ))}
                </div>
              </div>

              {/* Live Preview Sticker Box */}
              {activePreviewItem && (
                <div className="p-3 bg-white text-slate-950 rounded-xl shadow-md border border-slate-300 flex flex-col items-center justify-between text-center space-y-1.5 min-h-[140px]">
                  {showStoreName && (
                    <span className="text-[9px] font-extrabold tracking-wider uppercase text-slate-700">
                      MOBI-STORE DZ
                    </span>
                  )}
                  <p className="text-[10px] font-bold line-clamp-2 leading-tight text-slate-900">
                    {activePreviewItem.title}
                  </p>

                  {/* Real Barcode Canvas */}
                  <div className="w-full flex flex-col items-center">
                    <canvas ref={barcodeCanvasRef} className="max-w-[160px] h-9 object-contain" />
                    <span className="font-mono text-[9px] font-extrabold tracking-widest text-slate-800">
                      {activePreviewItem.barcode}
                    </span>
                  </div>

                  <span className="text-xs font-black text-slate-950 font-mono tracking-tight">
                    {formatDZD(activePreviewItem.sellingPrice)}
                  </span>
                </div>
              )}
            </div>

            {/* Print Launch Button */}
            <div className="pt-2 pb-[max(1rem,var(--safe-bottom))] sm:pb-0">
              <button
                type="button"
                onClick={handlePrint}
                disabled={totalLabelsCount === 0 || isPrinting}
                className="w-full min-h-[48px] py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-indigo-950 transition active:scale-95 cursor-pointer"
              >
                <Printer className="w-4 h-4" />
                <span>Imprimer {totalLabelsCount} Étiquettes (1-Clic)</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

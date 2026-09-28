import React, { useState, useRef } from 'react';
import {
  X,
  FileText,
  CheckCircle2,
  Upload,
  AlertCircle,
  Check,
  X as XIcon,
  Sparkles,
  Camera,
  Layers,
  ArrowRight,
  RefreshCw,
  Building2,
  HelpCircle,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { CsvInvoiceRowSchema } from '../../schemas/invoiceSchema';
import { parseLocalizedAmount } from '../../utils/moneyInput';
import { resolveReferenceCost } from '../../utils/referenceCost';
import { formatDZD } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { processRawScan } from '../../api/po';
import {
  scanNativeDocument,
  parseTextToBoundingBoxes,
  generateDemoInvoiceScan,
  isNativeScannerSupported,
} from '../../utils/documentScanner';
import { PoReviewScreen } from '../PoReviewScreen';
import type { Product, IMEIRecord } from '../../types/pos';
import type { ProcessRawScanResponse } from '../../types/po';

/**
 * Stable content hash for an import file: the slice derives delta + batch
 * identities from it, so re-importing the same file (double-click, retry,
 * re-paste) converges via ON CONFLICT instead of doubling stock, while a
 * genuinely new file hashes differently and applies normally.
 */
function hashImportText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x811c9dc5) >>> 0;
  }
  return `csv-${h1.toString(36)}${h2.toString(36)}`;
}

/**
 * Quote-aware single-line split: a `"...""...` section may contain the
 * delimiter (supplier SKUs like `"SKU,123"`); naive split corrupts the
 * columns. Handles `""` escapes; a lone quote is treated literally.
 */
function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export const InvoiceIngestionModal: React.FC = () => {
  const { activeModal, closeModal, products, ingestInvoiceBatch } = usePosStore();
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<'ai_recon' | 'csv_text'>('ai_recon');

  // CSV Ingestion State
  const [rawText, setRawText] = useState<string>('');
  const [ingestStatus, setIngestStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [parsedLines, setParsedLines] = useState<{ sku: string; qty: number; cost?: number; imei?: string; matched: boolean }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // AI Recon & Invariant Scanner State
  const [supplierName, setSupplierName] = useState<string>('Grossiste Mobile Distribution');
  const [reportedTax, setReportedTax] = useState<number>(0);
  const [reportedFreight, setReportedFreight] = useState<number>(0);
  const [reportedGrandTotal, setReportedGrandTotal] = useState<number>(0);
  const [rawOcrInput, setRawOcrInput] = useState<string>('');
  const [showDirectTextInput, setShowDirectTextInput] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [scanResponse, setScanResponse] = useState<ProcessRawScanResponse | null>(null);
  const scanFileInputRef = useRef<HTMLInputElement>(null);

  if (activeModal !== 'invoice_ingestion') return null;

  // Known suppliers list from existing products catalog
  const knownSuppliers = Array.from(
    new Set(
      products
        .map((p) => p.vendorName)
        .filter((v): v is string => Boolean(v && v.trim()))
    )
  );

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        setRawText(event.target.result as string);
        setIngestStatus(null);
        setParsedLines([]);
      }
    };
    reader.onerror = () => {
      setIngestStatus({ type: 'error', message: 'Erreur lors de la lecture du fichier.' });
    };
    reader.readAsText(file);
  };

  const handleProcessIngestion = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      const contentHash = hashImportText(rawText);
      const lines = rawText.split('\n').filter(line => line.trim() !== '');
      const newParsedLines: typeof parsedLines = [];
      const updatedProductsMap = new Map<string, Product>();
      const newImeis: IMEIRecord[] = [];
      const seenImei = new Set<string>();
      const receiptMap = new Map<string, { qty: number; costSum: number }>();

      for (const line of lines) {
        const delimiter = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
        const parts = splitCsvLine(line, delimiter).map((p) => p.trim().replace(/^["']|["']$/g, ''));
        if (parts.length >= 2) {
          const sku = parts[0];
          const rawQty = parts[1].replace(/[^\d-]/g, '');
          const qty = parseInt(rawQty, 10) || 0;

          let cost: number | undefined = undefined;
          if (parts[2]) {
            const rawCost = parts[2].trim();
            const parsedCost = parseLocalizedAmount(rawCost);
            if (!isNaN(parsedCost) && parsedCost > 0) {
              cost = Math.round(parsedCost);
            }
          }

          const imei = parts[3] ? parts[3].trim() : undefined;

          const validation = CsvInvoiceRowSchema.safeParse({
            sku,
            qty,
            cost,
            imei: imei || undefined,
          });

          if (!validation.success) {
            newParsedLines.push({ sku, qty, cost, imei, matched: false });
            continue;
          }

          const imeiKey = imei ? imei.toUpperCase() : '';
          if (imeiKey) {
            if (seenImei.has(imeiKey)) {
              newParsedLines.push({ sku, qty, cost, imei, matched: false });
              continue;
            }
            seenImei.add(imeiKey);
          }

          const currentProd =
            Array.from(updatedProductsMap.values()).find(
              (p) => p.sku.toLowerCase() === sku.toLowerCase() || p.barcode.toLowerCase() === sku.toLowerCase()
            ) ||
            products.find(
              (p) => p.sku.toLowerCase() === sku.toLowerCase() || p.barcode.toLowerCase() === sku.toLowerCase()
            );

          if (currentProd && qty > 0) {
            const isSerialized = Boolean(imei || currentProd.isSerialized);
            const invoiceCost = cost !== undefined ? cost : currentProd.costPrice;
            const updated: Product = {
              ...currentProd,
              stock: currentProd.stock + qty,
              costPrice: resolveReferenceCost(currentProd.costPrice, invoiceCost),
              isSerialized,
              imeiNumber: imei || currentProd.imeiNumber,
            };
            updatedProductsMap.set(updated.id, updated);
            const prevReceipt = receiptMap.get(updated.id);
            const prevQty = prevReceipt?.qty ?? 0;
            const prevSum = prevReceipt?.costSum ?? 0;
            receiptMap.set(updated.id, {
              qty: prevQty + qty,
              costSum: prevSum + qty * Math.max(0, Math.round(invoiceCost)),
            });

            if (imei) {
              const imeiRec: IMEIRecord = {
                imei,
                productId: currentProd.id,
                receivedAt: new Date().toISOString(),
              };
              newImeis.push(imeiRec);
            }

            newParsedLines.push({ sku, qty, cost, imei, matched: true });
          } else {
            newParsedLines.push({ sku, qty, cost, imei, matched: false });
          }
        }
      }

      if (updatedProductsMap.size > 0) {
        const updatedList = Array.from(updatedProductsMap.values());
        const receipts = Array.from(receiptMap.entries()).map(([productId, r]) => ({
          productId,
          qty: r.qty,
          unitCost: r.qty > 0 ? Math.round(r.costSum / r.qty) : 0,
        }));
        await ingestInvoiceBatch(updatedList, newImeis, receipts, { importKey: contentHash });
      }

      setParsedLines(newParsedLines);
      
      const matchedCount = newParsedLines.filter(l => l.matched).length;
      const unmatchedCount = newParsedLines.length - matchedCount;

      setIngestStatus({ 
        type: 'success', 
        message: `Succès ! ${matchedCount} références mises à jour. ${unmatchedCount} non trouvées.` 
      });
      setIsProcessing(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur lors du traitement des données.';
      setIngestStatus({ type: 'error', message: msg });
      setIsProcessing(false);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const matchedCount = parsedLines.filter(l => l.matched).length;
  const unmatchedCount = parsedLines.length - matchedCount;

  const applyExtractedSummary = (res: ProcessRawScanResponse) => {
    if (res.document_summary) {
      if (
        res.document_summary.detected_supplier &&
        (!supplierName || supplierName === 'Fournisseur Général' || supplierName === 'Fournisseur Inconnu')
      ) {
        setSupplierName(res.document_summary.detected_supplier);
      }
      if (res.document_summary.detected_tax !== undefined && res.document_summary.detected_tax !== null) {
        setReportedTax(res.document_summary.detected_tax);
      }
      if (res.document_summary.detected_freight !== undefined && res.document_summary.detected_freight !== null) {
        setReportedFreight(res.document_summary.detected_freight);
      }
      if (
        res.document_summary.detected_grand_total !== undefined &&
        res.document_summary.detected_grand_total !== null &&
        res.document_summary.detected_grand_total > 0
      ) {
        setReportedGrandTotal(res.document_summary.detected_grand_total);
        res.invariant_report.reported_grand_total = res.document_summary.detected_grand_total;
        res.invariant_report.delta = Math.abs(
          res.invariant_report.calculated_grand_total - res.document_summary.detected_grand_total
        );
        res.invariant_report.is_balanced =
          res.invariant_report.delta <= 0.01 && res.invariant_report.faulty_row_indices.length === 0;
      }
    }

    if (
      (reportedGrandTotal === 135250 || reportedGrandTotal === 0) &&
      res.invariant_report.calculated_grand_total > 0 &&
      (!res.document_summary || !res.document_summary.detected_grand_total)
    ) {
      const autoTotal = Math.round(res.invariant_report.calculated_grand_total);
      setReportedGrandTotal(autoTotal);
      res.invariant_report.reported_grand_total = autoTotal;
      res.invariant_report.delta = 0;
      res.invariant_report.is_balanced = res.invariant_report.faulty_row_indices.length === 0;
    }
  };

  // --- AI Recon Handlers ---
  const handleNativeCameraScan = async () => {
    setAiError(null);
    setIsAnalyzing(true);
    try {
      const scanResult = await scanNativeDocument();
      if (scanResult.isCancelled) {
        setIsAnalyzing(false);
        return;
      }
      if (!scanResult.success || !scanResult.blocks || scanResult.blocks.length === 0) {
        const errorMsg = scanResult.error || 'Aucun texte détecté sur le document numérisé.';
        setAiError(errorMsg);
        showToast(errorMsg, 'error');
        setIsAnalyzing(false);
        return;
      }

      const res = await processRawScan({
        supplier_name: supplierName.trim() || 'Fournisseur Inconnu',
        bounding_boxes: scanResult.blocks,
        reported_tax: reportedTax,
        reported_freight: reportedFreight,
        reported_grand_total: reportedGrandTotal,
      });

      applyExtractedSummary(res);
      setScanResponse(res);
      showToast('Document numérisé et analysé avec succès.', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err) || 'Erreur de numérisation';
      setAiError(msg);
      showToast(msg, 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleDemoScanClick = async () => {
    setAiError(null);
    setIsAnalyzing(true);
    try {
      const demoData = generateDemoInvoiceScan();
      setSupplierName(demoData.supplier_name);
      setReportedTax(demoData.reported_tax);
      setReportedFreight(demoData.reported_freight);
      setReportedGrandTotal(demoData.reported_grand_total);

      const res = await processRawScan(demoData);
      setScanResponse(res);
      showToast('Exemple de facture fournisseur chargé et réconcilié.', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err) || 'Erreur lors du chargement de la démo';
      setAiError(msg);
      showToast(msg, 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleScanFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setAiError(null);
    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as string;
      if (!content) return;

      setIsAnalyzing(true);
      try {
        const boxes = parseTextToBoundingBoxes(content);
        if (boxes.length === 0) {
          throw new Error('Le fichier ne contient aucun texte exploitable.');
        }

        const res = await processRawScan({
          supplier_name: supplierName.trim() || 'Fournisseur Inconnu',
          bounding_boxes: boxes,
          reported_tax: reportedTax,
          reported_freight: reportedFreight,
          reported_grand_total: reportedGrandTotal,
        });

        applyExtractedSummary(res);
        setScanResponse(res);
        showToast('Fichier analysé avec succès.', 'success');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err) || 'Erreur de traitement du fichier';
        setAiError(msg);
        showToast(msg, 'error');
      } finally {
        setIsAnalyzing(false);
      }
    };

    reader.onerror = () => {
      setAiError('Erreur de lecture du fichier scan.');
    };

    reader.readAsText(file);
  };

  const handleDirectOcrProcess = async () => {
    if (!rawOcrInput.trim()) return;
    setAiError(null);
    setIsAnalyzing(true);
    try {
      const boxes = parseTextToBoundingBoxes(rawOcrInput);
      const res = await processRawScan({
        supplier_name: supplierName.trim() || 'Fournisseur Inconnu',
        bounding_boxes: boxes,
        reported_tax: reportedTax,
        reported_freight: reportedFreight,
        reported_grand_total: reportedGrandTotal,
      });

      applyExtractedSummary(res);
      setScanResponse(res);
      showToast('Lignes OCR analysées avec succès.', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err) || 'Erreur de traitement OCR';
      setAiError(msg);
      showToast(msg, 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // If scan data is ready, render the full interactive Review Screen
  if (scanResponse) {
    return (
      <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-0 sm:p-4 select-none">
        <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col h-full max-h-[96vh] sm:max-h-[92vh]">
          <PoReviewScreen
            supplierName={supplierName}
            reportedTax={reportedTax}
            reportedFreight={reportedFreight}
            reportedGrandTotal={
              reportedGrandTotal > 0
                ? reportedGrandTotal
                : Math.round(scanResponse.invariant_report.calculated_grand_total)
            }
            scanData={scanResponse}
            onCommitSuccess={(count) => {
              showToast(`Stock réceptionné avec succès (${count} lots enregistrés).`, 'success');
              setScanResponse(null);
              closeModal();
            }}
            onCancel={() => setScanResponse(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none">
      <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col h-[94dvh] sm:h-auto max-h-[94dvh] sm:max-h-[90vh] pt-[max(0.5rem,var(--safe-top))] pb-[max(0.75rem,var(--safe-bottom))] sm:py-0">
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 text-pos-accent min-w-0">
            <Layers className="w-5 h-5 shrink-0" />
            <h2 className="text-sm font-bold text-pos-text truncate">
              Réception & Ingestion de Facture Fournisseur
            </h2>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Selector Tabs (Mobile Touch-Optimized) */}
        <div className="px-4 pt-3 bg-pos-card border-b border-pos-border grid grid-cols-2 gap-2 shrink-0">
          <button
            onClick={() => setActiveTab('ai_recon')}
            className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-t-xl text-xs font-bold border-b-2 transition cursor-pointer min-h-[44px] ${
              activeTab === 'ai_recon'
                ? 'border-pos-accent text-pos-accent bg-pos-panel/60 shadow-xs'
                : 'border-transparent text-pos-muted hover:text-pos-text hover:bg-pos-panel/30'
            }`}
          >
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <span>Scanner IA & Invariants</span>
          </button>
          <button
            onClick={() => setActiveTab('csv_text')}
            className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-t-xl text-xs font-bold border-b-2 transition cursor-pointer min-h-[44px] ${
              activeTab === 'csv_text'
                ? 'border-pos-accent text-pos-accent bg-pos-panel/60 shadow-xs'
                : 'border-transparent text-pos-muted hover:text-pos-text hover:bg-pos-panel/30'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>Import CSV / Texte</span>
          </button>
        </div>

        {/* TAB 1: AI RECON & INVARIANT SCANNER */}
        {activeTab === 'ai_recon' && (
          <div className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1">
            {aiError && (
              <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs space-y-2.5">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
                  <span className="leading-relaxed">{aiError}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-rose-500/20">
                  <button
                    type="button"
                    onClick={handleDemoScanClick}
                    className="px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 font-bold text-[11px] flex items-center gap-1.5 cursor-pointer transition active-press"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    <span>Tester Facture Démo (1-Clic)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDirectTextInput(true)}
                    className="px-3 py-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-text font-medium text-[11px] flex items-center gap-1.5 cursor-pointer transition"
                  >
                    <FileText className="w-3.5 h-3.5 text-pos-accent" />
                    <span>Coller / Saisir Texte</span>
                  </button>
                </div>
              </div>
            )}

            {/* Invoice Configuration Card */}
            <div className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold text-pos-text">
                <Building2 className="w-4 h-4 text-pos-accent shrink-0" />
                <span>Paramètres de la Facture / Bon de Livraison</span>
              </div>

              <div>
                <label className="text-[10px] font-semibold text-pos-muted uppercase tracking-wider block mb-1">
                  Nom du Fournisseur
                </label>
                <input
                  type="text"
                  list="known-suppliers-list"
                  value={supplierName}
                  onChange={(e) => setSupplierName(e.target.value)}
                  placeholder="Ex: Grossiste Mobile Alger"
                  className="w-full bg-pos-panel border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:outline-none focus:border-pos-accent font-medium min-h-[42px]"
                />
                <datalist id="known-suppliers-list">
                  {knownSuppliers.map((s, idx) => (
                    <option key={idx} value={s} />
                  ))}
                </datalist>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[9px] font-semibold text-pos-muted uppercase tracking-wider block mb-1">
                    Total Facture (DA)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={reportedGrandTotal > 0 ? reportedGrandTotal : ''}
                    placeholder="Auto (calculé)"
                    onChange={(e) =>
                      setReportedGrandTotal(
                        Math.max(0, Math.round(parseLocalizedAmount(e.target.value) || 0))
                      )
                    }
                    className="w-full bg-pos-panel border border-pos-border rounded-xl px-2 py-1.5 text-xs text-pos-text text-center font-mono focus:outline-none focus:border-pos-accent min-h-[40px]"
                  />
                </div>

                <div>
                  <label className="text-[9px] font-semibold text-pos-muted uppercase tracking-wider block mb-1">
                    TVA (DA)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={reportedTax}
                    onChange={(e) =>
                      setReportedTax(
                        Math.max(0, Math.round(parseLocalizedAmount(e.target.value) || 0))
                      )
                    }
                    className="w-full bg-pos-panel border border-pos-border rounded-xl px-2 py-1.5 text-xs text-pos-text text-center font-mono focus:outline-none focus:border-pos-accent min-h-[40px]"
                  />
                </div>

                <div>
                  <label className="text-[9px] font-semibold text-pos-muted uppercase tracking-wider block mb-1">
                    Frais Port (DA)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={reportedFreight}
                    onChange={(e) =>
                      setReportedFreight(
                        Math.max(0, Math.round(parseLocalizedAmount(e.target.value) || 0))
                      )
                    }
                    className="w-full bg-pos-panel border border-pos-border rounded-xl px-2 py-1.5 text-xs text-pos-text text-center font-mono focus:outline-none focus:border-pos-accent min-h-[40px]"
                  />
                </div>
              </div>
            </div>

            {/* Action Cards (Large Tap Targets on Mobile) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Native Camera Scanner */}
              <button
                onClick={handleNativeCameraScan}
                disabled={isAnalyzing}
                className="p-4 rounded-2xl bg-gradient-to-br from-emerald-500/20 via-pos-card to-pos-card border border-emerald-500/40 hover:border-emerald-400 text-left transition flex flex-col justify-between gap-3 group cursor-pointer shadow-sm hover:shadow-md disabled:opacity-50 min-h-[100px] active-press"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="w-11 h-11 rounded-xl bg-emerald-500 text-slate-950 flex items-center justify-center font-black group-hover:scale-105 transition shadow-sm">
                    <Camera className="w-6 h-6" />
                  </div>
                  <span className="text-[10px] font-extrabold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                    {isNativeScannerSupported() ? 'Appareil Photo / ML Kit' : 'Scanner Caméra'}
                  </span>
                </div>
                <div>
                  <h4 className="text-xs font-black text-pos-text">Numériser avec la Caméra</h4>
                  <p className="text-[11px] text-pos-muted mt-0.5">
                    Prendre en photo le bon papier ou importer depuis la galerie photo.
                  </p>
                </div>
              </button>

              {/* Upload Document / Image */}
              <div className="relative">
                <input
                  type="file"
                  accept=".txt,.csv,.tsv"
                  ref={scanFileInputRef}
                  onChange={handleScanFileUpload}
                  className="hidden"
                />
                <button
                  onClick={() => scanFileInputRef.current?.click()}
                  disabled={isAnalyzing}
                  className="w-full h-full p-4 rounded-2xl bg-pos-card border border-pos-border hover:border-pos-accent text-left transition flex flex-col justify-between gap-3 group cursor-pointer shadow-sm hover:shadow-md disabled:opacity-50 min-h-[100px] active-press"
                >
                  <div className="w-11 h-11 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 group-hover:scale-105 transition">
                    <Upload className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs font-black text-pos-text">Importer Fichier Texte OCR</h4>
                    <p className="text-[11px] text-pos-muted mt-0.5">
                      Fichier texte (.txt, .csv) contenant les lignes du bon fournisseur.
                    </p>
                  </div>
                </button>
              </div>
            </div>

            {/* 1-Click Demo Loader for Testing & Demonstration */}
            <div className="pt-1">
              <button
                onClick={handleDemoScanClick}
                disabled={isAnalyzing}
                className="w-full p-3.5 rounded-2xl bg-pos-card/80 border border-pos-border hover:border-amber-500/40 text-left transition flex items-center justify-between gap-3 cursor-pointer group disabled:opacity-50 active-press"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 group-hover:scale-105 transition shrink-0">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-xs font-black text-pos-text truncate">Charger Facture Démo (1-Clic Test)</h4>
                    <p className="text-[10px] text-pos-muted truncate">
                      Teste immédiatement le contrôle d'invariants avec des codes GTIN et montants réels.
                    </p>
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-pos-muted group-hover:text-pos-text transition shrink-0" />
              </button>
            </div>

            {/* Direct OCR Textarea Toggle */}
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setShowDirectTextInput(!showDirectTextInput)}
                className="text-[11px] text-pos-muted hover:text-pos-text flex items-center gap-1.5 transition cursor-pointer min-h-[36px]"
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>{showDirectTextInput ? 'Masquer la saisie texte brute' : 'Saisie / Collage direct de lignes OCR'}</span>
              </button>

              {showDirectTextInput && (
                <div className="mt-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-pos-muted">Lignes de facture (format: Produit [GTIN] Qté x Prix)</span>
                    <button
                      type="button"
                      onClick={() =>
                        setRawOcrInput(
                          "1. ADAPT. SECT. 20W TYPE-C A2305 ORIG APPL    |  10 |     3 150,00 |           31 500,00\n   [S/N: 019425208421]\n\n2. ETUI SILIC. NOIR IPH 15 PROMAX             |  20 |     1 850,00 |           37 000,00\n   [REF: APC-15PM-B]\n\n3. BELKIN BRAIDED CABLE USBC-USBC 200CM / 2M  |  15 |     1 400,00 |           21 000,00\n   [GTIN: 0745883815234]\n\n4. ANKER 735 CHARGER GAN 3 65W 3-PORT FAST    |   5 |     4 200,00 |           21 000,00\n   [P/N: A2667G11]\n\n5. FILM VERRE TREMPE PRIVACY S24 ULTRA 9H     |  50 |       350,00 |           17 500,00\n   [ACC-SCR-S24U]"
                        )
                      }
                      className="text-[10px] text-pos-accent hover:underline cursor-pointer"
                    >
                      Insérer exemple (Facture Fournisseur)
                    </button>
                  </div>
                  <textarea
                    rows={4}
                    value={rawOcrInput}
                    onChange={(e) => setRawOcrInput(e.target.value)}
                    placeholder="Ex: Écran OLED iPhone 13 4006381333931 5x 12500.00 62500.00&#10;Batterie Origine Samsung S21 10x 3200.00 32000.00"
                    className="w-full bg-pos-panel border border-pos-border rounded-xl p-3 text-xs font-mono text-pos-text focus:border-pos-accent focus:outline-none"
                  />
                  <button
                    onClick={handleDirectOcrProcess}
                    disabled={!rawOcrInput.trim() || isAnalyzing}
                    className="px-4 py-2.5 rounded-xl bg-pos-accent text-white text-xs font-bold flex items-center gap-2 cursor-pointer disabled:opacity-50 min-h-[44px]"
                  >
                    {isAnalyzing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    <span>Analyser le texte OCR</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: ORIGINAL CSV / TEXT INGESTION (100% PRESERVED) */}
        {activeTab === 'csv_text' && (
          <div className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
              <p className="text-xs text-pos-muted max-w-md">
                Collez le texte ou importez un fichier CSV/TXT (Format: <code className="text-pos-accent">SKU, Quantité, PrixAchat, IMEI (optionnel)</code>) pour incrémenter directement les stocks.
              </p>
              <input
                type="file"
                accept=".csv,.txt"
                className="hidden"
                ref={fileInputRef}
                onChange={handleFileUpload}
              />
              <button
                onClick={triggerFileInput}
                className="w-full sm:w-auto px-3.5 py-2.5 rounded-xl bg-pos-card border border-pos-border hover:border-pos-accent text-pos-text text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors min-h-[44px] cursor-pointer"
              >
                <Upload className="w-4 h-4" /> Importer Fichier
              </button>
            </div>

            <textarea
              rows={6}
              value={rawText}
              onChange={(e) => {
                setRawText(e.target.value);
                setIngestStatus(null);
              }}
              placeholder="Ex: SKU-123, 10, 1500, IMEI-987654321..."
              className="w-full bg-pos-bg border border-pos-border rounded-xl p-3 text-xs font-mono text-pos-text focus:border-pos-accent focus:outline-none placeholder-pos-muted/50"
            />

            {ingestStatus && (
              <div className={`p-3 border rounded-xl text-xs flex items-center gap-2 ${
                ingestStatus.type === 'success' 
                  ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300' 
                  : 'bg-red-950/40 border-red-500/40 text-red-300'
              }`}>
                {ingestStatus.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                )}
                <span>{ingestStatus.message}</span>
              </div>
            )}

            {parsedLines.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-pos-text">Résultats d'analyse</h3>
                  <div className="text-xs flex gap-3">
                    <span className="text-emerald-400">{matchedCount} trouvés</span>
                    <span className="text-red-400">{unmatchedCount} introuvables</span>
                  </div>
                </div>
                <div className="bg-pos-bg rounded-xl border border-pos-border overflow-hidden">
                  <div className="max-h-48 overflow-y-auto p-1">
                    <table className="w-full text-xs text-left">
                      <thead className="text-pos-muted sticky top-0 bg-pos-bg">
                        <tr>
                          <th className="px-3 py-2 font-medium">Statut</th>
                          <th className="px-3 py-2 font-medium">SKU</th>
                          <th className="px-3 py-2 font-medium">Qté</th>
                          <th className="px-3 py-2 font-medium">Prix</th>
                          <th className="px-3 py-2 font-medium">IMEI</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pos-border/50">
                        {parsedLines.map((line, idx) => (
                          <tr key={idx} className={line.matched ? 'text-pos-text' : 'text-pos-muted'}>
                            <td className="px-3 py-2">
                              {line.matched ? (
                                <Check className="w-4 h-4 text-emerald-500" />
                              ) : (
                                <XIcon className="w-4 h-4 text-red-500" />
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono">{line.sku}</td>
                            <td className="px-3 py-2">{line.qty}</td>
                            <td className="px-3 py-2">{line.cost ? formatDZD(line.cost) : '-'}</td>
                            <td className="px-3 py-2 font-mono text-[10px]">{line.imei || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer Actions */}
        <div className="p-3 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row justify-end gap-2 shrink-0">
          <button
            onClick={closeModal}
            className="px-4 py-2.5 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition-colors min-h-[44px] flex items-center justify-center cursor-pointer"
          >
            Fermer
          </button>
          {activeTab === 'csv_text' && (
            <button
              onClick={handleProcessIngestion}
              disabled={!rawText.trim() || isProcessing}
              className="px-5 py-2.5 rounded-xl bg-pos-accent hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-lg transition-all min-h-[44px] cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" /> {isProcessing ? 'Ingestion en cours…' : 'Ingestion & Mise à Jour'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

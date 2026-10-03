import React, { useEffect, useMemo } from 'react';
import { X, Printer, Check, Zap, Sparkles, ChevronLeft, ShieldCheck } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import type { CartItem } from '../../types/pos';
import { directPrintReceipt } from '../../utils/escpos';
import { printCoordinator } from '../../utils/printCoordinator';
import { resolvePrinterForDocument } from '../../utils/printerRoutingEngine';
import { buildReceiptViewModel } from '../../utils/receiptViewModel';
import { extractWarrantyMonths, hasExplicitWarranty } from '../../utils/warrantyResolver';
import { ReceiptPaper } from '../receipt/ReceiptPaper';
import { useToast } from '../ui/Toast';

export const ReceiptModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    lastTransaction,
    selectedTransactionForRefund,
    receiptSettings,
    tradeIns,
  } = usePosStore();
  const targetPrinter = resolvePrinterForDocument('receipt', receiptSettings.printerRouting);
  const { showToast } = useToast();

  const currentTx = selectedTransactionForRefund || lastTransaction;

  const tradeInRecord = useMemo(() => {
    const id = currentTx?.tradeInId;
    if (!id) return null;
    return (tradeIns || []).find((t) => t.id === id) ?? null;
  }, [currentTx, tradeIns]);

  const viewModel = useMemo(
    () =>
      currentTx
        ? buildReceiptViewModel(currentTx, receiptSettings, { tradeIn: tradeInRecord })
        : null,
    [currentTx, receiptSettings, tradeInRecord],
  );

  // Explicit store warranty (or pre-owned device) + IMEI → certificate eligible.
  const warrantyMonthsFor = (item: CartItem): number => {
    if (!item.imeiNumber) return 0;
    if (hasExplicitWarranty(item.product)) return extractWarrantyMonths(item.product);
    if (item.product.category === "Téléphones d'Occasion (Reprise)") return 3;
    return 0;
  };

  const handlePrintCertificate = async (item: CartItem) => {
    if (!currentTx) return;
    const months = Math.max(1, Math.floor(warrantyMonthsFor(item) || 3));
    const { SavPrintCoordinator } = await import('../../utils/savPrintCoordinator');
    const ok = await SavPrintCoordinator.printWarrantyCertificate(currentTx, item, receiptSettings, months);
    showToast(
      ok ? `Certificat de garantie imprimé (${months} mois).` : 'Impression indisponible sur cet appareil.',
      ok ? 'success' : 'error',
    );
  };

  useEffect(() => {
    if (activeModal === 'receipt' && currentTx?.receiptNumber) {
      // Immediate direct hardware print if enabled in settings — same unified
      // ReceiptPaper content (trade-in record forwarded for device lines).
      if (receiptSettings.autoPrintEnabled !== false) {
        void directPrintReceipt(currentTx, receiptSettings, tradeInRecord);
      }
    }
  }, [activeModal, currentTx, receiptSettings, tradeInRecord]);

  useEffect(() => { if (activeModal !== 'receipt') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  if (activeModal !== 'receipt' || !currentTx || !viewModel) return null;

  const handlePrintBrowser = () => {
    // System dialog / PDF record copy (works in browser AND desktop app).
    // On mobile this is a no-op — use "Imprimer Thermique" (native sheet).
    printCoordinator.printChannelDirect('receipt', 120);
  };

  const handlePrintThermal = () => {
    void directPrintReceipt(currentTx, receiptSettings, tradeInRecord);
  };

  const warrantyItems = (currentTx.items || []).filter((i) => warrantyMonthsFor(i) > 0);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-2xl sm:rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:fade-in sm:zoom-in-95 flex flex-col max-h-[92dvh]">
        {/* Mobile Pull Handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeModal}
              aria-label="Retour — revenir à la vente"
              className="p-1.5 -ml-1 rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer flex items-center gap-1 font-bold text-xs min-h-[44px] min-w-[44px] justify-center"
              title="Retour"
            >
              <ChevronLeft className="w-5 h-5 text-cyan-400 stroke-[2.5]" aria-hidden="true" />
              <span className="hidden sm:inline">Retour</span>
            </button>
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center ${
                currentTx.isRefund
                  ? 'bg-purple-500/20 text-purple-400'
                  : 'bg-emerald-500/20 text-emerald-400'
              }`}
            >
              <Check className="w-4 h-4" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-pos-text">
                {currentTx.isRefund
                  ? "Avoir / Remboursement"
                  : "Ticket de Caisse"}
              </h2>
              <span className="text-[9px] text-emerald-400 font-bold flex items-center gap-1 mt-0.5">
                <Sparkles className="w-3 h-3" aria-hidden="true" /> {targetPrinter.printerName}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={closeModal}
            aria-label="Fermer — fermer le ticket de caisse"
            title="Fermer"
            className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Thermal Receipt Paper */}
        <div className="p-6 overflow-y-auto overscroll-contain max-h-[60vh] bg-slate-950 flex flex-col items-center gap-3">
          <ReceiptPaper viewModel={viewModel} settings={receiptSettings} />

          {/* Screen-only warranty certificate actions (never printed: outside .print-receipt-target) */}
          {warrantyItems.length > 0 ? (
            <div className="w-[80mm] max-w-[80mm] flex flex-col gap-1.5" aria-label="Certificats de garantie">
              {warrantyItems.map((item) => (
                <button
                  key={`${item.product.id}-${item.imeiNumber}`}
                  type="button"
                  onClick={() => void handlePrintCertificate(item)}
                  aria-label={`Certificat de Garantie — imprimer pour ${item.product.title}`}
                  title={`Imprimer le certificat de garantie (${warrantyMonthsFor(item)} mois)`}
                  className="inline-flex items-center gap-1 px-2 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[10px] font-black uppercase tracking-wide hover:bg-emerald-500/25 transition cursor-pointer"
                >
                  <ShieldCheck className="w-3 h-3" aria-hidden="true" /> Certificat de Garantie — {item.product.title}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* Footer Actions */}
        <div className="p-3.5 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col gap-2.5 shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-emerald-400 flex items-center gap-1 font-medium">
              <Zap className="w-3.5 h-3.5" aria-hidden="true" /> Signal Ouverture Tiroir-Caisse Envoyé
            </span>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 justify-end">
            <button
              type="button"
              onClick={closeModal}
              aria-label="Fermer — fermer le ticket de caisse"
              className="w-full sm:w-auto min-h-[42px] px-4 py-2 rounded-xl text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer order-3 sm:order-1"
            >
              Fermer
            </button>
            <button
              type="button"
              onClick={handlePrintBrowser}
              aria-label="Navigateur — imprimer le ticket via le navigateur"
              className="w-full sm:w-auto min-h-[42px] px-4 py-2 rounded-xl bg-pos-bg border border-pos-border hover:border-emerald-500 text-pos-text font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-95 cursor-pointer order-2"
            >
              <Printer className="w-4 h-4" aria-hidden="true" /> <span>Navigateur</span>
            </button>
            <button
              type="button"
              onClick={handlePrintThermal}
              aria-label="Imprimer Thermique — imprimer le ticket 80mm"
              className="w-full sm:w-auto min-h-[44px] px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 transition shadow-lg shadow-emerald-500/20 active:scale-95 cursor-pointer order-1 sm:order-3"
            >
              <Printer className="w-4 h-4 stroke-[2.5]" aria-hidden="true" /> <span>Imprimer Thermique</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};



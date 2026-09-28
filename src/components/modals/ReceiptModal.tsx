import React, { useRef, useEffect } from 'react';
import { X, Printer, Check, Zap, Sparkles, ChevronLeft } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import { renderBarcodeToCanvas } from '../../utils/barcodeGenerator';
import { resolvePrinterForDocument } from '../../utils/printerRoutingEngine';
import { directPrintReceipt } from '../../utils/escpos';
import { printCoordinator } from '../../utils/printCoordinator';
import { grossFromTransaction } from '../../utils/receiptMath';

export const ReceiptModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    lastTransaction,
    selectedTransactionForRefund,
    receiptSettings,
  } = usePosStore();
  const barcodeCanvasRef = useRef<HTMLCanvasElement>(null);
  const targetPrinter = resolvePrinterForDocument('receipt', receiptSettings.printerRouting);

  const currentTx = selectedTransactionForRefund || lastTransaction;

  useEffect(() => {
    if (activeModal === 'receipt' && currentTx?.receiptNumber) {
      if (barcodeCanvasRef.current) {
        renderBarcodeToCanvas(barcodeCanvasRef.current, currentTx.receiptNumber, 'code128', {
          height: 40,
          showText: false,
        });
      }
      // Immediate direct hardware print if enabled in settings
      if (receiptSettings.autoPrintEnabled !== false) {
        void directPrintReceipt(currentTx, receiptSettings);
      }
    }
  }, [activeModal, currentTx, receiptSettings]);

  if (activeModal !== 'receipt' || !currentTx) return null;

  const handlePrintBrowser = () => {
    // System dialog / PDF record copy (works in browser AND desktop app).
    // On mobile this is a no-op — use "Imprimer Thermique" (native sheet).
    printCoordinator.printChannelDirect('receipt', 120);
  };

  const handlePrintThermal = () => {
    void directPrintReceipt(currentTx, receiptSettings);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:fade-in sm:zoom-in-95 flex flex-col max-h-[92vh]">
        {/* Mobile Pull Handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeModal}
              className="p-1.5 -ml-1 rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer flex items-center gap-1 font-bold text-xs min-h-[36px] min-w-[36px] justify-center"
              title="Retour"
            >
              <ChevronLeft className="w-5 h-5 text-cyan-400 stroke-[2.5]" />
              <span className="hidden sm:inline">Retour</span>
            </button>
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center ${
                currentTx.isRefund
                  ? 'bg-purple-500/20 text-purple-400'
                  : 'bg-emerald-500/20 text-emerald-400'
              }`}
            >
              <Check className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-pos-text">
                {currentTx.isRefund
                  ? "Avoir / Remboursement"
                  : "Ticket de Caisse"}
              </h2>
              <span className="text-[9px] text-emerald-400 font-bold flex items-center gap-1 mt-0.5">
                <Sparkles className="w-3 h-3" /> {targetPrinter.printerName}
              </span>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Thermal Receipt Paper */}
        <div className="p-6 overflow-y-auto max-h-[60vh] bg-slate-950 flex justify-center">
          <div className="print-receipt-target w-[80mm] max-w-[80mm] bg-white text-black p-4 shadow-2xl font-mono text-xs leading-tight rounded-sm">
            {/* Store Header with Template Customizer */}
            <div className="text-center pb-4 border-b border-dashed border-gray-400">
              {receiptSettings.logoUrl && (
                <div className="flex justify-center mb-2">
                  <img
                    src={receiptSettings.logoUrl}
                    alt="Logo Magasin"
                    className="max-h-14 max-w-[200px] object-contain mix-blend-multiply"
                  />
                </div>
              )}
              <h1 className="font-extrabold text-sm tracking-wider uppercase">{receiptSettings.storeName}</h1>
              <p className="text-[10px] text-gray-600">{receiptSettings.address}</p>
              <p className="text-[10px] text-gray-600">Tél: {receiptSettings.phone}</p>
              
              {currentTx.isRefund ? (
                <div className="mt-2 py-1 px-2 bg-gray-100 border border-gray-300 rounded text-center">
                  <p className="font-extrabold text-[11px] uppercase tracking-wider text-black">
                    *** BON D'AVOIR / REMBOURSEMENT ***
                  </p>
                  <p className="text-[9px] font-bold text-gray-700">N° Avoir: {currentTx.receiptNumber}</p>
                  {currentTx.originalReceiptNumber && (
                    <p className="text-[8px] text-gray-600">Sur Ticket Vente: #{currentTx.originalReceiptNumber}</p>
                  )}
                  {currentTx.refundReason && (
                    <p className="text-[8px] italic text-gray-600 mt-0.5">Motif: {currentTx.refundReason}</p>
                  )}
                </div>
              ) : (
                <>
                  <p className="text-[9px] text-gray-500 mt-1">N° Ticket: {currentTx.receiptNumber}</p>
                </>
              )}
              <p className="text-[9px] text-gray-500 mt-0.5">{formatDateTime(currentTx.createdAt)}</p>
            </div>

            {/* Customer Info */}
            {currentTx.customer && (
              <div className="py-2 border-b border-dashed border-gray-400 text-[10px]">
                <p><span className="font-bold">Client:</span> {currentTx.customer.name}</p>
                {currentTx.customer.registeredDevice && (
                  <p><span className="font-bold">Appareil:</span> {currentTx.customer.registeredDevice}</p>
                )}
                {currentTx.isRefund && currentTx.paymentMethod === 'Avoir Client' && (
                  <p className="font-bold text-purple-800 mt-0.5">
                    Solde Avoir Client Total: {formatDZD(currentTx.customer.storeCredit)}
                  </p>
                )}
              </div>
            )}

            {/* Items Table */}
            <div className="py-3 space-y-2 border-b border-dashed border-gray-400">
              <p className="text-[9px] font-bold uppercase text-gray-600">
                {currentTx.isRefund ? "Articles Retournés :" : "Articles Achetés :"}
              </p>
              {(currentTx.items || []).map((item) => {
                const unitPrice = item.unitPriceCharged || item.appliedPrice || item.product.price;
                const defaultPrice = item.defaultPrice || item.product.price;
                const grossLinePrice = unitPrice * item.quantity;
                const netLinePrice = Math.max(0, grossLinePrice - (item.discount || 0));
                const hasManualDiscount = item.discountAmount !== undefined && item.discountAmount > 0;

                return (
                  <div key={item.product.id} className="flex flex-col">
                    <div className="flex justify-between">
                      <div className="pr-2 flex-1">
                        <p className="font-bold break-words">{item.product.title}</p>
                        <p className="text-[9px] text-gray-600">
                          {item.quantity} x {formatDZD(unitPrice)}
                          {defaultPrice !== unitPrice && (
                            <span className="line-through text-gray-400 ml-1.5 font-normal">
                              {formatDZD(defaultPrice)}
                            </span>
                          )}
                        </p>
                      </div>
                      <span className="font-bold text-right shrink-0">{formatDZD(netLinePrice)}</span>
                    </div>

                    {item.discount > 0 && (
                      <div className="flex justify-between text-[9px] text-purple-700 font-semibold italic pl-2">
                        <span>&gt; Remise Produit :</span>
                        <span>-{formatDZD(item.discount)}</span>
                      </div>
                    )}

                    {hasManualDiscount && (
                      <div className="flex justify-between text-[9px] text-amber-700 font-semibold italic pl-2">
                        <span>&gt; Remise Manuelle :</span>
                        <span>-{formatDZD((item.discountAmount || 0) * item.quantity)} (-{formatDZD(item.discountAmount || 0)}/u)</span>
                      </div>
                    )}

                    {item.imeiNumber && (
                      <p className="text-[9px] text-gray-500 mt-0.5 font-mono">IMEI: {item.imeiNumber}</p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Totals Breakdown */}
            <div className="py-3 space-y-1 text-[11px]">
              {/* Show Subtotal and Discount Breakdown if discount exists */}
              {currentTx.discountTotal > 0 && (
                <>
                  <div className="flex justify-between text-gray-700 text-[10px]">
                    <span>SOUS-TOTAL BRUT:</span>
                      <span>{formatDZD(grossFromTransaction(currentTx))}</span>
                  </div>
                  <div className="flex justify-between text-purple-700 font-bold text-[10px]">
                    <span>REMISE ACCORDÉE:</span>
                    <span>-{formatDZD(currentTx.discountTotal)}</span>
                  </div>
                </>
              )}

              {currentTx.tenders?.some(t => t.method === 'Avoir Client') && (
                <div className="flex justify-between text-purple-700 font-bold text-[10px]">
                  <span>AVOIR CLIENT DÉDUIT:</span>
                  <span>-{formatDZD(currentTx.tenders.find(t => t.method === 'Avoir Client')?.amount || 0)}</span>
                </div>
              )}

              <div className="flex justify-between font-extrabold text-sm pt-1.5 pb-1 px-1 -mx-1 mt-1 border-t-2 border-black bg-gray-100 rounded-sm">
                <span>{currentTx.isRefund ? "TOTAL AVOIR / REMBOURSÉ:" : "TOTAL NET A PAYER:"}</span>
                <span className={currentTx.isRefund ? "text-purple-900" : ""}>
                  {formatDZD(currentTx.total)}
                </span>
              </div>

              <div className="pt-2 text-[10px] border-t border-dashed border-gray-400 space-y-0.5">
                <div className="flex justify-between">
                  <span>{currentTx.isRefund ? "Mode de Remboursement:" : "Mode de Règlement:"}</span>
                  <span className="font-bold">{currentTx.paymentMethod || 'Espèces (Comptant)'}</span>
                </div>
                {!currentTx.isRefund && (
                  <>
                    <div className="flex justify-between">
                      <span>Espèces Reçues:</span>
                      <span>{formatDZD(currentTx.cashTendered)}</span>
                    </div>
                    <div className="flex justify-between font-bold">
                      <span>Rendu Monnaie:</span>
                      <span>{formatDZD(currentTx.changeDue)}</span>
                    </div>
                  </>
                )}
                {currentTx.customer?.storeCredit !== undefined && currentTx.customer.storeCredit > 0 && (
                  <div className="flex justify-between text-purple-900 font-bold pt-1 border-t border-gray-200">
                    <span>Nouveau Solde Avoir:</span>
                    <span>{formatDZD(currentTx.customer.storeCredit)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Terms & Barcode Footer */}
            <div className="text-center pt-2 border-t border-dashed border-gray-400 flex flex-col items-center space-y-1">
              <p className="text-[8px] font-bold uppercase tracking-wider text-gray-700">
                • Paiement Comptant en Espèces Uniquement •
              </p>
              <canvas ref={barcodeCanvasRef} className="h-10 my-1 mix-blend-multiply max-w-[90%]" />
              <p className="text-[8px] text-gray-500">
                {currentTx.isRefund
                  ? "Ce bon d'avoir est valable en magasin sur présentation de ce document."
                  : receiptSettings.customFooterMsg}
              </p>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-3.5 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col gap-2.5 shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-emerald-400 flex items-center gap-1 font-medium">
              <Zap className="w-3.5 h-3.5" /> Signal Ouverture Tiroir-Caisse Envoyé
            </span>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 justify-end">
            <button
              onClick={closeModal}
              className="w-full sm:w-auto min-h-[42px] px-4 py-2 rounded-xl text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer order-3 sm:order-1"
            >
              Fermer
            </button>
            <button
              onClick={handlePrintBrowser}
              className="w-full sm:w-auto min-h-[42px] px-4 py-2 rounded-xl bg-pos-bg border border-pos-border hover:border-emerald-500 text-pos-text font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-95 cursor-pointer order-2"
            >
              <Printer className="w-4 h-4" /> <span>Navigateur</span>
            </button>
            <button
              onClick={handlePrintThermal}
              className="w-full sm:w-auto min-h-[44px] px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 transition shadow-lg shadow-emerald-500/20 active:scale-95 cursor-pointer order-1 sm:order-3"
            >
              <Printer className="w-4 h-4 stroke-[2.5]" /> <span>Imprimer Thermique</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

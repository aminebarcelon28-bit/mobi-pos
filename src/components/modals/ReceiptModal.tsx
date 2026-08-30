import React, { useRef, useEffect } from 'react';
import { X, Printer, Check, Zap, Sparkles } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { renderBarcodeToCanvas } from '../../utils/barcodeGenerator';
import { resolvePrinterForDocument } from '../../utils/printerRoutingEngine';
import { printCoordinator } from '../../utils/printCoordinator';

export const ReceiptModal: React.FC = () => {
  const { activeModal, closeModal, lastTransaction, receiptSettings } = usePosStore();
  const barcodeCanvasRef = useRef<HTMLCanvasElement>(null);
  const targetPrinter = resolvePrinterForDocument('receipt', receiptSettings.printerRouting);

  useEffect(() => {
    if (activeModal === 'receipt' && lastTransaction?.receiptNumber) {
      if (barcodeCanvasRef.current) {
        renderBarcodeToCanvas(barcodeCanvasRef.current, lastTransaction.receiptNumber, 'code128', {
          height: 40,
          showText: false,
        });
      }
      // Immediate auto-print execution if enabled in settings
      if (receiptSettings.autoPrintEnabled !== false) {
        printCoordinator.printReceipt(150);
      }
    }
  }, [activeModal, lastTransaction, receiptSettings.autoPrintEnabled]);

  if (activeModal !== 'receipt' || !lastTransaction) return null;

  const handlePrintBrowser = () => {
    printCoordinator.printReceipt(20);
  };

  const handlePrintThermal = () => {
    console.log(`[SmartRouting] Ticket ${lastTransaction.receiptNumber} routé automatiquement vers: ${targetPrinter.printerName}`);
    printCoordinator.printReceipt(20);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center ${
                lastTransaction.isRefund
                  ? 'bg-purple-500/20 text-purple-400'
                  : 'bg-emerald-500/20 text-emerald-400'
              }`}
            >
              <Check className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-pos-text">
                {lastTransaction.isRefund
                  ? "Avoir / Remboursement Émis avec Succès"
                  : "Paiement Enregistré avec Succès"}
              </h2>
              <span className="text-[9px] text-emerald-400 font-bold flex items-center gap-1 mt-0.5">
                <Sparkles className="w-3 h-3" /> Routé vers: {targetPrinter.printerName}
              </span>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition"
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
              
              {lastTransaction.isRefund ? (
                <div className="mt-2 py-1 px-2 bg-gray-100 border border-gray-300 rounded text-center">
                  <p className="font-extrabold text-[11px] uppercase tracking-wider text-black">
                    *** BON D'AVOIR / REMBOURSEMENT ***
                  </p>
                  <p className="text-[9px] font-bold text-gray-700">N° Avoir: {lastTransaction.receiptNumber}</p>
                  {lastTransaction.originalReceiptNumber && (
                    <p className="text-[8px] text-gray-600">Sur Ticket Vente: #{lastTransaction.originalReceiptNumber}</p>
                  )}
                  {lastTransaction.refundReason && (
                    <p className="text-[8px] italic text-gray-600 mt-0.5">Motif: {lastTransaction.refundReason}</p>
                  )}
                </div>
              ) : (
                <>
                  <p className="text-[9px] text-gray-500 mt-1">N° Ticket: {lastTransaction.receiptNumber}</p>
                </>
              )}
              <p className="text-[9px] text-gray-500 mt-0.5">{lastTransaction.createdAt}</p>
            </div>

            {/* Customer Info */}
            {lastTransaction.customer && (
              <div className="py-2 border-b border-dashed border-gray-400 text-[10px]">
                <p><span className="font-bold">Client:</span> {lastTransaction.customer.name}</p>
                {lastTransaction.customer.registeredDevice && (
                  <p><span className="font-bold">Appareil:</span> {lastTransaction.customer.registeredDevice}</p>
                )}
                {lastTransaction.isRefund && lastTransaction.paymentMethod === 'Avoir Client' && (
                  <p className="font-bold text-purple-800 mt-0.5">
                    Solde Avoir Client Total: {formatDZD(lastTransaction.customer.storeCredit)}
                  </p>
                )}
              </div>
            )}

            {/* Items Table */}
            <div className="py-3 space-y-2 border-b border-dashed border-gray-400">
              <p className="text-[9px] font-bold uppercase text-gray-600">
                {lastTransaction.isRefund ? "Articles Retournés :" : "Articles Achetés :"}
              </p>
              {lastTransaction.items.map((item) => {
                const unitPrice = item.appliedPrice || item.product.price;
                const grossLinePrice = unitPrice * item.quantity;
                const netLinePrice = Math.max(0, grossLinePrice - item.discount);

                return (
                  <div key={item.product.id} className="flex flex-col">
                    <div className="flex justify-between">
                      <div className="pr-2 flex-1">
                        <p className="font-bold break-words">{item.product.title}</p>
                        <p className="text-[9px] text-gray-600">
                          {item.quantity} x {formatDZD(unitPrice)}
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
              {lastTransaction.discountTotal > 0 && (
                <>
                  <div className="flex justify-between text-gray-700 text-[10px]">
                    <span>SOUS-TOTAL BRUT:</span>
                    <span>{formatDZD(lastTransaction.subtotal + lastTransaction.discountTotal)}</span>
                  </div>
                  <div className="flex justify-between text-purple-700 font-bold text-[10px]">
                    <span>REMISE ACCORDÉE:</span>
                    <span>-{formatDZD(lastTransaction.discountTotal)}</span>
                  </div>
                </>
              )}

              <div className="flex justify-between font-extrabold text-sm pt-1 border-t border-black">
                <span>{lastTransaction.isRefund ? "TOTAL AVOIR / REMBOURSÉ:" : "TOTAL NET A PAYER:"}</span>
                <span className={lastTransaction.isRefund ? "text-purple-900" : ""}>
                  {formatDZD(lastTransaction.total)}
                </span>
              </div>

              <div className="pt-2 text-[10px] border-t border-dashed border-gray-400 space-y-0.5">
                <div className="flex justify-between">
                  <span>{lastTransaction.isRefund ? "Mode de Remboursement:" : "Mode de Règlement:"}</span>
                  <span className="font-bold">{lastTransaction.paymentMethod || 'Espèces (Comptant)'}</span>
                </div>
                {!lastTransaction.isRefund && (
                  <>
                    <div className="flex justify-between">
                      <span>Espèces Reçues:</span>
                      <span>{formatDZD(lastTransaction.cashTendered)}</span>
                    </div>
                    <div className="flex justify-between font-bold">
                      <span>Rendu Monnaie:</span>
                      <span>{formatDZD(lastTransaction.changeDue)}</span>
                    </div>
                  </>
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
                {lastTransaction.isRefund
                  ? "Ce bon d'avoir est valable en magasin sur présentation de ce document."
                  : receiptSettings.customFooterMsg}
              </p>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-emerald-400 flex items-center gap-1">
              <Zap className="w-3.5 h-3.5" /> Signal Ouverture Tiroir-Caisse Envoyé
            </span>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={closeModal}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition"
            >
              Fermer
            </button>
            <button
              onClick={handlePrintBrowser}
              className="px-4 py-2 rounded-xl bg-pos-bg border border-pos-border hover:border-emerald-500 text-pos-text font-semibold text-xs flex items-center gap-1.5 transition"
            >
              <Printer className="w-4 h-4" /> Imprimer via Navigateur
            </button>
            <button
              onClick={handlePrintThermal}
              className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition shadow-lg shadow-emerald-500/20"
            >
              <Printer className="w-4 h-4" /> Imprimer Thermique
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

import React, { useRef, useEffect } from 'react';
import { usePosStore } from '../store/usePosStore';
import { formatDZD } from '../types/pos';
import { renderBarcodeToCanvas } from '../utils/barcodeGenerator';

export const SilentReceiptPrinter: React.FC = () => {
  const { lastTransaction, receiptSettings } = usePosStore();
  const barcodeCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (lastTransaction?.receiptNumber && barcodeCanvasRef.current) {
      renderBarcodeToCanvas(barcodeCanvasRef.current, lastTransaction.receiptNumber, 'code128', {
        height: 38,
        width: 240,
        showText: false,
      });
    }
  }, [lastTransaction]);

  if (!lastTransaction) return null;

  return (
    <div className="hidden print:block fixed inset-0 z-[99999] bg-white text-black p-0 m-0">
      <div
        className="print-receipt-target w-[80mm] max-w-[80mm] mx-auto bg-white text-black p-3 font-mono text-xs leading-tight"
      >
        {/* Store Header */}
        <div className="text-center pb-3 border-b border-dashed border-gray-600">
          {receiptSettings.logoUrl && (
            <div className="flex justify-center mb-1.5">
              <img
                src={receiptSettings.logoUrl}
                alt="Logo Magasin"
                className="max-h-12 max-w-[180px] object-contain mix-blend-multiply"
              />
            </div>
          )}
          <h1 className="font-black text-sm tracking-wider uppercase">{receiptSettings.storeName}</h1>
          {receiptSettings.address && <p className="text-[10px] text-gray-700">{receiptSettings.address}</p>}
          {receiptSettings.phone && <p className="text-[10px] text-gray-700">Tél: {receiptSettings.phone}</p>}
          <p className="text-[9px] text-gray-600 mt-1">N° Ticket: {lastTransaction.receiptNumber}</p>
          <p className="text-[9px] text-gray-600">{lastTransaction.createdAt}</p>
        </div>

        {/* Customer Info */}
        {lastTransaction.customer && (
          <div className="py-2 border-b border-dashed border-gray-600 text-[10px]">
            <p><span className="font-bold">Client:</span> {lastTransaction.customer.name}</p>
            {lastTransaction.customer.registeredDevice && (
              <p><span className="font-bold">Appareil:</span> {lastTransaction.customer.registeredDevice}</p>
            )}
          </div>
        )}

        {/* Items Table */}
        <div className="py-2.5 space-y-1.5 border-b border-dashed border-gray-600">
          {lastTransaction.items.map((item) => {
            const unitPrice = item.appliedPrice || item.product.price;
            const grossLinePrice = unitPrice * item.quantity;
            const netLinePrice = Math.max(0, grossLinePrice - item.discount);

            return (
              <div key={item.product.id} className="flex flex-col">
                <div className="flex justify-between items-start">
                  <div className="pr-1 flex-1">
                    <p className="font-bold text-[11px] break-words">{item.product.title}</p>
                    <p className="text-[9px] text-gray-700">
                      {item.quantity} x {formatDZD(unitPrice)}
                    </p>
                  </div>
                  <span className="font-bold text-right shrink-0">{formatDZD(netLinePrice)}</span>
                </div>

                {item.discount > 0 && (
                  <div className="flex justify-between text-[9px] text-gray-700 font-semibold italic pl-1">
                    <span>&gt; Remise Produit :</span>
                    <span>-{formatDZD(item.discount)}</span>
                  </div>
                )}

                {item.imeiNumber && (
                  <p className="text-[8.5px] text-gray-600 mt-0.5 font-mono">IMEI: {item.imeiNumber}</p>
                )}
              </div>
            );
          })}
        </div>

        {/* Totals Breakdown */}
        <div className="py-2.5 space-y-1 text-[11px]">
          {lastTransaction.discountTotal > 0 && (
            <>
              <div className="flex justify-between text-gray-700 text-[10px]">
                <span>SOUS-TOTAL BRUT:</span>
                <span>{formatDZD(lastTransaction.subtotal + lastTransaction.discountTotal)}</span>
              </div>
              <div className="flex justify-between text-gray-700 font-bold text-[10px]">
                <span>REMISE ACCORDÉE:</span>
                <span>-{formatDZD(lastTransaction.discountTotal)}</span>
              </div>
            </>
          )}

          <div className="flex justify-between font-black text-sm pt-1 border-t-2 border-black">
            <span>TOTAL NET À PAYER:</span>
            <span>{formatDZD(lastTransaction.total)}</span>
          </div>

          <div className="pt-2 text-[10px] border-t border-dashed border-gray-600 space-y-0.5">
            <div className="flex justify-between">
              <span>Mode de Paiement:</span>
              <span className="font-bold">{lastTransaction.paymentMethod || 'Espèces (DZD)'}</span>
            </div>
            <div className="flex justify-between">
              <span>Montant Reçu:</span>
              <span className="font-bold">{formatDZD(lastTransaction.cashTendered)}</span>
            </div>
            <div className="flex justify-between font-black text-[11px]">
              <span>Rendu Monnaie:</span>
              <span>{formatDZD(lastTransaction.changeDue)}</span>
            </div>
          </div>
        </div>

        {/* Barcode & Footer */}
        <div className="text-center pt-2.5 border-t border-dashed border-gray-600 flex flex-col items-center">
          <canvas ref={barcodeCanvasRef} className="h-9 my-1.5 mix-blend-multiply max-w-[90%]" />
          {receiptSettings.customFooterMsg && (
            <p className="text-[8px] text-gray-600 mt-1">{receiptSettings.customFooterMsg}</p>
          )}
        </div>
      </div>
    </div>
  );
};

import React, { useEffect, useRef } from 'react';
import { formatDZD } from '../../types/pos';
import type { ReceiptSettings } from '../../types/pos';
import { fiscalIdentifierLine, tvaSplitFromTotal } from '../../utils/receiptMath';
import { renderBarcodeToCanvas } from '../../utils/barcodeGenerator';
import {
  STORE_RETURN_POLICY,
  TRADE_IN_LEGAL_STATEMENT,
  type ReceiptViewModel,
} from '../../utils/receiptViewModel';

interface ReceiptPaperProps {
  viewModel: ReceiptViewModel;
  settings: ReceiptSettings;
  /** When false, the barcode canvas is omitted (ESC/POS text fallback). */
  showBarcode?: boolean;
}

/**
 * Production 80mm thermal receipt paper — the single visual truth for the
 * modal preview AND the browser print channel (`.print-receipt-target`).
 *
 * Layout contract:
 * - Exactly 80mm wide, monochrome, monospace + tabular numbers.
 * - Every monetary row is ONE paired row (flex justify-between / table row):
 *   labels and values are never split into independent columns.
 * - Cart lines use a semantic 4-column table:
 *   Désignation (left) | Qté (center) | P.U. (right) | Total (right).
 */
export const ReceiptPaper: React.FC<ReceiptPaperProps> = ({
  viewModel,
  settings,
  showBarcode = true,
}) => {
  const vm = viewModel;
  const barcodeRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!showBarcode || !barcodeRef.current) return;
    try {
      renderBarcodeToCanvas(barcodeRef.current, vm.ticketId, 'code128', {
        height: 40,
        showText: false,
      });
    } catch {
      /* barcode is decorative — the ticket id text below stays authoritative */
    }
  }, [showBarcode, vm.ticketId]);

  const fiscal = fiscalIdentifierLine(settings);
  const tva = tvaSplitFromTotal(vm.netDue, settings.vatRate);
  const showBarcodeBlock = showBarcode && (settings.showBarcode !== false);

  return (
    <div className="print-receipt-target w-[80mm] max-w-[80mm] bg-white text-black p-4 font-mono tabular-nums text-xs leading-tight">
      {/* ── Store header ── */}
      <div className="text-center pb-3 border-b border-dashed border-gray-400">
        {settings.logoUrl ? (
          <div className="flex justify-center mb-2">
            <img
              src={settings.logoUrl}
              alt="Logo Magasin"
              className="max-h-14 max-w-[200px] object-contain mix-blend-multiply"
            />
          </div>
        ) : null}
        <h1 className="font-extrabold text-sm tracking-wider uppercase">{vm.store.name}</h1>
        {vm.store.tagline ? (
          <p className="text-[10px] text-gray-600">{vm.store.tagline}</p>
        ) : null}
        {vm.store.address ? (
          <p className="text-[10px] text-gray-600">{vm.store.address}</p>
        ) : null}
        {vm.store.phone ? <p className="text-[10px] text-gray-600">Tél: {vm.store.phone}</p> : null}
        {fiscal ? <p className="text-[9px] font-bold text-gray-700">{fiscal}</p> : null}

        {/* ── Transaction nature (derived header label) ── */}
        <div className="mt-2 py-1 px-2 bg-gray-100 border border-gray-300 rounded text-center">
          <p className="font-extrabold text-[11px] uppercase tracking-wider text-black">
            *** {vm.natureLabel} ***
          </p>
        </div>
      </div>

      {/* ── Session telemetry: every row pairs label + value ── */}
      <div className="py-2 border-b border-dashed border-gray-400 text-[10px] space-y-0.5">
        <div className="flex justify-between gap-2">
          <span className="text-gray-600">N° Ticket:</span>
          <span className="font-bold text-right break-all">{vm.ticketId}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-gray-600">Date / Heure:</span>
          <span className="font-bold text-right">{vm.dateTime}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-gray-600">Caisse:</span>
          <span className="font-bold text-right break-all">{vm.registerId}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-gray-600">Vendeur:</span>
          <span className="font-bold text-right">{vm.cashierName}</span>
        </div>
      </div>

      {/* ── Cart: semantic 4-column table ── */}
      <div className="py-2 border-b border-dashed border-gray-400">
        <p className="text-[9px] font-bold uppercase text-gray-600 mb-1">
          {vm.isRefund ? 'Articles Retournés :' : 'Articles Achetés :'}
        </p>
        <table className="w-full border-collapse text-[10px]">
          <thead>
            <tr className="text-gray-600 uppercase text-[8px] border-b border-gray-300">
              <th scope="col" className="text-left font-bold py-1 pr-1">
                Désignation
              </th>
              <th scope="col" className="text-center font-bold py-1 px-1">
                Qté
              </th>
              <th scope="col" className="text-right font-bold py-1 px-1">
                P.U.
              </th>
              <th scope="col" className="text-right font-bold py-1 pl-1">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {vm.items.map((line, idx) => (
              <tr key={`${line.name}-${idx}`} className="border-b border-gray-100 last:border-0 align-top">
                <td className="text-left py-1 pr-1">
                  <span className="font-bold break-words">
                    {line.name}
                    {(line.warrantyMonths || 0) > 0 ? ' (*)' : ''}
                  </span>
                  {line.imei ? (
                    <span className="block text-[8px] text-gray-500 font-mono">IMEI: {line.imei}</span>
                  ) : null}
                  {(line.warrantyMonths || 0) > 0 ? (
                    <span className="block text-[8px] text-gray-700 font-bold">
                      Garantie {line.warrantyMonths} mois incluse (*)
                    </span>
                  ) : null}
                  {line.discount > 0 ? (
                    <span className="block text-[8px] text-gray-600 italic">
                      dont remise: -{formatDZD(line.discount)}
                    </span>
                  ) : null}
                </td>
                <td className="text-center py-1 px-1 whitespace-nowrap">{line.quantity}</td>
                <td className="text-right py-1 px-1 whitespace-nowrap">{formatDZD(line.unitPrice)}</td>
                <td className="text-right py-1 pl-1 font-bold whitespace-nowrap">{formatDZD(line.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Trade-in block (conditional) ── */}
      {vm.tradeIn ? (
        <div className="py-2 border-b border-dashed border-gray-400 text-[10px]">
          <p className="text-[9px] font-extrabold uppercase text-gray-800 mb-1">
            [Appareil Repris / Trade-In]
          </p>
          <div className="space-y-0.5">
            <div className="flex justify-between gap-2">
              <span className="text-gray-600">Catégorie:</span>
              <span className="font-bold text-right">{vm.tradeIn.category}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-gray-600">Modèle:</span>
              <span className="font-bold text-right break-words">{vm.tradeIn.model}</span>
            </div>
            {vm.tradeIn.imei ? (
              <div className="flex justify-between gap-2">
                <span className="text-gray-600">IMEI:</span>
                <span className="font-bold text-right font-mono break-all">{vm.tradeIn.imei}</span>
              </div>
            ) : null}
            {vm.tradeIn.grade ? (
              <div className="flex justify-between gap-2">
                <span className="text-gray-600">État:</span>
                <span className="font-bold text-right">{vm.tradeIn.grade}</span>
              </div>
            ) : null}
            <div className="flex justify-between gap-2 font-bold">
              <span>Crédit Reprise:</span>
              <span>-{formatDZD(vm.tradeIn.valuation)}</span>
            </div>
          </div>
          <p className="text-[8px] italic text-gray-700 mt-1.5 leading-snug">
            {TRADE_IN_LEGAL_STATEMENT}
          </p>
        </div>
      ) : null}

      {/* ── Financial ledger: single paired rows only ── */}
      <div className="py-2 text-[11px] space-y-1">
        <div className="flex justify-between gap-2 text-gray-700 text-[10px]">
          <span>SOUS-TOTAL BRUT:</span>
          <span className="whitespace-nowrap">{formatDZD(vm.grossSubtotal)}</span>
        </div>
        {vm.discounts > 0 ? (
          <div className="flex justify-between gap-2 text-gray-700 font-bold text-[10px]">
            <span>REMISE ACCORDÉE:</span>
            <span className="whitespace-nowrap">-{formatDZD(vm.discounts)}</span>
          </div>
        ) : null}
        {vm.tradeInCredit > 0 ? (
          <div className="flex justify-between gap-2 text-gray-700 font-bold text-[10px]">
            <span>CRÉDIT REPRISE DÉDUIT:</span>
            <span className="whitespace-nowrap">-{formatDZD(vm.tradeInCredit)}</span>
          </div>
        ) : null}
        {vm.voucherCredit > 0 ? (
          <div className="flex justify-between gap-2 text-gray-700 font-bold text-[10px]">
            <span>
              BON D&apos;ÉCHANGE{vm.voucherCode ? ` (${vm.voucherCode})` : ''}:
            </span>
            <span className="whitespace-nowrap">-{formatDZD(vm.voucherCredit)}</span>
          </div>
        ) : null}
        {vm.avoirCredit > 0 ? (
          <div className="flex justify-between gap-2 text-gray-700 font-bold text-[10px]">
            <span>AVOIR CLIENT DÉDUIT:</span>
            <span className="whitespace-nowrap">-{formatDZD(vm.avoirCredit)}</span>
          </div>
        ) : null}
        {tva ? (
          <>
            <div className="flex justify-between gap-2 text-gray-700 text-[10px]">
              <span>HT:</span>
              <span className="whitespace-nowrap">{formatDZD(tva.ht)}</span>
            </div>
            <div className="flex justify-between gap-2 text-gray-700 text-[10px]">
              <span>TVA {tva.rate}%:</span>
              <span className="whitespace-nowrap">+{formatDZD(tva.tva)}</span>
            </div>
          </>
        ) : null}

        <div className="flex justify-between gap-2 font-extrabold text-sm pt-1.5 pb-1 px-1 -mx-1 mt-1 border-t-2 border-black bg-gray-100 rounded-sm">
          <span>{vm.isRefund ? 'TOTAL AVOIR / REMBOURSÉ:' : 'TOTAL NET À PAYER:'}</span>
          <span className="whitespace-nowrap">{formatDZD(vm.netDue)}</span>
        </div>

        {/* Multi-tender settlement */}
        <div className="pt-2 text-[10px] border-t border-dashed border-gray-400 space-y-0.5">
          <p className="text-[9px] font-bold uppercase text-gray-600">
            {vm.isRefund ? 'Mode de Remboursement:' : 'Modes de Règlement:'}
          </p>
          {vm.tenders.map((tender, idx) => (
            <div key={`${tender.method}-${idx}`} className="flex justify-between gap-2">
              <span>{tender.label}:</span>
              <span className="font-bold whitespace-nowrap">{formatDZD(tender.amount)}</span>
            </div>
          ))}
          {!vm.isRefund ? (
            <div className="flex justify-between gap-2 font-bold">
              <span>Rendu Monnaie:</span>
              <span className="whitespace-nowrap">{formatDZD(vm.changeDue)}</span>
            </div>
          ) : null}
          {(() => {
            const wMax = Math.max(0, ...vm.items.map((l) => l.warrantyMonths || 0));
            return wMax > 0 ? (
              <p className="text-[9px] text-gray-700 font-bold pt-1">
                Garantie: {wMax} mois sur articles signalés (*)
              </p>
            ) : null;
          })()}
        </div>
      </div>

      {/* ── Footer: policy + barcode ── */}
      <div className="text-center pt-2 border-t border-dashed border-gray-400 flex flex-col items-center space-y-1">
        <p className="text-[8px] font-bold uppercase tracking-wider text-gray-700">
          • {STORE_RETURN_POLICY} •
        </p>
        {showBarcodeBlock ? (
          <>
            <canvas ref={barcodeRef} className="h-10 my-1 mix-blend-multiply max-w-[90%]" aria-hidden="true" />
            <p className="text-[9px] font-mono tracking-widest text-black">*{vm.ticketId}*</p>
          </>
        ) : (
          <p className="text-[9px] font-mono tracking-widest text-black">*{vm.ticketId}*</p>
        )}
        {settings.customFooterMsg ? (
          <p className="text-[8px] text-gray-600">{settings.customFooterMsg}</p>
        ) : null}
        <p className="text-[8px] text-gray-500">Merci de votre visite !</p>
      </div>
    </div>
  );
};

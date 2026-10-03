import React, { useMemo } from 'react';
import { usePosStore } from '../store/usePosStore';
import { buildReceiptViewModel } from '../utils/receiptViewModel';
import { ReceiptPaper } from './receipt/ReceiptPaper';

export const SilentReceiptPrinter: React.FC = () => {
  const { activeModal, activeShift, lastTransaction, receiptSettings, tradeIns } = usePosStore();

  const viewModel = useMemo(() => {
    if (!lastTransaction) return null;
    const tradeIn = lastTransaction.tradeInId
      ? ((tradeIns || []).find((t) => t.id === lastTransaction.tradeInId) ?? null)
      : null;
    return buildReceiptViewModel(lastTransaction, receiptSettings, {
      tradeIn,
      shiftOpener: activeShift?.openedBy ?? activeShift?.cashierName ?? null,
    });
  }, [lastTransaction, receiptSettings, tradeIns, activeShift]);

  // Single-print-target invariant: while the receipt modal is open its own
  // ReceiptPaper owns the `receipt` print channel. Rendering a second
  // `.print-receipt-target` here would stack both tickets at left:0/top:0
  // under `@media print` (position:fixed) and produce a doubled, unreadable
  // page. With the modal closed this silent copy is the only target (reprint
  // flows, bare Ctrl+P).
  if (activeModal === 'receipt') return null;
  if (!lastTransaction || !viewModel) return null;

  return (
    <div className="hidden print:block fixed inset-0 z-[99999] bg-white text-black p-0 m-0">
      <div className="mx-auto">
        <ReceiptPaper viewModel={viewModel} settings={receiptSettings} />
      </div>
    </div>
  );
};

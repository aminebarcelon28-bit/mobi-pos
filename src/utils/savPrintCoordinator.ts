/**
 * Enterprise 3-Piece SAV Print Coordinator
 * Orchestrates Customer Voucher, Workshop Diagnostic Card, and Chassis Sticker.
 * Author: Principal Systems Architect
 */
import type {
  CartItem,
  Customer,
  CustomerDebtEntry,
  RepairOrder,
  ReceiptSettings,
  SaleTransaction,
  TradeInItem,
} from '../types/pos';
import { SavTicketBuilder } from './savTicketBuilder';
import { SavLabelBuilder } from './savLabelBuilder';
import { SavRestitutionBuilder } from './savRestitutionBuilder';
import { SavQuoteBuilder } from './savQuoteBuilder';
import { WarrantyCertificateBuilder } from './warrantyCertificateBuilder';
import { TradeInVoucherBuilder } from './tradeInVoucherBuilder';
import { DebtStatementTicketBuilder } from './debtStatementTicketBuilder';
import { MobilePosRoutingEngine } from './mobilePosRoutingEngine';
import { isMobileDevice } from './platform';

export interface TriadPrintResult {
  customerVoucherPrinted: boolean;
  workshopCardPrinted: boolean;
  chassisStickerPrinted: boolean;
  /** True when the chassis tag fell back to 58mm ESC/POS text. */
  fallbackUsed: boolean;
}

/**
 * Live shift opener for slip telemetry (Part 1 seller rule): `openedBy` is
 * immutable across handovers; `cashierName` is the pre-handover fallback.
 * Lazy store import — this module is imported BY store slices, so a static
 * import would cycle.
 */
async function shiftSeller(): Promise<string | null> {
  try {
    const { usePosStore } = await import('../store/usePosStore');
    const s = usePosStore.getState().activeShift;
    return (s?.openedBy || '').trim() || (s?.cashierName || '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Triad steps, each independently enqueueable. Split from the runner so the
 * abortable queue (savPrintQueue) can schedule them FIFO — the old inline
 * `setTimeout(150)` sleeps let a second triad interleave bytes into the same
 * 80mm spooler and printed stale content after an edit.
 */
export async function printVoucherStep(
  order: RepairOrder,
  settings: ReceiptSettings,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false;
  const payload = SavTicketBuilder.buildCustomerVoucher(order, settings, await shiftSeller());
  return MobilePosRoutingEngine.dispatchDocument('REPAIR_CLAIM_STUB', payload);
}

export async function printWorkshopStep(
  order: RepairOrder,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false;
  const payload = SavTicketBuilder.buildWorkshopJobSlip(
    order,
    await shiftSeller(),
    order.assignedTechnicianId ?? null
  );
  return MobilePosRoutingEngine.dispatchDocument('REPAIR_WORK_ORDER', payload);
}

/**
 * Full intake triad, abortable. Each step is awaited (never fire-and-forget)
 * and the run aborts the moment the signal fires, so a cancelled intake cannot
 * leave a half-printed ticket set behind.
 */
export async function executeCompleteIntakeTriad(
  order: RepairOrder,
  settings: ReceiptSettings,
  signal?: AbortSignal
): Promise<TriadPrintResult> {
  const result: TriadPrintResult = {
    customerVoucherPrinted: false,
    workshopCardPrinted: false,
    chassisStickerPrinted: false,
    fallbackUsed: false,
  };

  result.customerVoucherPrinted = await printVoucherStep(order, settings, signal);
  if (signal?.aborted) return result;

  await abortableDelay(150, signal);
  if (signal?.aborted) return result;

  result.workshopCardPrinted = await printWorkshopStep(order, signal);
  if (signal?.aborted) return result;

  await abortableDelay(150, signal);
  if (signal?.aborted) return result;

  // Label step rides the full protocol ladder (TSPL → ZPL → ESC/POS
  // mini-tag → 58mm text fallback) so every SavLabelBuilder route is live.
  const label = await SavPrintCoordinator.printChassisLabel(order);
  result.chassisStickerPrinted = label.printed;
  result.fallbackUsed = label.fallbackUsed;

  return result;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class SavPrintCoordinator {
  /**
   * @deprecated Prefer `executeCompleteIntakeTriad(order, settings, signal)`
   * from this module: the queue-aware version is abortable and cannot
   * interleave with another triad on the same spooler.
   */
  public static async executeCompleteIntakeTriad(
    order: RepairOrder,
    settings: ReceiptSettings
  ): Promise<TriadPrintResult> {
    return executeCompleteIntakeTriad(order, settings);
  }

  /**
   * Restitution handover ticket: thermal ESC/POS on desktop (front-desk
   * receipt path), native text sheet on mobile. A4 is driven separately by
   * the Repair modal (print-repair-target + printingDocKind='restitution').
   */
  public static async printRepairRestitution(
    order: RepairOrder,
    settings: ReceiptSettings,
    paidToday?: number
  ): Promise<boolean> {
    // paidToday = session tender collected at handover (B5 ledger). Omit
    // when unknown: the slip then shows Net payé ce jour 0 and reste =
    // balance, never a fabricated echo of the cumulative deposit.
    const seller = await shiftSeller();
    try {
      if (isMobileDevice()) {
        const { openNativePrint } = await import('./phoneUtils');
        const { repairRestitutionText } = await import('./mobileDocPrint');
        return await openNativePrint(
          `Bon Restitution ${order.ticketNumber}`,
          repairRestitutionText(order, settings, seller, paidToday)
        );
      }
      const payload = SavRestitutionBuilder.buildSavRestitutionTicket(order, settings, seller, paidToday);
      return await MobilePosRoutingEngine.dispatchDocument('REPAIR_CLAIM_STUB', payload);
    } catch (e) {
      console.warn('[SAV] restitution thermal print failed:', e);
      return false;
    }
  }

  /**
   * Repair quotation ticket: thermal ESC/POS on desktop, native text sheet
   * on mobile. A4 is driven separately by the Repair modal
   * (print-repair-target + printingDocKind='quote').
   */
  public static async printRepairQuote(
    order: RepairOrder,
    settings: ReceiptSettings
  ): Promise<boolean> {
    try {
      if (isMobileDevice()) {
        const { openNativePrint } = await import('./phoneUtils');
        const { repairQuoteText } = await import('./mobileDocPrint');
        return await openNativePrint(
          `Devis SAV ${order.ticketNumber}`,
          repairQuoteText(order, settings, await shiftSeller())
        );
      }
      const payload = SavQuoteBuilder.buildSavQuoteTicket(order, settings, await shiftSeller());
      return await MobilePosRoutingEngine.dispatchDocument('REPAIR_CLAIM_STUB', payload);
    } catch (e) {
      console.warn('[SAV] quote thermal print failed:', e);
      return false;
    }
  }

  /**
   * Pre-owned / warranted-device certificate: thermal ESC/POS on desktop
   * (front-desk receipt path), native text sheet on mobile.
   */
  public static async printWarrantyCertificate(
    transaction: SaleTransaction,
    item: CartItem,
    settings: ReceiptSettings,
    warrantyMonths: number = 3
  ): Promise<boolean> {
    try {
      const mobileSeller =
        (transaction.shiftOpenedByName || '').trim() ||
        (await shiftSeller()) ||
        (transaction.cashierName || '').trim() ||
        null;
      if (isMobileDevice()) {
        const { openNativePrint } = await import('./phoneUtils');
        const { warrantyCertificateText } = await import('./mobileDocPrint');
        return await openNativePrint(
          `Garantie ${item.imeiNumber || transaction.receiptNumber}`,
          warrantyCertificateText(transaction, item, warrantyMonths, settings, mobileSeller)
        );
      }
      const payload = WarrantyCertificateBuilder.buildPreOwnedWarrantyCertificate(
        transaction,
        item,
        settings,
        warrantyMonths,
        transaction.shiftOpenedByName ||
          (await shiftSeller()) ||
          transaction.cashierName ||
          null
      );
      return await MobilePosRoutingEngine.dispatchDocument('WARRANTY_CERTIFICATE', payload);
    } catch (e) {
      console.warn('[SAV] warranty certificate print failed:', e);
      return false;
    }
  }

  /**
   * Trade-in legal buyback certificate: thermal ESC/POS on desktop, native
   * text sheet on mobile. The A4 attestation stays on the history reprint.
   */
  public static async printTradeInVoucher(
    trade: TradeInItem,
    settings: ReceiptSettings
  ): Promise<boolean> {
    try {
      if (isMobileDevice()) {
        const { openNativePrint } = await import('./phoneUtils');
        const { tradeInText } = await import('./mobileDocPrint');
        return await openNativePrint(
          `Cession ${trade.deviceModel}`,
          tradeInText(trade, settings)
        );
      }
      const payload = TradeInVoucherBuilder.buildLegalBuybackCertificate(trade, settings, await shiftSeller());
      return await MobilePosRoutingEngine.dispatchDocument('TRADE_IN_VOUCHER', payload);
    } catch (e) {
      console.warn('[SAV] trade-in voucher print failed:', e);
      return false;
    }
  }

  /**
   * Customer debt statement: thermal ESC/POS on desktop (front-desk path),
   * BT bytes with sheet fallback on mobile. Returns the transport used so
   * callers can decide whether the A4 channel print is still needed.
   */
  public static async printDebtStatement(
    customer: Customer,
    debts: CustomerDebtEntry[],
    settings: ReceiptSettings
  ): Promise<'thermal' | 'sheet' | 'failed'> {
    try {
      const seller = await shiftSeller();
      if (isMobileDevice()) {
        const { printBytesViaMobilePrinter } = await import('./mobilePrinter');
        const payload = DebtStatementTicketBuilder.buildStatementVoucher(customer, debts, settings, seller);
        const res = await printBytesViaMobilePrinter(payload);
        if (res.sent) return 'thermal';
        const { openNativePrint } = await import('./phoneUtils');
        const { debtStatementText } = await import('./mobileDocPrint');
        const ok = await openNativePrint(
          `Relevé ${customer.name}`,
          debtStatementText(customer, debts, settings, seller)
        );
        return ok ? 'sheet' : 'failed';
      }
      const payload = DebtStatementTicketBuilder.buildStatementVoucher(customer, debts, settings, seller);
      const ok = await MobilePosRoutingEngine.dispatchDocument('CUSTOMER_DEBT_STATEMENT', payload);
      return ok ? 'thermal' : 'failed';
    } catch (e) {
      console.warn('[SAV] debt statement print failed:', e);
      return 'failed';
    }
  }

  /**
   * Chassis tag with full protocol ladder: TSPL → ZPL → ESC/POS mini-tag on
   * the label channel, 58mm text fallback on the receipt channel. Used by
   * executeCompleteIntakeTriad so no SavLabelBuilder route stays unreachable.
   */
  public static async printChassisLabel(order: RepairOrder): Promise<{ printed: boolean; fallbackUsed: boolean }> {
    const ladder: Array<() => Uint8Array> = [
      () => SavLabelBuilder.buildTsplChassisLabel(order),
      () => SavLabelBuilder.buildZplChassisLabel(order),
      () => SavLabelBuilder.buildEscPosMiniTag(order),
    ];
    for (const build of ladder) {
      try {
        const payload = build();
        const ok = await MobilePosRoutingEngine.dispatchDocument('PRODUCT_LABEL', payload);
        if (ok) return { printed: true, fallbackUsed: false };
      } catch {
        // Next protocol in the ladder.
      }
    }
    try {
      const { chassisTagEscPosText } = await import('./mobileDocPrint');
      const text = chassisTagEscPosText(order);
      const bytes = new TextEncoder().encode(text + '\n\n\n');
      const printed = await MobilePosRoutingEngine.dispatchDocument('REPAIR_CLAIM_STUB', bytes);
      return { printed, fallbackUsed: printed };
    } catch {
      return { printed: false, fallbackUsed: true };
    }
  }
}

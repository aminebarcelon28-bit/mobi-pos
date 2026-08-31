/**
 * Enterprise 3-Piece SAV Print Coordinator
 * Orchestrates Customer Voucher, Workshop Diagnostic Card, and Chassis Sticker.
 * Author: Principal Systems Architect
 */
import type { RepairOrder, ReceiptSettings } from '../types/pos';
import { SavTicketBuilder } from './savTicketBuilder';
import { SavLabelBuilder } from './savLabelBuilder';
import { MobilePosRoutingEngine } from './mobilePosRoutingEngine';

export interface TriadPrintResult {
  customerVoucherPrinted: boolean;
  workshopCardPrinted: boolean;
  chassisStickerPrinted: boolean;
}

export class SavPrintCoordinator {
  public static async executeCompleteIntakeTriad(
    order: RepairOrder,
    settings: ReceiptSettings
  ): Promise<TriadPrintResult> {
    const result: TriadPrintResult = {
      customerVoucherPrinted: false,
      workshopCardPrinted: false,
      chassisStickerPrinted: false,
    };

    const customerPayload = SavTicketBuilder.buildCustomerVoucher(order, settings);
    result.customerVoucherPrinted = await MobilePosRoutingEngine.dispatchDocument(
      'REPAIR_CLAIM_STUB',
      customerPayload
    );

    await new Promise((r) => setTimeout(r, 150));

    const workshopPayload = SavTicketBuilder.buildWorkshopJobSlip(order);
    result.workshopCardPrinted = await MobilePosRoutingEngine.dispatchDocument(
      'REPAIR_WORK_ORDER',
      workshopPayload
    );

    await new Promise((r) => setTimeout(r, 150));

    const labelPayload = SavLabelBuilder.buildTsplChassisLabel(order);
    result.chassisStickerPrinted = await MobilePosRoutingEngine.dispatchDocument(
      'PRODUCT_LABEL',
      labelPayload
    );

    return result;
  }
}

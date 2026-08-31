/**
 * Professional Smart Routing Engine for Mobile Accessories & Repair POS
 * Author: Principal Systems Architect
 */
import type { DiscoveredDevice, PosDocumentType, MobileHardwareProfile } from '../types/pos';
import { printViaWindowsSpooler, openCashDrawerViaSpooler } from './escpos';
import { invoke } from '@tauri-apps/api/core';

export class MobilePosRoutingEngine {
  private static profile: MobileHardwareProfile = {
    frontDeskReceiptPrinter: null,
    workshopTechnicianPrinter: null,
    barcodeLabelPrinter: null,
    customerVfdPort: null,
  };

  public static autoConfigureProfile(devices: DiscoveredDevice[]): MobileHardwareProfile {
    const thermals = devices.filter((d) => d.category === 'thermalPrinter' || d.isUsb);
    const labels = devices.filter((d) => d.category === 'labelPrinter');
    const serials = devices.filter((d) => d.category === 'customerVfdDisplay' || d.category === 'genericSerial');

    if (thermals.length > 0) {
      this.profile.frontDeskReceiptPrinter = thermals[0].name;
    }

    if (thermals.length > 1) {
      const workshopNamed = thermals.find((t) =>
        t.name.toLowerCase().includes('sav') ||
        t.name.toLowerCase().includes('workshop') ||
        t.name.toLowerCase().includes('atelier')
      );
      this.profile.workshopTechnicianPrinter = workshopNamed ? workshopNamed.name : thermals[1].name;
    } else {
      this.profile.workshopTechnicianPrinter = this.profile.frontDeskReceiptPrinter;
    }

    if (labels.length > 0) {
      this.profile.barcodeLabelPrinter = labels[0].name;
    } else if (thermals.length > 2) {
      this.profile.barcodeLabelPrinter = thermals[2].name;
    }

    if (serials.length > 0) {
      this.profile.customerVfdPort = serials[0].portOrQueue;
    }

    return { ...this.profile };
  }

  public static getProfile(): MobileHardwareProfile {
    return { ...this.profile };
  }

  public static async dispatchDocument(
    docType: PosDocumentType,
    rawPayload: Uint8Array,
    options?: { kickCashDrawer?: boolean }
  ): Promise<boolean> {
    let targetPrinter: string | null = null;

    switch (docType) {
      case 'SALE_RECEIPT':
      case 'REPAIR_CLAIM_STUB':
      case 'TRADE_IN_VOUCHER':
      case 'Z_REPORT':
      case 'CUSTOMER_DEBT_STATEMENT':
        targetPrinter = this.profile.frontDeskReceiptPrinter;
        break;
      case 'REPAIR_WORK_ORDER':
        targetPrinter = this.profile.workshopTechnicianPrinter || this.profile.frontDeskReceiptPrinter;
        break;
      case 'PRODUCT_LABEL':
        targetPrinter = this.profile.barcodeLabelPrinter || this.profile.frontDeskReceiptPrinter;
        break;
    }

    if (!targetPrinter) {
      console.warn(`[Mobile POS Routing] No target hardware mapped for ${docType}. Falling back to default.`);
      return false;
    }

    const printSuccess = await printViaWindowsSpooler(targetPrinter, rawPayload);

    if (options?.kickCashDrawer && (docType === 'SALE_RECEIPT' || docType === 'CUSTOMER_DEBT_STATEMENT')) {
      await openCashDrawerViaSpooler(targetPrinter);
    }

    return printSuccess;
  }

  public static async updateCustomerDisplay(line1: string, line2: string): Promise<void> {
    if (!this.profile.customerVfdPort) return;
    try {
      await invoke('hardware_update_vfd', {
        interface: {
          type: 'serial',
          port_name: this.profile.customerVfdPort,
          baud_rate: 9600,
        },
        item_title: line1.slice(0, 20),
        total_price_formatted: line2.slice(0, 20),
      });
    } catch (e) {
      console.warn('[VFD Display] Stream update failed:', e);
    }
  }
}

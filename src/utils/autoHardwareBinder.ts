/**
 * Zero-Configuration Auto-Binding & Priority Heuristic Engine
 * Evaluates discovered peripherals and automatically assigns them to POS channels.
 * Author: Principal Systems Architect
 */
import type { DiscoveredDevice, ReceiptSettings } from '../types/pos';
import { usePosStore } from '../store/usePosStore';

export interface BindingResult {
  receiptPrinter?: DiscoveredDevice;
  labelPrinter?: DiscoveredDevice;
  vfdDisplay?: DiscoveredDevice;
}

export class AutoHardwareBinder {
  public static scoreThermalPrinter(device: DiscoveredDevice): number {
    const name = device.name.toLowerCase();
    let score = 10;

    if (name.includes('xprinter') || name.includes('xp-')) score += 50;
    if (name.includes('epson') || name.includes('tm-t')) score += 50;
    if (name.includes('pos-80') || name.includes('pos80') || name.includes('80mm')) score += 40;
    if (name.includes('star') || name.includes('tsp')) score += 40;
    if (name.includes('bixolon') || name.includes('srp')) score += 40;
    if (name.includes('thermal') || name.includes('receipt')) score += 30;

    if (
      name.includes('pdf') ||
      name.includes('xps') ||
      name.includes('onenote') ||
      name.includes('fax')
    ) {
      score = 0;
    }

    return score;
  }

  public static scoreLabelPrinter(device: DiscoveredDevice): number {
    const name = device.name.toLowerCase();
    let score = 10;

    if (name.includes('zebra') || name.includes('zd') || name.includes('gk420')) score += 60;
    if (name.includes('tsc') || name.includes('ttp-') || name.includes('da200')) score += 60;
    if (
      name.includes('xprinter') &&
      (name.includes('350') || name.includes('365') || name.includes('label'))
    ) {
      score += 50;
    }
    if (name.includes('barcode') || name.includes('tag')) score += 30;

    return score;
  }

  public static evaluateAndBind(
    devices: DiscoveredDevice[],
    showNotification?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void
  ): BindingResult {
    const result: BindingResult = {};
    const state = usePosStore.getState();
    const currentSettings: ReceiptSettings = state.receiptSettings;

    const thermalCandidates = devices.filter((d) => d.category === 'thermalPrinter' || d.isUsb);
    let bestThermal: DiscoveredDevice | null = null;
    let highestThermalScore = 0;

    for (const dev of thermalCandidates) {
      const score = this.scoreThermalPrinter(dev);
      if (score > highestThermalScore && score > 0) {
        highestThermalScore = score;
        bestThermal = dev;
      }
    }

    if (bestThermal && bestThermal.name !== currentSettings.printerName) {
      result.receiptPrinter = bestThermal;

      state.setReceiptSettings({
        ...currentSettings,
        printerName: bestThermal.name,
        printerInterface: 'SPOOLER',
      });

      if (showNotification) {
        showNotification(
          `Imprimante Reçu "${bestThermal.name}" connectée et configurée par défaut.`,
          'success'
        );
      }
    }

    const labelCandidates = devices.filter((d) => d.category === 'labelPrinter');
    let bestLabel: DiscoveredDevice | null = null;
    let highestLabelScore = 0;

    for (const dev of labelCandidates) {
      const score = this.scoreLabelPrinter(dev);
      if (score > highestLabelScore && score > 0) {
        highestLabelScore = score;
        bestLabel = dev;
      }
    }

    if (bestLabel) {
      result.labelPrinter = bestLabel;
    }

    const vfdCandidate = devices.find(
      (d) => d.category === 'customerVfdDisplay' || d.portOrQueue.toUpperCase().startsWith('COM')
    );

    if (vfdCandidate) {
      result.vfdDisplay = vfdCandidate;
    }

    return result;
  }
}

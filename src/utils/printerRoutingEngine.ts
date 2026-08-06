import type { PrinterRoutingConfig } from '../types/pos';

export type DocumentType = 'receipt' | 'label' | 'report' | 'repair_ticket';

export interface ResolvedPrinterTarget {
  printerId: string;
  printerName: string;
  documentTypeLabel: string;
  protocol: string;
  mediaType: string;
  isAutoRouted: boolean;
}

const DEFAULT_ROUTING: PrinterRoutingConfig = {
  receiptPrinterId: 'rp-1',
  receiptPrinterName: 'Imprimante Thermique Tickets (Epson TM-T88VI)',
  labelPrinterId: 'lp-1',
  labelPrinterName: 'Imprimante Étiquettes Code-Barres (Zebra ZD421)',
  reportPrinterId: 'sys-1',
  reportPrinterName: 'Imprimante Système Windows / PDF A4',
  autoRoutingEnabled: true,
};

/**
 * Intelligently resolves the target physical printer based on document type
 */
export const resolvePrinterForDocument = (
  docType: DocumentType,
  config?: PrinterRoutingConfig
): ResolvedPrinterTarget => {
  const routing = config || DEFAULT_ROUTING;

  switch (docType) {
    case 'receipt':
      return {
        printerId: routing.receiptPrinterId,
        printerName: routing.receiptPrinterName,
        documentTypeLabel: 'Ticket de Caisse & Reçu Client',
        protocol: 'ESC/POS Thermal 80mm',
        mediaType: 'Rouleau Thermique 80x80mm',
        isAutoRouted: routing.autoRoutingEnabled,
      };
    case 'label':
      return {
        printerId: routing.labelPrinterId,
        printerName: routing.labelPrinterName,
        documentTypeLabel: 'Étiquette Code-Barres & Prix',
        protocol: 'ZPL II Thermal Label',
        mediaType: 'Étiquette 50x25mm / 60x40mm',
        isAutoRouted: routing.autoRoutingEnabled,
      };
    case 'report':
    case 'repair_ticket':
    default:
      return {
        printerId: routing.reportPrinterId,
        printerName: routing.reportPrinterName,
        documentTypeLabel: docType === 'repair_ticket' ? 'Fiche d\'Atelier Réparation' : 'Rapport Z & Statistiques',
        protocol: 'Windows Print Spooler / PDF A4',
        mediaType: 'Feuille A4 Standard',
        isAutoRouted: routing.autoRoutingEnabled,
      };
  }
};

/**
 * Dispatches an automated smart print job with visual routing feedback
 */
export const dispatchSmartPrintJob = (
  docType: DocumentType,
  details: string,
  config?: PrinterRoutingConfig,
  showToast?: (msg: string, type: 'success' | 'info' | 'warning' | 'error') => void
): ResolvedPrinterTarget => {
  const target = resolvePrinterForDocument(docType, config);

  if (showToast) {
    showToast(
      `⚡ Routage Intelligent : [${target.documentTypeLabel}] routé automatiquement vers ${target.printerName}`,
      'info'
    );
  }

  console.log(`[SmartPrintRouter] Document: ${docType} (${details}) -> Target Printer: ${target.printerName} (${target.protocol})`);
  return target;
};

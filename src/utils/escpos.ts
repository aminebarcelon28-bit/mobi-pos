import type { SaleTransaction, ReceiptSettings, CashSession } from '../types/pos';
import { formatDZD } from '../types/pos';

const ESC = 0x1B;
const GS = 0x1D;
const LF = 0x0A;

/**
 * Classe utilitaire pour construire des commandes ESC/POS pour imprimantes thermiques.
 */
export class EscPosBuilder {
  private buffer: number[];

  constructor() {
    this.buffer = [];
  }

  /**
   * Initialise et réinitialise l'imprimante.
   */
  init(): this {
    this.buffer.push(ESC, 0x40);
    return this;
  }

  /**
   * Aligne le texte.
   */
  align(mode: 'left' | 'center' | 'right'): this {
    const n = mode === 'left' ? 0 : mode === 'center' ? 1 : 2;
    this.buffer.push(ESC, 0x61, n);
    return this;
  }

  /**
   * Active ou désactive le texte en gras.
   */
  bold(on: boolean): this {
    this.buffer.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }

  /**
   * Active ou désactive la double hauteur pour le texte.
   */
  doubleHeight(on: boolean): this {
    this.buffer.push(ESC, 0x21, on ? 0x10 : 0x00);
    return this;
  }

  /**
   * Encode le texte en octets et l'ajoute au tampon.
   */
  text(content: string): this {
    for (let i = 0; i < content.length; i++) {
      // Encodage simplifié pour ASCII
      this.buffer.push(content.charCodeAt(i) & 0xFF);
    }
    return this;
  }

  /**
   * Ajoute des sauts de ligne.
   */
  newline(count: number = 1): this {
    for (let i = 0; i < count; i++) {
      this.buffer.push(LF);
    }
    return this;
  }

  /**
   * Imprime une ligne de séparation pointillée ou avec le caractère donné.
   */
  separator(char: string = '-', width: number = 32): this {
    this.text(char.repeat(width));
    this.newline();
    return this;
  }

  /**
   * Imprime un code-barres avec les commandes standard GS k.
   */
  barcode(barcodeValue: string, type: 'CODE128' | 'EAN13' = 'CODE128'): this {
    // 1. Configuration géométrie code-barres standard
    this.buffer.push(GS, 0x68, 64);    // Hauteur = 64 dots (8mm)
    this.buffer.push(GS, 0x77, 2);     // Largeur de module = 2 dots
    this.buffer.push(GS, 0x48, 0x02);  // Texte HRI sous le code-barres
    this.buffer.push(GS, 0x66, 0x00);  // Police standard Font A pour HRI

    if (type === 'CODE128') {
      // Norme ESC/POS Function B: sélection de jeu de caractères {B (0x7B, 0x42)
      const dataBytes = [0x7B, 0x42];
      for (let i = 0; i < barcodeValue.length; i++) {
        dataBytes.push(barcodeValue.charCodeAt(i));
      }
      this.buffer.push(GS, 0x6B, 0x49, dataBytes.length, ...dataBytes);
    } else {
      const cleanEan = barcodeValue.replace(/\D/g, '').slice(0, 13);
      this.buffer.push(GS, 0x6B, 0x43, cleanEan.length);
      for (let i = 0; i < cleanEan.length; i++) {
        this.buffer.push(cleanEan.charCodeAt(i));
      }
    }
    return this;
  }

  /**
   * Envoie une impulsion pour ouvrir le tiroir-caisse.
   */
  openCashDrawer(pin: 0 | 1 = 0): this {
    const p = pin === 0 ? 0x00 : 0x01;
    this.buffer.push(ESC, 0x70, p, 0x32, 0xFA);
    return this;
  }

  /**
   * Avance le papier de 5 lignes pour dégager la tête d'impression et effectue une coupe partielle.
   */
  feedCut(): this {
    this.buffer.push(0x0A, 0x0A, 0x0A, 0x0A, 0x0A);
    this.buffer.push(GS, 0x56, 0x01);
    return this;
  }

  /**
   * Coupe le ticket (alias pour compatibilité).
   */
  cut(partial: boolean = false): this {
    this.buffer.push(GS, 0x56, partial ? 0x01 : 0x00);
    return this;
  }

  /**
   * Renvoie le tampon compilé prêt à être envoyé.
   */
  build(): Uint8Array {
    return new Uint8Array(this.buffer);
  }
}

/**
 * Construit un tampon complet pour l'impression d'un reçu thermique.
 */
export function buildReceiptBuffer(
  transaction: SaleTransaction,
  settings: ReceiptSettings
): Uint8Array {
  const builder = new EscPosBuilder();

  builder.init();

  // En-tête du magasin
  builder.align('center').bold(true);
  if (settings.storeName) builder.text(settings.storeName).newline();
  
  builder.bold(false);
  if (settings.address) builder.text(settings.address).newline();
  if (settings.phone) builder.text(settings.phone).newline();
  
  builder.newline().align('left');
  builder.separator();

  // Numéro de reçu et date
  builder.text(`Ticket: ${transaction.id}`).newline();
  builder.text(`Date: ${new Date(transaction.createdAt).toLocaleString('fr-FR')}`).newline();
  
  // Info client (optionnel)
  if (transaction.customer?.name) {
    builder.text(`Client: ${transaction.customer.name}`).newline();
  }

  builder.separator();

  // Liste des articles
  transaction.items.forEach((item) => {
    builder.text(item.product.title).newline();
    const qtyPrice = `${item.quantity} x ${formatDZD(item.appliedPrice)}`;
    const lineTotal = formatDZD(item.quantity * item.appliedPrice);
    
    // Calcul de l'espacement pour aligner le total à droite (largeur par défaut de 32 caractères)
    const spaces = Math.max(0, 32 - qtyPrice.length - lineTotal.length);
    builder.text(`${qtyPrice}${' '.repeat(spaces)}${lineTotal}`).newline();
  });

  builder.separator();

  // Total Brut (en gras et double hauteur)
  builder.align('right').bold(true).doubleHeight(true);
  builder.text(`TOTAL: ${formatDZD(transaction.total)}`).newline();
  builder.bold(false).doubleHeight(false);
  
  builder.newline();
  
  // Paiement en espèces
  builder.align('right');
  builder.text(`Espèces: ${formatDZD(transaction.cashTendered || transaction.total)}`).newline();
  if (transaction.changeDue !== undefined && transaction.changeDue > 0) {
    builder.text(`Rendu: ${formatDZD(transaction.changeDue)}`).newline();
  }

  builder.align('center').newline();
  builder.separator();

  // Message de pied de page personnalisé
  if (settings.customFooterMsg) {
    builder.text(settings.customFooterMsg).newline();
  } else {
    builder.text('Merci de votre visite !').newline();
  }

  builder.newline();

  // Code-barres du numéro de reçu
  builder.barcode(transaction.id.toString().substring(0, 15), 'CODE128');
  
  builder.newline(2);
  builder.feedCut();

  return builder.build();
}

/**
 * Construit une impulsion pour ouvrir le tiroir-caisse sans imprimer de reçu.
 */
export function buildCashDrawerPulse(): Uint8Array {
  const builder = new EscPosBuilder();
  return builder.init().openCashDrawer().build();
}

import { printRawEscpos, openCashDrawer } from '../api/hardware';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Envoie le tampon brut ESC/POS directement à l'imprimante via le spooler Windows (winspool.drv).
 */
export async function printViaWindowsSpooler(printerName: string, buffer: Uint8Array): Promise<boolean> {
  if (isTauri()) {
    try {
      await printRawEscpos(printerName, buffer);
      return true;
    } catch (err) {
      console.error(`[ESC/POS Spooler Error] Failed to print to "${printerName}":`, err);
      return false;
    }
  }
  // Web preview mode: silent simulation
  return true;
}

/**
 * Déclenche l'ouverture physique du tiroir-caisse via impulsion ESC/POS.
 */
export async function openCashDrawerViaSpooler(printerName: string): Promise<boolean> {
  if (isTauri()) {
    try {
      await openCashDrawer(printerName);
      return true;
    } catch (err) {
      console.error(`[Cash Drawer Error] Failed to pulse cash drawer on "${printerName}":`, err);
      return false;
    }
  }
  return true;
}

/**
 * Envoie le tampon à l'imprimante via un port série (ex: COM1, COM2).
 */
export async function printViaSerialPort(portName: string, buffer: Uint8Array): Promise<boolean> {
  return await printViaWindowsSpooler(portName, buffer);
}

import { resolvePrinterForDocument } from './printerRoutingEngine';
import { ProductLabelBuilder, type LabelPrintOptions } from './productLabelBuilder';
import type { Product, PrinterRoutingConfig } from '../types/pos';

/**
 * Pousse directement le reçu de vente vers l'imprimante matérielle sans aucune boîte de dialogue popup.
 */
export async function directPrintReceipt(
  transaction: SaleTransaction,
  settings: ReceiptSettings
): Promise<boolean> {
  const targetPrinter = resolvePrinterForDocument('receipt', settings?.printerRouting);
  const buffer = buildReceiptBuffer(transaction, settings);
  const success = await printViaWindowsSpooler(targetPrinter.printerName, buffer);
  if (settings?.kickCashDrawerOnCash !== false) {
    void openCashDrawerViaSpooler(targetPrinter.printerName);
  }
  return success;
}

/**
 * Pousse directement les étiquettes code-barres vers l'imprimante thermique sans popup browser.
 */
export async function directPrintProductLabels(
  product: Product,
  options: LabelPrintOptions,
  printerRouting?: PrinterRoutingConfig
): Promise<boolean> {
  const targetPrinter = resolvePrinterForDocument('label', printerRouting);
  const buffer = ProductLabelBuilder.build(product, options);
  return await printViaWindowsSpooler(targetPrinter.printerName, buffer);
}

/**
 * Construit un tampon ESC/POS pour un Rapport X (snapshot financier intermédiaire de session de caisse).
 */
export function buildXReportBuffer(session: CashSession, settings: ReceiptSettings): Uint8Array {
  const b = new EscPosBuilder();
  const width = settings?.paperWidth === '58mm' ? 32 : 42;

  b.init()
    .align('center')
    .bold(true)
    .doubleHeight(true)
    .text(settings?.storeName || 'MobiPOS')
    .newline(2)
    .doubleHeight(false)
    .text('*** RAPPORT X (POINT MID-SHIFT) ***')
    .newline()
    .bold(false)
    .text(`Date & Heure : ${new Date().toLocaleString('fr-FR')}`)
    .newline()
    .text(`Session : ${session.id}`)
    .newline()
    .text(`Caissier : ${session.cashierName}`)
    .newline()
    .text(`Ouvert le : ${new Date(session.openedAt).toLocaleString('fr-FR')}`)
    .newline()
    .separator('=', width);

  const padLine = (label: string, value: string): string => {
    const spaceCount = Math.max(1, width - label.length - value.length);
    return `${label}${' '.repeat(spaceCount)}${value}`;
  };

  b.align('left')
    .bold(true)
    .text('SITUATION DU TIROIR-CAISSE')
    .newline()
    .bold(false)
    .text(padLine('Fond Initial (Ouverture) :', formatDZD(session.openingFloat)))
    .newline()
    .text(padLine('Total Ventes Espèces :', `+${formatDZD(session.cashSales || 0)}`))
    .newline()
    .text(padLine('Apports / Dépôts Manuels :', `+${formatDZD(session.manualDeposits || 0)}`))
    .newline()
    .text(padLine('Dépenses / Sorties Caisse :', `-${formatDZD(session.expenses || 0)}`))
    .newline()
    .separator('-', width);

  const theoreticalCash =
    session.expectedCash !== undefined && session.expectedCash !== null
      ? session.expectedCash
      : session.openingFloat + (session.cashSales || 0) + (session.manualDeposits || 0) - (session.expenses || 0);

  b.bold(true)
    .doubleHeight(true)
    .text(padLine('ESPECES THEORIQUES :', formatDZD(theoreticalCash)))
    .newline()
    .doubleHeight(false)
    .separator('=', width);

  b.bold(true)
    .text('ACTIVITE COMMERCIALE')
    .newline()
    .bold(false)
    .text(padLine('Nombre de Ventes :', `${session.totalSalesCount || 0} transaction(s)`))
    .newline()
    .text(padLine('Chiffre d\'Affaires Total :', formatDZD(session.totalSalesRevenue || 0)))
    .newline()
    .separator('-', width)
    .align('center')
    .text('Document Intermédiaire Non Clôturant')
    .newline()
    .text('La caisse reste active')
    .newline(2)
    .feedCut();

  return b.build();
}

/**
 * Pousse directement le Rapport X vers l'imprimante thermique sans popup.
 */
export async function directPrintXReport(
  session: CashSession,
  settings: ReceiptSettings
): Promise<boolean> {
  const targetPrinter = resolvePrinterForDocument('receipt', settings?.printerRouting);
  const buffer = buildXReportBuffer(session, settings);
  return await printViaWindowsSpooler(targetPrinter.printerName, buffer);
}


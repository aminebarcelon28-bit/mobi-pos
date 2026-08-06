import type { SaleTransaction, ReceiptSettings } from '../types/pos';
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
   * Imprime un code-barres avec les commandes GS k.
   */
  barcode(data: string, type: 'CODE128' | 'EAN13' = 'CODE128'): this {
    if (type === 'CODE128') {
      this.buffer.push(GS, 0x6B, 0x49, data.length);
      for (let i = 0; i < data.length; i++) {
        this.buffer.push(data.charCodeAt(i));
      }
    } else {
      this.buffer.push(GS, 0x6B, 0x43, data.length);
      for (let i = 0; i < data.length; i++) {
        this.buffer.push(data.charCodeAt(i));
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
   * Avance le papier et effectue une coupe partielle.
   */
  feedCut(): this {
    this.buffer.push(GS, 0x56, 0x41, 0x03);
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

/**
 * Envoie le tampon à l'imprimante via le spooler Windows.
 * Note: À relier à Tauri IPC invoke quand le backend sera prêt.
 */
export async function printViaWindowsSpooler(printerName: string, buffer: Uint8Array): Promise<boolean> {
  console.log(`[STUB - Tauri IPC] Impression via Windows Spooler sur l'imprimante "${printerName}" avec ${buffer.length} octets.`);
  return true;
}

/**
 * Envoie le tampon à l'imprimante via un port série (ex: COM1, COM2).
 * Note: À relier à Tauri IPC invoke quand le backend sera prêt.
 */
export async function printViaSerialPort(portName: string, buffer: Uint8Array): Promise<boolean> {
  console.log(`[STUB - Tauri IPC] Impression via Port Série sur "${portName}" avec ${buffer.length} octets.`);
  return true;
}

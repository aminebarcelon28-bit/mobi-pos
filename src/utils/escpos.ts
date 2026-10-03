import type { SaleTransaction, ReceiptSettings, CashSession, StagedTradeIn, TradeInItem } from '../types/pos';
import { formatDZD } from '../types/pos';
import { RECEIPT_BARCODE } from '../constants';
import { fiscalIdentifierLine, tvaSplitFromTotal } from './receiptMath';
import {
  STORE_RETURN_POLICY,
  TRADE_IN_LEGAL_STATEMENT,
  buildReceiptViewModel,
} from './receiptViewModel';

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

/** Fold a long sentence onto printer-width lines (word boundaries). */
function foldThermal(text: string, width: number): string[] {
  const words = (text || '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + (cur ? ' ' : '') + w).length > width) {
      if (cur) lines.push(cur);
      cur = w.length > width ? w.slice(0, width) : w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [''];
}

/**
 * Construit un tampon complet pour l'impression d'un reçu thermique.
 *
 * UNIFIED PRINT TARGET: every section mirrors `ReceiptPaper` through the
 * shared `buildReceiptViewModel` (nature header, session telemetry, paired
 * ledger rows, multi-tender breakdown, conditional trade-in block, policy
 * footer) so the hardware ticket can never drift from the on-screen paper.
 * The optional `tradeIn` record (looked up by tradeInId at the call site)
 * feeds the device detail lines; without it the deduction still prints from
 * the persisted tender/deduction legs.
 */
export function buildReceiptBuffer(
  transaction: SaleTransaction,
  settings: ReceiptSettings,
  tradeIn?: TradeInItem | StagedTradeIn | null
): Uint8Array {
  const builder = new EscPosBuilder();
  const vm = buildReceiptViewModel(transaction, settings, { tradeIn: tradeIn ?? null });
  // 80mm = 42 colonnes (font A), 58mm = 32. Every money row stays ONE paired
  // line: label left, value right — never two independent columns.
  const cols = settings?.paperWidth === '58mm' ? 32 : 42;
  const pair = (label: string, value: string): string => {
    const v = value || '';
    const maxLabel = Math.max(0, cols - v.length - 1);
    const l = label.length > maxLabel ? label.slice(0, maxLabel) : label;
    return `${l}${' '.repeat(Math.max(1, cols - l.length - v.length))}${v}`;
  };

  builder.init();

  // En-tête du magasin
  builder.align('center').bold(true);
  if (vm.store.name) builder.text(vm.store.name).newline();

  builder.bold(false);
  if (vm.store.tagline) builder.text(vm.store.tagline).newline();
  if (vm.store.address) builder.text(vm.store.address).newline();
  if (vm.store.phone) builder.text(`Tél: ${vm.store.phone}`).newline();
  // Official fiscal block (RC/NIF/NIS/ART, legacy taxNumber fallback).
  const fiscalLine = fiscalIdentifierLine(settings);
  if (fiscalLine) builder.text(fiscalLine).newline();

  // Nature de la transaction (dérivée du payload, comme le papier écran).
  builder.bold(true);
  builder.text(`*** ${vm.natureLabel} ***`).newline();
  builder.bold(false);

  builder.align('left');
  builder.separator('-', cols);

  // Télémétrie de session : lignes appariées (jamais de colonnes découplées).
  builder.text(pair('Ticket:', vm.ticketId)).newline();
  builder.text(pair('Date:', vm.dateTime)).newline();
  builder.text(pair('Caisse:', vm.registerId)).newline();
  builder.text(pair('Vendeur:', vm.cashierName)).newline();

  // Info client (optionnel)
  if (transaction.customer?.name) {
    builder.text(pair('Client:', transaction.customer.name)).newline();
  }

  builder.separator('-', cols);

  // Liste des articles (warranted lines get a (*) marker, legend below).
  let warrantyMonthsMax = 0;
  for (const line of vm.items) {
    const wMonths = line.warrantyMonths || 0;
    if (wMonths > 0) warrantyMonthsMax = Math.max(warrantyMonthsMax, wMonths);
    builder.text(line.name + (wMonths > 0 ? ' (*)' : '')).newline();
    const qtyPrice = `${line.quantity} x ${formatDZD(line.unitPrice)}`;
    const lineTotal = formatDZD(line.total);
    builder.text(pair(qtyPrice, lineTotal)).newline();
    if (line.discount > 0) {
      builder.text(pair('  Remise:', `-${formatDZD(line.discount)}`)).newline();
    }
    if (line.imei) {
      builder.text(`  IMEI: ${line.imei}`).newline();
    }
    if (wMonths > 0) {
      builder.text(`  Garantie ${wMonths} mois incluse (*)`).newline();
    }
  }

  builder.separator('-', cols);

  // Bloc reprise (conditionnel, comme le papier) : le crédit a déjà été
  // déduit du net ; on l'affiche pour réconcilier le ticket.
  if (vm.tradeIn) {
    builder.bold(true);
    builder.text('[APPAREIL REPRIS / TRADE-IN]').newline();
    builder.bold(false);
    builder.text(pair('Catégorie:', vm.tradeIn.category)).newline();
    builder.text(pair('Modèle:', vm.tradeIn.model)).newline();
    if (vm.tradeIn.imei) {
      builder.text(pair('IMEI:', vm.tradeIn.imei)).newline();
    }
    if (vm.tradeIn.grade) {
      builder.text(pair('État:', vm.tradeIn.grade)).newline();
    }
    builder.text(pair('Crédit Reprise:', `-${formatDZD(vm.tradeIn.valuation)}`)).newline();
    for (const ln of foldThermal(TRADE_IN_LEGAL_STATEMENT, cols)) {
      builder.text(ln).newline();
    }
    builder.separator('-', cols);
  }

  // B-028: print gross REMISE/credit/TVA lines BEFORE TOTAL so the hardware
  // receipt reconciles with the software ticket (gross − discount = net).
  builder.align('left').bold(false);
  builder.text(pair('SOUS-TOTAL BRUT:', formatDZD(vm.grossSubtotal))).newline();
  if (vm.discounts > 0) {
    builder.text(pair('REMISE ACCORDÉE:', `-${formatDZD(vm.discounts)}`)).newline();
  }
  if (vm.tradeInCredit > 0) {
    builder.text(pair('CRÉDIT REPRISE DÉDUIT:', `-${formatDZD(vm.tradeInCredit)}`)).newline();
  }
  if (vm.voucherCredit > 0) {
    const voucherLabel = vm.voucherCode ? `BON ÉCHANGE (${vm.voucherCode}):` : 'BON ÉCHANGE DÉDUIT:';
    builder.text(pair(voucherLabel, `-${formatDZD(vm.voucherCredit)}`)).newline();
  }
  if (vm.avoirCredit > 0) {
    builder.text(pair('AVOIR CLIENT DÉDUIT:', `-${formatDZD(vm.avoirCredit)}`)).newline();
  }
  const txTax = (transaction as { tax?: number }).tax;
  if (typeof txTax === 'number' && txTax > 0) {
    builder.text(pair('TVA:', `+${formatDZD(txTax)}`)).newline();
  }
  // Explicit TVA breakdown table when a VAT rate is configured.
  const tva = tvaSplitFromTotal(vm.netDue, settings.vatRate);
  if (tva) {
    builder.text(pair('HT:', formatDZD(tva.ht))).newline();
    builder.text(pair(`TVA ${tva.rate}%:`, `+${formatDZD(tva.tva)}`)).newline();
    builder.text(pair('TTC:', formatDZD(tva.ttc))).newline();
  }

  // Total Net (en gras et double hauteur)
  builder.align('right').bold(true).doubleHeight(true);
  builder.text(`${vm.isRefund ? 'TOTAL AVOIR:' : 'TOTAL NET A PAYER:'} ${formatDZD(vm.netDue)}`).newline();
  builder.bold(false).doubleHeight(false);

  builder.newline();

  // Règlement multi-tender (chaque jambe appariée sur une seule ligne).
  builder.align('left');
  builder.text(vm.isRefund ? 'Modes de Remboursement:' : 'Modes de Règlement:').newline();
  for (const tender of vm.tenders) {
    builder.text(pair(`${tender.label}:`, formatDZD(tender.amount))).newline();
  }
  if (!vm.isRefund) {
    builder.text(pair('Rendu Monnaie:', formatDZD(vm.changeDue))).newline();
  }
  // Soulte boutique (shop owed the difference) — traçabilité du versement.
  if (transaction.tradeInSoulte && transaction.tradeInSoulte.amount > 0) {
    builder.text(
      pair(
        transaction.tradeInSoulte.method === 'cash' ? 'Soulte versée (espèces):' : 'Soulte créditée (avoir):',
        formatDZD(transaction.tradeInSoulte.amount)
      )
    ).newline();
  }

  // Customer account reminder (single-line summaries, no extra modal).
  if ((transaction.customer?.storeCredit || 0) > 0) {
    builder.text(pair('Avoir client disponible:', formatDZD(transaction.customer?.storeCredit || 0))).newline();
  }
  if ((transaction.customer?.currentDebt || 0) > 0) {
    builder.text(pair('Dette client restante:', formatDZD(transaction.customer?.currentDebt || 0))).newline();
  }
  if (warrantyMonthsMax > 0) {
    builder.text(`Garantie: ${warrantyMonthsMax} mois sur articles signalés (*)`).newline();
  }

  builder.align('center').newline();
  builder.separator('-', cols);

  // Politique de retour (identique au papier) + pied de page personnalisé.
  for (const ln of foldThermal(STORE_RETURN_POLICY, cols)) {
    builder.text(ln).newline();
  }
  // Message de pied de page personnalisé
  if (settings.customFooterMsg) {
    for (const ln of foldThermal(settings.customFooterMsg, cols)) {
      builder.text(ln).newline();
    }
  } else {
    builder.text('Merci de votre visite !').newline();
  }

  builder.newline();

  // Code-barres du numéro de reçu : l'identifiant opaque COMPLET est encodé
  // (CODE128 le supporte ; le scan-to-lookup doit être exact, plus de
  // troncature à 15 caractères qui rendait les reçus indiscanables en
  // recherche). Seuls les ids au-delà de RECEIPT_BARCODE.MAX_LENGTH sont
  // compactés en conservant tête + queue pour préserver l'unicité.
  const fullBarcodeValue = transaction.id.toString();
  const receiptBarcodeValue =
    fullBarcodeValue.length > RECEIPT_BARCODE.MAX_LENGTH
      ? `${fullBarcodeValue.slice(0, RECEIPT_BARCODE.MAX_LENGTH - 16)}${fullBarcodeValue.slice(-15)}`
      : fullBarcodeValue;
  builder.barcode(receiptBarcodeValue, 'CODE128');
  
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

function isMobileWebView(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /android|iphone|ipad|ipod/i.test(ua);
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
 * Sur mobile (pas de spooler USB) : imprimante Wi-Fi/Bluetooth configurée,
 * sinon ticket texte via la feuille d'impression Android.
 */
export async function directPrintReceipt(
  transaction: SaleTransaction,
  settings: ReceiptSettings,
  tradeIn?: TradeInItem | StagedTradeIn | null
): Promise<boolean> {
  if (isMobileWebView()) {
    try {
      const { printBytesViaMobilePrinter } = await import('./mobilePrinter');
      const direct = await printBytesViaMobilePrinter(buildReceiptBuffer(transaction, settings, tradeIn));
      if (direct.sent) return true;
      if (direct.reason !== 'disabled') {
        console.warn('[Mobile Receipt] Network printer failed, falling back to sheet:', direct.reason);
      }
      const { receiptText } = await import('./mobileDocPrint');
      const { openNativePrint } = await import('./phoneUtils');
      return await openNativePrint(
        `Ticket ${transaction.receiptNumber}`,
        receiptText(transaction, settings)
      );
    } catch (err) {
      console.error('[Mobile Receipt Print Error]', err);
      return false;
    }
  }
  const targetPrinter = resolvePrinterForDocument('receipt', settings?.printerRouting);
  const buffer = buildReceiptBuffer(transaction, settings, tradeIn);
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
    .text(`Date & Heure : ${new Date().toLocaleString('fr-DZ')}`)
    .newline()
    .text(`Session : ${session.id}`)
    .newline()
    .text(`Caissier : ${session.cashierName}`)
    .newline()
    .text(`Ouvert le : ${new Date(session.openedAt).toLocaleString('fr-DZ')}`)
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
    .newline();
  // SAV atelier splits (informational — cash already inside Total Ventes).
  const xSavDeposits = Math.max(0, Math.round(session.savDeposits || 0));
  const xSavSettled = Math.max(0, Math.round(session.savSettled || 0));
  if (xSavDeposits > 0) {
    b.text(padLine('Acomptes SAV perçus :', `+${formatDZD(xSavDeposits)}`)).newline();
  }
  if (xSavSettled > 0) {
    b.text(padLine('Soldes SAV encaissés :', `+${formatDZD(xSavSettled)}`)).newline();
  }
  if (xSavDeposits + xSavSettled > 0) {
    b.bold(true)
      .text(padLine('Total Encaissé Atelier :', `+${formatDZD(xSavDeposits + xSavSettled)}`))
      .newline()
      .bold(false);
  }
  b.separator('-', width);

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
 * Sur mobile (pas de spooler USB) : imprimante Wi-Fi/Bluetooth configurée,
 * sinon texte via la feuille d'impression Android.
 */
export async function directPrintXReport(
  session: CashSession,
  settings: ReceiptSettings
): Promise<boolean> {
  if (isMobileWebView()) {
    try {
      const { printBytesViaMobilePrinter } = await import('./mobilePrinter');
      const direct = await printBytesViaMobilePrinter(buildXReportBuffer(session, settings));
      if (direct.sent) return true;
      if (direct.reason !== 'disabled') {
        console.warn('[Mobile X-Report] Network printer failed, falling back to sheet:', direct.reason);
      }
      const { xReportFromSession } = await import('./mobileDocPrint');
      const { openNativePrint } = await import('./phoneUtils');
      return await openNativePrint(
        `Rapport X ${session.id}`,
        xReportFromSession(
          session,
          {
            cashSales: session.cashSales ?? 0,
            refunds: 0,
            deposits: session.manualDeposits ?? 0,
            expenses: session.expenses ?? 0,
          },
          settings?.storeName
        )
      );
    } catch (err) {
      console.error('[Mobile X-Report Print Error]', err);
      return false;
    }
  }
  const targetPrinter = resolvePrinterForDocument('receipt', settings?.printerRouting);
  const buffer = buildXReportBuffer(session, settings);
  return await printViaWindowsSpooler(targetPrinter.printerName, buffer);
}


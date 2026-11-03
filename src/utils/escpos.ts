import type { SaleTransaction, ReceiptSettings, CashSession, StagedTradeIn, TradeInItem } from '../types/pos';
import { formatDZD } from '../types/pos';
import { RECEIPT_BARCODE } from '../constants';
import { fiscalIdentifierLine } from './receiptMath';
import {
  STORE_RETURN_POLICY,
  TRADE_IN_LEGAL_STATEMENT,
  buildReceiptViewModel,
  formatReceiptDateTime,
} from './receiptViewModel';
import type { ZReportSnapshot } from '../components/receipt/ZReportPaper';
import { ARABIC_CODE_PAGE, containsArabic, encodeCp864, logicalRuns, visualRuns } from './arabicText';
import { PAPER_DOTS, canvasLineRasterizer, type LineRasterizer } from './receiptRaster';

const ESC = 0x1B;
const GS = 0x1D;
const LF = 0x0A;

/**
 * Classe utilitaire pour construire des commandes ESC/POS pour imprimantes thermiques.
 */
export interface EscPosBuilderOptions {
  /** Epson code-page number for the CP864 fallback (vendor tables differ). */
  arabicCodePage?: number;
  /** Bit-image renderer for Arabic lines; the app injects the canvas one. */
  rasterizer?: LineRasterizer | null;
  /** Printable width in dots (58 mm = 384, 80 mm = 576). */
  maxWidthDots?: number;
}

export class EscPosBuilder {
  private buffer: number[];
  private readonly arabicCodePage: number;
  private readonly rasterizer: LineRasterizer | null;
  private readonly maxWidthDots: number;
  /** True once an Arabic line was sent as a raster image (diagnostics/tests). */
  arabicRasterLines = 0;
  /** True once the CP864 fallback was used instead of a raster image. */
  arabicFallbackLines = 0;

  constructor(options: EscPosBuilderOptions = {}) {
    this.buffer = [];
    this.arabicCodePage = options.arabicCodePage ?? ARABIC_CODE_PAGE;
    this.rasterizer = options.rasterizer === undefined ? canvasLineRasterizer : options.rasterizer;
    this.maxWidthDots = options.maxWidthDots ?? PAPER_DOTS['80mm'];
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
   *
   * A receipt title is OPERATOR DATA, not printer commands. The old
   * `charCodeAt(i) & 0xFF` truncated every UTF-16 code unit to one byte, so an
   * emoji whose low surrogate byte happened to be 0x1B injected a raw ESC into
   * the ticket stream and "ESC @" reset the printer mid-receipt (I18-07,
   * measured). Control bytes can only enter the stream through the command
   * methods above; here they are dropped, characters above Latin-1 are
   * degraded to `?` (no code page is negotiated yet: RCP-01), and CR/LF in
   * data become spaces.
   */
  text(content: string): this {
    const flat = String(content ?? '');
    if (!containsArabic(flat)) {
      this.pushLatin(flat);
      return this;
    }
    // Arabic runs (RCP-01/12/21). The printer has no shaping engine and no
    // single-byte page covers the Arabic contextual forms, so each Arabic run is
    // rendered to dots by the platform (which shapes and bidi-orders it) and
    // printed with GS v 0; the Latin label around it stays text. Without a
    // rasterizer (Node/tests/SSR) the builder degrades to CP864 with the forms
    // the page does carry, and says so through `arabicFallbackLines` — a silent
    // degrade would look like working Arabic.
    if (this.rasterizer) {
      // Only the Arabic runs become dots: the surrounding Latin label stays
      // real text (sharper, and the receipt keeps a searchable text lane).
      let rastered = 0;
      for (const run of logicalRuns(flat)) {
        if (!run.rtl) {
          this.pushLatin(run.text);
          continue;
        }
        const raster = this.rasterizer(run.text, this.maxWidthDots);
        if (!raster) {
          rastered = -1;
          break;
        }
        this.bitImage(raster.widthBytes, raster.heightDots, raster.data);
        rastered += 1;
      }
      if (rastered > 0) {
        this.arabicRasterLines += rastered;
        return this;
      }
    }
    this.arabicFallbackLines += 1;
    for (const run of visualRuns(flat)) {
      if (!run.rtl) {
        this.pushLatin(run.text);
        continue;
      }
      this.buffer.push(ESC, 0x74, this.arabicCodePage);
      for (const b of encodeCp864(run.text)) this.buffer.push(b);
      this.buffer.push(ESC, 0x74, 0x00);
    }
    return this;
  }

  /** GS v 0 m xL xH yL yH data — raster bit image, MSB = leftmost dot. */
  bitImage(widthBytes: number, heightDots: number, data: Uint8Array): this {
    // Geometry is a byte/dot count, never money. It must already be a positive
    // integer: rounding here would silently accept a malformed image (and would
    // add a second money-shaped token to a file the boundary gate counts).
    if (!Number.isInteger(widthBytes) || widthBytes < 1 || widthBytes > 8191) {
      throw new Error(`bitImage: widthBytes ${widthBytes} outside 1..8191`);
    }
    if (!Number.isInteger(heightDots) || heightDots < 1 || heightDots > 1662) {
      throw new Error(`bitImage: heightDots ${heightDots} outside 1..1662`);
    }
    const w = widthBytes;
    const h = heightDots;
    const expected = w * h;
    if (data.length !== expected) {
      throw new Error(`bitImage: payload ${data.length} != ${w}x${h}`);
    }
    this.buffer.push(GS, 0x76, 0x30, 0x00, w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff);
    for (let i = 0; i < expected; i += 1) this.buffer.push(data[i]);
    return this;
  }

  /**
   * Latin-1 text path (unchanged bytes). Data can never inject a command: CR,
   * LF and TAB become spaces, control bytes are dropped, and characters above
   * Latin-1 degrade to '?' (they belong in the Arabic lane above).
   */
  private pushLatin(content: string): void {
    for (const ch of content) {
      const cp = ch.codePointAt(0) as number;
      if (cp === 0x0a || cp === 0x0d || cp === 0x09) {
        this.buffer.push(0x20);
        continue;
      }
      if (cp < 0x20 || cp === 0x7f) continue; // never emit a control byte from data
      // RCP-13: Intl money formatting uses U+202F/U+00A0/U+2009 as the thousands
      // separator; the printer has no glyph for them and printed "1?700 DA".
      if (cp === 0x00a0 || cp === 0x202f || cp === 0x2009 || cp === 0x2007) {
        this.buffer.push(0x20);
        continue;
      }
      if (cp < 0x100) {
        this.buffer.push(cp);
        continue;
      }
      this.buffer.push(0x3f); // '?'
    }
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
  tradeIn?: TradeInItem | StagedTradeIn | null,
  shiftOpener?: string | CashSession | null,
  /** Injection seam: tests pass a deterministic rasterizer; the app passes none. */
  builderOptions: EscPosBuilderOptions = {}
): Uint8Array {
  const builder = new EscPosBuilder({
    maxWidthDots: settings?.paperWidth === '58mm' ? PAPER_DOTS['58mm'] : PAPER_DOTS['80mm'],
    ...builderOptions,
  });
  const vm = buildReceiptViewModel(transaction, settings, {
    tradeIn: tradeIn ?? null,
    shiftOpener: shiftOpener ?? null,
  });
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
  if (vm.store.email) builder.text(`Email: ${vm.store.email}`).newline();
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
    for (const nameLine of foldThermal(line.name + (wMonths > 0 ? ' (*)' : ''), cols)) {
      builder.text(nameLine).newline();
    }
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
  // Phase 1b-i: no TVA/HT/TTC block. There is no rate to print, no `tax` field
  // on the transaction and no split to compute — the ticket states the net.

  // Total Net (en gras et double hauteur)
builder.align('right').bold(true).doubleHeight(true);
{
  const totalLabel = vm.isRefund ? 'TOTAL AVOIR:' : 'TOTAL NET A PAYER:';
  const totalValue = formatDZD(vm.netDue);
  if (totalLabel.length + 1 + totalValue.length > cols) {
    builder.text(totalLabel).newline();
    builder.text(totalValue).newline();
  } else {
    builder.text(`${totalLabel} ${totalValue}`).newline();
  }
}
  builder.bold(false).doubleHeight(false);

  builder.newline();

  // Règlement multi-tender (chaque jambe appariée sur une seule ligne).
  builder.align('left');
  builder.text(vm.isRefund ? 'Modes de Remboursement:' : 'Modes de Règlement:').newline();
  for (const tender of vm.tenders) {
    builder.text(pair(`${tender.label}:`, formatDZD(tender.amount))).newline();
  }
  if (!vm.isRefund) {
    builder.text(pair('TOTAL PERÇU:', formatDZD(vm.tenderedTotal))).newline();
    builder.text(pair('MONNAIE RENDUE:', formatDZD(vm.changeDue))).newline();
  }
  for (const ln of foldThermal(
  `Articles remis: ${vm.itemCount} - Appareils repris: ${vm.tradeInCount}`,
  cols
)) {
  builder.text(ln).newline();
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

  // Footer policy: custom message wins (primary block), otherwise the
  // default return policy — identical to the paper, never both, never blank.
  for (const ln of foldThermal(
    vm.store.footerMessage ? vm.store.footerMessage : STORE_RETURN_POLICY,
    cols
  )) {
    builder.text(ln).newline();
  }
  for (const ln of foldThermal('Merci de votre visite et à bientôt !', cols)) {
  builder.text(ln).newline();
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
  tradeIn?: TradeInItem | StagedTradeIn | null,
  shiftOpener?: string | CashSession | null
): Promise<boolean> {
  if (isMobileWebView()) {
    try {
      const { printBytesViaMobilePrinter } = await import('./mobilePrinter');
      const direct = await printBytesViaMobilePrinter(
        buildReceiptBuffer(transaction, settings, tradeIn, shiftOpener)
      );
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
  const buffer = buildReceiptBuffer(transaction, settings, tradeIn, shiftOpener);
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

/**
 * ESC/POS twin of `ZReportPaper` — same frozen snapshot, same paired-row
 * discipline (one `label/value` line each, never decoupled align blocks), so
 * the hardware Z can never drift from the HTML close ticket. 42 cols on
 * 80mm, 32 on 58mm.
 */
export function buildZReportBuffer(s: ZReportSnapshot, settings: ReceiptSettings): Uint8Array {
  const b = new EscPosBuilder();
  const cols = settings?.paperWidth === '58mm' ? 32 : 42;
  const pair = (label: string, value: string): string => {
    const v = value || '';
    const maxLabel = Math.max(0, cols - v.length - 1);
    const l = label.length > maxLabel ? label.slice(0, maxLabel) : label;
    return `${l}${' '.repeat(Math.max(1, cols - l.length - v.length))}${v}`;
  };
  const money = (label: string, amount: number, sign = ''): void => {
    b.text(pair(label, `${sign}${formatDZD(amount)}`)).newline();
  };

  b.init()
    .align('center')
    .bold(true)
    .text(settings?.storeName || s.storeName || 'MOBI-POS')
    .newline()
    .bold(false)
    .text('*** RAPPORT Z DE CLOTURE ***')
    .newline()
    .text(`Z-Ticket: ${s.zNumber}`)
    .newline()
    .align('left')
    .separator('-', cols);
  b.text(pair('Ouvert le:', formatReceiptDateTime(s.openedAtISO))).newline();
  b.text(pair('Cloture le:', formatReceiptDateTime(s.closedAtISO))).newline();
  b.text(pair('Caisse:', s.registerLabel)).newline();
  b.text(pair('Responsable Caisse:', s.responsibleName)).newline();
  b.separator('-', cols);

  b.bold(true).text("CHIFFRE D'AFFAIRES:").newline().bold(false);
  money('Ventes Especes:', s.cashSales);
  if (s.cardSales > 0) money('Ventes TPE / Carte:', s.cardSales);
  if (s.creditSales > 0) money('Ventes a Credit:', s.creditSales);
  if (s.repriseTake > 0) money('Reprises (Trade-in):', s.repriseTake, '-');
  b.bold(true);
  money('TOTAL VENTES NETTES:', s.netSales);
  b.bold(false).separator('-', cols);

  b.bold(true).text('MOUVEMENTS DE CAISSE (ESPECES):').newline().bold(false);
  money('Fond de caisse initial:', s.openingFloat);
  money('Encaissements especes:', s.cashSales, '+');
  if (s.debtSettlements > 0) money('Reglements dettes recus:', s.debtSettlements, '+');
  if (s.savDeposits > 0) money('Acomptes SAV:', s.savDeposits, '+');
  if (s.savSettled > 0) money('Soldes SAV encaisses:', s.savSettled, '+');
  if (s.manualIn > 0) money('Apports manuels:', s.manualIn, '+');
  if (s.refunds > 0) money('Remboursements client:', s.refunds, '-');
  if (s.expenses > 0) money('Depenses de caisse:', s.expenses, '-');
  if (s.tradeInCashOut > 0) money('Rachats occasions:', s.tradeInCashOut, '-');
  if (s.exchangeOut > 0) money('Retours echanges:', s.exchangeOut, '-');
  if (s.soulteOut > 0) money('Soulte reprise decaissee:', s.soulteOut, '-');
  if (s.manualOut > 0) money('Depenses manuelles:', s.manualOut, '-');
  if (s.drops > 0) money('Depots coffre:', s.drops, '-');
  if (s.payouts > 0) money('Decaissements:', s.payouts, '-');
  b.separator('-', cols);

  b.bold(true).doubleHeight(true);
  money('ESPECES THEORIQUES:', s.expectedCash);
  if (s.blindCountPerformed === false) {
    // An un-counted drawer has no counted amount and no variance. Printing 0 and
    // `-<expected>` here would put a fabricated full-drawer shortage on a signed
    // accounting document — the hardware twin must say the same thing the paper
    // twin says.
    b.text(pair('COMPTE EN CAISSE:', '(NON EFFECTUE)')).newline();
    b.doubleHeight(false);
    b.bold(true);
    b.text(pair('ECART:', '(NON EFFECTUE)')).newline();
  } else {
    money('COMPTE EN CAISSE:', s.countedCash);
    b.doubleHeight(false);
    b.bold(true);
    b.text(pair('ECART:', `${s.variance >= 0 ? '+' : ''}${formatDZD(s.variance)}`)).newline();
  }
  b.bold(false).separator('=', cols);

  for (const drop of s.dropsList || []) {
    b.text(pair(`Coffre: ${drop.reason}`.slice(0, cols), formatDZD(drop.amount))).newline();
  }

  if (s.closingDenominations) {
    b.bold(true).text('BILLETAGE DE CLOTURE (DZD):').newline().bold(false);
    const cd = s.closingDenominations;
    if (cd.qty2000) money(`2 000 DA x ${cd.qty2000}`, cd.qty2000 * 2000);
    if (cd.qty1000) money(`1 000 DA x ${cd.qty1000}`, cd.qty1000 * 1000);
    if (cd.qty500) money(`500 DA x ${cd.qty500}`, cd.qty500 * 500);
    if (cd.qty200) money(`200 DA x ${cd.qty200}`, cd.qty200 * 200);
    if (cd.qty100) money(`100 DA x ${cd.qty100}`, cd.qty100 * 100);
    if (cd.qty50) money(`50 DA x ${cd.qty50}`, cd.qty50 * 50);
    if (cd.qty20) money(`20 DA x ${cd.qty20}`, cd.qty20 * 20);
    if (cd.qty10) money(`10 DA x ${cd.qty10}`, cd.qty10 * 10);
    if (cd.qty5) money(`5 DA x ${cd.qty5}`, cd.qty5 * 5);
    if (cd.coins) money('Pieces Div.', cd.coins);
    b.separator('-', cols);
  }

  b.align('center').newline();
  b.text('Signature Caissier: ____________________').newline();
  b.text('Signature Gerant: ____________________').newline();
  b.newline();
  // CODE128 is ASCII-safe; the Z number is the scan key (may contain dashes).
  try {
    b.barcode(s.zNumber, 'CODE128');
  } catch {
    b.text(`*${s.zNumber}*`).newline();
  }
  b.newline(2).feedCut();
  return b.build();
}


/**
 * Professional Trade-In Buyback Voucher & Legal Ownership Transfer Builder
 * Author: Principal Systems Architect
 */
import type { TradeInItem, ReceiptSettings, SaleTransaction } from '../types/pos';
import { faitALine, formatDZD } from '../types/pos';
import { EscPosBuilder } from './escpos';
import { grossFromTransaction } from './receiptMath';
import { STORE_RETURN_POLICY, formatReceiptDateTime } from './receiptViewModel';

/**
 * Sequential police-registry folio (Livre de Police) derived deterministically
 * from the trade record: `[ID-YEAR-SEQ]` — stable per trade, printable on
 * every copy for stolen-goods inspections.
 */
export function policeRegistryFolio(trade: Pick<TradeInItem, 'id' | 'createdAt'>): string {
  const clean = (trade.id || '').replace(/[^A-Z0-9]/gi, '').toUpperCase() || '000000';
  const year = new Date(trade.createdAt || Date.now()).getFullYear();
  const idPart = clean.slice(-6).padStart(6, '0');
  const seqPart = clean.slice(0, 4).padStart(4, '0');
  return `${idPart}-${year}-${seqPart}`;
}

/** Formal seller sworn statement (registry wording, shared thermal ↔ A4). */
export const SELLER_SWORN_STATEMENT =
  "Je soussigné(e) certifie sur l'honneur être le légitime propriétaire de cet appareil, " +
  "qu'il est libre de tout engagement ou gage, et qu'il ne provient d'aucun vol ou acte illicite.";

export class TradeInVoucherBuilder {
  public static buildLegalBuybackCertificate(
    tradeIn: TradeInItem,
    settings: ReceiptSettings,
    seller?: string | null
  ): Uint8Array {
    const builder = new EscPosBuilder();
    const is80mm = settings.paperWidth !== '58mm';
    const separator = is80mm
      ? '------------------------------------------------'
      : '--------------------------------';

    builder
      .init()
      .align('center')
      .bold(true)
      .text(settings.storeName || 'MOBI ACCESSORIES')
      .newline()
      .bold(false)
      .text(settings.address || 'Boulevard Mohamed V, Alger Centre')
      .newline()
      .text(`Tél : ${settings.phone || '0550 00 00 00'}`)
      .newline()
      .text(separator)
      .newline()
      .bold(true)
      .text('CONTRAT DE CESSION & REPRISE DE TÉLÉPHONE')
      .newline()
      .bold(false)
      .text(`Réf Reprise : ${tradeIn.id}`)
      .newline()
      .text(`Date : ${new Date().toLocaleString('fr-DZ')}`)
      .newline()
      .bold(true)
      .text(`Folio Registre Police N°: ${policeRegistryFolio(tradeIn)}`)
      .newline()
      .bold(false);
    if ((seller || '').trim()) {
      builder.text(`Vendeur (Caisse) : ${seller!.trim()}`).newline();
    }
    builder
      .text(separator)
      .newline()
      .align('left')
      .bold(true)
      .text('IDENTITÉ DU CÉDANT (CLIENT) :')
      .newline()
      .bold(false)
      .text(`Nom / Prénom : ${tradeIn.customerName}`)
      .newline()
      .text(`N° Téléphone : ${tradeIn.customerPhone || 'Non spécifié'}`)
      .newline()
      .bold(true)
      .text(`N° Pièce d'Identité (CNI/Permis/Passeport) : ${tradeIn.nationalIdNumber || 'Non renseigné — À COMPLÉTER'}`)
      .newline()
      .bold(false)

    builder
      .text(separator)
      .newline()
      .bold(true)
      .text('APPAREIL CÉDÉ :')
      .newline()
      .bold(false)
      .text(`Modèle : ${tradeIn.deviceModel}`)
      .newline()
      .text(`N° IMEI : ${tradeIn.imei}`)
      .newline()
      .text(`État Esthétique : ${tradeIn.conditionGrade || 'Bon état'}`)
      .newline();

    if (tradeIn.inspectionChecklist) {
      builder
        .text(`Santé Batterie : ${tradeIn.inspectionChecklist.batteryHealthPercent}%`)
        .newline();
    }

    builder
      .text(separator)
      .newline()
      .align('right')
      .bold(true)
      .text(`VALEUR DE RACHAT (REPRISE) : ${tradeIn.buybackValue.toLocaleString('fr-DZ')} DA`)
      .newline()
      .bold(false)
      .text(separator)
      .newline()
      .align('left')
      .text('DÉCLARATION SUR L\'HONNEUR :')
      .newline()
      .text(SELLER_SWORN_STATEMENT)
      .newline()
      .newline(2)
      .align('center')
      .text(faitALine(settings))
      .newline()
      .newline()
      .text('Signature du Client :                  Signature Magasin :')
      .newline()
      .newline(2)
      .text('....................                  ....................')
      .newline()
      .newline(2)
      .cut(false);

    return builder.build();
  }

  /**
   * Net exchange ticket (Phase 5 revival): items + gross, trade-in device
   * summary with IMEI, deduction, and the settled amount. Soulte variant
   * prints the shop-owed payout + method instead of an amount due.
   */
  public static buildNetTradeInSaleReceipt(
    transaction: SaleTransaction,
    tradeIn: TradeInItem,
    settings: ReceiptSettings,
    soulte?: { amount: number; method: 'cash' | 'wallet' } | null,
    seller?: string | null
  ): Uint8Array {
    const builder = new EscPosBuilder();
    // 42-col professional standard (32 on 58mm). Every money row is ONE
    // paired line — the old build printed labels (align:left) and values
    // (align:right) on SEPARATE lines, decoupling them on any paper slip.
    const cols = settings.paperWidth === '58mm' ? 32 : 42;
    const separator = '-'.repeat(cols);
    const pair = (label: string, value: string): string => {
      const v = value || '';
      const maxLabel = Math.max(0, cols - v.length - 1);
      const l = label.length > maxLabel ? label.slice(0, maxLabel) : label;
      return `${l}${' '.repeat(Math.max(1, cols - l.length - v.length))}${v}`;
    };
    const fold = (text: string): void => {
      const words = (text || '').split(/\s+/).filter(Boolean);
      let cur = '';
      for (const w of words) {
        if ((cur + (cur ? ' ' : '') + w).length > cols) {
          if (cur) {
            builder.text(cur).newline();
            cur = w.length > cols ? w.slice(0, cols) : w;
          } else {
            cur = w;
          }
        } else {
          cur = cur ? `${cur} ${w}` : w;
        }
      }
      if (cur) builder.text(cur).newline();
    };

    const grossTotal = grossFromTransaction(transaction);
    const tradeInDeduction = Math.max(
      0,
      Math.round(Number(transaction.tradeInDeduction ?? tradeIn.buybackValue) || 0)
    );
    const netToPay = Math.max(0, grossTotal - tradeInDeduction - (transaction.discountTotal || 0));
    const soulteAmount = Math.max(0, Math.round(Number(soulte?.amount) || 0));
    const isSoulte = soulteAmount > 0;
    // Seller = commit-time snapshot first (reprint-proof), live param next.
    const vendeur =
      (transaction.shiftOpenedByName || '').trim() ||
      (seller || '').trim() ||
      (transaction.cashierName || '').trim() ||
      'Caisse Principale';

    builder
      .init()
      .align('center')
      .bold(true)
      .text(settings.storeName || 'MOBI ACCESSORIES')
      .newline()
      .bold(false)
      .text(settings.address || 'Boulevard Mohamed V, Alger Centre')
      .newline()
      .text(`Tél : ${settings.phone || '0550 00 00 00'}`)
      .newline()
      .bold(true)
      .text('*** VENTE + REPRISE APPAREIL (TRADE-IN) ***')
      .newline()
      .bold(false)
      .align('left')
      .text(separator)
      .newline();
    builder.text(pair('Ticket:', transaction.receiptNumber || transaction.id)).newline();
    builder.text(pair('Date:', formatReceiptDateTime(transaction.createdAt))).newline();
    builder.text(pair('Caisse:', transaction.shiftId ? `Caisse ${transaction.shiftId.slice(-8)}` : 'Caisse Principale')).newline();
    builder.text(pair('Vendeur:', vendeur)).newline();
    builder.text(separator).newline();

    transaction.items.forEach((item) => {
      const itemTitle = (item.product?.title || 'Article').slice(0, cols - 8);
      const unitPrice = Number(item.appliedPrice ?? item.product?.price ?? 0);
      const lineTotal = unitPrice * Number(item.quantity || 0);
      builder.bold(true).text(itemTitle).newline().bold(false);
      builder.text(pair(`  ${item.quantity} x ${formatDZD(unitPrice)}`, formatDZD(lineTotal))).newline();
      if (item.imeiNumber) {
        builder.text(`  IMEI: ${item.imeiNumber}`.slice(0, cols)).newline();
      }
    });

    builder.text(separator).newline();
    builder.text(pair('SOUS-TOTAL ARTICLES:', formatDZD(grossTotal))).newline();
    if ((transaction.discountTotal || 0) > 0) {
      builder.text(pair('REMISE ACCORDÉE:', `-${formatDZD(transaction.discountTotal || 0)}`)).newline();
    }
    builder.bold(true);
    builder.text('[APPAREIL REPRIS / TRADE-IN]').newline();
    builder.bold(false);
    builder.text(pair('Modèle:', tradeIn.deviceModel)).newline();
    builder.text(pair('IMEI:', tradeIn.imei)).newline();
    if (tradeIn.conditionGrade) {
      builder.text(pair('État:', tradeIn.conditionGrade)).newline();
    }
    builder.text(pair('DÉDUCTION REPRISE:', `-${formatDZD(tradeInDeduction)}`)).newline();
    builder.text(separator).newline();
    if (isSoulte) {
      builder.bold(true);
      builder.text(pair('SOULTE À VERSER AU CLIENT :', formatDZD(soulteAmount))).newline();
      builder.bold(false);
      builder
        .text(
          pair(
            'Mode :',
            soulte?.method === 'cash' ? 'Espèces (Tiroir)' : 'Avoir Client (Portefeuille)'
          )
        )
        .newline();
    } else {
      builder.text(pair('NET À PAYER EN ESPÈCES :', formatDZD(netToPay))).newline();
      builder
        .text(pair('Espèces Données :', formatDZD(transaction.cashTendered || netToPay)))
        .newline();
      builder.bold(true);
      builder.text(pair('MONNAIE RENDUE :', formatDZD(transaction.changeDue || 0))).newline();
      builder.bold(false);
    }
    builder.text(separator).newline().align('center');
    fold(STORE_RETURN_POLICY);
    builder
      .text('Merci de votre visite !')
      .newline()
      .newline(2)
      .cut(false);

    return builder.build();
  }
}

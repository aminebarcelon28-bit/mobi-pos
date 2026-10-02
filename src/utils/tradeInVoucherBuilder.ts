/**
 * Professional Trade-In Buyback Voucher & Legal Ownership Transfer Builder
 * Author: Principal Systems Architect
 */
import type { TradeInItem, ReceiptSettings, SaleTransaction } from '../types/pos';
import { faitALine } from '../types/pos';
import { EscPosBuilder } from './escpos';
import { grossFromTransaction } from './receiptMath';

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
    settings: ReceiptSettings
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
      .bold(false)
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
    soulte?: { amount: number; method: 'cash' | 'wallet' } | null
  ): Uint8Array {
    const builder = new EscPosBuilder();
    const is80mm = settings.paperWidth !== '58mm';
    const separator = is80mm
      ? '------------------------------------------------'
      : '--------------------------------';

    const grossTotal = grossFromTransaction(transaction);
    const tradeInDeduction = Math.max(
      0,
      Math.round(Number(transaction.tradeInDeduction ?? tradeIn.buybackValue) || 0)
    );
    const netToPay = Math.max(0, grossTotal - tradeInDeduction - (transaction.discountTotal || 0));
    const soulteAmount = Math.max(0, Math.round(Number(soulte?.amount) || 0));
    const isSoulte = soulteAmount > 0;

    builder
      .init()
      .align('center')
      .bold(true)
      .text(settings.storeName || 'MOBI ACCESSORIES')
      .newline()
      .bold(false)
      .text(settings.address || 'Boulevard Mohamed V, Alger Centre')
      .newline()
      .text(`TICKET : ${transaction.receiptNumber}`)
      .newline()
      .text(separator)
      .newline()
      .align('left');

    transaction.items.forEach((item) => {
      const itemTitle = item.product.title.slice(0, is80mm ? 26 : 16);
      const unitPrice = item.appliedPrice;
      const lineTotal = item.appliedPrice * item.quantity;
      builder
        .bold(true)
        .text(itemTitle)
        .newline()
        .bold(false)
        .text(`  ${item.quantity} x ${unitPrice.toLocaleString('fr-DZ')} DA`)
        .align('right')
        .text(`  ${lineTotal.toLocaleString('fr-DZ')} DA`)
        .newline()
        .align('left');
    });

    builder
      .text(separator)
      .newline()
      .text(`Sous-total Articles :`)
      .align('right')
      .text(`${grossTotal.toLocaleString('fr-DZ')} DA`)
      .newline()
      .align('left')
      .bold(true)
      .text(`Reprise ${tradeIn.deviceModel} (IMEI: ${tradeIn.imei.slice(-6)}) :`)
      .align('right')
      .text(`-${tradeInDeduction.toLocaleString('fr-DZ')} DA`)
      .newline()
      .text(separator)
      .newline();
    if (isSoulte) {
      builder
        .align('left')
        .bold(true)
        .text(`SOULTE À VERSER AU CLIENT :`)
        .align('right')
        .text(` ${soulteAmount.toLocaleString('fr-DZ')} DA`)
        .newline()
        .align('left')
        .bold(false)
        .text(`Mode : ${soulte?.method === 'cash' ? 'Espèces (Tiroir)' : 'Avoir Client (Portefeuille)'}`)
        .newline();
    } else {
      builder
        .align('left')
        .text(`NET À PAYER EN ESPÈCES :`)
        .align('right')
        .text(` ${netToPay.toLocaleString('fr-DZ')} DA`)
        .newline()
        .align('left')
        .bold(false)
        .text(`Espèces Données :`)
        .align('right')
        .text(` ${(transaction.cashTendered || netToPay).toLocaleString('fr-DZ')} DA`)
        .newline()
        .align('left')
        .bold(true)
        .text(`MONNAIE RENDUE :`)
        .align('right')
        .text(` ${(transaction.changeDue || 0).toLocaleString('fr-DZ')} DA`)
        .newline()
        .bold(false);
    }
    builder
      .text(separator)
      .newline()
      .align('center')
      .text('Merci de votre visite !')
      .newline()
      .newline(2)
      .cut(false);

    return builder.build();
  }
}

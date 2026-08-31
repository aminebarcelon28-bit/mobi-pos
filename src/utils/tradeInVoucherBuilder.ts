/**
 * Professional Trade-In Buyback Voucher & Legal Ownership Transfer Builder
 * Author: Principal Systems Architect
 */
import type { TradeInItem, ReceiptSettings, SaleTransaction } from '../types/pos';
import { EscPosBuilder } from './escpos';

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
      .newline();

    if (tradeIn.nationalIdNumber) {
      builder.text(`N° Pièce d'Identité (CNI / Permis) : ${tradeIn.nationalIdNumber}`).newline();
    }

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
      .text(
        'Le cédant certifie sur l\'honneur être le propriétaire légitime de l\'appareil ci-dessus et que celui-ci n\'est ni gagé, ni déclaré volé ou perdu.'
      )
      .newline()
      .newline(2)
      .align('center')
      .text('Signature du Client :                  Signature Magasin :')
      .newline()
      .newline(2)
      .text('....................                  ....................')
      .newline()
      .newline(2)
      .cut(false);

    return builder.build();
  }

  public static buildNetTradeInSaleReceipt(
    transaction: SaleTransaction,
    tradeIn: TradeInItem,
    settings: ReceiptSettings
  ): Uint8Array {
    const builder = new EscPosBuilder();
    const is80mm = settings.paperWidth !== '58mm';
    const separator = is80mm
      ? '------------------------------------------------'
      : '--------------------------------';

    const grossTotal = transaction.subtotal || transaction.total;
    const tradeInDeduction = tradeIn.buybackValue;
    const netToPay = Math.max(0, grossTotal - tradeInDeduction - (transaction.discountTotal || 0));

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
      .newline()
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
      .bold(false)
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

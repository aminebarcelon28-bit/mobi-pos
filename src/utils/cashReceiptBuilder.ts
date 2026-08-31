/**
 * Professional Cash Settlement Receipt Builder (80mm / 58mm ESC/POS)
 * Author: Principal Systems Architect
 */
import type { SaleTransaction, ReceiptSettings } from '../types/pos';
import { EscPosBuilder } from './escpos';

export class CashReceiptBuilder {
  public static buildCashSaleReceipt(
    transaction: SaleTransaction,
    settings: ReceiptSettings
  ): Uint8Array {
    const builder = new EscPosBuilder();
    const is80mm = settings.paperWidth !== '58mm';
    const separatorLine = is80mm
      ? '------------------------------------------------'
      : '--------------------------------';

    const subtotalFormatted =
      (transaction.subtotal || transaction.total).toLocaleString('fr-DZ') + ' DA';
    const totalFormatted = transaction.total.toLocaleString('fr-DZ') + ' DA';
    const tenderedFormatted =
      (transaction.cashTendered || transaction.total).toLocaleString('fr-DZ') + ' DA';
    const changeFormatted = (transaction.changeDue || 0).toLocaleString('fr-DZ') + ' DA';

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
      .newline();

    if (settings.taxNumber) {
      builder.text(`NIF / RC : ${settings.taxNumber}`).newline();
    }

    builder
      .text(separatorLine)
      .newline()
      .bold(true)
      .text(`TICKET DE CAISSE : ${transaction.receiptNumber}`)
      .newline()
      .bold(false)
      .text(`Date : ${new Date(transaction.createdAt).toLocaleString('fr-DZ')}`)
      .newline()
      .text(separatorLine)
      .newline()
      .align('left');

    transaction.items.forEach((item) => {
      const itemTitle = item.product.title.slice(0, is80mm ? 26 : 16);
      const qtyAndPrice = `${item.quantity} x ${item.appliedPrice.toLocaleString('fr-DZ')}`;
      const lineTotal =
        (item.appliedPrice * item.quantity).toLocaleString('fr-DZ') + ' DA';

      builder
        .bold(true)
        .text(itemTitle)
        .newline()
        .bold(false)
        .text(`  ${qtyAndPrice}`)
        .align('right')
        .text(`  ${lineTotal}`)
        .newline()
        .align('left');
    });

    builder
      .text(separatorLine)
      .newline()
      .align('left');

    if (transaction.discountTotal && transaction.discountTotal > 0) {
      builder
        .text(`Sous-total :`)
        .align('right')
        .text(subtotalFormatted)
        .newline()
        .align('left')
        .text(`Remise Accordée :`)
        .align('right')
        .text(`-${transaction.discountTotal.toLocaleString('fr-DZ')} DA`)
        .newline()
        .align('left');
    }

    builder
      .bold(true)
      .text(`TOTAL NET À PAYER :`)
      .align('right')
      .text(` ${totalFormatted}`)
      .newline()
      .text(separatorLine)
      .newline()
      .align('left')
      .bold(false)
      .text(`Espèces Données (Client) :`)
      .align('right')
      .text(` ${tenderedFormatted}`)
      .newline()
      .align('left')
      .bold(true)
      .text(`MONNAIE RENDUE :`)
      .align('right')
      .text(` ${changeFormatted}`)
      .newline()
      .bold(false)
      .text(separatorLine)
      .newline()
      .align('center')
      .text(
        settings.footerMessage ||
          'Merci de votre visite ! Les articles sont échangeables sous 48h avec ticket.'
      )
      .newline()
      .newline(2)
      .cut(false);

    return builder.build();
  }
}

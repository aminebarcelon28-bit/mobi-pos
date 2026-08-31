/**
 * 80mm ESC/POS Account Statement Ticket Builder
 * Author: Principal Systems Architect
 */
import type { Customer, CustomerDebtEntry, ReceiptSettings } from '../types/pos';
import { EscPosBuilder } from './escpos';

export class DebtStatementTicketBuilder {
  public static buildStatementVoucher(
    customer: Customer,
    debts: CustomerDebtEntry[],
    settings: ReceiptSettings
  ): Uint8Array {
    const builder = new EscPosBuilder();
    const currentDebtFormatted = (customer.currentDebt || 0).toLocaleString('fr-DZ');

    builder
      .init()
      .align('center')
      .bold(true)
      .text(settings.storeName || 'MOBI ACCESSORIES')
      .newline()
      .bold(false)
      .text(settings.address || 'Boulevard Mohamed V, Alger')
      .newline()
      .text(`Tél : ${settings.phone || '0550 00 00 00'}`)
      .newline()
      .separator()
      .bold(true)
      .text('RELEVÉ DE COMPTE & CRÉDIT CLIENT (KREDY)')
      .newline()
      .bold(false)
      .text(`Date d'Édition : ${new Date().toLocaleString('fr-DZ')}`)
      .newline()
      .separator()
      .align('left')
      .bold(true)
      .text(`Client : ${customer.name}`)
      .newline()
      .bold(false)
      .text(`Téléphone : ${customer.phone}`)
      .newline()
      .text(`Plafond de Crédit Autorisé : ${(customer.debtLimit || 100000).toLocaleString('fr-DZ')} DA`)
      .newline()
      .separator()
      .bold(true)
      .text('HISTORIQUE DES MOUVEMENTS :')
      .newline()
      .bold(false);

    (debts || []).slice(0, 5).forEach((d) => {
      const typeLabel = d.type === 'DEBT_ACQUIRED' ? '(+) Achat Crédit' : '(-) Règlement';
      const dateStr = new Date(d.createdAt).toLocaleDateString('fr-DZ');
      builder
        .text(`${dateStr} | ${typeLabel} : ${d.amount.toLocaleString('fr-DZ')} DA`)
        .newline();
    });

    builder
      .separator()
      .align('center')
      .bold(true)
      .text(`SOLDE ACTUEL DÛ : ${currentDebtFormatted} DA`)
      .newline()
      .bold(false)
      .separator()
      .align('left')
      .text('Signature & Accord Client :')
      .newline()
      .newline(2)
      .align('center')
      .text('........................................')
      .newline()
      .newline(2)
      .cut(false);

    return builder.build();
  }
}

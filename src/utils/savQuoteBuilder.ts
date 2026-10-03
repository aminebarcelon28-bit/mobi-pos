/**
 * SAV repair quotation (devis estimatif) ESC/POS ticket builder.
 * 58mm standard (32 columns). Mirrors SavTicketBuilder conventions.
 */
import type { RepairOrder, ReceiptSettings } from '../types/pos';
import { faitALine, repairQuoteNumber, REPAIR_QUOTE_VALIDITY_DAYS } from '../types/pos';
import { EscPosBuilder } from './escpos';

const fmtDA = (n: number): string => `${Math.round(n || 0).toLocaleString('fr-DZ')} DA`;

export class SavQuoteBuilder {
  public static buildSavQuoteTicket(
    order: RepairOrder,
    settings: ReceiptSettings,
    seller?: string | null
  ): Uint8Array {
    const builder = new EscPosBuilder();
    const total = Math.round(order.totalCost || 0);
    const quoteNo = repairQuoteNumber(order);
    const emittedAt = new Date();
    const validUntil = new Date(emittedAt);
    validUntil.setDate(validUntil.getDate() + REPAIR_QUOTE_VALIDITY_DAYS);

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
      .text('DEVIS ESTIMATIF SAV')
      .newline()
      .bold(false)
      .text(`Devis N° : ${quoteNo}`)
      .newline()
      .text(`Ticket : ${order.ticketNumber}`)
      .newline()
      .text(`Émis le : ${emittedAt.toLocaleString('fr-DZ')}`)
      .newline();
    if ((seller || '').trim()) {
      builder.text(`Vendeur (Caisse) : ${seller!.trim()}`).newline();
    }
    builder.bold(true)
      .text(`Validité : ${REPAIR_QUOTE_VALIDITY_DAYS} jours (jusqu'au ${validUntil.toLocaleDateString('fr-DZ')})`)
      .newline()
      .bold(false)
      .separator()
      .align('left')
      .text(`Client : ${order.customerName}`)
      .newline()
      .text(`Téléphone : ${order.customerPhone}`)
      .newline()
      .text(`Appareil : ${order.deviceModel}`)
      .newline()
      .text(`IMEI/S/N : ${order.imei || 'Non spécifié'}`)
      .newline()
      .separator()
      .text(`Symptôme : ${order.problemDescription}`)
      .newline();
    if (order.diagnosticNotes) {
      builder.text(`Diagnostic : ${order.diagnosticNotes}`).newline();
    }
    builder
      .separator()
      .align('left')
      .text(`Main d'œuvre estimée : ${fmtDA(order.laborCost)}`)
      .newline()
      .text(`Pièces estimées : ${fmtDA(order.partsCost)}`)
      .newline()
      .bold(true)
      .text(`TOTAL ESTIMÉ : ${fmtDA(total)}`)
      .newline()
      .bold(false)
      .text(`Acompte requis : ${fmtDA(Math.round(total / 2))}`)
      .newline()
      .separator()
      .align('center')
      .text('Devis gratuit, sans engagement.')
      .newline()
      .text(faitALine(settings))
      .newline()
      .bold(true)
      .text('Bon pour accord : __________')
      .newline()
      .bold(false)
      .separator()
      .align('center')
      .barcode(order.ticketNumber)
      .newline(2)
      .cut(false);

    return builder.build();
  }
}

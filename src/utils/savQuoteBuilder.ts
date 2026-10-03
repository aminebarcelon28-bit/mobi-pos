/**
 * SAV repair quotation (devis estimatif) ESC/POS ticket builder.
 * 58mm standard (32 columns). Mirrors SavTicketBuilder conventions.
 */
import type { RepairOrder, ReceiptSettings } from '../types/pos';
import { faitALine, formatDZD, REPAIR_QUOTE_VALIDITY_DAYS } from '../types/pos';
import { EscPosBuilder } from './escpos';
import { buildSavViewModel } from './receiptViewModel';

export class SavQuoteBuilder {
  public static buildSavQuoteTicket(
    order: RepairOrder,
    settings: ReceiptSettings,
    seller?: string | null
  ): Uint8Array {
    // Unified on buildSavViewModel: paired ledger, telemetry, 42/32 cols.
    const vm = buildSavViewModel(order, settings, { kind: 'quote', seller });
    const cols = settings?.paperWidth === '58mm' ? 32 : 42;
    const builder = new EscPosBuilder();
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

    builder.init().align('center').bold(true);
    builder.text(vm.store.name).newline().bold(false);
    if (vm.store.tagline) {
      builder.text(vm.store.tagline).newline();
    }
    builder.text(settings.address || 'Boulevard Mohamed V, Alger').newline();
    builder.text(`Tél : ${settings.phone || '0550 00 00 00'}`).newline();
    if (vm.store.email) {
      builder.text(`Email: ${vm.store.email}`).newline();
    }
    builder.separator('-', cols);
    builder.bold(true).text('DEVIS ESTIMATIF SAV').newline().bold(false);
    builder.text(pair('Devis N° :', vm.quoteNumber)).newline();
    builder.text(pair('Ticket :', vm.ticketNumber)).newline();
    builder.text(pair('Émis le :', vm.createdAt)).newline();
    builder.text(pair('Vendeur (Caisse) :', vm.sellerName)).newline();
    builder.bold(true)
    builder.text(pair('Validité :', `${REPAIR_QUOTE_VALIDITY_DAYS} jours (jusqu'au ${vm.validUntil})`)).newline();
    builder.bold(false);
    builder.separator('-', cols).align('left');
    builder.bold(true).text(`Client : ${vm.customerName}`).newline().bold(false);
    builder.text(pair('Téléphone :', vm.customerPhone || 'Non renseigné')).newline();
    builder.text(pair('Appareil :', vm.deviceModel)).newline();
    builder.text(pair('IMEI/S/N :', vm.imei || 'Non spécifié')).newline();
    builder.separator('-', cols);
    fold(`Symptôme : ${vm.problem}`);
    if (vm.diagnosticNotes) {
      fold(`Diagnostic : ${vm.diagnosticNotes}`);
    }
    builder.separator('-', cols);
    builder.text(pair("Main d'œuvre estimée :", formatDZD(vm.laborCost))).newline();
    builder.text(pair('Pièces estimées :', formatDZD(vm.partsCost))).newline();
    builder.bold(true);
    builder.text(pair('TOTAL ESTIMÉ :', formatDZD(vm.totalCost))).newline();
    builder.bold(false);
    builder.text(pair('Acompte requis :', formatDZD(Math.round(vm.totalCost / 2)))).newline();
    builder.separator('-', cols).align('center');
    builder.text('Devis gratuit, sans engagement.').newline();
    builder.text(faitALine(settings)).newline();
    builder.bold(true).text('Bon pour accord : __________').newline().bold(false);
    builder.separator('-', cols).align('center');
    builder.barcode(vm.ticketNumber);
    builder.newline(2).cut(false);

    return builder.build();
  }
}

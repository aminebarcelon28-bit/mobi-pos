/**
 * SAV restitution (handover / discharge) ESC/POS ticket builder.
 * 58mm standard (32 columns). Mirrors SavTicketBuilder conventions.
 */
import type { RepairOrder, ReceiptSettings } from '../types/pos';
import {
  DATA_LOSS_DISCLAIMER,
  faitALine,
  formatDZD,
  RESTITUTION_UNSETTLED_BANNER,
  UNCLAIMED_DEVICE_CLAUSE,
} from '../types/pos';
import { EscPosBuilder } from './escpos';
import { buildSavViewModel, savCheckCell } from './receiptViewModel';

export class SavRestitutionBuilder {
  public static buildSavRestitutionTicket(
    order: RepairOrder,
    settings: ReceiptSettings,
    seller?: string | null,
    paidToday?: number
  ): Uint8Array {
    // Unified on buildSavViewModel (B5): paired ledger, telemetry, 42/32 cols.
    const vm = buildSavViewModel(order, settings, { kind: 'restitution', seller, paidToday });
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
    const check = (label: string, ok: boolean | undefined): string =>
      `${label} : ${savCheckCell(ok)}`;

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
    builder.bold(true).text('BON DE RESTITUTION SAV').newline().bold(false);
    builder.text(pair('Ticket N° :', vm.ticketNumber)).newline();
    builder.text(pair('Dépôt :', vm.createdAt)).newline();
    builder.text(pair('Restitution :', vm.deliveredAt)).newline();
    builder.text(pair('Vendeur (Caisse) :', vm.sellerName)).newline();
    if (vm.technicianName) {
      builder.text(pair('Technicien :', vm.technicianName)).newline();
    }

    if (vm.unsettled) {
      builder.separator('-', cols).align('center').bold(true);
      builder.text(`!! RESTE DÛ : ${formatDZD(vm.balanceDue)} !!`).newline();
      // Thermal-safe: the banner's em-dash (U+2014) truncates to a control
      // byte through the latin-1 byte path — fold it to ASCII first.
      fold(RESTITUTION_UNSETTLED_BANNER.replace(/[—–]/g, '-'));
      builder.bold(false);
    } else {
      builder.separator('-', cols).align('center').bold(true);
      builder.text('*** SOLDE RÉGLÉ ***').newline();
      builder.bold(false);
    }

    builder.separator('-', cols).align('left');
    builder.bold(true).text(`Client : ${vm.customerName}`).newline().bold(false);
    builder.text(pair('Téléphone :', vm.customerPhone || 'Non renseigné')).newline();
    builder.text(pair('Appareil :', vm.deviceModel)).newline();
    builder.text(pair('IMEI/S/N :', vm.imei || 'Non spécifié')).newline();
    fold(`Panne initiale : ${vm.problem}`);
    builder.separator('-', cols);
    builder.text(pair("Main d'œuvre :", formatDZD(vm.laborCost))).newline();
    builder.text(pair('Pièces détachées :', formatDZD(vm.partsCost))).newline();
    builder.bold(true);
    builder.text(pair('TOTAL :', formatDZD(vm.totalCost))).newline();
    builder.bold(false);
    builder.text(pair('Acompte déjà versé :', formatDZD(vm.depositAmount))).newline();
    builder.text(pair('Net payé ce jour :', formatDZD(vm.paidToday))).newline();
    builder.bold(true);
    builder.text(pair('RESTE DÛ :', formatDZD(vm.balanceDue))).newline();
    builder.bold(false);
    builder.separator('-', cols);
    builder.bold(true).text('CONTRÔLE QUALITÉ SORTIE :').newline().bold(false);
    builder.text(check('Écran', vm.checklist.screenOk)).newline();
    builder.text(check('Caméras', vm.checklist.cameraOk)).newline();
    builder.text(check('Charge', vm.checklist.chargingOk)).newline();
    builder.text(check('Face ID / Touch ID', vm.checklist.faceIdOk)).newline();
    builder.text(check('Audio', vm.checklist.audioOk)).newline();
    builder.separator('-', cols).align('center');
    builder.text('Garantie 30 jours sur pièces remplacées').newline();
    builder.text('(hors chocs, humidité, démontage).').newline();
    fold(DATA_LOSS_DISCLAIMER);
    fold(UNCLAIMED_DEVICE_CLAUSE);
    builder.bold(true).text('Appareil retiré vérifié et fonctionnel.').newline().bold(false);
    builder.separator('-', cols).align('center');
    builder.text(faitALine(settings)).newline().newline();
    builder.align('left');
    builder.text("Pour l'Atelier : __________").newline();
    builder.text('Le Client (Lu et approuvé) : __________').newline();
    builder.align('center');
    builder.barcode(vm.ticketNumber);
    builder.newline(2).cut(false);

    return builder.build();
  }
}

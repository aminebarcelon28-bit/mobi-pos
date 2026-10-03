/**
 * Professional Dual-Stub ESC/POS Ticket Builder for Mobile Phone Repair
 * Author: Principal Systems Architect
 */
import type { RepairOrder, ReceiptSettings } from '../types/pos';
import { DATA_LOSS_DISCLAIMER, UNCLAIMED_DEVICE_CLAUSE, formatDZD } from '../types/pos';
import { EscPosBuilder } from './escpos';
import { buildSavViewModel } from './receiptViewModel';

export class SavTicketBuilder {
  public static buildCustomerVoucher(
    order: RepairOrder,
    settings: ReceiptSettings,
    seller?: string | null
  ): Uint8Array {
    // Unified on buildSavViewModel (B4): same telemetry + paired ledger as
    // the mobile twin. 42 cols on 80mm, 32 on 58mm.
    const vm = buildSavViewModel(order, settings, { kind: 'depot', seller });
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
    builder.bold(true).text('BON DE DÉPÔT RÉPARATION (SAV)').newline().bold(false);
    builder.text(pair('Ticket N° :', vm.ticketNumber)).newline();
    builder.text(pair('Date :', vm.createdAt)).newline();
    builder.text(pair('Vendeur (Caisse) :', vm.sellerName)).newline();
    builder.separator('-', cols).align('left');
    builder.bold(true).text(`Client : ${vm.customerName}`).newline().bold(false);
    builder.text(pair('Téléphone :', vm.customerPhone || 'Non renseigné')).newline();
    builder.text(pair('Appareil :', vm.deviceModel)).newline();
    builder.text(pair('IMEI/S/N :', vm.imei || 'Non spécifié')).newline();
    fold(`Problème déclaré : ${vm.problem}`);
    if (vm.diagnosticNotes) {
      fold(`Diag : ${vm.diagnosticNotes}`);
    }
    builder.separator('-', cols);
    builder.text(pair('Coût Total Estimé :', formatDZD(vm.totalCost))).newline();
    builder.text(pair('Acompte Versé :', formatDZD(vm.depositAmount))).newline();
    builder.bold(true);
    builder.text(pair('SOLDE RESTANT DÛ :', formatDZD(vm.balanceDue))).newline();
    builder.bold(false);
    builder.separator('-', cols).align('center');
    builder.text('Scan pour suivi WhatsApp / Retrait :').newline();
    builder.barcode(vm.ticketNumber);
    builder.newline();
    builder.text('CONDITIONS GÉNÉRALES SAV :').newline();
    builder.text('1. Présentation obligatoire de ce bon pour retrait.').newline();
    fold(`2. ${UNCLAIMED_DEVICE_CLAUSE}`);
    builder.text('3. Garantie 30 jours sur pièces remplacées.').newline();
    fold(`4. ${DATA_LOSS_DISCLAIMER}`);
    builder.text('Signature client : ____________________').newline();
    builder.newline(2).cut(false);

    return builder.build();
  }

  public static buildWorkshopJobSlip(
    order: RepairOrder,
    seller?: string | null,
    technician?: string | null
  ): Uint8Array {
    const builder = new EscPosBuilder();
    const cl = order.conditionChecklist || {
      screenOk: true,
      faceIdOk: true,
      cameraOk: true,
      chargingOk: true,
      bodyOk: true,
      batteryOk: true,
      audioOk: true,
    };

    builder
      .init()
      .align('center')
      .bold(true)
      .text('*** FICHE ATELIER / TECHNICIEN ***')
      .newline()
      .text(`TICKET : ${order.ticketNumber}`)
      .newline()
      .bold(false)
      .text(`Date Dépôt : ${new Date(order.createdAt).toLocaleString('fr-DZ')}`)
      .newline();
    if ((seller || '').trim()) {
      builder.text(`Vendeur (Caisse) : ${seller!.trim()}`).newline();
    }
    if ((technician || order.assignedTechnicianId || '').trim()) {
      builder.text(`Technicien : ${(technician || order.assignedTechnicianId || '').trim()}`).newline();
    }
    builder.separator()
      .align('left')
      .bold(true)
      .text(`Appareil : ${order.deviceModel}`)
      .newline()
      .text(`Client : ${order.customerName} (${order.customerPhone})`)
      .newline()
      .text(`IMEI : ${order.imei || 'N/A'}`)
      .newline()
      .text(`Date Prévue : ${order.estimatedCompletionDate || 'Non spécifiée'}`)
      .newline()
      .separator()
      .bold(true)
      .text('DIAGNOSTIC & PANNE :')
      .newline()
      .bold(false)
      .text(order.problemDescription)
      .newline();

    if (order.diagnosticNotes) {
      builder.text(`Notes Internes : ${order.diagnosticNotes}`).newline();
    }

    builder
      .separator()
      .bold(true)
      .text('AUDIT CONTRÔLE INITIAL (CHECKLIST) :')
      .newline()
      .bold(false)
      .text(`Écran / Tactile : ${cl.screenOk ? '[✓] OK' : '[✗] HORS SERVICE / CASSÉ'}`)
      .newline()
      .text(`Face ID / Touch ID : ${cl.faceIdOk ? '[✓] OK' : '[✗] DÉFAILLANT'}`)
      .newline()
      .text(`Caméras (Av/Ar) : ${cl.cameraOk ? '[✓] OK' : '[✗] HORS SERVICE'}`)
      .newline()
      .text(`Charge / Connecteur : ${cl.chargingOk ? '[✓] OK' : '[✗] DÉFAILLANT'}`)
      .newline()
      .text(`Batterie : ${cl.batteryOk ? '[✓] OK' : '[✗] À REMPLACER'}`)
      .newline()
      .text(`Châssis / Coque : ${cl.bodyOk ? '[✓] BON ÉTAT' : '[✗] DÉFORMÉ / RAYÉ'}`)
      .newline()
      .text(`Audio / Micro : ${cl.audioOk ? '[✓] OK' : '[✗] HORS SERVICE'}`)
      .newline()
      .separator()
      .align('center')
      .text('Scanner pour ouvrir le dossier SAV :')
      .newline()
      .barcode(order.ticketNumber)
      .newline(2)
      .cut(false);

    return builder.build();
  }
}

/**
 * SAV restitution (handover / discharge) ESC/POS ticket builder.
 * 58mm standard (32 columns). Mirrors SavTicketBuilder conventions.
 */
import type { RepairOrder, ReceiptSettings } from '../types/pos';
import {
  DATA_LOSS_DISCLAIMER,
  faitALine,
  repairRemainingBalance,
  RESTITUTION_UNSETTLED_BANNER,
  UNCLAIMED_DEVICE_CLAUSE,
} from '../types/pos';
import { EscPosBuilder } from './escpos';

const fmtDA = (n: number): string => `${Math.round(n || 0).toLocaleString('fr-DZ')} DA`;

export class SavRestitutionBuilder {
  public static buildSavRestitutionTicket(
    order: RepairOrder,
    settings: ReceiptSettings,
    seller?: string | null
  ): Uint8Array {
    const builder = new EscPosBuilder();
    const total = Math.round(order.totalCost || 0);
    const deposit = Math.round(order.depositAmount || 0);
    const remaining = repairRemainingBalance(order);
    const settled = remaining <= 0;
    const deliveredAt = order.updatedAt || order.createdAt;
    const cl = order.postRepairChecklist || order.conditionChecklist;

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
      .text('BON DE RESTITUTION SAV')
      .newline()
      .bold(false)
      .text(`Ticket N° : ${order.ticketNumber}`)
      .newline()
      .text(`Dépôt : ${new Date(order.createdAt).toLocaleString('fr-DZ')}`)
      .newline()
      .text(`Restitution : ${new Date(deliveredAt).toLocaleString('fr-DZ')}`)
      .newline();
    if ((seller || '').trim()) {
      builder.text(`Vendeur (Caisse) : ${seller!.trim()}`).newline();
    }
    if ((order.assignedTechnicianId || '').trim()) {
      builder.text(`Technicien : ${order.assignedTechnicianId!.trim()}`).newline();
    }

    if (!settled) {
      builder
        .separator()
        .align('center')
        .bold(true)
        .text(RESTITUTION_UNSETTLED_BANNER)
        .newline()
        .bold(false);
    }

    builder
      .separator()
      .align('left')
      .bold(true)
      .text(`Client : ${order.customerName}`)
      .newline()
      .bold(false)
      .text(`Téléphone : ${order.customerPhone}`)
      .newline()
      .text(`Appareil : ${order.deviceModel}`)
      .newline()
      .text(`IMEI/S/N : ${order.imei || 'Non spécifié'}`)
      .newline()
      .text(`Panne initiale : ${order.problemDescription}`)
      .newline()
      .separator()
      .align('left')
      .text(`Main d'œuvre : ${fmtDA(order.laborCost)}`)
      .newline()
      .text(`Pièces : ${fmtDA(order.partsCost)}`)
      .newline()
      .bold(true)
      .text(`TOTAL : ${fmtDA(total)}`)
      .newline()
      .bold(false)
      .text(`Acompte réglé : ${fmtDA(deposit)}`)
      .newline()
      .bold(true)
      .text(`Solde réglé : ${fmtDA(total - remaining)}`)
      .newline()
      .text(`RESTE À PAYER : ${fmtDA(remaining)}`)
      .newline()
      .bold(false)
      .separator()
      .align('left')
      .bold(true)
      .text('CONTRÔLE QUALITÉ SORTIE :')
      .newline()
      .bold(false)
      .text(`Écran : ${cl.screenOk ? '[✓] OK' : '[✗] KO'}`)
      .newline()
      .text(`Caméras : ${cl.cameraOk ? '[✓] OK' : '[✗] KO'}`)
      .newline()
      .text(`Charge : ${cl.chargingOk ? '[✓] OK' : '[✗] KO'}`)
      .newline()
      .text(`Face ID / Touch ID : ${cl.faceIdOk ? '[✓] OK' : '[✗] KO'}`)
      .newline()
      .text(`Audio : ${cl.audioOk ? '[✓] OK' : '[✗] KO'}`)
      .newline()
      .separator()
      .align('center')
      .text('Garantie 30 jours sur pièces remplacées')
      .newline()
      .text('(hors chocs, humidité, démontage).')
      .newline()
      .text(DATA_LOSS_DISCLAIMER)
      .newline()
      .text(UNCLAIMED_DEVICE_CLAUSE)
      .newline()
      .bold(true)
      .text('Appareil retiré vérifié et fonctionnel.')
      .newline()
      .bold(false)
      .separator()
      .align('center')
      .text(faitALine(settings))
      .newline()
      .newline()
      .align('left')
      .text('Pour l\'Atelier : __________')
      .newline()
      .text('Le Client (Lu et approuvé) : __________')
      .newline()
      .align('center')
      .barcode(order.ticketNumber)
      .newline(2)
      .cut(false);

    return builder.build();
  }
}

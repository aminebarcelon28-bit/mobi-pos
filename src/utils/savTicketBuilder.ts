/**
 * Professional Dual-Stub ESC/POS Ticket Builder for Mobile Phone Repair
 * Author: Principal Systems Architect
 */
import type { RepairOrder, ReceiptSettings } from '../types/pos';
import { EscPosBuilder } from './escpos';

export class SavTicketBuilder {
  public static buildCustomerVoucher(order: RepairOrder, settings: ReceiptSettings): Uint8Array {
    const builder = new EscPosBuilder();
    const remaining = Math.max(0, order.totalCost - (order.depositAmount || 0));

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
      .text('BON DE DÉPÔT RÉPARATION (SAV)')
      .newline()
      .bold(false)
      .text(`Ticket N° : ${order.ticketNumber}`)
      .newline()
      .text(`Date : ${new Date(order.createdAt).toLocaleString('fr-DZ')}`)
      .newline()
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
      .text(`Problème déclaré : ${order.problemDescription}`)
      .newline()
      .separator()
      .align('left')
      .text(`Coût Total Estimé : ${order.totalCost.toLocaleString('fr-DZ')} DA`)
      .newline()
      .text(`Acompte Versé : ${(order.depositAmount || 0).toLocaleString('fr-DZ')} DA`)
      .newline()
      .bold(true)
      .text(`SOLDE RESTANT DÛ : ${remaining.toLocaleString('fr-DZ')} DA`)
      .newline()
      .bold(false)
      .separator()
      .align('center')
      .text('Scan pour suivi WhatsApp / Retrait :')
      .newline()
      .barcode(order.ticketNumber)
      .newline()
      .text('CONDITIONS GÉNÉRALES SAV :')
      .newline()
      .text('1. Présentation obligatoire de ce bon pour retrait.')
      .newline()
      .text('2. Appareils non réclamés après 30 jours recyclés.')
      .newline()
      .text('3. Garantie 30 jours sur pièces remplacées.')
      .newline()
      .newline(2)
      .cut(false);

    return builder.build();
  }

  public static buildWorkshopJobSlip(order: RepairOrder): Uint8Array {
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
      .newline()
      .separator()
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

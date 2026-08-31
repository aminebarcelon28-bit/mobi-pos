/**
 * Professional Multi-State Customer Notification Gateway for Mobile Repair
 * Author: Principal Systems Architect
 */
import type { RepairOrder, ReceiptSettings, RepairNotificationType } from '../types/pos';

export class RepairNotificationEngine {
  public static sanitizeAlgerianPhone(phone: string): string {
    let clean = phone.replace(/[^0-9+]/g, '');
    if (clean.startsWith('+213')) {
      clean = clean.slice(1);
    } else if (clean.startsWith('00213')) {
      clean = clean.slice(2);
    } else if (
      clean.startsWith('0') &&
      (clean.startsWith('05') || clean.startsWith('06') || clean.startsWith('07'))
    ) {
      clean = '213' + clean.slice(1);
    } else if (!clean.startsWith('213') && clean.length === 9) {
      clean = '213' + clean;
    }
    return clean;
  }

  public static generateMessageBody(
    order: RepairOrder,
    settings: ReceiptSettings,
    type: RepairNotificationType = 'READY_FOR_PICKUP'
  ): string {
    const storeName = settings.storeName || 'MOBI ACCESSORIES';
    const storeAddress = settings.address || 'Boulevard Mohamed V, Alger Centre';
    const remaining = Math.max(0, order.totalCost - (order.depositAmount || 0));

    switch (type) {
      case 'READY_FOR_PICKUP':
        return [
          `Bonjour *${order.customerName}*,`,
          ``,
          `✅ Votre appareil *${order.deviceModel}* (Ticket N° *${order.ticketNumber}*) est *réparé et prêt à être récupéré* chez *${storeName}* !`,
          ``,
          `💰 *Bilan Financier :*`,
          `• Coût Total : *${order.totalCost.toLocaleString('fr-DZ')} DA*`,
          `• Acompte Réglé : *${(order.depositAmount || 0).toLocaleString('fr-DZ')} DA*`,
          `• *Solde Restant à Régler :* *${remaining.toLocaleString('fr-DZ')} DA*`,
          ``,
          `🛡️ *Garantie :* 30 jours sur les pièces remplacées.`,
          `📍 *Adresse :* ${storeAddress}`,
          `⏰ *Horaires :* 09h00 - 20h00 (Samedi au Jeudi)`,
          ``,
          `Merci de votre confiance ! 📱✨`,
        ].join('\n');

      case 'QUOTE_APPROVAL_REQUIRED':
        return [
          `Bonjour *${order.customerName}*,`,
          ``,
          `🔍 Le diagnostic de votre appareil *${order.deviceModel}* (Ticket N° *${order.ticketNumber}*) est terminé chez *${storeName}*.`,
          ``,
          `📋 *Détail de l'intervention :* ${order.problemDescription}`,
          `💵 *Montant du Devis :* *${order.totalCost.toLocaleString('fr-DZ')} DA*`,
          ``,
          `Merci de nous confirmer par retour de message si vous validez la réparation.`,
          `📍 *${storeName}* — ${storeAddress}`,
        ].join('\n');

      case 'PARTS_DELAY_NOTICE':
        return [
          `Bonjour *${order.customerName}*,`,
          ``,
          `ℹ️ Suivi de réparation pour votre *${order.deviceModel}* (Ticket N° *${order.ticketNumber}*) :`,
          `Nous sommes en attente de réception des pièces détachées d'origine nécessaires pour finaliser l'intervention dans les meilleures conditions.`,
          ``,
          `Nous vous recontacterons dès que l'appareil sera prêt. Merci de votre patience !`,
          `📍 *${storeName}*`,
        ].join('\n');
    }
  }

  public static buildWhatsAppUrl(
    order: RepairOrder,
    settings: ReceiptSettings,
    type: RepairNotificationType = 'READY_FOR_PICKUP'
  ): string {
    const rawPhone = this.sanitizeAlgerianPhone(order.customerPhone || '');
    const message = this.generateMessageBody(order, settings, type);
    const encodedMessage = encodeURIComponent(message);
    return `https://api.whatsapp.com/send?phone=${rawPhone}&text=${encodedMessage}`;
  }

  public static dispatchWhatsAppNotification(
    order: RepairOrder,
    settings: ReceiptSettings,
    type: RepairNotificationType = 'READY_FOR_PICKUP'
  ): boolean {
    if (!order.customerPhone || order.customerPhone.trim().length < 8) {
      return false;
    }
    const url = this.buildWhatsAppUrl(order, settings, type);
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
}

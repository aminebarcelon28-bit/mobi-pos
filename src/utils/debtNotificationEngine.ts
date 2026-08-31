/**
 * Professional Customer Debt (Kredy) Statement with BaridiMob Coordinates
 * Author: Principal Systems Architect
 */
import type { Customer, CustomerDebtEntry, ReceiptSettings } from '../types/pos';
import { RepairNotificationEngine } from './repairNotificationEngine';

export class DebtNotificationEngine {
  public static generateDebtStatementMessage(
    customer: Customer,
    recentDebts: CustomerDebtEntry[],
    settings: ReceiptSettings
  ): string {
    const storeName = settings.storeName || 'MOBI ACCESSORIES';
    const storeAddress = settings.address || 'Boulevard Mohamed V, Alger Centre';
    const storePhone = settings.phone || '0550 00 00 00';
    const debtAmount = (customer.currentDebt || 0).toLocaleString('fr-DZ');

    const paymentMethodsBlock: string[] = [];
    paymentMethodsBlock.push(`💳 *Modes de Règlement Acceptés :*`);
    paymentMethodsBlock.push(`1. En magasin : Espèces`);

    if (settings.baridimobRip || settings.ccpAccount) {
      paymentMethodsBlock.push(`2. Virement à distance :`);
      if (settings.baridimobRip) {
        paymentMethodsBlock.push(`   • *RIP BaridiMob :* \`${settings.baridimobRip}\``);
      }
      if (settings.ccpAccount) {
        paymentMethodsBlock.push(`   • *Compte CCP :* \`${settings.ccpAccount}\``);
      }
      if (settings.bankBeneficiaryName) {
        paymentMethodsBlock.push(`   • *Bénéficiaire :* ${settings.bankBeneficiaryName}`);
      }
      paymentMethodsBlock.push(`   _(Merci d'envoyer la capture d'écran du reçu après virement)_`);
    }

    const debtLines = (recentDebts || [])
      .slice(0, 3)
      .map(
        (d) =>
          `• ${new Date(d.createdAt).toLocaleDateString('fr-DZ')} : *${d.amount.toLocaleString(
            'fr-DZ'
          )} DA* (${d.notes || d.type})`
      )
      .join('\n');

    return [
      `Bonjour *${customer.name}*,`,
      ``,
      `📄 *Relevé de Compte Client — ${storeName}*`,
      ``,
      `Nous vous transmettons le récapitulatif de votre situation comptable à ce jour :`,
      `💰 *Solde Restant Dû :* *${debtAmount} DA*`,
      ``,
      `📋 *Dernières Opérations :*`,
      debtLines || `• Solde global en compte : *${debtAmount} DA*`,
      ``,
      paymentMethodsBlock.join('\n'),
      ``,
      `📍 *Adresse :* ${storeAddress}`,
      `📞 *Contact :* ${storePhone}`,
      ``,
      `Merci pour votre confiance et votre collaboration ! ✨`,
    ].join('\n');
  }

  public static buildDebtReminderWhatsAppUrl(
    customer: Customer,
    recentDebts: CustomerDebtEntry[],
    settings: ReceiptSettings
  ): string {
    const rawPhone = RepairNotificationEngine.sanitizeAlgerianPhone(customer.phone);
    const message = this.generateDebtStatementMessage(customer, recentDebts, settings);
    return `https://api.whatsapp.com/send?phone=${rawPhone}&text=${encodeURIComponent(message)}`;
  }
}

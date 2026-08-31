/**
 * Professional Serialized Pre-Owned Warranty Certificate Builder (80mm ESC/POS)
 * Author: Principal Systems Architect
 */
import type { SaleTransaction, CartItem, ReceiptSettings } from '../types/pos';
import { EscPosBuilder } from './escpos';

export class WarrantyCertificateBuilder {
  public static buildPreOwnedWarrantyCertificate(
    transaction: SaleTransaction,
    item: CartItem,
    settings: ReceiptSettings,
    warrantyMonths: number = 3
  ): Uint8Array {
    const builder = new EscPosBuilder();
    const is80mm = settings.paperWidth !== '58mm';
    const separator = is80mm
      ? '================================================'
      : '================================';

    const startDate = new Date(transaction.createdAt);
    const expiryDate = new Date(startDate);
    expiryDate.setMonth(expiryDate.getMonth() + warrantyMonths);

    const startFormatted = startDate.toLocaleDateString('fr-DZ');
    const expiryFormatted = expiryDate.toLocaleDateString('fr-DZ');
    const imei = item.imeiNumber || item.serialNumber || 'Non spécifié';

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
      .newline()
      .text(separator)
      .newline()
      .bold(true)
      .text('CERTIFICAT DE GARANTIE APPAREIL OCCASION')
      .newline()
      .bold(false)
      .text(`Réf Garantie : GAR-${transaction.receiptNumber}`)
      .newline()
      .text(separator)
      .newline()
      .align('left')
      .bold(true)
      .text('DÉSIGNATION DE L\'APPAREIL GARANTI :')
      .newline()
      .bold(false)
      .text(`Modèle : ${item.product.title}`)
      .newline()
      .bold(true)
      .text(`N° IMEI / S/N : ${imei}`)
      .newline()
      .bold(false)
      .text(`Date d'Achat : ${startFormatted}`)
      .newline()
      .text(`Prix de Vente : ${item.appliedPrice.toLocaleString('fr-DZ')} DA`)
      .newline()
      .text(separator)
      .newline()
      .align('center')
      .bold(true)
      .text(`DURÉE DE GARANTIE : ${warrantyMonths} MOIS`)
      .newline()
      .text(`VALABLE DU ${startFormatted} AU ${expiryFormatted}`)
      .newline()
      .bold(false)
      .text(separator)
      .newline()
      .align('left')
      .bold(true)
      .text('CONDITIONS D\'APPLICATION :')
      .newline()
      .bold(false)
      .text(
        '1. Prise en charge des pannes matérielles internes (carte mère, audio, Face ID, connecteurs).'
      )
      .newline()
      .text('2. Ce certificat et la facture d\'origine sont obligatoires pour toute prise en charge.')
      .newline()
      .bold(true)
      .text('EXCLUSIONS DE GARANTIE :')
      .newline()
      .bold(false)
      .text('• Chocs physiques, écran ou vitre arrière brisée.')
      .newline()
      .text('• Traces d\'humidité ou immersion liquide (Oxydation).')
      .newline()
      .text('• Tentative de démontage ou modification logicielle non autorisée.')
      .newline()
      .text(separator)
      .newline()
      .align('center')
      .text('Code de Traçabilité SAV :')
      .newline()
      .barcode(imei.length >= 12 ? imei.slice(0, 15) : transaction.receiptNumber)
      .newline()
      .newline(2)
      .text('Cachet du Magasin :')
      .newline()
      .newline(2)
      .cut(false);

    return builder.build();
  }
}

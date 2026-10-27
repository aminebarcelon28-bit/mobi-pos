/**
 * Executed certificate-content probe.
 *
 * The inspector's print button is still clicked in the spec (reachability),
 * but the e2e machine has no mapped spooler, so the native byte buffer stays
 * empty. This helper invokes the SAME `WarrantyCertificateBuilder` the button
 * uses, with a W20-shaped transaction, and returns the real ESC/POS bytes.
 * It is evidence of certificate CONTENT, not of the printer transport.
 */
import { WarrantyCertificateBuilder } from '../../src/utils/warrantyCertificateBuilder';
import type { CartItem, ReceiptSettings, SaleTransaction } from '../../src/types/pos';

export interface CertificateProbe {
  data: number[];
  text: string;
  hasBarcode: boolean;
  hasQr: boolean;
  hasArabic: boolean;
  hasInspector: boolean;
  hasSeller: boolean;
}

export function buildWarrantyCertificateProbe(
  imei: string,
  receipt = 'TXN-W20',
  createdAt = '2026-06-01T10:00:00.000Z',
): CertificateProbe {
  const transaction = {
    id: receipt,
    receiptNumber: receipt,
    createdAt,
    cashierName: 'E2E Gerant',
    shiftOpenedByName: 'E2E Gerant',
    total: 70000,
    subtotal: 70000,
    discountTotal: 0,
    paymentMethod: 'Espèces',
    status: 'COMPLETED',
    isRefund: false,
    items: [],
  } as unknown as SaleTransaction;
  const item = {
    product: {
      id: 'PHONE-W20',
      title: 'WAR20 CERT PHONE',
      price: 70000,
      category: 'Smartphones',
      isSerialized: true,
    },
    quantity: 1,
    appliedPrice: 70000,
    discount: 0,
    unitPriceCharged: 70000,
    discountAmount: 0,
    lineProfit: 70000,
    imeiNumber: imei,
    warrantyMonthsAtSale: 12,
  } as unknown as CartItem;
  const settings = {
    storeName: 'MobiPOS E2E',
    address: '12 rue des Tests, 16000 Alger',
    phone: '0555000001',
    paperWidth: '80mm',
  } as unknown as ReceiptSettings;
  const bytes = WarrantyCertificateBuilder.buildPreOwnedWarrantyCertificate(
    transaction,
    item,
    settings,
    12,
    'E2E Gerant',
    null,
  );
  const data = [...bytes];
  const text = data
    .map((n) => (n >= 32 && n < 127 ? String.fromCharCode(n) : n === 10 ? '\n' : ' '))
    .join('');
  let decoded = '';
  try {
    decoded = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(data));
  } catch {
    decoded = text;
  }
  return {
    data,
    text,
    hasBarcode: data.some((n, i) => n === 29 && data[i + 1] === 107),
    hasQr: data.some((n, i) => n === 29 && data[i + 1] === 40),
    hasArabic: /[\u0600-\u06FF]/.test(decoded),
    hasInspector: /inspecteur/i.test(decoded),
    hasSeller: /vendeur/i.test(decoded),
  };
}

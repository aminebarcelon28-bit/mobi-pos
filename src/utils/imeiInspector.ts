/**
 * Complete IMEI Lifecycle & Warranty Audit Inspector
 * Author: Principal Systems Architect
 */
import type { ImeiLifecycleDossier, IMEIRecord, SaleTransaction, Product } from '../types/pos';
import { usePosStore } from '../store/usePosStore';

export class ImeiInspector {
  public static inspectDossier(imeiQuery: string): ImeiLifecycleDossier | null {
    const cleanImei = imeiQuery.trim();
    if (!cleanImei) return null;

    const state = usePosStore.getState();
    const imeiRecords: IMEIRecord[] = state.imeiRecords || [];
    const products: Product[] = state.products || [];
    const transactions: SaleTransaction[] = state.transactions || [];
    const repairOrders = state.repairOrders || [];

    const record = imeiRecords.find((r) => r.imei === cleanImei);
    const product = products.find(
      (p) => p.imeiNumber === cleanImei || (record && p.id === record.productId)
    );

    if (!record && !product) {
      return null;
    }

    const isSold = !!(record?.soldAt || record?.saleTransactionId);
    const soldAt = record?.soldAt;
    const warrantyExpiresAt = record?.warrantyExpiresAt || product?.warrantyExpiresAt;

    let isWarrantyValid = false;
    let daysRemaining: number | undefined = undefined;

    if (warrantyExpiresAt) {
      const expiry = new Date(warrantyExpiresAt).getTime();
      const now = Date.now();
      const diffDays = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      daysRemaining = diffDays;
      isWarrantyValid = diffDays >= 0;
    }

    let originalReceiptNumber: string | undefined = undefined;
    let originalCustomerName: string | undefined = undefined;
    let originalCustomerPhone: string | undefined = undefined;
    let purchasePrice: number | undefined = product?.price;

    if (record?.saleTransactionId) {
      const txn = transactions.find((t) => t.id === record.saleTransactionId);
      if (txn) {
        originalReceiptNumber = txn.receiptNumber;
        originalCustomerName = txn.customer?.name;
        originalCustomerPhone = txn.customer?.phone;
        const matchedItem = txn.items.find(
          (i) => i.product.id === product?.id || i.imeiNumber === cleanImei
        );
        if (matchedItem) {
          purchasePrice = matchedItem.appliedPrice;
        }
      }
    }

    const repairHistoryCount = repairOrders.filter((ro) => ro.imei === cleanImei).length;

    return {
      imei: cleanImei,
      productTitle: product?.title || 'Appareil Sérialisé',
      isSold,
      soldAt,
      warrantyExpiresAt,
      isWarrantyValid,
      daysRemaining,
      originalReceiptNumber,
      originalCustomerName,
      originalCustomerPhone,
      purchasePrice,
      repairHistoryCount,
    };
  }
}

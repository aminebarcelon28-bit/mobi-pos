import { db } from '../database';
import type { Product, Customer } from '../../types/pos';

export const backupRepository = {
  async exportJSON(): Promise<string> {
    const data = {
      exportedAt: new Date().toISOString(),
      version: '2.0.0-indexeddb',
      products: await db.products.toArray(),
      customers: await db.customers.toArray(),
      transactions: await db.transactions.toArray(),
      repairOrders: await db.repairOrders.toArray(),
      purchaseOrders: await db.purchaseOrders.toArray(),
      tradeIns: await db.tradeIns.toArray(),
      imeiRecords: await db.imeiRecords.toArray(),
      cashDrops: await db.cashDrops.toArray(),
      payouts: await db.payouts.toArray(),
      bundles: await db.bundles.toArray(),
      settings: await db.appSettings.toArray(),
    };
    return JSON.stringify(data, null, 2);
  },

  async importJSON(jsonString: string): Promise<{ success: boolean; reason?: string }> {
    try {
      const data = JSON.parse(jsonString);
      if (!data || typeof data !== 'object') {
        return { success: false, reason: 'Fichier JSON invalide' };
      }

      await db.transaction('rw', [
        db.products,
        db.customers,
        db.transactions,
        db.repairOrders,
        db.purchaseOrders,
        db.tradeIns,
        db.imeiRecords,
        db.cashDrops,
        db.payouts,
        db.bundles,
        db.appSettings,
      ], async () => {
        if (Array.isArray(data.products)) {
          await db.products.clear();
          await db.products.bulkPut(data.products);
        }
        if (Array.isArray(data.customers)) {
          await db.customers.clear();
          await db.customers.bulkPut(data.customers);
        }
        if (Array.isArray(data.transactions)) {
          await db.transactions.clear();
          await db.transactions.bulkPut(data.transactions);
        }
        if (Array.isArray(data.repairOrders)) {
          await db.repairOrders.clear();
          await db.repairOrders.bulkPut(data.repairOrders);
        }
        if (Array.isArray(data.purchaseOrders)) {
          await db.purchaseOrders.clear();
          await db.purchaseOrders.bulkPut(data.purchaseOrders);
        }
        if (Array.isArray(data.tradeIns)) {
          await db.tradeIns.clear();
          await db.tradeIns.bulkPut(data.tradeIns);
        }
        if (Array.isArray(data.imeiRecords)) {
          await db.imeiRecords.clear();
          await db.imeiRecords.bulkPut(data.imeiRecords);
        }
        if (Array.isArray(data.cashDrops)) {
          await db.cashDrops.clear();
          await db.cashDrops.bulkPut(data.cashDrops);
        }
        if (Array.isArray(data.payouts)) {
          await db.payouts.clear();
          await db.payouts.bulkPut(data.payouts);
        }
        if (Array.isArray(data.bundles)) {
          await db.bundles.clear();
          await db.bundles.bulkPut(data.bundles);
        }
        if (Array.isArray(data.settings)) {
          await db.appSettings.clear();
          await db.appSettings.bulkPut(data.settings);
        }
      });

      return { success: true };
    } catch (e: any) {
      return { success: false, reason: e?.message || 'Erreur lors de l’importation' };
    }
  },

  async seedDemoData(demoProducts: Product[], demoCustomers: Customer[]): Promise<void> {
    await db.products.clear();
    await db.customers.clear();
    await db.products.bulkPut(demoProducts);
    await db.customers.bulkPut(demoCustomers);
  },

  async clearAllData(): Promise<void> {
    await Promise.all([
      db.products.clear(),
      db.customers.clear(),
      db.transactions.clear(),
      db.repairOrders.clear(),
      db.purchaseOrders.clear(),
      db.tradeIns.clear(),
      db.imeiRecords.clear(),
      db.cashDrops.clear(),
      db.payouts.clear(),
      db.bundles.clear(),
    ]);
  },
};

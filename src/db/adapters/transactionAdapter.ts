import type {
  Product,
  Customer,
  SaleTransaction,
  SecurityAuditLogEntry,
} from '../../types/pos';
import { db as dexieDb } from '../database';
import { fireSync, isTauriEnv } from './base';
import { getLocalDb } from '../sqlPluginAdapter';

export const transactionAdapter = {
  async processSaleTransactionAtomic(
    transaction: SaleTransaction,
    updatedProducts: Product[],
    updatedCustomer?: Customer,
    auditEntry?: SecurityAuditLogEntry
  ): Promise<void> {
    // Persist to Dexie in single transaction
    await dexieDb.transaction('rw', [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs], async () => {
      await dexieDb.transactions.put(transaction);
      await dexieDb.products.bulkPut(updatedProducts);
      if (updatedCustomer) {
        await dexieDb.customers.put(updatedCustomer);
      }
      if (auditEntry) {
        await dexieDb.securityAuditLogs.put(auditEntry);
      }
    });
    if (updatedCustomer) void fireSync('customer', updatedCustomer.id, updatedCustomer);
    if (auditEntry) void fireSync('audit_log', auditEntry.id, auditEntry);
  },

  async getAllTransactions(): Promise<SaleTransaction[]> {
    return await dexieDb.transactions.toArray();
  },

  async voidTransactionAtomic(
    _transactionId: string,
    voidedTransaction: SaleTransaction,
    restoredProducts: Product[],
    updatedCustomer?: Customer,
    restoredImeis: string[] = [],
    auditEntry?: SecurityAuditLogEntry
  ): Promise<void> {
    await dexieDb.transaction('rw', [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs, dexieDb.imeiRecords], async () => {
      await dexieDb.transactions.put(voidedTransaction);
      if (restoredProducts.length > 0) {
        await dexieDb.products.bulkPut(restoredProducts);
      }
      if (updatedCustomer) {
        await dexieDb.customers.put(updatedCustomer);
      }
      if (auditEntry) {
        await dexieDb.securityAuditLogs.put(auditEntry);
      }
      if (restoredImeis.length > 0) {
        for (const imei of restoredImeis) {
          const rec = await dexieDb.imeiRecords.get(imei);
          if (rec) {
            await dexieDb.imeiRecords.put({
              ...rec,
              saleTransactionId: undefined,
              soldAt: undefined,
            });
          }
        }
      }
    });

    if (isTauriEnv() && restoredImeis.length > 0) {
      try {
        const db = await getLocalDb();
        for (const imei of restoredImeis) {
          await db.execute(
            'UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, version = version + 1 WHERE imei = $1',
            [imei]
          );
        }
      } catch (err) {
        console.warn('[db:void] Failed to reset restored IMEIs in SQLite:', err);
      }
    }

    if (restoredImeis.length > 0) {
      for (const imei of restoredImeis) {
        const rec = await dexieDb.imeiRecords.get(imei);
        if (rec) void fireSync('imei', imei, rec);
      }
    }

    if (updatedCustomer) void fireSync('customer', updatedCustomer.id, updatedCustomer);
    if (auditEntry) void fireSync('audit_log', auditEntry.id, auditEntry);
  },

  async processRefundAtomic(
    refundTransaction: SaleTransaction,
    updatedOriginalTransaction?: SaleTransaction,
    restockedProducts: Product[] = [],
    updatedCustomer?: Customer,
    restoredImeis: string[] = [],
    auditEntry?: SecurityAuditLogEntry
  ): Promise<void> {
    await dexieDb.transaction('rw', [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs, dexieDb.imeiRecords], async () => {
      await dexieDb.transactions.put(refundTransaction);
      if (updatedOriginalTransaction) {
        await dexieDb.transactions.put(updatedOriginalTransaction);
      }
      if (restockedProducts.length > 0) {
        await dexieDb.products.bulkPut(restockedProducts);
      }
      if (updatedCustomer) {
        await dexieDb.customers.put(updatedCustomer);
      }
      if (auditEntry) {
        await dexieDb.securityAuditLogs.put(auditEntry);
      }
      if (restoredImeis.length > 0) {
        for (const imei of restoredImeis) {
          const rec = await dexieDb.imeiRecords.get(imei);
          if (rec) {
            await dexieDb.imeiRecords.put({
              ...rec,
              saleTransactionId: undefined,
              soldAt: undefined,
            });
          }
        }
      }
    });

    if (isTauriEnv() && restoredImeis.length > 0) {
      try {
        const db = await getLocalDb();
        for (const imei of restoredImeis) {
          await db.execute(
            'UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, version = version + 1 WHERE imei = $1',
            [imei]
          );
        }
      } catch (err) {
        console.warn('[db:refund] Failed to reset restored IMEIs in SQLite:', err);
      }
    }

    if (restoredImeis.length > 0) {
      for (const imei of restoredImeis) {
        const rec = await dexieDb.imeiRecords.get(imei);
        if (rec) void fireSync('imei', imei, rec);
      }
    }

    if (updatedCustomer) void fireSync('customer', updatedCustomer.id, updatedCustomer);
    if (auditEntry) void fireSync('audit_log', auditEntry.id, auditEntry);
  },
};

import type {
  Product,
  Customer,
  SaleTransaction,
  SecurityAuditLogEntry,
} from '../../types/pos';
import { db as dexieDb } from '../database';
import { fireSync } from './base';

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
    _restoredImeis: string[] = [],
    auditEntry?: SecurityAuditLogEntry
  ): Promise<void> {
    await dexieDb.transaction('rw', [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs], async () => {
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
    });
    if (updatedCustomer) void fireSync('customer', updatedCustomer.id, updatedCustomer);
    if (auditEntry) void fireSync('audit_log', auditEntry.id, auditEntry);
  },

  async processRefundAtomic(
    refundTransaction: SaleTransaction,
    updatedOriginalTransaction?: SaleTransaction,
    restockedProducts: Product[] = [],
    updatedCustomer?: Customer,
    _restoredImeis: string[] = [],
    auditEntry?: SecurityAuditLogEntry
  ): Promise<void> {
    await dexieDb.transaction('rw', [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs], async () => {
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
    });
    if (updatedCustomer) void fireSync('customer', updatedCustomer.id, updatedCustomer);
    if (auditEntry) void fireSync('audit_log', auditEntry.id, auditEntry);
  },
};

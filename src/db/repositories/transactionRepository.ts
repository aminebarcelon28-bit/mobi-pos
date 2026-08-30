import { sqliteAdapter } from '../sqliteAdapter';
import type { SaleTransaction, Product, Customer, SecurityAuditLogEntry } from '../../types/pos';

export const transactionRepository = {
  async getAll(): Promise<SaleTransaction[]> {
    return await sqliteAdapter.getAllTransactions();
  },

  async save(transaction: SaleTransaction): Promise<void> {
    await sqliteAdapter.processSaleTransactionAtomic(
      transaction,
      [],
      transaction.customer || undefined,
      undefined
    );
  },

  async saveAtomicSale(
    transaction: SaleTransaction,
    updatedProducts: Product[],
    updatedCustomer?: Customer,
    auditEntry?: SecurityAuditLogEntry
  ): Promise<void> {
    await sqliteAdapter.processSaleTransactionAtomic(
      transaction,
      updatedProducts,
      updatedCustomer,
      auditEntry
    );
  },

  async findByReceipt(receiptNumber: string): Promise<SaleTransaction | undefined> {
    const txns = await sqliteAdapter.getAllTransactions();
    return txns.find((t) => t.receiptNumber.trim() === receiptNumber.trim());
  },

  async voidTransaction(
    transactionId: string,
    voidedTransaction: SaleTransaction,
    restoredProducts: Product[],
    updatedCustomer?: Customer,
    restoredImeis: string[] = [],
    auditEntry?: SecurityAuditLogEntry
  ): Promise<void> {
    await sqliteAdapter.voidTransactionAtomic(
      transactionId,
      voidedTransaction,
      restoredProducts,
      updatedCustomer,
      restoredImeis,
      auditEntry
    );
  },

  async processRefund(
    refundTransaction: SaleTransaction,
    updatedOriginalTransaction?: SaleTransaction,
    restockedProducts: Product[] = [],
    updatedCustomer?: Customer,
    restoredImeis: string[] = [],
    auditEntry?: SecurityAuditLogEntry
  ): Promise<void> {
    await sqliteAdapter.processRefundAtomic(
      refundTransaction,
      updatedOriginalTransaction,
      restockedProducts,
      updatedCustomer,
      restoredImeis,
      auditEntry
    );
  },

  async clearAll(): Promise<void> {
    // Clear handled by db reset
  },
};

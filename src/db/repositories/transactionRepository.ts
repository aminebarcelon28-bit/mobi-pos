import type { SaleTransaction, Product, Customer, SecurityAuditLogEntry } from '../../types/pos';

// P11.3: resolve the sqliteAdapter barrel lazily — a static import pins the whole
// DB graph (adapters -> dexie + libsql) into the importing chunk.
async function getSqlite() {
  const { sqliteAdapter } = await import('../sqliteAdapter');
  return sqliteAdapter;
}

export const transactionRepository = {
  async getAll(): Promise<SaleTransaction[]> {
    return await (await getSqlite()).getAllTransactions();
  },

  async save(transaction: SaleTransaction): Promise<void> {
    await (await getSqlite()).processSaleTransactionAtomic(
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
    await (await getSqlite()).processSaleTransactionAtomic(
      transaction,
      updatedProducts,
      updatedCustomer,
      auditEntry
    );
  },

  async findByReceipt(receiptNumber: string): Promise<SaleTransaction | undefined> {
    const txns = await (await getSqlite()).getAllTransactions();
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
    await (await getSqlite()).voidTransactionAtomic(
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
    await (await getSqlite()).processRefundAtomic(
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

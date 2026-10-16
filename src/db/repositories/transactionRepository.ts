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
    // UPGRADE-01 safety rail: index-direct receipt lookup
    // (idx_transactions_receipt). Scanning the store's bounded window would
    // silently miss a receipt older than the newest 200 tickets.
    const clean = String(receiptNumber ?? '').trim();
    if (!clean) return undefined;
    return await (await getSqlite()).getTransactionByReceipt(clean);
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
    auditEntry?: SecurityAuditLogEntry,
    policy?: { localDeviceId: string; activeShiftId: string | null; online: boolean }
  ): Promise<void> {
    await (await getSqlite()).processRefundAtomic(
      refundTransaction,
      updatedOriginalTransaction,
      restockedProducts,
      updatedCustomer,
      restoredImeis,
      auditEntry,
      policy
    );
  },

  async clearAll(): Promise<void> {
    // Clear handled by db reset
  },
};

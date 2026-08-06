import { db } from '../database';
import type { SaleTransaction } from '../../types/pos';

export const transactionRepository = {
  async getAll(): Promise<SaleTransaction[]> {
    return await db.transactions.toArray();
  },

  async save(transaction: SaleTransaction): Promise<void> {
    await db.transactions.put(transaction);
  },

  async findByReceipt(receiptNumber: string): Promise<SaleTransaction | undefined> {
    return await db.transactions.where('receiptNumber').equals(receiptNumber.trim()).first();
  },

  async bulkSave(transactions: SaleTransaction[]): Promise<void> {
    await db.transactions.bulkPut(transactions);
  },

  async clearAll(): Promise<void> {
    await db.transactions.clear();
  },
};

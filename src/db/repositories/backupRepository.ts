import { sqliteAdapter } from '../sqliteAdapter';
import type { Product, Customer } from '../../types/pos';

export const backupRepository = {
  async exportJSON(): Promise<string> {
    return await sqliteAdapter.exportJSON();
  },

  async importJSON(jsonString: string): Promise<{ success: boolean; reason?: string }> {
    return await sqliteAdapter.importJSON(jsonString);
  },

  async seedDemoData(demoProducts: Product[], demoCustomers: Customer[]): Promise<void> {
    await sqliteAdapter.clearAllData();
    await sqliteAdapter.bulkSaveProducts(demoProducts);
    await sqliteAdapter.bulkSaveCustomers(demoCustomers);
  },

  async clearAllData(): Promise<void> {
    await sqliteAdapter.clearAllData();
  },

  async backupToFile(destPath: string): Promise<string> {
    return await sqliteAdapter.backupToFile(destPath);
  },
};

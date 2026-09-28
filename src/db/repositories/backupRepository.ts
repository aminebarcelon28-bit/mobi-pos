import type { Product, Customer } from '../../types/pos';

// P11.3: resolve the sqliteAdapter barrel lazily — a static import pins the whole
// DB graph (adapters -> dexie + libsql) into the importing chunk.
async function getSqlite() {
  const { sqliteAdapter } = await import('../sqliteAdapter');
  return sqliteAdapter;
}

export const backupRepository = {
  async exportJSON(): Promise<string> {
   return await (await getSqlite()).exportJSON();
  },

  async importJSON(jsonString: string): Promise<{ success: boolean; reason?: string }> {
   return await (await getSqlite()).importJSON(jsonString);
  },

  async seedDemoData(demoProducts: Product[], demoCustomers: Customer[]): Promise<void> {
   const sqlite = await getSqlite();
   await sqlite.clearAllData();
   await sqlite.bulkSaveProducts(demoProducts);
   await sqlite.bulkSaveCustomers(demoCustomers);
  },

  async clearAllData(): Promise<void> {
   await (await getSqlite()).clearAllData();
  },

  async backupToFile(destPath: string): Promise<string> {
   return await (await getSqlite()).backupToFile(destPath);
  },
};

import type { IMEIRecord } from '../../types/pos';

// P11.3: resolve the sqliteAdapter barrel lazily — a static import pins the whole
// DB graph (adapters -> dexie + libsql) into the importing chunk.
async function getSqlite() {
  const { sqliteAdapter } = await import('../sqliteAdapter');
  return sqliteAdapter;
}

export const imeiRepository = {
  async getAll(): Promise<IMEIRecord[]> {
   return await (await getSqlite()).getAllIMEIRecords();
  },

  async save(record: IMEIRecord): Promise<void> {
   await (await getSqlite()).saveIMEIRecord(record);
  },
};

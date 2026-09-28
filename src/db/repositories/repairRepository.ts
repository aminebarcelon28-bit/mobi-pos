import type { RepairOrder } from '../../types/pos';

// P11.3: resolve the sqliteAdapter barrel lazily — a static import pins the whole
// DB graph (adapters -> dexie + libsql) into the importing chunk.
async function getSqlite() {
  const { sqliteAdapter } = await import('../sqliteAdapter');
  return sqliteAdapter;
}

export const repairRepository = {
  async getAll(): Promise<RepairOrder[]> {
   return await (await getSqlite()).getAllRepairOrders();
  },

  async save(repair: RepairOrder): Promise<void> {
   await (await getSqlite()).saveRepairOrder(repair);
  },

  async bulkSave(repairs: RepairOrder[]): Promise<void> {
    for (const r of repairs) {
    await (await getSqlite()).saveRepairOrder(r);
    }
  },

  async delete(id: string): Promise<void> {
   await (await getSqlite()).deleteRepairOrder(id);
  },

  async clearAll(): Promise<void> {
   const sqlite = await getSqlite();
   const repairs = await sqlite.getAllRepairOrders();
    for (const r of repairs) {
    await sqlite.deleteRepairOrder(r.id);
    }
  },
};

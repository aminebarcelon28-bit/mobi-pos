import { sqliteAdapter } from '../sqliteAdapter';
import type { RepairOrder } from '../../types/pos';

export const repairRepository = {
  async getAll(): Promise<RepairOrder[]> {
    return await sqliteAdapter.getAllRepairOrders();
  },

  async save(repair: RepairOrder): Promise<void> {
    await sqliteAdapter.saveRepairOrder(repair);
  },

  async bulkSave(repairs: RepairOrder[]): Promise<void> {
    for (const r of repairs) {
      await sqliteAdapter.saveRepairOrder(r);
    }
  },

  async delete(id: string): Promise<void> {
    await sqliteAdapter.deleteRepairOrder(id);
  },

  async clearAll(): Promise<void> {
    const repairs = await sqliteAdapter.getAllRepairOrders();
    for (const r of repairs) {
      await sqliteAdapter.deleteRepairOrder(r.id);
    }
  },
};

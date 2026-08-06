import { db } from '../database';
import type { RepairOrder } from '../../types/pos';

export const repairRepository = {
  async getAll(): Promise<RepairOrder[]> {
    return await db.repairOrders.toArray();
  },

  async save(repair: RepairOrder): Promise<void> {
    await db.repairOrders.put(repair);
  },

  async bulkSave(repairs: RepairOrder[]): Promise<void> {
    await db.repairOrders.bulkPut(repairs);
  },

  async delete(id: string): Promise<void> {
    await db.repairOrders.delete(id);
  },

  async clearAll(): Promise<void> {
    await db.repairOrders.clear();
  },
};

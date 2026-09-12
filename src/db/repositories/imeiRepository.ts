import { sqliteAdapter } from '../sqliteAdapter';
import type { IMEIRecord } from '../../types/pos';

export const imeiRepository = {
  async getAll(): Promise<IMEIRecord[]> {
    return await sqliteAdapter.getAllIMEIRecords();
  },

  async save(record: IMEIRecord): Promise<void> {
    await sqliteAdapter.saveIMEIRecord(record);
  },
};

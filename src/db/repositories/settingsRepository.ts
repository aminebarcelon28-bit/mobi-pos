import { db } from '../database';

export const settingsRepository = {
  async get<T>(key: string, fallback: T): Promise<T> {
    try {
      const item = await db.appSettings.get(key);
      if (item && item.value !== undefined) {
        return item.value as T;
      }
    } catch (e) {
      console.error(`Failed to read setting [${key}] from IndexedDB:`, e);
    }
    return fallback;
  },

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await db.appSettings.put({ key, value });
    } catch (e) {
      console.error(`Failed to save setting [${key}] to IndexedDB:`, e);
    }
  },

  async remove(key: string): Promise<void> {
    await db.appSettings.delete(key);
  },
};

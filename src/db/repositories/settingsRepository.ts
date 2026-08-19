import { sqliteAdapter } from '../sqliteAdapter';

export const settingsRepository = {
  async get<T>(key: string, fallback: T): Promise<T> {
    try {
      return await sqliteAdapter.getSetting<T>(key, fallback);
    } catch (e) {
      console.error(`Failed to read setting [${key}]:`, e);
      return fallback;
    }
  },

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await sqliteAdapter.setSetting(key, value);
    } catch (e) {
      console.error(`Failed to save setting [${key}]:`, e);
    }
  },

  async remove(key: string): Promise<void> {
    try {
      await sqliteAdapter.setSetting(key, null);
    } catch (e) {
      console.error(`Failed to remove setting [${key}]:`, e);
    }
  },
};

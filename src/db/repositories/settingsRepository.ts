
// P11.3: resolve the sqliteAdapter barrel lazily — a static import pins the whole
// DB graph (adapters -> dexie + libsql) into the importing chunk.
async function getSqlite() {
  const { sqliteAdapter } = await import('../sqliteAdapter');
  return sqliteAdapter;
}

export const settingsRepository = {
  async get<T>(key: string, fallback: T): Promise<T> {
    try {
      return await (await getSqlite()).getSetting<T>(key, fallback);
    } catch (e) {
      console.error(`Failed to read setting [${key}]:`, e);
      return fallback;
    }
  },

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await (await getSqlite()).setSetting(key, value);
    } catch (e) {
      console.error(`Failed to save setting [${key}]:`, e);
      throw e;
    }
  },

  async remove(key: string): Promise<void> {
    try {
      await (await getSqlite()).setSetting(key, null);
    } catch (e) {
      console.error(`Failed to remove setting [${key}]:`, e);
    }
  },
};

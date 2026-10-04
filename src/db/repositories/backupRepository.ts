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

  async importJSON(jsonString: string, opts?: { actor?: string }): Promise<{ success: boolean; reason?: string; auditOk?: boolean }> {
   return await (await getSqlite()).importJSON(jsonString, opts);
  },

  async clearAllData(): Promise<void> {
   await (await getSqlite()).clearAllData();
  },

  async backupToFile(destPath: string): Promise<string> {
   return await (await getSqlite()).backupToFile(destPath);
  },
};

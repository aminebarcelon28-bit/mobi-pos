// Local database backup & disaster rollback manager.
// Ensures pristine copies of mobi_pos.db and Dexie data exist BEFORE
// any migration or cloud sync operation touches local state.

import {
  createDatabaseBackup as apiCreateDatabaseBackup,
  restoreDatabaseBackup as apiRestoreDatabaseBackup,
  listDatabaseBackups as apiListDatabaseBackups,
  swapStagingDatabase as apiSwapStagingDatabase,
} from '../api/backup';
import { db as dexieDb } from './database';

const isTauri = (): boolean => {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI_INTERNALS__ || (window as unknown as { __TAURI__?: unknown }).__TAURI__);
};

export interface LocalBackupResult {
  success: boolean;
  sqliteBackupPath?: string;
  dexieBackupSnapshot?: string;
  timestamp: string;
  error?: string;
}

/**
 * Creates an automatic full backup of the local SQLite database file and a Dexie snapshot.
 * Must be executed BEFORE first-sync migration or account changes.
 */
export async function createPreMigrationBackup(): Promise<LocalBackupResult> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let sqliteBackupPath: string | undefined;

  // 1. Native SQLite .db copy
  if (isTauri()) {
    try {
      sqliteBackupPath = await apiCreateDatabaseBackup();
    } catch (e) {
      console.warn('Native SQLite backup error:', e);
    }
  }

  // 2. Dexie full snapshot
  let dexieSnapshotKey = '';
  try {
    const dexieSnapshot = {
      timestamp: new Date().toISOString(),
      products: await dexieDb.products.toArray(),
      customers: await dexieDb.customers.toArray(),
      transactions: await dexieDb.transactions.toArray(),
      repairOrders: await dexieDb.repairOrders.toArray(),
      purchaseOrders: await dexieDb.purchaseOrders.toArray(),
      tradeIns: await dexieDb.tradeIns.toArray(),
      imeiRecords: await dexieDb.imeiRecords.toArray(),
      securityAuditLogs: await dexieDb.securityAuditLogs.toArray(),
      cashDrops: await dexieDb.cashDrops.toArray(),
      payouts: await dexieDb.payouts.toArray(),
      bundles: await dexieDb.bundles.toArray(),
      customerDebts: await dexieDb.customerDebts.toArray(),
      storeExpenses: await dexieDb.storeExpenses.toArray(),
      cashSessions: await dexieDb.cashSessions.toArray(),
      cashMovements: await dexieDb.cashMovements.toArray(),
      appSettings: await dexieDb.appSettings.toArray(),
    };
    dexieSnapshotKey = `mobi_pos_backup_dexie_${timestamp}`;
    try {
      localStorage.setItem(dexieSnapshotKey, JSON.stringify(dexieSnapshot));
    } catch (storageErr) {
      console.warn('Dexie snapshot localStorage quota exceeded or write failed:', storageErr);
      dexieSnapshotKey = '';
    }
  } catch (e) {
    console.error('Dexie snapshot generation failed:', e);
  }

  const isSuccess = Boolean(sqliteBackupPath || dexieSnapshotKey);
  return {
    success: isSuccess,
    sqliteBackupPath,
    dexieBackupSnapshot: dexieSnapshotKey || undefined,
    timestamp,
    error: isSuccess ? undefined : 'Sauvegarde locale impossible: échec SQLite et quota stockage dépassé',
  };
}

/**
 * Rollback helper: restores a specified SQLite backup file.
 */
export async function restoreLocalDatabaseFile(backupPath: string): Promise<boolean> {
  if (isTauri()) {
    try {
      await apiRestoreDatabaseBackup(backupPath);
      return true;
    } catch (e) {
      console.error('Failed to restore local database backup:', e);
      throw e;
    }
  }
  return false;
}

/**
 * List available local SQLite file backups.
 */
export async function listLocalDatabaseBackups(): Promise<string[]> {
  if (isTauri()) {
    try {
      return await apiListDatabaseBackups();
    } catch (e) {
      console.warn('Failed to list backups:', e);
      return [];
    }
  }
  return [];
}

/**
 * Swap a validated staging database into active mobi_pos.db (used during cloud restore).
 */
export async function swapStagingDatabase(stagingFilename: string): Promise<void> {
  if (isTauri()) {
    await apiSwapStagingDatabase(stagingFilename);
  }
}

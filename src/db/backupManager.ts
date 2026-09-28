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

  // 2. Dexie full snapshot — purge first so the write itself is less likely
  // to hit quota, then keep only the last 3 snapshots afterwards.
  purgeOldDexieSnapshots(3);
  let dexieSnapshotKey = '';
  let quotaExceeded = false;
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
      // B-015: mirror tables added after the original snapshot list froze —
      // without them a restore drops FIFO cost basis, vouchers, ledger, outbox.
      stockBatches: await dexieDb.stockBatches.toArray(),
      creditVouchers: await dexieDb.creditVouchers.toArray(),
      inventoryLedger: await dexieDb.inventoryLedger.toArray(),
      syncOutbox: await dexieDb.syncOutbox.toArray(),
      // Frozen FIFO allocation rows + pending checkout recovery intents:
      // without them a restore loses per-batch COGS (reports fall back to
      // stale stored costs) and drops in-flight sales recovery. Restoring
      // intents is safe: replay-after-commit short-circuits in the adapter.
      saleBatchAllocations: await dexieDb.saleBatchAllocations.toArray(),
      checkoutRecoveryIntents: await dexieDb.checkoutRecoveryIntents.toArray(),
    };
    dexieSnapshotKey = `mobi_pos_backup_dexie_${timestamp}`;
    try {
      localStorage.setItem(dexieSnapshotKey, JSON.stringify(dexieSnapshot));
      // Retention: keep only the last 3 snapshots — unbounded snapshot growth
      // is itself a quota time-bomb on low-end devices.
      purgeOldDexieSnapshots(3);
    } catch (storageErr) {
      quotaExceeded =
        typeof DOMException !== 'undefined' &&
        storageErr instanceof DOMException &&
        (storageErr.name === 'QuotaExceededError' || storageErr.code === 22);
      console.error(
        `Dexie snapshot localStorage write FAILED${quotaExceeded ? ' (quota exceeded)' : ''}:`,
        storageErr,
      );
      dexieSnapshotKey = '';
    }
  } catch (e) {
    console.error('Dexie snapshot generation failed:', e);
  }

  // Success contract (B2): the Dexie snapshot below is a read-mirror copy only —
  // it cannot rebuild mobi_pos.db, so inside Tauri it must NOT count as a backup.
  // Success requires the native SQLite file copy; otherwise the pre-migration
  // gate (migrationManager aborts when success is false) would let a migration
  // run with no restorable backup. In pure web builds there is no native file,
  // so the Dexie snapshot is the only backup and counts.
  const isSuccess = isTauri() ? Boolean(sqliteBackupPath) : Boolean(dexieSnapshotKey);
  // Quota is fatal ONLY where the snapshot is the only copy (pure web): fail
  // loudly instead of warn-only. Inside Tauri the native SQLite file is the
  // authority and the snapshot is a convenience mirror, so a quota miss stays
  // a loud console error without failing the backup.
  const error = isSuccess
    ? undefined
    : isTauri()
      ? 'Sauvegarde locale impossible: échec de la copie SQLite native'
      : quotaExceeded
        ? 'Sauvegarde locale impossible: quota de stockage dépassé — supprimez d\'anciennes sauvegardes (seules les 3 dernières sont conservées automatiquement) puis réessayez'
        : 'Sauvegarde locale impossible: écriture du snapshot local refusée';
  if (!isTauri() && !isSuccess) {
    console.error(`[backup] Pre-migration backup FAILED (web, snapshot is the only copy): ${error}`);
  }
  return {
    success: isSuccess,
    sqliteBackupPath,
    dexieBackupSnapshot: dexieSnapshotKey || undefined,
    timestamp,
    error,
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

// ---------------------------------------------------------------------------
// Dexie-snapshot restore (B2): the mirror-rebuild path.
// ---------------------------------------------------------------------------

const DEXIE_SNAPSHOT_PREFIX = 'mobi_pos_backup_dexie_';

/** Mirror tables captured by createPreMigrationBackup — must stay in sync with it. */
const DEXIE_SNAPSHOT_TABLES = [
  'products',
  'customers',
  'transactions',
  'repairOrders',
  'purchaseOrders',
  'tradeIns',
  'imeiRecords',
  'securityAuditLogs',
  'cashDrops',
  'payouts',
  'bundles',
  'customerDebts',
  'storeExpenses',
  'cashSessions',
  'cashMovements',
  'appSettings',
  // B-015: keep in sync with createPreMigrationBackup's snapshot builder.
  'stockBatches',
  'creditVouchers',
  'inventoryLedger',
  'syncOutbox',
  // Frozen FIFO allocations + recovery intents (see builder comment). Old
  // snapshots lack these keys and restore skips them gracefully below.
  'saleBatchAllocations',
  'checkoutRecoveryIntents',
] as const;

export interface DexieSnapshotRestoreResult {
  success: boolean;
  tablesRestored: number;
  recordsRestored: number;
  error?: string;
}

interface WritableMirrorTable {
  clear(): Promise<void>;
  bulkPut(rows: unknown[]): Promise<unknown>;
}

/**
 * Deletes all but the newest `keep` Dexie snapshots. Retention bound so
 * localStorage growth cannot itself trigger quota failures on low-end
 * devices. Returns the number of snapshots removed. Never throws.
 */
export function purgeOldDexieSnapshots(keep = 3): number {
  try {
    const all = listDexieSnapshots();
    const stale = all.slice(Math.max(0, keep));
    for (const key of stale) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Storage restricted — best effort.
      }
    }
    if (stale.length > 0) {
      console.info(`[backup] Purged ${stale.length} stale Dexie snapshot(s), kept ${Math.min(keep, all.length)}`);
    }
    return stale.length;
  } catch {
    return 0;
  }
}

/**
 * Lists locally stored Dexie snapshots, newest first (ISO timestamp in key).
 */
export function listDexieSnapshots(): string[] {
  if (typeof localStorage === 'undefined') return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(DEXIE_SNAPSHOT_PREFIX)) out.push(key);
    }
  } catch {
    // Storage restricted
  }
  return out.sort().reverse();
}

/**
 * Restores the Dexie read-mirror from a snapshot taken by createPreMigrationBackup.
 *
 * Scope contract: this rebuilds the MIRROR only (browser preview / Dexie readers).
 * The live store on Tauri is SQLite (plugin-sql) — a native .db file restore
 * (restoreLocalDatabaseFile) remains the authoritative disaster-recovery path.
 * Typical use: after swapping in a native backup, refresh the stale mirror
 * from the pre-migration snapshot instead of re-downloading everything.
 *
 * Throws on missing/corrupt snapshots — never reports a false success.
 */
export async function restoreDexieSnapshot(snapshotKey: string): Promise<DexieSnapshotRestoreResult> {
  if (!snapshotKey || !snapshotKey.startsWith(DEXIE_SNAPSHOT_PREFIX)) {
    throw new Error(`Clé de snapshot invalide: ${snapshotKey}`);
  }
  if (typeof localStorage === 'undefined') {
    throw new Error('Stockage local indisponible pour la restauration du snapshot');
  }
  const raw = localStorage.getItem(snapshotKey);
  if (!raw) {
    throw new Error(`Snapshot introuvable: ${snapshotKey}`);
  }
  let snapshot: Record<string, unknown>;
  try {
    snapshot = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Snapshot corrompu (JSON invalide): ${snapshotKey}`);
  }
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error(`Snapshot corrompu (contenu invalide): ${snapshotKey}`);
  }

  let tablesRestored = 0;
  let recordsRestored = 0;

  // One transaction: all mirror tables swap atomically, never half-restored.
  await dexieDb.transaction('rw', dexieDb.tables, async () => {
    for (const name of DEXIE_SNAPSHOT_TABLES) {
      const rows = snapshot[name];
      if (!Array.isArray(rows)) {
        console.warn(`[backup] snapshot table "${name}" absente ou invalide, ignorée`);
        continue;
      }
      const table = (dexieDb as unknown as Record<string, WritableMirrorTable | undefined>)[name];
      if (!table) continue;
      await table.clear();
      if (rows.length > 0) {
        await table.bulkPut(rows);
      }
      tablesRestored++;
      recordsRestored += rows.length;
    }
  });

  if (tablesRestored === 0) {
    throw new Error(`Snapshot vide ou illisible: ${snapshotKey}`);
  }
  return { success: true, tablesRestored, recordsRestored };
}

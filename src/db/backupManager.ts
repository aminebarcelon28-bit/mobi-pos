// Local database backup & disaster rollback manager.
// Ensures pristine copies of mobi_pos.db and Dexie data exist BEFORE
// any migration or cloud sync operation touches local state.

import {
  createDatabaseBackup as apiCreateDatabaseBackup,
  listDatabaseBackups as apiListDatabaseBackups,
  type DatabaseBackupMeta,
  type SnapshotKind,
} from '../api/backup';
import { db as dexieDb } from './database';
import { utcNowIso } from '../utils/dateUtils';

const isTauri = (): boolean => {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI_INTERNALS__ || (window as unknown as { __TAURI__?: unknown }).__TAURI__);
};

export interface LocalBackupResult {
  success: boolean;
  sqliteBackupPath?: string;
  /** Stage 1/E: native snapshot identity + integrity (audit rows use `snapshotId`, never the path). */
  snapshotId?: string;
  snapshotBytes?: number;
  snapshotMtimeMs?: number;
  snapshotSha256?: string;
  dexieBackupSnapshot?: string;
  timestamp: string;
  error?: string;
}

/**
 * Creates an automatic full backup of the local SQLite database file and a Dexie snapshot.
 * Must be executed BEFORE first-sync migration or account changes.
 *
 * Stage 1/E: the native side is now the SQLite online backup API (single
 * read transaction, integrity-checked, hashed) instead of a raw file copy.
 * `kind` files the snapshot into its filename (wipe/restore/migration/manual).
 */
export async function createPreMigrationBackup(kind: SnapshotKind = 'manual'): Promise<LocalBackupResult> {
  const timestamp = utcNowIso().replace(/[:.]/g, '-');
  let sqliteBackupPath: string | undefined;
  let snapshotMeta: DatabaseBackupMeta | undefined;

  // 1. Native SQLite snapshot (online backup API)
  if (isTauri()) {
    try {
      snapshotMeta = await apiCreateDatabaseBackup(kind);
      sqliteBackupPath = snapshotMeta.path;
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
      timestamp: utcNowIso(),
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
    snapshotId: snapshotMeta?.id,
    snapshotBytes: snapshotMeta?.bytes,
    snapshotMtimeMs: snapshotMeta?.mtimeMs,
    snapshotSha256: snapshotMeta?.sha256,
    dexieBackupSnapshot: dexieSnapshotKey || undefined,
    timestamp,
    error,
  };
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

// ---------------------------------------------------------------------------
// Dexie-snapshot retention (B2).
// ---------------------------------------------------------------------------
// FT-06: the Dexie-snapshot RESTORE helper was deleted — it had zero callers
// and its clear()+bulkPut() swap replaced newer mirror rows (including audit)
// with a stale subset. Snapshots are still TAKEN (createPreMigrationBackup
// above; capturing evidence is fine) and pruned below. Restoring mirror
// state goes through the guarded JSON import / cloud merge paths, which
// preserve the audit trail (see maintenanceAdapter.importJSON,
// restoreManager.executeRestore).

const DEXIE_SNAPSHOT_PREFIX = 'mobi_pos_backup_dexie_';

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

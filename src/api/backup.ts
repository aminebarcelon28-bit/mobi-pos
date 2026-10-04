// SQLite WAL Backup API wrappers (rules.md R6.2, R3.12)
//
// FT-06: `restore_database_backup` and `swap_staging_database` were removed
// from the native handler (Phase 4.4, src-tauri/src/lib.rs) — their wrappers
// are deleted here too, not left to throw at runtime. Restoring either
// requires PIN + audit + schema validation (deferred until a real restore
// feature exists).
import { invokeCommand } from '../platform/invoke';

/** Snapshot kinds, filed into the filename. Unknown kinds are rejected natively. */
export type SnapshotKind = 'wipe' | 'restore' | 'migration' | 'manual';

/**
 * Stage 1/E snapshot receipt. Referenced by FILENAME/ID (`id`), never by
 * absolute path, in every audit row — `path` is display-only.
 */
export interface DatabaseBackupMeta {
  id: string;
  bytes: number;
  mtimeMs: number;
  sha256: string;
  path: string;
}

export async function createDatabaseBackup(kind: SnapshotKind = 'manual'): Promise<DatabaseBackupMeta> {
  return invokeCommand<DatabaseBackupMeta>('create_database_backup', { kind });
}

export async function listDatabaseBackups(): Promise<string[]> {
  return invokeCommand<string[]>('list_database_backups');
}

export interface PrunePolicy {
  keepLast?: number;
  olderThanSecs?: number;
}

export interface PruneReport {
  scanned: number;
  kept: number;
  deleted: string[];
}

/**
 * Phase 3: manual snapshot prune. The PIN is verified INSIDE the native
 * command through the unmodified pin_verify (wrong PINs burn the existing
 * ladder); floors (keep_last >= 1, older_than >= 7d) are enforced natively.
 * No UI is wired to this yet — future admin UI only.
 */
export async function pruneSnapshots(pin: string, policy: PrunePolicy = {}): Promise<PruneReport> {
  return invokeCommand<PruneReport>('prune_snapshots', {
    request: { pin, keepLast: policy.keepLast, olderThanSecs: policy.olderThanSecs },
  });
}

export interface DecryptedSnapshot {
  id: string;
  decryptedFile: string;
  bytes: number;
}

/**
 * Phase 4d manual-recovery decrypt. Produces a PLAINTEXT working copy of a
 * sealed snapshot for operator copy-out (runbook step); the sealed original
 * is never modified. Fresh manager PIN verified INSIDE natively (wrong PINs
 * burn the ladder); kernel audit row `Décryptage Snapshot Secours` on every
 * success. No UI is wired to this yet — manual recovery only.
 */
export async function decryptSnapshotForRecovery(snapshotId: string, pin: string): Promise<DecryptedSnapshot> {
  return invokeCommand<DecryptedSnapshot>('decrypt_snapshot_for_recovery', {
    request: { snapshotId, pin },
  });
}
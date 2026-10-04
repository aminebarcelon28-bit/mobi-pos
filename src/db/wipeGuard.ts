/**
 * FT-06 — guarded full wipe (Track 1A).
 *
 * Any full wipe MUST go through `requestDataWipe`. Order is load-bearing:
 *
 *   1. Tauri runtime check — outside Tauri the wipe fails closed. There is
 *      no native kernel to verify the manager PIN, take a snapshot, or chain
 *      the pre-wipe row, so there is no safe wipe either.
 *   2. Fresh native manager PIN (`verifyManagerStepUp`, `allowWeakFallback:
 *      false`) — no window, no weak fallback. A cashier PIN never passes
 *      (verified against `userId: 'manager'`).
 *   3. WAL checkpoint (`checkpointWalStrict`, TRUNCATE). A snapshot taken over
 *      an un-checkpointed WAL can miss committed frames. Incomplete/busy or
 *      failed checkpoint aborts before anything is written or deleted, and
 *      the message is surfaced to the user.
 *   4. Pre-wipe native snapshot (`createPreMigrationBackup`, i.e. the
 *      `create_database_backup` file copy + Dexie snapshot). Snapshot failure
 *      aborts before anything is written or deleted.
 *      Why not `export_snapshot` directly: it is a Rust-internal helper with
 *      no Tauri command surface in 1A (only `emergency_export_ledger` uses
 *      it) — exposing it would be new Rust surface, DEFERRED TO 1B. The
 *      backup command is the established native pre-mutation snapshot with
 *      fail-closed semantics, already used by restore and migration flows.
 *      Known limits of that snapshot (1B candidates, not fixed here): raw
 *      file copy (no SQLite backup API; checkpoint-by-caller-convention, see
 *      lib.rs), no rotation/pruning (unbounded `backups/` growth; a deleted
 *      file would dangle the snapshotPath below), stored unencrypted.
 *   5. `DATA_WIPE_BEFORE` appended NATIVELY (`audit_append`, chained). Throw
 *      → abort the wipe. The row lands before any deletion, so the intent
 *      is on record even if the wipe itself later fails partway.
 *   6. Only then `clearAllData()` — which itself never touches
 *      `security_audit_logs` / `audit_chain` in either lane (FT-06
 *      preservation), so the pre-wipe row and all history survive.
 *
 * ACCESS_DENIED in 1A covers only denials the TS layer observes. Native IPC
 * denials stay stderr-only until 1B.
 */

import { auditAppend } from '../api/audit';
import { createPreMigrationBackup } from './backupManager';
import { isTauriRuntime, verifyManagerStepUp } from '../utils/auditGate';

export const DATA_WIPE_BEFORE_ACTION = 'DATA_WIPE_BEFORE';

export type WipeRefusalReason =
  | 'unavailable'
  | 'denied'
  | 'locked'
  | 'bad-pin'
  | 'checkpoint-failed'
  | 'snapshot-failed'
  | 'audit-failed';

export interface WipeReceipt {
  /** Stage 1/E: filename/ID only — never an absolute path. */
  snapshotId?: string;
  snapshotBytes?: number;
  snapshotSha256?: string;
}

export interface WipeCheckpoint {
  ok: boolean;
  busy: number;
  message: string;
}

export interface WipeDeps {
  isTauri?: () => boolean;
  verifyPin?: typeof verifyManagerStepUp;
  checkpoint?: () => Promise<WipeCheckpoint>;
  takeSnapshot?: () => Promise<{
    success: boolean;
    snapshot?: { id: string; bytes: number; mtimeMs: number; sha256: string };
    error?: string;
  }>;
  appendAudit?: typeof auditAppend;
  clear?: () => Promise<void>;
  nowIso?: () => string;
  /**
   * FT-06/F1 write quiescing. The checkpoint → snapshot → append → clear
   * sequence runs inside this lock so same-window writers (checkout,
   * void/refund, outbox ops, sync chunk commits — all withWriteLock users)
   * cannot land mid-wipe. What it does NOT stop (stated, not hidden):
   * backfill and pull-apply rows (documented withWriteLock exception,
   * busyRetry only), second-window writers (SQLite busy-timeout + clear's
   * own IMMEDIATE transaction serialize those), and native writes. The
   * residual snapshot risk is a stale tail, never corruption (WAL recovery
   * on open + back-to-back companion copies + integrity check).
   */
  lockWrites?: <T>(fn: () => Promise<T>) => Promise<T>;
}

async function defaultClear(): Promise<void> {
  const { sqliteAdapter } = await import('./sqliteAdapter');
  await sqliteAdapter.clearAllData();
}

async function defaultCheckpoint(): Promise<WipeCheckpoint> {
  const { maintenanceAdapter } = await import('./adapters/maintenanceAdapter');
  const res = await maintenanceAdapter.checkpointWalStrict();
  return { ok: res.ok, busy: res.busy, message: res.message };
}

export async function requestDataWipe(
  pin: string,
  deps: WipeDeps = {}
): Promise<{ ok: true; receipt: WipeReceipt } | { ok: false; reason: WipeRefusalReason; message: string }> {
  const isTauri = deps.isTauri ?? isTauriRuntime;
  if (!isTauri()) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Effacement disponible uniquement dans l\u2019application installée.',
    };
  }

  // Fresh native manager PIN — no window, no weak fallback.
  const verify = deps.verifyPin ?? verifyManagerStepUp;
  const clean = (pin || '').trim();
  let stepUp: Awaited<ReturnType<typeof verifyManagerStepUp>>;
  try {
    stepUp = await verify(clean, { allowWeakFallback: false, gateName: 'wipe' });
  } catch {
    return { ok: false, reason: 'denied', message: 'PIN manager incorrect.' };
  }
  if (stepUp.weaker) {
    // Belt-and-braces: the fallback must never authorize a wipe even if a
    // future caller passes allowWeakFallback: true.
    return { ok: false, reason: 'denied', message: 'PIN manager incorrect.' };
  }
  if (stepUp.locked) {
    const secs = Math.max(1, Math.ceil(stepUp.lockedRemainingMs / 1000));
    return { ok: false, reason: 'locked', message: `Verrouillé — réessayez dans ${secs}s.` };
  }
  if (!stepUp.ok) {
    if (stepUp.reason === 'unavailable') {
      return { ok: false, reason: 'unavailable', message: 'Vérification indisponible — réessayez.' };
    }
    return { ok: false, reason: stepUp.reason === 'bad-length' ? 'bad-pin' : 'denied', message: 'PIN manager incorrect.' };
  }

  // The checkpoint → snapshot → append → clear sequence runs inside ONE
  // write lock (see WipeDeps.lockWrites): same-window writers queue behind
  // the wipe instead of landing inside it. Deadlock audit: none of the four
  // steps acquires withWriteLock internally (raw select / native file copy /
  // native IPC append / raw DELETEs in an IMMEDIATE txn), so the hold is a
  // plain FIFO wait. The till stalls for the duration (seconds, rare,
  // PIN-gated) — stated, not hidden.
  const lockWrites =
    deps.lockWrites ??
    (async <T>(fn: () => Promise<T>): Promise<T> => {
      const { withWriteLock } = await import('./writeMutex');
      return withWriteLock(fn);
    });
  return lockWrites(async () => {
    // WAL checkpoint BEFORE the snapshot: a snapshot over an un-checkpointed
    // WAL can miss committed frames. Busy/incomplete/failed checkpoint aborts
    // here — nothing is written or deleted — and the message is surfaced.
    const checkpoint = deps.checkpoint ?? defaultCheckpoint;
    try {
      const cp = await checkpoint();
      if (!cp.ok) {
        return {
          ok: false,
          reason: 'checkpoint-failed',
          message: `${cp.message} — effacement refusé.`,
        } as const;
      }
    } catch {
      return {
        ok: false,
        reason: 'checkpoint-failed',
        message: 'Point de contrôle WAL impossible — effacement refusé.',
      } as const;
    }

  // Pre-wipe native snapshot — failure aborts before any write or delete.
  // Stage 1/E: kind 'wipe' files it into the filename; the receipt and the
  // audit row carry the filename/ID + integrity, never the absolute path.
  const takeSnapshot = deps.takeSnapshot ?? (async () => {
    const pre = await createPreMigrationBackup('wipe');
    return {
      success: pre.success,
      snapshot: pre.snapshotId
        ? { id: pre.snapshotId, bytes: pre.snapshotBytes ?? 0, mtimeMs: pre.snapshotMtimeMs ?? 0, sha256: pre.snapshotSha256 ?? '' }
        : undefined,
      error: pre.error,
    };
  });
  let snapshot: { id: string; bytes: number; mtimeMs: number; sha256: string } | undefined;
  try {
    const snap = await takeSnapshot();
    if (!snap.success || !snap.snapshot) {
      return {
        ok: false,
        reason: 'snapshot-failed',
        message: `Sauvegarde pré-effacement impossible (${snap.error ?? 'cause inconnue'}) — effacement refusé.`,
      } as const;
    }
    snapshot = snap.snapshot;
  } catch {
    return {
      ok: false,
      reason: 'snapshot-failed',
      message: 'Sauvegarde pré-effacement impossible — effacement refusé.',
    } as const;
  }

  // Pre-wipe audit row, natively chained — failure aborts the wipe.
  // Stage 1/E: references the snapshot by filename/ID + integrity, never
  // by absolute path.
  const append = deps.appendAudit ?? auditAppend;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  try {
    await append({
      action: DATA_WIPE_BEFORE_ACTION,
      details: JSON.stringify({
        snapshotId: snapshot!.id,
        snapshotBytes: snapshot!.bytes,
        snapshotMtimeMs: snapshot!.mtimeMs,
        snapshotSha256: snapshot!.sha256,
        at: nowIso(),
      }),
      requiresPin: true,
    });
  } catch {
    return {
      ok: false,
      reason: 'audit-failed',
      message: 'Traçabilité pré-effacement impossible — effacement refusé.',
    } as const;
  }

  const clear = deps.clear ?? defaultClear;
  await clear();
  return { ok: true, receipt: { snapshotId: snapshot!.id, snapshotBytes: snapshot!.bytes, snapshotSha256: snapshot!.sha256 } } as const;
  });
}

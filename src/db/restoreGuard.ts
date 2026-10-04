/**
 * Phase 2 (F1) — guarded restore (JSON import + cloud merge).
 *
 * Same bar as the wipe guard: validate BEFORE the PIN (a malformed file
 * must not burn native budget or reach the point of no return), fresh
 * native manager PIN (no window, no weak fallback), strict checkpoint +
 * verified snapshot of CURRENT state, pre-action native row, then proceed.
 *
 * Differences from wipe (deliberate, documented):
 * - The write lock encloses checkpoint → snapshot ONLY. A restore merge
 *   runs minutes (cloud pages); holding the till mutex that long would
 *   stall sales. The merge lanes are version-guarded/idempotent, so
 *   concurrent writes converge instead of corrupting. The wipe holds the
 *   lock across clear because its DELETE loop is seconds-fast.
 * - Validation runs TWICE (before PIN, before the point of no return): a
 *   file swapped between picker and execute, or a cloud source that changed
 *   shape, refuses after the snapshot (kept) but before anything destructive.
 * - Post-point-of-no-return failure returns `restore-failed` with the
 *   snapshot reference for MANUAL recovery via the runbook — never
 *   auto-rollback (rollback would destroy the evidence of what the merge
 *   did, and the pre-restore snapshot exists precisely for this).
 * - Outcome rows mirror the import convention: DATA_RESTORED_OK on success
 *   (carrying the inner proceed's auditOk), completed-but-unaudited when
 *   the OK row itself cannot land.
 *
 * The native audit log is insert-only everywhere on this path
 * (mergeImportAuditHistory DO NOTHING, pull mirror DO NOTHING) — a restore
 * can never replace or erase it.
 */

import { auditAppend } from '../api/audit';
import { createPreMigrationBackup } from './backupManager';
import { isTauriRuntime, verifyManagerStepUp } from '../utils/auditGate';

export const DATA_RESTORE_BEFORE_ACTION = 'DATA_RESTORE_BEFORE';
export const DATA_RESTORED_OK_ACTION = 'DATA_RESTORED_OK';

export type RestoreSource = 'json-import' | 'cloud-merge';

export interface RestorePayloadSummary {
  version?: string;
  counts?: Record<string, number>;
}

export interface RestoreValidation {
  ok: boolean;
  reason?: string;
}

export interface RestoreRequest {
  source: RestoreSource;
  /** Required for json-import (validate enforces); absent for cloud-merge. */
  sourceSha256?: string;
  /** Cloud identifier (host/db name — never tokens or secrets). */
  remoteId?: string;
  payloadSummary?: RestorePayloadSummary;
  actor?: string;
  /** No writes. Runs before the PIN and again before the point of no return. */
  validate: () => Promise<RestoreValidation>;
  /** The restore itself (import/merge). Must be idempotent on retry. */
  proceed: () => Promise<{ success: boolean; reason?: string; auditOk?: boolean }>;
}

export type RestoreRefusalReason =
  | 'invalid-payload'
  | 'unavailable'
  | 'denied'
  | 'locked'
  | 'bad-pin'
  | 'checkpoint-failed'
  | 'snapshot-failed'
  | 'audit-failed';

export interface RestoreReceipt {
  snapshotId: string;
  snapshotSha256: string;
}

export interface RestoreDeps {
  isTauri?: () => boolean;
  verifyPin?: typeof verifyManagerStepUp;
  checkpoint?: () => Promise<{ ok: boolean; busy: number; message: string }>;
  takeSnapshot?: () => Promise<{
    success: boolean;
    snapshot?: { id: string; bytes: number; mtimeMs: number; sha256: string };
    error?: string;
  }>;
  appendAudit?: typeof auditAppend;
  lockWrites?: <T>(fn: () => Promise<T>) => Promise<T>;
  nowIso?: () => string;
}

type RestoreResult =
  | { ok: true; receipt: RestoreReceipt; auditOk: boolean; message?: string }
  | { ok: false; reason: RestoreRefusalReason | 'restore-failed'; message: string; receipt?: RestoreReceipt };

async function defaultCheckpoint(): Promise<{ ok: boolean; busy: number; message: string }> {
  const { maintenanceAdapter } = await import('./adapters/maintenanceAdapter');
  const res = await maintenanceAdapter.checkpointWalStrict();
  return { ok: res.ok, busy: res.busy, message: res.message };
}

export async function requestDataRestore(
  req: RestoreRequest,
  pin: string,
  deps: RestoreDeps = {}
): Promise<RestoreResult> {
  // 1. Validate BEFORE the PIN: malformed input burns no budget and reaches
  // nothing destructive.
  try {
    const v = await req.validate();
    if (!v.ok) {
      return { ok: false, reason: 'invalid-payload', message: v.reason || 'Contenu de restauration invalide — PIN non demandé.' };
    }
  } catch {
    return { ok: false, reason: 'invalid-payload', message: 'Contenu de restauration illisible — PIN non demandé.' };
  }
  if (req.source === 'json-import' && !req.sourceSha256) {
    return { ok: false, reason: 'invalid-payload', message: 'Empreinte du fichier source manquante — PIN non demandé.' };
  }

  const isTauri = deps.isTauri ?? isTauriRuntime;
  if (!isTauri()) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Restauration disponible uniquement dans l\u2019application installée.',
    };
  }

  // 2. Fresh native manager PIN — no window, no weak fallback.
  const verify = deps.verifyPin ?? verifyManagerStepUp;
  const clean = (pin || '').trim();
  if (!/^\d+$/.test(clean) || clean.length < 4 || clean.length > 32) {
    return { ok: false, reason: 'bad-pin', message: 'PIN manager incorrect.' };
  }
  let stepUp: Awaited<ReturnType<typeof verifyManagerStepUp>>;
  try {
    stepUp = await verify(clean, { allowWeakFallback: false, gateName: 'restore' });
  } catch {
    return { ok: false, reason: 'denied', message: 'PIN manager incorrect.' };
  }
  if (stepUp.weaker) {
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
    return { ok: false, reason: 'denied', message: 'PIN manager incorrect.' };
  }

  const lockWrites =
    deps.lockWrites ??
    (async <T>(fn: () => Promise<T>): Promise<T> => {
      const { withWriteLock } = await import('./writeMutex');
      return withWriteLock(fn);
    });
  const append = deps.appendAudit ?? auditAppend;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  // 3. Checkpoint + snapshot under ONE write lock (same quiescing contract
  // as the wipe guard). Re-validate inside, before the point of no return.
  const takeSnapshot = deps.takeSnapshot ?? (async () => {
    const pre = await createPreMigrationBackup('restore');
    return {
      success: pre.success,
      snapshot: pre.snapshotId
        ? { id: pre.snapshotId, bytes: pre.snapshotBytes ?? 0, mtimeMs: pre.snapshotMtimeMs ?? 0, sha256: pre.snapshotSha256 ?? '' }
        : undefined,
      error: pre.error,
    };
  });
  let snapshot: { id: string; bytes: number; mtimeMs: number; sha256: string };
  try {
    const locked = await lockWrites(async () => {
      const checkpoint = deps.checkpoint ?? defaultCheckpoint;
      const cp = await checkpoint();
      if (!cp.ok) {
        throw { restoreGuard: true as const, reason: 'checkpoint-failed' as const, message: `${cp.message} — restauration refusée.` };
      }
      const snap = await takeSnapshot();
      if (!snap.success || !snap.snapshot) {
        throw { restoreGuard: true as const, reason: 'snapshot-failed' as const, message: `Sauvegarde pré-restauration impossible (${snap.error ?? 'cause inconnue'}) — restauration refusée.` };
      }
      // Re-validate before the point of no return (file swapped, cloud
      // reshaped, or race since step 1).
      const v2 = await req.validate();
      if (!v2.ok) {
        throw { restoreGuard: true as const, reason: 'invalid-payload' as const, message: v2.reason || 'Contenu invalide avant restauration — abandon.' };
      }
      return snap.snapshot;
    });
    snapshot = locked;
  } catch (e: unknown) {
    const g = e as { restoreGuard?: true; reason?: RestoreRefusalReason; message?: string };
    if (g?.restoreGuard === true && g.reason && g.message) {
      return { ok: false, reason: g.reason, message: g.message };
    }
    return { ok: false, reason: 'snapshot-failed', message: 'Sauvegarde pré-restauration impossible — restauration refusée.' };
  }

  // 4. Pre-action native row (outside the lock — the merge lanes converge,
  // so no quiet section is needed past the snapshot).
  const preDetails = {
    source: req.source,
    ...(req.sourceSha256 ? { sourceSha256: req.sourceSha256 } : {}),
    ...(req.remoteId ? { remoteId: req.remoteId } : {}),
    snapshotId: snapshot.id,
    snapshotSha256: snapshot.sha256,
    payloadSummary: req.payloadSummary ?? {},
    at: nowIso(),
  };
  try {
    await append({
      action: DATA_RESTORE_BEFORE_ACTION,
      details: JSON.stringify(preDetails),
      user: (req.actor ?? '').trim() || undefined,
      requiresPin: true,
    });
  } catch {
    return { ok: false, reason: 'audit-failed', message: 'Traçabilité pré-restauration impossible — restauration refusée.' };
  }

  // 5. Proceed. Post-point-of-no-return failure returns restore-failed WITH
  // the snapshot reference for manual recovery via the runbook — never
  // auto-rollback (rollback would destroy the evidence of what the merge
  // did, and the pre-restore snapshot exists precisely for this).
  const receipt: RestoreReceipt = { snapshotId: snapshot.id, snapshotSha256: snapshot.sha256 };
  let proceeded: { success: boolean; reason?: string; auditOk?: boolean };
  try {
    proceeded = await req.proceed();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: 'restore-failed',
      message: `Restauration interrompue après le point de non-retour (${msg}). Sauvegarde pré-restauration : ${snapshot.id} — suivez le runbook de récupération, ne relancez pas à l'aveugle.`,
      receipt,
    };
  }
  if (!proceeded.success) {
    return {
      ok: false,
      reason: 'restore-failed',
      message: `${proceeded.reason || 'Échec de la restauration après le point de non-retour.'} Sauvegarde pré-restauration : ${snapshot.id} — suivez le runbook de récupération.`,
      receipt,
    };
  }

  // 6. Outcome row. If it cannot land, the restore DID complete — report
  // completed-but-unaudited (same convention as the import path), never
  // plain failure (which would invite a duplicate retry) or silent success.
  try {
    await append({
      action: DATA_RESTORED_OK_ACTION,
      details: JSON.stringify({
        ...preDetails,
        outcome: 'completed',
        importAuditOk: proceeded.auditOk ?? true,
        at: nowIso(),
      }),
      user: (req.actor ?? '').trim() || undefined,
      requiresPin: true,
    });
  } catch {
    return {
      ok: true,
      receipt,
      auditOk: false,
      message: 'Restauration terminée MAIS traçabilité finale impossible — vérifiez le journal avant toute diffusion.',
    };
  }
  return { ok: true, receipt, auditOk: proceeded.auditOk ?? true };
}

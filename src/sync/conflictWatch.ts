/**
 * Version-conflict observation lane (A3: SYNC-005 — "zero silent conflicts").
 *
 * The tied version guard (tiedVersionGuardSql) makes equal-version losers
 * DETERMINISTIC, but a deterministic loss with differing content is still a
 * conflict the merchant must see, not a silent drop. This module records it:
 *
 *   - local-only `sync_conflicts` table (queryable diagnostics; never synced,
 *     so observations cannot loop). Created lazily by ensureConflictTable()
 *     — no boot cost, no migration-number consumption, no contention with
 *     the shared schema-heal path.
 *   - one audit entry through the caller's funnel with a deterministic
 *     convergence key (same shape as payoutWatch: AUDIT-CONFLICT-…), so
 *     every device that observes the same divergence files the same key.
 *   - once-only per (table, row, localFp, incomingFp): the table itself is
 *     the marker (pre-SELECT + INSERT … ON CONFLICT DO NOTHING).
 *
 * Everything here is best-effort and NEVER throws: a reporting failure must
 * not fail the sync/write pipeline it observes. Failures warn loudly.
 */

import {
  compareStamps,
  projectionFingerprint,
} from './causalVersion';

/** Minimal driver surface — real plugin-sql db in prod, fakes in tests. */
export interface ConflictDb {
  select: (sql: string, args?: unknown[]) => Promise<unknown>;
  execute: (sql: string, args?: unknown[]) => Promise<unknown>;
}

/** Fire-and-forget audit sink. Prod wires logSecurityAction. */
export type ConflictAuditSink = (action: string, details: string) => Promise<unknown>;

export interface ConflictObservation {
  table: string;
  id: string;
  localVersion: unknown;
  incomingVersion: unknown;
  localDevice: unknown;
  incomingDevice: unknown;
  localPayload: unknown;
  incomingPayload: unknown;
  at?: string;
}

export type ObserveOutcome = 'recorded' | 'identical' | 'duplicate' | 'skipped';

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  local_version INTEGER NOT NULL DEFAULT 0,
  incoming_version INTEGER NOT NULL DEFAULT 0,
  local_device TEXT NOT NULL DEFAULT '',
  incoming_device TEXT NOT NULL DEFAULT '',
  local_fp TEXT NOT NULL DEFAULT '',
  incoming_fp TEXT NOT NULL DEFAULT '',
  winner TEXT NOT NULL DEFAULT '',
  detected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved INTEGER NOT NULL DEFAULT 0,
  note TEXT
);`;

const CREATE_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_sync_conflicts_row ON sync_conflicts(table_name, row_id);';

/** Idempotent. Call before recording; cheap after the first call. */
export async function ensureConflictTable(db: ConflictDb): Promise<void> {
  await db.execute(CREATE_TABLE_SQL);
  await db.execute(CREATE_INDEX_SQL);
}

function sanitizeKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/g, '').slice(0, 48);
}

export function conflictRecordId(
  table: string,
  id: string,
  localFp: string,
  incomingFp: string,
): string {
  return `CONFLICT-${sanitizeKeyPart(table)}-${sanitizeKeyPart(id)}-${localFp.slice(0, 8)}-${incomingFp.slice(0, 8)}`;
}

export function conflictAuditKey(
  table: string,
  id: string,
  localFp: string,
  incomingFp: string,
): string {
  return `AUDIT-CONFLICT-${sanitizeKeyPart(table)}-${sanitizeKeyPart(id)}-${localFp.slice(0, 8)}-${incomingFp.slice(0, 8)}`;
}

function toFiniteVersion(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

export interface GuardMissInput {
  /** Raw driver result of the guarded upsert (number, {rowsAffected}, or unknown). */
  affectedRaw: unknown;
  /** Local row AFTER the miss (intact — the guard rejected the overwrite). */
  local: { version?: unknown } | null | undefined;
  incomingVersion: unknown;
}

/**
 * Pure gate for wiring sites: observe ONLY a proven guard miss
 * (affected === 0 exactly) on equal versions. Anything indeterminate —
 * driver-shaped results, missing rows, version mismatch — returns false:
 * a missed observation is acceptable, a wrong one is not.
 */
export function guardMissNeedsObservation(input: GuardMissInput): boolean {
  const raw = input.affectedRaw;
  const affected =
    typeof raw === 'number' ? raw : Number((raw as { rowsAffected?: unknown } | null)?.rowsAffected ?? NaN);
  if (affected !== 0) return false;
  if (!input.local) return false;
  return toFiniteVersion(input.local.version) === toFiniteVersion(input.incomingVersion);
}

function toDevice(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Observe one guarded-write rejection. Returns what happened; never throws.
 * 'skipped' covers: version mismatch (the version guard owns it, not a tie),
 * unreadable state, and any infrastructure failure.
 */
export async function observeVersionConflict(
  db: ConflictDb,
  fileAudit: ConflictAuditSink,
  obs: ConflictObservation,
): Promise<ObserveOutcome> {
  try {
    const localVersion = toFiniteVersion(obs.localVersion);
    const incomingVersion = toFiniteVersion(obs.incomingVersion);
    if (localVersion !== incomingVersion) return 'skipped';
    const localDevice = toDevice(obs.localDevice);
    const incomingDevice = toDevice(obs.incomingDevice);
    const localFp = projectionFingerprint(obs.localPayload);
    const incomingFp = projectionFingerprint(obs.incomingPayload);
    if (localFp === incomingFp) return 'identical';

    await ensureConflictTable(db);
    const recordId = conflictRecordId(obs.table, obs.id, localFp, incomingFp);
    const existing = (await db.select(
      'SELECT id FROM sync_conflicts WHERE table_name = $1 AND row_id = $2 AND local_fp = $3 AND incoming_fp = $4 LIMIT 1',
      [obs.table, obs.id, localFp, incomingFp],
    ).catch(() => [])) as Array<{ id?: string }>;
    if (Array.isArray(existing) && existing.length > 0) return 'duplicate';

    const winner =
      compareStamps(
        { version: incomingVersion, deviceId: incomingDevice, fingerprint: incomingFp },
        { version: localVersion, deviceId: localDevice, fingerprint: localFp },
      ) >= 0
        ? 'incoming'
        : 'local';
    const at = typeof obs.at === 'string' && obs.at ? obs.at : new Date().toISOString();
    await db.execute(
      `INSERT INTO sync_conflicts (id, table_name, row_id, local_version, incoming_version,
        local_device, incoming_device, local_fp, incoming_fp, winner, detected_at, resolved, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12)
       ON CONFLICT(id) DO NOTHING`,
      [
        recordId, obs.table, obs.id, localVersion, incomingVersion,
        localDevice, incomingDevice, localFp, incomingFp, winner, at,
        `Equal-version divergence: ${winner} wins by device/fingerprint tiebreak (A3).`,
      ],
    );
    try {
      await fileAudit(
        'Divergence de synchronisation',
        `[${conflictAuditKey(obs.table, obs.id, localFp, incomingFp)}] ` +
          `Conflit d'édition simultanée sur ${obs.table}:${obs.id} (v${localVersion}, ` +
          `${localDevice || '?'} contre ${incomingDevice || '?'}) — ${winner} appliqué par tiebreak déterministe. Contrôlez la fiche.`,
      );
    } catch (auditErr) {
      console.warn('[sync:conflict] audit sink failed (record is durable):', auditErr);
    }
    return 'recorded';
  } catch (err) {
    console.warn('[sync:conflict] observation failed (pipeline unaffected):', err);
    return 'skipped';
  }
}

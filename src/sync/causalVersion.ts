/**
 * Causal version-ordering primitive (A3: SYNC-005 / DB-013).
 *
 * Problem: every sync lane resolves concurrent writes with
 * `WHERE excluded.version >= <table>.version`. Equal versions therefore
 * resolve by ARRIVAL ORDER — whichever row lands last wins, silently, and
 * different devices can converge differently. There is no tiebreak and no
 * conflict record.
 *
 * This module is the single source of truth for version comparison:
 *   1. Greater `version` always wins (monotonic per-device clock intact).
 *   2. Equal versions break ties by `deviceId` (greater wins), then by
 *      payload fingerprint (greater wins). Both inputs are row content, so
 *      every replica reaches the SAME decision independently → convergence.
 *   3. Zero is returned ONLY when version+device+fingerprint all match
 *      (the same logical write) — "same version" is never conflated with
 *      "same write".
 *   4. Equal-version losers with differing payloads are CONFLICTS, not
 *      silent drops: callers surface them via reportConflict().
 *
 * SQL mirror (must stay in sync with compareStamps): the guarded upserts
 * use
 *   WHERE excluded.version > <T>.version
 *      OR (excluded.version = <T>.version
 *          AND COALESCE(excluded.device_id,'') >= COALESCE(<T>.device_id,''))
 * i.e. version first, greater-device wins ties. The payload-hash level
 * cannot be expressed in SQLite and lives in resolveIncoming() for the
 * JS-side decision points (sparse-echo guard, detectors, tests).
 *
 * Mixed-fleet note: pre-tiebreak clients resolve equal versions by arrival
 * order while tiebreak clients resolve deterministically, so the two can
 * flap on genuinely concurrent equal-version rows until the fleet upgrades.
 * Equal-version rows are rare (they require concurrent offline edits landing
 * on the same version) and were silent losses before; the tiebreak strictly
 * improves determinism. No flag infra exists yet for a dual-accept window.
 *
 * Zero runtime dependencies — importable from sync hot paths and tests.
 */

export interface VersionStamp {
  version?: unknown;
  deviceId?: unknown;
  fingerprint?: unknown;
}

/** Non-finite versions (null/undefined/NaN/garbage) rank as 0, never NaN. */
export function normalizeVersion(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n);
}

/** Missing device ids rank as '' (lowest), deterministically. */
export function normalizeDeviceId(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Deterministic JSON: object keys sorted recursively. NaN/Infinity → null. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? String(value) : 'null';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${(value as unknown[]).map(stableStringify).join(',')}]`;
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** FNV-1a 32-bit, uppercase hex — same family as utils/ids deterministicId. */
export function fnv1a32Hex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

/** Content fingerprint for the tiebreak's third level. */
export function payloadFingerprint(payload: unknown): string {
  return fnv1a32Hex(stableStringify(payload));
}

/**
 * Total deterministic order over version stamps.
 * Returns >0 when `a` wins, <0 when `b` wins, 0 ONLY for identical stamps.
 * Antisymmetric by construction: compareStamps(a,b) === -compareStamps(b,a).
 */
export function compareStamps(
  a: VersionStamp | null | undefined,
  b: VersionStamp | null | undefined,
): number {
  const va = normalizeVersion(a?.version);
  const vb = normalizeVersion(b?.version);
  if (va !== vb) return va < vb ? -1 : 1;
  const da = normalizeDeviceId(a?.deviceId);
  const db = normalizeDeviceId(b?.deviceId);
  if (da !== db) return da < db ? -1 : 1;
  const fa = typeof a?.fingerprint === 'string' ? (a.fingerprint as string) : '';
  const fb = typeof b?.fingerprint === 'string' ? (b.fingerprint as string) : '';
  if (fa !== fb) return fa < fb ? -1 : 1;
  return 0;
}

export type ConflictDecision =
  | { decision: 'apply'; reason: 'newer-version' | 'tiebreak-won' | 'identical' }
  | { decision: 'skip'; reason: 'stale-version' | 'tiebreak-lost' };

/**
 * Decide one incoming row against the local row. Pure — no I/O.
 * 'identical' (same version+device+fingerprint) is safe to re-apply.
 * Every other equal-version outcome is a conflict the caller must surface.
 */
export function resolveIncoming(
  local: VersionStamp | null | undefined,
  incoming: VersionStamp | null | undefined,
): ConflictDecision {
  const va = normalizeVersion(incoming?.version);
  const vb = normalizeVersion(local?.version);
  if (va !== vb) return va > vb ? { decision: 'apply', reason: 'newer-version' } : { decision: 'skip', reason: 'stale-version' };
  const cmp = compareStamps(incoming, local);
  if (cmp === 0) return { decision: 'apply', reason: 'identical' };
  return cmp > 0 ? { decision: 'apply', reason: 'tiebreak-won' } : { decision: 'skip', reason: 'tiebreak-lost' };
}

export interface VersionConflict {
  table: string;
  id: string;
  local: { version: number; deviceId: string; fingerprint: string };
  incoming: { version: number; deviceId: string; fingerprint: string };
  winner: 'local' | 'incoming';
  at: string;
}

export function describeConflict(c: VersionConflict): string {
  return (
    `[sync:conflict] ${c.table}:${c.id} v${c.incoming.version} ` +
    `(incoming ${c.incoming.deviceId || '?'}/${c.incoming.fingerprint}) vs ` +
    `v${c.local.version} (local ${c.local.deviceId || '?'}/${c.local.fingerprint}) ` +
    `→ ${c.winner} wins @ ${c.at}`
  );
}

type ConflictReporter = (conflict: VersionConflict) => void;

let reporter: ConflictReporter = (conflict) => {
  console.warn(describeConflict(conflict));
};

/** Override the conflict sink (tests, audit lane). Restored via reset. */
export function setConflictReporter(next: ConflictReporter): void {
  reporter = next;
}

export function reportConflict(conflict: VersionConflict): void {
  try {
    reporter(conflict);
  } catch {
    // A reporting failure must never fail the write it observes.
  }
}

/**
 * Canonical SQL guard shared by every version-guarded upsert (push + pull).
 * Use it instead of hand-writing the predicate so all lanes resolve equal
 * versions identically: strictly-newer wins, else greater-or-equal device
 * wins ties. `COALESCE` keeps NULL/missing device ids total and
 * deterministic (they rank lowest). Same-device re-pushes still apply
 * (idempotent re-apply, harmless).
 */
export function tiedVersionGuardSql(table: string): string {
  return (
    `excluded.version > ${table}.version ` +
    `OR (excluded.version = ${table}.version ` +
    `AND COALESCE(excluded.device_id,'') >= COALESCE(${table}.device_id,''))`
  );
}

/**
 * Volatile sync metadata: differs on every write (timestamps, sync state,
 * attempt-scoped keys) and must NEVER count as a conflict. Device identity
 * is excluded too — it is tiebreak level 2, not content.
 */
export const VOLATILE_SYNC_KEYS: readonly string[] = [
  'updated_at',
  'sync_status',
  'idempotency_key',
  'device_id',
  'deviceId',
];

/**
 * Canonical conflict projection: the payload minus volatile metadata.
 * Two rows with equal versions are in conflict IFF their projections differ
 * (money/identity divergence), not when only volatile fields differ (which
 * is every write). Extra per-lane volatile keys via `extraVolatile`.
 */
export function canonicalProjection(
  payload: unknown,
  extraVolatile: readonly string[] = [],
): Record<string, unknown> {
  const banned = new Set<string>([...VOLATILE_SYNC_KEYS, ...extraVolatile]);
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(project);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        if (banned.has(k)) continue;
        out[k] = project((value as Record<string, unknown>)[k]);
      }
      return out;
    }
    return value;
  };
  const projected = project(payload);
  return (projected !== null && typeof projected === 'object' && !Array.isArray(projected)
    ? (projected as Record<string, unknown>)
    : {}) as Record<string, unknown>;
}

/** Conflict fingerprint: hash of the canonical projection, not raw payload. */
export function projectionFingerprint(
  payload: unknown,
  extraVolatile: readonly string[] = [],
): string {
  return payloadFingerprint(canonicalProjection(payload, extraVolatile));
}

/**
 * Status-rank expression for the transactions pull guard: terminal states
 * outrank live ones so a COMPLETED echo can never un-void a ticket.
 */
export function statusRankSql(statusExpr: string): string {
  return (
    `(CASE COALESCE(${statusExpr}, 'COMPLETED') ` +
    `WHEN 'VOIDED' THEN 3 WHEN 'REFUNDED' THEN 2 WHEN 'PARTIALLY_REFUNDED' THEN 2 ELSE 1 END)`
  );
}

/**
 * Full pull-side transactions guard: version first, then status rank (so
 * terminal states stick), then device tiebreak at the bottom so equal
 * versions with equal rank still converge deterministically on every
 * replica instead of by arrival order.
 */
export function transactionPullGuardSql(): string {
  const rankIncoming = statusRankSql('excluded.status');
  const rankLocal = statusRankSql('transactions.status');
  return (
    `excluded.version > transactions.version ` +
    `OR (excluded.version = transactions.version ` +
    `AND (${rankIncoming} > ${rankLocal} ` +
    `OR (${rankIncoming} = ${rankLocal} ` +
    `AND COALESCE(excluded.device_id,'') >= COALESCE(transactions.device_id,''))))`
  );
}

/**
 * Optimistic-bump helper for the write side (DB-013): read the version,
 * write with `UPDATE ... WHERE version = :read` (or an upsert whose guard
 * carries the read version), and RETRY the whole read-modify-write on a
 * guard miss instead of last-writer-winning. Returns read+1.
 */
export function nextVersionForWrite(readVersion: unknown): number {
  return normalizeVersion(readVersion) + 1;
}

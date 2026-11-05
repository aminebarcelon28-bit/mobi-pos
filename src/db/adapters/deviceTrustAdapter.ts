/**
 * UPGRADE-08 — blocked-IMEI screen + IMEI ownership ledger (SQLite lane).
 *
 * Both tables are merchant-local (like the SAV/Tier-B evidence tables): no
 * sync lane, no generic SQL reachability beyond this module — plus the one
 * inline append inside the checkout sale lane (`sqlPluginAdapter`), which owns
 * the sale stamp itself.
 *
 * Posture:
 *  - Under Tauri, a READ error is `unknown` — callers deny (a database with no
 *    blocked list is a broken state, not a clean one). Fail closed.
 *  - Outside Tauri (web preview / tests) there is no local DB at all: reads
 *    answer `clear`, writes no-op. Same posture as the Dexie mirror — the
 *    preview is not an enforcement surface.
 *  - Mutations THROW (callers decide fail-closed vs best-effort); ledger
 *    appends are idempotent by deterministic id, so any retry converges.
 */
import { isTauriEnv } from './base';
import { getLocalDb } from '../sqlPluginAdapter';
import { normalizeDeviceKey } from '../../utils/deviceIdCodec';
import {
  imeiTrustEventId,
  type ImeiTrustEventKind,
} from '../../utils/deviceTrust';

export interface BlockedImeiRow {
  imei: string;
  reason: string;
  source: string;
  addedAt: string;
  active: boolean;
}

export interface ImeiTrustEventRow {
  id: string;
  imei: string;
  kind: string;
  refType: string;
  refId: string;
  at: string;
  actor: string;
  note: string;
}

export type ImeiBlockedVerdict =
  | { status: 'blocked'; imei: string; reason: string; source: string }
  | { status: 'clear' }
  | { status: 'unknown'; detail: string };

function canonicalOf(rawIdentifier: string): string {
  return normalizeDeviceKey(String(rawIdentifier ?? '')) || String(rawIdentifier ?? '').trim();
}

// ── Blocked screen ──────────────────────────────────────────────────────────

/**
 * Tri-state blocked check. Callers treat `unknown` as DENY (fail closed) and
 * `blocked` as deny-unless-fresh-audited-grant; `clear` proceeds.
 */
export async function checkImeiBlocked(rawIdentifier: string): Promise<ImeiBlockedVerdict> {
  const canonical = canonicalOf(rawIdentifier);
  if (!canonical) return { status: 'clear' };
  if (!isTauriEnv()) return { status: 'clear' };
  try {
    const db = await getLocalDb();
    const rows = (await db.select(
      'SELECT imei, reason, source FROM blocked_imeis WHERE imei = $1 AND active = 1 LIMIT 1',
      [canonical]
    )) as Array<{ imei?: string; reason?: string | null; source?: string | null }>;
    const row = rows?.[0];
    if (!row) return { status: 'clear' };
    return {
      status: 'blocked',
      imei: String(row.imei ?? canonical),
      reason: String(row.reason ?? ''),
      source: String(row.source ?? ''),
    };
  } catch (err) {
    return { status: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Adds or re-activates one entry. The key is canonicalized at the boundary. */
export async function blockImeiDevice(input: {
  imei: string;
  reason: string;
  source?: string;
}): Promise<void> {
  if (!isTauriEnv()) return;
  const canonical = canonicalOf(input.imei);
  if (!canonical) throw new Error('BLOCKED_IMEI_EMPTY');
  const db = await getLocalDb();
  await db.execute(
    `INSERT INTO blocked_imeis (imei, reason, source, added_at, active)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT(imei) DO UPDATE SET
       reason=excluded.reason, source=excluded.source, added_at=excluded.added_at, active=1`,
    [canonical, String(input.reason ?? ''), String(input.source ?? 'manuel'), new Date().toISOString()]
  );
}

/**
 * Deactivates (never deletes): the list is trust evidence, and a device that
 * was once flagged must keep that trace for the ledger/audit story.
 */
export async function unblockImeiDevice(rawIdentifier: string): Promise<void> {
  if (!isTauriEnv()) return;
  const canonical = canonicalOf(rawIdentifier);
  if (!canonical) return;
  const db = await getLocalDb();
  await db.execute('UPDATE blocked_imeis SET active = 0 WHERE imei = $1', [canonical]);
}

export async function listBlockedImeis(): Promise<BlockedImeiRow[]> {
  if (!isTauriEnv()) return [];
  const db = await getLocalDb();
  const rows = (await db.select(
    'SELECT imei, reason, source, added_at, active FROM blocked_imeis ORDER BY active DESC, added_at DESC'
  )) as Array<{ imei?: string; reason?: string | null; source?: string | null; added_at?: string | null; active?: number | null }>;
  return (rows ?? []).map((r) => ({
    imei: String(r.imei ?? ''),
    reason: String(r.reason ?? ''),
    source: String(r.source ?? ''),
    addedAt: String(r.added_at ?? ''),
    active: Number(r.active ?? 0) !== 0,
  }));
}

// ── Ownership ledger (append-only) ──────────────────────────────────────────

export interface ImeiTrustEventInput {
  imei: string;
  kind: ImeiTrustEventKind;
  refType: string;
  refId: string;
  at?: string;
  actor?: string;
  note?: string;
}

/**
 * One append-only row per (kind, ref document, device). `INSERT OR IGNORE` on
 * the deterministic id is what makes replay/retry convergent. Throws on SQL
 * failure — callers choose the posture (the money lanes treat it as additive
 * best-effort and log; the ledger itself never updates or deletes).
 */
export async function appendImeiEvent(event: ImeiTrustEventInput): Promise<void> {
  if (!isTauriEnv()) return;
  const canonical = canonicalOf(event.imei);
  if (!canonical) return;
  const at = event.at || new Date().toISOString();
  // Native lane (SEC-01): idempotent by the canonical event id.
  const { invokeCommand } = await import('../../platform/invoke');
  await invokeCommand<{ changes: number }>('append_imei_event', {
    request: {
      id: imeiTrustEventId(event.kind, event.refType, event.refId, canonical),
      imei: canonical,
      kind: event.kind,
      refType: event.refType,
      refId: event.refId,
      at,
      actor: String(event.actor ?? ''),
      note: String(event.note ?? ''),
    },
  });
}

export async function appendImeiEvents(events: ImeiTrustEventInput[]): Promise<void> {
  for (const event of events) {
    await appendImeiEvent(event);
  }
}

export async function listImeiEvents(
  rawIdentifier: string,
  limit = 100
): Promise<ImeiTrustEventRow[]> {
  if (!isTauriEnv()) return [];
  const canonical = canonicalOf(rawIdentifier);
  if (!canonical) return [];
  const db = await getLocalDb();
  const capped = Math.max(1, Math.min(500, Math.floor(limit) || 100));
  const rows = (await db.select(
    `SELECT id, imei, kind, ref_type, ref_id, at, actor, note FROM imei_events
     WHERE imei = $1 ORDER BY at DESC, id DESC LIMIT ${capped}`,
    [canonical]
  )) as Array<Record<string, unknown>>;
  return (rows ?? []).map((r) => ({
    id: String(r.id ?? ''),
    imei: String(r.imei ?? ''),
    kind: String(r.kind ?? ''),
    refType: String(r.ref_type ?? ''),
    refId: String(r.ref_id ?? ''),
    at: String(r.at ?? ''),
    actor: String(r.actor ?? ''),
    note: String(r.note ?? ''),
  }));
}

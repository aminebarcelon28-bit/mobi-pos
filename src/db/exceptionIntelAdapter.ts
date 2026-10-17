/**
 * UPGRADE-09 — exception-intelligence read lane (compute-on-read).
 *
 * The ONLY new SQL this feature adds (see `exceptionIntelSql.ts` for the
 * statements + the plan discipline). Three bounded reads over tables that
 * already exist; nothing is written, nothing is cached, nothing is derived in
 * SQL — the pure engine (`utils/cashierExceptionRates.ts`) owns every number.
 */

import { getLocalDb } from './sqlPluginAdapter';
import { AUDIT_ACTOR_ID_HEAL_PROBE_SQL } from './schemaHeal';
import {
  EXCEPTION_AUDIT_WINDOW_LIMIT,
  buildClosedSessionSql,
  buildExceptionAuditWindowSql,
  buildShiftTxnCountSql,
} from './exceptionIntelSql';
import type {
  ClosedSessionRow,
  ExceptionAuditRow,
  ShiftTxnCount,
} from '../utils/cashierExceptionRates';

export interface ExceptionIntelSnapshot {
  actorColumnPresent: boolean;
  auditRows: ExceptionAuditRow[];
  shiftTxnCounts: ShiftTxnCount[];
  sessions: ClosedSessionRow[];
}

interface RawAuditRow {
  id?: string | null;
  timestamp?: string | null;
  user?: string | null;
  action?: string | null;
  details?: string | null;
  requires_pin?: number | boolean | null;
  actor_id?: string | null;
}

interface RawShiftTxnRow {
  shift_id?: string | null;
  n?: number | string | null;
}

interface RawSessionRow {
  id?: string | null;
  cashier_name?: string | null;
  opened_at?: string | null;
  closed_at?: string | null;
  expected_cash?: number | string | null;
  actual_cash?: number | string | null;
  discrepancy?: number | string | null;
  status?: string | null;
}

function numOrNull(v: number | string | null | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * One read pass for the analytics window. `bounds` are ISO-8601 and pushed
 * into SQL; the caller owns the clock.
 */
export async function loadExceptionIntelSnapshot(bounds: {
  sinceIso: string;
  untilIso: string;
}): Promise<ExceptionIntelSnapshot> {
  const db = await getLocalDb();

  // Column probe, never assumed: pre-v124 shapes read a literal NULL instead.
  let actorColumnPresent = false;
  try {
    await db.select(AUDIT_ACTOR_ID_HEAL_PROBE_SQL);
    actorColumnPresent = true;
  } catch {
    actorColumnPresent = false;
  }

  const auditRaw = (await db.select(buildExceptionAuditWindowSql(actorColumnPresent), [
    bounds.sinceIso,
    bounds.untilIso,
    EXCEPTION_AUDIT_WINDOW_LIMIT,
  ])) as RawAuditRow[];

  const shiftRaw = (await db.select(buildShiftTxnCountSql(), [
    bounds.sinceIso,
    bounds.untilIso,
  ])) as RawShiftTxnRow[];

  const sessionRaw = (await db.select(buildClosedSessionSql(), [
    bounds.sinceIso,
    bounds.untilIso,
  ])) as RawSessionRow[];

  const auditRows: ExceptionAuditRow[] = (auditRaw || []).map((r) => ({
    id: String(r?.id ?? ''),
    timestamp: String(r?.timestamp ?? ''),
    user: String(r?.user ?? ''),
    action: String(r?.action ?? ''),
    details: String(r?.details ?? ''),
    requiresPin: Boolean(Number(r?.requires_pin ?? 0)),
    actorId: r?.actor_id == null ? null : String(r.actor_id),
  }));

  const shiftTxnCounts: ShiftTxnCount[] = (shiftRaw || []).map((r) => ({
    shiftId: String(r?.shift_id ?? ''),
    count: Number(r?.n ?? 0) || 0,
  }));

  const sessions: ClosedSessionRow[] = (sessionRaw || []).map((r) => ({
    id: String(r?.id ?? ''),
    cashierName: String(r?.cashier_name ?? ''),
    openedAt: String(r?.opened_at ?? ''),
    closedAt: r?.closed_at == null ? null : String(r.closed_at),
    expectedCash: numOrNull(r?.expected_cash),
    actualCash: numOrNull(r?.actual_cash),
    discrepancy: numOrNull(r?.discrepancy),
    status: String(r?.status ?? ''),
  }));

  return { actorColumnPresent, auditRows, shiftTxnCounts, sessions };
}

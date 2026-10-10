import { getLocalDb, getSyncDeviceId } from '../sqlPluginAdapter';
import { db as dexieDb } from '../database';
import { toWholeDa, type SqlDb } from './wholeDinar';
import type { CashSession } from '../../types/pos';

export type ShiftErrorCode =
  | 'SQLITE_OPEN_FAILED'
  | 'SQLITE_CLOSE_FAILED'
  | 'SQLITE_MOVEMENT_FAILED'
  | 'SHIFT_ALREADY_OPEN'
  | 'SHIFT_NOT_OPEN'
  | 'PARENT_SESSION_MISSING';

export class ShiftSqliteError extends Error {
  readonly code: ShiftErrorCode;
  readonly cause?: unknown;

  constructor(code: ShiftErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ShiftSqliteError';
    this.code = code;
    this.cause = cause;
  }
}

export const DEFAULT_TERMINAL_NAME = 'Caisse Comptoir';
export const DEFAULT_SHIFT = 'DEFAULT_SHIFT';

export const INSERT_SESSION_SQL = `INSERT INTO cash_sessions (
  id, opened_at, closed_at, opening_float, expected_cash, actual_cash, status,
  cashier_name, opening_note, closing_note, discrepancy,
  json_payload, updated_at, version, device_id, terminal_name
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const ADOPT_SESSION_SQL = `${INSERT_SESSION_SQL} ON CONFLICT(id) DO NOTHING`;

export const INSERT_MOVEMENT_SQL = `INSERT INTO cash_movements (
  id, session_id, type, amount, reason, cashier_name, created_at, json_payload, version
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1
WHERE EXISTS (SELECT 1 FROM cash_sessions WHERE id = ? AND status = 'OPEN')
ON CONFLICT(id) DO NOTHING`;

export function sessionParams(s: CashSession, deviceId: string): unknown[] {
  return [
    s.id,
    s.openedAt,
    s.closedAt ?? null,
    toWholeDa(s.openingFloat),
    s.expectedCash != null ? toWholeDa(s.expectedCash) : null,
    s.actualCash != null ? toWholeDa(s.actualCash) : null,
    s.status,
    s.cashierName || 'Caissier Principal',
    s.openingNote ?? null,
    s.closingNote ?? null,
    s.discrepancy != null ? toWholeDa(s.discrepancy) : 0,
    JSON.stringify(s),
    s.updatedAt || new Date().toISOString(),
    1,
    deviceId,
    s.terminalName || DEFAULT_TERMINAL_NAME,
  ];
}

/**
 * Inserts a Dexie session into SQLite (idempotent).
 * Used by boot adoption and the movement/refund preflights when the SQLite row is absent.
 */
export async function adoptSessionIntoSqlite(sql: SqlDb, s: CashSession): Promise<void> {
  const deviceId = s.deviceId || (await getSyncDeviceId()) || 'local';
  try {
    await sql.execute(ADOPT_SESSION_SQL, sessionParams({ ...s, deviceId }, deviceId));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes('uq_one_live_shift_per_device') || msg.includes('cash_sessions.device_id')) {
      throw new ShiftSqliteError('SHIFT_ALREADY_OPEN', 'Une autre session est déjà ouverte sur cet appareil', e);
    }
    throw e;
  }
}

/** Guarantees the parent row exists in SQLite; adopts from Dexie when it is OPEN there. */
export async function ensureSessionInSqlite(sql: SqlDb, sessionId: string): Promise<void> {
  const rows = await sql.select<{ id: string }>('SELECT id FROM cash_sessions WHERE id = ?', [sessionId]);
  if (rows.length > 0) return;
  const fromDexie = await dexieDb.cashSessions.get(sessionId);
  if (!fromDexie || fromDexie.status !== 'OPEN') {
    throw new ShiftSqliteError('PARENT_SESSION_MISSING', `Session ${sessionId} non trouvée ou non OUVERTE`);
  }
  await adoptSessionIntoSqlite(sql, fromDexie);
}

/**
 * Preflight gate for kernel operations (e.g. refund_sale_atomic).
 * Ensures the specified session is present and marked OPEN in SQLite.
 */
export async function assertShiftVisibleToKernel(sessionId: string): Promise<void> {
  const sql = (await getLocalDb()) as unknown as SqlDb;
  await ensureSessionInSqlite(sql, sessionId);
}

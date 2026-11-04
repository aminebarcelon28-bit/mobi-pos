import { toWholeDa, type SqlDb } from '../db/adapters/wholeDinar';

export interface PulledRow {
  id: string;
  data_json: string;
  version?: number | null;
  device_id?: string | null;
  updated_at?: string | null;
  deleted?: number | null;
}
type Payload = Record<string, unknown>;
export type MirrorResult = 'applied' | 'stale' | 'duplicate' | 'parked' | 'skipped';

const pick = (p: Payload, ...keys: string[]) => {
  for (const k of keys) {
    if (p[k] !== undefined && p[k] !== null) return p[k];
  }
  return undefined;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const optDa = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : toWholeDa(v));
const SESSION_STATUS = new Set(['OPEN', 'CLOSING', 'CLOSED', 'VOIDED']);
const MOVEMENT_TYPES = new Set([
  'SALE_CASH', 'REFUND_CASH', 'DEPOSIT', 'EXPENSE', 'ALLOCATION', 'FLOAT_ADJUST', 'CORRECTION',
  'MANUAL_DEPOSIT',
]);

const UPSERT_SESSION_SQL = `INSERT INTO cash_sessions (
  id, opened_at, closed_at, opening_float, expected_cash, actual_cash, status,
  cashier_name, opening_note, closing_note, discrepancy,
  json_payload, updated_at, version, device_id, terminal_name
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  status        = excluded.status,
  closed_at     = excluded.closed_at,
  expected_cash = excluded.expected_cash,
  actual_cash   = excluded.actual_cash,
  discrepancy   = excluded.discrepancy,
  closing_note  = excluded.closing_note,
  json_payload  = excluded.json_payload,
  updated_at    = excluded.updated_at,
  version       = excluded.version
WHERE (excluded.version > cash_sessions.version
       OR (excluded.version = cash_sessions.version
           AND excluded.updated_at > cash_sessions.updated_at))
  AND NOT (cash_sessions.status IN ('CLOSED','VOIDED')
           AND excluded.status IN ('OPEN','CLOSING'))`;

const INSERT_MOVEMENT_PULL_SQL = `INSERT INTO cash_movements (
  id, session_id, type, amount, reason, cashier_name, created_at, json_payload, version
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM cash_sessions WHERE id = ?)
ON CONFLICT(id) DO NOTHING`;

export async function mirrorCashSession(sql: SqlDb, row: PulledRow, p: Payload): Promise<MirrorResult> {
  // Tombstones: sessions are append-only; never deleted by a pull.
  if (row.deleted === 1) return 'skipped';
  try {
    const id = str(p.id) ?? row.id;
    const status = String(pick(p, 'status') ?? '').toUpperCase();
    const openedAt = str(pick(p, 'openedAt', 'opened_at'));
    if (!id || !SESSION_STATUS.has(status) || !openedAt) {
      console.warn('[cash-mirror] session skipped: invalid shape', { id, status, openedAt });
      return 'skipped';
    }
    const openingFloat = toWholeDa(pick(p, 'openingFloat', 'opening_float') ?? 0);
    if (openingFloat < 0) {
      console.warn('[cash-mirror] session skipped: negative opening float', { id });
      return 'skipped';
    }
    const version = Math.max(1, (Number(row.version ?? p.version ?? 1) | 0) || 1);
    const updatedAt = str(pick(p, 'updatedAt', 'updated_at')) ?? row.updated_at ?? openedAt;
    // Generic pull drops device_id; synthetic fallback avoids colliding on uq_one_live_shift_per_device.
    const deviceId = str(pick(p, 'deviceId', 'device_id')) ?? row.device_id ?? `peer:${id}`;

    const res = await sql.execute(UPSERT_SESSION_SQL, [
      id,
      openedAt,
      str(pick(p, 'closedAt', 'closed_at')),
      openingFloat,
      optDa(pick(p, 'expectedCash', 'expected_cash')),
      optDa(pick(p, 'actualCash', 'actual_cash')),
      status,
      str(pick(p, 'cashierName', 'cashier_name')) || 'Caissier Principal',
      str(pick(p, 'openingNote', 'opening_note')),
      str(pick(p, 'closingNote', 'closing_note')),
      optDa(pick(p, 'discrepancy')) ?? 0,
      row.data_json,
      updatedAt,
      version,
      deviceId,
      str(pick(p, 'terminalName', 'terminal_name')) ?? 'Caisse Comptoir',
    ]);
    await drainParkedMovements(sql, id);
    return res.rowsAffected > 0 ? 'applied' : 'stale';
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (e instanceof RangeError) {
      console.warn('[cash-mirror] session skipped: non-numeric money', msg);
      return 'skipped';
    }
    if (msg.includes('uq_one_live_shift_per_device') || msg.includes('cash_sessions.device_id')) {
      console.error('[cash-mirror] live-shift conflict on pull; SQLite mirror skipped', { id: row.id });
      return 'skipped';
    }
    throw e;
  }
}

export async function mirrorCashMovement(sql: SqlDb, row: PulledRow, p: Payload): Promise<MirrorResult> {
  if (row.deleted === 1) return 'skipped';
  try {
    const id = str(p.id) ?? row.id;
    const sessionId = str(pick(p, 'sessionId', 'session_id'));
    const rawType = String(pick(p, 'type') ?? '').toUpperCase();
    const type = rawType === 'MANUAL_DEPOSIT' ? 'DEPOSIT' : rawType;
    if (!id || !sessionId || !MOVEMENT_TYPES.has(rawType)) {
      console.warn('[cash-mirror] movement skipped: invalid shape', { id, sessionId, rawType });
      return 'skipped';
    }
    const amount = toWholeDa(pick(p, 'amount'));
    const createdAt = str(pick(p, 'createdAt', 'created_at')) ?? row.updated_at ?? new Date(0).toISOString();
    const version = Math.max(1, (Number(row.version ?? p.version ?? 1) | 0) || 1);
    const reason = str(pick(p, 'reason')) || 'Mouvement synchronisé';

    const res = await sql.execute(INSERT_MOVEMENT_PULL_SQL, [
      id, sessionId, type, amount,
      reason,
      str(pick(p, 'cashierName', 'cashier_name')),
      createdAt, row.data_json, version, sessionId,
    ]);
    if (res.rowsAffected > 0) return 'applied';

    const exists = await sql.select<{ id: string }>('SELECT id FROM cash_movements WHERE id = ?', [id]);
    if (exists.length > 0) return 'duplicate';

    // Parent absent: park in sync_parked_movements, never drop.
    await sql.execute(
      `INSERT INTO sync_parked_movements (id, session_id, data_json, row_version, parked_at, attempts)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, row_version = excluded.row_version`,
      [id, sessionId, row.data_json, version, new Date().toISOString()],
    );
    return 'parked';
  } catch (e) {
    if (e instanceof RangeError) {
      console.warn('[cash-mirror] movement skipped: non-numeric amount', String((e as Error).message));
      return 'skipped';
    }
    throw e;
  }
}

const PARKED_MAX_ATTEMPTS = 20;

export async function drainParkedMovements(sql: SqlDb, sessionId: string): Promise<void> {
  const rows = await sql.select<{ id: string; data_json: string; row_version: number }>(
    'SELECT id, data_json, row_version FROM sync_parked_movements WHERE session_id = ?',
    [sessionId],
  );
  for (const r of rows) {
    const payload = JSON.parse(r.data_json) as Payload;
    const out = await mirrorCashMovement(sql, { id: r.id, data_json: r.data_json, version: r.row_version }, payload);
    if (out === 'applied' || out === 'duplicate' || out === 'skipped') {
      await sql.execute('DELETE FROM sync_parked_movements WHERE id = ?', [r.id]);
    }
  }
}

export async function drainAllParkedMovements(sql: SqlDb): Promise<void> {
  const ready = await sql.select<{ session_id: string }>(
    `SELECT DISTINCT p.session_id FROM sync_parked_movements p
       JOIN cash_sessions s ON s.id = p.session_id`,
  );
  for (const r of ready) await drainParkedMovements(sql, r.session_id);

  // Native once boot maintenance ran (fixed literal); renderer SQL is the
  // fallback for a host without the command.
  try {
    const { invokeCommand } = await import('../platform/invoke');
    await invokeCommand<number>('bump_parked_attempts_command');
  } catch {
    await sql.execute('UPDATE sync_parked_movements SET attempts = attempts + 1');
  }
  const dead = await sql.select<{ id: string; session_id: string }>(
    'SELECT id, session_id FROM sync_parked_movements WHERE attempts >= ?',
    [PARKED_MAX_ATTEMPTS],
  );
  for (const d of dead) {
    console.error('[cash-mirror] parked movement exceeded retry budget (kept for review)', d);
  }
}


/**
 * UPGRADE-05 — technician roster, time-on-job and commission rules adapter.
 *
 * Storage: plain SQLite tables `technicians`, `technician_time_log`,
 * `commission_rules` (migration v120). Merchant-local operational config —
 * like price books, NOT trust tables and NOT synced entities (no outbox
 * lane). Repair-linked commission results ride `repair_orders.json_payload`.
 *
 * Outside Tauri every read degrades to empty/null and every write fails
 * loudly (the WebView preview has no workshop tables — documented residual).
 */
import { isTauriEnv } from './base';
import { newId } from '../../utils/ids';
import type { CommissionBasis } from '../../utils/technicianCommission';

export interface TechnicianRecord {
  id: string;
  name: string;
  role: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TechnicianInput {
  id?: string;
  name: string;
  role?: string;
  active?: boolean;
}

export interface TimeLogRecord {
  id: string;
  repairId: string;
  technicianId: string;
  kind: string;
  startedAt: string;
  /** null while the session is running. */
  endedAt: string | null;
}

export interface TimeLogQuery {
  repairId?: string;
  technicianId?: string;
  /** ISO lower bound on started_at (inclusive). */
  sinceIso?: string;
}

export interface CommissionRuleRecord {
  id: string;
  technicianId: string | null;
  basis: CommissionBasis;
  ratePercent: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommissionRuleInput {
  id?: string;
  technicianId?: string | null;
  basis?: CommissionBasis;
  ratePercent: number;
  active?: boolean;
}

async function pluginDb() {
  const { getLocalDb, utcNowIso } = await import('../sqlPluginAdapter');
  const db = await getLocalDb();
  return { db, utcNowIso };
}

interface RawTechnicianRow {
  id: string;
  name: string;
  role: string | null;
  active: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface RawTimeLogRow {
  id: string;
  repair_id: string;
  technician_id: string;
  kind: string | null;
  started_at: string;
  ended_at: string | null;
}

interface RawRuleRow {
  id: string;
  technician_id: string | null;
  basis: string | null;
  rate_percent: number | string | null;
  active: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

function mapTechnician(row: RawTechnicianRow): TechnicianRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    role: String(row.role ?? 'Technicien'),
    active: Number(row.active) !== 0,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

function mapTimeLog(row: RawTimeLogRow): TimeLogRecord {
  return {
    id: String(row.id),
    repairId: String(row.repair_id),
    technicianId: String(row.technician_id),
    kind: String(row.kind ?? 'work'),
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : null,
  };
}

function mapRule(row: RawRuleRow): CommissionRuleRecord {
  return {
    id: String(row.id),
    technicianId: row.technician_id ? String(row.technician_id) : null,
    basis: row.basis === 'total' ? 'total' : 'labor',
    ratePercent: Number(row.rate_percent) || 0,
    active: Number(row.active) !== 0,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

// ── Roster ────────────────────────────────────────────────────────────────

export function isTechnicianStorageAvailable(): boolean {
  return isTauriEnv();
}

/** Full roster, active first then name order (management + pickers). */
export async function listTechnicians(): Promise<TechnicianRecord[]> {
  if (!isTauriEnv()) return [];
  try {
    const { db } = await pluginDb();
    const rows = (await db.select(
      `SELECT id, name, role, active, created_at, updated_at FROM technicians
       ORDER BY active DESC, name ASC`
    )) as RawTechnicianRow[];
    return (rows ?? []).map(mapTechnician);
  } catch (err) {
    console.error('listTechnicians failed:', err);
    return [];
  }
}

export async function getTechnician(id: string): Promise<TechnicianRecord | null> {
  if (!isTauriEnv() || !id) return null;
  try {
    const { db } = await pluginDb();
    const rows = (await db.select(
      `SELECT id, name, role, active, created_at, updated_at FROM technicians WHERE id = $1`,
      [id]
    )) as RawTechnicianRow[];
    return rows && rows.length > 0 ? mapTechnician(rows[0]) : null;
  } catch (err) {
    console.error(`getTechnician failed [${id}]:`, err);
    return null;
  }
}

/** Upsert one technician. Returns the id on success, null on failure. */
export async function saveTechnician(input: TechnicianInput): Promise<string | null> {
  if (!isTauriEnv() || !input.name?.trim()) return null;
  try {
    const { db, utcNowIso } = await pluginDb();
    const id = input.id && input.id !== '' ? input.id : newId('tech');
    await db.execute(
      `INSERT INTO technicians (id, name, role, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         active = excluded.active,
         updated_at = excluded.updated_at`,
      [id, input.name.trim(), (input.role ?? 'Technicien').trim() || 'Technicien', input.active === false ? 0 : 1, utcNowIso()]
    );
    return id;
  } catch (err) {
    console.error('saveTechnician failed:', err);
    return null;
  }
}

// ── Time log ──────────────────────────────────────────────────────────────

/** Filtered time-log read; newest first. Aggregation lives in the callers. */
export async function listTimeLogs(query: TimeLogQuery = {}): Promise<TimeLogRecord[]> {
  if (!isTauriEnv()) return [];
  try {
    const { db } = await pluginDb();
    const where: string[] = [];
    const params: Array<string> = [];
    if (query.repairId) {
      params.push(query.repairId);
      where.push(`repair_id = $${params.length}`);
    }
    if (query.technicianId) {
      params.push(query.technicianId);
      where.push(`technician_id = $${params.length}`);
    }
    if (query.sinceIso) {
      params.push(query.sinceIso);
      where.push(`started_at >= $${params.length}`);
    }
    const sql = `SELECT id, repair_id, technician_id, kind, started_at, ended_at FROM technician_time_log
                 ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY started_at DESC`;
    const rows = (await db.select(sql, params)) as RawTimeLogRow[];
    return (rows ?? []).map(mapTimeLog);
  } catch (err) {
    console.error('listTimeLogs failed:', err);
    return [];
  }
}

/** The running session for a repair, if any (at most one is allowed). */
export async function getOpenTimeLogForRepair(repairId: string): Promise<TimeLogRecord | null> {
  if (!isTauriEnv() || !repairId) return null;
  try {
    const { db } = await pluginDb();
    const rows = (await db.select(
      `SELECT id, repair_id, technician_id, kind, started_at, ended_at FROM technician_time_log
       WHERE repair_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [repairId]
    )) as RawTimeLogRow[];
    return rows && rows.length > 0 ? mapTimeLog(rows[0]) : null;
  } catch (err) {
    console.error(`getOpenTimeLogForRepair failed [${repairId}]:`, err);
    return null;
  }
}

/** Open one work session. Returns the id on success, null on failure. */
export async function startTimeLog(
  repairId: string,
  technicianId: string,
  kind = 'work'
): Promise<string | null> {
  if (!isTauriEnv() || !repairId || !technicianId) return null;
  try {
    const { utcNowIso } = await pluginDb();
    const id = newId('tlog');
    // Native lane (SEC-01): the session row is written without the pool.
    const { invokeCommand } = await import('../../platform/invoke');
    await invokeCommand<{ changes: number }>('start_time_log', {
      id,
      repairId,
      technicianId,
      kind,
      startedAt: utcNowIso(),
    });
    return id;
  } catch (err) {
    console.error('startTimeLog failed:', err);
    return null;
  }
}

/** Close every running session of a repair (idempotent). Returns rows closed. */
export async function closeOpenTimeLogsForRepair(repairId: string, endedAtIso: string): Promise<number> {
  if (!isTauriEnv() || !repairId) return 0;
  try {
    // Native lane (SEC-01): closes every running session of the repair.
    const { invokeCommand } = await import('../../platform/invoke');
    return await invokeCommand<number>('close_open_time_logs', {
      repairId,
      endedAt: endedAtIso,
    });
  } catch (err) {
    console.error(`closeOpenTimeLogsForRepair failed [${repairId}]:`, err);
    return 0;
  }
}

// ── Commission rules ──────────────────────────────────────────────────────

export async function listCommissionRules(): Promise<CommissionRuleRecord[]> {
  if (!isTauriEnv()) return [];
  try {
    const { db } = await pluginDb();
    const rows = (await db.select(
      `SELECT id, technician_id, basis, rate_percent, active, created_at, updated_at FROM commission_rules
       ORDER BY created_at DESC`
    )) as RawRuleRow[];
    return (rows ?? []).map(mapRule);
  } catch (err) {
    console.error('listCommissionRules failed:', err);
    return [];
  }
}

/** Upsert one rule. Returns the id on success, null on failure. */
export async function saveCommissionRule(input: CommissionRuleInput): Promise<string | null> {
  if (!isTauriEnv()) return null;
  try {
    const { db, utcNowIso } = await pluginDb();
    const id = input.id && input.id !== '' ? input.id : newId('crule');
    await db.execute(
      `INSERT INTO commission_rules (id, technician_id, basis, rate_percent, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT(id) DO UPDATE SET
         technician_id = excluded.technician_id,
         basis = excluded.basis,
         rate_percent = excluded.rate_percent,
         active = excluded.active,
         updated_at = excluded.updated_at`,
      [
        id,
        input.technicianId ?? null,
        input.basis === 'total' ? 'total' : 'labor',
        Math.max(0, Math.min(100, Number(input.ratePercent) || 0)),
        input.active === false ? 0 : 1,
        utcNowIso(),
      ]
    );
    return id;
  } catch (err) {
    console.error('saveCommissionRule failed:', err);
    return null;
  }
}

export async function deleteCommissionRule(id: string): Promise<boolean> {
  if (!isTauriEnv() || !id) return false;
  try {
    const { db } = await pluginDb();
    await db.execute('DELETE FROM commission_rules WHERE id = $1', [id]);
    return true;
  } catch (err) {
    console.error(`deleteCommissionRule failed [${id}]:`, err);
    return false;
  }
}

/** Every running session (ended_at IS NULL) — the bench board's live set. */
export async function listOpenTimeLogs(): Promise<TimeLogRecord[]> {
  if (!isTauriEnv()) return [];
  try {
    const { db } = await pluginDb();
    const rows = (await db.select(
      `SELECT id, repair_id, technician_id, kind, started_at, ended_at FROM technician_time_log
       WHERE ended_at IS NULL ORDER BY started_at DESC`
    )) as RawTimeLogRow[];
    return (rows ?? []).map(mapTimeLog);
  } catch (err) {
    console.error('listOpenTimeLogs failed:', err);
    return [];
  }
}

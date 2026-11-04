import { fireSync } from './adapters/base';
import { db as dexieDb } from './database';
import { getLocalDb, getSyncDeviceId, nativeBootMaintenanceApplied } from './sqlPluginAdapter';
import { invokeCommand } from '../platform/invoke';
import { adoptSessionIntoSqlite } from './adapters/shiftSqlite';
import { drainAllParkedMovements } from '../sync/cashMirror';
import type { CashSession } from '../types/pos';
import type { SqlDb } from './adapters/wholeDinar';

export interface BootAdoptionReport {
  deviceId: string;
  foreignKeysOnTsPool: number | null;
  keepId: string | null;
  dexieDemoted: string[];
  sqliteDemoted: number;
  adopted: boolean;
  indexCreated: boolean;
  duplicateLiveRemaining: number;
}

let bootPromise: Promise<BootAdoptionReport> | null = null;
export const runShiftBootAdoption = (): Promise<BootAdoptionReport> => (bootPromise ??= adopt());

const ts = (s: { openedAt?: string; opened_at?: string }) => Date.parse((s.openedAt ?? s.opened_at) as string) || 0;
const newest = <T extends { id: string }>(a: T, b: T, key: (x: T) => number) =>
  key(a) !== key(b) ? (key(a) > key(b) ? a : b) : a.id > b.id ? a : b;

async function adopt(): Promise<BootAdoptionReport> {
  const sql = (await getLocalDb()) as unknown as SqlDb;
  const deviceId = (await getSyncDeviceId()) || 'local';
  const now = new Date().toISOString();
  const report: BootAdoptionReport = {
    deviceId,
    foreignKeysOnTsPool: null,
    keepId: null,
    dexieDemoted: [],
    sqliteDemoted: 0,
    adopted: false,
    indexCreated: false,
    duplicateLiveRemaining: 0,
  };

  try {
    const fk = await sql.select<{ foreign_keys: number }>('PRAGMA foreign_keys');
    report.foreignKeysOnTsPool = fk[0]?.foreign_keys ?? null;
  } catch {
    // best-effort diagnostics
  }

  // 1-2. Candidate sets
  const dexieOpen = (await dexieDb.cashSessions
    .filter((s) => s.status === 'OPEN' && (!s.deviceId || s.deviceId === deviceId))
    .toArray()) as CashSession[];

  const dexieCandidates: CashSession[] = [];
  for (const session of dexieOpen) {
    const durableRows = await sql.select<{
      status: string;
      closed_at: string | null;
      closing_note: string | null;
    }>(
      'SELECT status, closed_at, closing_note FROM cash_sessions WHERE id = ?',
      [session.id],
    );
    const durable = durableRows[0];
    if (durable && !['OPEN', 'CLOSING'].includes(durable.status)) {
      const closed: CashSession = {
        ...session,
        status: 'CLOSED',
        closedAt: durable.closed_at || session.closedAt || now,
        closingNote: durable.closing_note ?? session.closingNote,
        updatedAt: now,
      };
      await dexieDb.cashSessions.put(closed);
      await fireSync('cash_session', closed.id, closed).catch((e) =>
        console.warn('[SHIFT-BOOT] fireSync stale mirror close failed', e)
      );
      report.dexieDemoted.push(session.id);
      continue;
    }
    dexieCandidates.push(session);
  }

  const sqliteLive = await sql.select<{ id: string; opened_at: string }>(
    `SELECT id, opened_at FROM cash_sessions
      WHERE (device_id = ? OR device_id IS NULL OR TRIM(device_id) = '') AND status IN ('OPEN','CLOSING')
      ORDER BY opened_at DESC, id DESC`,
    [deviceId],
  );

  // 3. Survivor
  const pool = [
    ...dexieCandidates.map((s) => ({ id: s.id, t: ts(s) })),
    ...sqliteLive.map((s) => ({ id: s.id, t: ts(s) })),
  ];
  const keep = pool.length ? pool.reduce((a, b) => newest(a, b, (x) => x.t)) : null;
  report.keepId = keep?.id ?? null;

  if (keep) {
    // 4. Demote Dexie losers
    for (const s of dexieCandidates.filter((x) => x.id !== keep.id)) {
      const closed: CashSession = {
        ...s,
        status: 'CLOSED',
        closedAt: now,
        closingNote: s.closingNote ? `${s.closingNote} | AUTO_CLOSED_DUPLICATE_LIVE_SHIFT` : 'AUTO_CLOSED_DUPLICATE_LIVE_SHIFT',
        deviceId,
        updatedAt: now,
      };
      await dexieDb.cashSessions.put(closed);
      await fireSync('cash_session', closed.id, closed).catch((e) =>
        console.warn('[SHIFT-BOOT] fireSync demote failed', e)
      );
      report.dexieDemoted.push(s.id);
    }

    // 5. Demote SQLite losers — native once boot maintenance has run (fixed
    // literal, same transaction policy), renderer SQL only as the fallback.
    const demoteSqliteLosers = (): Promise<{ rowsAffected: number }> =>
      sql.execute(
        `UPDATE cash_sessions
           SET status = 'CLOSED',
               closed_at = COALESCE(closed_at, ?),
               closing_note = CASE WHEN closing_note IS NULL OR closing_note = ''
                                   THEN 'AUTO_CLOSED_DUPLICATE_LIVE_SHIFT'
                                   ELSE closing_note || ' | AUTO_CLOSED_DUPLICATE_LIVE_SHIFT' END,
               json_payload = CASE WHEN json_valid(json_payload)
                                   THEN json_set(json_payload, '$.status', 'CLOSED')
                                   ELSE json_payload END,
               updated_at = ?,
               version = version + 1
         WHERE device_id = ? AND status IN ('OPEN','CLOSING') AND id <> ?`,
        [now, now, deviceId, keep.id],
      ) as Promise<{ rowsAffected: number }>;

    let res: { rowsAffected: number };
    if (nativeBootMaintenanceApplied()) {
      try {
        res = { rowsAffected: await invokeCommand<number>('finalize_shift_adoption', { deviceId, keepId: keep.id, nowIso: now }) };
      } catch (e) {
        console.warn('[SHIFT-BOOT] native finalize refused; renderer fallback', e);
        res = await demoteSqliteLosers();
      }
    } else {
      res = await demoteSqliteLosers();
    }
    report.sqliteDemoted = res.rowsAffected;

    // 6. Adopt the survivor if it is in Dexie but absent from SQLite
    const inSqlite = await sql.select<{ id: string }>('SELECT id FROM cash_sessions WHERE id = ?', [keep.id]);
    const survivor = dexieCandidates.find((s) => s.id === keep.id);
    if (inSqlite.length === 0 && survivor) {
      await adoptSessionIntoSqlite(sql, { ...survivor, deviceId });
      report.adopted = true;
    }
  }

  // 7. Pre-check duplicates
  const dups = await sql.select<{ device_id: string; live_count: number }>(
    `SELECT device_id, COUNT(*) AS live_count FROM cash_sessions
      WHERE status IN ('OPEN','CLOSING') GROUP BY device_id HAVING COUNT(*) > 1`,
  );
  report.duplicateLiveRemaining = dups.length;

  // 8. Create invariant index if clean (native owns DDL once boot_maintenance ran)
  if (dups.length === 0) {
    if (nativeBootMaintenanceApplied()) {
      // Native maintenance (and finalize_shift_adoption) created it.
      report.indexCreated = true;
    } else {
      await sql.execute(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_one_live_shift_per_device
           ON cash_sessions(device_id) WHERE status IN ('OPEN','CLOSING')`,
      );
      report.indexCreated = true;
    }
  } else {
    console.error('[SHIFT-BOOT] duplicate live shifts remain; unique index NOT created', dups);
  }

  // Drain parked movements whose parents may have now landed
  await drainAllParkedMovements(sql).catch((err) =>
    console.warn('[SHIFT-BOOT] drainAllParkedMovements warning:', err)
  );

  console.info('[SHIFT-BOOT]', JSON.stringify(report));
  return report;
}


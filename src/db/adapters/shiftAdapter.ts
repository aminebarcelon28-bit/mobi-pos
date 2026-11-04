import type {
  CashDropEntry,
  StoreExpense,
  CashSession,
  CashMovement,
  DenominationCount,
  InventoryValuation,
} from '../../types/pos';
import { db as dexieDb } from '../database';
import { fireSync, fireSyncDelete, isTauriEnv } from './base';
import { getLocalDb } from '../sqlPluginAdapter';
import { newId } from '../../utils/ids';
import { verifyManagerGate } from '../../utils/pinGate';
import { cashSalesFromTxns, cashRefundsFromTxns, DRAWER_REASON_PREFIXES } from '../../utils/cashTerms';
import { toWholeDa, type SqlDb } from './wholeDinar';
import {
  INSERT_SESSION_SQL,
  INSERT_MOVEMENT_SQL,
  sessionParams,
  ensureSessionInSqlite,
  ShiftSqliteError,
} from './shiftSqlite';

/**
 * Minimal close-window transaction shape. Both the SQLite authority reader
 * and the Dexie-mirror reader below normalize to this, so the filter +
 * tender math underneath runs once, identically, whichever source fed it.
 */
interface CloseWindowTxn {
  id: string;
  total: number;
  profit: number;
  /** Signed stored row cost (both legs for exchanges). Absent = unknown. */
  costTotal?: number;
  /** Materialized frozen ledger sum. Absent = unknown (legacy rows). */
  ledgerCogsTotal?: number;
  /** Return leg present — margin must use the signed row cost. */
  isExchange: boolean;
  /** Owning cash session id, stamped at checkout. Absent on legacy rows. */
  shiftId?: string;
  paymentMethod: string;
  tenders?: Array<{ method?: string; amount?: number }>;
  changeDue: number;
  status: string;
  createdAt: string;
  isRefund: boolean;
  refundMethod?: string;
  deviceId?: string;
}

export interface CloseScopeSession {
  id?: string;
  openedAt?: string | null;
  closedAt?: string | null;
}

/**
 * Single close-scope rule shared by the booking adapter and the preview
 * modal so both count exactly the same tickets. Stamped rows belong to
 * exactly one session: their own while it is open (even slightly outside
 * the window — clock skew), never a closed session they outlived (frozen
 * books are immutable). Unstamped legacy rows keep the pure createdAt
 * window rule, closed by `closedAt` (or now while open) so post-close sales
 * can no longer leak into a booked Z. VOIDED never counts.
 */
export function isTxInCloseScope(
  t: { status?: string; createdAt?: string; shiftId?: string },
  session: CloseScopeSession,
  nowIso?: string
): boolean {
  if (t.status === 'VOIDED') return false;
  const stamp = t.shiftId ? String(t.shiftId) : '';
  const sid = session.id ? String(session.id) : '';
  if (stamp && sid) {
    if (stamp === sid) {
      if (!session.closedAt) return true;
      return String(t.createdAt ?? '') < String(session.closedAt);
    }
    return false;
  }
  const openedAt = session.openedAt ?? null;
  if (openedAt && !((t.createdAt ?? '') >= openedAt)) return false;
  const upper = session.closedAt ?? nowIso ?? new Date().toISOString();
  if (!((t.createdAt ?? '') < upper)) return false;
  return true;
}

function safeParseTxPayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Money fields must be finite numbers — a corrupt row must read as 0,
 * never NaN-poison the whole close (the old Dexie path summed raw values). */
function toCloseAmount(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Cash close reads from the SQLite authority on Tauri (pro rule: a close
 * certifies money, and a certified write decision must never read from the
 * Dexie projection — projections lag, ghost, and rebuild). Rows are parsed
 * payload-first with scalar columns as fallback, mirroring the Dexie object
 * shape field-for-field so downstream math cannot drift between sources.
 */
async function readCloseTxnsAuthority(openedAt: string | null): Promise<CloseWindowTxn[]> {
  const { getLocalDb } = await import('../sqlPluginAdapter');
  const { withBusyRetry } = await import('../busyRetry');
  const db = await getLocalDb();
  const baseCols = `id, receipt_number, total, profit, payment_method, status,
            created_at, json_payload, device_id`;
  // Column variants, newest-first: a pre-heal database missing the newer
  // costing/attribution columns falls back gracefully (those rows simply
  // keep stored profit, exactly as before) instead of blocking the close.
  const colVariants = [
    `${baseCols}, cost_total, ledger_cogs_total, shift_id`,
    `${baseCols}, cost_total, ledger_cogs_total`,
    baseCols,
  ];
  const runSelect = (cols: string) =>
    db.select(
      openedAt
        ? `SELECT ${cols}
           FROM transactions
           WHERE (deleted = 0 OR deleted IS NULL) AND created_at >= $1`
        : `SELECT ${cols}
           FROM transactions
           WHERE (deleted = 0 OR deleted IS NULL)`,
      openedAt ? [openedAt] : undefined
    );
  let rows: Array<Record<string, unknown>> | undefined;
  for (const cols of colVariants) {
    try {
      rows = (await withBusyRetry(() => runSelect(cols), {
        attempts: 3,
        baseDelayMs: 60,
        label: 'close-authority-read',
      })) as Array<Record<string, unknown>>;
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isLast = cols === colVariants[colVariants.length - 1];
      if (!/no such column/i.test(msg) || isLast) throw e;
    }
  }
  rows = rows ?? [];
  const finiteOrUndefined = (v: unknown, nonNegative: boolean): number | undefined => {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    if (nonNegative && n < 0) return undefined;
    return Math.round(n);
  };
  const detectExchange = (items: unknown): boolean =>
    Array.isArray(items) &&
    (items as Array<unknown>).some(
      (it) =>
        Boolean(
          (it as { isReturn?: unknown }).isReturn ??
            (it as { is_return?: unknown }).is_return
        ) || Number((it as { quantity?: unknown }).quantity) < 0
    );
  return (rows ?? []).map((r) => {
    const payload = safeParseTxPayload(r.json_payload);
    const tendersRaw = payload.tenders;
    return {
      id: String(r.id ?? ''),
      total: toCloseAmount(payload.total ?? r.total ?? 0),
      profit: toCloseAmount(payload.profit ?? r.profit ?? 0),
      costTotal: finiteOrUndefined(payload.costTotal ?? payload.cost_total ?? r.cost_total, false),
      ledgerCogsTotal: finiteOrUndefined(
        payload.ledgerCogsTotal ?? payload.ledger_cogs_total ?? r.ledger_cogs_total,
        true
      ),
      isExchange: detectExchange(payload.items),
      paymentMethod: String(payload.paymentMethod ?? payload.payment_method ?? r.payment_method ?? 'Espèces'),
      tenders: Array.isArray(tendersRaw)
        ? (tendersRaw as Array<Record<string, unknown>>).map((t) => ({
            method: String(t.method ?? ''),
            amount: toCloseAmount(t.amount ?? 0),
          }))
        : undefined,
      changeDue: toCloseAmount(payload.changeDue ?? payload.change_due ?? 0),
      status: String(payload.status ?? r.status ?? 'COMPLETED'),
      createdAt: String(payload.createdAt ?? payload.created_at ?? r.created_at ?? ''),
      shiftId:
        typeof payload.shiftId === 'string'
          ? payload.shiftId
          : typeof r.shift_id === 'string'
            ? (r.shift_id as string)
            : undefined,
      isRefund: Boolean(payload.isRefund ?? false),
      refundMethod: (payload.refundMethod ?? payload.refund_method ?? undefined) as string | undefined,
      deviceId: (payload.deviceId ?? payload.device_id ?? r.device_id ?? undefined) as string | undefined,
    };
  });
}

/** Legacy reader: Dexie IS the store on web preview (no SQLite authority). */
async function readCloseTxnsDexie(openedAt: string | null): Promise<CloseWindowTxn[]> {
  const txns = openedAt
    ? await dexieDb.transactions.where('createdAt').aboveOrEqual(openedAt).toArray()
    : await dexieDb.transactions.toArray();
  const finiteOrUndefined = (v: unknown, nonNegative: boolean): number | undefined => {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    if (nonNegative && n < 0) return undefined;
    return Math.round(n);
  };
  return txns.map((t) => ({
    id: t.id,
    total: t.total,
    profit: t.profit || 0,
    costTotal: finiteOrUndefined(t.costTotal, false),
    ledgerCogsTotal: finiteOrUndefined(
      (t as { ledgerCogsTotal?: unknown }).ledgerCogsTotal,
      true
    ),
    shiftId: (t as { shiftId?: unknown }).shiftId as string | undefined,
    isExchange: Array.isArray(t.items)
      ? (t.items as Array<unknown>).some(
          (it) =>
            Boolean(
              (it as { isReturn?: unknown }).isReturn ??
                (it as { is_return?: unknown }).is_return
            ) || Number((it as { quantity?: unknown }).quantity) < 0
        )
      : false,
    paymentMethod: t.paymentMethod,
    tenders: t.tenders as Array<{ method?: string; amount?: number }> | undefined,
    changeDue: t.changeDue || 0,
    // SaleTransaction.status is optional; default mirrors the SQLite authority
    // reader above ('COMPLETED'). Runtime behavior unchanged: undefined never
    // equalled 'VOIDED', so the row was included — same as now.
    status: t.status ?? 'COMPLETED',
    createdAt: t.createdAt,
    isRefund: Boolean(t.isRefund),
    refundMethod: (t as { refundMethod?: string }).refundMethod,
    deviceId: t.deviceId,
  }));
}

/**
 * Variance gate: a blind-count discrepancy at or above this threshold (integer
 * DZD) requires manager-PIN authorization before the shift can close.
 * Single source of truth — the close modal imports this constant for its UI.
 */
export const SHIFT_VARIANCE_MANAGER_PIN_THRESHOLD = 1000;

/** Machine-readable close/open failure codes surfaced via `reason`. */
export const SHIFT_ALREADY_OPEN = 'SHIFT_ALREADY_OPEN';
export const SHIFT_NO_OPEN_SESSION = 'NO_OPEN_SHIFT';
export const SHIFT_CLOSING_NOTE_REQUIRED = 'CLOSING_NOTE_REQUIRED';
export const SHIFT_MANAGER_PIN_REQUIRED = 'MANAGER_PIN_REQUIRED';
export const SHIFT_MANAGER_PIN_INVALID = 'MANAGER_PIN_INVALID';

export interface CodedShiftError extends Error {
  code: string;
  existingSession?: CashSession | null;
}

/**
 * Runtime-only attribution extras persisted on the Dexie cash-session row.
 * Kept out of the shared CashSession type (owned by another agent) — readers
 * cast via `as CashSession & ShiftAttribution`.
 */
export interface ShiftAttribution {
  openedBy?: string;
  currentCashier?: string;
}

function codedError(code: string, message: string, existingSession?: CashSession | null): CodedShiftError {
  const err = new Error(message) as CodedShiftError;
  err.code = code;
  if (existingSession !== undefined) err.existingSession = existingSession;
  return err;
}

export const shiftAdapter = {
  // ── CASH DROPS & PAYOUTS ──
  async saveCashDrop(entry: CashDropEntry, isPayout = false): Promise<void> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        await db.execute(
          `INSERT INTO cash_drops (id, timestamp, amount, reason, user, is_payout)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT(id) DO UPDATE SET
             timestamp=excluded.timestamp,
             amount=excluded.amount,
             reason=excluded.reason,
             user=excluded.user,
             is_payout=excluded.is_payout,
             version=cash_drops.version + 1`,
          [
            entry.id,
            entry.timestamp || new Date().toISOString(),
            entry.amount || 0,
            entry.reason || '',
            entry.user || 'Admin',
            isPayout ? 1 : 0,
          ],
        );
      } catch (err) {
        console.warn('[shiftAdapter] SQLite saveCashDrop failed, fallback to Dexie:', err);
      }
    }
    if (isPayout) {
      await dexieDb.payouts.put(entry);
    } else {
      await dexieDb.cashDrops.put(entry);
    }
    void fireSync('cash_drop', entry.id, { ...entry, _isPayout: isPayout });
  },

  async getCashDrops(isPayout = false): Promise<CashDropEntry[]> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = (await db.select(
          'SELECT id, timestamp, amount, reason, user FROM cash_drops WHERE is_payout = $1 ORDER BY timestamp DESC',
          [isPayout ? 1 : 0],
        )) as Array<{ id: string; timestamp: string; amount: number; reason: string; user: string }>;
        if (rows && rows.length > 0) {
          const list: CashDropEntry[] = rows.map((r) => ({
            id: r.id,
            timestamp: r.timestamp,
            amount: Number(r.amount || 0),
            reason: r.reason || '',
            user: r.user || 'Admin',
          }));
          if (isPayout) {
            void dexieDb.payouts.bulkPut(list).catch(() => {});
          } else {
            void dexieDb.cashDrops.bulkPut(list).catch(() => {});
          }
          return list;
        }
      } catch (err) {
        console.warn('[shiftAdapter] SQLite getCashDrops failed, fallback to Dexie:', err);
      }
    }
    return isPayout ? await dexieDb.payouts.toArray() : await dexieDb.cashDrops.toArray();
  },

  // ── STORE EXPENSES (EBITDA) ──
  async saveStoreExpense(expense: StoreExpense): Promise<void> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const payload = JSON.stringify(expense);
        await db.execute(
          `INSERT INTO store_expenses (id, category, title, amount, payment_method, paid_to, notes, recorded_by, created_at, json_payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT(id) DO UPDATE SET
             category=excluded.category,
             title=excluded.title,
             amount=excluded.amount,
             payment_method=excluded.payment_method,
             paid_to=excluded.paid_to,
             notes=excluded.notes,
             recorded_by=excluded.recorded_by,
             json_payload=excluded.json_payload,
             version=store_expenses.version + 1`,
          [
            expense.id,
            expense.category || 'Général',
            expense.title || '',
            expense.amount || 0,
            expense.paymentMethod || 'Espèces',
            expense.paidTo || null,
            expense.notes || null,
            expense.recordedBy || 'Admin',
            expense.createdAt || new Date().toISOString(),
            payload,
          ],
        );
      } catch (err) {
        console.warn('[shiftAdapter] SQLite saveStoreExpense failed, fallback to Dexie:', err);
      }
    }
    await dexieDb.storeExpenses.put(expense);
    void fireSync('store_expense', expense.id, expense);
  },

  /**
   * UPGRADE-01: bounded/on-demand expense lane. Boot and post-pull refreshes
   * pass `{ limit }`; report/expense modals load the full list (or a shift /
   * date range) explicitly when opened — expense history must never be part of
   * the unbounded boot tail.
   */
  async getAllStoreExpenses(opts?: {
    limit?: number;
    from?: string | null;
    to?: string | null;
  }): Promise<StoreExpense[]> {
    const from = opts?.from && opts.from.length > 0 ? opts.from : null;
    const to = opts?.to && opts.to.length > 0 ? opts.to : null;
    const limit = opts?.limit && opts.limit > 0 ? Math.floor(opts.limit) : undefined;
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const where: string[] = [];
        const params: unknown[] = [];
        if (from) {
          params.push(from);
          where.push(`created_at >= $${params.length}`);
        }
        if (to) {
          params.push(to);
          where.push(`created_at <= $${params.length}`);
        }
        const rows = (await db.select(
          `SELECT json_payload FROM store_expenses ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC${limit !== undefined ? ` LIMIT ${limit}` : ''}`,
          params
        )) as Array<{ json_payload: string }>;
        if (rows && rows.length > 0) {
          const list = rows
            .map((r) => {
              try {
                return JSON.parse(r.json_payload) as StoreExpense;
              } catch {
                return null;
              }
            })
            .filter((e): e is StoreExpense => e !== null);
          if (list.length > 0) {
            void dexieDb.storeExpenses.bulkPut(list).catch(() => {});
            return list;
          }
        }
      } catch (err) {
        console.warn('[shiftAdapter] SQLite getAllStoreExpenses failed, fallback to Dexie:', err);
      }
    }
    let list = await dexieDb.storeExpenses.orderBy('createdAt').reverse().toArray();
    if (from) list = list.filter((e) => String(e.createdAt ?? '') >= from);
    if (to) list = list.filter((e) => String(e.createdAt ?? '') <= to);
    if (limit !== undefined) list = list.slice(0, limit);
    return list;
  },

  async deleteStoreExpense(id: string): Promise<void> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        await db.execute('DELETE FROM store_expenses WHERE id = $1', [id]);
      } catch (err) {
        console.warn('[shiftAdapter] SQLite deleteStoreExpense failed:', err);
      }
    }
    await dexieDb.storeExpenses.delete(id);
    void fireSyncDelete('store_expense', id);
  },

  // ── CASH REGISTER SESSIONS & MOVEMENTS ──
  async startShift(
    openingFloat: number,
    cashierName?: string,
    openingNote?: string,
    denominations?: DenominationCount,
    openedBy?: string
  ): Promise<CashSession> {
    // Double-open guard: a second shift would orphan the first session's cash
    // (getActiveShift uses .first()), so refuse explicitly instead of inserting.
    const alreadyOpen = await dexieDb.cashSessions.where('status').equals('OPEN').first();
    if (alreadyOpen) {
      throw codedError(
        SHIFT_ALREADY_OPEN,
        `Une session de caisse est déjà ouverte (ID: ${alreadyOpen.id}, Caissier: ${alreadyOpen.cashierName}).`,
        alreadyOpen
      );
    }

    let devId = 'local';
    try {
      const { getSyncDeviceId } = await import('../sqlPluginAdapter');
      devId = (await getSyncDeviceId()) || 'local';
    } catch {
      // Fallback
    }

    if (isTauriEnv()) {
      const { getLocalDb } = await import('../sqlPluginAdapter');
      const sql = (await getLocalDb()) as unknown as SqlDb;
      const liveInSql = await sql.select<{ id: string; cashier_name: string }>(
        `SELECT id, cashier_name FROM cash_sessions WHERE device_id = ? AND status IN ('OPEN', 'CLOSING') LIMIT 1`,
        [devId]
      );
      if (liveInSql.length > 0) {
        throw codedError(
          SHIFT_ALREADY_OPEN,
          `Une session de caisse est déjà ouverte sur cet appareil (ID: ${liveInSql[0].id}, Caissier: ${liveInSql[0].cashier_name}).`,
        );
      }
    }

    const opener = (openedBy || '').trim() || cashierName || 'Caissier Principal';
    const baseSession: CashSession = {
      id: newId('SHIFT'),
      openedAt: new Date().toISOString(),
      closedAt: null,
      openingFloat: toWholeDa(openingFloat),
      expectedCash: null,
      actualCash: null,
      status: 'OPEN',
      cashierName: cashierName || 'Caissier Principal',
      openingNote: openingNote || '',
      closingNote: null,
      discrepancy: 0,
      denominations: denominations || null,
      movements: [],
      updatedAt: new Date().toISOString(),
      deviceId: devId,
      terminalName: typeof window !== 'undefined' && (window.__TAURI_INTERNALS__ || window.__TAURI__) ? 'Caisse Comptoir' : 'Terminal Mobile',
    };

    // Attribution contract (cashier switches mid-shift):
    // - `openedBy` = the lock-screen cashier who opened the shift (immutable).
    // - `currentCashier` = who currently owns the drawer; updated via
    //   setShiftCashier() on lock-screen switches (switchCashier in
    //   createUISlice is owned by another agent and cannot call the shift
    //   slice directly — it, or the checkout path, must call the
    //   `setShiftCashier` store action / adapter method).
    // - Per-transaction `recordedBy` (checkout agent's responsibility) must be
    //   resolved from `currentCashier`, NOT from `cashierName`/`openedBy`, so
    //   mid-shift cashier switches attribute sales to the right person.
    // These ride as runtime extras: CashSession's shared type is owned by
    // another agent, Dexie persists unindexed extras as-is, and readers cast
    // back via ShiftAttribution below.
    const newSession: CashSession = {
      ...baseSession,
      ...{ openedBy: opener, currentCashier: baseSession.cashierName },
    };

    let openedNatively = false;
    if (isTauriEnv()) {
      // Fiscal write: opening a shift inserts the session AND enqueues its sync
      // row. Both must land together, so the Tauri path goes through the native
      // `open_shift` lane (one transaction: cash_sessions + entity_keys +
      // sync_outbox). The renderer SQL is only the non-Tauri fallback.
      const { invokeCommand } = await import('../../platform/invoke');
      try {
        await invokeCommand<{ deviceId: string; version: number }>('open_shift', {
          request: {
            id: newSession.id,
            openedAt: newSession.openedAt,
            openingFloat: newSession.openingFloat,
            cashierName: newSession.cashierName,
            openingNote: newSession.openingNote ?? '',
            terminalName: newSession.terminalName ?? '',
            jsonPayload: JSON.stringify(newSession),
          },
        });
        openedNatively = true;
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (msg.includes('SHIFT_ALREADY_OPEN')) {
          throw codedError(
            SHIFT_ALREADY_OPEN,
            'Une session est dAcjA� ouverte sur cet appareil (contrainte native)',
          );
        }
        // Only an absent command falls back; a real native failure must surface.
        if (/not found|unknown command|open_shift is not/i.test(msg)) {
          console.warn('[startShift] native open_shift unavailable; renderer fallback', msg);
        } else {
          throw new ShiftSqliteError(
            'SQLITE_OPEN_FAILED',
            `A%chec d'ouverture de session (natif): ${msg}`,
            err,
          );
        }
      }

      if (!openedNatively) {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const sql = (await getLocalDb()) as unknown as SqlDb;
        try {
          await sql.execute(INSERT_SESSION_SQL, sessionParams(newSession, devId));
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          if (msg.includes('uq_one_live_shift_per_device') || msg.includes('cash_sessions.device_id')) {
            throw codedError(
              SHIFT_ALREADY_OPEN,
              'Une session est dAcjA� ouverte sur cet appareil (contrainte SQLite)',
            );
          }
          throw new ShiftSqliteError('SQLITE_OPEN_FAILED', `A%chec d'ouverture de session dans SQLite: ${msg}`, err);
        }

        const rows = await sql.select<{ id: string; status: string }>(
          'SELECT id, status FROM cash_sessions WHERE id = ?',
          [newSession.id],
        );
        if (!rows[0] || rows[0].status !== 'OPEN') {
          throw new ShiftSqliteError('SQLITE_OPEN_FAILED', 'VAcrification SQLite AcchouAce : session non trouvAce en statut OUVERTE');
        }
      }
    }

    await dexieDb.cashSessions.put(newSession);
    // Native already wrote entity_keys + sync_outbox in the same transaction;
    // enqueueing again would bump the clock twice for one fiscal event.
    if (!openedNatively) void fireSync('cash_session', newSession.id, newSession);
    return newSession;
  },

  async logExpense(
    amount: number,
    movementType: 'EXPENSE' | 'MANUAL_DEPOSIT' | 'ALLOCATION' = 'EXPENSE',
    reason: string,
    cashierName?: string,
    sessionId?: string,
    movementId?: string,
    category?: string,
    refType?: string,
    refId?: string
  ): Promise<CashMovement> {
    const fallbackSession = sessionId || (await dexieDb.cashSessions.where('status').equals('OPEN').first())?.id || 'DEFAULT_SHIFT';
    const cleanReason = (reason || '').trim() || 'Mouvement de caisse';
    const wholeAmount = toWholeDa(amount);
    const movement: CashMovement = {
      // Explicit idempotency key (debt-settlement double-submit guard):
      // repeated writes with the same id collapse via Dexie put-upsert and
      // the stable outbox key instead of minting duplicate drawer rows.
      id: movementId || newId('MOV'),
      sessionId: fallbackSession,
      type: movementType,
      amount: wholeAmount,
      reason: cleanReason,
      category,
      refType,
      refId,
      cashierName: cashierName || 'Caissier',
      createdAt: new Date().toISOString(),
    };

    if (isTauriEnv()) {
      const { getLocalDb } = await import('../sqlPluginAdapter');
      const sql = (await getLocalDb()) as unknown as SqlDb;
      try {
        await ensureSessionInSqlite(sql, fallbackSession);
      } catch (err) {
        console.warn('[logExpense] ensureSessionInSqlite warning:', err);
      }

      const res = await sql.execute(INSERT_MOVEMENT_SQL, [
        movement.id,
        movement.sessionId,
        movement.type,
        movement.amount,
        movement.reason,
        movement.cashierName,
        movement.createdAt,
        JSON.stringify(movement),
        movement.sessionId,
      ]);

      if (res.rowsAffected === 0) {
        // Park in the v113 envelope shape (id, session_id, data_json,
        // row_version, parked_at, attempts) — the ONLY shape
        // sync_parked_movements carries (Rust v113 + cashMirror drain read
        // data_json/row_version). The full movement rides as data_json.
        await sql.execute(
          `INSERT INTO sync_parked_movements (id, session_id, data_json, row_version, parked_at, attempts)
           VALUES (?, ?, ?, 1, ?, 0)
           ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, row_version = excluded.row_version`,
          [
            movement.id,
            movement.sessionId,
            JSON.stringify(movement),
            new Date().toISOString(),
          ]
        );
      }
    }

    await dexieDb.cashMovements.put(movement);
    void fireSync('cash_movement', movement.id, movement);
    return movement;
  },

  async closeShift(
    blindCount: number,
    closingNote?: string,
    _cashierName?: string,
    sessionId?: string,
    managerPin?: string,
    closingDenominations?: DenominationCount
  ): Promise<CashSession> {
    const openSession = sessionId
      ? await dexieDb.cashSessions.get(sessionId)
      : await dexieDb.cashSessions.where('status').equals('OPEN').first();

    // Phantom-close guard: never fabricate a synthetic zero-float session.
    // Closing with no OPEN session is a caller bug — fail loudly.
    // (Fail-closed also when an explicit sessionId resolves to a missing or
    // already-CLOSED row.)
    if (!openSession || openSession.status !== 'OPEN') {
      throw codedError(
        SHIFT_NO_OPEN_SESSION,
        'Aucune session de caisse ouverte à clôturer.'
      );
    }

    const currentSessionId = openSession.id;
    const movements = await dexieDb.cashMovements.where('sessionId').equals(currentSessionId).toArray();
    const deposits = movements.filter((m) => m.type === 'MANUAL_DEPOSIT').reduce((sum, m) => sum + m.amount, 0);
    const expenses = movements.filter((m) => m.type === 'EXPENSE').reduce((sum, m) => sum + m.amount, 0);

    const openingFloat = openSession.openingFloat || 0;
    // Cash source (pro rule): the close certifies money, so on Tauri the
    // window reads the SQLite authority — never the Dexie projection, which
    // can lag, ghost (voids are append-only there), and rebuild. Range-scoped
    // read: the session window is known (openedAt), so the created_at bound
    // keeps the scan off the full history. Predicates below are verbatim so
    // healthy shops see byte-identical numbers from either source (missing
    // createdAt rows excluded when openedAt is set, on both). Movements stay
    // on Dexie: cash lanes are Dexie(+cloud)-only by design — no local
    // SQLite mirror exists for them (see adapter audit).
    // Web preview has no SQLite authority: Dexie IS the store there.
    let txns: CloseWindowTxn[];
    if (isTauriEnv()) {
      try {
        txns = await readCloseTxnsAuthority(openSession.openedAt ?? null);
      } catch (err) {
        // Authority unreadable (sick schema/pool, never "empty"): certifying a
        // close on mirror data would mint a false variance — fail loudly so
        // the merchant retries instead of booking a wrong discrepancy.
        throw new Error(
          `Clôture impossible : base SQLite illisible (${err instanceof Error ? err.message : String(err)}). Vérifiez la maintenance puis réessayez.`,
        );
      }
    } else {
      txns = await readCloseTxnsDexie(openSession.openedAt ?? null);
    }
    // Isolate transactions to this terminal/register if deviceId is bound.
    // (deviceId is a runtime extra — see ShiftAttribution — so read it via
    // cast; the shared CashSession type is owned by another agent.)
    const openDeviceId = (openSession as CashSession & { deviceId?: string }).deviceId;
    // F3 tally (no behavior change): rows counted here ONLY because their
    // deviceId is missing are unattributable — on multi-terminal setups the
    // same legacy row inflates every bound drawer's expectedCash. Surfaced
    // below; the inclusion rule itself needs a business policy decision.
    // Pure scope predicate (no side effects — it runs once per filter pass,
    // so a tally inside would double-count across the sales/refunds splits).
    // Time/stamp rule is shared with the preview modal (isTxInCloseScope):
    // stamped rows belong to exactly one session, legacy rows keep the
    // createdAt window — now UPPER-BOUNDED by the close instant so post-close
    // sales can never leak into a booked Z.
    const closeNowIso = new Date().toISOString();
    const inScope = (t: CloseWindowTxn) => {
      if (!isTxInCloseScope(t, openSession, closeNowIso)) return false;
      if (!openDeviceId) return true;
      if (t.deviceId === openDeviceId) return true;
      // Device-less legacy rows stay included (rule unchanged — attribution
      // needs a business policy decision); they are tallied once below.
      return !t.deviceId;
    };
    const scopedAll = txns.filter(inScope);
    // Gap visibility: in-window rows excluded ONLY by stamp mismatch (sales
    // stamped with another session — e.g. a stale tab selling after this
    // close but before the next open). They land in no close; warn loudly
    // instead of letting the cash vanish from every Z.
    {
      const scopedIds = new Set(scopedAll.map((t) => t.id));
      let gapCount = 0;
      let gapTotal = 0;
      for (const t of txns) {
        if (t.status === 'VOIDED') continue;
        if (!openSession.openedAt || !(t.createdAt >= openSession.openedAt)) continue;
        if (t.createdAt >= closeNowIso) continue;
        if (scopedIds.has(t.id)) continue;
        gapCount += 1;
        gapTotal += Math.max(0, Number(t.total) || 0);
      }
      if (gapCount > 0) {
        console.warn(
          `[closeShift] ${gapCount} vente(s) hors périmètre (${gapTotal} DA) — horodatées dans la fenêtre mais rattachées à une autre session. Vérifiez les onglets périmés avant de clôturer.`
        );
      }
    }
    const sessionTxns = scopedAll.filter((t) => !t.isRefund);
      // Refund rows are COMPLETED with total = the refunded amount. They are
      // already subtracted in `expectedCash` via cashRefunds / store-credit
      // liability, so counting them as sales would double-count the outflow.
    const sessionRefunds = scopedAll.filter((t) => t.isRefund);
    if (openDeviceId) {
      let unattributedCount = 0;
      let unattributedTotal = 0;
      for (const t of scopedAll) {
        if (!t.deviceId) {
          unattributedCount += 1;
          unattributedTotal += Math.max(0, t.total);
        }
      }
      if (unattributedCount > 0) {
        console.warn(
          `[closeShift] ${unattributedCount} transaction(s) sans deviceId comptée(s) dans ce tiroir ` +
            `(${unattributedTotal} DA d'origine indéterminée) — politique d'attribution à trancher.`,
        );
      }
    }

    // Cash terms share one definition with the preview modal, Reports and
    // the Z report (utils/cashTerms) — the surfaces differ only in which
    // rows they feed in. Do not reimplement the predicates here.
    const cashSales = cashSalesFromTxns(sessionTxns);

    const cashRefunds = cashRefundsFromTxns(sessionRefunds);

    const totalProfits = await (async () => {
      // Ledger-first booked profit, unified with the close modal preview,
      // KPI cards and exports: per-sale frozen allocation sums in ONE grouped
      // read (never per-sale queries); exchanges use the signed row cost;
      // legacy rows without any frozen basis keep stored profit, exactly as
      // before. Without this the booked Z cements the stale estimate the
      // cashier just approved past on screen.
      const allocBySale = new Map<string, number>();
      try {
        const saleIds = [...new Set(sessionTxns.map((t) => t.id))];
        if (saleIds.length > 0) {
          if (isTauriEnv()) {
            const { getLocalDb } = await import('../sqlPluginAdapter');
            const db = await getLocalDb();
            const rows = (await db
              .select(
                `SELECT sale_id, COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0) AS s
                 FROM sale_batch_allocations WHERE sale_id IN (${saleIds.map(() => '?').join(',')}) AND deleted = 0 GROUP BY sale_id`,
                saleIds
              )
              .catch(() => [])) as Array<{ sale_id: string; s: number }>;
            for (const r of rows ?? []) {
              const v = Number(r.s);
              if (Number.isFinite(v) && v >= 0) allocBySale.set(String(r.sale_id), Math.round(v));
            }
          } else {
            const rows = await dexieDb.saleBatchAllocations
              .where('saleId')
              .anyOf(saleIds)
              .toArray()
              .catch(() => []);
            for (const r of rows ?? []) {
              const v = Number(r.qtyConsumed ?? 0) * Number(r.unitCostAtSale ?? 0);
              if (Number.isFinite(v) && v >= 0) {
                allocBySale.set(r.saleId, Math.round((allocBySale.get(r.saleId) ?? 0) + v));
              }
            }
          }
        }
      } catch {
        // Allocation read unavailable — every row falls back to stored
        // profit below, i.e. today's behavior.
      }
      const netOf = (t: CloseWindowTxn): number => {
        const n = Number(t.total);
        return Number.isFinite(n) ? Math.max(0, n) : 0;
      };
      return sessionTxns.reduce((sum, t) => {
        if (t.isExchange && t.costTotal !== undefined) return sum + (netOf(t) - t.costTotal);
        const alloc = allocBySale.get(t.id);
        if (alloc !== undefined) return sum + (netOf(t) - alloc);
        if (t.ledgerCogsTotal !== undefined) return sum + (netOf(t) - t.ledgerCogsTotal);
        return sum + (t.profit || 0);
      }, 0);
    })();

    const expectedCash = openingFloat + cashSales + deposits - expenses - cashRefunds;
    const actualCash = Math.round(blindCount);
    const discrepancy = actualCash - expectedCash;

    // Variance gate (enforced here, not just in the modal): any non-zero
    // discrepancy requires a non-empty justification note, and a discrepancy
    // at/above SHIFT_VARIANCE_MANAGER_PIN_THRESHOLD additionally requires a
    // manager PIN. Phase 1: verified natively (fail-closed, counted on the
    // native ladder) — the old Dexie-hash read + counter-free local compare
    // is gone. All cash math stays in integer DZD.
    if (discrepancy !== 0 && !(closingNote || '').trim()) {
      throw codedError(
        SHIFT_CLOSING_NOTE_REQUIRED,
        `Écart de caisse de ${discrepancy} DA : une note justificative est obligatoire pour clôturer.`
      );
    }
    if (Math.abs(discrepancy) >= SHIFT_VARIANCE_MANAGER_PIN_THRESHOLD) {
      const cleanPin = (managerPin || '').trim();
      if (!cleanPin) {
        throw codedError(
          SHIFT_MANAGER_PIN_REQUIRED,
          `Écart de caisse de ${discrepancy} DA (seuil ${SHIFT_VARIANCE_MANAGER_PIN_THRESHOLD} DA) : validation par code PIN Manager requise.`
        );
      }
      // No hash ever enters JS here: the kernel compares against the stored
      // credential through its own handle. An unset PIN fails closed natively
      // (missing credential is an error, never a default).
      const gate = await verifyManagerGate(cleanPin);
      if (!gate.ok) {
        throw codedError(
          SHIFT_MANAGER_PIN_INVALID,
          gate.locked
            ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
            : 'Code PIN Manager incorrect — clôture à écart refusée.'
        );
      }
    }

    const operatingExpenses = movements
      .filter((m) => {
        if (m.type !== 'EXPENSE') return false;
        const r = m.reason || '';
        if (r.startsWith(DRAWER_REASON_PREFIXES.SOULTE_CASHOUT)) return false;
        if (r.startsWith(DRAWER_REASON_PREFIXES.EXCHANGE_CASHOUT)) return false;
        if (r.startsWith('Dépôt coffre') || r.startsWith('DROP_SAFE') || r.startsWith('COFFRE')) return false;
        if (m.category === 'TRADE_IN_PAYOUT' || m.category === 'TRADE_IN_SOULTE' || m.category === 'SAV_ACOMPTE_REFUND') return false;
        if (r.includes('Rachat Occasion') || r.includes('Reprise') || r.includes('Remboursement Acompte SAV')) return false;
        return true;
      })
      .reduce((sum, m) => sum + m.amount, 0);

    const closedSession: CashSession = {
      ...openSession,
      status: 'CLOSED',
      closedAt: closeNowIso,
      expectedCash: toWholeDa(expectedCash),
      actualCash: toWholeDa(actualCash),
      discrepancy: toWholeDa(discrepancy),
      totalSalesCount: sessionTxns.length,
      totalSalesRevenue: sessionTxns.reduce((sum, t) => sum + t.total, 0),
      totalProfits: toWholeDa(totalProfits),
      // Net of operating EXPENSE movements — same definition the close-modal
      // preview shows (`totalSaleMargins - operatingExpenses`).
      dailyNetProfit: toWholeDa(totalProfits - operatingExpenses),
      closingNote: closingNote || '',
      closingDenominations: closingDenominations || null,
      movements,
      updatedAt: closeNowIso,
    };

    if (isTauriEnv()) {
      const { getLocalDb } = await import('../sqlPluginAdapter');
      const sql = (await getLocalDb()) as unknown as SqlDb;
      try {
        await ensureSessionInSqlite(sql, openSession.id);
      } catch (err) {
        console.warn('[closeShift] ensureSessionInSqlite warning:', err);
      }

      await sql.execute(
        `UPDATE cash_sessions
         SET status = 'CLOSED',
             closed_at = ?,
             expected_cash = ?,
             actual_cash = ?,
             discrepancy = ?,
             closing_note = ?,
             json_payload = ?,
             updated_at = ?,
             version = version + 1
         WHERE id = ?`,
        [
          closeNowIso,
          toWholeDa(expectedCash),
          toWholeDa(actualCash),
          toWholeDa(discrepancy),
          closingNote || '',
          JSON.stringify(closedSession),
          closeNowIso,
          openSession.id,
        ]
      );

      const rows = await sql.select<{ id: string; status: string }>(
        'SELECT id, status FROM cash_sessions WHERE id = ?',
        [openSession.id]
      );
      if (!rows[0] || rows[0].status !== 'CLOSED') {
        throw new ShiftSqliteError('SQLITE_CLOSE_FAILED', 'Vérification SQLite échouée : session non trouvée en statut CLOSED');
      }
    }

    await dexieDb.cashSessions.put(closedSession);
    void fireSync('cash_session', closedSession.id, closedSession);
    return closedSession;
  },

  /**
   * Mid-shift drawer handover: re-points the OPEN session's currentCashier
   * (and display cashierName) at the lock-screen cashier WITHOUT closing the
   * session. Called by the `setShiftCashier` store action; the lock-screen
   * switch path (createUISlice.switchCashier, owned by another agent) must
   * route here so per-transaction `recordedBy` attribution stays correct.
   */
  async setShiftCashier(cashierName: string): Promise<CashSession> {
    const clean = (cashierName || '').trim();
    if (!clean) {
      throw codedError('CASHIER_NAME_REQUIRED', 'Nom de caissier vide — passation refusée.');
    }
    const open = await dexieDb.cashSessions.where('status').equals('OPEN').first();
    if (!open) {
      throw codedError(SHIFT_NO_OPEN_SESSION, 'Aucune session ouverte — passation impossible.');
    }
    const updated: CashSession = {
      ...open,
      ...{ currentCashier: clean },
      cashierName: clean,
      updatedAt: new Date().toISOString(),
    };
    if (isTauriEnv()) {
      try {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const sql = (await getLocalDb()) as unknown as SqlDb;
        await sql.execute(
          `UPDATE cash_sessions
           SET cashier_name = ?,
               json_payload = CASE WHEN json_valid(json_payload)
                                   THEN json_set(json_payload, '$.cashierName', ?, '$.currentCashier', ?)
                                   ELSE json_payload END,
               updated_at = ?,
               version = version + 1
           WHERE id = ?`,
          [clean, clean, clean, updated.updatedAt, open.id]
        );
      } catch (err) {
        console.warn('[setShiftCashier] SQLite update warning:', err);
      }
    }
    await dexieDb.cashSessions.put(updated);
    void fireSync('cash_session', updated.id, updated);
    const movements = await dexieDb.cashMovements.where('sessionId').equals(updated.id).toArray();
    return { ...updated, movements };
  },

  async getActiveShift(): Promise<CashSession | null> {
    const open = await dexieDb.cashSessions.where('status').equals('OPEN').first();
    if (!open) return null;
    const movements = await dexieDb.cashMovements.where('sessionId').equals(open.id).toArray();
    return { ...open, movements };
  },

  /**
   * UPGRADE-01: windowed shift history (newest first). Pass `{ limit }` for
   * the bounded boot/pull lane; omit it for full, on-demand reads. Exact counts
   * that feed the Z-ticket sequence come from `getShiftStats()` — never from a
   * windowed array length.
   */
  async getAllShifts(opts?: { limit?: number }): Promise<CashSession[]> {
    const limit = opts?.limit && opts.limit > 0 ? Math.floor(opts.limit) : undefined;
    const collection = dexieDb.cashSessions.orderBy('openedAt').reverse();
    if (limit !== undefined) return await collection.limit(limit).toArray();
    return await collection.toArray();
  },

  /**
   * UPGRADE-01 safety rail: exact closed/total shift counts for Z-ticket
   * numbering, computed by indexed count (cashSessions: 'id, status,
   * openedAt') instead of materializing every session row.
   */
  async getShiftStats(): Promise<{ total: number; closed: number }> {
    const [total, closed] = await Promise.all([
      dexieDb.cashSessions.count(),
      dexieDb.cashSessions.where('status').equals('CLOSED').count(),
    ]);
    return { total, closed };
  },

  async getShiftDetails(sessionId: string): Promise<CashSession | null> {
    const session = await dexieDb.cashSessions.get(sessionId);
    if (!session) return null;
    const movements = await dexieDb.cashMovements.where('sessionId').equals(sessionId).toArray();
    return { ...session, movements };
  },

  async getInventoryValuation(): Promise<InventoryValuation> {
    const products = await dexieDb.products.toArray();
    const inStockProducts = products.filter((p) => (p.stock || 0) > 0);
    const totalSkus = inStockProducts.length;
    const totalUnits = inStockProducts.reduce((sum, p) => sum + p.stock, 0);
    const totalCostValue = Math.round(inStockProducts.reduce((sum, p) => sum + p.stock * (p.costPrice || 0), 0));
    const totalRetailValue = Math.round(inStockProducts.reduce((sum, p) => sum + p.stock * p.price, 0));
    const potentialProfitMargin = totalRetailValue - totalCostValue;

    return {
      totalSkus,
      totalUnits,
      totalCostValue,
      totalRetailValue,
      potentialProfitMargin,
    };
  },
};

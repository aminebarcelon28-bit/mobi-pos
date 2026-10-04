import { APP_CONFIG } from '../constants';

/**
 * Business-day keys in the shop timezone (default Africa/Algiers).
 *
 * Several screens computed "today" with `new Date().toISOString().slice(0,10)`
 * (UTC) while others used local dates — midnight sales jumped days between
 * tabs. Every "today" comparison must use these helpers on BOTH sides:
 * `toLocalDayKey(tx.createdAt) === todayLocalKey()`.
 */
export function businessTimeZone(): string {
  return APP_CONFIG?.TIMEZONE || 'Africa/Algiers';
}

export function todayLocalKey(timeZone?: string): string {
  return toLocalDayKey(new Date(), timeZone);
}

export function toLocalDayKey(d: Date | string | number, timeZone?: string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || businessTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Canonical transaction ordering (single source of truth for every receipt
 * list: RefundModal, ReportsModal history, and the Zustand `transactions`
 * array itself).
 *
 * Newest-first by `createdAt` DESC. `NaN`-safe: missing or unparseable
 * timestamps coerce to `-Infinity` so legacy/dateless rows sink
 * deterministically instead of poisoning `Array.sort` with `NaN`.
 * Tiebreakers keep the order strict and stable: `receiptNumber` DESC, then
 * `id` DESC. Receipt numbers are display-only opaque strings (see
 * `utils/ids.ts`) — compared lexicographically here purely as a stable
 * tiebreak, never parsed as time.
 */
export interface TransactionOrderKeys {
  createdAt?: string | null;
  receiptNumber?: string | null;
  id?: string | null;
}

export function transactionTimeMs(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) return Number.NEGATIVE_INFINITY;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

export function compareTransactionsNewestFirst(
  a: TransactionOrderKeys | null | undefined,
  b: TransactionOrderKeys | null | undefined,
): number {
  const ta = transactionTimeMs(a?.createdAt);
  const tb = transactionTimeMs(b?.createdAt);
  if (ta !== tb) return tb - ta;
  const ra = String(a?.receiptNumber ?? '');
  const rb = String(b?.receiptNumber ?? '');
  if (ra !== rb) return ra < rb ? 1 : -1;
  const ia = String(a?.id ?? '');
  const ib = String(b?.id ?? '');
  if (ia !== ib) return ia < ib ? 1 : -1;
  return 0;
}

/** Non-mutating newest-first sort (input array is never reordered in place). */
export function sortTransactionsNewestFirst<T extends TransactionOrderKeys>(list: readonly T[]): T[] {
  return [...list].sort(compareTransactionsNewestFirst);
}

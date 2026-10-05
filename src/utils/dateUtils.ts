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

/**
 * Single timestamp mint gate (TIME-001). Every business record in the app
 * must mint "now" through this function — never raw `new Date()` variants
 * scattered per file. Output is byte-identical to `new
 * Date().toISOString()` (UTC ISO-8601 with millis + Z); the value is the
 * grep-verifiable single source, so a future local-time or sliced variant
 * stands out in review instead of blending into twelve identical calls.
 */
export function utcNowIso(): string {
  return new Date().toISOString();
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

/**
 * Canonical transaction standing (single source of truth for every money
 * question: revenue, void, refund, quarantine).
 *
 * Two axes collapse to one verdict: VOIDED dominates everything; a
 * well-formed non-void row is a `sale`, or a `refund` receipt when
 * `isRefund` is set (refund rows are stamped COMPLETED at creation, so
 * status alone can never identify them). Anything else — null, empty,
 * typo, lowercase, future value — is `unknown` and quarantined: it counts
 * NOWHERE (not as a sale, not as a refund) until repaired.
 *
 * Behavior-preserving by construction: for the four known statuses every
 * consumer below computes exactly what it computed before (verified per
 * call site); only unknown statuses move — from silent revenue into the
 * quarantine count. Case-sensitive on purpose: writers emit uppercase
 * constants, so any other casing is corruption, not a variant.
 */
export type TransactionStanding = 'sale' | 'refund' | 'void' | 'unknown';

const KNOWN_TRANSACTION_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'VOIDED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
]);

export function resolveTransactionStanding(
  t: { status?: unknown; isRefund?: unknown } | null | undefined,
): TransactionStanding {
  const status = typeof t?.status === 'string' ? t.status : '';
  if (status === 'VOIDED') return 'void';
  if (!KNOWN_TRANSACTION_STATUSES.has(status)) return 'unknown';
  if (t?.isRefund === true) return 'refund';
  return 'sale';
}

/** Revenue-eligible (matches the historic validSales rule on known rows). */
export function isRevenueSale(t: { status?: unknown; isRefund?: unknown } | null | undefined): boolean {
  return resolveTransactionStanding(t) === 'sale';
}

/** Cancelled (matches the historic `status === 'VOIDED'` rule, all rows). */
export function isVoidedTransaction(t: { status?: unknown; isRefund?: unknown } | null | undefined): boolean {
  return resolveTransactionStanding(t) === 'void';
}

/** Avoir/credit-note receipt (matches `Boolean(isRefund)` on known rows). */
export function isRefundReceipt(t: { status?: unknown; isRefund?: unknown } | null | undefined): boolean {
  return resolveTransactionStanding(t) === 'refund';
}

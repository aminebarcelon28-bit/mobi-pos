/**
 * Audit register query construction.
 *
 * Pure SQL text and parameter construction, kept out of `operationsAdapter` for
 * two reasons: the adapter drags in Dexie and the whole plugin chain, so a
 * query-shape test would need a browser, and the shapes themselves are the
 * part worth pinning. The bounds contract — "the window is a WHERE clause, not
 * a client-side pass over a capped slice" — is only observable here.
 *
 * No value ever reaches the SQL text. The WHERE clause is assembled from a
 * fixed set of literal fragments and every user-controlled input is bound.
 */

/** Default register depth when no explicit range is requested. */
export const AUDIT_DEFAULT_LIMIT = 300;

/**
 * Depth of the legacy (pre-ISO) lane.
 *
 * Rows written before the P11.3 store change hold a bare wall clock
 * (`"14:32"` / `"14:32:07"`). They cannot participate in a lexicographic ISO
 * range, so they are read by their own narrow query and narrowed by the caller.
 * The lane is capped because the store no longer produces those rows and the
 * bound keeps the read bounded.
 */
export const AUDIT_LEGACY_LIMIT = 200;

export interface AuditQueryBounds {
  /** Inclusive lower bound. Null/omitted means "no lower bound". */
  start?: Date | null;
  /** Inclusive upper bound. Null/omitted means "no upper bound". */
  end?: Date | null;
  /** Register depth. Defaults to {@link AUDIT_DEFAULT_LIMIT}. */
  limit?: number;
}

export function hasAuditBound(bounds?: AuditQueryBounds): boolean {
  return Boolean(bounds && (bounds.start || bounds.end));
}

const AUDIT_COLUMNS =
  'id, timestamp, user, action, details, requires_pin, device_id, ip_address';

/**
 * Build the bounded SELECT for the ISO lane.
 *
 * `ORDER BY timestamp DESC` is what lets SQLite satisfy a `BETWEEN`-on-index
 * `LIMIT` plan here, and it is the same ordering the unbounded form has always
 * used, so an "all time" read is byte-identical to the pre-existing query.
 *
 * The upper bound is inclusive at millisecond precision, which is safe for
 * every value this app writes: `toISOString()` always emits exactly three
 * fractional digits, and a value stored without them (`...T23:59:59Z`) sorts
 * *above* `...T23:59:59.999Z` ('Z' > '.') and would be dropped by an
 * exclusive next-instant bound. See `test_audit_intel.mts` for the pin.
 */
export function buildAuditSelect(bounds?: AuditQueryBounds): string {
  const clauses: string[] = [];
  if (bounds?.start) clauses.push('timestamp >= $1');
  if (bounds?.end) clauses.push('timestamp <= $2');
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return `SELECT ${AUDIT_COLUMNS} FROM security_audit_logs${where} ORDER BY timestamp DESC LIMIT $3`;
}

export function auditSelectParams(bounds?: AuditQueryBounds): (string | number)[] {
  return [
    bounds?.start ? bounds.start.toISOString() : '',
    bounds?.end ? bounds.end.toISOString() : '',
    bounds?.limit ?? AUDIT_DEFAULT_LIMIT,
  ];
}

/**
 * Rows whose `timestamp` is a bare wall clock rather than an ISO instant.
 *
 * `substr(timestamp, 3, 1) = ':'` identifies `HH:MM…` in one comparison, and
 * the `timestamp >= '00:00' AND timestamp < '24:00'` envelope keeps SQLite on
 * an `idx_audit_timestamp` range scan for that slice instead of degrading to a
 * full table scan on every poll.
 */
export function buildLegacyAuditSelect(): string {
  return (
    `SELECT ${AUDIT_COLUMNS} FROM security_audit_logs ` +
    `WHERE substr(timestamp, 3, 1) = ':' AND timestamp >= '00:00' AND timestamp < '24:00' ` +
    `ORDER BY timestamp DESC LIMIT $1`
  );
}

/** True when a stored timestamp is a bare wall clock rather than an ISO instant. */
export function isLegacyWallClock(timestamp: string | undefined | null): boolean {
  const value = String(timestamp ?? '');
  return value.length >= 5 && value.charAt(2) === ':';
}

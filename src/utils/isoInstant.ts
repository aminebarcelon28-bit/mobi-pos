/**
 * Canonical instant normalizer (sync + FIFO + warranty lanes).
 *
 * Problem: timestamps arrive in mixed spellings — ISO-8601 UTC (`T…Z`) from
 * local writers, space-separated `datetime('now','utc')` from legacy
 * defaults, local-time strings from peers. Mixed spellings break byte-order
 * `ORDER BY`/`String()<String()` comparisons and shift `new Date()` parses
 * into local TZ. Every cross-device clock (received_at, sold_at,
 * warranty_expires_at) must pass through here on ingest so the DB holds one
 * spelling.
 *
 * Zero runtime dependencies — importable from sync hot paths and tests.
 */

/** Parseable instant → canonical ISO-8601 UTC, else NULL (never invented). */
export function coerceIsoInstant(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const t = new Date(trimmed).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Canonical instant, or `fallback` when the value is missing/unparseable. */
export function isoOrFallback(value: unknown, fallback: string): string {
  return coerceIsoInstant(value) ?? fallback;
}

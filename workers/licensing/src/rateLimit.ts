/**
 * M2 rate limiting (EDGE-1 / EDGE-2, red-team E-0256/E-0257).
 *
 * EDGE-1: seat-squatting DoS — an attacker holding ANY valid key can take the
 *   last seat and lock the victim out; unbounded retries amplify it.
 * EDGE-2: /verify is a key-existence enumeration oracle (404 vs 200).
 *
 * Both are closed by per-identity fixed-window counters stored in the master
 * Turso DB (one extra round-trip per request, atomic upsert-increment).
 * Identities are peppered hashes (IP_PEPPER / LICENSE_PEPPER) — never raw IPs
 * or keys, mirroring the existing ip_hash discipline.
 *
 * The limits are deliberately generous compared to legitimate traffic (a shop
 * behind one IP runs ~30 verify/hour/device) and ruinous compared to
 * enumeration (32^8 key space at a few hundred requests/hour is geological).
 */

export interface RateLimitDb {
  execute(sql: { sql: string; args: Record<string, unknown> }): Promise<{ rows: ArrayLike<Record<string, unknown>>; rowsAffected: number }>;
}

export interface RateLimitVerdict {
  ok: boolean;
  /** Seconds until the window rolls over; 0 when allowed. */
  retryAfter: number;
  count: number;
  limit: number;
}

/** Bucket registry — one entry per enforced surface. Limits per rolling fixed window. */
export const RATE_LIMITS = {
  activate_ip: { limit: 20, windowSecs: 3600 },
  activate_key: { limit: 30, windowSecs: 3600 },
  verify_ip: { limit: 300, windowSecs: 3600 },
  verify_key: { limit: 240, windowSecs: 3600 },
  deactivate_ip: { limit: 20, windowSecs: 3600 },
  deactivate_key: { limit: 30, windowSecs: 3600 },
  trial_ip: { limit: 5, windowSecs: 3600 },
  admin_ip: { limit: 30, windowSecs: 3600 },
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

const UPSERT_SQL = `
  INSERT INTO rate_limits (bucket, identity, window_start, count)
  VALUES (:bucket, :identity, :window_start, 1)
  ON CONFLICT(bucket, identity, window_start) DO UPDATE SET count = count + 1
  RETURNING count`;

const SWEEP_SQL = `
  DELETE FROM rate_limits WHERE bucket = :bucket AND window_start < :cutoff`;

export function rateLimitConfig(bucket: RateLimitBucket): { limit: number; windowSecs: number } {
  return RATE_LIMITS[bucket];
}

/**
 * Count one hit and return the verdict. The upsert-increment is atomic
 * (single statement), so concurrent activations cannot race the counter the
 * way a SELECT-then-INSERT could. When the hit opens a NEW window
 * (count === 1) stale windows for the same bucket are swept opportunistically
 * so the table cannot grow without bound.
 *
 * Fail-open on infrastructure errors is DELIBERATE and narrow: a Turso hiccup
 * must not lock a merchant out of their till. The failure is surfaced to the
 * caller via `degraded` so it can be logged; the security posture for a
 * sustained DB outage is unchanged (activation already needs the DB).
 */
export async function enforceRateLimit(
  db: RateLimitDb,
  bucket: RateLimitBucket,
  identity: string,
  nowSecs: number
): Promise<RateLimitVerdict & { degraded?: string }> {
  const { limit, windowSecs } = RATE_LIMITS[bucket];
  const windowStart = Math.floor(nowSecs / windowSecs) * windowSecs;
  try {
    const res = await db.execute({
      sql: UPSERT_SQL,
      args: { bucket, identity, window_start: windowStart },
    });
    const row = res.rows[0] as { count?: number } | undefined;
    const count = Number(row?.count ?? 1);
    if (count === 1) {
      // New window opened: sweep everything older than the previous window.
      try {
        await db.execute({
          sql: SWEEP_SQL,
          args: { bucket, cutoff: windowStart - windowSecs },
        });
      } catch {
        // Sweep is best-effort; the PK keeps growth bounded per window anyway.
      }
    }
    return {
      ok: count <= limit,
      retryAfter: count <= limit ? 0 : windowStart + windowSecs - nowSecs,
      count,
      limit,
    };
  } catch (err) {
    return {
      ok: true,
      retryAfter: 0,
      count: 0,
      limit,
      degraded: `rate_limit_store_unavailable: ${(err as Error).message}`,
    };
  }
}

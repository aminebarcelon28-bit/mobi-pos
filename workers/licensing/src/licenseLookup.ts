/**
 * M2 pepper rotation (F3, deferred from the original audit — rides schema v2).
 *
 * LICENSE_PEPPER is the blind-index pepper: every license row's key_hash is
 * HMAC(normalized_key, pepper). Rotating it naively would invalidate EVERY
 * lookup at once (a downtime event). Instead the rotation is LAZY:
 *
 *   1. Owner sets LICENSE_PEPPER to the new value and LICENSE_PEPPER_PREVIOUS
 *      to the old one (both secrets, no schema change, no downtime).
 *   2. Every lookup tries the current pepper first; on a miss it tries the
 *      previous pepper, and on that hit re-hashes the row in place with the
 *      current pepper. Each licence converges the first time its client
 *      presents the key (activation, verify ping, or deactivate).
 *   3. Once the admin sees zero previous-pepper hits for a rotation window,
 *      LICENSE_PEPPER_PREVIOUS is removed — from then on old-pepper rows are
 *      simply unfindable, which is exactly the fail-closed end state.
 *
 * The raw license key is only ever seen when a client presents it, so the
 * lazy path needs no key escrow and no batch job. All hashes are HMAC-SHA256
 * over the normalized key — the same blind-index discipline as before.
 */

import { hashHmac } from './crypto.ts';
import type { RateLimitDb } from './rateLimit.ts';

export interface LicenseLookupEnv {
  LICENSE_PEPPER: string;
  LICENSE_PEPPER_PREVIOUS?: string;
}

export interface LicenseLookupResult {
  row: Record<string, unknown>;
  /** True when the row was found under the previous pepper and re-hashed. */
  rePeppered: boolean;
}

const SELECT_COLUMNS = `id, customer_name, license_type, status, max_desktops, max_mobiles,
                        encrypted_turso_token, turso_url, expires_at`;

export async function findLicenseByNormalizedKey(
  db: RateLimitDb,
  env: LicenseLookupEnv,
  normalizedKey: string
): Promise<LicenseLookupResult | null> {
  const currentHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER);

  const current = await db.execute({
    sql: `SELECT ${SELECT_COLUMNS} FROM licenses WHERE key_hash = :key_hash LIMIT 1`,
    args: { key_hash: currentHash },
  });
  if (current.rows.length > 0) {
    return { row: current.rows[0], rePeppered: false };
  }

  const previousPepper = env.LICENSE_PEPPER_PREVIOUS;
  if (!previousPepper || previousPepper === env.LICENSE_PEPPER) {
    return null;
  }

  const previousHash = await hashHmac(normalizedKey, previousPepper);
  const previous = await db.execute({
    sql: `SELECT ${SELECT_COLUMNS} FROM licenses WHERE key_hash = :key_hash LIMIT 1`,
    args: { key_hash: previousHash },
  });
  if (previous.rows.length === 0) {
    return null;
  }

  // Lazy re-pepper: converge the row to the current pepper. key_hash is
  // UNIQUE and keys are unique, so the new value cannot collide. If the
  // UPDATE fails the lookup still succeeds (the row stays on the old pepper
  // and converges on a later presentation) — rotation is monotone, never
  // destructive.
  let rePeppered = false;
  try {
    await db.execute({
      sql: `UPDATE licenses SET key_hash = :new_hash, updated_at = :now
            WHERE id = :id AND key_hash = :old_hash`,
      args: {
        new_hash: currentHash,
        old_hash: previousHash,
        id: previous.rows[0].id,
        now: new Date().toISOString(),
      },
    });
    rePeppered = true;
  } catch {
    // Converges on the next presentation; never block the client on it.
  }
  return { row: previous.rows[0], rePeppered };
}

/**
 * Audit write deduplication (session idempotency window).
 *
 * Industry pattern (Stripe/Adyen idempotency keys, ledgerline INSERT OR
 * IGNORE): retries of one logical operation carry the operation-derived key
 * and the second write is a replay, not a new row. Our audit trail is a
 * native hash chain — chain bytes must never be forged — so dedupe happens
 * at the APPLICATION layer, before append: the first call with a key records
 * it; repeats within the session are replays and skip the write.
 *
 * Scope: same-process races (the double-submit window). Cross-restart
 * replays re-audit by design (two user-visible intents); the durable
 * UNIQUE-key constraint on the native table remains the recommended
 * follow-up for crash-replay exactness.
 * Pure + dependency-free (unit-tested).
 */

const claimed = new Set<string>();

/**
 * Claim an audit idempotency key. Returns true when this call owns the
 * write (first claim); false on repeats (skip the append — replay).
 * Synchronous: concurrent same-key callers serialize on this check.
 */
export function claimAuditKey(key: string): boolean {
  const safe = String(key || '').trim();
  if (!safe) return true;
  if (claimed.has(safe)) return false;
  claimed.add(safe);
  return true;
}

/** For tests only — resets the session window. */
export function resetAuditKeys(): void {
  claimed.clear();
}

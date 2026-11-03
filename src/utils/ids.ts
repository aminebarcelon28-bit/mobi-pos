/**
 * Collision-safe identifier generation (edge-case hardening, 2026-09).
 *
 * Why this exists: the store slices previously generated IDs as
 * `prefix-${Date.now()}`. Two actions in the same millisecond (a rapid double
 * click, a barcode scanner burst, or a sync replay) produced IDENTICAL primary
 * keys. Every persistence layer below is an upsert (`dexieDb.put`,
 * `INSERT OR REPLACE`), so a collision does not throw — it silently OVERWRITES
 * the earlier row. For money records that is a bookkeeping loss (contract C5/C6
 * territory); for audit rows it is a lost accountability event.
 *
 * The fix keeps the human-readable `PREFIX-` shape (receipts print it, support
 * reads it) but appends a monotonic counter plus entropy, so uniqueness holds:
 *   - within one millisecond (counter, incremented under a module-level lock)
 *   - across millisecond boundaries (counter only resets forward)
 *   - across tabs / processes (random entropy)
 *
 * Receipt numbers additionally widen the millisecond window: the old
 * `.slice(-6)` kept only ~16.7 minutes of resolution, so receipt numbers
 * REPEATED constantly throughout the day. They are display-only strings
 * (nothing parses them numerically), so widening is safe and printable.
 *
 * Shape stability: receipts stay `PREFIX-YYYYMMDD-<base36>-<seq>-<entropy>`.
 * Only the entropy width grows (3 → 5 chars). Opaque strings throughout —
 * no numeric parsing exists downstream, so sync dedupe is unaffected.
 */
import { newDocumentNumber } from './numbering';

/** Monotonic sequence, guaranteed strictly increasing within a millisecond. */
let idCounter = 0;
/** Last millisecond the counter observed; resets the counter only when moving forward. */
let idCounterLastMs = 0;

/**
 * Returns a strictly increasing sequence number for `ms`, resetting to 0 only
 * when the clock moves forward. Guards against a same-millisecond burst and
 * against a clock that jumps backwards (NTP correction) by keeping the counter
 * monotonic rather than reusing a stale ms bucket.
 */
function nextSequence(ms: number): number {
  if (ms > idCounterLastMs) {
    idCounterLastMs = ms;
    idCounter = 0;
  }
  // Even on a backwards clock jump we keep incrementing rather than collide.
  idCounter += 1;
  return idCounter;
}

/** Cryptographic entropy when available, Math.random otherwise. */
function randomSuffix(length: number): string {
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
  }
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/**
 * Collision-safe primary key: `PREFIX-<epochMs>-<seq>-<entropy>`.
 * Use for anything persisted as a durable row id (debts, audit rows, POs,
 * bundles, trade-ins, cash drops, expenses, held sales, customers, repairs).
 */
export function newId(prefix: string): string {
  const ms = Date.now();
  const seq = nextSequence(ms);
  return `${prefix}-${ms}-${seq}-${randomSuffix(4)}`;
}

/**
 * Deterministic idempotency key: `PREFIX-<FNV1A-32HEX>` over the joined parts.
 * Two devices performing the SAME logical operation (same ticket + same items
 * + same method) derive the SAME id, so the second write converges via the
 * existing ON CONFLICT paths instead of double-counting (cross-device
 * double-refund / double-void protection, ad.md §§7-10). Different operations
 * MUST differ in at least one part. Opaque strings — same shape family as
 * newId, no numeric parsing downstream.
 */
export function deterministicId(prefix: string, ...parts: Array<string | number | null | undefined>): string {
  const joined = parts.map((p) => String(p ?? '')).join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i += 1) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${prefix}-${(h >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
}

/**
 * Fiscal document number (SYN-02, ADR-006).
 *
 * Delegates to the numbering seam: the default scheme is a per-terminal series
 * with a continuous counter (`PREFIX-<SERIES>-<000001>`), because a single
 * merchant-wide counter cannot allocate while a terminal is offline. The legacy
 * timestamp format stays available via `setNumberingScheme('legacy-timestamp')`
 * and is used automatically when no durable counter exists (counted, never
 * silent).
 */
export function newReceiptNumber(prefix: string): string {
  return newDocumentNumber(prefix);
}

/**
 * Deterministic drawer-movement id for a debt settlement (`MOV-DEBT-<entry>`).
 * Double-submit races pass the SAME debt entry id, so deriving the movement
 * id from it (instead of minting entropy) makes repeats collapse via
 * put-upsert + stable outbox key instead of minting duplicate drawer rows.
 * Pure — unit-tested.
 */
export function debtDepositMovementId(debtEntryId: string): string {
  const safe = String(debtEntryId || '').trim() || 'unknown';
  return `MOV-DEBT-${safe}`;
}

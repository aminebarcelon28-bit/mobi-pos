/**
 * REF-87 regression guards (pure, unit-testable).
 *
 * These encode three properties that were only enforced by accident / not at all:
 *  1. Two submits in the same tick must produce ONE refund attempt.
 *  2. A manager PIN typed for ticket A must never authorise a refund of ticket B.
 *  3. The refund identity "basis" must count COMMITTED refunds durably (SQLite),
 *     because the in-memory union can be blind to a just-committed refund and both
 *     chunks then hash identically -> the legitimate second chunk dies as a replay.
 */

export interface SubmitGuard {
  /** true when this caller may proceed; false when a submit is already in flight. */
  tryEnter(): boolean;
  /** release the guard (always call in finally). */
  leave(): void;
  readonly busy: boolean;
}

/** Synchronous re-entrancy guard. State is module-local, no timers, no async. */
export function createSubmitGuard(): SubmitGuard {
  let inFlight = false;
  return {
    tryEnter() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    leave() {
      inFlight = false;
    },
    get busy() {
      return inFlight;
    },
  };
}

/**
 * A PIN authorises only the ticket it was typed for. A missing/blank ticket
 * identity authorises nothing (fail closed).
 */
export function pinAuthorisesTicket(pinTicketId: string | null | undefined, refundTicketId: string | null | undefined): boolean {
  const pinTicket = String(pinTicketId ?? '').trim();
  const refundTicket = String(refundTicketId ?? '').trim();
  if (!pinTicket || !refundTicket) return false;
  return pinTicket === refundTicket;
}

/**
 * Dedup basis: the larger of the in-memory union count and the durable
 * committed-refund count. An exact replay keeps the same basis (same hash ->
 * refused by the native dedup gate); a later legitimate chunk sees a higher
 * durable count and hashes differently.
 */
export function committedRefundBasis(unionCount: number, durableCount: number): number {
  const a = Number.isFinite(unionCount) ? Math.max(0, Math.trunc(unionCount)) : 0;
  const b = Number.isFinite(durableCount) ? Math.max(0, Math.trunc(durableCount)) : 0;
  return Math.max(a, b);
}

export type RefundRefusal = 'AVOIR_RECIPIENT_REQUIRED';

/**
 * P0 recipient rule (owner ruling: fail closed). A refund that pays into a
 * wallet needs a recipient. Both entry shapes are covered:
 *   - the cashier chose "Avoir Client" (method), or
 *   - the original ticket was paid with store credit, so the refund's funding
 *     split carries an avoir lane that must go back to a wallet.
 * An anonymous ticket has nobody to credit; the value would evaporate.
 */
export function avoirRecipientRefusal(input: {
  method: string;
  hasCustomer: boolean;
  avoirShare: number;
}): RefundRefusal | null {
  const needsRecipient = input.method === 'Avoir Client' || Number(input.avoirShare) > 0;
  if (needsRecipient && !input.hasCustomer) return 'AVOIR_RECIPIENT_REQUIRED';
  return null;
}
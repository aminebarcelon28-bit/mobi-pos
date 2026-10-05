/**
 * Compensation-claim protocol (ad.md §§7/10 — online double-payout guard).
 *
 * Deterministic ids make two identical compensations CONVERGE, but they cannot
 * stop two online tills from each handing out cash for the same ticket at the
 * same moment. When ONLINE, a refund/void first claims a short advisory lock
 * in the `refund_claims` cloud table (remote migration v8):
 *
 *   INSERT INTO refund_claims (...) ON CONFLICT(id) DO NOTHING
 *
 * - 1 row affected  -> we hold the claim -> pay out.
 * - 0 rows affected -> a peer holds it (or held it and paid out) -> abort with
 *   HELD_BY_PEER so the cashier pulls first instead of double-paying.
 * - Cloud unreachable -> OFFLINE -> proceed (offline-first is inviolable);
 *   deterministic ids remain the convergence backstop.
 *
 * Claims expire after CLAIM_TTL_MIN minutes so a crash between claim and
 * payout cannot wedge the ticket forever. A device retrying its OWN claim
 * (same device_id) proceeds — the payout either landed (idempotent replay) or
 * never started (claim sweeps on next attempt).
 *
 * This table is lock state, not business data: it is intentionally OUTSIDE
 * ALL_REMOTE_SYNC_TABLES (never pulled, never restored).
 */

import { getTursoClient, probeOnline } from './tursoClient';
import { deterministicId } from '../utils/ids';
import { utcNowIso } from '../utils/dateUtils';

// NOTE: device identity is resolved LAZILY (never statically imported): this
// module is itself dynamically imported on the checkout critical path, and a
// static device import would pin it into the entry chunk (cold start, P11.3).

export const CLAIM_TTL_MIN = 10;

export type ClaimOutcome =
  | { claimed: true }
  | { claimed: false; reason: 'OFFLINE' | 'HELD_BY_PEER' | 'ERROR'; holder?: string };

/**
 * Method-independent claim key for one refund leg (A4: SYNC-008). Two tills
 * refunding the SAME items through DIFFERENT methods is the both-offline
 * double-payout — it must converge on one claim, not mint two. Different
 * items (or tickets) still diverge, so legitimate partial refunds proceed.
 * Transaction ids keep their method leg (distinct payout records); only the
 * mutual-exclusion key drops it. Pure and unit-tested.
 */
export function refundLegClaimId(originalTransactionId: string, canonicalKey: string): string {
  return `CLAIM-${deterministicId('REF', String(originalTransactionId ?? ''), String(canonicalKey ?? ''))}`;
}

/** Best-effort sweep so crashed claims cannot wedge a ticket past their TTL. */
async function sweepExpired(remote: { execute: (stmt: unknown) => Promise<unknown> }): Promise<void> {
  try {
    await remote.execute({
      sql: "DELETE FROM refund_claims WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')",
      args: [],
    });
  } catch {
    // Advisory only — a failed sweep never blocks compensation. Expiry is
    // ALSO a predicate on read below, so a dead sweep degrades to one extra
    // round-trip, never to a wedged ticket.
  }
}

export type ClaimContention = 'ours' | 'takeover-expired' | 'held';

/**
 * Pure contention decision (A4: SYNC-008). Expiry is evaluated ON READ, so
 * a failed pre-sweep cannot wedge a ticket on an expired row: an expired
 * holder — including a sweep that never ran — loses to a live claimant.
 * ISO-8601 strings compare lexicographically; all writers mint them via
 * toISOString(), so the comparison is sound. Empty holder with live expiry
 * stays held (unknown owner, live lock); empty holder with dead/missing
 * expiry is takeover-eligible (abandoned lock).
 */
export function resolveClaimContention(input: {
  holderDevice?: unknown;
  holderExpiresAt?: unknown;
  ourDevice: string;
  nowIso: string;
}): ClaimContention {
  const holder = typeof input.holderDevice === 'string' ? input.holderDevice : '';
  if (holder && holder === input.ourDevice) return 'ours';
  const expires = typeof input.holderExpiresAt === 'string' ? input.holderExpiresAt : '';
  if (!expires || expires <= input.nowIso) return 'takeover-expired';
  return 'held';
}

export async function tryClaimCompensation(
  kind: 'REFUND' | 'VOID' | 'RECONCILE',
  claimId: string,
  ticketId: string,
): Promise<ClaimOutcome> {
  let online = false;
  try {
    online = await probeOnline(2500);
  } catch {
    online = false;
  }
  if (!online) return { claimed: false, reason: 'OFFLINE' };

  let deviceId = 'unknown';
  try {
    const { getStableDeviceId } = await import('./device');
    deviceId = await getStableDeviceId();
  } catch {
    // Transport id fallback below keeps the claim attributable.
  }

  try {
    const remote = await getTursoClient();
    await sweepExpired(remote as unknown as { execute: (stmt: unknown) => Promise<unknown> });
    const now = utcNowIso();
    const expires = new Date(Date.now() + CLAIM_TTL_MIN * 60_000).toISOString();
    const res = (await remote.execute({
      sql: `INSERT INTO refund_claims (id, ticket_id, kind, device_id, created_at, expires_at)
            VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      args: [claimId, ticketId, kind, deviceId, now, expires],
    })) as unknown as { rowsAffected?: number };
    if (Number(res?.rowsAffected ?? 0) >= 1) return { claimed: true };

    // Lost the race (or replaying): find out who holds it, with expiry as
    // a predicate on read — a dead sweep never wedges us on an expired row.
    const claimRow = async (): Promise<{ device_id?: unknown; expires_at?: unknown } | null> => {
      try {
        const existing = (await remote.execute({
          sql: 'SELECT device_id, expires_at FROM refund_claims WHERE id = ?',
          args: [claimId],
        })) as unknown as { rows?: Array<Record<string, unknown>> };
        return (existing?.rows?.[0] as { device_id?: unknown; expires_at?: unknown } | undefined) ?? null;
      } catch {
        return null;
      }
    };
    const decide = async (): Promise<ClaimOutcome> => {
      const row = await claimRow();
      if (!row) {
        // Vanished between INSERT and SELECT (a sweep raced us): retry the
        // insert once rather than declaring a peer hold we never saw.
        try {
          const retry = (await remote.execute({
            sql: `INSERT INTO refund_claims (id, ticket_id, kind, device_id, created_at, expires_at)
                  VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
            args: [claimId, ticketId, kind, deviceId, now, expires],
          })) as unknown as { rowsAffected?: number };
          if (Number(retry?.rowsAffected ?? 0) >= 1) return { claimed: true };
        } catch {
          // Fall through to HELD_BY_PEER below.
        }
        return { claimed: false, reason: 'HELD_BY_PEER' };
      }
      const verdict = resolveClaimContention({
        holderDevice: row.device_id,
        holderExpiresAt: row.expires_at,
        ourDevice: deviceId,
        nowIso: now,
      });
      if (verdict === 'ours') return { claimed: true }; // own claim — proceed
      if (verdict === 'held') {
        const holder = String(row.device_id ?? '');
        return { claimed: false, reason: 'HELD_BY_PEER', holder: holder || undefined };
      }
      // Takeover: expired holder. Delete-by-expiry first (only an expired
      // row can match, so a live peer can never be evicted here), then
      // re-claim. Any failure degrades to HELD_BY_PEER, never to a payout.
      try {
        await remote.execute({
          sql: 'DELETE FROM refund_claims WHERE id = ? AND expires_at <= ?',
          args: [claimId, now],
        });
        const retake = (await remote.execute({
          sql: `INSERT INTO refund_claims (id, ticket_id, kind, device_id, created_at, expires_at)
                VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
          args: [claimId, ticketId, kind, deviceId, now, expires],
        })) as unknown as { rowsAffected?: number };
        if (Number(retake?.rowsAffected ?? 0) >= 1) return { claimed: true };
      } catch {
        // Fall through to HELD_BY_PEER below.
      }
      return { claimed: false, reason: 'HELD_BY_PEER' };
    };
    try {
      return await decide();
    } catch {
      return { claimed: false, reason: 'HELD_BY_PEER' };
    }
  } catch {
    // Any cloud error degrades to offline behavior — never block a payout on
    // lock-table trouble; deterministic ids still guarantee convergence.
    return { claimed: false, reason: 'ERROR' };
  }
}

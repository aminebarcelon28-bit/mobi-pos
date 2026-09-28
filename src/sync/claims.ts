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

// NOTE: device identity is resolved LAZILY (never statically imported): this
// module is itself dynamically imported on the checkout critical path, and a
// static device import would pin it into the entry chunk (cold start, P11.3).

export const CLAIM_TTL_MIN = 10;

export type ClaimOutcome =
  | { claimed: true }
  | { claimed: false; reason: 'OFFLINE' | 'HELD_BY_PEER' | 'ERROR'; holder?: string };

/** Best-effort sweep so crashed claims cannot wedge a ticket past their TTL. */
async function sweepExpired(remote: { execute: (stmt: unknown) => Promise<unknown> }): Promise<void> {
  try {
    await remote.execute({
      sql: "DELETE FROM refund_claims WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')",
      args: [],
    });
  } catch {
    // Advisory only — a failed sweep never blocks compensation.
  }
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
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + CLAIM_TTL_MIN * 60_000).toISOString();
    const res = (await remote.execute({
      sql: `INSERT INTO refund_claims (id, ticket_id, kind, device_id, created_at, expires_at)
            VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      args: [claimId, ticketId, kind, deviceId, now, expires],
    })) as unknown as { rowsAffected?: number };
    if (Number(res?.rowsAffected ?? 0) >= 1) return { claimed: true };

    // Lost the race (or replaying): find out who holds it.
    try {
      const existing = (await remote.execute({
        sql: 'SELECT device_id FROM refund_claims WHERE id = ?',
        args: [claimId],
      })) as unknown as { rows?: Array<Record<string, unknown>> };
      const holder = String(existing?.rows?.[0]?.device_id ?? '');
      if (holder && holder === deviceId) return { claimed: true }; // own claim — proceed
      return { claimed: false, reason: 'HELD_BY_PEER', holder: holder || undefined };
    } catch {
      return { claimed: false, reason: 'HELD_BY_PEER' };
    }
  } catch {
    // Any cloud error degrades to offline behavior — never block a payout on
    // lock-table trouble; deterministic ids still guarantee convergence.
    return { claimed: false, reason: 'ERROR' };
  }
}

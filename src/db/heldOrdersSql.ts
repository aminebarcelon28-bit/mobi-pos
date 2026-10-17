/**
 * UPGRADE-12 — held-sale single-claim SQL (dependency-free).
 *
 * Every statement here is executed verbatim by the repo lane
 * (`sqlPluginAdapter.ts`) and by the `node:sqlite` oracle
 * (`scripts/test_upgrade12.mts`), so the claims pinned by the suite are the
 * claims the app runs.
 *
 * Single-claim law: a held sale may be recalled at most once. `deleted = 0`
 * is the live predicate, so the claim below is a compare-and-swap — only the
 * caller whose UPDATE reports `rowsAffected === 1` owns the cart. A second
 * recall (double click, second window on the same store) sees 0 and must
 * refuse instead of double-loading the ticket.
 *
 * The claim reuses the tombstone columns of `deleteHeldOrder` (deleted = 1,
 * version bumped) so no new state vocabulary exists: a claimed hold is simply
 * a deleted hold whose delete was arbitrated. Release is the exact inverse,
 * used when a claimed hold is refused AFTER the claim (all lines catalog-
 * deleted) — the hold must stay recallable rather than be consumed by a
 * restore that never happened.
 */

/** Claim a live hold: first caller wins, everyone else sees `deleted = 0` gone. */
export const HELD_ORDER_CLAIM_SQL =
  `UPDATE held_orders
     SET deleted = 1, updated_at = $1, version = version + 1
   WHERE id = $2 AND deleted = 0`;

/** Undo a claim after a refused restore. Only a claimed (deleted = 1) row resurrects. */
export const HELD_ORDER_RELEASE_SQL =
  `UPDATE held_orders
     SET deleted = 0, updated_at = $1, version = version + 1
   WHERE id = $2 AND deleted = 1`;

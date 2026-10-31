import type { Customer, LoyaltyLedgerEntry } from '../types/pos';

/**
 * D4-A / cold review N2 (docs/reviews/D4A-third-review.md).
 *
 * The refund finishes natively: the wallet balance, its `creditDeltaDzd` ledger
 * row and the milestone revocation are all committed inside
 * `refund_sale_atomic`. The TypeScript side then has to mirror the *loyalty*
 * bookkeeping (points, buckets, tier, total spent) into the customer row.
 *
 * It must NOT mirror money. The previous path saved the whole customer object,
 * so a wallet debit that landed between the native commit and this save was
 * overwritten with the stale pre-debit snapshot — free credit (N2).
 *
 * These statements are deliberately merge-only:
 *   - a JSON merge patch (`json_patch`, RFC 7386) of loyalty keys, evaluated
 *     against the row's CURRENT payload, so `storeCredit`, `currentDebt` and
 *     the native `ledger` rows are preserved;
 *   - `store_credit` and `current_debt` columns are never in the SET list;
 *   - the ledger rows produced on the TS side are APPENDED by id.
 *
 * Every statement is safe to re-run (replay / retry): the patch is idempotent
 * for equal values and the append refuses an id that is already present.
 */

export interface RefundMirrorStatement {
  sql: string;
  args: unknown[];
}

/** Loyalty-only keys the refund may mirror. Money keys are intentionally absent. */
const LOYALTY_KEYS = ['loyaltyPoints', 'loyaltyTier', 'pointBuckets', 'totalSpent'] as const;

function loyaltyPatch(customer: Customer): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of LOYALTY_KEYS) {
    const value = (customer as unknown as Record<string, unknown>)[key];
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}

/**
 * Build the statements that mirror loyalty state onto an existing customer row.
 *
 * `newLedgerEntries` must contain ONLY the entries this operation just created
 * (a refund on a heavy customer carries hundreds of thousands of historical
 * ledger rows; re-scanning them would be quadratic).
 *
 * The row must already exist: the refund path refuses to mirror a tombstoned
 * profile (`origCustLive`), so an INSERT here could only resurrect one.
 */
export function buildRefundMirrorStatements(
  customer: Customer,
  now: string,
  newLedgerEntries: readonly LoyaltyLedgerEntry[] = [],
): RefundMirrorStatement[] {
  const statements: RefundMirrorStatement[] = [
    {
      // json_patch merges into whatever the row holds at write time. A wallet
      // movement committed after this refund's read-back therefore survives;
      // only loyalty keys are replaced. `json_valid` guards a corrupt payload
      // from being nulled out by a failing patch.
      sql: `UPDATE customers
               SET json_payload = CASE
                     WHEN json_valid(json_payload) THEN json_patch(json_payload, $2)
                     ELSE json_payload
                   END,
                   total_spent = COALESCE($3, total_spent),
                   loyalty_points = COALESCE($4, loyalty_points),
                   updated_at = $5,
                   version = version + 1
             WHERE id = $1`,
      args: [
        customer.id,
        JSON.stringify(loyaltyPatch(customer)),
        typeof customer.totalSpent === 'number' && Number.isFinite(customer.totalSpent)
          ? customer.totalSpent
          : null,
        typeof customer.loyaltyPoints === 'number' && Number.isFinite(customer.loyaltyPoints)
          ? customer.loyaltyPoints
          : null,
        now,
      ],
    },
  ];

  const seen = new Set<string>();
  for (const entry of newLedgerEntries) {
    const id = String((entry as unknown as { id?: unknown }).id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    statements.push({
      // Append by id: a row already emitted natively (or by an earlier retry)
      // is never duplicated, and the wallet's own ledger is left untouched.
      sql: `UPDATE customers
               SET json_payload = json_insert(json_payload, '$.ledger[#]', json($2))
             WHERE id = $1
               AND json_valid(json_payload)
               AND NOT EXISTS (
                     SELECT 1 FROM json_each(customers.json_payload, '$.ledger')
                      WHERE json_extract(value, '$.id') = $3
                   )`,
      args: [customer.id, JSON.stringify(entry), id],
    });
  }

  return statements;
}

/**
 * UPGRADE-10 (v125) — scheduled ABC micro-stocktake SQL (dependency-free).
 *
 * Every statement here is executed verbatim by the repo lane
 * (`sqlPluginAdapter.ts`) and by the `node:sqlite` oracles
 * (`scripts/test_cycle_count.mts`), so the plans pinned by the suite are the
 * plans the app runs.
 *
 * Watermark law: `cycle_count_tasks.opened_ledger_max_id` stores
 * `MAX(inventory_ledger.rowid)` — the ledger's TEXT primary keys
 * (`LED-…`, `seed-…`) are not chronological, but the implicit `rowid` is
 * monotonic per insert, so `rowid > opened_ledger_max_id` is exactly
 * "movements since the task opened".
 *
 * Expectation law: expected = snapshot_qty + Σ(delta) over post-watermark
 * rows with `reason != 'ADJUST'` — other stock corrections (concurrent counts,
 * manual adjusts) never leak into this task's expectation.
 */

/** Snapshot at open: live ledger sum + the insert watermark. */
export const CCT_SNAPSHOT_READ_SQL =
  `SELECT
     COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id = $1 AND deleted = 0), 0) AS ledger_sum,
     COALESCE(MAX(rowid), 0) AS ledger_max_id
   FROM inventory_ledger`;

/** Movements since the open watermark, ADJUST corrections excluded. */
export const CCT_MOVEMENTS_SUM_SQL =
  `SELECT COALESCE(SUM(delta), 0) AS moved
   FROM inventory_ledger
   WHERE product_id = $1 AND rowid > $2 AND deleted = 0 AND reason != 'ADJUST'`;

/**
 * One open task per product is enforced twice: the lane reads open tasks
 * before inserting (skip guard), and this partial unique index is the
 * backstop. `ON CONFLICT(id) DO NOTHING` makes retries converge.
 */
export const CCT_OPEN_TASK_INSERT_SQL =
  `INSERT INTO cycle_count_tasks
     (id, product_id, abc_class, due_at, opened_at, opened_ledger_max_id, snapshot_qty, created_at, updated_at, deleted)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $5, $5, 0)
   ON CONFLICT(id) DO NOTHING`;

/** Open tasks, soonest due first (the shelf list the operator works). */
export const CCT_LIST_OPEN_SQL =
  `SELECT id, product_id, abc_class, due_at, opened_at, opened_ledger_max_id, snapshot_qty,
          counted_qty, expected_qty, counted_at, operator
   FROM cycle_count_tasks
   WHERE counted_at IS NULL AND deleted = 0
   ORDER BY due_at ASC, opened_at ASC`;

/** Task read before submit (snapshot + watermark + open guard). */
export const CCT_TASK_BY_ID_SQL =
  `SELECT id, product_id, abc_class, due_at, opened_at, opened_ledger_max_id, snapshot_qty,
          counted_qty, expected_qty, counted_at, operator
   FROM cycle_count_tasks
   WHERE id = $1 AND deleted = 0
   LIMIT 1`;

/**
 * Single-claim submit: `counted_at IS NULL` in the predicate means a
 * concurrent second submit of the same task matches 0 rows and is skipped —
 * a task can never be counted twice or race a double-tap.
 */
export const CCT_SUBMIT_UPDATE_SQL =
  `UPDATE cycle_count_tasks
   SET counted_qty = $2, expected_qty = $3, counted_at = $4, operator = $5, updated_at = $4
   WHERE id = $1 AND counted_at IS NULL AND deleted = 0`;

/** Last completed count per product, for the cadence check. Batched IN-list. */
export const buildLastCountedSql = (paramCount: number): string =>
  `SELECT product_id, MAX(counted_at) AS last_counted_at
   FROM cycle_count_tasks
   WHERE product_id IN (${Array.from({ length: paramCount }, (_, i) => `$${i + 1}`).join(', ')})
     AND counted_at IS NOT NULL AND deleted = 0
   GROUP BY product_id`;

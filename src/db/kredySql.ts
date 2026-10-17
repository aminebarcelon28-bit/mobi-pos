/**
 * UPGRADE-11 (v126) — Kredy collection & risk SQL (dependency-free).
 *
 * Executed verbatim by the repo lane (`sqlPluginAdapter.ts`) and by the
 * `node:sqlite` oracles (`scripts/test_kredy.mts`), so the plans pinned by the
 * suite are the plans the app runs.
 *
 * Money law: every amount here is INTEGER DZD. Plans are strictly 0 % /
 * 0-fee — no statement below carries a fee, an interest or a rate column at
 * all; `Σ debt_plan_entries.amount = debt_plans.total_amount` is the only
 * arithmetic the lane knows.
 *
 * Cap law: `idx_dunning_cust_stage` (UNIQUE per customer+stage) is the
 * one-launch-per-stage backstop. The claim statement upserts over a
 * `PLANIFIEE` row only after it went stale (crash between claim and result),
 * so a completed `LANCEE` launch can never repeat while a dead claim does
 * not block the stage forever.
 */

/** Plan header. Retries converge (`ON CONFLICT(id) DO NOTHING`). */
export const KREDY_PLAN_INSERT_SQL =
  `INSERT INTO debt_plans
     (id, customer_id, total_amount, installments, interval_days, start_date, status, notes, created_at, updated_at, deleted)
   VALUES ($1, $2, $3, $4, $5, $6, 'ACTIF', $7, $8, $8, 0)
   ON CONFLICT(id) DO NOTHING`;

/** One dated installment (integer DZD, 0 % by construction). */
export const KREDY_PLAN_ENTRY_INSERT_SQL =
  `INSERT INTO debt_plan_entries
     (id, plan_id, seq, due_date, amount, paid_amount, paid_at, deleted)
   VALUES ($1, $2, $3, $4, $5, 0, NULL, 0)
   ON CONFLICT(id) DO NOTHING`;

/** Active plans for one customer, oldest first (the payment lane's read). */
export const KREDY_PLANS_ACTIVE_BY_CUSTOMER_SQL =
  `SELECT id, customer_id, total_amount, installments, interval_days, start_date, status, notes, created_at, updated_at
   FROM debt_plans
   WHERE customer_id = $1 AND status = 'ACTIF' AND deleted = 0
   ORDER BY created_at ASC, id ASC`;

/** Entries for a batch of plans (submitted in one payment). */
export const buildKredyPlanEntriesSql = (paramCount: number): string =>
  `SELECT id, plan_id, seq, due_date, amount, paid_amount, paid_at
   FROM debt_plan_entries
   WHERE plan_id IN (${Array.from({ length: paramCount }, (_, i) => `$${i + 1}`).join(', ')})
     AND deleted = 0
   ORDER BY plan_id ASC, seq ASC`;

/** Entry fill: `paid_at` is set only when the entry becomes fully paid. */
export const KREDY_ENTRY_PAY_UPDATE_SQL =
  `UPDATE debt_plan_entries
   SET paid_amount = $2, paid_at = COALESCE($3, paid_at)
   WHERE id = $1 AND deleted = 0`;

/** Plan close (ACTIF → SOLDE/ANNULE) — claim-style, once. */
export const KREDY_PLAN_STATUS_UPDATE_SQL =
  `UPDATE debt_plans
   SET status = $2, updated_at = $3
   WHERE id = $1 AND status = 'ACTIF' AND deleted = 0`;

/**
 * Single-claim dunning launch: inserts the stage row, or re-claims it ONLY
 * when the previous claim is `PLANIFIEE` and older than `$5` (crash
 * window). `rowsAffected === 1` means this caller owns the launch.
 */
export const KREDY_DUNNING_CLAIM_SQL =
  `INSERT INTO dunning_queue
     (id, customer_id, stage, scheduled_at, launched_at, status, created_at, deleted)
   VALUES ($1, $2, $3, $4, NULL, 'PLANIFIEE', $4, 0)
   ON CONFLICT(customer_id, stage) DO UPDATE
     SET scheduled_at = excluded.scheduled_at
     WHERE dunning_queue.status = 'PLANIFIEE' AND dunning_queue.scheduled_at < $5`;

/** Claim → launched (only after the launch itself reported success). */
export const KREDY_DUNNING_FINALIZE_SQL =
  `UPDATE dunning_queue
   SET status = 'LANCEE', launched_at = $3
   WHERE customer_id = $1 AND stage = $2 AND status = 'PLANIFIEE'`;

/** Claim → released (launch failed/blocked: the stage becomes retryable). */
export const KREDY_DUNNING_RELEASE_SQL =
  `DELETE FROM dunning_queue
   WHERE customer_id = $1 AND stage = $2 AND status = 'PLANIFIEE'`;

/** Every claim/launch for one customer (ladder state for the UI). */
export const KREDY_DUNNING_BY_CUSTOMER_SQL =
  `SELECT id, customer_id, stage, status, scheduled_at, launched_at
   FROM dunning_queue
   WHERE customer_id = $1 AND deleted = 0
   ORDER BY scheduled_at ASC, stage ASC`;

/** Ladder state for a batch of customers (one read for a whole list view). */
export const buildKredyDunningByCustomersSql = (paramCount: number): string =>
  `SELECT id, customer_id, stage, status, scheduled_at, launched_at
   FROM dunning_queue
   WHERE customer_id IN (${Array.from({ length: paramCount }, (_, i) => `$${i + 1}`).join(', ')})
     AND deleted = 0
   ORDER BY customer_id ASC, scheduled_at ASC, stage ASC`;

/**
 * Honest launch log — written ONLY when `openWhatsApp` resolved `true`.
 * `status` is always exactly 'Lancé' (the store passes the engine constant);
 * a blocked popup leaves no row, so the log never over-reports.
 */
export const KREDY_WHATSAPP_LAUNCH_INSERT_SQL =
  `INSERT INTO whatsapp_launches
     (id, customer_id, phone, purpose, stage, message_preview, status, launched_at, operator, created_at, deleted)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, 0)
   ON CONFLICT(id) DO NOTHING`;

/** Launch history for one customer, newest first. */
export const KREDY_WHATSAPP_BY_CUSTOMER_SQL =
  `SELECT id, customer_id, phone, purpose, stage, message_preview, status, launched_at, operator
   FROM whatsapp_launches
   WHERE customer_id = $1 AND deleted = 0
   ORDER BY launched_at DESC, id DESC`;

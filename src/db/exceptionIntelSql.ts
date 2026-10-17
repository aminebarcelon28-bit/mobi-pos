/**
 * UPGRADE-09 — exception-intelligence SQL text (dependency-free, testable).
 *
 * Kept out of the adapter so the query-plan oracle (`scripts/
 * test_exception_intel.mts`) can prepare these EXACT strings against
 * `node:sqlite` without dragging in the Tauri plugin chain. Each query is
 * range-bounded over an index that exists since the base schema and pinned
 * with `INDEXED BY` so the planner can never degrade to a table scan (the
 * suite asserts `SEARCH … USING INDEX` and fails on `SCAN TABLE`).
 *
 *  • `idx_audit_timestamp` — v1 (`security_audit_logs(timestamp)`).
 *  • `idx_transactions_created_at` — v1 (`transactions(created_at)`).
 *  • `idx_sessions_status` — v1 (`cash_sessions(status)`).
 *
 * `actor_id` lands with UPGRADE-09 (v124). Databases healed by an older build
 * read it as a literal NULL; the engine's deterministic legacy mapping covers
 * those rows, so no branch of the adapter can fail on shape.
 */

/** Hard cap for the audit window read — a merchant month sits far below it. */
export const EXCEPTION_AUDIT_WINDOW_LIMIT = 20000;

export function buildExceptionAuditWindowSql(actorColumnPresent: boolean): string {
  return `SELECT id, timestamp, user, action, details, requires_pin, ${
    actorColumnPresent ? 'actor_id' : 'NULL'
  } AS actor_id
FROM security_audit_logs INDEXED BY idx_audit_timestamp
WHERE timestamp >= $1 AND timestamp <= $2
ORDER BY timestamp DESC
LIMIT $3`;
}

export function buildShiftTxnCountSql(): string {
  return `SELECT shift_id AS shift_id, COUNT(*) AS n
FROM transactions INDEXED BY idx_transactions_created_at
WHERE created_at >= $1 AND created_at <= $2
  AND shift_id IS NOT NULL AND shift_id != ''
  AND deleted = 0
GROUP BY shift_id`;
}

export function buildClosedSessionSql(): string {
  return `SELECT id, cashier_name, opened_at, closed_at, expected_cash, actual_cash, discrepancy, status
FROM cash_sessions INDEXED BY idx_sessions_status
WHERE status = 'CLOSED' AND closed_at >= $1 AND closed_at <= $2
ORDER BY closed_at DESC`;
}

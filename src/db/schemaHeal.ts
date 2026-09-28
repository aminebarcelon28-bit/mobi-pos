/**
 * Local debt-lane column heal (dependency-free, unit-testable).
 *
 * Forensics (2026-09-22): devices whose Rust migrations stopped before v8
 * carry a `customer_debts` table WITHOUT `updated_at`/`deleted`/`device_id`,
 * while the pull mirror unconditionally writes `updated_at`. Every pulled
 * debt row then fails with `no such column: updated_at`, the cursor never
 * advances past it, and the lane retries the same row forever (debt never
 * converges). The boot probe in `ensureLocalSyncColumns` never caught it
 * because it only probed unrelated columns.
 *
 * These ALTERs are idempotent (duplicate column → ignored by the caller) and
 * mirror Rust migration v8 verbatim, so old and new builds converge on the
 * same shape regardless of which side healed first.
 */
export const CUSTOMER_DEBTS_COLUMN_HEAL_SQL: readonly string[] = [
  "ALTER TABLE customer_debts ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;",
  "ALTER TABLE customer_debts ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';",
  "ALTER TABLE customer_debts ADD COLUMN device_id TEXT NOT NULL DEFAULT 'legacy';",
];

/** Canary probe: fails on pre-v8 tables so the full heal pass runs. */
export const CUSTOMER_DEBTS_HEAL_PROBE_SQL =
  'SELECT updated_at FROM customer_debts LIMIT 0;';

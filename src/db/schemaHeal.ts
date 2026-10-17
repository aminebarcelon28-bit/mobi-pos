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

/**
 * UPGRADE-09 (v124) — audit actor attribution.
 *
 * The audit funnel binds every new row to the immutable cashier id
 * (`actor_id`) alongside the display name, so exception-intelligence
 * analytics never depend on mutable names. Legacy rows stay NULL and map
 * deterministically at read time (`legacy:<slug>`). Mirrors Rust v124
 * verbatim; idempotent (duplicate column → ignored by the caller). Same lane
 * rule as the v119–v123 heals: the stalled sqlx ledger may never run v124 on
 * upgraded-shape DBs, so the boot probe forces the full idempotent pass.
 */
export const AUDIT_ACTOR_ID_HEAL_SQL: readonly string[] = [
  'ALTER TABLE security_audit_logs ADD COLUMN actor_id TEXT;',
];

/** Canary probe: fails on pre-v124 tables so the full heal pass runs. */
export const AUDIT_ACTOR_ID_HEAL_PROBE_SQL =
  'SELECT actor_id FROM security_audit_logs LIMIT 0;';

/**
 * UPGRADE-10 (v125) — scheduled ABC micro-stocktakes.
 *
 * `cycle_count_tasks` freezes the expectation at open time
 * (`snapshot_qty` + `opened_ledger_max_id`, the inventory_ledger rowid
 * watermark); submit compares the physical count against
 * snapshot + post-open movements (ADJUST corrections excluded) so sales
 * between open and submit never book phantom variance. Operational table:
 * local-only (never synced), written exclusively through the repo lane in
 * `sqlPluginAdapter.ts`. Mirrors Rust v125 verbatim; idempotent (table/index
 * creation is `IF NOT EXISTS`). Same lane rule as v119–v124 heals: the
 * stalled sqlx ledger may never run v125 on upgraded-shape DBs, so the boot
 * probe forces the full idempotent pass.
 */
export const CYCLE_COUNT_TASKS_HEAL_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cycle_count_tasks (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    abc_class TEXT NOT NULL CHECK (abc_class IN ('A','B','C')),
    due_at TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    opened_ledger_max_id INTEGER NOT NULL DEFAULT 0,
    snapshot_qty INTEGER NOT NULL DEFAULT 0,
    counted_qty INTEGER,
    expected_qty INTEGER,
    counted_at TEXT,
    operator TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted INTEGER NOT NULL DEFAULT 0
  );`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_cct_open_product ON cycle_count_tasks(product_id) WHERE counted_at IS NULL AND deleted = 0;',
  'CREATE INDEX IF NOT EXISTS idx_cct_due ON cycle_count_tasks(counted_at, due_at);',
  'CREATE INDEX IF NOT EXISTS idx_cct_product_counted ON cycle_count_tasks(product_id, counted_at);',
];

/** Canary probe: fails on pre-v125 schemas so the full heal pass runs. */
export const CYCLE_COUNT_TASKS_HEAL_PROBE_SQL =
  'SELECT opened_ledger_max_id, snapshot_qty FROM cycle_count_tasks LIMIT 0;';

/**
 * UPGRADE-11 (v126) — Kredy collection & risk.
 *
 * Due dates + kind on the debt ledger (`customer_debts.due_date`/`.kind`),
 * WhatsApp opt-in and the stored reliability score on `customers`, and three
 * LOCAL-ONLY operational tables: `debt_plans` + `debt_plan_entries` (0 % /
 * 0-fee installment schedules — integer DZD, no fee/interest column exists)
 * and `dunning_queue` + `whatsapp_launches` (≤1 launch per ladder stage via
 * the unique `(customer_id, stage)` index; the launch log records only
 * launches that actually happened, status 'Lancé'). The synced debt lane
 * stays `customer_debts` itself; plans/dunning/launches never sync. Mirrors
 * Rust v126 verbatim; idempotent (duplicate column / existing table →
 * ignored by the caller). Same lane rule as v119–v125 heals: the stalled
 * sqlx ledger may never run v126 on upgraded-shape DBs, so the boot probes
 * force the full idempotent pass.
 */
export const KREDY_V126_HEAL_SQL: readonly string[] = [
  'ALTER TABLE customer_debts ADD COLUMN due_date TEXT;',
  "ALTER TABLE customer_debts ADD COLUMN kind TEXT NOT NULL DEFAULT '';",
  'ALTER TABLE customers ADD COLUMN whatsapp_opt_in INTEGER NOT NULL DEFAULT 0;',
  'ALTER TABLE customers ADD COLUMN credit_score INTEGER;',
  'ALTER TABLE customers ADD COLUMN credit_score_at TEXT;',
  `CREATE TABLE IF NOT EXISTS debt_plans (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
    installments INTEGER NOT NULL CHECK (installments >= 1),
    interval_days INTEGER NOT NULL CHECK (interval_days >= 1),
    start_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIF' CHECK (status IN ('ACTIF','SOLDE','ANNULE')),
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted INTEGER NOT NULL DEFAULT 0
  );`,
  'CREATE INDEX IF NOT EXISTS idx_debt_plans_cust ON debt_plans(customer_id, status, created_at);',
  `CREATE TABLE IF NOT EXISTS debt_plan_entries (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    paid_amount INTEGER NOT NULL DEFAULT 0,
    paid_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  );`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_dpe_plan_seq ON debt_plan_entries(plan_id, seq);',
  `CREATE TABLE IF NOT EXISTS dunning_queue (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('R1','R2','R3')),
    scheduled_at TEXT NOT NULL,
    launched_at TEXT,
    status TEXT NOT NULL DEFAULT 'PLANIFIEE' CHECK (status IN ('PLANIFIEE','LANCEE','ANNULEE')),
    message_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted INTEGER NOT NULL DEFAULT 0
  );`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_dunning_cust_stage ON dunning_queue(customer_id, stage);',
  'CREATE INDEX IF NOT EXISTS idx_dunning_status ON dunning_queue(status, scheduled_at);',
  `CREATE TABLE IF NOT EXISTS whatsapp_launches (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    purpose TEXT NOT NULL,
    stage TEXT,
    message_preview TEXT,
    status TEXT NOT NULL DEFAULT 'Lancé',
    launched_at TEXT NOT NULL,
    operator TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted INTEGER NOT NULL DEFAULT 0
  );`,
  'CREATE INDEX IF NOT EXISTS idx_whatsapp_cust ON whatsapp_launches(customer_id, launched_at);',
];

/** Canary probe: fails on pre-v126 debt tables so the full heal pass runs. */
export const KREDY_V126_PROBE_CUSTOMER_DEBTS_SQL =
  'SELECT due_date, kind FROM customer_debts LIMIT 0;';

/** Canary probe for the customer-side v126 columns (opt-in + score). */
export const KREDY_V126_PROBE_CUSTOMERS_SQL =
  'SELECT whatsapp_opt_in, credit_score, credit_score_at FROM customers LIMIT 0;';

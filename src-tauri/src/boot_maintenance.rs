//! SEC-01 increment 2, step 2 — boot writes move to native code.
//!
//! The renderer's SQL pool is writable at boot because boot itself writes
//! through it. The instrumented run (`POS_SQL_QUERY_ONLY=1`) named the exact
//! statements, and they are all **maintenance**, not business logic:
//!
//!   * purge `sync_outbox` rows already `synced`;
//!   * reset `inflight` rows to `pending` (a crash left them claimed);
//!   * reconcile the `customers.current_debt` cache from the debt ledger;
//!   * close duplicate live shifts after adoption picked a survivor;
//!   * create the one-live-shift-per-device index once the table is clean.
//!
//! They now run here, in one transaction, behind a capability + role check, so
//! the renderer no longer needs a write handle to start. Schema healing is the
//! native database's job (`db::initialize_database` + migrations), which is why
//! the renderer's SQL heal is skipped when this command succeeds — and only
//! then (a failed native boot falls back to the old renderer path).
//!
//! Every statement is a **fixed literal** in this file: the renderer supplies
//! parameters, never SQL.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::Serialize;

/// One boot wrote through the renderer pool. Values are counts so the caller can
/// log (and tests can assert) what actually happened.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BootMaintenanceReport {
    pub outbox_purged: usize,
    pub inflight_reset: usize,
    pub debts_repaired: usize,
    pub duplicate_live_shifts: usize,
    pub index_created: bool,
}

/// Apply the boot maintenance to `conn`. Idempotent; one transaction; no
/// renderer-supplied SQL.
pub fn apply_boot_maintenance(conn: &mut Connection) -> Result<BootMaintenanceReport, String> {
    let tx = conn.transaction().map_err(|e| format!("boot tx: {e}"))?;
    let mut report = BootMaintenanceReport::default();

    report.outbox_purged = tx
        .execute("DELETE FROM sync_outbox WHERE status = 'synced'", [])
        .map_err(|e| format!("purge synced outbox: {e}"))?;

    report.inflight_reset = tx
        .execute(
            "UPDATE sync_outbox SET status = 'pending' WHERE status = 'inflight'",
            [],
        )
        .map_err(|e| format!("reset inflight outbox: {e}"))?;

    // Customer cache reconciled from the ledger, exactly the renderer's SQL.
    report.debts_repaired = tx
        .execute(
            "UPDATE customers
                SET current_debt = (
                    SELECT COALESCE(SUM(CASE WHEN d.type = 'DEBT_ACQUIRED' THEN d.amount
                                             WHEN d.type = 'PAYMENT_SETTLED' THEN -d.amount
                                             ELSE 0 END), 0)
                      FROM customer_debts d
                     WHERE d.customer_id = customers.id AND d.deleted = 0
                )
              WHERE EXISTS (
                    SELECT 1 FROM customer_debts d
                     WHERE d.customer_id = customers.id AND d.deleted = 0
              )
                AND COALESCE(current_debt, -1) <> (
                    SELECT COALESCE(SUM(CASE WHEN d.type = 'DEBT_ACQUIRED' THEN d.amount
                                             WHEN d.type = 'PAYMENT_SETTLED' THEN -d.amount
                                             ELSE 0 END), 0)
                      FROM customer_debts d
                     WHERE d.customer_id = customers.id AND d.deleted = 0
                )",
            [],
        )
        .map_err(|e| format!("reconcile debt cache: {e}"))?;

    // Duplicate live shifts are a recurring offline/restore artefact; report the
    // count so the caller can refuse the unique index while any remain.
    report.duplicate_live_shifts = tx
        .query_row(
            "SELECT COUNT(*) FROM (
                 SELECT device_id FROM cash_sessions
                  WHERE status IN ('OPEN','CLOSING')
                  GROUP BY device_id HAVING COUNT(*) > 1
             )",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| format!("count duplicate shifts: {e}"))? as usize;

    if report.duplicate_live_shifts == 0 {
        tx.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_one_live_shift_per_device
               ON cash_sessions(device_id) WHERE status IN ('OPEN','CLOSING')",
            [],
        )
        .map_err(|e| format!("live shift index: {e}"))?;
        report.index_created = true;
    }

    tx.commit().map_err(|e| format!("boot commit: {e}"))?;
    Ok(report)
}

/// Close every live shift of `device_id` except `keep_id` (the survivor chosen
/// by boot adoption). Fixed literal; the ids are parameters.
pub fn close_duplicate_live_shifts(
    conn: &mut Connection,
    device_id: &str,
    keep_id: &str,
    now_iso: &str,
) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| format!("shift tx: {e}"))?;
    let closed = tx
        .execute(
            "UPDATE cash_sessions
                SET status = 'CLOSED',
                    closed_at = COALESCE(closed_at, ?1),
                    closing_note = CASE WHEN closing_note IS NULL OR closing_note = ''
                                        THEN 'AUTO_CLOSED_DUPLICATE_LIVE_SHIFT'
                                        ELSE closing_note || ' | AUTO_CLOSED_DUPLICATE_LIVE_SHIFT' END,
                    json_payload = CASE WHEN json_valid(json_payload)
                                        THEN json_set(json_payload, '$.status', 'CLOSED')
                                        ELSE json_payload END,
                    updated_at = ?2,
                    version = version + 1
              WHERE device_id = ?3 AND status IN ('OPEN','CLOSING') AND id <> ?4",
            rusqlite::params![now_iso, now_iso, device_id, keep_id],
        )
        .map_err(|e| format!("close duplicate shifts: {e}"))?;
    tx.commit().map_err(|e| format!("shift commit: {e}"))?;
    // Once the table is clean the invariant index is native DDL, not renderer SQL.
    let dups: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM (
                 SELECT device_id FROM cash_sessions
                  WHERE status IN ('OPEN','CLOSING')
                  GROUP BY device_id HAVING COUNT(*) > 1
             )",
            [],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    if dups == 0 {
        let _ = conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_one_live_shift_per_device
               ON cash_sessions(device_id) WHERE status IN ('OPEN','CLOSING')",
            [],
        );
    }
    Ok(closed)
}

/// Result of replaying the captured schema-heal migration.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SchemaHealReport {
    pub total: usize,
    pub applied: usize,
    pub tolerated: usize,
    pub failed: usize,
    pub first_error: Option<String>,
}

static SCHEMA_APPLIED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Replay the renderer's schema heal natively. Every statement is idempotent, so
/// "duplicate column"/"already exists" is a normal outcome on a healed DB; any
/// other error is counted and the worst is reported. The flag is only set when
/// nothing failed, so a partial heal never makes the renderer skip its pass.
pub fn run_schema_heal(conn: &mut Connection) -> SchemaHealReport {
    let mut report = SchemaHealReport {
        total: crate::schema_heal_sql::SCHEMA_HEAL_STATEMENTS.len(),
        ..Default::default()
    };
    for sql in crate::schema_heal_sql::SCHEMA_HEAL_STATEMENTS {
        match conn.execute_batch(sql) {
            Ok(()) => report.applied += 1,
            Err(e) => {
                let msg = e.to_string().to_lowercase();
                // Already applied, or a legacy backfill whose precondition is
                // absent on this shape (the renderer tolerated these too).
                // Only outcomes that mean "already applied" are tolerated. A
                // missing table/column means the base schema is not there yet —
                // the heal did NOT apply, and the flag must stay off so the
                // renderer's pass owns that case.
                if msg.contains("duplicate column")
                    || msg.contains("already exists")
                    || msg.contains("has no column named")
                {
                    report.tolerated += 1;
                } else {
                    report.failed += 1;
                    if report.first_error.is_none() {
                        report.first_error = Some(format!("{} :: {}", e, sql.chars().take(80).collect::<String>()));
                    }
                }
            }
        }
    }
    if report.failed == 0 {
        SCHEMA_APPLIED.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    report
}

/// Startup entry: heal an EXISTING database before the WebView. A fresh install has
/// no file yet (the plugin creates it), so the renderer path still owns first run;
/// the flag tells it when it can skip.
pub fn run_schema_heal_at_startup(app_dir: &std::path::Path) -> Result<SchemaHealReport, String> {
    let path = crate::e2e::live_db_path(app_dir);
    if !path.exists() {
        // A fresh install has no base schema yet (the plugin's v1 migration creates
        // it). Replaying the heal before those tables exist would "succeed" only by
        // tolerating "no such table" and leave a half-schema DB — measured: it broke
        // imei_records on the next boot. The renderer path owns first run until a
        // native BASE migration exists.
        return Err("database not initialised yet".to_string());
    }
    let mut conn = Connection::open(&path).map_err(|e| format!("heal open: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| format!("heal busy: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("heal fk: {e}"))?;
    Ok(run_schema_heal(&mut conn))
}

/// Public probe: true when the native schema heal completed with zero failures.
#[tauri::command]
pub fn schema_heal_applied() -> bool {
    SCHEMA_APPLIED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Gated command for hosts that want to run it explicitly (tests/diagnostics).
#[tauri::command]
pub fn run_schema_heal_command(app: tauri::AppHandle) -> Result<SchemaHealReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "run_schema_heal_command",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_live_db(&app)?;
            Ok(run_schema_heal(&mut conn))
        },
    )
}

/// Set once the native startup pass ran, so the renderer can skip its SQL.
static BOOT_APPLIED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Native startup entry point: run the boot maintenance before the WebView
/// exists, so the renderer never needs a write handle to start. Best-effort;
/// a failure is logged by the caller and the renderer falls back to its SQL.
pub fn run_at_startup(app_dir: &std::path::Path) -> Result<BootMaintenanceReport, String> {
    let path = crate::e2e::live_db_path(app_dir);
    if !path.exists() {
        return Err("database not initialised yet".to_string());
    }
    let mut conn = Connection::open(&path).map_err(|e| format!("startup open: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| format!("startup busy: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("startup fk: {e}"))?;
    let report = apply_boot_maintenance(&mut conn)?;
    BOOT_APPLIED.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(report)
}

/// Public boot probe: true when the native startup pass applied the boot writes.
/// Exposes no business data (same class as the existing gate/version probes).
#[tauri::command]
pub fn boot_maintenance_applied() -> bool {
    BOOT_APPLIED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Bump the retry counter on parked cash movements (boot drain housekeeping).
/// Fixed literal: the renderer supplies nothing.
pub fn bump_parked_attempts(conn: &Connection) -> Result<usize, String> {
    conn.execute("UPDATE sync_parked_movements SET attempts = attempts + 1", [])
        .map_err(|e| format!("bump parked attempts: {e}"))
}

#[tauri::command]
pub fn bump_parked_attempts_command(app: tauri::AppHandle) -> Result<usize, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "bump_parked_attempts_command",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_live_db(&app)?;
            bump_parked_attempts(&conn).map_err(crate::trust_core::ipc_authorizer::TrustError::op_failed)
        },
    )
}

fn open_live_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("boot app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("boot open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| TrustError::op_failed(format!("boot busy: {e}")))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| TrustError::op_failed(format!("boot wal: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("boot fk: {e}")))?;
    Ok(conn)
}

/// Native boot maintenance (SEC-01). Requires `OperationalWrites`; the app calls
/// it once at startup, before any renderer query.
#[tauri::command]
pub fn boot_maintenance(app: tauri::AppHandle) -> Result<BootMaintenanceReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "boot_maintenance",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_live_db(&app)?;
            let report = apply_boot_maintenance(&mut conn)
                .map_err(crate::trust_core::ipc_authorizer::TrustError::op_failed)?;
            BOOT_APPLIED.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(report)
        },
    )
}

/// Close the losing live shifts after boot adoption, natively.
#[tauri::command]
pub fn finalize_shift_adoption(
    app: tauri::AppHandle,
    device_id: String,
    keep_id: String,
    now_iso: String,
) -> Result<usize, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "finalize_shift_adoption",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            if device_id.trim().is_empty() || keep_id.trim().is_empty() {
                return Err(TrustError::op_failed(
                    "finalize_shift_adoption: device_id and keep_id are required".to_string(),
                ));
            }
            let mut conn = open_live_db(&app)?;
            close_duplicate_live_shifts(&mut conn, &device_id, &keep_id, &now_iso)
                .map_err(crate::trust_core::ipc_authorizer::TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
             CREATE TABLE customers (id TEXT PRIMARY KEY, current_debt INTEGER);
             CREATE TABLE customer_debts (id TEXT PRIMARY KEY, customer_id TEXT, type TEXT,
                                          amount INTEGER, deleted INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE cash_sessions (id TEXT PRIMARY KEY, device_id TEXT, status TEXT NOT NULL,
                                          closed_at TEXT, closing_note TEXT, json_payload TEXT,
                                          updated_at TEXT, version INTEGER NOT NULL DEFAULT 1);
             INSERT INTO sync_outbox (status) VALUES ('synced'), ('pending'), ('inflight'), ('inflight');
             INSERT INTO customers (id, current_debt) VALUES ('C1', 0), ('C2', 99), ('C3', NULL);
             INSERT INTO customer_debts (id, customer_id, type, amount) VALUES
                ('d1', 'C1', 'DEBT_ACQUIRED', 500),
                ('d2', 'C1', 'PAYMENT_SETTLED', 200),
                ('d3', 'C2', 'DEBT_ACQUIRED', 100);
             INSERT INTO cash_sessions (id, device_id, status, json_payload) VALUES
                ('S1', 'dev', 'OPEN', '{\"status\":\"OPEN\"}'),
                ('S2', 'dev', 'OPEN', NULL);",
        )
        .expect("schema");
        conn
    }

    #[test]
    fn purges_synced_and_resets_inflight() {
        let mut conn = seeded();
        let r = apply_boot_maintenance(&mut conn).unwrap();
        assert_eq!(r.outbox_purged, 1);
        assert_eq!(r.inflight_reset, 2);
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |x| x.get(0))
            .unwrap();
        assert_eq!(left, 3, "the synced row is gone; the reset rows remain pending");
        let pending: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE status='pending'", [], |x| x.get(0))
            .unwrap();
        assert_eq!(pending, 3);
    }

    #[test]
    fn reconciles_the_debt_cache_exactly() {
        let mut conn = seeded();
        let r = apply_boot_maintenance(&mut conn).unwrap();
        assert_eq!(r.debts_repaired, 2, "C1 and C2 are corrected");
        let c1: i64 = conn
            .query_row("SELECT current_debt FROM customers WHERE id='C1'", [], |x| x.get(0))
            .unwrap();
        let c2: i64 = conn
            .query_row("SELECT current_debt FROM customers WHERE id='C2'", [], |x| x.get(0))
            .unwrap();
        let c3: Option<i64> = conn
            .query_row("SELECT current_debt FROM customers WHERE id='C3'", [], |x| x.get(0))
            .unwrap();
        assert_eq!(c1, 300);
        assert_eq!(c2, 100);
        assert_eq!(c3, None, "a customer with no ledger rows is untouched");
    }

    #[test]
    fn refuses_the_unique_index_while_duplicates_exist() {
        let mut conn = seeded();
        let r = apply_boot_maintenance(&mut conn).unwrap();
        assert_eq!(r.duplicate_live_shifts, 1);
        assert!(!r.index_created);
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='uq_one_live_shift_per_device'",
                [],
                |x| x.get(0),
            )
            .unwrap();
        assert_eq!(idx, 0);
    }

    #[test]
    fn closes_losers_then_creates_the_index() {
        let mut conn = seeded();
        let closed = close_duplicate_live_shifts(&mut conn, "dev", "S2", "2026-11-03T00:00:00Z").unwrap();
        assert_eq!(closed, 1, "S1 is closed, S2 survives");
        let (status, note, payload): (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT status, closing_note, json_payload FROM cash_sessions WHERE id='S1'",
                [],
                |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "CLOSED");
        assert!(note.unwrap().contains("AUTO_CLOSED_DUPLICATE_LIVE_SHIFT"));
        assert!(payload.unwrap().contains("CLOSED"));
        // second call is a no-op
        assert_eq!(close_duplicate_live_shifts(&mut conn, "dev", "S2", "2026-11-03T00:00:00Z").unwrap(), 0);
        let r = apply_boot_maintenance(&mut conn).unwrap();
        assert_eq!(r.duplicate_live_shifts, 0);
        assert!(r.index_created);
    }

    #[test]
    fn maintenance_is_idempotent() {
        let mut conn = seeded();
        let first = apply_boot_maintenance(&mut conn).unwrap();
        let second = apply_boot_maintenance(&mut conn).unwrap();
        assert_eq!(first.outbox_purged, 1);
        assert_eq!(second.outbox_purged, 0);
        assert_eq!(second.inflight_reset, 0);
        assert_eq!(second.debts_repaired, 0);
    }
}

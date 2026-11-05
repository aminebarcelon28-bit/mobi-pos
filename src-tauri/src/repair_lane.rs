//! Native repair-side lanes (SEC-01 / ADR-005): technician time log and
//! warranty claims opened by a rework.
//!
//! Time log: one row per work session; closing a repair closes every running
//! session of it, idempotently (a second close reports zero rows and cannot
//! rewrite the first end time).
//!
//! Warranty claim: at most one claim per redo (rework_repair_id is the natural
//! key). Opening twice returns the existing id; closing is a claim on
//! status='open', so a delivered redo cannot absorb the parts basis twice.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReport {
    pub changes: usize,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("repair app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("repair open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("repair busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("repair fk: {e}")))?;
    Ok(conn)
}

pub fn start_time_log_core(
    conn: &Connection,
    id: &str,
    repair_id: &str,
    technician_id: &str,
    kind: &str,
    started_at: &str,
) -> Result<usize, String> {
    if id.trim().is_empty() || repair_id.trim().is_empty() || technician_id.trim().is_empty() {
        return Err("start_time_log: id, repair_id and technician_id required".to_string());
    }
    conn.execute(
        "INSERT INTO technician_time_log (id, repair_id, technician_id, kind, started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
        rusqlite::params![id, repair_id, technician_id, kind, started_at],
    )
    .map_err(|e| format!("start_time_log: {e}"))
}

pub fn close_open_time_logs_core(
    conn: &Connection,
    repair_id: &str,
    ended_at: &str,
) -> Result<usize, String> {
    if repair_id.trim().is_empty() {
        return Err("close_open_time_logs: repair_id required".to_string());
    }
    conn.execute(
        "UPDATE technician_time_log SET ended_at = ?2 WHERE repair_id = ?1 AND ended_at IS NULL",
        rusqlite::params![repair_id, ended_at],
    )
    .map_err(|e| format!("close_open_time_logs: {e}"))
}

pub fn open_warranty_claim_core(
    conn: &Connection,
    id: &str,
    original_repair_id: &str,
    rework_repair_id: &str,
    notes: &str,
    now: &str,
) -> Result<String, String> {
    if rework_repair_id.trim().is_empty() || id.trim().is_empty() {
        return Err("open_warranty_claim: id and rework_repair_id required".to_string());
    }
    if let Ok(existing) = conn.query_row(
        "SELECT id FROM warranty_claims WHERE rework_repair_id = ?1 LIMIT 1",
        rusqlite::params![rework_repair_id],
        |r| r.get::<_, String>(0),
    ) {
        return Ok(existing);
    }
    conn.execute(
        "INSERT INTO warranty_claims (id, original_repair_id, rework_repair_id, status,
            labor_basis, parts_basis, rma_id, notes, opened_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'open', 0, 0, NULL, ?4, ?5, ?5, ?5)",
        rusqlite::params![id, original_repair_id, rework_repair_id, notes, now],
    )
    .map_err(|e| format!("open_warranty_claim: {e}"))?;
    Ok(id.to_string())
}

pub fn close_warranty_claim_core(
    conn: &Connection,
    rework_repair_id: &str,
    labor_basis: i64,
    parts_basis: i64,
    closed_at: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE warranty_claims
                SET status = 'closed', labor_basis = ?2, parts_basis = ?3,
                    closed_at = ?4, updated_at = ?4
              WHERE rework_repair_id = ?1 AND status = 'open'",
            rusqlite::params![rework_repair_id, labor_basis.max(0), parts_basis.max(0), closed_at],
        )
        .map_err(|e| format!("close_warranty_claim: {e}"))?;
    Ok(changed > 0)
}

#[tauri::command]
pub fn start_time_log(
    app: tauri::AppHandle,
    id: String,
    repair_id: String,
    technician_id: String,
    kind: String,
    started_at: String,
) -> Result<WriteReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "start_time_log",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            start_time_log_core(&conn, &id, &repair_id, &technician_id, &kind, &started_at)
                .map(|changes| WriteReport { changes })
                .map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn close_open_time_logs(
    app: tauri::AppHandle,
    repair_id: String,
    ended_at: String,
) -> Result<usize, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "close_open_time_logs",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            close_open_time_logs_core(&conn, &repair_id, &ended_at).map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn open_warranty_claim(
    app: tauri::AppHandle,
    id: String,
    original_repair_id: String,
    rework_repair_id: String,
    notes: String,
    now: String,
) -> Result<String, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "open_warranty_claim",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            open_warranty_claim_core(&conn, &id, &original_repair_id, &rework_repair_id, &notes, &now)
                .map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn close_warranty_claim(
    app: tauri::AppHandle,
    rework_repair_id: String,
    labor_basis: i64,
    parts_basis: i64,
    closed_at: String,
) -> Result<bool, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "close_warranty_claim",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            close_warranty_claim_core(&conn, &rework_repair_id, labor_basis, parts_basis, &closed_at)
                .map_err(TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE technician_time_log (id TEXT PRIMARY KEY, repair_id TEXT,
                technician_id TEXT, kind TEXT, started_at TEXT, ended_at TEXT);
             CREATE TABLE warranty_claims (id TEXT PRIMARY KEY, original_repair_id TEXT,
                rework_repair_id TEXT, status TEXT, labor_basis INTEGER, parts_basis INTEGER,
                rma_id TEXT, notes TEXT, opened_at TEXT, closed_at TEXT, created_at TEXT, updated_at TEXT);",
        )
        .expect("schema");
        conn
    }

    #[test]
    fn time_log_opens_once_and_closes_idempotently() {
        let conn = seeded();
        assert_eq!(
            start_time_log_core(&conn, "L1", "R1", "TECH1", "work", "2026-11-05T09:00:00Z").unwrap(),
            1
        );
        assert_eq!(close_open_time_logs_core(&conn, "R1", "2026-11-05T10:00:00Z").unwrap(), 1);
        assert_eq!(
            close_open_time_logs_core(&conn, "R1", "2026-11-05T10:05:00Z").unwrap(),
            0,
            "an already-closed session is not re-closed"
        );
        let ended: String = conn
            .query_row("SELECT ended_at FROM technician_time_log WHERE id='L1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ended, "2026-11-05T10:00:00Z", "the first close wins");
    }

    #[test]
    fn a_rework_opens_one_claim_and_closes_it_with_its_bases() {
        let conn = seeded();
        let first = open_warranty_claim_core(&conn, "W1", "R0", "R1", "reprise", "2026-11-05T09:00:00Z").unwrap();
        let again = open_warranty_claim_core(&conn, "W2", "R0", "R1", "reprise", "2026-11-05T09:01:00Z").unwrap();
        assert_eq!(first, "W1");
        assert_eq!(again, "W1", "one claim per redo");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM warranty_claims", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);

        assert!(close_warranty_claim_core(&conn, "R1", 0, 2500, "2026-11-06T09:00:00Z").unwrap());
        assert!(
            !close_warranty_claim_core(&conn, "R1", 0, 9999, "2026-11-06T09:05:00Z").unwrap(),
            "a closed claim is not re-closed"
        );
        let (status, parts): (String, i64) = conn
            .query_row(
                "SELECT status, parts_basis FROM warranty_claims WHERE id='W1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "closed");
        assert_eq!(parts, 2500, "the first close's basis stands");
    }
}

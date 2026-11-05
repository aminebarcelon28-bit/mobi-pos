//! Native voucher write lane (SEC-01 / ADR-005).
//!
//! Credit-voucher capture and credit-back are compare-and-swap updates on
//! `remaining_amount`: a concurrent lane that moved the balance must lose, and
//! the loser sees 0 rows (the caller then inspects before deciding). The write
//! is now native, same statement and same guard.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoucherReport {
    pub changes: usize,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("voucher app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("voucher open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("voucher busy: {e}")))?;
    Ok(conn)
}

/// Guarded update: only the caller whose read still matches wins.
pub fn update_credit_voucher_core(
    conn: &Connection,
    id: &str,
    expected_remaining: i64,
    remaining: i64,
    status: &str,
    now: &str,
) -> Result<usize, String> {
    if id.trim().is_empty() {
        return Err("update_credit_voucher: id required".to_string());
    }
    conn.execute(
        "UPDATE credit_vouchers SET remaining_amount = ?1, status = ?2, updated_at = ?3,
            version = version + 1
          WHERE id = ?4 AND remaining_amount = ?5",
        rusqlite::params![remaining, status, now, id, expected_remaining],
    )
    .map_err(|e| format!("update_credit_voucher: {e}"))
}

#[tauri::command]
pub fn update_credit_voucher(
    app: tauri::AppHandle,
    id: String,
    expected_remaining: i64,
    remaining: i64,
    status: String,
    now: String,
) -> Result<VoucherReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "update_credit_voucher",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            update_credit_voucher_core(&conn, &id, expected_remaining, remaining, &status, &now)
                .map(|changes| VoucherReport { changes })
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
            "CREATE TABLE credit_vouchers (id TEXT PRIMARY KEY, remaining_amount INTEGER NOT NULL,
                status TEXT NOT NULL, updated_at TEXT, version INTEGER NOT NULL DEFAULT 1);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO credit_vouchers (id, remaining_amount, status, version) VALUES ('V1', 1000, 'ACTIVE', 3)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_stale_expected_balance_loses_the_cas() {
        let conn = seeded();
        assert_eq!(
            update_credit_voucher_core(&conn, "V1", 1000, 400, "PARTIAL", "2026-11-05T10:00:00Z").unwrap(),
            1
        );
        assert_eq!(
            update_credit_voucher_core(&conn, "V1", 1000, 0, "EXHAUSTED", "2026-11-05T10:00:01Z").unwrap(),
            0,
            "the same expected balance cannot be captured twice"
        );
        let (remaining, version): (i64, i64) = conn
            .query_row("SELECT remaining_amount, version FROM credit_vouchers WHERE id='V1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(remaining, 400);
        assert_eq!(version, 4);
    }
}

//! Native kredy (installment plan) lane (SEC-01 / ADR-005).
//!
//! Three renderer writes on the debt-plan path:
//!
//!   * `insertDebtPlanWithEntries` — entries first, then the header (a crash
//!     between the two leaves orphan entries that reads ignore, never a header
//!     with a half-written schedule);
//!   * `updateDebtPlanEntries` — the payment fill (0 % / 0-fee by contract);
//!   * `setDebtPlanStatus` — the ACTIF → SOLDE/ANNULE single claim.
//!
//! All three are native now. The create lane puts entries and header in ONE
//! transaction (strictly stronger than the renderer's two loops), and every
//! statement keeps `ON CONFLICT DO NOTHING` / claim semantics so a retry
//! converges and a completed close can never repeat.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPlanEntryInput {
    pub id: String,
    pub seq: i64,
    pub due_date: String,
    pub amount: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPlanRequest {
    pub id: String,
    pub customer_id: String,
    pub total_amount: i64,
    pub installments: i64,
    pub interval_days: i64,
    pub start_date: String,
    pub notes: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub entries: Vec<DebtPlanEntryInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPlanPayment {
    pub id: String,
    pub paid_amount: i64,
    pub paid_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DebtPlanReport {
    pub entries_written: usize,
    pub header_written: usize,
    pub claimed: bool,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("kredy app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("kredy open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("kredy busy: {e}")))?;
    Ok(conn)
}

/// Entries + header in one transaction; both inserts converge on retry.
pub fn save_debt_plan_core(
    conn: &mut Connection,
    req: &DebtPlanRequest,
) -> Result<DebtPlanReport, String> {
    if req.id.trim().is_empty() || req.customer_id.trim().is_empty() {
        return Err("save_debt_plan: id and customer_id required".to_string());
    }
    let tx = conn.transaction().map_err(|e| format!("plan tx: {e}"))?;
    let mut report = DebtPlanReport::default();
    for entry in &req.entries {
        let changed = tx
            .execute(
                "INSERT INTO debt_plan_entries
                   (id, plan_id, seq, due_date, amount, paid_amount, paid_at, deleted)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, 0)
                 ON CONFLICT(id) DO NOTHING",
                rusqlite::params![entry.id, req.id, entry.seq, entry.due_date, entry.amount],
            )
            .map_err(|e| format!("plan entry: {e}"))?;
        report.entries_written += changed;
    }
    report.header_written = tx
        .execute(
            "INSERT INTO debt_plans
               (id, customer_id, total_amount, installments, interval_days, start_date, status, notes, created_at, updated_at, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ACTIF', ?7, ?8, ?8, 0)
             ON CONFLICT(id) DO NOTHING",
            rusqlite::params![
                req.id,
                req.customer_id,
                req.total_amount,
                req.installments,
                req.interval_days,
                req.start_date,
                req.notes,
                req.created_at
            ],
        )
        .map_err(|e| format!("plan header: {e}"))?;
    tx.commit().map_err(|e| format!("plan commit: {e}"))?;
    Ok(report)
}

/// Payment fill: `paid_amount` always, `paid_at` only when the caller says the
/// entry is settled (`COALESCE` keeps an earlier timestamp).
pub fn pay_debt_plan_entries_core(
    conn: &mut Connection,
    payments: &[DebtPlanPayment],
) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| format!("plan pay tx: {e}"))?;
    let mut written = 0usize;
    for payment in payments {
        written += tx
            .execute(
                "UPDATE debt_plan_entries
                    SET paid_amount = ?2, paid_at = COALESCE(?3, paid_at)
                  WHERE id = ?1 AND deleted = 0",
                rusqlite::params![payment.id, payment.paid_amount, payment.paid_at],
            )
            .map_err(|e| format!("plan pay: {e}"))?;
    }
    tx.commit().map_err(|e| format!("plan pay commit: {e}"))?;
    Ok(written)
}

/// Close claim: only an ACTIF plan transitions, and only once.
pub fn close_debt_plan_core(
    conn: &Connection,
    plan_id: &str,
    status: &str,
    now: &str,
) -> Result<bool, String> {
    if status != "SOLDE" && status != "ANNULE" {
        return Err("close_debt_plan: status must be SOLDE or ANNULE".to_string());
    }
    let changed = conn
        .execute(
            "UPDATE debt_plans
                SET status = ?2, updated_at = ?3
              WHERE id = ?1 AND status = 'ACTIF' AND deleted = 0",
            rusqlite::params![plan_id, status, now],
        )
        .map_err(|e| format!("close_debt_plan: {e}"))?;
    Ok(changed == 1)
}

#[tauri::command]
pub fn save_debt_plan(
    app: tauri::AppHandle,
    request: DebtPlanRequest,
) -> Result<DebtPlanReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "save_debt_plan",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            save_debt_plan_core(&mut conn, &request).map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn pay_debt_plan_entries(
    app: tauri::AppHandle,
    payments: Vec<DebtPlanPayment>,
) -> Result<usize, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "pay_debt_plan_entries",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            if payments.len() > 500 {
                return Err(TrustError::op_failed("pay_debt_plan_entries: batch too large"));
            }
            let mut conn = open_db(&app)?;
            pay_debt_plan_entries_core(&mut conn, &payments).map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn close_debt_plan(
    app: tauri::AppHandle,
    plan_id: String,
    status: String,
    now: String,
) -> Result<bool, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "close_debt_plan",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            close_debt_plan_core(&conn, &plan_id, &status, &now).map_err(TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE debt_plans (id TEXT PRIMARY KEY, customer_id TEXT, total_amount INTEGER,
                installments INTEGER, interval_days INTEGER, start_date TEXT, status TEXT,
                notes TEXT, created_at TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE debt_plan_entries (id TEXT PRIMARY KEY, plan_id TEXT, seq INTEGER,
                due_date TEXT, amount INTEGER, paid_amount INTEGER, paid_at TEXT,
                deleted INTEGER NOT NULL DEFAULT 0);",
        )
        .expect("schema");
        conn
    }

    fn plan() -> DebtPlanRequest {
        DebtPlanRequest {
            id: "PL1".to_string(),
            customer_id: "C1".to_string(),
            total_amount: 3000,
            installments: 3,
            interval_days: 30,
            start_date: "2026-11-05".to_string(),
            notes: None,
            created_at: "2026-11-05T10:00:00Z".to_string(),
            entries: vec![
                DebtPlanEntryInput { id: "E1".to_string(), seq: 1, due_date: "2026-12-05".to_string(), amount: 1000 },
                DebtPlanEntryInput { id: "E2".to_string(), seq: 2, due_date: "2027-01-05".to_string(), amount: 1000 },
                DebtPlanEntryInput { id: "E3".to_string(), seq: 3, due_date: "2027-02-05".to_string(), amount: 1000 },
            ],
        }
    }

    #[test]
    fn plan_and_entries_commit_together_and_retry_converges() {
        let mut conn = seeded();
        let first = save_debt_plan_core(&mut conn, &plan()).expect("create");
        assert_eq!(first.entries_written, 3);
        assert_eq!(first.header_written, 1);
        let second = save_debt_plan_core(&mut conn, &plan()).expect("retry");
        assert_eq!(second.entries_written, 0, "ON CONFLICT DO NOTHING");
        assert_eq!(second.header_written, 0);

        let sum: i64 = conn
            .query_row("SELECT COALESCE(SUM(amount),0) FROM debt_plan_entries WHERE plan_id='PL1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sum, 3000, "Σ entries == header total");
        let status: String = conn
            .query_row("SELECT status FROM debt_plans WHERE id='PL1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "ACTIF");
    }

    #[test]
    fn a_failing_header_rolls_the_entries_back() {
        let mut conn = seeded();
        conn.execute_batch("ALTER TABLE debt_plans RENAME TO debt_plans_off;").unwrap();
        let err = save_debt_plan_core(&mut conn, &plan()).expect_err("must roll back");
        assert!(err.contains("plan header"), "{err}");
        let entries: i64 = conn
            .query_row("SELECT COUNT(*) FROM debt_plan_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(entries, 0, "no orphan schedule without its header");
    }

    #[test]
    fn payment_fill_sets_paid_at_only_when_settled() {
        let mut conn = seeded();
        save_debt_plan_core(&mut conn, &plan()).expect("create");
        let written = pay_debt_plan_entries_core(
            &mut conn,
            &[
                DebtPlanPayment { id: "E1".to_string(), paid_amount: 400, paid_at: None },
                DebtPlanPayment { id: "E2".to_string(), paid_amount: 1000, paid_at: Some("2026-12-01".to_string()) },
            ],
        )
        .expect("pay");
        assert_eq!(written, 2);
        let (partial, partial_at): (i64, Option<String>) = conn
            .query_row("SELECT paid_amount, paid_at FROM debt_plan_entries WHERE id='E1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(partial, 400);
        assert!(partial_at.is_none(), "a partial payment does not settle");
        let settled_at: Option<String> = conn
            .query_row("SELECT paid_at FROM debt_plan_entries WHERE id='E2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(settled_at.as_deref(), Some("2026-12-01"));
    }

    #[test]
    fn close_is_a_single_claim() {
        let mut conn = seeded();
        save_debt_plan_core(&mut conn, &plan()).expect("create");
        assert!(close_debt_plan_core(&conn, "PL1", "SOLDE", "2026-11-06T00:00:00Z").unwrap());
        assert!(
            !close_debt_plan_core(&conn, "PL1", "ANNULE", "2026-11-06T00:00:01Z").unwrap(),
            "a closed plan does not transition again"
        );
        assert!(close_debt_plan_core(&conn, "PL1", "ACTIF", "2026-11-06T00:00:02Z").is_err());
    }
}

//! Native customer write lanes (SEC-01 / ADR-005).
//!
//! Two renderer writes dominated the refund-spec refusal log after the sync
//! enqueue moved native:
//!
//!   * the customer upsert in `saveCustomer` (INSERT … ON CONFLICT with an
//!     optimistic version guard);
//!   * the pull/requeue stamp `UPDATE customers SET sync_status='synced'`.
//!
//! Both now run natively with fixed literals. The upsert keeps the TypeScript
//! contract exactly: the guard is `WHERE customers.version = <base>` when the
//! caller is in a guarded attempt, `current_debt` is COALESCEd so a caller that
//! does not carry it does not wipe the ledger cache, and `created_at` is kept on
//! update.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertCustomerRequest {
    pub id: String,
    pub name: String,
    pub phone: String,
    pub email: Option<String>,
    pub loyalty_points: i64,
    pub store_credit: i64,
    pub pricing_tier: String,
    pub total_spent: i64,
    pub current_debt: Option<i64>,
    pub json_payload: String,
    pub updated_at: String,
    pub version: i64,
    pub base_version: i64,
    pub idempotency_key: String,
    pub guarded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerWriteReport {
    pub changes: usize,
    pub version: i64,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("customer app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("customer open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("customer busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("customer fk: {e}")))?;
    Ok(conn)
}

/// Same statement as `customerAdapter.writeRow`, fixed literals, guard optional.
pub fn upsert_customer_core(
    conn: &Connection,
    req: &UpsertCustomerRequest,
) -> Result<CustomerWriteReport, String> {
    if req.id.trim().is_empty() {
        return Err("upsert_customer: id required".to_string());
    }
    if req.json_payload.len() > 256 * 1024 {
        return Err("upsert_customer: payload oversized".to_string());
    }
    let sql = if req.guarded {
        "INSERT INTO customers (id, name, phone, email, loyalty_points, store_credit, pricing_tier, total_spent, json_payload, updated_at, deleted, version, idempotency_key, created_at, current_debt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?12, ?10, ?14)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email,
           loyalty_points=excluded.loyalty_points, store_credit=excluded.store_credit,
           pricing_tier=excluded.pricing_tier, total_spent=excluded.total_spent,
           json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0,
           current_debt=COALESCE(excluded.current_debt, customers.current_debt),
           version = excluded.version,
           created_at = CASE WHEN COALESCE(customers.created_at, '') = '' THEN excluded.created_at ELSE customers.created_at END
         WHERE customers.version = ?13"
    } else {
        "INSERT INTO customers (id, name, phone, email, loyalty_points, store_credit, pricing_tier, total_spent, json_payload, updated_at, deleted, version, idempotency_key, created_at, current_debt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?12, ?10, ?14)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email,
           loyalty_points=excluded.loyalty_points, store_credit=excluded.store_credit,
           pricing_tier=excluded.pricing_tier, total_spent=excluded.total_spent,
           json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0,
           current_debt=COALESCE(excluded.current_debt, customers.current_debt),
           version = excluded.version,
           created_at = CASE WHEN COALESCE(customers.created_at, '') = '' THEN excluded.created_at ELSE customers.created_at END"
    };
    let changes = conn
        .execute(
            sql,
            rusqlite::params![
                req.id,
                req.name,
                req.phone,
                req.email,
                req.loyalty_points,
                req.store_credit,
                req.pricing_tier,
                req.total_spent,
                req.json_payload,
                req.updated_at,
                req.version,
                req.idempotency_key,
                req.base_version,
                req.current_debt,
            ],
        )
        .map_err(|e| format!("upsert_customer: {e}"))?;
    Ok(CustomerWriteReport {
        changes,
        version: req.version,
    })
}

/// Stamp a re-enqueued customer as synced. Version- and status-guarded so a
/// pending row that changed underneath is left pending (the loop re-reads).
pub fn mark_customer_synced_core(
    conn: &Connection,
    id: &str,
    version: i64,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE customers
            SET sync_status = 'synced'
          WHERE id = ?1 AND version = ?2 AND COALESCE(sync_status, '') = 'pending'",
        rusqlite::params![id, version],
    )
    .map_err(|e| format!("mark_customer_synced: {e}"))
}

#[tauri::command]
pub fn upsert_customer(
    app: tauri::AppHandle,
    request: UpsertCustomerRequest,
) -> Result<CustomerWriteReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "upsert_customer",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            upsert_customer_core(&conn, &request).map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn mark_customer_synced(
    app: tauri::AppHandle,
    id: String,
    version: i64,
) -> Result<usize, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "mark_customer_synced",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            if id.trim().is_empty() {
                return Err(TrustError::op_failed("mark_customer_synced: id required"));
            }
            let conn = open_db(&app)?;
            mark_customer_synced_core(&conn, &id, version).map_err(TrustError::op_failed)
        },
    )
}

/// Soft-delete a customer: bump the version clock so a stale same-version
/// echo can never resurrect the row through the guarded upsert.
pub fn tombstone_customer_core(
    conn: &Connection,
    id: &str,
    now: &str,
) -> Result<usize, String> {
    if id.trim().is_empty() {
        return Err("tombstone_customer: id required".to_string());
    }
    conn.execute(
        "UPDATE customers SET deleted = 1, version = COALESCE(version, 1) + 1, updated_at = ?2
          WHERE id = ?1",
        rusqlite::params![id, now],
    )
    .map_err(|e| format!("tombstone_customer: {e}"))
}

#[tauri::command]
pub fn tombstone_customer(
    app: tauri::AppHandle,
    id: String,
    now: String,
) -> Result<usize, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "tombstone_customer",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            tombstone_customer_core(&conn, &id, &now).map_err(TrustError::op_failed)
        },
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtCacheEntry {
    pub customer_id: String,
    pub debt: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DebtCacheReport {
    pub changed: usize,
}

/// Reconcile the `customers.current_debt` cache from the ledger projection.
/// Writes only rows whose value actually changes and never bumps `version`
/// (this is a derived cache, not a user edit — bumping would emit a spurious
/// sync event on every pull).
pub fn refresh_customer_debt_cache_core(
    conn: &mut Connection,
    entries: &[DebtCacheEntry],
) -> Result<DebtCacheReport, String> {
    let tx = conn.transaction().map_err(|e| format!("debt cache tx: {e}"))?;
    let mut report = DebtCacheReport::default();
    for e in entries {
        if e.customer_id.trim().is_empty() {
            continue;
        }
        let projected = e.debt.max(0);
        let changed = tx
            .execute(
                "UPDATE customers SET current_debt = ?1
                  WHERE id = ?2 AND COALESCE(current_debt, -1) <> ?1",
                rusqlite::params![projected, e.customer_id],
            )
            .map_err(|err| format!("debt cache {}: {err}", e.customer_id))?;
        report.changed += changed;
    }
    tx.commit().map_err(|e| format!("debt cache commit: {e}"))?;
    Ok(report)
}

#[tauri::command]
pub fn refresh_customer_debt_cache(
    app: tauri::AppHandle,
    request: Vec<DebtCacheEntry>,
) -> Result<DebtCacheReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "refresh_customer_debt_cache",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            refresh_customer_debt_cache_core(&mut conn, &request).map_err(TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE customers (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
                loyalty_points INTEGER DEFAULT 0, store_credit INTEGER DEFAULT 0,
                pricing_tier TEXT DEFAULT 'Retail', total_spent INTEGER DEFAULT 0,
                json_payload TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
                idempotency_key TEXT, created_at TEXT, current_debt INTEGER,
                sync_status TEXT DEFAULT 'pending');",
        )
        .expect("schema");
        conn
    }

    fn req() -> UpsertCustomerRequest {
        UpsertCustomerRequest {
            id: "C-1".to_string(),
            name: "Ali".to_string(),
            phone: "0550".to_string(),
            email: None,
            loyalty_points: 10,
            store_credit: 500,
            pricing_tier: "Retail".to_string(),
            total_spent: 1000,
            current_debt: Some(250),
            json_payload: "{\"id\":\"C-1\",\"name\":\"Ali\",\"version\":1}".to_string(),
            updated_at: "2026-11-04T10:00:00.000Z".to_string(),
            version: 1,
            base_version: 0,
            idempotency_key: "cust-C-1".to_string(),
            guarded: false,
        }
    }

    #[test]
    fn debt_cache_writes_only_changed_rows_and_never_bumps_version() {
        let mut conn = seeded();
        conn.execute(
            "INSERT INTO customers (id, name, phone, json_payload, updated_at, version, current_debt)
             VALUES ('C1', 'Ali', '0550', '{}', '2026-11-01', 7, 0)",
            [],
        )
        .unwrap();
        let report = refresh_customer_debt_cache_core(
            &mut conn,
            &[
                DebtCacheEntry { customer_id: "C1".to_string(), debt: 300 },
                DebtCacheEntry { customer_id: "MISSING".to_string(), debt: 100 },
            ],
        )
        .expect("refresh");
        assert_eq!(report.changed, 1, "only the live row changes");
        let (debt, version): (i64, i64) = conn
            .query_row("SELECT current_debt, version FROM customers WHERE id='C1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(debt, 300);
        assert_eq!(version, 7, "a derived cache refresh never bumps the clock");

        // Same value again: no write, no event.
        let again = refresh_customer_debt_cache_core(
            &mut conn,
            &[DebtCacheEntry { customer_id: "C1".to_string(), debt: 300 }],
        )
        .expect("refresh");
        assert_eq!(again.changed, 0);
    }

    #[test]
    fn tombstone_bumps_the_clock_and_is_repeatable() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO customers (id, name, phone, json_payload, updated_at, version)
             VALUES ('C9', 'Ali', '0550', '{}', '2026-11-01', 4)",
            [],
        )
        .unwrap();
        assert_eq!(tombstone_customer_core(&conn, "C9", "2026-11-05T10:00:00Z").unwrap(), 1);
        let (deleted, version): (i64, i64) = conn
            .query_row("SELECT deleted, version FROM customers WHERE id='C9'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(version, 5);
        assert_eq!(tombstone_customer_core(&conn, "C9", "2026-11-05T10:00:01Z").unwrap(), 1);
        assert_eq!(tombstone_customer_core(&conn, "MISSING", "2026-11-05T10:00:02Z").unwrap(), 0);
    }

    #[test]
    fn inserts_then_updates_with_the_optimistic_guard() {
        let conn = seeded();
        let first = upsert_customer_core(&conn, &req()).expect("insert");
        assert_eq!(first.changes, 1);

        let mut update = req();
        update.name = "Ali B".to_string();
        update.version = 2;
        update.base_version = 1;
        update.guarded = true;
        let second = upsert_customer_core(&conn, &update).expect("guarded update");
        assert_eq!(second.changes, 1);

        // A stale guarded attempt must not change the row.
        let mut stale = req();
        stale.name = "Stale".to_string();
        stale.version = 2;
        stale.base_version = 1;
        stale.guarded = true;
        let third = upsert_customer_core(&conn, &stale).expect("stale");
        assert_eq!(third.changes, 0, "CAS loses the race");

        let (name, version, debt): (String, i64, i64) = conn
            .query_row(
                "SELECT name, version, current_debt FROM customers WHERE id='C-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(name, "Ali B");
        assert_eq!(version, 2);
        assert_eq!(debt, 250);
    }

    #[test]
    fn a_missing_current_debt_keeps_the_ledger_cache() {
        let conn = seeded();
        upsert_customer_core(&conn, &req()).expect("insert");
        let mut update = req();
        update.current_debt = None;
        update.version = 2;
        let _ = upsert_customer_core(&conn, &update).expect("update");
        let debt: i64 = conn
            .query_row("SELECT current_debt FROM customers WHERE id='C-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(debt, 250, "COALESCE preserves the cache");
    }

    #[test]
    fn synced_stamp_is_version_and_status_guarded() {
        let conn = seeded();
        upsert_customer_core(&conn, &req()).expect("insert");
        assert_eq!(mark_customer_synced_core(&conn, "C-1", 1).unwrap(), 1);
        assert_eq!(
            mark_customer_synced_core(&conn, "C-1", 1).unwrap(),
            0,
            "already synced: nothing to stamp"
        );
        conn.execute("UPDATE customers SET sync_status='pending' WHERE id='C-1'", [])
            .unwrap();
        assert_eq!(
            mark_customer_synced_core(&conn, "C-1", 99).unwrap(),
            0,
            "a different version stays pending"
        );
        assert_eq!(mark_customer_synced_core(&conn, "missing", 1).unwrap(), 0);
    }
}

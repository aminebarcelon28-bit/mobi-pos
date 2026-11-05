//! Native held-order lane (SEC-01 / ADR-005).
//!
//! Held sales are a single-claim lane: a hold may be recalled at most once, and
//! the claim is a compare-and-swap on `deleted = 0`. These four writes used to
//! run on the WebView pool. They now run natively with the same statements:
//! save (upsert, version bump), tombstone (delete), claim (CAS) and release
//! (inverse of claim).

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldOrderSaveRequest {
    pub id: String,
    pub customer_id: Option<String>,
    pub customer_name: Option<String>,
    pub items_count: i64,
    pub total_amount: f64,
    pub json_payload: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldOrderReport {
    pub changes: usize,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("held app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("held open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("held busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("held fk: {e}")))?;
    Ok(conn)
}

pub fn save_held_order_core(
    conn: &Connection,
    req: &HeldOrderSaveRequest,
) -> Result<HeldOrderReport, String> {
    if req.id.trim().is_empty() {
        return Err("save_held_order: id required".to_string());
    }
    if req.json_payload.len() > 512 * 1024 {
        return Err("save_held_order: payload oversized".to_string());
    }
    let changes = conn
        .execute(
            "INSERT INTO held_orders (
                id, customer_id, customer_name, items_count, total_amount, json_payload,
                device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'local', ?1, 'pending', 1, ?7, ?7, 0)
             ON CONFLICT(id) DO UPDATE SET
               customer_id = excluded.customer_id,
               customer_name = excluded.customer_name,
               items_count = excluded.items_count,
               total_amount = excluded.total_amount,
               json_payload = excluded.json_payload,
               updated_at = excluded.updated_at,
               version = held_orders.version + 1,
               deleted = 0",
            rusqlite::params![
                req.id,
                req.customer_id,
                req.customer_name,
                req.items_count,
                req.total_amount,
                req.json_payload,
                req.created_at
            ],
        )
        .map_err(|e| format!("save_held_order: {e}"))?;
    Ok(HeldOrderReport { changes })
}

#[tauri::command]
pub fn save_held_order(
    app: tauri::AppHandle,
    request: HeldOrderSaveRequest,
) -> Result<HeldOrderReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "save_held_order",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            save_held_order_core(&conn, &request).map_err(TrustError::op_failed)
        },
    )
}

fn tombstone(conn: &Connection, id: &str, now: &str, deleted: i64, live: i64) -> Result<usize, String> {
    conn.execute(
        "UPDATE held_orders SET deleted = ?3, updated_at = ?1, version = version + 1
          WHERE id = ?2 AND deleted = ?4",
        rusqlite::params![now, id, deleted, live],
    )
    .map_err(|e| format!("held_order update: {e}"))
}

pub fn delete_held_order_core(conn: &Connection, id: &str, now: &str) -> Result<usize, String> {
    // `deleteHeldOrder` has no live predicate (a second delete bumps again).
    conn.execute(
        "UPDATE held_orders SET deleted = 1, updated_at = ?1, version = version + 1 WHERE id = ?2",
        rusqlite::params![now, id],
    )
    .map_err(|e| format!("delete_held_order: {e}"))
}

pub fn claim_held_order_core(conn: &Connection, id: &str, now: &str) -> Result<usize, String> {
    tombstone(conn, id, now, 1, 0)
}

pub fn release_held_order_core(conn: &Connection, id: &str, now: &str) -> Result<usize, String> {
    tombstone(conn, id, now, 0, 1)
}

#[tauri::command]
pub fn delete_held_order(app: tauri::AppHandle, id: String, now: String) -> Result<HeldOrderReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "delete_held_order",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            delete_held_order_core(&conn, &id, &now)
                .map(|changes| HeldOrderReport { changes })
                .map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn claim_held_order(app: tauri::AppHandle, id: String, now: String) -> Result<HeldOrderReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "claim_held_order",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            claim_held_order_core(&conn, &id, &now)
                .map(|changes| HeldOrderReport { changes })
                .map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn release_held_order(app: tauri::AppHandle, id: String, now: String) -> Result<HeldOrderReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "release_held_order",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            release_held_order_core(&conn, &id, &now)
                .map(|changes| HeldOrderReport { changes })
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
            "CREATE TABLE held_orders (
                id TEXT PRIMARY KEY, customer_id TEXT, customer_name TEXT,
                items_count INTEGER NOT NULL DEFAULT 0, total_amount REAL NOT NULL DEFAULT 0,
                json_payload TEXT NOT NULL, device_id TEXT, idempotency_key TEXT,
                sync_status TEXT, version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0);",
        )
        .expect("schema");
        conn
    }

    fn save() -> HeldOrderSaveRequest {
        HeldOrderSaveRequest {
            id: "H1".to_string(),
            customer_id: Some("C1".to_string()),
            customer_name: Some("Ali".to_string()),
            items_count: 2,
            total_amount: 2500.0,
            json_payload: "{\"id\":\"H1\"}".to_string(),
            created_at: "2026-11-05T08:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn save_upserts_and_bumps_the_version() {
        let conn = seeded();
        assert_eq!(save_held_order_core(&conn, &save()).unwrap().changes, 1);
        assert_eq!(save_held_order_core(&conn, &save()).unwrap().changes, 1);
        let (version, deleted): (i64, i64) = conn
            .query_row("SELECT version, deleted FROM held_orders WHERE id='H1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(version, 2);
        assert_eq!(deleted, 0);
    }

    #[test]
    fn claim_is_single_winner_and_release_is_its_inverse() {
        let conn = seeded();
        save_held_order_core(&conn, &save()).unwrap();
        assert_eq!(claim_held_order_core(&conn, "H1", "2026-11-05T09:00:00Z").unwrap(), 1);
        assert_eq!(
            claim_held_order_core(&conn, "H1", "2026-11-05T09:00:01Z").unwrap(),
            0,
            "the second recall loses the CAS"
        );
        assert_eq!(release_held_order_core(&conn, "H1", "2026-11-05T09:00:02Z").unwrap(), 1);
        assert_eq!(
            release_held_order_core(&conn, "H1", "2026-11-05T09:00:03Z").unwrap(),
            0,
            "only a claimed hold resurrects"
        );
        assert_eq!(claim_held_order_core(&conn, "H1", "2026-11-05T09:00:04Z").unwrap(), 1);
    }

    #[test]
    fn delete_tombstones_even_when_already_deleted() {
        let conn = seeded();
        save_held_order_core(&conn, &save()).unwrap();
        assert_eq!(delete_held_order_core(&conn, "H1", "2026-11-05T09:00:00Z").unwrap(), 1);
        assert_eq!(delete_held_order_core(&conn, "H1", "2026-11-05T09:00:01Z").unwrap(), 1);
        let deleted: i64 = conn
            .query_row("SELECT deleted FROM held_orders WHERE id='H1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(deleted, 1);
    }
}

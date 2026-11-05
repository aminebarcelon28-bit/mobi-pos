//! Native order-status lane (SEC-01 / ADR-005).
//!
//! `enqueueOrderSync` flips a sale's status (VOID / REFUNDED /
//! PARTIALLY_REFUNDED), bumps the version clock, and upserts the `order`
//! envelope — all inside a renderer `BEGIN IMMEDIATE`, because two racing voids
//! must serialize and the loser must see `ALREADY_VOIDED` instead of
//! double-restoring stock.
//!
//! It is now one native transaction with the same statement text and the same
//! refusal: the version bump is written to the row *and* stamped into the
//! envelope, so a stale same-version echo can never un-void the sale.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderStatusRequest {
    pub order_id: String,
    /// Absent = the caller only wants the envelope (no status flip).
    pub status: Option<String>,
    pub payload_json: String,
    pub now: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderStatusReport {
    pub version: i64,
    pub idempotency_key: String,
    pub status_changed: bool,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("order app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("order open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("order busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("order fk: {e}")))?;
    Ok(conn)
}

/// Status flip + version bump + envelope in one transaction. `ALREADY_VOIDED`
/// is the same typed refusal the renderer raised, and it aborts before any
/// write so the loser cannot double-restore stock.
pub fn sync_order_status_core(
    conn: &mut Connection,
    req: &OrderStatusRequest,
) -> Result<OrderStatusReport, String> {
    if req.order_id.trim().is_empty() {
        return Err("sync_order_status: order_id required".to_string());
    }
    let tx = conn.transaction().map_err(|e| format!("order tx: {e}"))?;

    let row: Option<(i64, String, Option<String>)> = tx
        .query_row(
            "SELECT COALESCE(version, 1), COALESCE(status, ''), idempotency_key
               FROM transactions WHERE id = ?1",
            rusqlite::params![req.order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let (current_version, current_status, existing_key) =
        row.unwrap_or((0, String::new(), None));

    if let Some(status) = req.status.as_deref() {
        if status == "VOIDED" && current_status == "VOIDED" {
            return Err("ALREADY_VOIDED".to_string());
        }
    }

    let next_version = current_version + 1;
    let mut status_changed = false;
    if let Some(status) = req.status.as_deref() {
        let changed = tx
            .execute(
                "UPDATE transactions SET status = ?1, updated_at = ?2, version = ?3, sync_status = ?4 WHERE id = ?5",
                rusqlite::params![status, req.now, next_version, "pending", req.order_id],
            )
            .map_err(|e| format!("order status update: {e}"))?;
        status_changed = changed > 0;
    }

    let key = existing_key
        .filter(|k| !k.trim().is_empty())
        .unwrap_or_else(|| format!("legacy-{}", req.order_id));

    let mut payload: serde_json::Value =
        serde_json::from_str(&req.payload_json).unwrap_or_else(|_| serde_json::json!({}));
    if !payload.is_object() {
        payload = serde_json::json!({});
    }
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "idempotency_key".to_string(),
            serde_json::Value::String(key.clone()),
        );
        obj.insert("updated_at".to_string(), serde_json::Value::String(req.now.clone()));
        obj.insert("version".to_string(), serde_json::json!(next_version));
    }
    let json = payload.to_string();
    if json.len() > 1024 * 1024 {
        return Err("sync_order_status: payload oversized".to_string());
    }

    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES (?1, 'order', ?2, 'UPSERT', ?3, 'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json,
           status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=?4",
        rusqlite::params![key, req.order_id, json, req.now],
    )
    .map_err(|e| format!("order outbox: {e}"))?;

    tx.commit().map_err(|e| format!("order commit: {e}"))?;
    Ok(OrderStatusReport {
        version: next_version,
        idempotency_key: key,
        status_changed,
    })
}

#[tauri::command]
pub fn sync_order_status(
    app: tauri::AppHandle,
    request: OrderStatusRequest,
) -> Result<OrderStatusReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "sync_order_status",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            sync_order_status_core(&mut conn, &request).map_err(TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE transactions (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT,
                version INTEGER NOT NULL DEFAULT 1, sync_status TEXT, idempotency_key TEXT);
             CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT, last_error TEXT, updated_at TEXT);
             INSERT INTO transactions (id, status, version, idempotency_key)
                VALUES ('T1', 'COMPLETED', 4, 'ord-T1');",
        )
        .expect("schema");
        conn
    }

    fn req(status: Option<&str>) -> OrderStatusRequest {
        OrderStatusRequest {
            order_id: "T1".to_string(),
            status: status.map(|s| s.to_string()),
            payload_json: "{\"id\":\"T1\",\"status\":\"VOIDED\"}".to_string(),
            now: "2026-11-05T12:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn status_flip_bumps_the_clock_and_stamps_the_envelope() {
        let mut conn = seeded();
        let report = sync_order_status_core(&mut conn, &req(Some("VOIDED"))).expect("void");
        assert!(report.status_changed);
        assert_eq!(report.version, 5);
        assert_eq!(report.idempotency_key, "ord-T1", "reuses the order's key");

        let (status, version): (String, i64) = conn
            .query_row("SELECT status, version FROM transactions WHERE id='T1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(status, "VOIDED");
        assert_eq!(version, 5);

        let (etype, payload): (String, String) = conn
            .query_row("SELECT entity_type, payload_json FROM sync_outbox", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(etype, "order");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["version"], 5, "the envelope carries the bumped clock");
        assert_eq!(parsed["idempotency_key"], "ord-T1");
    }

    #[test]
    fn a_second_void_is_refused_and_writes_nothing() {
        let mut conn = seeded();
        sync_order_status_core(&mut conn, &req(Some("VOIDED"))).expect("first");
        let err = sync_order_status_core(&mut conn, &req(Some("VOIDED"))).expect_err("second");
        assert_eq!(err, "ALREADY_VOIDED");
        let outbox: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(outbox, 1, "no second envelope");
        let version: i64 = conn
            .query_row("SELECT version FROM transactions WHERE id='T1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 5, "and no extra clock bump");
    }

    #[test]
    fn a_missing_row_still_enqueues_with_a_legacy_key() {
        let mut conn = seeded();
        let mut r = req(Some("REFUNDED"));
        r.order_id = "T-MISSING".to_string();
        let report = sync_order_status_core(&mut conn, &r).expect("enqueue only");
        assert!(!report.status_changed);
        assert_eq!(report.idempotency_key, "legacy-T-MISSING");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn the_envelope_payload_is_never_trusted_for_the_clock() {
        let mut conn = seeded();
        let mut r = req(Some("PARTIALLY_REFUNDED"));
        r.payload_json = "{\"version\":999,\"idempotency_key\":\"spoofed\"}".to_string();
        let report = sync_order_status_core(&mut conn, &r).expect("flip");
        let payload: String = conn
            .query_row("SELECT payload_json FROM sync_outbox", [], |r| r.get(0))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["version"], report.version);
        assert_eq!(parsed["idempotency_key"], "ord-T1");
    }
}

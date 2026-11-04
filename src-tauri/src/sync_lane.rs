//! Native generic sync enqueue (SEC-01 / ADR-005).
//!
//! Every `fireSync` in the renderer funnels through `enqueueGenericSync`, which
//! used to do three writes on the WebView pool: ensure the `entity_keys` row,
//! bump its version clock, and upsert the `sync_outbox` row. Under a read-only
//! pool that is the single largest refusal class (measured: 94 × 4 statements in
//! one refund spec), and a crash between the three writes could leave a version
//! bump without its outbox row.
//!
//! They now happen in ONE native transaction, with fixed literals:
//!
//!   * `entity_keys` row (UUID) created when absent, version bumped otherwise;
//!   * `sync_outbox` UPSERT (or DELETE tombstone) carrying the bumped version;
//!   * payload bounded and required to be a JSON object.
//!
//! The renderer supplies values only; the entity name is checked against the
//! same closed set the TypeScript union defines.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Same closed set as `GenericEntity` in `sqlPluginAdapter.ts`.
const GENERIC_ENTITIES: &[&str] = &[
    "customer",
    "repair_order",
    "purchase_order",
    "trade_in",
    "imei",
    "audit_log",
    "cash_drop",
    "bundle",
    "customer_debt",
    "store_expense",
    "cash_session",
    "cash_movement",
    "setting",
    "credit_voucher",
    "stock_batches",
    "sale_batch_allocations",
    "sale_batch_allocation",
];

/// Mirrors `MAX_SYNC_PAYLOAD_BYTES` (64 KiB).
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueRequest {
    pub entity: String,
    pub entity_id: String,
    /// Already sanitised by the renderer (`toBoundedSyncJson`); must be a JSON object.
    pub payload_json: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueReport {
    pub idempotency_key: String,
    pub version: i64,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("sync app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("sync open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("sync busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("sync fk: {e}")))?;
    Ok(conn)
}

fn validate(entity: &str, entity_id: &str, payload: &str) -> Result<(), String> {
    if !GENERIC_ENTITIES.contains(&entity) {
        return Err(format!("enqueue: entity not allowed ({entity})"));
    }
    if entity_id.trim().is_empty() || entity_id.len() > 200 {
        return Err("enqueue: entity_id missing or oversized".to_string());
    }
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(format!(
            "enqueue: payload {} bytes exceeds {MAX_PAYLOAD_BYTES}",
            payload.len()
        ));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(payload).map_err(|e| format!("enqueue: payload not JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("enqueue: payload must be a JSON object".to_string());
    }
    Ok(())
}

fn key_and_version(
    tx: &rusqlite::Transaction<'_>,
    entity: &str,
    entity_id: &str,
) -> Result<(String, i64), String> {
    let existing: Option<(String, i64)> = tx
        .query_row(
            "SELECT idempotency_key, COALESCE(version, 1) FROM entity_keys
              WHERE entity_type = ?1 AND entity_id = ?2",
            rusqlite::params![entity, entity_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (key, current) = match existing {
        Some(v) => v,
        None => {
            let k = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version)
                 VALUES (?1, ?2, ?3, 1)",
                rusqlite::params![entity, entity_id, k],
            )
            .map_err(|e| format!("enqueue entity key: {e}"))?;
            (k, 1)
        }
    };
    let next = current + 1;
    tx.execute(
        "UPDATE entity_keys SET version = ?1 WHERE entity_type = ?2 AND entity_id = ?3",
        rusqlite::params![next, entity, entity_id],
    )
    .map_err(|e| format!("enqueue version bump: {e}"))?;
    Ok((key, next))
}

fn enqueue_core(
    conn: &mut Connection,
    req: &EnqueueRequest,
    operation: &str,
    tombstone: bool,
) -> Result<EnqueueReport, String> {
    validate(&req.entity, &req.entity_id, &req.payload_json)?;
    let tx = conn.transaction().map_err(|e| format!("enqueue tx: {e}"))?;
    let (key, version) = key_and_version(&tx, &req.entity, &req.entity_id)?;

    let payload = if tombstone {
        serde_json::json!({ "id": req.entity_id, "deleted": 1, "version": version }).to_string()
    } else {
        let mut value: serde_json::Value =
            serde_json::from_str(&req.payload_json).map_err(|e| format!("enqueue payload: {e}"))?;
        if let Some(obj) = value.as_object_mut() {
            obj.insert("version".to_string(), serde_json::json!(version));
        }
        value.to_string()
    };

    let now = crate::trust_core::time_anchor::iso_utc_ms(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    );

    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation = ?4,
             payload_json = excluded.payload_json,
             status = 'pending',
             retry_count = 0,
             next_retry_at = NULL,
             last_error = NULL,
             updated_at = ?6",
        rusqlite::params![key, req.entity, req.entity_id, operation, payload, now],
    )
    .map_err(|e| format!("enqueue outbox: {e}"))?;

    tx.commit().map_err(|e| format!("enqueue commit: {e}"))?;
    Ok(EnqueueReport {
        idempotency_key: key,
        version,
    })
}

/// Upsert enqueue (same contract as `enqueueGenericSync`).
#[tauri::command]
pub fn enqueue_sync_upsert(
    app: tauri::AppHandle,
    request: EnqueueRequest,
) -> Result<EnqueueReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "enqueue_sync_upsert",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            enqueue_core(&mut conn, &request, "UPSERT", false).map_err(TrustError::op_failed)
        },
    )
}

/// Tombstone enqueue (same contract as `enqueueGenericDelete`).
#[tauri::command]
pub fn enqueue_sync_delete(
    app: tauri::AppHandle,
    request: EnqueueRequest,
) -> Result<EnqueueReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "enqueue_sync_delete",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            enqueue_core(&mut conn, &request, "DELETE", true).map_err(TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE entity_keys (
                entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (entity_type, entity_id));
             CREATE TABLE sync_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
                entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
                payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_error TEXT,
                updated_at TEXT);",
        )
        .expect("schema");
        conn
    }

    fn req() -> EnqueueRequest {
        EnqueueRequest {
            entity: "customer".to_string(),
            entity_id: "C-1".to_string(),
            payload_json: "{\"id\":\"C-1\",\"name\":\"Ali\"}".to_string(),
        }
    }

    #[test]
    fn upsert_creates_key_and_outbox_in_one_step() {
        let mut conn = seeded();
        let first = enqueue_core(&mut conn, &req(), "UPSERT", false).expect("first");
        let second = enqueue_core(&mut conn, &req(), "UPSERT", false).expect("second");
        assert_eq!(first.version, 2, "new entity starts at version 2");
        assert_eq!(second.version, 3, "the clock is monotonic");
        assert_eq!(first.idempotency_key, second.idempotency_key, "one key per entity");

        let (op, payload, status): (String, String, String) = conn
            .query_row(
                "SELECT operation, payload_json, status FROM sync_outbox WHERE entity_id='C-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(op, "UPSERT");
        assert_eq!(status, "pending");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["version"], 3);
        assert_eq!(parsed["name"], "Ali");
    }

    #[test]
    fn delete_is_a_tombstone_with_a_higher_version() {
        let mut conn = seeded();
        enqueue_core(&mut conn, &req(), "UPSERT", false).expect("upsert");
        let del = enqueue_core(&mut conn, &req(), "DELETE", true).expect("delete");
        assert_eq!(del.version, 3);
        let (op, payload): (String, String) = conn
            .query_row(
                "SELECT operation, payload_json FROM sync_outbox WHERE entity_id='C-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(op, "DELETE");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["deleted"], 1);
        assert_eq!(parsed["version"], 3);
    }

    #[test]
    fn rejects_an_unknown_entity_and_writes_nothing() {
        let mut conn = seeded();
        let mut bad = req();
        bad.entity = "not_an_entity".to_string();
        assert!(enqueue_core(&mut conn, &bad, "UPSERT", false).is_err());
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn rejects_an_oversized_payload_and_rolls_back() {
        let mut conn = seeded();
        let mut big = req();
        big.payload_json = format!("{{\"x\":\"{}\"}}", "a".repeat(MAX_PAYLOAD_BYTES));
        assert!(enqueue_core(&mut conn, &big, "UPSERT", false).is_err());
        let keys: i64 = conn
            .query_row("SELECT COUNT(*) FROM entity_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(keys, 0, "validation happens before any write");
    }
}

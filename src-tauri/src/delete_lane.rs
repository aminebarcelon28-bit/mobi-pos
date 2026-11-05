//! Native product-delete lane (SEC-01 / ADR-005).
//!
//! Deleting a product was the last renderer write on the suite: a tombstone
//! UPDATE, its DELETE envelope, and — from the catalog slice — a tombstone of
//! every live `stock_batches` row plus one UPSERT envelope per batch.
//!
//! All of it is one transaction here:
//!
//!   1. read the product (key + version) before the delete;
//!   2. tombstone it, bumping the clock (H18b: a stale same-version echo must
//!      not resurrect the row — the pull guard is `excluded.version >= row`);
//!   3. enqueue the product DELETE with the full snapshot at the bumped version;
//!   4. tombstone every live batch of the product, then enqueue one UPSERT per
//!      batch carrying the committed version (`sb-<id>-tombstone`, so a retry
//!      converges);
//!   5. record the `product_deleted` shadow event (best-effort, after commit,
//!      exactly like the renderer).
//!
//! A second delete is idempotent: the keys are stable, so envelopes converge
//! instead of multiplying.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProductRequest {
    pub product_id: String,
    pub device_id: String,
    pub now: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProductReport {
    pub product_changed: bool,
    pub product_version: i64,
    pub batches_tombstoned: usize,
    pub idempotency_key: String,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("delete app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("delete open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("delete busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("delete fk: {e}")))?;
    Ok(conn)
}

fn row_json(row: &rusqlite::Row<'_>, names: &[String]) -> Result<serde_json::Value, String> {
    use rusqlite::types::Value as SqlValue;
    let mut obj = serde_json::Map::new();
    for (i, name) in names.iter().enumerate() {
        let v: SqlValue = row.get(i).map_err(|e| format!("row value: {e}"))?;
        let j = match v {
            SqlValue::Null => serde_json::Value::Null,
            SqlValue::Integer(n) => serde_json::json!(n),
            SqlValue::Real(f) => serde_json::json!(f),
            SqlValue::Text(t) => serde_json::Value::String(t),
            SqlValue::Blob(_) => serde_json::Value::Null,
        };
        obj.insert(name.clone(), j);
    }
    Ok(serde_json::Value::Object(obj))
}

/// Tombstone the product and its live batches, with every envelope, in one
/// transaction. Returns what actually changed so the caller can report it.
pub fn delete_product_core(
    conn: &mut Connection,
    req: &DeleteProductRequest,
) -> Result<DeleteProductReport, String> {
    if req.product_id.trim().is_empty() {
        return Err("delete_product: product_id required".to_string());
    }
    let tx = conn.transaction().map_err(|e| format!("delete tx: {e}"))?;
    let mut report = DeleteProductReport::default();

    // 1. Snapshot the row before the tombstone (full payload for the envelope).
    let mut snapshot = {
        let mut stmt = tx
            .prepare("SELECT * FROM products WHERE id = ?1")
            .map_err(|e| format!("delete read: {e}"))?;
        let names: Vec<String> = stmt.column_names().iter().map(|n| n.to_string()).collect();
        let mut rows = stmt.query(rusqlite::params![req.product_id]).map_err(|e| format!("delete query: {e}"))?;
        match rows.next().map_err(|e| format!("delete row: {e}"))? {
            Some(row) => row_json(row, &names)?,
            None => serde_json::json!({ "id": req.product_id }),
        }
    };
    let key = snapshot
        .get("idempotency_key")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("legacy-{}", req.product_id));
    let before_version = snapshot.get("version").and_then(|v| v.as_i64()).unwrap_or(0);

    // 2 + 3. Tombstone the product and enqueue the DELETE at the bumped clock.
    let changed = tx
        .execute(
            "UPDATE products SET deleted=1, version=version+1, updated_at=?1, sync_status='pending' WHERE id=?2",
            rusqlite::params![req.now, req.product_id],
        )
        .map_err(|e| format!("delete product: {e}"))?;
    report.product_changed = changed > 0;
    let tombstone_version: i64 = tx
        .query_row(
            "SELECT COALESCE(version, 1) FROM products WHERE id = ?1",
            rusqlite::params![req.product_id],
            |r| r.get(0),
        )
        .unwrap_or(before_version + 1);
    report.product_version = tombstone_version;
    report.idempotency_key = key.clone();

    if let Some(obj) = snapshot.as_object_mut() {
        obj.insert("deleted".to_string(), serde_json::json!(1));
        obj.insert("updated_at".to_string(), serde_json::Value::String(req.now.clone()));
        obj.insert("version".to_string(), serde_json::json!(tombstone_version));
    }
    let product_payload = snapshot.to_string();
    if product_payload.len() > 256 * 1024 {
        return Err("delete_product: payload oversized".to_string());
    }
    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES (?1,'product',?2,'DELETE',?3,'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation='DELETE', payload_json=excluded.payload_json,
           status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=?4",
        rusqlite::params![key, req.product_id, product_payload, req.now],
    )
    .map_err(|e| format!("delete product envelope: {e}"))?;

    // 4. Tombstone every live batch and enqueue its UPSERT at the committed clock.
    let live: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT batch_id FROM stock_batches WHERE product_id = ?1 AND deleted = 0")
            .map_err(|e| format!("delete batches read: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![req.product_id], |r| r.get::<_, String>(0))
            .map_err(|e| format!("delete batches query: {e}"))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if !live.is_empty() {
        tx.execute(
            "UPDATE stock_batches SET deleted = 1, version = version + 1, updated_at = ?1, sync_status = 'pending'
              WHERE product_id = ?2 AND deleted = 0",
            rusqlite::params![req.now, req.product_id],
        )
        .map_err(|e| format!("delete batch tombstone: {e}"))?;
    }
    for batch_id in &live {
        let version: i64 = tx
            .query_row(
                "SELECT COALESCE(version, 1) FROM stock_batches WHERE batch_id = ?1",
                rusqlite::params![batch_id],
                |r| r.get(0),
            )
            .unwrap_or(1);
        let payload = serde_json::json!({
            "batch_id": batch_id,
            "product_id": req.product_id,
            "deleted": 1,
            "version": version,
            "updated_at": req.now,
        })
        .to_string();
        tx.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES (?1, 'stock_batches', ?2, 'UPSERT', ?3, 'pending')
             ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending',
               retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=?4",
            rusqlite::params![format!("sb-{batch_id}-tombstone"), batch_id, payload, req.now],
        )
        .map_err(|e| format!("delete batch envelope: {e}"))?;
        report.batches_tombstoned += 1;
    }

    tx.commit().map_err(|e| format!("delete commit: {e}"))?;

    // 5. Shadow event, best-effort after the commit (the row is already durable).
    let shadow = crate::shadow_event_lane::ShadowEventRequest {
        event_id: crate::shadow_event_lane::mint_event_id(),
        aggregate: format!("product:{}", req.product_id),
        hlc: req.now.clone(),
        device_id: req.device_id.clone(),
        schema_v: 1,
        event_type: "product_deleted".to_string(),
        data_json: serde_json::json!({ "id": req.product_id }).to_string(),
        created_at: req.now.clone(),
    };
    let _ = crate::shadow_event_lane::record_shadow_event_core(conn, &shadow);

    Ok(report)
}

#[tauri::command]
pub fn delete_product(
    app: tauri::AppHandle,
    request: DeleteProductRequest,
) -> Result<DeleteProductReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "delete_product",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            delete_product_core(&mut conn, &request).map_err(TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE products (id TEXT PRIMARY KEY, title TEXT, deleted INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, sync_status TEXT,
                idempotency_key TEXT);
             CREATE TABLE stock_batches (batch_id TEXT PRIMARY KEY, product_id TEXT,
                quantity_remaining INTEGER, unit_cost REAL, deleted INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, sync_status TEXT,
                created_at TEXT, received_at TEXT, purchase_order_id TEXT);
             CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT, last_error TEXT, updated_at TEXT);
             CREATE TABLE event_log (event_id TEXT PRIMARY KEY, aggregate TEXT, hlc TEXT,
                device_id TEXT, schema_v INTEGER, event_type TEXT, data_json TEXT,
                synced_to_cloud INTEGER NOT NULL DEFAULT 0, created_at TEXT);
             CREATE TABLE p_products (id TEXT PRIMARY KEY, name TEXT, price_cents INTEGER,
                stock INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
                row_hlc TEXT, updated_at TEXT);
             CREATE TABLE projection_cursor (projection_name TEXT PRIMARY KEY,
                last_event_id TEXT, last_hlc TEXT, updated_at TEXT);
             INSERT INTO products (id, title, version, idempotency_key)
                VALUES ('P1', 'Phone', 4, 'pk-P1');
             INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, version)
                VALUES ('B1', 'P1', 3, 700, 2), ('B2', 'P1', 1, 650, 5);",
        )
        .expect("schema");
        conn
    }

    fn req() -> DeleteProductRequest {
        DeleteProductRequest {
            product_id: "P1".to_string(),
            device_id: "dev".to_string(),
            now: "2026-11-05T18:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn delete_tombstones_product_and_live_batches_with_envelopes() {
        let mut conn = seeded();
        let report = delete_product_core(&mut conn, &req()).expect("delete");
        assert!(report.product_changed);
        assert_eq!(report.product_version, 5, "4 + 1");
        assert_eq!(report.batches_tombstoned, 2);

        let (deleted, version): (i64, i64) = conn
            .query_row("SELECT deleted, version FROM products WHERE id='P1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(version, 5);

        let batches: Vec<(String, i64, i64)> = conn
            .prepare("SELECT batch_id, deleted, version FROM stock_batches ORDER BY batch_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(batches, vec![("B1".into(), 1, 3), ("B2".into(), 1, 6)]);

        let product_payload: String = conn
            .query_row(
                "SELECT payload_json FROM sync_outbox WHERE entity_type='product'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&product_payload).unwrap();
        assert_eq!(parsed["deleted"], 1);
        assert_eq!(parsed["version"], 5, "the tombstone carries the bumped clock");
        assert_eq!(parsed["title"], "Phone", "full snapshot for a remote that never saw it");

        let batch_envelopes: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity_type='stock_batches'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(batch_envelopes, 2);
        let b2: String = conn
            .query_row(
                "SELECT payload_json FROM sync_outbox WHERE idempotency_key='sb-B2-tombstone'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&b2).unwrap();
        assert_eq!(parsed["version"], 6, "B2 was at 5, so the tombstone is 6");
        assert_eq!(parsed["deleted"], 1);
    }

    #[test]
    fn a_second_delete_converges_instead_of_multiplying_envelopes() {
        let mut conn = seeded();
        delete_product_core(&mut conn, &req()).expect("first");
        let again = delete_product_core(&mut conn, &req()).expect("second");
        assert_eq!(again.batches_tombstoned, 0, "no batch is live any more");
        let outbox: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(outbox, 3, "one product + two batches, not six");
        let product_envelopes: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity_type='product'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(product_envelopes, 1);
    }

    #[test]
    fn a_stale_same_version_echo_cannot_resurrect_the_row() {
        let mut conn = seeded();
        let before: i64 = conn.query_row("SELECT version FROM products WHERE id='P1'", [], |r| r.get(0)).unwrap();
        delete_product_core(&mut conn, &req()).expect("delete");
        let payload: String = conn
            .query_row("SELECT payload_json FROM sync_outbox WHERE entity_type='product'", [], |r| r.get(0))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let pushed = parsed["version"].as_i64().unwrap();
        assert!(pushed > before, "tombstone {pushed} must beat the pre-delete {before}");
    }

    #[test]
    fn a_missing_product_still_enqueues_with_a_legacy_key() {
        let mut conn = seeded();
        let mut r = req();
        r.product_id = "P-GONE".to_string();
        let report = delete_product_core(&mut conn, &r).expect("tolerant");
        assert!(!report.product_changed);
        assert_eq!(report.idempotency_key, "legacy-P-GONE");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity_type='product'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn a_failing_batch_envelope_rolls_the_whole_delete_back() {
        let mut conn = seeded();
        conn.execute_batch(
            "CREATE TRIGGER refuse_batch_env BEFORE INSERT ON sync_outbox
               WHEN NEW.entity_type = 'stock_batches'
             BEGIN SELECT RAISE(ABORT, 'no batch envelopes'); END;",
        )
        .unwrap();
        let err = delete_product_core(&mut conn, &req()).expect_err("must roll back");
        assert!(err.contains("batch envelope"), "{err}");
        let (deleted, version): (i64, i64) = conn
            .query_row("SELECT deleted, version FROM products WHERE id='P1'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(deleted, 0, "the product tombstone did not survive");
        assert_eq!(version, 4);
    }
}

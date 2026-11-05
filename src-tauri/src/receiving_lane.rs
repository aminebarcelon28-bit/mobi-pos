//! Native receiving lane (SEC-01 / ADR-005).
//!
//! Two writes dominated the remaining flag refusals on the buy/refund paths:
//!
//!   * `insertStockBatch` — the batch row plus its `sync_outbox` envelope, with a
//!     version read-back so the envelope carries the committed clock;
//!   * `insertSupplierPriceRows` — the per-line supplier evidence rows.
//!
//! Both now run natively with fixed literals. The batch lane is one transaction,
//! so a crash between the row and its envelope cannot leave a batch that a peer
//! never learns about.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockBatchRequest {
    pub batch_id: String,
    pub product_id: String,
    pub quantity_remaining: i64,
    pub unit_cost: f64,
    #[serde(default)]
    pub freight_per_unit: f64,
    pub received_at: String,
    pub purchase_order_id: Option<String>,
    pub device_id: String,
    /// Honoured when present so a retry converges on one envelope (the old
    /// renderer lane always minted a fresh key, duplicating outbox rows).
    pub idempotency_key: Option<String>,
    pub now: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockBatchReport {
    pub batch_id: String,
    pub version: i64,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierPriceRow {
    pub id: String,
    pub product_id: String,
    pub product_name: Option<String>,
    pub supplier: String,
    pub invoice_no: Option<String>,
    pub unit_cost: i64,
    pub quantity: i64,
    pub batch_id: Option<String>,
    pub received_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierPriceReport {
    pub written: usize,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("receiving app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("receiving open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("receiving busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("receiving fk: {e}")))?;
    Ok(conn)
}

/// Batch row + envelope in one transaction; the envelope carries the committed
/// version (read back after the upsert, exactly like the renderer did).
pub fn insert_stock_batch_core(
    conn: &mut Connection,
    req: &StockBatchRequest,
) -> Result<StockBatchReport, String> {
    if req.batch_id.trim().is_empty() || req.product_id.trim().is_empty() {
        return Err("insert_stock_batch: batch_id and product_id required".to_string());
    }
    let key = req
        .idempotency_key
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let tx = conn.transaction().map_err(|e| format!("batch tx: {e}"))?;
    tx.execute(
        "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, freight_per_unit,
            received_at, purchase_order_id, device_id, idempotency_key, sync_status, version,
            created_at, updated_at, deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', 1, ?10, ?10, 0)
         ON CONFLICT(batch_id) DO UPDATE SET quantity_remaining=excluded.quantity_remaining,
           version = version + 1,
           unit_cost=excluded.unit_cost, freight_per_unit=excluded.freight_per_unit,
           updated_at=excluded.updated_at, sync_status='pending'",
        rusqlite::params![
            req.batch_id,
            req.product_id,
            req.quantity_remaining,
            req.unit_cost,
            req.freight_per_unit.max(0.0),
            req.received_at,
            req.purchase_order_id,
            req.device_id,
            key,
            req.now
        ],
    )
    .map_err(|e| format!("batch insert: {e}"))?;

    let version: i64 = tx
        .query_row(
            "SELECT COALESCE(version, 1) FROM stock_batches WHERE batch_id = ?1",
            rusqlite::params![req.batch_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("batch version: {e}"))?;

    let payload = serde_json::json!({
        "version": version,
        "batch_id": req.batch_id,
        "product_id": req.product_id,
        "quantity_remaining": req.quantity_remaining,
        "unit_cost": req.unit_cost,
        "received_at": req.received_at,
        "purchase_order_id": req.purchase_order_id,
        "device_id": req.device_id,
        "idempotency_key": key,
        "updated_at": req.now,
    })
    .to_string();
    if payload.len() > 256 * 1024 {
        return Err("insert_stock_batch: payload oversized".to_string());
    }
    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES (?1, 'stock_batches', ?2, 'UPSERT', ?3, 'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=?4",
        rusqlite::params![key, req.batch_id, payload, req.now],
    )
    .map_err(|e| format!("batch outbox: {e}"))?;

    tx.commit().map_err(|e| format!("batch commit: {e}"))?;
    Ok(StockBatchReport {
        batch_id: req.batch_id.clone(),
        version,
        idempotency_key: key,
    })
}

/// Per-line supplier evidence. Idempotent by row id (`ON CONFLICT DO NOTHING`),
/// so a retried receipt appends nothing twice.
pub fn insert_supplier_price_rows_core(
    conn: &mut Connection,
    rows: &[SupplierPriceRow],
) -> Result<SupplierPriceReport, String> {
    let tx = conn.transaction().map_err(|e| format!("price tx: {e}"))?;
    let mut written = 0usize;
    for row in rows {
        if row.id.trim().is_empty() || row.product_id.trim().is_empty() {
            continue;
        }
        let changed = tx
            .execute(
                "INSERT INTO supplier_price_history
                   (id, product_id, product_name, supplier, invoice_no, unit_cost, quantity, batch_id, received_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO NOTHING",
                rusqlite::params![
                    row.id,
                    row.product_id,
                    row.product_name,
                    row.supplier,
                    row.invoice_no,
                    row.unit_cost.max(0),
                    row.quantity.max(0),
                    row.batch_id,
                    row.received_at
                ],
            )
            .map_err(|e| format!("price row: {e}"))?;
        written += changed;
    }
    tx.commit().map_err(|e| format!("price commit: {e}"))?;
    Ok(SupplierPriceReport { written })
}

#[tauri::command]
pub fn insert_stock_batch(
    app: tauri::AppHandle,
    request: StockBatchRequest,
) -> Result<StockBatchReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "insert_stock_batch",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            insert_stock_batch_core(&mut conn, &request).map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn insert_supplier_price_rows(
    app: tauri::AppHandle,
    rows: Vec<SupplierPriceRow>,
) -> Result<SupplierPriceReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "insert_supplier_price_rows",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            if rows.len() > 500 {
                return Err(TrustError::op_failed(
                    "insert_supplier_price_rows: batch too large",
                ));
            }
            let mut conn = open_db(&app)?;
            insert_supplier_price_rows_core(&mut conn, &rows).map_err(TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE stock_batches (batch_id TEXT PRIMARY KEY, product_id TEXT,
                quantity_remaining INTEGER, unit_cost REAL, freight_per_unit REAL, received_at TEXT,
                purchase_order_id TEXT, device_id TEXT, idempotency_key TEXT, sync_status TEXT,
                version INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT,
                deleted INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE supplier_price_history (id TEXT PRIMARY KEY, product_id TEXT,
                product_name TEXT, supplier TEXT, invoice_no TEXT, unit_cost INTEGER,
                quantity INTEGER, batch_id TEXT, received_at TEXT);
             CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT, last_error TEXT, updated_at TEXT);",
        )
        .expect("schema");
        conn
    }

    fn batch() -> StockBatchRequest {
        StockBatchRequest {
            batch_id: "B1".to_string(),
            product_id: "P1".to_string(),
            quantity_remaining: 5,
            unit_cost: 700.0,
            freight_per_unit: 0.0,
            received_at: "2026-11-05T08:00:00.000Z".to_string(),
            purchase_order_id: Some("PO1".to_string()),
            device_id: "dev".to_string(),
            idempotency_key: Some("sb-B1".to_string()),
            now: "2026-11-05T08:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn first_insert_commits_row_and_envelope_with_version_one() {
        let mut conn = seeded();
        let report = insert_stock_batch_core(&mut conn, &batch()).expect("insert");
        assert_eq!(report.version, 1);
        let (qty, po): (i64, String) = conn
            .query_row(
                "SELECT quantity_remaining, purchase_order_id FROM stock_batches WHERE batch_id='B1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(qty, 5);
        assert_eq!(po, "PO1");

        let (etype, payload): (String, String) = conn
            .query_row(
                "SELECT entity_type, payload_json FROM sync_outbox WHERE idempotency_key='sb-B1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(etype, "stock_batches");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["batch_id"], "B1");
    }

    #[test]
    fn a_retry_with_the_same_key_bumps_the_version_without_duplicating_the_envelope() {
        let mut conn = seeded();
        insert_stock_batch_core(&mut conn, &batch()).expect("first");
        let mut again = batch();
        again.quantity_remaining = 7;
        let report = insert_stock_batch_core(&mut conn, &again).expect("retry");
        assert_eq!(report.version, 2);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "one envelope per batch, not one per retry");
        let payload: String = conn
            .query_row("SELECT payload_json FROM sync_outbox", [], |r| r.get(0))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["version"], 2, "the envelope carries the committed clock");
        assert_eq!(parsed["quantity_remaining"], 7);
    }

    #[test]
    fn a_failing_envelope_rolls_the_batch_back() {
        let mut conn = seeded();
        conn.execute_batch("DROP TABLE sync_outbox;").unwrap();
        let err = insert_stock_batch_core(&mut conn, &batch()).expect_err("must roll back");
        assert!(err.contains("outbox"), "{err}");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM stock_batches", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    fn price_row(id: &str) -> SupplierPriceRow {
        SupplierPriceRow {
            id: id.to_string(),
            product_id: "P1".to_string(),
            product_name: Some("Phone".to_string()),
            supplier: "Sup".to_string(),
            invoice_no: Some("INV-1".to_string()),
            unit_cost: 650,
            quantity: 3,
            batch_id: Some("B1".to_string()),
            received_at: "2026-11-05T08:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn supplier_price_rows_are_idempotent_by_id() {
        let mut conn = seeded();
        let first = insert_supplier_price_rows_core(&mut conn, &[price_row("S1"), price_row("S2")])
            .expect("first");
        assert_eq!(first.written, 2);
        let retry = insert_supplier_price_rows_core(&mut conn, &[price_row("S1"), price_row("S2")])
            .expect("retry");
        assert_eq!(retry.written, 0, "a retried receipt appends nothing twice");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM supplier_price_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2);
    }
}

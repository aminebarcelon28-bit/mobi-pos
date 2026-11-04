//! Native product mirror lane (SEC-01 / ADR-005).
//!
//! `syncProductUpsertBulk` used to write the product row, then — conditionally —
//! a manual `inventory_ledger` ADJUST row, a stock recomputation and an opening
//! `stock_batches` row, plus their outbox envelopes. Four renderer writes for one
//! product, and a crash between them could leave stock without its ledger row.
//!
//! They now run in ONE native transaction. The renderer still owns the *reads*
//! (existing key/version, ledger sum, batch count), so the stock decision is
//! unchanged; this lane owns every write.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpeningBatch {
    pub quantity: i64,
    pub unit_cost: f64,
    pub purchase_order_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductUpsertRequest {
    pub id: String,
    pub sku: String,
    pub barcode: String,
    pub title: String,
    pub brand: String,
    pub category: String,
    pub price: f64,
    pub wholesale_price: f64,
    pub cost_price: f64,
    pub stock: i64,
    pub image_url: Option<String>,
    pub is_serialized: bool,
    pub imei_number: Option<String>,
    pub vendor_name: Option<String>,
    pub lead_time_days: i64,
    pub daily_sales_velocity: f64,
    pub reorder_point: i64,
    pub json_payload: String,
    pub device_id: String,
    pub idempotency_key: String,
    pub created_at: String,
    pub updated_at: String,
    pub version: i64,
    /// `wantStock - ledgerBaseline` when non-zero; the lane writes the ADJUST row.
    pub ledger_adjust: Option<i64>,
    /// Present when the product had no batch and `stock > 0`.
    pub opening_batch: Option<OpeningBatch>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProductUpsertReport {
    pub ledger_adjust: i64,
    pub batch_created: bool,
    pub batch_id: Option<String>,
    pub product_outbox: bool,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("product app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("product open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("product busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("product fk: {e}")))?;
    Ok(conn)
}

fn outbox_product(
    tx: &rusqlite::Transaction<'_>,
    key: &str,
    id: &str,
    payload: &str,
    now: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES (?1,'product',?2,'UPSERT',?3,'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=?4",
        rusqlite::params![key, id, payload, now],
    )
    .map_err(|e| format!("product outbox: {e}"))?;
    Ok(())
}

/// Row JSON for the product outbox envelope, bounded like `toBoundedSyncJson`
/// (64 KiB): a product row is small; the guard is a tripwire, not a truncator.
fn product_payload(req: &ProductUpsertRequest, stock: i64) -> Result<String, String> {
    let value = serde_json::json!({
        "id": req.id,
        "sku": req.sku,
        "barcode": req.barcode,
        "title": req.title,
        "brand": req.brand,
        "category": req.category,
        "price": req.price,
        "wholesale_price": req.wholesale_price,
        "cost_price": req.cost_price,
        "stock": stock,
        "image_url": req.image_url,
        "is_serialized": if req.is_serialized { 1 } else { 0 },
        "imei_number": req.imei_number,
        "vendor_name": req.vendor_name,
        "lead_time_days": req.lead_time_days,
        "daily_sales_velocity": req.daily_sales_velocity,
        "reorder_point": req.reorder_point,
        "json_payload": req.json_payload,
        "device_id": req.device_id,
        "idempotency_key": req.idempotency_key,
        "sync_status": "pending",
        "created_at": req.created_at,
        "updated_at": req.updated_at,
        "deleted": 0,
        "version": req.version,
    });
    let text = value.to_string();
    if text.len() > 64 * 1024 {
        return Err("product outbox payload exceeds 64 KiB".to_string());
    }
    Ok(text)
}

/// One product, one transaction: upsert, optional ledger ADJUST + stock
/// recompute, optional opening batch, outbox envelopes.
pub fn upsert_product_core(
    conn: &mut Connection,
    req: &ProductUpsertRequest,
) -> Result<ProductUpsertReport, String> {
    if req.id.trim().is_empty() {
        return Err("upsert_product: id required".to_string());
    }
    if req.json_payload.len() > 256 * 1024 {
        return Err("upsert_product: payload oversized".to_string());
    }
    let tx = conn.transaction().map_err(|e| format!("product tx: {e}"))?;
    let mut report = ProductUpsertReport::default();

    tx.execute(
        "INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price,
            cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
            daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key,
            sync_status, created_at, updated_at, deleted, version)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,'pending',?21,?22,0,?23)
         ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, barcode=excluded.barcode, title=excluded.title,
           brand=excluded.brand, category=excluded.category, price=excluded.price,
           wholesale_price=excluded.wholesale_price, cost_price=excluded.cost_price,
           image_url=excluded.image_url, is_serialized=excluded.is_serialized,
           imei_number=excluded.imei_number, vendor_name=excluded.vendor_name,
           lead_time_days=excluded.lead_time_days, daily_sales_velocity=excluded.daily_sales_velocity,
           reorder_point=excluded.reorder_point, json_payload=excluded.json_payload,
           updated_at=excluded.updated_at, sync_status='pending', deleted=0,
           version=excluded.version",
        rusqlite::params![
            req.id,
            req.sku,
            req.barcode,
            req.title,
            req.brand,
            req.category,
            req.price,
            req.wholesale_price,
            req.cost_price,
            req.stock,
            req.image_url,
            if req.is_serialized { 1 } else { 0 },
            req.imei_number,
            req.vendor_name,
            req.lead_time_days,
            req.daily_sales_velocity,
            req.reorder_point,
            req.json_payload,
            req.device_id,
            req.idempotency_key,
            req.created_at,
            req.updated_at,
            req.version
        ],
    )
    .map_err(|e| format!("product upsert: {e}"))?;

    if let Some(adjust) = req.ledger_adjust.filter(|d| *d != 0) {
        let ledger_id = uuid::Uuid::new_v4().to_string();
        let ledger_key = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
                idempotency_key, sync_status, created_at, updated_at, deleted)
             VALUES (?1,?2,?3,'ADJUST','manual',?2,?4,?5,'pending',?6,?6,0)",
            rusqlite::params![
                ledger_id,
                req.id,
                adjust,
                req.device_id,
                ledger_key,
                req.updated_at
            ],
        )
        .map_err(|e| format!("product ledger: {e}"))?;
        let payload = serde_json::json!({
            "id": ledger_id,
            "product_id": req.id,
            "delta": adjust,
            "reason": "ADJUST",
            "ref_type": "manual",
            "ref_id": req.id,
            "device_id": req.device_id,
            "idempotency_key": ledger_key,
        })
        .to_string();
        tx.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES (?1,'ledger',?2,'UPSERT',?3,'pending') ON CONFLICT(idempotency_key) DO NOTHING",
            rusqlite::params![ledger_key, ledger_id, payload],
        )
        .map_err(|e| format!("product ledger outbox: {e}"))?;
        tx.execute(
            "UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=?1 AND deleted=0), stock),
                updated_at=?2, sync_status='pending' WHERE id=?1",
            rusqlite::params![req.id, req.updated_at],
        )
        .map_err(|e| format!("product stock recompute: {e}"))?;
        report.ledger_adjust = adjust;
    }

    if let Some(batch) = &req.opening_batch {
        let batch_id = format!("batch-{}", uuid::Uuid::new_v4());
        let batch_key = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, freight_per_unit, received_at,
                purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
             VALUES (?1,?2,?3,?4,0,?5,?8,?6,?7,'pending',1,?5,?5,0)
             ON CONFLICT(batch_id) DO UPDATE SET quantity_remaining=excluded.quantity_remaining,
               version = version + 1,
               unit_cost=excluded.unit_cost, updated_at=excluded.updated_at, sync_status='pending'",
            rusqlite::params![
                batch_id,
                req.id,
                batch.quantity,
                batch.unit_cost,
                req.updated_at,
                req.device_id,
                batch_key,
                batch.purchase_order_id
            ],
        )
        .map_err(|e| format!("product opening batch: {e}"))?;
        let batch_version: i64 = tx
            .query_row(
                "SELECT COALESCE(version, 1) FROM stock_batches WHERE batch_id = ?1",
                rusqlite::params![batch_id],
                |r| r.get(0),
            )
            .unwrap_or(1);
        let payload = serde_json::json!({
            "version": batch_version,
            "batch_id": batch_id,
            "product_id": req.id,
            "quantity_remaining": batch.quantity,
            "unit_cost": batch.unit_cost,
            "received_at": req.updated_at,
            "purchase_order_id": batch.purchase_order_id,
            "device_id": req.device_id,
            "idempotency_key": batch_key,
            "updated_at": req.updated_at,
        })
        .to_string();
        tx.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES (?1,'stock_batches',?2,'UPSERT',?3,'pending')
             ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=?4",
            rusqlite::params![batch_key, batch_id, payload, req.updated_at],
        )
        .map_err(|e| format!("product batch outbox: {e}"))?;
        report.batch_created = true;
        report.batch_id = Some(batch_id);
    }

    // The product envelope carries the row as committed (stock may have moved).
    let stock_now: i64 = tx
        .query_row(
            "SELECT COALESCE(stock, 0) FROM products WHERE id = ?1",
            rusqlite::params![req.id],
            |r| r.get(0),
        )
        .unwrap_or(req.stock);
    let payload = product_payload(req, stock_now)?;
    outbox_product(&tx, &req.idempotency_key, &req.id, &payload, &req.updated_at)?;
    report.product_outbox = true;

    tx.commit().map_err(|e| format!("product commit: {e}"))?;
    Ok(report)
}

#[tauri::command]
pub fn upsert_product(
    app: tauri::AppHandle,
    request: ProductUpsertRequest,
) -> Result<ProductUpsertReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "upsert_product",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            upsert_product_core(&mut conn, &request).map_err(TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE products (
                id TEXT PRIMARY KEY, sku TEXT, barcode TEXT, title TEXT, brand TEXT, category TEXT,
                price REAL, wholesale_price REAL, cost_price REAL, stock INTEGER DEFAULT 0,
                image_url TEXT, is_serialized INTEGER DEFAULT 0, imei_number TEXT, vendor_name TEXT,
                lead_time_days INTEGER, daily_sales_velocity REAL, reorder_point INTEGER,
                json_payload TEXT, device_id TEXT, idempotency_key TEXT, sync_status TEXT,
                created_at TEXT, updated_at TEXT, deleted INTEGER DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE inventory_ledger (id TEXT PRIMARY KEY, product_id TEXT, delta INTEGER,
                reason TEXT, ref_type TEXT, ref_id TEXT, device_id TEXT, idempotency_key TEXT,
                sync_status TEXT, created_at TEXT, updated_at TEXT, deleted INTEGER DEFAULT 0);
             CREATE TABLE stock_batches (batch_id TEXT PRIMARY KEY, product_id TEXT,
                quantity_remaining INTEGER, unit_cost REAL, freight_per_unit REAL, received_at TEXT,
                purchase_order_id TEXT, device_id TEXT, idempotency_key TEXT, sync_status TEXT,
                version INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT,
                deleted INTEGER DEFAULT 0);
             CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
                operation TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_error TEXT, updated_at TEXT);",
        )
        .expect("schema");
        conn
    }

    fn req() -> ProductUpsertRequest {
        ProductUpsertRequest {
            id: "P1".to_string(),
            sku: "SKU-1".to_string(),
            barcode: "613".to_string(),
            title: "Phone".to_string(),
            brand: "Brand".to_string(),
            category: "Phones".to_string(),
            price: 1000.0,
            wholesale_price: 900.0,
            cost_price: 700.0,
            stock: 5,
            image_url: None,
            is_serialized: false,
            imei_number: None,
            vendor_name: None,
            lead_time_days: 7,
            daily_sales_velocity: 0.0,
            reorder_point: 5,
            json_payload: "{\"id\":\"P1\"}".to_string(),
            device_id: "dev".to_string(),
            idempotency_key: "pk-P1".to_string(),
            created_at: "2026-11-04T10:00:00.000Z".to_string(),
            updated_at: "2026-11-04T10:00:00.000Z".to_string(),
            version: 3,
            ledger_adjust: None,
            opening_batch: None,
        }
    }

    #[test]
    fn upsert_writes_one_product_and_its_envelope() {
        let mut conn = seeded();
        let report = upsert_product_core(&mut conn, &req()).expect("upsert");
        assert_eq!(report.ledger_adjust, 0);
        assert!(report.product_outbox);
        let (version, sync): (i64, String) = conn
            .query_row("SELECT version, sync_status FROM products WHERE id='P1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(version, 3);
        assert_eq!(sync, "pending");
        let (etype, payload): (String, String) = conn
            .query_row("SELECT entity_type, payload_json FROM sync_outbox", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(etype, "product");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["stock"], 5);
        assert_eq!(parsed["version"], 3);
    }

    #[test]
    fn ledger_adjust_and_stock_recompute_commit_together() {
        let mut conn = seeded();
        let mut r = req();
        r.ledger_adjust = Some(4);
        let report = upsert_product_core(&mut conn, &r).expect("adjust");
        assert_eq!(report.ledger_adjust, 4);
        let stock: i64 = conn
            .query_row("SELECT stock FROM products WHERE id='P1'", [], |x| x.get(0))
            .unwrap();
        assert_eq!(stock, 4, "stock is recomputed from the ledger");
        let (reason, delta): (String, i64) = conn
            .query_row("SELECT reason, delta FROM inventory_ledger", [], |x| {
                Ok((x.get(0)?, x.get(1)?))
            })
            .unwrap();
        assert_eq!(reason, "ADJUST");
        assert_eq!(delta, 4);
        let entities: Vec<String> = conn
            .prepare("SELECT entity_type FROM sync_outbox ORDER BY entity_type")
            .unwrap()
            .query_map([], |x| x.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(entities, vec!["ledger".to_string(), "product".to_string()]);
    }

    #[test]
    fn opening_batch_is_created_with_its_envelope() {
        let mut conn = seeded();
        let mut r = req();
        r.opening_batch = Some(OpeningBatch { quantity: 5, unit_cost: 700.0, purchase_order_id: "MATRIX_OPENING".to_string() });
        let report = upsert_product_core(&mut conn, &r).expect("batch");
        assert!(report.batch_created);
        let (qty, po): (i64, String) = conn
            .query_row("SELECT quantity_remaining, purchase_order_id FROM stock_batches", [], |x| {
                Ok((x.get(0)?, x.get(1)?))
            })
            .unwrap();
        assert_eq!(qty, 5);
        assert_eq!(po, "MATRIX_OPENING");
        let batch_outbox: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE entity_type='stock_batches'", [], |x| x.get(0))
            .unwrap();
        assert_eq!(batch_outbox, 1);
    }

    #[test]
    fn a_failing_envelope_write_rolls_the_product_back() {
        let mut conn = seeded();
        conn.execute_batch("DROP TABLE sync_outbox;").unwrap();
        let err = upsert_product_core(&mut conn, &req()).expect_err("must roll back");
        assert!(err.contains("outbox"), "{err}");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM products", [], |x| x.get(0))
            .unwrap();
        assert_eq!(rows, 0, "the product row is rolled back with its envelope");
    }
}

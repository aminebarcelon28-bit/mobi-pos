//! Tauri IPC engine for the PO-recon invariant sandwich.
//!
//! Adaptation notes (vs greenfield spec):
//! - No global `AppState<Mutex<Connection>>`: the live app DB is owned by
//!   `tauri-plugin-sql` (sqlx pool). These commands open a short-lived
//!   `rusqlite` WAL connection to the same `mobi_pos.db` file per invoke
//!   (WAL + `busy_timeout=5000` in `db.rs`), do their work transactionally,
//!   and close — no lock held across `.await`, no pool conflicts.
//! - `CommitItem.product_id` is TEXT (repo `products.id`), not INTEGER.
//! - Stock lands in existing FIFO `stock_batches` (one row per item, unique
//!   `batch_id`) + `inventory_ledger` (`RECEIVE` deltas), grouped by a shared
//!   `purchase_order_id` trace id. `products.stock` increments;
//!   `products.cost_price` follows the catalog REFERENCE rule (first-known
//!   wins — see `resolveReferenceCost`): only initialized when currently
//!   missing/zero, never repriced per receipt.
//! - Any validation failure (e.g. `quantity <= 0`, unknown product) aborts
//!   before commit → whole transaction rolls back, zero partial rows
//!   (acceptance §11.3).

use crate::db::{ensure_po_recon_tables, register_vec_extension};
use crate::gate::{evaluate_invoice_invariants, InvariantReport};
use crate::geometry::{ExtractedDocumentSummary, OcrBoundingBox, SpatialLayoutParser};
use crate::resolver::{InventoryResolver, ResolvedPoLine};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::Manager;

fn resolver() -> &'static InventoryResolver {
    static CELL: OnceLock<InventoryResolver> = OnceLock::new();
    CELL.get_or_init(InventoryResolver::new)
}

fn parser() -> &'static SpatialLayoutParser {
    static CELL: OnceLock<SpatialLayoutParser> = OnceLock::new();
    CELL.get_or_init(SpatialLayoutParser::new)
}

fn open_live_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    register_vec_extension();
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = dir.join("mobi_pos.db");
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    ensure_po_recon_tables(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn now_iso() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| {
            // Seconds precision is enough for ledger grouping; ISO-ish.
            format!("{}", d.as_secs())
        })
        .unwrap_or_else(|_| "0".into())
}

// ---------------------------------------------------------------------------
// process_raw_scan
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ProcessRawScanRequest {
    pub supplier_name: String,
    pub bounding_boxes: Vec<OcrBoundingBox>,
    pub reported_tax: f64,
    pub reported_freight: f64,
    pub reported_grand_total: f64,
}

#[derive(Debug, Serialize)]
pub struct ProcessRawScanResponse {
    pub invariant_report: InvariantReport,
    pub resolved_lines: Vec<ResolvedPoLine>,
    pub document_summary: ExtractedDocumentSummary,
}

fn process_scan_inner(
    conn: &Connection,
    req: &ProcessRawScanRequest,
) -> Result<ProcessRawScanResponse, String> {
    // Step 0: Ensure active catalog products are indexed in vec_products
    let _ = resolver().ensure_products_indexed(conn);

    // Step 1: Reconstruct physical table structure and extract document summary
    let parsed_doc = parser().parse_document(req.bounding_boxes.clone());
    let extracted_rows = parsed_doc.rows;
    let document_summary = parsed_doc.summary;

    if extracted_rows.is_empty() {
        return Err("No legible tabular rows detected from scan geometry.".into());
    }

    // Step 2: Determine effective accounting targets
    let effective_tax = if req.reported_tax > 0.0 {
        req.reported_tax
    } else {
        document_summary.detected_tax.unwrap_or(0.0)
    };

    let effective_freight = if req.reported_freight > 0.0 {
        req.reported_freight
    } else {
        document_summary.detected_freight.unwrap_or(0.0)
    };

    let calculated_subtotal: f64 = extracted_rows.iter().map(|r| r.line_total).sum();
    let calculated_total =
        ((calculated_subtotal + effective_tax + effective_freight) * 100.0).round() / 100.0;

    let effective_grand_total = if req.reported_grand_total > 0.0 {
        req.reported_grand_total
    } else if let Some(gt) = document_summary.detected_grand_total {
        if gt > 0.0 {
            gt
        } else {
            calculated_total
        }
    } else {
        calculated_total
    };

    // Step 3: Validate invoice accounting
    let math_tuples: Vec<(f64, f64, f64)> = extracted_rows
        .iter()
        .map(|r| (r.quantity, r.unit_cost, r.line_total))
        .collect();

    let invariant_report = evaluate_invoice_invariants(
        &math_tuples,
        effective_tax,
        effective_freight,
        effective_grand_total,
    );

    // Step 4: Run multi-tier entity resolution
    let effective_supplier = if !req.supplier_name.trim().is_empty() {
        &req.supplier_name
    } else if let Some(ref sup) = document_summary.detected_supplier {
        sup
    } else {
        "Fournisseur Inconnu"
    };

    let mut resolved_lines = Vec::new();
    for row in extracted_rows {
        let res = resolver()
            .resolve_line(
                conn,
                effective_supplier,
                &row.description,
                row.extracted_barcode.as_deref(),
                row.quantity,
                row.unit_cost,
                row.line_total,
            )
            .map_err(|e| e.to_string())?;
        resolved_lines.push(res);
    }

    Ok(ProcessRawScanResponse {
        invariant_report,
        resolved_lines,
        document_summary,
    })
}

#[tauri::command]
pub fn po_process_raw_scan(
    app: tauri::AppHandle,
    request: ProcessRawScanRequest,
) -> Result<ProcessRawScanResponse, String> {
    let conn = open_live_db(&app)?;
    process_scan_inner(&conn, &request)
}

// ---------------------------------------------------------------------------
// commit_stock_batch (atomic)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CommitItem {
    pub product_id: String,
    pub quantity: f64,
    pub unit_cost: f64,
    pub raw_supplier_name: String,
    pub save_as_alias: bool,
}

#[derive(Debug, Deserialize)]
pub struct CommitStockBatchRequest {
    pub supplier_name: String,
    pub items: Vec<CommitItem>,
    pub user_id: Option<String>,
}

fn commit_batch_inner(conn: &mut Connection, payload: &CommitStockBatchRequest) -> Result<usize, String> {
    if payload.items.is_empty() {
        return Err("Cannot commit empty inventory payload.".into());
    }

    let group_id = uuid::Uuid::new_v4().to_string();
    let ts = now_iso();

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    {
        let mut insert_batch = tx
            .prepare(
                r#"
                INSERT INTO stock_batches
                  (batch_id, product_id, quantity_remaining, unit_cost, received_at,
                   purchase_order_id, device_id, idempotency_key, sync_status, version, deleted)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'local', ?7, 'pending', 1, 0)
                "#,
            )
            .map_err(|e| e.to_string())?;

        let mut insert_ledger = tx
            .prepare(
                r#"
                INSERT INTO inventory_ledger
                  (id, product_id, delta, reason, ref_type, ref_id, device_id,
                   idempotency_key, sync_status, version, deleted)
                VALUES (?1, ?2, ?3, 'RECEIVE', 'po_recon', ?4, 'local', ?5, 'pending', 1, 0)
                "#,
            )
            .map_err(|e| e.to_string())?;

        // Reference-cost rule: only initialize when the catalog has no cost yet.
        let mut bump_stock = tx
            .prepare(
                r#"
                UPDATE products
                SET stock = stock + ?1,
                    cost_price = CASE WHEN COALESCE(cost_price, 0) > 0 THEN cost_price ELSE ?2 END,
                    updated_at = ?3
                WHERE id = ?4 AND COALESCE(deleted, 0) = 0
                "#,
            )
            .map_err(|e| e.to_string())?;

        let mut insert_alias = tx
            .prepare(
                r#"
                INSERT OR REPLACE INTO vendor_aliases (supplier_name, raw_vendor_name, product_id)
                VALUES (?1, ?2, ?3)
                "#,
            )
            .map_err(|e| e.to_string())?;

        for item in &payload.items {
            if !item.quantity.is_finite() || item.quantity <= 0.0 {
                return Err(format!(
                    "Invalid non-positive quantity for product {}",
                    item.product_id
                ));
            }
            if !item.unit_cost.is_finite() || item.unit_cost < 0.0 {
                return Err(format!(
                    "Invalid negative unit cost for product {}",
                    item.product_id
                ));
            }
            // Whole-unit ledger: accessories are discrete; fractional scans round.
            let whole = item.quantity.round() as i64;
            if whole <= 0 {
                return Err(format!(
                    "Quantity rounds to zero for product {}",
                    item.product_id
                ));
            }

            let batch_id = uuid::Uuid::new_v4().to_string();
            let ledger_id = uuid::Uuid::new_v4().to_string();

            insert_batch
                .execute(params![
                    batch_id,
                    item.product_id,
                    item.quantity,
                    item.unit_cost,
                    ts,
                    group_id,
                    format!("po-recon-{batch_id}"),
                ])
                .map_err(|e| e.to_string())?;

            insert_ledger
                .execute(params![
                    ledger_id,
                    item.product_id,
                    whole,
                    group_id,
                    format!("po-recon-{ledger_id}"),
                ])
                .map_err(|e| e.to_string())?;

            let rows_affected = bump_stock
                .execute(params![whole, item.unit_cost, ts, item.product_id])
                .map_err(|e| e.to_string())?;

            if rows_affected == 0 {
                return Err(format!(
                    "Active product {} not found in catalog.",
                    item.product_id
                ));
            }

            if item.save_as_alias {
                insert_alias
                    .execute(params![
                        payload.supplier_name,
                        item.raw_supplier_name,
                        item.product_id
                    ])
                    .map_err(|e| e.to_string())?;
            }
        }

        let mut insert_audit = tx
            .prepare(
                r#"
                INSERT INTO scan_audit_log
                  (trace_id, user_id, supplier_name, items_count, grand_total, delta, is_balanced, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, 0.0, 1, ?6)
                "#,
            )
            .map_err(|e| e.to_string())?;

        let total_val: f64 = payload.items.iter().map(|i| i.quantity * i.unit_cost).sum();
        insert_audit
            .execute(params![
                group_id,
                payload.user_id,
                payload.supplier_name,
                payload.items.len() as i64,
                total_val,
                ts,
            ])
            .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(payload.items.len())
}

#[tauri::command]
pub fn po_commit_stock_batch(
    app: tauri::AppHandle,
    payload: CommitStockBatchRequest,
) -> Result<usize, String> {
    let mut conn = open_live_db(&app)?;
    commit_batch_inner(&mut conn, &payload)
}

/// Back-compat aliases matching the spec's command names (`process_raw_scan`,
/// `commit_stock_batch`). The canonical names are `po_*` (namespaced to avoid
/// collisions with future generic commands).
#[tauri::command]
pub fn process_raw_scan(
    app: tauri::AppHandle,
    request: ProcessRawScanRequest,
) -> Result<ProcessRawScanResponse, String> {
    po_process_raw_scan(app, request)
}

#[tauri::command]
pub fn commit_stock_batch(
    app: tauri::AppHandle,
    payload: CommitStockBatchRequest,
) -> Result<usize, String> {
    po_commit_stock_batch(app, payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{ensure_po_recon_tables, register_vec_extension};

    fn open_test_db() -> Connection {
        register_vec_extension();
        let mut conn = Connection::open_in_memory().expect("in-memory open");
        conn.execute_batch(
            r#"
            CREATE TABLE products (
                id TEXT PRIMARY KEY, sku TEXT NOT NULL, barcode TEXT NOT NULL,
                title TEXT NOT NULL, cost_price REAL DEFAULT 0,
                stock INTEGER DEFAULT 0, updated_at TEXT DEFAULT '',
                deleted INTEGER DEFAULT 0
            );
            CREATE TABLE stock_batches (
                batch_id TEXT PRIMARY KEY,
                product_id TEXT NOT NULL REFERENCES products(id),
                quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
                unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
                received_at TEXT NOT NULL,
                purchase_order_id TEXT,
                device_id TEXT NOT NULL DEFAULT 'local',
                idempotency_key TEXT NOT NULL UNIQUE,
                sync_status TEXT NOT NULL DEFAULT 'pending',
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE inventory_ledger (
                id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
                delta INTEGER NOT NULL, reason TEXT NOT NULL,
                ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                sync_status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                deleted INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1
            );
            "#,
        )
        .unwrap();
        ensure_po_recon_tables(&conn).unwrap();
        let _ = &mut conn;
        conn
    }

    /// Acceptance §11.3: 3 valid rows + 1 invalid (quantity -5) → error +
    /// ZERO rows persisted (full rollback).
    #[test]
    fn test_commit_rollback_on_invalid_row() {
        let mut conn = open_test_db();
        for (id, sku) in [("p1", "SKU1"), ("p2", "SKU2"), ("p3", "SKU3")] {
            conn.execute(
                "INSERT INTO products(id, sku, barcode, title) VALUES (?1, ?2, ?3, ?4)",
                params![id, sku, format!("BC-{id}"), format!("Product {id}")],
            )
            .unwrap();
        }
        let payload = CommitStockBatchRequest {
            supplier_name: "ACME".into(),
            items: vec![
                CommitItem { product_id: "p1".into(), quantity: 2.0, unit_cost: 10.0, raw_supplier_name: "Widget A".into(), save_as_alias: true },
                CommitItem { product_id: "p2".into(), quantity: 1.0, unit_cost: 5.0, raw_supplier_name: "Widget B".into(), save_as_alias: false },
                CommitItem { product_id: "p3".into(), quantity: 3.0, unit_cost: 7.0, raw_supplier_name: "Widget C".into(), save_as_alias: false },
                CommitItem { product_id: "p1".into(), quantity: -5.0, unit_cost: 10.0, raw_supplier_name: "Widget A".into(), save_as_alias: false },
            ],
            user_id: Some("user-test".into()),
        };
        let err = commit_batch_inner(&mut conn, &payload).expect_err("must reject negative qty");
        assert!(err.contains("non-positive") || err.contains("rounds to zero"), "{err}");

        let batches: i64 = conn
            .query_row("SELECT count(*) FROM stock_batches", [], |r| r.get(0))
            .unwrap();
        let ledger: i64 = conn
            .query_row("SELECT count(*) FROM inventory_ledger", [], |r| r.get(0))
            .unwrap();
        let aliases: i64 = conn
            .query_row("SELECT count(*) FROM vendor_aliases", [], |r| r.get(0))
            .unwrap();
        let audits: i64 = conn
            .query_row("SELECT count(*) FROM scan_audit_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!((batches, ledger, aliases, audits), (0, 0, 0, 0), "rollback must leave zero rows");

        let stock: i64 = conn
            .query_row("SELECT stock FROM products WHERE id='p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stock, 0);
    }

    #[test]
    fn test_commit_happy_path_and_reference_cost() {
        let mut conn = open_test_db();
        conn.execute(
            "INSERT INTO products(id, sku, barcode, title, cost_price, stock) VALUES ('p1','SKU1','BC1','Widget',400.0,5)",
            [],
        )
        .unwrap();
        let payload = CommitStockBatchRequest {
            supplier_name: "ACME".into(),
            items: vec![CommitItem {
                product_id: "p1".into(),
                quantity: 2.0,
                unit_cost: 500.0, // must NOT reprice the 400 reference
                raw_supplier_name: "Widget v2".into(),
                save_as_alias: true,
            }],
            user_id: Some("cashier-1".into()),
        };
        assert_eq!(commit_batch_inner(&mut conn, &payload).unwrap(), 1);
        let (stock, cost): (i64, f64) = conn
            .query_row("SELECT stock, cost_price FROM products WHERE id='p1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(stock, 7);
        assert!((cost - 400.0).abs() < 1e-9, "reference cost frozen, got {cost}");
        let alias: i64 = conn
            .query_row("SELECT count(*) FROM vendor_aliases", [], |r| r.get(0))
            .unwrap();
        assert_eq!(alias, 1);
        let audit: i64 = conn
            .query_row("SELECT count(*) FROM scan_audit_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(audit, 1);
    }
}

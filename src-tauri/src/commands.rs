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
use crate::trust_core::{
    audit_append::chrono_iso8601_utc,
    capability_policy::Capability,
    ipc_authorizer::{authorize_and_execute, global_kernel, TrustError},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
    let db_path = crate::e2e::live_db_path(&dir);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    crate::db::tune(&conn).map_err(|e| e.to_string())?;
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
    // Phase 1b-i (Addendum B): no `reported_tax` — the field is removed from
    // the request contract, not kept optional.
    pub reported_freight: f64,
    pub reported_grand_total: f64,
}

#[derive(Debug, Serialize)]
pub struct ProcessRawScanResponse {
    pub invariant_report: InvariantReport,
    pub resolved_lines: Vec<ResolvedPoLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_summary: Option<ExtractedDocumentSummary>,
}

fn process_scan_inner(
    conn: &Connection,
    req: &ProcessRawScanRequest,
) -> Result<ProcessRawScanResponse, String> {
    let safe_supplier = req.supplier_name.trim();
    let sanitized_supplier = if safe_supplier.is_empty() {
        "Fournisseur Inconnu"
    } else if safe_supplier.len() > 255 {
        &safe_supplier[..255]
    } else {
        safe_supplier
    };

    let mut boxes = req.bounding_boxes.clone();
    if boxes.is_empty() {
        return Err("Aucun bloc de texte ou tableau détecté sur le document.".into());
    }
    if boxes.len() > 5000 {
        boxes.truncate(5000);
    }

    // Step 1: Reconstruct physical table structure and extract document metadata
    let parsed_doc = parser().parse_document(boxes);
    let extracted_rows = parsed_doc.rows;
    let document_summary = Some(parsed_doc.summary);

    if extracted_rows.is_empty() {
        return Err("Aucune ligne d'article lisible n'a pu être extraite du scan.".into());
    }

    // Step 2: Validate invoice accounting
    let math_tuples: Vec<(f64, f64, f64)> = extracted_rows
        .iter()
        .map(|r| (r.quantity, r.unit_cost, r.line_total))
        .collect();

    let invariant_report = evaluate_invoice_invariants(
        &math_tuples,
        req.reported_freight,
        req.reported_grand_total,
    );

    // Step 3: Run multi-tier entity resolution
    let mut resolved_lines = Vec::new();
    for row in extracted_rows {
        let res = resolver()
            .resolve_line(
                conn,
                sanitized_supplier,
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
) -> Result<ProcessRawScanResponse, TrustError> {
    authorize_and_execute(
        "po_process_raw_scan",
        Capability::OperationalWrites,
        |_| {
            let conn = open_live_db(&app).map_err(TrustError::op_failed)?;
            process_scan_inner(&conn, &request).map_err(TrustError::op_failed)
        },
    )
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
    #[serde(default)]
    pub user_id: Option<String>,
}

fn commit_batch_inner(
    conn: &mut Connection,
    payload: &CommitStockBatchRequest,
    entry_generation: u64,
) -> Result<usize, TrustError> {
    if payload.items.is_empty() {
        return Err(TrustError::IPCProtocolError {
            reason: "empty inventory payload",
        });
    }

    let group_id = uuid::Uuid::new_v4().to_string();
    let ts = now_iso();
    // ISO-8601 UTC stamp for human/audit `created_at` columns. The table
    // DEFAULTs are the legacy space-separated `datetime('now','utc')` form
    // (kept byte-identical: migration bodies are checksummed), so every
    // native write stamps explicitly instead of relying on the default.
    let created_iso = chrono_iso8601_utc();

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
                    version = version + 1,
                    sync_status = 'pending',
                    updated_at = ?3
                WHERE id = ?4 AND COALESCE(deleted, 0) = 0
                "#,
            )
            .map_err(|e| e.to_string())?;

        let mut insert_outbox = tx
            .prepare(
                r#"
                INSERT INTO sync_outbox
                  (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at)
                VALUES (?1, ?2, ?3, 'UPSERT', ?4, 'pending', ?5, ?5)
                ON CONFLICT(idempotency_key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  status = 'pending',
                  updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| e.to_string())?;

        let mut insert_alias = tx
            .prepare(
                r#"
                INSERT OR REPLACE INTO vendor_aliases (supplier_name, raw_vendor_name, product_id, created_at)
                VALUES (?1, ?2, ?3, ?4)
                "#,
            )
            .map_err(|e| e.to_string())?;

        for item in &payload.items {
            if !item.quantity.is_finite() || item.quantity <= 0.0 {
                return Err(TrustError::op_failed(format!(
                    "Invalid non-positive quantity for product {}",
                    item.product_id
                )));
            }
            if !item.unit_cost.is_finite() || item.unit_cost < 0.0 {
                return Err(TrustError::op_failed(format!(
                    "Invalid negative unit cost for product {}",
                    item.product_id
                )));
            }
            // Whole-unit ledger: accessories are discrete; fractional scans round.
            let whole = item.quantity.round() as i64;
            if whole <= 0 {
                return Err(TrustError::op_failed(format!(
                    "Quantity rounds to zero for product {}",
                    item.product_id
                )));
            }

            let batch_id = uuid::Uuid::new_v4().to_string();
            let ledger_id = uuid::Uuid::new_v4().to_string();
            let batch_key = format!("po-recon-{batch_id}");
            let ledger_key = format!("po-recon-{ledger_id}");

            insert_batch
                .execute(params![
                    batch_id,
                    item.product_id,
                    item.quantity,
                    item.unit_cost,
                    ts,
                    group_id,
                    batch_key,
                ])
                .map_err(|e| e.to_string())?;

            insert_ledger
                .execute(params![
                    ledger_id,
                    item.product_id,
                    whole,
                    group_id,
                    ledger_key,
                ])
                .map_err(|e| e.to_string())?;

            let rows_affected = bump_stock
                .execute(params![whole, item.unit_cost, ts, item.product_id])
                .map_err(|e| e.to_string())?;

            if rows_affected == 0 {
                return Err(TrustError::op_failed(format!(
                    "Active product {} not found in catalog.",
                    item.product_id
                )));
            }

            // Sync outbox entries
            let batch_payload = serde_json::json!({
                "version": 1,
                "batch_id": batch_id,
                "product_id": item.product_id,
                "quantity_remaining": item.quantity,
                "unit_cost": item.unit_cost,
                "received_at": ts,
                "purchase_order_id": group_id,
                "device_id": "local",
                "idempotency_key": batch_key,
            });
            insert_outbox
                .execute(params![
                    batch_key,
                    "stock_batches",
                    batch_id,
                    batch_payload.to_string(),
                    created_iso,
                ])
                .map_err(|e| e.to_string())?;

            let ledger_payload = serde_json::json!({
                "id": ledger_id,
                "product_id": item.product_id,
                "delta": whole,
                "reason": "RECEIVE",
                "ref_type": "po_recon",
                "ref_id": group_id,
                "device_id": "local",
                "idempotency_key": ledger_key,
            });
            insert_outbox
                .execute(params![
                    ledger_key,
                    "ledger",
                    ledger_id,
                    ledger_payload.to_string(),
                    created_iso,
                ])
                .map_err(|e| e.to_string())?;

            let prod_version: i64 = tx
                .query_row(
                    "SELECT version FROM products WHERE id = ?1",
                    params![item.product_id],
                    |r| r.get(0),
                )
                .unwrap_or(1);
            let prod_payload = serde_json::json!({
                "id": item.product_id,
                "version": prod_version,
            });
            let prod_key = format!("po-recon-prod-{}-{}", item.product_id, group_id);
            insert_outbox
                .execute(params![
                    prod_key,
                    "product",
                    item.product_id,
                    prod_payload.to_string(),
                    created_iso,
                ])
                .map_err(|e| e.to_string())?;

            if item.save_as_alias {
            insert_alias
                .execute(params![
                    payload.supplier_name,
                    item.raw_supplier_name,
                    item.product_id,
                    created_iso
                ])
                .map_err(|e| e.to_string())?;
            }
        }

        let items_count = payload.items.len() as i64;
        let total_cost: f64 = payload
            .items
            .iter()
            .map(|it| it.quantity * it.unit_cost)
            .sum();

        tx.execute(
            r#"
            INSERT INTO scan_audit_log
              (trace_id, user_id, supplier_name, items_count, grand_total, delta, is_balanced, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 0.0, 1, ?6)
            "#,
            params![
                group_id,
                payload.user_id,
                payload.supplier_name,
                items_count,
                total_cost,
                created_iso,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // B.5: re-verify the kernel generation immediately before persisting. A
    // license transition that landed mid-batch aborts instead of committing
    // under stale authority (returns TerminalLocked, nothing persisted).
    global_kernel().ensure_generation_unchanged(entry_generation)?;

    tx.commit().map_err(|e| e.to_string())?;

    // UPGRADE-03: keep the semantic index warm for products this receipt
    // touched. Suggestions-only surface: an indexing failure is logged and
    // swallowed — an advisory index must never fail a committed receipt.
    let mut indexed_products: HashSet<&str> = HashSet::new();
    for item in &payload.items {
        if !indexed_products.insert(item.product_id.as_str()) {
            continue;
        }
        let fields: Option<(String, String, String)> = conn
            .query_row(
                "SELECT title, COALESCE(brand, ''), COALESCE(compatible_model, '') \
                 FROM products WHERE id = ?1 AND COALESCE(deleted, 0) = 0",
                params![item.product_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .unwrap_or(None);
        if let Some((title, brand, compat)) = fields {
            let composed = compose_index_text(&title, &brand, &compat);
            if !composed.is_empty() {
                if let Err(err) = resolver().index_product(conn, &item.product_id, &composed) {
                    eprintln!("[vec] product {} index skipped: {err}", item.product_id);
                }
            }
        }
    }

    Ok(payload.items.len())
}

#[tauri::command]
pub fn po_commit_stock_batch(
    app: tauri::AppHandle,
    payload: CommitStockBatchRequest,
) -> Result<usize, TrustError> {
    authorize_and_execute(
        "po_commit_stock_batch",
        Capability::OperationalWrites,
        |ctx| {
            let mut conn = open_live_db(&app).map_err(TrustError::op_failed)?;
            commit_batch_inner(&mut conn, &payload, ctx.generation)
        },
    )
}

/// Back-compat aliases matching the spec's command names (`process_raw_scan`,
/// `commit_stock_batch`). The canonical names are `po_*` (namespaced to avoid
/// collisions with future generic commands).
#[tauri::command]
pub fn process_raw_scan(
    app: tauri::AppHandle,
    request: ProcessRawScanRequest,
) -> Result<ProcessRawScanResponse, TrustError> {
    po_process_raw_scan(app, request)
}

#[tauri::command]
pub fn commit_stock_batch(
    app: tauri::AppHandle,
    payload: CommitStockBatchRequest,
) -> Result<usize, TrustError> {
    po_commit_stock_batch(app, payload)
}

// ---------------------------------------------------------------------------
// UPGRADE-03 — semantic accessory suggestions (sqlite-vec Tier-2, advisory)
// ---------------------------------------------------------------------------

/// Advisory suggestion row: a catalog neighbor of the cart's seed product.
/// Suggestions are display-only — the native side NEVER applies them to a
/// cart or a sale; only an explicit operator tap on the UI chip does.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessorySuggestion {
    pub id: String,
    pub sku: String,
    pub title: String,
    pub price: f64,
    pub stock: f64,
    pub distance: f64,
}

/// The composition indexed into `vec_products` — the SAME string is embedded
/// for the seed product at suggestion time, so self-similarity is maximal.
fn compose_index_text(title: &str, brand: &str, compatible_model: &str) -> String {
    let mut parts: Vec<&str> = Vec::with_capacity(3);
    for part in [title, brand, compatible_model] {
        let trimmed = part.trim();
        if !trimmed.is_empty() {
            parts.push(trimmed);
        }
    }
    parts.join(" ")
}

/// Advisory threshold: with the deterministic fallback embeddings, related
/// accessories land well under this; orthogonal strings sit near 1.0. The
/// cut only filters noise — it never gates a sale path.
const SUGGESTION_MAX_DISTANCE: f64 = 0.9;

fn suggest_inner(
    conn: &Connection,
    seed_product_id: &str,
    k: u32,
) -> Result<Vec<AccessorySuggestion>, TrustError> {
    let k = k.clamp(1, 8) as usize;
    if seed_product_id.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Nothing indexed yet → no suggestions. The latched catalog rebuild
    // (`vec_reindex_catalog`) fills the index; suggesting without index rows
    // would be fabrication, not recall.
    let indexed: i64 = conn
        .query_row("SELECT COUNT(*) FROM vec_products", [], |r| r.get(0))
        .unwrap_or(0);
    if indexed == 0 {
        return Ok(Vec::new());
    }

    let seed_fields: Option<(String, String, String)> = conn
        .query_row(
            "SELECT title, COALESCE(brand, ''), COALESCE(compatible_model, '') \
             FROM products WHERE id = ?1 AND COALESCE(deleted, 0) = 0",
            params![seed_product_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| TrustError::op_failed(e.to_string()))?;
    let Some((title, brand, compat)) = seed_fields else {
        return Ok(Vec::new());
    };
    let seed_text = compose_index_text(&title, &brand, &compat);
    if seed_text.is_empty() {
        return Ok(Vec::new());
    }

    let vector = resolver().embed_string(&seed_text);
    debug_assert_eq!(vector.len(), 384);
    let query_bytes: &[u8] = bytemuck::cast_slice(&vector);

    // KNN (fetch k+1 so the seed itself can be dropped without shrinking the
    // result), then a lookup per hit — same two-step shape as `resolve_line`
    // (no virtual-table JOINs).
    let fetch_k = (k + 1) as i64;
    let knn_rows: Vec<(String, f64)> = {
        let mut stmt = conn
            .prepare(
                r#"
                SELECT product_tid, distance
                FROM vec_products
                WHERE embedding MATCH ?1 AND k = ?2
                ORDER BY distance
                "#,
            )
            .map_err(|e| TrustError::op_failed(e.to_string()))?;
        let mapped = stmt
            .query_map(params![query_bytes, fetch_k], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
            })
            .map_err(|e| TrustError::op_failed(e.to_string()))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| TrustError::op_failed(e.to_string()))?
    };

    let mut out: Vec<AccessorySuggestion> = Vec::with_capacity(k);
    for (tid, distance) in knn_rows {
        if tid == seed_product_id || distance > SUGGESTION_MAX_DISTANCE {
            continue;
        }
        let found: Option<AccessorySuggestion> = conn
            .query_row(
                "SELECT sku, title, price, stock FROM products \
                 WHERE id = ?1 AND COALESCE(deleted, 0) = 0",
                params![tid],
                |r| {
                    Ok(AccessorySuggestion {
                        id: tid.clone(),
                        sku: r.get(0)?,
                        title: r.get(1)?,
                        price: r.get(2)?,
                        stock: r.get(3)?,
                        distance,
                    })
                },
            )
            .optional()
            .map_err(|e| TrustError::op_failed(e.to_string()))?;
        if let Some(found) = found {
            out.push(found);
        }
        if out.len() >= k {
            break;
        }
    }
    Ok(out)
}

/// One-shot catalog rebuild (latched; `force` re-runs it after bulk imports).
/// Idempotent: every product upserts by `product_tid`. The latch lives in
/// `app_settings` (best-effort — a lost latch only costs one extra pass).
fn reindex_catalog_inner(conn: &Connection, force: bool) -> Result<usize, TrustError> {
    if !force {
        let latched: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM app_settings WHERE key = 'vec_index.backfill.v1' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);
        if latched.is_some() {
            return Ok(0);
        }
    }

    let mut total = 0usize;
    let mut last_id = String::new();
    loop {
        let rows: Vec<(String, String, String, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, title, COALESCE(brand, ''), COALESCE(compatible_model, '') \
                     FROM products WHERE COALESCE(deleted, 0) = 0 AND id > ?1 \
                     ORDER BY id LIMIT 500",
                )
                .map_err(|e| TrustError::op_failed(e.to_string()))?;
            let mapped = stmt
                .query_map(params![last_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .map_err(|e| TrustError::op_failed(e.to_string()))?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| TrustError::op_failed(e.to_string()))?
        };
        if rows.is_empty() {
            break;
        }
        for (id, title, brand, compat) in &rows {
            let text = compose_index_text(title, brand, compat);
            if text.is_empty() {
                continue;
            }
            resolver()
                .index_product(conn, id, &text)
                .map_err(|e| TrustError::op_failed(e.to_string()))?;
            total += 1;
        }
        let last = rows.last().map(|r| r.0.clone()).unwrap_or_default();
        let exhausted = rows.len() < 500;
        last_id = last;
        if exhausted {
            break;
        }
    }

    // Latch, best-effort, shape-tolerant (`id` presence decides the column
    // set; DELETE+INSERT avoids depending on a UNIQUE constraint).
    let now = chrono_iso8601_utc();
    let latch_value = serde_json::json!({ "done": true, "indexed": total }).to_string();
    let has_id_col: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('app_settings') WHERE name = 'id'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let latch_result = if has_id_col > 0 {
        let _ = conn.execute(
            "DELETE FROM app_settings WHERE id = 'vec_index.backfill.v1' OR key = 'vec_index.backfill.v1'",
            [],
        );
        conn.execute(
            "INSERT INTO app_settings (id, key, value_json, updated_at, version) \
             VALUES ('vec_index.backfill.v1', 'vec_index.backfill.v1', ?1, ?2, 1)",
            params![latch_value, now],
        )
    } else {
        let _ = conn.execute(
            "DELETE FROM app_settings WHERE key = 'vec_index.backfill.v1'",
            [],
        );
        conn.execute(
            "INSERT INTO app_settings (key, value_json, updated_at, version) \
             VALUES ('vec_index.backfill.v1', ?1, ?2, 1)",
            params![latch_value, now],
        )
    };
    let _ = latch_result;

    Ok(total)
}

/// Advisory accessory suggestions for the cart's seed product. Read-only:
/// opening the DB also ensures the lazily-created vec table exists.
#[tauri::command]
pub fn checkout_suggest_accessories(
    app: tauri::AppHandle,
    seed_product_id: String,
    k: Option<u32>,
) -> Result<Vec<AccessorySuggestion>, TrustError> {
    authorize_and_execute(
        "checkout_suggest_accessories",
        Capability::ReadOperationalData,
        |_ctx| {
            let conn = open_live_db(&app).map_err(TrustError::op_failed)?;
            suggest_inner(&conn, &seed_product_id, k.unwrap_or(4))
        },
    )
}

/// (Re-)index one product: `name` = title‖brand‖compat (empty = remove).
/// Called on catalog save/delete; also covers renames in one shot.
#[tauri::command]
pub fn vec_index_product(
    app: tauri::AppHandle,
    product_id: String,
    name: String,
) -> Result<(), TrustError> {
    authorize_and_execute("vec_index_product", Capability::OperationalWrites, |_ctx| {
        let conn = open_live_db(&app).map_err(TrustError::op_failed)?;
        if name.trim().is_empty() {
            conn.execute(
                "DELETE FROM vec_products WHERE product_tid = ?1",
                params![product_id],
            )
            .map_err(|e| TrustError::op_failed(e.to_string()))?;
            return Ok(());
        }
        resolver()
            .index_product(&conn, &product_id, &name)
            .map_err(|e| TrustError::op_failed(e.to_string()))?;
        Ok(())
    })
}

/// Latched catalog rebuild for existing installs (`force` after bulk import).
#[tauri::command]
pub fn vec_reindex_catalog(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<usize, TrustError> {
    authorize_and_execute("vec_reindex_catalog", Capability::OperationalWrites, |_ctx| {
        let conn = open_live_db(&app).map_err(TrustError::op_failed)?;
        reindex_catalog_inner(&conn, force.unwrap_or(false))
    })
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
                deleted INTEGER DEFAULT 0, version INTEGER DEFAULT 1,
                sync_status TEXT DEFAULT 'pending'
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
            CREATE TABLE sync_outbox (
                idempotency_key TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                device_id TEXT,
                seq_no INTEGER
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
        // Serialized against kernel-mutating tests: the generation captured
        // below must still be current at commit time.
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
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
            user_id: Some("user_test".into()),
        };
        let (_, entry_gen) = global_kernel().get();
        let err =
            commit_batch_inner(&mut conn, &payload, entry_gen).expect_err("must reject negative qty");
        let msg = err.to_string();
        assert!(
            msg.contains("non-positive") || msg.contains("rounds to zero"),
            "{msg}"
        );

        let batches: i64 = conn
            .query_row("SELECT count(*) FROM stock_batches", [], |r| r.get(0))
            .unwrap();
        let ledger: i64 = conn
            .query_row("SELECT count(*) FROM inventory_ledger", [], |r| r.get(0))
            .unwrap();
        let aliases: i64 = conn
            .query_row("SELECT count(*) FROM vendor_aliases", [], |r| r.get(0))
            .unwrap();
        let audit: i64 = conn
            .query_row("SELECT count(*) FROM scan_audit_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!((batches, ledger, aliases, audit), (0, 0, 0, 0), "rollback must leave zero rows");

        let stock: i64 = conn
            .query_row("SELECT stock FROM products WHERE id='p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stock, 0);
    }

    #[test]
    fn test_commit_happy_path_and_reference_cost() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
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
            user_id: Some("user_agent_42".into()),
        };
        let (_, entry_gen) = global_kernel().get();
        assert_eq!(commit_batch_inner(&mut conn, &payload, entry_gen).unwrap(), 1);
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

        let (audit_count, audit_trace, audit_cost, audit_user): (i64, String, f64, Option<String>) = conn
            .query_row(
                "SELECT count(*), trace_id, grand_total, user_id FROM scan_audit_log WHERE supplier_name = 'ACME'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(audit_count, 1);
        assert!(!audit_trace.is_empty());
        assert!((audit_cost - 1000.0).abs() < 1e-9);
        assert_eq!(audit_user.as_deref(), Some("user_agent_42"));
        // created_at must be ISO-8601 UTC (T…Z), never the legacy
        // space-separated `datetime('now','utc')` default form.
        let (audit_created, alias_created): (String, String) = conn
            .query_row(
                "SELECT created_at FROM scan_audit_log WHERE supplier_name = 'ACME'",
                [],
                |r| r.get(0),
            )
            .and_then(|audit_created| {
                conn.query_row(
                    "SELECT created_at FROM vendor_aliases LIMIT 1",
                    [],
                    |r| r.get(0).map(|alias_created| (audit_created, alias_created)),
                )
            })
            .unwrap();
        for stamped in [&audit_created, &alias_created] {
            assert!(
                stamped.contains('T') && stamped.ends_with('Z'),
                "expected ISO-8601 UTC, got {stamped}"
            );
        }
    }

    /// UPGRADE-03 schema add-on for the semantic-index tests: the minimal
    /// products columns those queries touch + the app_settings latch table.
    fn add_vec_test_schema(conn: &Connection) {
        conn.execute_batch(
            r#"
            ALTER TABLE products ADD COLUMN brand TEXT DEFAULT '';
            ALTER TABLE products ADD COLUMN compatible_model TEXT DEFAULT '';
            ALTER TABLE products ADD COLUMN price REAL DEFAULT 0;
            CREATE TABLE app_settings (
                id TEXT PRIMARY KEY, key TEXT, value_json TEXT,
                updated_at TEXT, version INTEGER NOT NULL DEFAULT 1
            );
            "#,
        )
        .unwrap();
    }

    fn seed_three_products(conn: &Connection) {
        for (id, title, brand, compat, price) in [
            ("prod-a", "iPhone 13 128Go", "Apple", "iPhone 13", 90000.0),
            ("prod-b", "Coque iPhone 13", "", "iPhone 13", 1200.0),
            ("prod-c", "Chargeur Samsung A54", "Samsung", "Galaxy A54", 2500.0),
        ] {
            conn.execute(
                "INSERT INTO products(id, sku, barcode, title, brand, compatible_model, price, cost_price, stock) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 5)",
                params![id, format!("SKU-{id}"), format!("BC-{id}"), title, brand, compat, price],
            )
            .unwrap();
        }
    }

    /// UPGRADE-03: rebuild indexes once, latches, and `force` re-runs the
    /// idempotent upsert without duplicating rows.
    #[test]
    fn test_vec_reindex_catalog_indexes_and_latches() {
        let conn = open_test_db();
        add_vec_test_schema(&conn);
        seed_three_products(&conn);

        assert_eq!(reindex_catalog_inner(&conn, false).unwrap(), 3);
        let indexed: i64 = conn
            .query_row("SELECT count(*) FROM vec_products", [], |r| r.get(0))
            .unwrap();
        assert_eq!(indexed, 3);

        // Latched: the default pass is a cheap no-op …
        assert_eq!(reindex_catalog_inner(&conn, false).unwrap(), 0);
        // … while `force` (bulk-import hook) re-runs the rebuild idempotently.
        assert_eq!(reindex_catalog_inner(&conn, true).unwrap(), 3);
        let still: i64 = conn
            .query_row("SELECT count(*) FROM vec_products", [], |r| r.get(0))
            .unwrap();
        assert_eq!(still, 3, "upsert must not duplicate rows");
    }

    /// UPGRADE-03: suggestions recall token neighbors, never the seed itself,
    /// and never fabricate while the index is empty.
    #[test]
    fn test_checkout_suggest_accessories_neighbors() {
        let conn = open_test_db();
        add_vec_test_schema(&conn);
        seed_three_products(&conn);

        // Nothing indexed yet → empty, no fabrication.
        assert!(suggest_inner(&conn, "prod-a", 4).unwrap().is_empty());

        assert_eq!(reindex_catalog_inner(&conn, true).unwrap(), 3);
        let out = suggest_inner(&conn, "prod-a", 4).unwrap();
        assert!(
            out.iter().any(|s| s.id == "prod-b"),
            "expected the iPhone 13 neighbor, got {:?}",
            out.iter().map(|s| s.id.as_str()).collect::<Vec<_>>()
        );
        assert!(
            out.iter().all(|s| s.id != "prod-a"),
            "the seed must never suggest itself"
        );
        let coque = out.iter().find(|s| s.id == "prod-b").unwrap();
        assert!((coque.price - 1200.0).abs() < 1e-9, "price must ride the row");
    }

    /// UPGRADE-03: a PO receipt keeps the semantic index warm for the
    /// products it touched (advisory projection — never fails the commit).
    #[test]
    fn test_commit_indexes_received_products() {
        let _guard = crate::trust_core::ipc_authorizer::serial_test_lock();
        let mut conn = open_test_db();
        add_vec_test_schema(&conn);
        conn.execute(
            "INSERT INTO products(id, sku, barcode, title, brand, compatible_model, price, cost_price, stock) \
             VALUES ('p1','SKU1','BC1','Coque iPhone 13','','iPhone 13',1200.0,400.0,5)",
            [],
        )
        .unwrap();
        let payload = CommitStockBatchRequest {
            supplier_name: "ACME".into(),
            items: vec![CommitItem {
                product_id: "p1".into(),
                quantity: 2.0,
                unit_cost: 500.0,
                raw_supplier_name: "Coque".into(),
                save_as_alias: false,
            }],
            user_id: None,
        };
        let (_, entry_gen) = global_kernel().get();
        assert_eq!(commit_batch_inner(&mut conn, &payload, entry_gen).unwrap(), 1);
        let indexed: i64 = conn
            .query_row("SELECT count(*) FROM vec_products", [], |r| r.get(0))
            .unwrap();
        assert_eq!(indexed, 1, "received product must land in the semantic index");
    }
}

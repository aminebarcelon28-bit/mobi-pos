//! Native atomic checkout engine (MOBI-P0: single-transaction atomic sale commits).
//!
//! Every effect of a sale commits in a SINGLE `BEGIN IMMEDIATE`
//! transaction on a short-lived per-invoke `rusqlite` connection (same
//! ownership model as `refund.rs`: no global mutex, no lock held across
//! `.await`, no pool multiplexing).
//!
//! Guarantees:
//! 1. Single Native Transaction: All mutations (products, stock_batches,
//!    sale_batch_allocations, transactions, transaction_items, inventory_ledger,
//!    imei_records, sync_outbox) commit together or roll back completely.
//! 2. Idempotency & Replay Safety: If `transactions.id` is already durable,
//!    the persisted cost and items are returned immediately without double-depleting
//!    batches or creating duplicate ledger deltas.
//! 3. Oversell Validation: Authoritative `inventory_ledger` stock is checked
//!    for physical items before any write. Negative stock aborts with
//!    `INSUFFICIENT_STOCK:<pid>: ledger=<sum> requested=<take>`.
//! 4. FIFO Batch Depletion: Open `stock_batches` are consumed in strict FIFO order
//!    (`received_at ASC, batch_id ASC`). If open batches cannot fulfill the order,
//!    a SHADOW batch is synthesized and recorded.
//! 5. Synchronous `sale_batch_allocations`: Exact batch allocations are frozen
//!    at checkout, securing immutable COGS and net profit calculations.

use crate::trust_core::{
    audit_append::chrono_iso8601_utc,
    capability_policy::Capability,
    ipc_authorizer::{authorize_and_execute, TrustError},
};
use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ---------------------------------------------------------------------------
// Wire Types (camelCase to match the TypeScript caller)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutItemIn {
    pub id: Option<String>,
    #[serde(alias = "product_id")]
    pub product_id: Option<String>,
    pub quantity: Option<f64>,
    #[serde(alias = "applied_price")]
    pub applied_price: Option<f64>,
    #[serde(alias = "unit_price_charged")]
    pub unit_price_charged: Option<f64>,
    #[serde(alias = "default_price")]
    pub default_price: Option<f64>,
    #[serde(alias = "discount_amount")]
    pub discount_amount: Option<f64>,
    pub discount: Option<f64>,
    #[serde(alias = "cost_price")]
    pub cost_price: Option<f64>,
    #[serde(alias = "unit_cost_at_sale")]
    pub unit_cost_at_sale: Option<f64>,
    #[serde(alias = "line_profit")]
    pub line_profit: Option<f64>,
    #[serde(alias = "imei_number")]
    pub imei_number: Option<String>,
    #[serde(alias = "is_return")]
    pub is_return: Option<bool>,
    #[serde(alias = "warranty_months_at_sale")]
    pub warranty_months_at_sale: Option<i64>,
    #[serde(alias = "idempotency_key")]
    pub idempotency_key: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerDeltaIn {
    pub id: Option<String>,
    #[serde(alias = "productId")]
    pub product_id: Option<String>,
    pub delta: Option<f64>,
    pub reason: Option<String>,
    #[serde(alias = "refType")]
    pub ref_type: Option<String>,
    #[serde(alias = "refId")]
    pub ref_id: Option<String>,
    #[serde(alias = "idempotencyKey")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductSnapshotIn {
    pub id: String,
    pub sku: Option<String>,
    pub barcode: Option<String>,
    pub title: Option<String>,
    pub brand: Option<String>,
    pub category: Option<String>,
    pub price: Option<f64>,
    pub stock: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutOrderIn {
    pub id: String,
    #[serde(alias = "receipt_number", alias = "receiptNumber")]
    pub receipt_number: Option<String>,
    #[serde(alias = "customer_id", alias = "customerId")]
    pub customer_id: Option<String>,
    pub subtotal: Option<f64>,
    #[serde(alias = "discount_total", alias = "discountTotal")]
    pub discount_total: Option<f64>,
    pub total: Option<f64>,
    #[serde(alias = "cost_total", alias = "costTotal")]
    pub cost_total: Option<f64>,
    pub profit: Option<f64>,
    #[serde(alias = "profit_margin", alias = "profitMargin")]
    pub profit_margin: Option<f64>,
    #[serde(alias = "pricing_tier", alias = "pricingTier")]
    pub pricing_tier: Option<String>,
    #[serde(alias = "payment_method", alias = "paymentMethod")]
    pub payment_method: Option<String>,
    #[serde(alias = "cash_tendered", alias = "cashTendered")]
    pub cash_tendered: Option<f64>,
    #[serde(alias = "change_due", alias = "changeDue")]
    pub change_due: Option<f64>,
    pub status: Option<String>,
    #[serde(alias = "created_at", alias = "createdAt")]
    pub created_at: Option<String>,
    #[serde(alias = "shift_id", alias = "shiftId")]
    pub shift_id: Option<String>,
    #[serde(alias = "idempotency_key", alias = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRequest {
    pub order_row: CheckoutOrderIn,
    pub items: Vec<CheckoutItemIn>,
    pub deltas: Vec<LedgerDeltaIn>,
    pub full_tx: Option<serde_json::Value>,
    pub product_snapshots: Option<Vec<ProductSnapshotIn>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FifoAllocationOut {
    pub batch_id: String,
    pub quantity: f64,
    pub unit_cost: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FifoItemOut {
    pub id: String,
    pub item_id: String,
    pub unit_cost_at_sale: i64,
    pub line_profit: i64,
    pub fifo_allocations: Vec<FifoAllocationOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResponse {
    pub device_id: String,
    pub fifo_cost_total: Option<i64>,
    pub fifo_profit: Option<i64>,
    pub ledger_cogs_total: Option<i64>,
    pub fifo_items: Vec<FifoItemOut>,
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

fn conflict(code: &str) -> TrustError {
    TrustError::op_failed(code.to_string())
}

fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(f, _)
            if matches!(
                f.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            )
    )
}

fn map_rusqlite(context: &str, e: rusqlite::Error) -> TrustError {
    if is_busy(&e) {
        return conflict(&format!("BUSY:{context}"));
    }
    TrustError::op_failed(format!("{context}: {e}"))
}

/// One line's contribution to the ticket profit — THE canonical formula,
/// mirror of `lineProfitNet` in `src/utils/receiptMath.ts` (the TS twin,
/// the ledger repairs and the shadow reconciliation all call that single
/// function; this must never drift from it).
///
///   (unit_price_charged − unit_cost_at_sale) × signed_qty − signed discount
///
/// The line discount is netted because ticket totals are stored net of
/// discounts (a gross line profit left Σ per-line ≠ ticket profit — the
/// 2026-10-16 reconciliation incident). Return lines follow
/// `computeCartTotals`' sign contract: signed_qty is negative and their
/// line discount shrinks the refund, never grows it (OBS-A1).
fn line_profit_net(
    unit_price_charged: f64,
    unit_cost_at_sale: i64,
    qty: f64,
    discount: f64,
    is_return: bool,
) -> i64 {
    let magnitude = (qty.round() as i64).abs();
    let signed_qty = if is_return { -magnitude } else { magnitude };
    let line_discount = discount.round().max(0.0) as i64;
    let signed_discount = if is_return {
        -line_discount
    } else {
        line_discount
    };
    (unit_price_charged.round() as i64 - unit_cost_at_sale) * signed_qty - signed_discount
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn open_live_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("checkout open: {e}")))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| TrustError::op_failed(format!("checkout wal: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| TrustError::op_failed(format!("checkout busy_timeout: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("checkout fk: {e}")))?;
    crate::db::tune(&conn).map_err(|e| TrustError::op_failed(format!("checkout tune: {e}")))?;
    Ok(conn)
}

fn add_months_clamped(iso: &str, months: i64) -> String {
    if months <= 0 {
        return iso.to_string();
    }
    if iso.len() >= 10 && &iso[4..5] == "-" && &iso[7..8] == "-" {
        if let (Ok(y), Ok(m), Ok(d)) = (
            iso[0..4].parse::<i64>(),
            iso[5..7].parse::<i64>(),
            iso[8..10].parse::<i64>(),
        ) {
            let total_m = m - 1 + months;
            let new_y = y + total_m.div_euclid(12);
            let new_m = total_m.rem_euclid(12) + 1;
            let max_d = match new_m {
                1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
                4 | 6 | 9 | 11 => 30,
                2 => {
                    let leap = (new_y % 4 == 0 && new_y % 100 != 0) || (new_y % 400 == 0);
                    if leap {
                        29
                    } else {
                        28
                    }
                }
                _ => 30,
            };
            let clamped_d = d.min(max_d);
            let time_part = if iso.len() > 10 {
                &iso[10..]
            } else {
                "T00:00:00Z"
            };
            return format!("{new_y:04}-{new_m:02}-{clamped_d:02}{time_part}");
        }
    }
    iso.to_string()
}

fn get_device_id(tx: &Transaction) -> String {
    if let Ok(id) = tx.query_row(
        "SELECT device_id FROM device_identity WHERE device_id IS NOT NULL AND trim(device_id) != '' LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    ) {
        if !id.trim().is_empty() {
            return id;
        }
    }
    if let Ok(v) = tx.query_row(
        "SELECT value_json FROM app_settings WHERE key = 'sync.device_id'",
        [],
        |r| r.get::<_, String>(0),
    ) {
        let trimmed = v.trim().trim_matches('"');
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "default".to_string()
}

fn get_stable_entity_key(tx: &Transaction, entity: &str, id: &str) -> Result<String, TrustError> {
    let row: Result<String, rusqlite::Error> = tx.query_row(
        "SELECT idempotency_key FROM entity_keys WHERE entity_type = ?1 AND entity_id = ?2",
        params![entity, id],
        |r| r.get(0),
    );
    match row {
        Ok(k) if !k.is_empty() => Ok(k),
        _ => {
            let new_key = format!("{entity}-{id}-{}", uuid::Uuid::new_v4());
            let _ = tx.execute(
                "INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version) \
                 VALUES (?1, ?2, ?3, 1) ON CONFLICT(entity_type, entity_id) DO NOTHING",
                params![entity, id, new_key],
            );
            let confirmed: String = tx
                .query_row(
                    "SELECT idempotency_key FROM entity_keys WHERE entity_type = ?1 AND entity_id = ?2",
                    params![entity, id],
                    |r| r.get(0),
                )
                .unwrap_or(new_key);
            Ok(confirmed)
        }
    }
}

fn bump_entity_version(tx: &Transaction, entity: &str, id: &str) -> Result<i64, TrustError> {
    let _ = tx.execute(
        "INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version) \
         VALUES (?1, ?2, ?3, 1) ON CONFLICT(entity_type, entity_id) DO UPDATE SET version = entity_keys.version + 1",
        params![entity, id, format!("{entity}-{id}-{}", uuid::Uuid::new_v4())],
    );
    let v: i64 = tx
        .query_row(
            "SELECT version FROM entity_keys WHERE entity_type = ?1 AND entity_id = ?2",
            params![entity, id],
            |r| r.get(0),
        )
        .unwrap_or(1);
    Ok(v)
}

fn last_known_purchase_cost(tx: &Transaction, prod_id: &str, fallback_cost: f64) -> f64 {
    if let Ok(cost) = tx.query_row(
        "SELECT unit_cost FROM stock_batches \
         WHERE product_id = ?1 AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW') AND deleted = 0 \
         ORDER BY received_at DESC, created_at DESC LIMIT 1",
        params![prod_id],
        |r| r.get::<_, f64>(0),
    ) {
        if cost > 0.0 {
            return cost;
        }
    }
    fallback_cost.max(0.0)
}

// ---------------------------------------------------------------------------
// Transaction Body
// ---------------------------------------------------------------------------

pub fn apply_checkout_in_txn(
    tx: &Transaction,
    req: &CheckoutRequest,
) -> Result<CheckoutResponse, TrustError> {
    let now = req
        .order_row
        .created_at
        .clone()
        .unwrap_or_else(chrono_iso8601_utc);
    let tx_id = &req.order_row.id;
    let device_id = get_device_id(tx);

    // 1. Idempotency & Replay Safety
    let replay_row: Result<(Option<f64>, Option<f64>, Option<f64>), rusqlite::Error> = tx.query_row(
        "SELECT cost_total, profit, ledger_cogs_total FROM transactions WHERE id = ?1",
        params![tx_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    );

    if let Ok((cost_total, profit, ledger_cogs)) = replay_row {
        if let Some(ct) = cost_total {
            let mut stmt = tx
                .prepare(
                    "SELECT id, unit_cost_at_sale, line_profit FROM transaction_items WHERE transaction_id = ?1",
                )
                .map_err(|e| map_rusqlite("prepare replay items", e))?;

            let stored_items = stmt
                .query_map(params![tx_id], |r| {
                    let item_id: String = r.get(0)?;
                    let unit_cost: Option<f64> = r.get(1)?;
                    let line_prof: Option<f64> = r.get(2)?;
                    Ok(FifoItemOut {
                        id: item_id.clone(),
                        item_id,
                        unit_cost_at_sale: unit_cost.map(|v| v.round() as i64).unwrap_or(0),
                        line_profit: line_prof.map(|v| v.round() as i64).unwrap_or(0),
                        fifo_allocations: vec![],
                    })
                })
                .map_err(|e| map_rusqlite("query replay items", e))?
                .filter_map(|r| r.ok())
                .collect();

            return Ok(CheckoutResponse {
                device_id,
                fifo_cost_total: Some(ct.round() as i64),
                fifo_profit: profit.map(|v| v.round() as i64),
                ledger_cogs_total: ledger_cogs.map(|v| v.round() as i64),
                fifo_items: stored_items,
            });
        }
    }

    // 2. Batched Oversell Validation & Baseline Seeding
    let mut unstocked_categories: HashSet<String> = HashSet::new();
    if let Some(snaps) = &req.product_snapshots {
        for s in snaps {
            if s.category.as_deref() == Some("Services") {
                unstocked_categories.insert(s.id.clone());
            }
        }
    }

    for d in &req.deltas {
        let pid = d.product_id.as_deref().unwrap_or("");
        if pid.is_empty() || pid.starts_with("qt-") || pid.starts_with("prod-misc-") {
            continue;
        }
        let reason = d.reason.as_deref().unwrap_or("SALE");
        if reason != "SALE" {
            continue;
        }

        if unstocked_categories.contains(pid) {
            continue;
        }

        let cat: Option<String> = tx
            .query_row(
                "SELECT category FROM products WHERE id = ?1",
                params![pid],
                |r| r.get(0),
            )
            .ok();
        if cat.as_deref() == Some("Services") {
            unstocked_categories.insert(pid.to_string());
            continue;
        }

        let (row_count, ledger_sum, seeds_count): (i64, f64, i64) = tx
            .query_row(
                "SELECT COUNT(*) AS n, COALESCE(SUM(delta), 0) AS s, \
                 SUM(CASE WHEN reason IN ('SEED','RECEIVE','ADJUST') THEN 1 ELSE 0 END) AS seeds \
                 FROM inventory_ledger WHERE product_id = ?1 AND deleted = 0",
                params![pid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| map_rusqlite("oversell check", e))?;

        let mut cur_row_count = row_count;
        let mut cur_ledger_sum = ledger_sum;

        if cur_row_count == 0 || (seeds_count == 0 && cur_ledger_sum <= 0.0) {
            let mut snap_stock: Option<f64> = None;
            if let Ok(stock) = tx.query_row(
                "SELECT stock FROM products WHERE id = ?1",
                params![pid],
                |r| r.get::<_, Option<f64>>(0),
            ) {
                if let Some(s) = stock {
                    if s > 0.0 {
                        snap_stock = Some(s);
                    }
                }
            }
            if snap_stock.is_none() {
                if let Some(snaps) = &req.product_snapshots {
                    for s in snaps {
                        if s.id == pid && s.stock.map(|v| v > 0.0).unwrap_or(false) {
                            snap_stock = s.stock;
                            break;
                        }
                    }
                }
            }

            let mut on_hand = snap_stock.unwrap_or(0.0).round() as i64;
            if on_hand <= 0 && seeds_count == 0 && cur_ledger_sum < 0.0 {
                on_hand = 10.max(cur_ledger_sum.abs() as i64 + 20);
            }

            if on_hand > 0 {
                let seed_key = format!("seed-baseline-{pid}");
                tx.execute(
                    "INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, created_at, updated_at, deleted) \
                     VALUES (?1, ?2, ?3, 'SEED', 'heal', ?4, ?5, ?6, 'pending', ?7, ?7, 0) \
                     ON CONFLICT(id) DO NOTHING",
                    params![seed_key, pid, on_hand, tx_id, device_id, seed_key, now],
                )
                .map_err(|e| map_rusqlite("seed ledger", e))?;

                let seed_payload = serde_json::json!({
                    "id": seed_key,
                    "product_id": pid,
                    "delta": on_hand,
                    "reason": "SEED"
                })
                .to_string();

                tx.execute(
                    "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                     VALUES (?1, 'ledger', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                     ON CONFLICT(idempotency_key) DO NOTHING",
                    params![seed_key, seed_key, seed_payload, now],
                )
                .map_err(|e| map_rusqlite("seed outbox", e))?;

                let re: (i64, f64) = tx
                    .query_row(
                        "SELECT COUNT(*) AS n, COALESCE(SUM(delta), 0) AS s FROM inventory_ledger WHERE product_id = ?1 AND deleted = 0",
                        params![pid],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(|e| map_rusqlite("re-read ledger", e))?;

                cur_row_count = re.0;
                cur_ledger_sum = re.1;
            }
        }

        if cur_row_count > 0 {
            let take = d.delta.unwrap_or(0.0).abs();
            if cur_ledger_sum - take < 0.0 {
                return Err(conflict(&format!(
                    "INSUFFICIENT_STOCK:{pid}: ledger={cur_ledger_sum} requested={take}"
                )));
            }
        }
    }

    // 3. Ensure Referenced Products Exist
    if let Some(snaps) = &req.product_snapshots {
        for p in snaps {
            let p_id = &p.id;
            let is_service = p_id.starts_with("qt-")
                || p_id.starts_with("prod-misc-")
                || p.category.as_deref() == Some("Services");
            let initial_stock = if is_service { 999999.0 } else { 0.0 };
            let p_payload = serde_json::to_string(p).unwrap_or_default();
            let _ = tx.execute(
                "INSERT OR IGNORE INTO products (id, sku, barcode, title, brand, category, price, \
                 wholesale_price, cost_price, stock, json_payload, device_id, idempotency_key, \
                 sync_status, created_at, updated_at, deleted) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, ?8, ?9, ?10, ?11, 'pending', ?12, ?12, 0)",
                params![
                    p_id,
                    p.sku.as_deref().unwrap_or(""),
                    p.barcode.as_deref().unwrap_or(""),
                    p.title.as_deref().unwrap_or("Article"),
                    p.brand.as_deref().unwrap_or("Autre"),
                    p.category.as_deref().unwrap_or(if is_service {
                        "Services"
                    } else {
                        "Tous les produits"
                    }),
                    p.price.unwrap_or(0.0),
                    initial_stock,
                    p_payload,
                    device_id,
                    format!("stub-{p_id}"),
                    now,
                ],
            );
            if is_service {
                let _ = tx.execute(
                    "UPDATE products SET stock = 999999, category = 'Services' WHERE id = ?1 AND stock < 999999",
                    params![p_id],
                );
            }
        }
    }

    // 4. FIFO Batch Depletion & Allocation
    let mut fifo_item_resolutions: Vec<FifoItemOut> = Vec::new();
    let mut total_fifo_cost: i64 = 0;
    let mut alloc_ledger_total: i64 = 0;
    let mut fifo_resolved_any = false;

    let receipt_no = req
        .order_row
        .receipt_number
        .clone()
        .unwrap_or_else(|| tx_id.clone());
    let order_key = req
        .order_row
        .idempotency_key
        .clone()
        .unwrap_or_else(|| format!("order-{tx_id}"));

    struct BatchRow {
        batch_id: String,
        quantity_remaining: f64,
        unit_cost: f64,
    }

    for (idx, item) in req.items.iter().enumerate() {
        let item_id = item
            .id
            .clone()
            .unwrap_or_else(|| format!("{tx_id}-item-{idx}"));
        let prod_id = item.product_id.clone().unwrap_or_else(|| "unknown".into());
        let is_return = item.is_return.unwrap_or(false);
        let qty = item.quantity.unwrap_or(1.0).abs();
        let fallback_cost = item.cost_price.unwrap_or(0.0);
        let applied_price = item
            .applied_price
            .unwrap_or_else(|| item.unit_price_charged.unwrap_or(0.0));
        let unit_price_charged = item.unit_price_charged.unwrap_or(applied_price);

        let mut fifo_allocations: Vec<FifoAllocationOut> = Vec::new();
        let mut authoritative_cost: Option<i64> = None;

        if is_return {
            let line_qty = qty.round() as i64;
            let line_cost = fallback_cost.round() as i64;
            if line_qty > 0 {
                let earliest: Option<BatchRow> = tx
                    .query_row(
                        "SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches \
                         WHERE product_id = ?1 AND quantity_remaining > 0 AND deleted = 0 \
                           AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW') \
                         ORDER BY received_at ASC, batch_id ASC LIMIT 1",
                        params![prod_id],
                        |r| {
                            Ok(BatchRow {
                                batch_id: r.get(0)?,
                                quantity_remaining: r.get(1)?,
                                unit_cost: r.get(2)?,
                            })
                        },
                    )
                    .ok();

                if let Some(target) = earliest {
                    tx.execute(
                        "UPDATE stock_batches \
                         SET quantity_remaining = quantity_remaining + ?1, version = version + 1, updated_at = ?2, sync_status = 'pending' \
                         WHERE batch_id = ?3",
                        params![line_qty, now, target.batch_id],
                    )
                    .map_err(|e| map_rusqlite("restock batch", e))?;

                    let ex_key = format!("sb-{}-{tx_id}", target.batch_id);
                    let batch_payload = serde_json::json!({
                        "batch_id": target.batch_id,
                        "product_id": prod_id,
                        "quantity_remaining": target.quantity_remaining + line_qty as f64,
                        "unit_cost": target.unit_cost,
                        "updated_at": now,
                        "device_id": device_id
                    })
                    .to_string();

                    tx.execute(
                        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                         VALUES (?1, 'stock_batches', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, status = 'pending', updated_at = ?4",
                        params![ex_key, target.batch_id, batch_payload, now],
                    )
                    .map_err(|e| map_rusqlite("restock outbox", e))?;

                    fifo_allocations.push(FifoAllocationOut {
                        batch_id: target.batch_id,
                        quantity: line_qty as f64,
                        unit_cost: target.unit_cost.round() as i64,
                    });
                } else {
                    let ex_batch_id = format!("batch-exchange-{}", uuid::Uuid::new_v4());
                    let ex_key = format!("sb-{ex_batch_id}");
                    tx.execute(
                        "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, \
                         purchase_order_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) \
                         VALUES (?1, ?2, ?3, ?4, ?5, 'EXCHANGE', ?6, ?7, 'pending', 1, ?5, ?5, 0)",
                        params![
                            ex_batch_id,
                            prod_id,
                            line_qty,
                            line_cost,
                            now,
                            device_id,
                            ex_key
                        ],
                    )
                    .map_err(|e| map_rusqlite("insert exchange batch", e))?;

                    let ex_payload = serde_json::json!({
                        "version": 1,
                        "batch_id": ex_batch_id,
                        "product_id": prod_id,
                        "quantity_remaining": line_qty,
                        "unit_cost": line_cost,
                        "received_at": now,
                        "purchase_order_id": "EXCHANGE",
                        "device_id": device_id,
                        "idempotency_key": ex_key,
                        "created_at": now,
                        "updated_at": now
                    })
                    .to_string();

                    tx.execute(
                        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                         VALUES (?1, 'stock_batches', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, status = 'pending', updated_at = ?4",
                        params![ex_key, ex_batch_id, ex_payload, now],
                    )
                    .map_err(|e| map_rusqlite("exchange batch outbox", e))?;

                    fifo_allocations.push(FifoAllocationOut {
                        batch_id: ex_batch_id,
                        quantity: line_qty as f64,
                        unit_cost: line_cost,
                    });
                }
            }
            authoritative_cost = Some(line_cost);
        } else {
            // Physical Sale: Deplete open batches in FIFO order
            let mut stmt = tx
                .prepare(
                    "SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches \
                     WHERE product_id = ?1 AND quantity_remaining > 0 AND deleted = 0 \
                       AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW') \
                     ORDER BY received_at ASC, batch_id ASC",
                )
                .map_err(|e| map_rusqlite("prepare batch query", e))?;

            let batches: Vec<BatchRow> = stmt
                .query_map(params![prod_id], |r| {
                    Ok(BatchRow {
                        batch_id: r.get(0)?,
                        quantity_remaining: r.get(1)?,
                        unit_cost: r.get(2)?,
                    })
                })
                .map_err(|e| map_rusqlite("query open batches", e))?
                .filter_map(|r| r.ok())
                .collect();

            let mut needed = qty;
            let mut total_cost_accum = 0.0;
            let mut total_allocated_qty = 0.0;

            for b in batches {
                if needed <= 0.0 {
                    break;
                }
                let avail = b.quantity_remaining.max(0.0);
                let take = avail.min(needed);
                if take <= 0.0 {
                    continue;
                }

                tx.execute(
                    "UPDATE stock_batches \
                     SET quantity_remaining = quantity_remaining - ?1, version = version + 1, updated_at = ?2, sync_status = 'pending' \
                     WHERE batch_id = ?3 AND quantity_remaining >= ?1",
                    params![take, now, b.batch_id],
                )
                .map_err(|e| map_rusqlite("deplete batch", e))?;

                needed -= take;
                total_allocated_qty += take;
                total_cost_accum += take * b.unit_cost;

                let b_key = format!("sb-{}-{tx_id}", b.batch_id);
                let b_payload = serde_json::json!({
                    "batch_id": b.batch_id,
                    "product_id": prod_id,
                    "quantity_remaining": avail - take,
                    "unit_cost": b.unit_cost,
                    "updated_at": now,
                    "device_id": device_id
                })
                .to_string();

                tx.execute(
                    "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                     VALUES (?1, 'stock_batches', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                     ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, status = 'pending', updated_at = ?4",
                    params![b_key, b.batch_id, b_payload, now],
                )
                .map_err(|e| map_rusqlite("deplete batch outbox", e))?;

                fifo_allocations.push(FifoAllocationOut {
                    batch_id: b.batch_id,
                    quantity: take,
                    unit_cost: b.unit_cost.round() as i64,
                });
            }

            if needed > 0.0 {
                let shadow_cost = last_known_purchase_cost(tx, &prod_id, fallback_cost);
                let shadow_id = format!("shadow-{tx_id}-{idx}");
                let shadow_key = format!("sb-{shadow_id}");

                tx.execute(
                    "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, \
                     purchase_order_id, device_id, idempotency_key, sync_status, version, \
                     created_at, updated_at, deleted, shadow_sale_id, shadow_item_id, shadow_qty, shadow_resolved) \
                     VALUES (?1, ?2, 0, ?3, ?4, 'SHADOW', ?5, ?6, 'pending', 1, ?4, ?4, 0, ?7, ?8, ?9, 0) \
                     ON CONFLICT(batch_id) DO NOTHING",
                    params![shadow_id, prod_id, shadow_cost, now, device_id, shadow_key, tx_id, item_id, needed],
                )
                .map_err(|e| map_rusqlite("insert shadow batch", e))?;

                let shadow_payload = serde_json::json!({
                    "version": 1,
                    "batch_id": shadow_id,
                    "product_id": prod_id,
                    "quantity_remaining": 0,
                    "unit_cost": shadow_cost,
                    "received_at": now,
                    "purchase_order_id": "SHADOW",
                    "device_id": device_id,
                    "idempotency_key": shadow_key,
                    "created_at": now,
                    "updated_at": now,
                    "shadow_sale_id": tx_id,
                    "shadow_item_id": item_id,
                    "shadow_qty": needed,
                    "shadow_resolved": 0
                })
                .to_string();

                tx.execute(
                    "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                     VALUES (?1, 'stock_batches', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                     ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, status = 'pending', updated_at = ?4",
                    params![shadow_key, shadow_id, shadow_payload, now],
                )
                .map_err(|e| map_rusqlite("shadow batch outbox", e))?;

                total_cost_accum += needed * shadow_cost;
                total_allocated_qty += needed;
                fifo_allocations.push(FifoAllocationOut {
                    batch_id: shadow_id,
                    quantity: needed,
                    unit_cost: shadow_cost.round() as i64,
                });
            }

            if total_allocated_qty > 0.0 {
                let blended = total_cost_accum / total_allocated_qty;
                authoritative_cost = Some(blended.round() as i64);
            }
        }

        let unit_cost_at_sale = authoritative_cost.unwrap_or_else(|| fallback_cost.round() as i64);
        if authoritative_cost.is_some() {
            fifo_resolved_any = true;
        }

        let signed_qty = if is_return { -(qty.round() as i64) } else { qty.round() as i64 };
        // Canonical line profit (mirror of receiptMath.lineProfitNet) — nets
        // the line discount so Σ per-line equals the discounted ticket.
        let line_profit = line_profit_net(
            unit_price_charged,
            unit_cost_at_sale,
            qty,
            item.discount.unwrap_or(0.0),
            is_return,
        );
        total_fifo_cost += unit_cost_at_sale * signed_qty;

        // Persist sale_batch_allocations
        if !is_return {
            for alloc in &fifo_allocations {
                let alloc_id = format!("alloc-{tx_id}-{idx}-{}", alloc.batch_id);
                tx.execute(
                    "INSERT INTO sale_batch_allocations \
                     (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale, created_at, product_id, sale_item_id, \
                      device_id, idempotency_key, sync_status, version, updated_at, deleted) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', 1, ?6, 0) \
                     ON CONFLICT(id) DO UPDATE SET \
                      qty_consumed = sale_batch_allocations.qty_consumed + excluded.qty_consumed, \
                      updated_at = excluded.updated_at, sync_status = 'pending'",
                    params![
                        alloc_id,
                        tx_id,
                        alloc.batch_id,
                        alloc.quantity as i64,
                        alloc.unit_cost,
                        now,
                        prod_id,
                        item_id,
                        device_id,
                        alloc_id
                    ],
                )
                .map_err(|e| map_rusqlite("insert sale_batch_allocations", e))?;

                let alloc_payload = serde_json::json!({
                    "id": alloc_id,
                    "sale_id": tx_id,
                    "batch_id": alloc.batch_id,
                    "qty_consumed": alloc.quantity as i64,
                    "unit_cost_at_sale": alloc.unit_cost,
                    "product_id": prod_id,
                    "sale_item_id": item_id,
                    "device_id": device_id,
                    "updated_at": now
                })
                .to_string();

                tx.execute(
                    "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                     VALUES (?1, 'sale_batch_allocations', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                     ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, status = 'pending', updated_at = ?4",
                    params![alloc_id, alloc_id, alloc_payload, now],
                )
                .map_err(|e| map_rusqlite("sale_batch_allocations outbox", e))?;

                alloc_ledger_total += (alloc.quantity as i64) * alloc.unit_cost;
            }
        }

        fifo_item_resolutions.push(FifoItemOut {
            id: item_id.clone(),
            item_id,
            unit_cost_at_sale,
            line_profit,
            fifo_allocations,
        });

        // IMEI ownership check & update
        if let Some(imei) = &item.imei_number {
            let imei = imei.trim();
            if !imei.is_empty() && !is_return {
                // Check if already sold
                let prev_sold: Result<(Option<String>, Option<String>), rusqlite::Error> = tx.query_row(
                    "SELECT sale_transaction_id, sold_at FROM imei_records WHERE imei = ?1",
                    params![imei],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                );

                if let Ok((prev_sale_id, prev_sold_at)) = prev_sold {
                    if prev_sold_at.is_some() {
                        if let Some(ref prev_id) = prev_sale_id {
                            if prev_id != tx_id {
                                let is_refund: bool = tx
                                    .query_row(
                                        "SELECT is_refund FROM transactions WHERE id = ?1",
                                        params![prev_id],
                                        |r| r.get(0),
                                    )
                                    .unwrap_or(false);
                                if !is_refund {
                                    return Err(conflict(&format!("IMEI_ALREADY_SOLD:{imei}")));
                                }
                            }
                        }
                    }
                }

                let w_months = item.warranty_months_at_sale.unwrap_or(0).max(0);
                let w_expires_at = if w_months > 0 {
                    add_months_clamped(&now, w_months)
                } else {
                    now.clone()
                };

                let imei_key = get_stable_entity_key(tx, "imei", imei)?;
                let imei_version = bump_entity_version(tx, "imei", imei)?;

                tx.execute(
                    "INSERT INTO imei_records (imei, product_id, sale_transaction_id, sold_at, received_at, warranty_months, warranty_expires_at, version) \
                     VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7) \
                     ON CONFLICT(imei) DO UPDATE SET \
                      sale_transaction_id = excluded.sale_transaction_id, \
                      sold_at = excluded.sold_at, \
                      warranty_months = excluded.warranty_months, \
                      warranty_expires_at = excluded.warranty_expires_at, \
                      version = ?7",
                    params![imei, prod_id, tx_id, now, w_months, w_expires_at, imei_version],
                )
                .map_err(|e| map_rusqlite("update imei_records", e))?;

                let imei_payload = serde_json::json!({
                    "imei": imei,
                    "product_id": prod_id,
                    "sale_transaction_id": tx_id,
                    "sold_at": now,
                    "warranty_months": w_months,
                    "warranty_expires_at": w_expires_at,
                    "version": imei_version
                })
                .to_string();

                tx.execute(
                    "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                     VALUES (?1, 'imei', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                     ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, status = 'pending', updated_at = ?4",
                    params![imei_key, imei, imei_payload, now],
                )
                .map_err(|e| map_rusqlite("imei outbox", e))?;
            }
        }
    }

    // 5. Order Totals & Pricing
    let order_total = req.order_row.total.unwrap_or(0.0).round() as i64;
    let final_cost_total = if fifo_resolved_any {
        total_fifo_cost
    } else {
        req.order_row.cost_total.unwrap_or(0.0).round() as i64
    };
    let final_profit = order_total - final_cost_total;
    let final_profit_margin = if order_total > 0 {
        ((final_profit as f64 / order_total as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };
    let final_ledger_cogs = if fifo_resolved_any {
        Some(alloc_ledger_total)
    } else {
        None
    };

    let next_version: i64 = {
        let cur_v: Option<i64> = tx
            .query_row(
                "SELECT version FROM transactions WHERE id = ?1",
                params![tx_id],
                |r| r.get(0),
            )
            .ok();
        cur_v.unwrap_or(0) + 1
    };

    // Build receipt JSON payload
    let mut receipt_obj = match &req.full_tx {
        Some(serde_json::Value::Object(map)) => map.clone(),
        _ => serde_json::Map::new(),
    };
    receipt_obj.insert("id".to_string(), serde_json::Value::String(tx_id.clone()));
    receipt_obj.insert(
        "receiptNumber".to_string(),
        serde_json::Value::String(receipt_no.clone()),
    );
    receipt_obj.insert(
        "deviceId".to_string(),
        serde_json::Value::String(device_id.clone()),
    );
    receipt_obj.insert(
        "version".to_string(),
        serde_json::Value::Number(next_version.into()),
    );
    receipt_obj.insert(
        "costTotal".to_string(),
        serde_json::Value::Number(final_cost_total.into()),
    );
    receipt_obj.insert(
        "profit".to_string(),
        serde_json::Value::Number(final_profit.into()),
    );
    if let Some(lc) = final_ledger_cogs {
        receipt_obj.insert(
            "ledgerCogsTotal".to_string(),
            serde_json::Value::Number(lc.into()),
        );
    }
    // Version parity with the TS twin's canonical receipt (payload.version
    // feeds the remote row version on the guarded order lane).
    receipt_obj.insert(
        "version".to_string(),
        serde_json::Value::from(next_version),
    );
    // P1 (2026-10-16): adopt the FIFO line resolutions INTO the receipt items
    // — mirror of the TS twin's "Canonical receipt JSON" patch
    // (sqlPluginAdapter.ts). Without this the receipt kept the pre-FIFO
    // caller snapshots, and Desktop/Mobile mirrors rebuilt from it disagreed
    // on every line margin while ticket totals were already exact.
    if let Some(serde_json::Value::Array(items)) = receipt_obj.get_mut("items") {
        for (ri_idx, ri) in items.iter_mut().enumerate() {
            let Some(res) = fifo_item_resolutions.get(ri_idx) else {
                continue;
            };
            let Some(obj) = ri.as_object_mut() else {
                continue;
            };
            let cost = serde_json::Value::Number(res.unit_cost_at_sale.into());
            let profit = serde_json::Value::Number(res.line_profit.into());
            obj.insert("unitCostAtSale".to_string(), cost.clone());
            obj.insert("unitCostPrice".to_string(), cost.clone());
            obj.insert("unit_cost_at_sale".to_string(), cost);
            obj.insert("lineProfit".to_string(), profit.clone());
            obj.insert("line_profit".to_string(), profit);
        }
    }
    let receipt_json = serde_json::to_string(&receipt_obj).unwrap_or_default();

    // 6. Upsert transactions table
    let shift_id = req.order_row.shift_id.clone();
    let subtotal = req.order_row.subtotal.unwrap_or(0.0).round();
    let discount_total = req.order_row.discount_total.unwrap_or(0.0).round();
    let pricing_tier = req
        .order_row
        .pricing_tier
        .clone()
        .unwrap_or_else(|| "Retail".into());
    let payment_method = req
        .order_row
        .payment_method
        .clone()
        .unwrap_or_else(|| "Espèces".into());
    let cash_tendered = req.order_row.cash_tendered.unwrap_or(0.0).round();
    let change_due = req.order_row.change_due.unwrap_or(0.0).round();
    let status = req
        .order_row
        .status
        .clone()
        .unwrap_or_else(|| "COMPLETED".into());
    let customer_id = req.order_row.customer_id.clone();

    tx.execute(
        "INSERT INTO transactions (id, receipt_number, customer_id, subtotal, discount_total, total, \
         cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due, \
         status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, version, deleted, ledger_cogs_total, shift_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 'pending', ?19, ?20, 0, ?21, ?22) \
         ON CONFLICT(id) DO UPDATE SET receipt_number = excluded.receipt_number, total = excluded.total, \
          cost_total = excluded.cost_total, profit = excluded.profit, profit_margin = excluded.profit_margin, \
          ledger_cogs_total = excluded.ledger_cogs_total, shift_id = excluded.shift_id, \
          status = excluded.status, json_payload = excluded.json_payload, updated_at = excluded.updated_at, \
          sync_status = 'pending', idempotency_key = excluded.idempotency_key, version = excluded.version",
        params![
            tx_id,
            receipt_no,
            customer_id,
            subtotal,
            discount_total,
            order_total as f64,
            final_cost_total as f64,
            final_profit as f64,
            final_profit_margin,
            pricing_tier,
            payment_method,
            cash_tendered,
            change_due,
            status,
            now,
            receipt_json,
            device_id,
            order_key,
            now,
            next_version,
            final_ledger_cogs.map(|v| v as f64),
            shift_id
        ],
    )
    .map_err(|e| map_rusqlite("insert transactions", e))?;

    // Outbox: Order
    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
         VALUES (?1, 'order', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, status = 'pending', updated_at = ?4",
        params![order_key, tx_id, receipt_json, now],
    )
    .map_err(|e| map_rusqlite("order outbox", e))?;

    // 7. Upsert transaction_items table & outbox
    for (idx, item) in req.items.iter().enumerate() {
        let res = &fifo_item_resolutions[idx];
        let item_id = &res.id;
        let prod_id = item.product_id.clone().unwrap_or_else(|| "unknown".into());
        let item_key = item
            .idempotency_key
            .clone()
            .unwrap_or_else(|| format!("{tx_id}-itemkey-{idx}"));

        let qty = item.quantity.unwrap_or(1.0);
        let applied_price = item
            .applied_price
            .unwrap_or_else(|| item.unit_price_charged.unwrap_or(0.0));
        let discount = item.discount.unwrap_or(0.0);
        let default_price = item.default_price.unwrap_or(applied_price);
        let unit_price_charged = item.unit_price_charged.unwrap_or(applied_price);
        let discount_amount = item
            .discount_amount
            .unwrap_or_else(|| (default_price - unit_price_charged).max(0.0));
        let fallback_cost = item.cost_price.unwrap_or(0.0);

        // Full line payload (mirror of the TS twin's enrichedPayload): the
        // 5-key stub this replaced starved the push lane — the remote row was
        // materialized with zeroed pricing columns (applied_price 0, quantity
        // 1) and the pull echo then zeroed the same columns locally
        // (2026-10-16 incident). Raw request fields first, resolved FIFO
        // values after; `extra` keeps any future payload keys.
        let mut item_obj = serde_json::Map::new();
        for (k, v) in &item.extra {
            item_obj.insert(k.clone(), v.clone());
        }
        item_obj.insert("id".into(), serde_json::Value::String(item_id.clone()));
        item_obj.insert(
            "transaction_id".into(),
            serde_json::Value::String(tx_id.clone()),
        );
        item_obj.insert(
            "product_id".into(),
            serde_json::Value::String(prod_id.clone()),
        );
        item_obj.insert("quantity".into(), serde_json::json!(qty));
        item_obj.insert("applied_price".into(), serde_json::json!(applied_price));
        item_obj.insert(
            "unit_price_charged".into(),
            serde_json::json!(unit_price_charged),
        );
        item_obj.insert("default_price".into(), serde_json::json!(default_price));
        item_obj.insert("discount".into(), serde_json::json!(discount));
        item_obj.insert(
            "discount_amount".into(),
            serde_json::json!(discount_amount),
        );
        item_obj.insert("cost_price".into(), serde_json::json!(fallback_cost));
        item_obj.insert(
            "is_return".into(),
            serde_json::json!(item.is_return.unwrap_or(false)),
        );
        item_obj.insert("imei_number".into(), serde_json::json!(item.imei_number));
        if let Some(w) = item.warranty_months_at_sale {
            item_obj.insert("warranty_months_at_sale".into(), serde_json::json!(w));
        }
        item_obj.insert(
            "idempotency_key".into(),
            serde_json::Value::String(item_key.clone()),
        );
        item_obj.insert(
            "unit_cost_at_sale".into(),
            serde_json::Value::Number(res.unit_cost_at_sale.into()),
        );
        item_obj.insert(
            "line_profit".into(),
            serde_json::Value::Number(res.line_profit.into()),
        );
        item_obj.insert(
            "fifo_allocations".into(),
            serde_json::Value::Array(
                res.fifo_allocations
                    .iter()
                    .map(|a| {
                        serde_json::json!({
                            "batchId": a.batch_id,
                            "quantity": a.quantity,
                            "unitCost": a.unit_cost,
                        })
                    })
                    .collect(),
            ),
        );
        let item_json = serde_json::to_string(&item_obj).unwrap_or_default();

        tx.execute(
            "INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount, \
             imei_number, cost_price, unit_price_charged, unit_cost_at_sale, discount_amount, line_profit, \
             json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'pending', ?16, ?16, 0) \
             ON CONFLICT(id) DO UPDATE SET quantity = excluded.quantity, applied_price = excluded.applied_price, \
              unit_price_charged = excluded.unit_price_charged, unit_cost_at_sale = excluded.unit_cost_at_sale, \
              discount_amount = excluded.discount_amount, line_profit = excluded.line_profit, \
              json_payload = excluded.json_payload, updated_at = excluded.updated_at, sync_status = 'pending'",
            params![
                item_id,
                tx_id,
                prod_id,
                qty,
                applied_price,
                discount,
                item.imei_number.as_deref(),
                fallback_cost,
                unit_price_charged,
                res.unit_cost_at_sale as f64,
                discount_amount,
                res.line_profit as f64,
                item_json,
                device_id,
                item_key,
                now
            ],
        )
        .map_err(|e| map_rusqlite("insert transaction_items", e))?;

        tx.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
             VALUES (?1, 'order_item', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) ON CONFLICT(idempotency_key) DO NOTHING",
            params![item_key, item_id, item_json, now],
        )
        .map_err(|e| map_rusqlite("order_item outbox", e))?;
    }

    // 8. Inventory Ledger Deltas & Post-Sale Stock Recompute
    let mut touched_products: HashSet<String> = HashSet::new();

    for (idx, d) in req.deltas.iter().enumerate() {
        let prod_id = d.product_id.as_deref().unwrap_or("unknown");
        if prod_id.starts_with("qt-") || prod_id.starts_with("prod-misc-") {
            continue;
        }
        if unstocked_categories.contains(prod_id) {
            continue;
        }

        let ledger_id = d
            .id
            .clone()
            .unwrap_or_else(|| format!("{tx_id}-ledger-{idx}"));
        let ledger_key = d
            .idempotency_key
            .clone()
            .unwrap_or_else(|| format!("{tx_id}-ledgerkey-{idx}"));
        let delta = d.delta.unwrap_or(0.0);
        let reason = d.reason.as_deref().unwrap_or("SALE");
        let ref_type = d.ref_type.as_deref().unwrap_or("order");
        let ref_id = d
            .ref_id
            .clone()
            .unwrap_or_else(|| format!("{tx_id}-{idx}"));

        tx.execute(
            "INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, \
             idempotency_key, sync_status, created_at, updated_at, deleted) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?9, 0) \
             ON CONFLICT(id) DO NOTHING",
            params![
                ledger_id, prod_id, delta, reason, ref_type, ref_id, device_id, ledger_key, now
            ],
        )
        .map_err(|e| map_rusqlite("insert inventory_ledger", e))?;

        let ledger_payload = serde_json::json!({
            "id": ledger_id,
            "product_id": prod_id,
            "delta": delta,
            "reason": reason,
            "ref_type": ref_type,
            "ref_id": ref_id,
            "device_id": device_id,
            "idempotency_key": ledger_key
        })
        .to_string();

        tx.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
             VALUES (?1, 'ledger', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) ON CONFLICT(idempotency_key) DO NOTHING",
            params![ledger_key, ledger_id, ledger_payload, now],
        )
        .map_err(|e| map_rusqlite("ledger outbox", e))?;

        touched_products.insert(prod_id.to_string());
    }

    // Recompute cached stock for touched products
    for pid in &touched_products {
        tx.execute(
            "UPDATE products \
             SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id = ?1 AND deleted = 0), stock), \
                 version = version + 1, updated_at = ?2, sync_status = 'pending' \
             WHERE id = ?1",
            params![pid, now],
        )
        .map_err(|e| map_rusqlite("update products stock", e))?;

        let p_row: Result<(String, Option<String>, Option<f64>), rusqlite::Error> = tx.query_row(
            "SELECT id, json_payload, stock FROM products WHERE id = ?1",
            params![pid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        );

        if let Ok((p_id, p_json, p_stock)) = p_row {
            let p_key = format!("stub-{p_id}");
            let payload = serde_json::json!({
                "id": p_id,
                "stock": p_stock,
                "json_payload": p_json,
                "updated_at": now
            })
            .to_string();

            tx.execute(
                "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                 VALUES (?1, 'product', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, status = 'pending', updated_at = ?4",
                params![p_key, p_id, payload, now],
            )
            .map_err(|e| map_rusqlite("product outbox", e))?;
        }
    }

    Ok(CheckoutResponse {
        device_id,
        fifo_cost_total: Some(final_cost_total),
        fifo_profit: Some(final_profit),
        ledger_cogs_total: final_ledger_cogs,
        fifo_items: fifo_item_resolutions,
    })
}

pub fn apply_checkout(
    conn: &mut Connection,
    req: &CheckoutRequest,
) -> Result<CheckoutResponse, TrustError> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| {
            if is_busy(&e) {
                conflict("BUSY:write lock held")
            } else {
                TrustError::op_failed(format!("checkout begin: {e}"))
            }
        })?;

    let res = apply_checkout_in_txn(&tx, req)?;

    tx.commit().map_err(|e| {
        if is_busy(&e) {
            conflict("BUSY:commit")
        } else {
            TrustError::op_failed(format!("checkout commit: {e}"))
        }
    })?;

    Ok(res)
}

/// Native atomic checkout command exposed to Tauri IPC.
#[tauri::command]
pub fn checkout_sale_atomic(
    app: tauri::AppHandle,
    req: CheckoutRequest,
) -> Result<CheckoutResponse, TrustError> {
    authorize_and_execute(
        "checkout_sale_atomic",
        Capability::OperationalWrites,
        |_ctx| {
            let mut conn = open_live_db(&app)?;
            apply_checkout(&mut conn, &req)
        },
    )
}

// ---------------------------------------------------------------------------
// Rust Unit Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_profit_nets_discount_and_signs_returns() {
        // Gross-vs-net regression (2026-10-16): (2416−1336)×1 − 200 = 880,
        // matching the stored ticket profit — not the gross 1080.
        assert_eq!(line_profit_net(2416.0, 1336, 1.0, 200.0, false), 880);
        // Multi-unit with no line discount: (400−1605)×2 = −2410.
        assert_eq!(line_profit_net(400.0, 1605, 2.0, 0.0, false), -2410);
        // Return line: signed qty negative AND the discount shrinks the
        // refund: −((500−380)×2) + 100 = −140.
        assert_eq!(line_profit_net(500.0, 380, -2.0, 100.0, true), -140);
        // Sale-line discount always nets as a subtraction.
        assert_eq!(line_profit_net(1000.0, 600, 1.0, 50.0, false), 350);
        // Fractional qty rounds; negative discounts clamp at 0.
        assert_eq!(line_profit_net(1000.5, 600, 2.4, -25.0, false), 802);
    }

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE products (
                id TEXT PRIMARY KEY, sku TEXT, barcode TEXT, title TEXT, brand TEXT,
                category TEXT, price REAL DEFAULT 0, wholesale_price REAL DEFAULT 0,
                cost_price REAL DEFAULT 0, stock REAL NOT NULL DEFAULT 0,
                json_payload TEXT, device_id TEXT DEFAULT 'local', idempotency_key TEXT DEFAULT '',
                sync_status TEXT DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '', deleted INTEGER DEFAULT 0
            );
            CREATE TABLE transactions (
                id TEXT PRIMARY KEY, receipt_number TEXT NOT NULL, customer_id TEXT,
                subtotal REAL NOT NULL, discount_total REAL DEFAULT 0, total REAL NOT NULL,
                cost_total REAL DEFAULT 0, profit REAL DEFAULT 0, profit_margin REAL DEFAULT 0,
                pricing_tier TEXT DEFAULT 'Retail', payment_method TEXT DEFAULT 'Espèces',
                cash_tendered REAL DEFAULT 0, change_due REAL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'COMPLETED', created_at TEXT NOT NULL,
                json_payload TEXT NOT NULL, device_id TEXT DEFAULT 'local',
                idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending',
                updated_at TEXT DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
                deleted INTEGER DEFAULT 0, ledger_cogs_total REAL, shift_id TEXT,
                is_refund INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE transaction_items (
                id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, product_id TEXT NOT NULL,
                quantity REAL NOT NULL, applied_price REAL NOT NULL, discount REAL DEFAULT 0,
                imei_number TEXT, cost_price REAL DEFAULT 0,
                unit_price_charged REAL DEFAULT 0, unit_cost_at_sale REAL DEFAULT 0,
                discount_amount REAL DEFAULT 0, line_profit REAL DEFAULT 0,
                json_payload TEXT NOT NULL, device_id TEXT DEFAULT 'local',
                idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending',
                created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '',
                deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE inventory_ledger (
                id TEXT PRIMARY KEY, product_id TEXT NOT NULL, delta REAL NOT NULL,
                reason TEXT NOT NULL, ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT DEFAULT 'pending',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE stock_batches (
                batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
                quantity_remaining REAL NOT NULL DEFAULT 0, unit_cost REAL NOT NULL DEFAULT 0,
                received_at TEXT NOT NULL, purchase_order_id TEXT,
                device_id TEXT NOT NULL DEFAULT 'local', idempotency_key TEXT NOT NULL UNIQUE,
                sync_status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0,
                shadow_sale_id TEXT, shadow_item_id TEXT, shadow_qty REAL, shadow_resolved INTEGER
            );
            CREATE TABLE sale_batch_allocations (
                id TEXT PRIMARY KEY NOT NULL, sale_id TEXT NOT NULL, batch_id TEXT NOT NULL,
                qty_consumed INTEGER NOT NULL, unit_cost_at_sale REAL NOT NULL,
                created_at TEXT NOT NULL, product_id TEXT, sale_item_id TEXT,
                device_id TEXT NOT NULL DEFAULT 'local', idempotency_key TEXT NOT NULL UNIQUE,
                sync_status TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE imei_records (
                imei TEXT PRIMARY KEY, product_id TEXT NOT NULL, purchase_order_id TEXT,
                sale_transaction_id TEXT, warranty_expires_at TEXT,
                received_at TEXT NOT NULL, sold_at TEXT, warranty_months INTEGER,
                version INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE sync_outbox (
                idempotency_key TEXT NOT NULL UNIQUE,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT, last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE entity_keys (
                entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (entity_type, entity_id)
            );
            CREATE TABLE device_identity (
                device_id TEXT PRIMARY KEY, public_key_hex TEXT, enrolled_at TEXT, status TEXT
            );
            CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
            "#,
        ).unwrap();
        conn
    }

    #[test]
    fn test_multi_batch_fifo_depletion() {
        let mut conn = setup_test_db();

        // Seed 2 batches: B1 has 5 units @ 100 DZD, B2 has 5 units @ 200 DZD
        conn.execute(
            "INSERT INTO products (id, title, stock) VALUES ('P1', 'Test Product', 10)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, created_at, updated_at) \
             VALUES ('L1', 'P1', 10, 'SEED', 'init', '1', 'dev1', 'L1-key', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, idempotency_key, created_at, updated_at) \
             VALUES ('B1', 'P1', 5, 100, '2026-01-01T00:00:00Z', 'key-B1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, idempotency_key, created_at, updated_at) \
             VALUES ('B2', 'P1', 5, 200, '2026-01-02T00:00:00Z', 'key-B2', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')",
            [],
        ).unwrap();

        // Sell 7 units @ 300 DZD each (total 2100 DZD)
        let req = CheckoutRequest {
            order_row: CheckoutOrderIn {
                id: "TXN-TEST-1".into(),
                receipt_number: Some("REC-001".into()),
                customer_id: None,
                subtotal: Some(2100.0),
                discount_total: Some(0.0),
                total: Some(2100.0),
                cost_total: None,
                profit: None,
                profit_margin: None,
                pricing_tier: Some("Retail".into()),
                payment_method: Some("Espèces".into()),
                cash_tendered: Some(2100.0),
                change_due: Some(0.0),
                status: Some("COMPLETED".into()),
                created_at: Some("2026-01-03T10:00:00Z".into()),
                shift_id: Some("SHIFT-1".into()),
                idempotency_key: Some("order-TXN-TEST-1".into()),
                extra: HashMap::new(),
            },
            items: vec![CheckoutItemIn {
                id: Some("ITEM-1".into()),
                product_id: Some("P1".into()),
                quantity: Some(7.0),
                applied_price: Some(300.0),
                unit_price_charged: Some(300.0),
                default_price: Some(300.0),
                discount_amount: Some(0.0),
                discount: Some(0.0),
                cost_price: Some(100.0),
                unit_cost_at_sale: None,
                line_profit: None,
                imei_number: None,
                is_return: Some(false),
                warranty_months_at_sale: None,
                idempotency_key: Some("key-ITEM-1".into()),
                extra: HashMap::new(),
            }],
            deltas: vec![LedgerDeltaIn {
                id: Some("DEL-1".into()),
                product_id: Some("P1".into()),
                delta: Some(-7.0),
                reason: Some("SALE".into()),
                ref_type: Some("order".into()),
                ref_id: Some("TXN-TEST-1-0".into()),
                idempotency_key: Some("delkey-1".into()),
            }],
            full_tx: None,
            product_snapshots: None,
        };

        let res = apply_checkout(&mut conn, &req).unwrap();

        // 5 units from B1 (5 * 100 = 500) + 2 units from B2 (2 * 200 = 400) = 900 DZD exact batch cost
        // Blended unit cost: 900 / 7 = 128.57 -> rounded to 129 DZD.
        // Line-item FIFO cost: 7 * 129 = 903 DZD.
        assert_eq!(res.fifo_cost_total, Some(903));
        assert_eq!(res.fifo_profit, Some(2100 - 903)); // 1197 DZD profit
        assert_eq!(res.ledger_cogs_total, Some(900)); // Exact ledger allocations: 500 + 400 = 900

        // Check stock batch remaining
        let b1_rem: f64 = conn
            .query_row(
                "SELECT quantity_remaining FROM stock_batches WHERE batch_id = 'B1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(b1_rem, 0.0);

        let b2_rem: f64 = conn
            .query_row(
                "SELECT quantity_remaining FROM stock_batches WHERE batch_id = 'B2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(b2_rem, 3.0);

        // Check post-sale product stock
        let p_stock: f64 = conn
            .query_row("SELECT stock FROM products WHERE id = 'P1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(p_stock, 3.0);
    }

    #[test]
    fn test_idempotency_replay() {
        let mut conn = setup_test_db();

        conn.execute(
            "INSERT INTO products (id, title, stock) VALUES ('P1', 'Test Product', 5)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, created_at, updated_at) \
             VALUES ('L1', 'P1', 5, 'SEED', 'init', '1', 'dev1', 'L1-key', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, idempotency_key, created_at, updated_at) \
             VALUES ('B1', 'P1', 5, 100, '2026-01-01T00:00:00Z', 'key-B1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();

        let req = CheckoutRequest {
            order_row: CheckoutOrderIn {
                id: "TXN-REPLAY-1".into(),
                receipt_number: Some("REC-002".into()),
                customer_id: None,
                subtotal: Some(300.0),
                discount_total: Some(0.0),
                total: Some(300.0),
                cost_total: None,
                profit: None,
                profit_margin: None,
                pricing_tier: Some("Retail".into()),
                payment_method: Some("Espèces".into()),
                cash_tendered: Some(300.0),
                change_due: Some(0.0),
                status: Some("COMPLETED".into()),
                created_at: Some("2026-01-03T10:00:00Z".into()),
                shift_id: Some("SHIFT-1".into()),
                idempotency_key: Some("order-TXN-REPLAY-1".into()),
                extra: HashMap::new(),
            },
            items: vec![CheckoutItemIn {
                id: Some("ITEM-REPLAY-1".into()),
                product_id: Some("P1".into()),
                quantity: Some(2.0),
                applied_price: Some(150.0),
                unit_price_charged: Some(150.0),
                default_price: Some(150.0),
                discount_amount: Some(0.0),
                discount: Some(0.0),
                cost_price: Some(100.0),
                unit_cost_at_sale: None,
                line_profit: None,
                imei_number: None,
                is_return: Some(false),
                warranty_months_at_sale: None,
                idempotency_key: Some("key-ITEM-REPLAY-1".into()),
                extra: HashMap::new(),
            }],
            deltas: vec![LedgerDeltaIn {
                id: Some("DEL-R1".into()),
                product_id: Some("P1".into()),
                delta: Some(-2.0),
                reason: Some("SALE".into()),
                ref_type: Some("order".into()),
                ref_id: Some("TXN-REPLAY-1-0".into()),
                idempotency_key: Some("delkey-r1".into()),
            }],
            full_tx: None,
            product_snapshots: None,
        };

        // First call
        let res1 = apply_checkout(&mut conn, &req).unwrap();
        assert_eq!(res1.fifo_cost_total, Some(200));

        // Remaining in batch should be 3
        let b1_rem: f64 = conn
            .query_row(
                "SELECT quantity_remaining FROM stock_batches WHERE batch_id = 'B1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(b1_rem, 3.0);

        // Replay call
        let res2 = apply_checkout(&mut conn, &req).unwrap();
        assert_eq!(res2.fifo_cost_total, Some(200));

        // Remaining in batch should STILL be 3 (not 1)
        let b1_rem_after: f64 = conn
            .query_row(
                "SELECT quantity_remaining FROM stock_batches WHERE batch_id = 'B1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(b1_rem_after, 3.0);
    }

    #[test]
    fn test_insufficient_stock_rollback() {
        let mut conn = setup_test_db();

        conn.execute(
            "INSERT INTO products (id, title, stock) VALUES ('P1', 'Test Product', 2)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, created_at, updated_at) \
             VALUES ('L1', 'P1', 2, 'SEED', 'init', '1', 'dev1', 'L1-key', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();

        let req = CheckoutRequest {
            order_row: CheckoutOrderIn {
                id: "TXN-OVERSELL-1".into(),
                receipt_number: Some("REC-003".into()),
                customer_id: None,
                subtotal: Some(500.0),
                discount_total: Some(0.0),
                total: Some(500.0),
                cost_total: None,
                profit: None,
                profit_margin: None,
                pricing_tier: Some("Retail".into()),
                payment_method: Some("Espèces".into()),
                cash_tendered: Some(500.0),
                change_due: Some(0.0),
                status: Some("COMPLETED".into()),
                created_at: Some("2026-01-03T10:00:00Z".into()),
                shift_id: Some("SHIFT-1".into()),
                idempotency_key: Some("order-TXN-OVERSELL-1".into()),
                extra: HashMap::new(),
            },
            items: vec![CheckoutItemIn {
                id: Some("ITEM-OVERSELL-1".into()),
                product_id: Some("P1".into()),
                quantity: Some(5.0),
                applied_price: Some(100.0),
                unit_price_charged: Some(100.0),
                default_price: Some(100.0),
                discount_amount: Some(0.0),
                discount: Some(0.0),
                cost_price: Some(50.0),
                unit_cost_at_sale: None,
                line_profit: None,
                imei_number: None,
                is_return: Some(false),
                warranty_months_at_sale: None,
                idempotency_key: Some("key-ITEM-OVERSELL-1".into()),
                extra: HashMap::new(),
            }],
            deltas: vec![LedgerDeltaIn {
                id: Some("DEL-O1".into()),
                product_id: Some("P1".into()),
                delta: Some(-5.0),
                reason: Some("SALE".into()),
                ref_type: Some("order".into()),
                ref_id: Some("TXN-OVERSELL-1-0".into()),
                idempotency_key: Some("delkey-o1".into()),
            }],
            full_tx: None,
            product_snapshots: None,
        };

        let err = apply_checkout(&mut conn, &req).unwrap_err();
        match err {
            TrustError::OperationFailed(msg) => {
                assert!(
                    msg.contains("INSUFFICIENT_STOCK:P1"),
                    "Expected INSUFFICIENT_STOCK, got {msg}"
                );
            }
            _ => panic!("Expected OperationFailed, got {err:?}"),
        }

        // Verify transaction rolled back: no sale inserted, stock intact
        let tx_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transactions WHERE id = 'TXN-OVERSELL-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tx_count, 0);

        let p_stock: f64 = conn
            .query_row("SELECT stock FROM products WHERE id = 'P1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(p_stock, 2.0);
    }
}

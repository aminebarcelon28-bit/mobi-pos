//! Native FIFO shadow reconciliation (SEC-01 / ADR-005).
//!
//! When a sale oversells, the checkout kernel records a `SHADOW` batch marker with
//! `shadow_sale_id` / `shadow_item_id` / `shadow_qty`. Later, when real stock
//! arrives, the reconcile consumes real batches oldest-first and rewrites the
//! sale's cost basis: the line's `unit_cost_at_sale`, the ticket's `cost_total` /
//! `profit` / margin, the `sale_batch_allocations` ledger and `ledger_cogs_total`.
//!
//! This mirrors `reconcileShadowBatches` statement-for-statement, with the same
//! guards:
//!
//!   * coverage pre-check — a shadow is only touched when the live batches fully
//!     cover it (a partial cover leaves the marker open and the batches untouched);
//!   * guarded depletion — `quantity_remaining >= want AND deleted = 0`;
//!   * cost basis — the line becomes
//!     `round((oldUnit*qty - shadowUnit*shadowQty + takenCost) / qty)`, so the
//!     phantom units' cost is replaced by what was actually consumed;
//!   * envelopes for the batch depletions, the line, the order and the resolved
//!     shadow, plus the allocation rows and `ledger_cogs_total`.
//!
//! The peer-claim coordination (`tryClaimCompensation`) stays in TypeScript: it is
//! a best-effort cross-tab guard that already proceeds unclaimed when offline, so
//! it is called before the native transaction rather than inside it.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileRequest {
    pub product_id: Option<String>,
    pub device_id: String,
    pub now: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileOutcome {
    pub shadow_batch_id: String,
    pub sale_id: String,
    pub item_id: String,
    pub quantity: i64,
    pub old_unit_cost: i64,
    pub new_unit_cost: i64,
    pub taken_cost: f64,
    pub takes: Vec<ReconcileTake>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileTake {
    pub batch_id: String,
    pub quantity: i64,
    pub unit_cost: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub reconciled: usize,
    pub outcomes: Vec<ReconcileOutcome>,
    pub sale_ids: Vec<String>,
    pub product_ids: Vec<String>,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("fifo app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("fifo open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("fifo busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("fifo fk: {e}")))?;
    Ok(conn)
}

fn round_money(v: f64) -> i64 {
    // TS Math.round for the values this lane produces (positive money).
    if v >= 0.0 {
        (v + 0.5).floor() as i64
    } else {
        (v - 0.5).ceil() as i64
    }
}

fn bump_version(current: Option<i64>) -> i64 {
    match current {
        Some(n) if n >= 1 => n + 1,
        _ => 2,
    }
}

struct Shadow {
    batch_id: String,
    product_id: String,
    unit_cost: f64,
    sale_id: String,
    item_id: String,
    qty: i64,
}

fn load_shadow(tx: &rusqlite::Transaction<'_>, batch_id: &str) -> Option<Shadow> {
    tx.query_row(
        "SELECT product_id, unit_cost, shadow_sale_id, shadow_item_id, COALESCE(shadow_qty, 0)
           FROM stock_batches WHERE batch_id = ?1",
        rusqlite::params![batch_id],
        |r| {
            let product_id: String = r.get(0)?;
            let unit_cost: f64 = r.get(1)?;
            let sale_id: Option<String> = r.get(2)?;
            let item_id: Option<String> = r.get(3)?;
            let qty: i64 = r.get(4)?;
            match (sale_id, item_id) {
                (Some(s), Some(i)) if qty > 0 => Ok(Some(Shadow {
                    batch_id: batch_id.to_string(),
                    product_id,
                    unit_cost: unit_cost.max(0.0),
                    sale_id: s,
                    item_id: i,
                    qty,
                })),
                _ => Ok(None),
            }
        },
    )
    .ok()
    .flatten()
}

fn enqueue(
    tx: &rusqlite::Transaction<'_>,
    key: &str,
    entity_type: &str,
    entity_id: &str,
    payload: &str,
    now: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES (?1, ?2, ?3, 'UPSERT', ?4, 'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending',
           retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=?5",
        rusqlite::params![key, entity_type, entity_id, payload, now],
    )
    .map_err(|e| format!("reconcile outbox {entity_type}: {e}"))?;
    Ok(())
}

/// Consume live batches for one shadow, oldest first. Returns the takes, or None
/// when the live stock does not fully cover the shadow (marker stays open).
fn deplete(
    tx: &rusqlite::Transaction<'_>,
    shadow: &Shadow,
    device_id: &str,
    now: &str,
) -> Result<Option<(Vec<ReconcileTake>, i64)>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT batch_id, quantity_remaining, unit_cost, received_at, purchase_order_id, created_at, device_id
               FROM stock_batches
              WHERE product_id = ?1 AND quantity_remaining > 0 AND deleted = 0
                AND (purchase_order_id IS NULL OR purchase_order_id != 'SHADOW')
              ORDER BY received_at ASC, batch_id ASC",
        )
        .map_err(|e| format!("reconcile live read: {e}"))?;
    struct Live {
        batch_id: String,
        qty: i64,
        unit_cost: f64,
        received_at: Option<String>,
        purchase_order_id: Option<String>,
        created_at: Option<String>,
        device_id: Option<String>,
    }
    let live: Vec<Live> = stmt
        .query_map(rusqlite::params![shadow.product_id], |r| {
            Ok(Live {
                batch_id: r.get(0)?,
                qty: r.get(1)?,
                unit_cost: r.get(2)?,
                received_at: r.get(3)?,
                purchase_order_id: r.get(4)?,
                created_at: r.get(5)?,
                device_id: r.get(6)?,
            })
        })
        .map_err(|e| format!("reconcile live query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let total_avail: i64 = live.iter().map(|b| b.qty.max(0)).sum();
    if total_avail < shadow.qty {
        return Ok(None);
    }

    let mut need = shadow.qty;
    let mut takes = Vec::new();
    let mut taken_cost = 0.0f64;
    for b in &live {
        if need <= 0 {
            break;
        }
        let avail = b.qty.max(0);
        let want = avail.min(need);
        if want <= 0 {
            continue;
        }
        let changed = tx
            .execute(
                "UPDATE stock_batches
                    SET quantity_remaining = quantity_remaining - ?1, version = version + 1,
                        updated_at = ?2, sync_status = 'pending'
                  WHERE batch_id = ?3 AND quantity_remaining >= ?1 AND deleted = 0",
                rusqlite::params![want, now, b.batch_id],
            )
            .map_err(|e| format!("reconcile deplete: {e}"))?;
        if changed == 0 {
            continue;
        }
        let (remaining, version, unit_cost, received_at, po, created_at, dev): (
            i64,
            i64,
            f64,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = tx
            .query_row(
                "SELECT quantity_remaining, COALESCE(version, 1), unit_cost, received_at,
                        purchase_order_id, created_at, device_id
                   FROM stock_batches WHERE batch_id = ?1",
                rusqlite::params![b.batch_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .map_err(|e| format!("reconcile deplete read: {e}"))?;
        let payload = serde_json::json!({
            "version": version,
            "batch_id": b.batch_id,
            "product_id": shadow.product_id,
            "quantity_remaining": remaining,
            "unit_cost": unit_cost,
            "received_at": received_at.clone().or(b.received_at.clone()),
            "purchase_order_id": po.clone().or(b.purchase_order_id.clone()),
            "created_at": created_at.clone().or(b.created_at.clone()),
            "device_id": dev.clone().or(b.device_id.clone()).unwrap_or_else(|| device_id.to_string()),
            "updated_at": now,
        })
        .to_string();
        enqueue(
            tx,
            &format!("sb-{}-recon-{}", b.batch_id, shadow.batch_id),
            "stock_batches",
            &b.batch_id,
            &payload,
            now,
        )?;
        need -= want;
        taken_cost += want as f64 * unit_cost;
        takes.push(ReconcileTake {
            batch_id: b.batch_id.clone(),
            quantity: want,
            unit_cost,
        });
    }
    if need > 0 {
        // A cross-tab race consumed stock between the coverage check and the
        // guarded depletes: leave the marker open rather than half-accounting.
        return Err("RECONCILE_PARTIAL_COVER".to_string());
    }
    Ok(Some((takes, taken_cost as i64)))
}

/// Reconcile every unresolved shadow (optionally for one product) in ONE
/// transaction. Returns what was rewritten so the caller can mirror it.
pub fn reconcile_shadow_batches_core(
    conn: &mut Connection,
    req: &ReconcileRequest,
) -> Result<ReconcileReport, String> {
    let tx = conn.transaction().map_err(|e| format!("reconcile tx: {e}"))?;

    let mut stmt = tx
        .prepare(
            "SELECT batch_id FROM stock_batches
              WHERE purchase_order_id = 'SHADOW' AND deleted = 0 AND shadow_resolved = 0
                AND (?1 IS NULL OR product_id = ?1)
              ORDER BY received_at ASC, batch_id ASC",
        )
        .map_err(|e| format!("reconcile shadows: {e}"))?;
    let shadow_ids: Vec<String> = stmt
        .query_map(rusqlite::params![req.product_id], |r| r.get::<_, String>(0))
        .map_err(|e| format!("reconcile shadow query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    let mut report = ReconcileReport::default();
    for shadow_id in shadow_ids {
        let Some(shadow) = load_shadow(&tx, &shadow_id) else {
            continue;
        };
        let Some((takes, taken_cost)) = deplete(&tx, &shadow, &req.device_id, &req.now)? else {
            continue; // partial cover: shadow stays open, batches untouched
        };

        // ── line: recompute the cost basis at the REAL consumed cost ──────
        let line: Option<(String, i64, f64, f64, String, String, Option<i64>)> = tx
            .query_row(
                "SELECT transaction_id, quantity, COALESCE(unit_price_charged, applied_price, 0),
                        COALESCE(unit_cost_at_sale, 0), COALESCE(json_payload, '{}'),
                        COALESCE(idempotency_key, ''), version
                   FROM transaction_items WHERE id = ?1",
                rusqlite::params![shadow.item_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .ok();
        let Some((sale_id, line_qty, charged, old_unit, payload_raw, line_key, line_version)) = line
        else {
            continue;
        };
        let line_qty = line_qty.max(1);
        let old_unit = round_money(old_unit as f64);
        let new_unit = round_money(
            (old_unit as f64 * line_qty as f64 - shadow.unit_cost * shadow.qty as f64
                + taken_cost as f64)
                / line_qty as f64,
        );
        let diff_cogs = (new_unit - old_unit) * line_qty;

        let mut payload: serde_json::Value =
            serde_json::from_str(&payload_raw).unwrap_or_else(|_| serde_json::json!({}));
        if !payload.is_object() {
            payload = serde_json::json!({});
        }
        let discount = payload
            .get("discount")
            .and_then(|v| v.as_f64())
            .map(|v| round_money(v).max(0))
            .unwrap_or(0);
        let is_return = payload
            .get("is_return")
            .or_else(|| payload.get("isReturn"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let signed_qty = if is_return { -line_qty } else { line_qty };
        let line_profit = (round_money(charged).max(0) - new_unit) * signed_qty
            - if is_return { -discount } else { discount };
        let prior: Vec<serde_json::Value> = payload
            .get("fifo_allocations")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut merged: Vec<serde_json::Value> = prior
            .into_iter()
            .filter(|a| {
                let id = a.get("batchId").and_then(|v| v.as_str()).unwrap_or("");
                id != shadow.batch_id && id != "unbatched"
            })
            .collect();
        for t in &takes {
            merged.push(serde_json::json!({
                "batchId": t.batch_id,
                "quantity": t.quantity,
                "unitCost": t.unit_cost,
            }));
        }
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("unit_cost_at_sale".to_string(), serde_json::json!(new_unit));
            obj.insert("line_profit".to_string(), serde_json::json!(line_profit));
            obj.insert("fifo_allocations".to_string(), serde_json::json!(merged));
        }
        let line_payload = payload.to_string();
        let next_line_version = bump_version(line_version);
        tx.execute(
            "UPDATE transaction_items
                SET unit_cost_at_sale = ?1, line_profit = ?2, json_payload = ?3,
                    version = ?4, updated_at = ?5, sync_status = 'pending'
              WHERE id = ?6",
            rusqlite::params![new_unit, line_profit, line_payload, next_line_version, req.now, shadow.item_id],
        )
        .map_err(|e| format!("reconcile line: {e}"))?;
        let key = if line_key.is_empty() {
            format!("recon-{}", shadow.item_id)
        } else {
            line_key
        };
        enqueue(&tx, &key, "order_item", &shadow.item_id, &line_payload, &req.now)?;

        // ── order: cost_total += diff, profit/margin follow ───────────────
        let order: Option<(i64, i64, String, String, Option<i64>)> = tx
            .query_row(
                "SELECT COALESCE(total, 0), COALESCE(cost_total, 0), COALESCE(json_payload, '{}'),
                        COALESCE(idempotency_key, ''), version
                   FROM transactions WHERE id = ?1",
                rusqlite::params![sale_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .ok();
        if let Some((total, cost_total, order_payload_raw, order_key, order_version)) = order {
            let new_cost = cost_total + diff_cogs;
            let new_profit = total - new_cost;
            let margin = if total > 0 {
                (new_profit as f64 / total as f64 * 100.0 * 10.0).round() / 10.0
            } else {
                0.0
            };
            let next_order_version = bump_version(order_version);
            let mut op: serde_json::Value =
                serde_json::from_str(&order_payload_raw).unwrap_or_else(|_| serde_json::json!({}));
            if !op.is_object() {
                op = serde_json::json!({});
            }
            if let Some(obj) = op.as_object_mut() {
                obj.insert("costTotal".to_string(), serde_json::json!(new_cost));
                obj.insert("cost_total".to_string(), serde_json::json!(new_cost));
                obj.insert("profit".to_string(), serde_json::json!(new_profit));
                obj.insert("profitMargin".to_string(), serde_json::json!(margin));
                obj.insert("profit_margin".to_string(), serde_json::json!(margin));
                obj.insert("version".to_string(), serde_json::json!(next_order_version));
            }
            let order_payload = op.to_string();
            tx.execute(
                "UPDATE transactions
                    SET cost_total = ?1, profit = ?2, profit_margin = ?3, json_payload = ?4,
                        version = ?5, updated_at = ?6, sync_status = 'pending'
                  WHERE id = ?7",
                rusqlite::params![new_cost, new_profit, margin, order_payload, next_order_version, req.now, sale_id],
            )
            .map_err(|e| format!("reconcile order: {e}"))?;
            let key = if order_key.is_empty() {
                format!("order-{sale_id}")
            } else {
                order_key
            };
            enqueue(&tx, &key, "order", &sale_id, &order_payload, &req.now)?;
        }

        // ── resolve the marker (tombstone + envelope) ─────────────────────
        let shadow_version: Option<i64> = tx
            .query_row(
                "SELECT version FROM stock_batches WHERE batch_id = ?1",
                rusqlite::params![shadow.batch_id],
                |r| r.get(0),
            )
            .ok();
        let resolved_version = bump_version(shadow_version);
        tx.execute(
            "UPDATE stock_batches SET deleted = 1, shadow_resolved = 1, version = ?1,
                    updated_at = ?2, sync_status = 'pending'
              WHERE batch_id = ?3",
            rusqlite::params![resolved_version, req.now, shadow.batch_id],
        )
        .map_err(|e| format!("reconcile resolve: {e}"))?;

        // ── allocation ledger swap + materialised COGS ────────────────────
        tx.execute(
            "DELETE FROM sale_batch_allocations WHERE sale_id = ?1 AND batch_id = ?2",
            rusqlite::params![sale_id, shadow.batch_id],
        )
        .map_err(|e| format!("reconcile alloc delete: {e}"))?;
        for t in &takes {
            let alloc_id = format!("alloc-{}-{}-{}-recon", sale_id, shadow.item_id, t.batch_id);
            tx.execute(
                "INSERT INTO sale_batch_allocations
                   (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale, created_at,
                    product_id, sale_item_id, device_id, idempotency_key, sync_status,
                    version, updated_at, deleted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?1, 'pending', 1, ?6, 0)
                 ON CONFLICT(id) DO NOTHING",
                rusqlite::params![
                    alloc_id,
                    sale_id,
                    t.batch_id,
                    t.quantity,
                    round_money(t.unit_cost).max(0),
                    req.now,
                    shadow.product_id,
                    shadow.item_id,
                    req.device_id
                ],
            )
            .map_err(|e| format!("reconcile alloc insert: {e}"))?;
        }
        let ledger_sum: i64 = tx
            .query_row(
                "SELECT COALESCE(SUM(qty_consumed * unit_cost_at_sale), 0)
                   FROM sale_batch_allocations WHERE sale_id = ?1 AND deleted = 0",
                rusqlite::params![sale_id],
                |r| r.get::<_, f64>(0),
            )
            .map(|v| round_money(v).max(0))
            .unwrap_or(0);
        let meta: Option<(String, String, Option<i64>)> = tx
            .query_row(
                "SELECT COALESCE(json_payload, '{}'), COALESCE(idempotency_key, ''), version
                   FROM transactions WHERE id = ?1",
                rusqlite::params![sale_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        if let Some((raw, key, version)) = meta {
            let mut p: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
            if !p.is_object() {
                p = serde_json::json!({});
            }
            let next = bump_version(version);
            if let Some(obj) = p.as_object_mut() {
                obj.insert("ledgerCogsTotal".to_string(), serde_json::json!(ledger_sum));
                obj.insert("ledger_cogs_total".to_string(), serde_json::json!(ledger_sum));
                obj.insert("version".to_string(), serde_json::json!(next));
            }
            let payload = p.to_string();
            tx.execute(
                "UPDATE transactions SET ledger_cogs_total = ?1, json_payload = ?2,
                        updated_at = ?3, sync_status = 'pending' WHERE id = ?4",
                rusqlite::params![ledger_sum, payload, req.now, sale_id],
            )
            .map_err(|e| format!("reconcile ledger cogs: {e}"))?;
            let key = if key.is_empty() { format!("order-{sale_id}") } else { key };
            enqueue(&tx, &key, "order", &sale_id, &payload, &req.now)?;
        }

        enqueue(
            &tx,
            &format!("sb-{}-resolved", shadow.batch_id),
            "stock_batches",
            &shadow.batch_id,
            &serde_json::json!({
                "version": resolved_version,
                "batch_id": shadow.batch_id,
                "product_id": shadow.product_id,
                "quantity_remaining": 0,
                "unit_cost": shadow.unit_cost,
                "updated_at": req.now,
                "purchase_order_id": "SHADOW",
                "device_id": req.device_id,
                "shadow_sale_id": shadow.sale_id,
                "shadow_item_id": shadow.item_id,
                "shadow_qty": shadow.qty,
                "shadow_resolved": 1,
                "deleted": 1,
            })
            .to_string(),
            &req.now,
        )?;

        report.reconciled += 1;
        if !report.sale_ids.contains(&sale_id) {
            report.sale_ids.push(sale_id.clone());
        }
        if !report.product_ids.contains(&shadow.product_id) {
            report.product_ids.push(shadow.product_id.clone());
        }
        report.outcomes.push(ReconcileOutcome {
            shadow_batch_id: shadow.batch_id,
            sale_id,
            item_id: shadow.item_id,
            quantity: shadow.qty,
            old_unit_cost: old_unit,
            new_unit_cost: new_unit,
            taken_cost: taken_cost as f64,
            takes,
        });
    }

    tx.commit().map_err(|e| format!("reconcile commit: {e}"))?;
    Ok(report)
}

#[tauri::command]
pub fn reconcile_shadow_batches(
    app: tauri::AppHandle,
    request: ReconcileRequest,
) -> Result<ReconcileReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "reconcile_shadow_batches",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let pending: i64 = {
                let conn = open_db(&app)?;
                conn.query_row(
                    "SELECT COUNT(*) FROM stock_batches
                      WHERE purchase_order_id = 'SHADOW' AND deleted = 0 AND shadow_resolved = 0",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0)
            };
            if pending == 0 {
                return Ok(ReconcileReport::default());
            }
            let mut conn = open_db(&app)?;
            reconcile_shadow_batches_core(&mut conn, &request).map_err(TrustError::op_failed)
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
                deleted INTEGER NOT NULL DEFAULT 0, shadow_sale_id TEXT, shadow_item_id TEXT,
                shadow_qty INTEGER NOT NULL DEFAULT 0, shadow_resolved INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE transaction_items (id TEXT PRIMARY KEY, transaction_id TEXT,
                quantity INTEGER, applied_price REAL, unit_price_charged REAL,
                unit_cost_at_sale REAL, discount_amount REAL, line_profit INTEGER,
                json_payload TEXT, idempotency_key TEXT, version INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT, sync_status TEXT);
             CREATE TABLE transactions (id TEXT PRIMARY KEY, total INTEGER, cost_total INTEGER,
                profit INTEGER, profit_margin REAL, ledger_cogs_total INTEGER,
                json_payload TEXT, idempotency_key TEXT, version INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT, sync_status TEXT);
             CREATE TABLE sale_batch_allocations (id TEXT PRIMARY KEY, sale_id TEXT, batch_id TEXT,
                qty_consumed INTEGER, unit_cost_at_sale INTEGER, created_at TEXT, product_id TEXT,
                sale_item_id TEXT, device_id TEXT, idempotency_key TEXT, sync_status TEXT,
                version INTEGER NOT NULL DEFAULT 1, updated_at TEXT,
                deleted INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT, last_error TEXT, updated_at TEXT);",
        )
        .expect("schema");
        conn
    }

    /// A sale of 3 units charged at 1000 each, costed at the phantom 900/unit
    /// (2700 total), plus one real batch of 3 at 700.
    fn scenario(real_qty: i64, real_cost: f64) -> Connection {
        let conn = seeded();
        conn.execute(
            "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
                purchase_order_id, version, created_at, updated_at, deleted,
                shadow_sale_id, shadow_item_id, shadow_qty, shadow_resolved)
             VALUES ('shadow-S1-0', 'P1', 0, 900, '2026-10-01', 'SHADOW', 1, '2026-10-01', '2026-10-01', 0,
                     'S1', 'S1-item-0', 3, 0)",
            [],
        )
        .unwrap();
        if real_qty > 0 {
            conn.execute(
                "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
                    purchase_order_id, device_id, version, created_at, updated_at, deleted)
                 VALUES ('B1', 'P1', ?1, ?2, '2026-10-05', 'PO1', 'dev', 1, '2026-10-05', '2026-10-05', 0)",
                rusqlite::params![real_qty, real_cost],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO transaction_items (id, transaction_id, quantity, applied_price, unit_price_charged,
                unit_cost_at_sale, line_profit, json_payload, idempotency_key, version)
             VALUES ('S1-item-0', 'S1', 3, 1000, 1000, 900, 300, '{\"discount\":0,\"fifo_allocations\":[{\"batchId\":\"shadow-S1-0\",\"quantity\":3}]}', 'oi-S1-0', 2)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transactions (id, total, cost_total, profit, profit_margin, json_payload,
                idempotency_key, version)
             VALUES ('S1', 3000, 2700, 300, 10.0, '{\"total\":3000,\"costTotal\":2700}', 'ord-S1', 3)",
            [],
        )
        .unwrap();
        conn
    }

    fn req() -> ReconcileRequest {
        ReconcileRequest {
            product_id: None,
            device_id: "dev".to_string(),
            now: "2026-11-06T10:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn reconcile_replaces_phantom_cost_with_the_real_batch_cost() {
        let mut conn = scenario(3, 700.0);
        let report = reconcile_shadow_batches_core(&mut conn, &req()).expect("reconcile");
        assert_eq!(report.reconciled, 1);
        let o = &report.outcomes[0];
        assert_eq!(o.quantity, 3);
        assert_eq!(o.old_unit_cost, 900);
        assert_eq!(o.new_unit_cost, 700, "(900*3 - 900*3 + 700*3) / 3");
        assert_eq!(o.takes.len(), 1);
        assert_eq!(o.takes[0].batch_id, "B1");
        assert_eq!(o.takes[0].quantity, 3);

        // Line: cost 700, profit (1000-700)*3 = 900.
        let (unit, profit, version): (i64, i64, i64) = conn
            .query_row(
                "SELECT CAST(unit_cost_at_sale AS INTEGER), line_profit, version FROM transaction_items WHERE id='S1-item-0'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(unit, 700);
        assert_eq!(profit, 900);
        assert_eq!(version, 3, "line version bumped");

        // Order: cost 2100, profit 900, margin 30.0, ledger COGS 2100.
        let (cost, profit, margin, ledger, version): (i64, i64, f64, i64, i64) = conn
            .query_row(
                "SELECT cost_total, profit, profit_margin, ledger_cogs_total, version FROM transactions WHERE id='S1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(cost, 2100);
        assert_eq!(profit, 900);
        assert_eq!(margin, 30.0);
        assert_eq!(ledger, 2100, "materialised from the allocation ledger");
        // Parity quirk preserved from the renderer: the materialisation step
        // stamps the bumped version into the PAYLOAD but its UPDATE does not set
        // the `version` column, so the row keeps the reconcile's bump (4).
        assert_eq!(version, 4, "order row version from the reconcile update");

        // Batch depleted to zero, marker resolved and tombstoned.
        let (batch_qty, batch_ver): (i64, i64) = conn
            .query_row("SELECT quantity_remaining, version FROM stock_batches WHERE batch_id='B1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(batch_qty, 0);
        assert_eq!(batch_ver, 2);
        let (resolved, deleted, marker_ver): (i64, i64, i64) = conn
            .query_row(
                "SELECT shadow_resolved, deleted, version FROM stock_batches WHERE batch_id='shadow-S1-0'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(resolved, 1);
        assert_eq!(deleted, 1);
        assert_eq!(marker_ver, 2);

        // Allocation ledger swapped to the real batch with its unit cost.
        let allocs: Vec<(String, i64, i64)> = conn
            .prepare("SELECT batch_id, qty_consumed, unit_cost_at_sale FROM sale_batch_allocations WHERE sale_id='S1'")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(allocs, vec![("B1".to_string(), 3, 700)]);
    }

    #[test]
    fn a_partial_cover_leaves_the_marker_open_and_the_batches_untouched() {
        let mut conn = scenario(2, 700.0);
        let report = reconcile_shadow_batches_core(&mut conn, &req()).expect("reconcile");
        assert_eq!(report.reconciled, 0, "2 units cannot cover a 3-unit shadow");
        let (qty, resolved): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT quantity_remaining FROM stock_batches WHERE batch_id='B1'), shadow_resolved FROM stock_batches WHERE batch_id='shadow-S1-0'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(qty, 2, "the real batch was not burned");
        assert_eq!(resolved, 0);
        let cost: i64 = conn
            .query_row("SELECT cost_total FROM transactions WHERE id='S1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cost, 2700, "no accounting happened");
    }

    #[test]
    fn a_second_reconcile_is_a_no_op() {
        let mut conn = scenario(3, 700.0);
        assert_eq!(reconcile_shadow_batches_core(&mut conn, &req()).unwrap().reconciled, 1);
        let again = reconcile_shadow_batches_core(&mut conn, &req()).expect("second");
        assert_eq!(again.reconciled, 0, "the marker is resolved and tombstoned");
        let cost: i64 = conn
            .query_row("SELECT cost_total FROM transactions WHERE id='S1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cost, 2100, "the basis does not drift on a retry");
    }

    #[test]
    fn multiple_batches_are_consumed_oldest_first_and_costed_by_weight() {
        let mut conn = scenario(1, 600.0);
        conn.execute(
            "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
                purchase_order_id, device_id, version, created_at, updated_at, deleted)
             VALUES ('B2', 'P1', 2, 800, '2026-10-10', 'PO1', 'dev', 1, '2026-10-10', '2026-10-10', 0)",
            [],
        )
        .unwrap();
        let report = reconcile_shadow_batches_core(&mut conn, &req()).expect("reconcile");
        let o = &report.outcomes[0];
        assert_eq!(o.takes.len(), 2);
        assert_eq!(o.takes[0].batch_id, "B1");
        assert_eq!(o.takes[0].quantity, 1);
        assert_eq!(o.takes[1].batch_id, "B2");
        assert_eq!(o.takes[1].quantity, 2);
        // (900*3 - 900*3 + (1*600 + 2*800)) / 3 = 2200/3 = 733.33 -> 733
        assert_eq!(o.new_unit_cost, 733);
        let cost: i64 = conn
            .query_row("SELECT cost_total FROM transactions WHERE id='S1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cost, 2700 + (733 - 900) * 3, "cost_total tracks the real weight");
    }

    #[test]
    fn a_failing_envelope_rolls_the_whole_reconcile_back() {
        let mut conn = scenario(3, 700.0);
        conn.execute_batch("DROP TABLE sync_outbox;").unwrap();
        let err = reconcile_shadow_batches_core(&mut conn, &req()).expect_err("must roll back");
        assert!(err.contains("outbox"), "{err}");
        let (cost, resolved): (i64, i64) = conn
            .query_row(
                "SELECT (SELECT cost_total FROM transactions WHERE id='S1'), shadow_resolved FROM stock_batches WHERE batch_id='shadow-S1-0'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(cost, 2700);
        assert_eq!(resolved, 0);
    }
}

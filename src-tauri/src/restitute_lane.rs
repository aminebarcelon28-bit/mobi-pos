//! Native stock restitution lane (SEC-01 / ADR-005).
//!
//! Refunds and voids put units back on the shelf. The renderer did it inside a
//! `BEGIN IMMEDIATE` with an OCC loop per allocation, and it is money-relevant:
//! a restock must land on the *original* batch at its original unit cost, or
//! fall through to a `REFUND` batch at that same cost — never at the shadow
//! marker's cost, never on a tombstoned row, and never twice for one seed.
//!
//! Everything below mirrors that statement-for-statement:
//!
//!   * live batch → `quantity_remaining += qty`, `version + 1`, guarded by the
//!     version we read (a lost race re-reads once, then fails retryably);
//!   * shadow marker (`shadow-…`), tombstoned or missing batch → mint a
//!     `REFUND` batch at the allocation's unit cost, id deterministic from the
//!     seed so a retry converges instead of minting twins;
//!   * each write gets its `stock_batches` envelope carrying the committed
//!     version.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestitutionAllocation {
    pub batch_id: Option<String>,
    pub product_id: String,
    pub quantity: i64,
    pub unit_cost: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestituteRequest {
    pub allocations: Vec<RestitutionAllocation>,
    /// `void-<txId>` / `ref-<refundId>`: makes batch ids and envelope keys
    /// deterministic so a racing peer converges instead of double-restoring.
    pub seed: Option<String>,
    pub device_id: String,
    pub now: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestitutionOutcome {
    pub batch_id: String,
    pub product_id: String,
    pub quantity_remaining: i64,
    pub unit_cost: f64,
    pub version: i64,
    /// "restored" | "refund" | "skipped"
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestituteReport {
    pub outcomes: Vec<RestitutionOutcome>,
    pub product_ids: Vec<String>,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("restitute app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("restitute open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("restitute busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("restitute fk: {e}")))?;
    Ok(conn)
}

struct LiveBatch {
    quantity: i64,
    unit_cost: f64,
    version: i64,
}

fn read_live(tx: &rusqlite::Transaction<'_>, batch_id: &str) -> Option<LiveBatch> {
    tx.query_row(
        "SELECT quantity_remaining, unit_cost, COALESCE(version, 1) FROM stock_batches
          WHERE batch_id = ?1 AND (deleted = 0 OR deleted IS NULL)",
        rusqlite::params![batch_id],
        |r| {
            Ok(LiveBatch {
                quantity: r.get(0)?,
                unit_cost: r.get(1)?,
                version: r.get(2)?,
            })
        },
    )
    .ok()
}

fn bump_batch(
    tx: &rusqlite::Transaction<'_>,
    batch_id: &str,
    qty: i64,
    now: &str,
) -> Result<Option<LiveBatch>, String> {
    let Some(base) = read_live(tx, batch_id) else {
        return Ok(None);
    };
    let next = base.quantity + qty;
    let changed = tx
        .execute(
            "UPDATE stock_batches
                SET quantity_remaining = ?1, version = version + 1, updated_at = ?2,
                    sync_status = 'pending'
              WHERE batch_id = ?3 AND version = ?4",
            rusqlite::params![next, now, batch_id, base.version],
        )
        .map_err(|e| format!("restitute update: {e}"))?;
    if changed == 1 {
        return Ok(Some(LiveBatch {
            quantity: next,
            unit_cost: base.unit_cost,
            version: base.version + 1,
        }));
    }
    // Lost the OCC race: re-read once and retry on the fresh version. A second
    // miss is sustained contention, which must surface as retryable (code 5).
    let Some(fresh) = read_live(tx, batch_id) else {
        return Ok(None);
    };
    let retry_qty = fresh.quantity + qty;
    let retried = tx
        .execute(
            "UPDATE stock_batches
                SET quantity_remaining = ?1, version = version + 1, updated_at = ?2,
                    sync_status = 'pending'
              WHERE batch_id = ?3 AND version = ?4",
            rusqlite::params![retry_qty, now, batch_id, fresh.version],
        )
        .map_err(|e| format!("restitute retry: {e}"))?;
    if retried != 1 {
        return Err("RESTITUTE_VERSION_CONFLICT".to_string());
    }
    Ok(Some(LiveBatch {
        quantity: retry_qty,
        unit_cost: fresh.unit_cost,
        version: fresh.version + 1,
    }))
}

fn enqueue_batch(
    tx: &rusqlite::Transaction<'_>,
    key: &str,
    batch_id: &str,
    payload: serde_json::Value,
    now: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES (?1, 'stock_batches', ?2, 'UPSERT', ?3, 'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=?4",
        rusqlite::params![key, batch_id, payload.to_string(), now],
    )
    .map_err(|e| format!("restitute outbox: {e}"))?;
    Ok(())
}

/// One transaction for every allocation, or none. Returns the committed batch
/// rows so the caller (and the tests) can assert the COGS effects per row.
pub fn restitute_stock_batches_core(
    conn: &mut Connection,
    req: &RestituteRequest,
) -> Result<RestituteReport, String> {
    if req.allocations.len() > 500 {
        return Err("restitute: batch too large".to_string());
    }
    let seed = req.seed.as_deref().map(str::trim).unwrap_or("");
    let tx = conn.transaction().map_err(|e| format!("restitute tx: {e}"))?;
    let mut report = RestituteReport {
        outcomes: Vec::new(),
        product_ids: Vec::new(),
    };

    for (idx, alloc) in req.allocations.iter().enumerate() {
        let qty = alloc.quantity.max(0);
        if qty == 0 {
            continue;
        }
        if !alloc.product_id.trim().is_empty() && !report.product_ids.contains(&alloc.product_id) {
            report.product_ids.push(alloc.product_id.clone());
        }

        let mut restored = false;
        if let Some(batch_id) = alloc.batch_id.as_deref() {
            let usable = !batch_id.trim().is_empty()
                && batch_id != "unbatched"
                && !batch_id.starts_with("shadow-");
            if usable {
                if let Some(live) = bump_batch(&tx, batch_id, qty, &req.now)? {
                    let key = if seed.is_empty() {
                        format!("sb-{batch_id}-{}", req.now)
                    } else {
                        format!("sb-{seed}-{batch_id}")
                    };
                    enqueue_batch(
                        &tx,
                        &key,
                        batch_id,
                        serde_json::json!({
                            "version": live.version,
                            "batch_id": batch_id,
                            "product_id": alloc.product_id,
                            "quantity_remaining": live.quantity,
                            "unit_cost": live.unit_cost,
                            "updated_at": req.now,
                        }),
                        &req.now,
                    )?;
                    report.outcomes.push(RestitutionOutcome {
                        batch_id: batch_id.to_string(),
                        product_id: alloc.product_id.clone(),
                        quantity_remaining: live.quantity,
                        unit_cost: live.unit_cost,
                        version: live.version,
                        kind: "restored".to_string(),
                    });
                    restored = true;
                }
            }
        }

        if !restored {
            // A shadow marker, a tombstoned row or a missing row: the unit
            // physically came back, so it re-enters as a REFUND batch at the
            // ORIGINAL unit cost (never the shadow marker's cost).
            let new_batch_id = if seed.is_empty() {
                format!("batch-return-{}", uuid::Uuid::new_v4())
            } else {
                format!(
                    "batch-return-{seed}-{}-{}-{idx}",
                    alloc.product_id,
                    alloc.unit_cost.max(0.0).round() as i64
                )
            };
            let key = if seed.is_empty() {
                format!("sb-{new_batch_id}-{}", req.now)
            } else {
                format!("sb-{new_batch_id}")
            };
            let inserted = tx
                .execute(
                    "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
                        received_at, purchase_order_id, device_id, idempotency_key, sync_status,
                        version, created_at, updated_at, deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'REFUND', ?6, ?7, 'pending', 1, ?5, ?5, 0)
                     ON CONFLICT(batch_id) DO NOTHING",
                    rusqlite::params![
                        new_batch_id,
                        alloc.product_id,
                        qty,
                        alloc.unit_cost,
                        req.now,
                        req.device_id,
                        key
                    ],
                )
                .map_err(|e| format!("restitute refund batch: {e}"))?;
            // The envelope is written even when the row already existed (a
            // retry): the key is deterministic, so it converges on one row.
            let _ = inserted;
            let version: i64 = tx
                .query_row(
                    "SELECT COALESCE(version, 1) FROM stock_batches WHERE batch_id = ?1",
                    rusqlite::params![new_batch_id],
                    |r| r.get(0),
                )
                .unwrap_or(1);
            let quantity: i64 = tx
                .query_row(
                    "SELECT COALESCE(quantity_remaining, 0) FROM stock_batches WHERE batch_id = ?1",
                    rusqlite::params![new_batch_id],
                    |r| r.get(0),
                )
                .unwrap_or(qty);
            enqueue_batch(
                &tx,
                &key,
                &new_batch_id,
                serde_json::json!({
                    "version": version,
                    "batch_id": new_batch_id,
                    "product_id": alloc.product_id,
                    "quantity_remaining": quantity,
                    "unit_cost": alloc.unit_cost,
                    "received_at": req.now,
                    "purchase_order_id": "REFUND",
                    "updated_at": req.now,
                }),
                &req.now,
            )?;
            report.outcomes.push(RestitutionOutcome {
                batch_id: new_batch_id,
                product_id: alloc.product_id.clone(),
                quantity_remaining: quantity,
                unit_cost: alloc.unit_cost,
                version,
                kind: "refund".to_string(),
            });
        }
    }

    tx.commit().map_err(|e| format!("restitute commit: {e}"))?;
    Ok(report)
}

#[tauri::command]
pub fn restitute_stock_batches(
    app: tauri::AppHandle,
    request: RestituteRequest,
) -> Result<RestituteReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "restitute_stock_batches",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            restitute_stock_batches_core(&mut conn, &request).map_err(TrustError::op_failed)
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
             CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT, last_error TEXT, updated_at TEXT);",
        )
        .expect("schema");
        conn
    }

    fn batch(conn: &Connection, id: &str, qty: i64, cost: f64, deleted: i64) {
        conn.execute(
            "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, deleted,
                version, received_at, created_at, updated_at)
             VALUES (?1, 'P1', ?2, ?3, ?4, 3, '2026-10-01', '2026-10-01', '2026-10-01')",
            rusqlite::params![id, qty, cost, deleted],
        )
        .unwrap();
    }

    fn req(batch_id: Option<&str>, qty: i64, cost: f64, seed: Option<&str>) -> RestituteRequest {
        RestituteRequest {
            allocations: vec![RestitutionAllocation {
                batch_id: batch_id.map(|s| s.to_string()),
                product_id: "P1".to_string(),
                quantity: qty,
                unit_cost: cost,
            }],
            seed: seed.map(|s| s.to_string()),
            device_id: "dev".to_string(),
            now: "2026-11-05T15:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn restores_onto_the_original_batch_at_its_own_cost() {
        let mut conn = seeded();
        batch(&conn, "B1", 2, 700.0, 0);
        let report = restitute_stock_batches_core(&mut conn, &req(Some("B1"), 1, 999.0, Some("ref-R1")))
            .expect("restitute");
        assert_eq!(report.outcomes.len(), 1);
        let o = &report.outcomes[0];
        assert_eq!(o.kind, "restored");
        assert_eq!(o.quantity_remaining, 3, "2 + 1 back on the shelf");
        assert_eq!(o.unit_cost, 700.0, "the ORIGINAL cost wins over the caller's");
        assert_eq!(o.version, 4, "version 3 + 1");

        let payload: String = conn
            .query_row("SELECT payload_json FROM sync_outbox", [], |r| r.get(0))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["version"], 4);
        assert_eq!(parsed["unit_cost"], 700.0);
        assert_eq!(parsed["quantity_remaining"], 3);
    }

    #[test]
    fn a_shadow_marker_is_never_restored_and_mints_a_refund_at_the_original_cost() {
        let mut conn = seeded();
        batch(&conn, "shadow-T1-0", 0, 10.0, 0);
        let report = restitute_stock_batches_core(
            &mut conn,
            &req(Some("shadow-T1-0"), 2, 700.0, Some("ref-R1")),
        )
        .expect("restitute");
        let o = &report.outcomes[0];
        assert_eq!(o.kind, "refund");
        assert_eq!(o.quantity_remaining, 2);
        assert_eq!(o.unit_cost, 700.0, "cost comes from the allocation, not the shadow");
        let shadow_qty: i64 = conn
            .query_row("SELECT quantity_remaining FROM stock_batches WHERE batch_id='shadow-T1-0'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(shadow_qty, 0, "the phantom row stays dead");
    }

    #[test]
    fn a_tombstoned_batch_falls_through_to_a_refund_batch() {
        let mut conn = seeded();
        batch(&conn, "B1", 0, 700.0, 1);
        let report = restitute_stock_batches_core(&mut conn, &req(Some("B1"), 1, 700.0, Some("void-T1")))
            .expect("restitute");
        assert_eq!(report.outcomes[0].kind, "refund");
        let live: i64 = conn
            .query_row("SELECT quantity_remaining FROM stock_batches WHERE batch_id='B1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(live, 0, "a deleted batch is not resurrected");
    }

    #[test]
    fn the_same_seed_twice_mints_one_refund_batch_and_one_envelope() {
        let mut conn = seeded();
        let r = req(None, 3, 650.0, Some("ref-R9"));
        restitute_stock_batches_core(&mut conn, &r).expect("first");
        restitute_stock_batches_core(&mut conn, &r).expect("retry");
        let batches: i64 = conn
            .query_row("SELECT COUNT(*) FROM stock_batches WHERE purchase_order_id='REFUND'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(batches, 1, "ON CONFLICT converges on one batch");
        let outbox: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(outbox, 1, "and one deterministic envelope key");
    }

    #[test]
    fn a_failing_envelope_rolls_the_whole_restitution_back() {
        let mut conn = seeded();
        batch(&conn, "B1", 2, 700.0, 0);
        conn.execute_batch("DROP TABLE sync_outbox;").unwrap();
        let err = restitute_stock_batches_core(&mut conn, &req(Some("B1"), 1, 700.0, None))
            .expect_err("must roll back");
        assert!(err.contains("outbox"), "{err}");
        let qty: i64 = conn
            .query_row("SELECT quantity_remaining FROM stock_batches WHERE batch_id='B1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(qty, 2, "the restock did not survive without its envelope");
    }
}

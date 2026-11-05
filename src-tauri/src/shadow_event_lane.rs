//! Native shadow-event lane (SEC-01 / ADR-005).
//!
//! `recordShadowEvent` appends a domain envelope to `event_log` and reduces it
//! onto the `p_*` projections. It is called from the product, stock and checkout
//! paths, so a read-only renderer pool would refuse it on every catalog write.
//!
//! The reducer switch is mirrored here (nine effective event types; the two
//! device events are owned by the device-state projection and are no-ops here).
//! **Deliberate difference from the renderer, recorded in ADR-005:** log, reduce
//! and cursor advance share ONE transaction, so a failed projection cannot leave
//! half-applied shadow state. The renderer ran them as separate statements and
//! could. If the whole lane is unsupported by this schema the command fails and
//! the TypeScript side latches exactly as before.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowEventRequest {
    pub event_id: String,
    pub aggregate: String,
    pub hlc: String,
    pub device_id: String,
    pub schema_v: i64,
    pub event_type: String,
    /// `JSON.stringify(event.data)` — the reducer reads typed fields from it.
    pub data_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowEventReport {
    pub recorded: bool,
    pub reduced: bool,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("shadow app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("shadow open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("shadow busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("shadow fk: {e}")))?;
    Ok(conn)
}

fn round(value: &serde_json::Value) -> i64 {
    value
        .as_f64()
        .map(|f| f.round() as i64)
        .or_else(|| value.as_i64())
        .unwrap_or(0)
}

fn text<'a>(data: &'a serde_json::Value, key: &str) -> &'a str {
    data.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

/// Append + reduce + advance the cursor in one transaction.
pub fn record_shadow_event_core(
    conn: &mut Connection,
    req: &ShadowEventRequest,
) -> Result<ShadowEventReport, String> {
    if req.event_id.trim().is_empty() || req.event_type.trim().is_empty() {
        return Err("record_shadow_event: event_id and event_type required".to_string());
    }
    let data: serde_json::Value = serde_json::from_str(&req.data_json)
        .map_err(|e| format!("record_shadow_event: data is not JSON: {e}"))?;
    if !data.is_object() {
        return Err("record_shadow_event: data must be an object".to_string());
    }

    let tx = conn.transaction().map_err(|e| format!("shadow tx: {e}"))?;
    tx.execute(
        "INSERT INTO event_log (event_id, aggregate, hlc, device_id, schema_v, event_type,
            data_json, synced_to_cloud, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)",
        rusqlite::params![
            req.event_id,
            req.aggregate,
            req.hlc,
            req.device_id,
            req.schema_v,
            req.event_type,
            req.data_json,
            req.created_at
        ],
    )
    .map_err(|e| format!("shadow event_log: {e}"))?;

    let now = req.created_at.as_str();
    match req.event_type.as_str() {
        "product_created" => {
            tx.execute(
                "INSERT INTO p_products (id, name, price_cents, stock, deleted, row_hlc, updated_at)
                 VALUES (?1, ?2, ?3, 0, 0, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   price_cents = excluded.price_cents,
                   row_hlc = excluded.row_hlc,
                   updated_at = excluded.updated_at
                 WHERE excluded.row_hlc > p_products.row_hlc",
                rusqlite::params![
                    text(&data, "id"),
                    text(&data, "name"),
                    round(data.get("price_cents").unwrap_or(&serde_json::Value::Null)),
                    req.hlc,
                    now
                ],
            )
            .map_err(|e| format!("shadow product_created: {e}"))?;
        }
        "product_renamed" => {
            tx.execute(
                "UPDATE p_products SET name = ?1, row_hlc = ?2, updated_at = ?3
                  WHERE id = ?4 AND ?2 > row_hlc AND deleted = 0",
                rusqlite::params![text(&data, "new_name"), req.hlc, now, text(&data, "id")],
            )
            .map_err(|e| format!("shadow product_renamed: {e}"))?;
        }
        "price_changed" => {
            tx.execute(
                "UPDATE p_products SET price_cents = ?1, row_hlc = ?2, updated_at = ?3
                  WHERE id = ?4 AND ?2 > row_hlc AND deleted = 0",
                rusqlite::params![
                    round(data.get("new_cents").unwrap_or(&serde_json::Value::Null)),
                    req.hlc,
                    now,
                    text(&data, "id")
                ],
            )
            .map_err(|e| format!("shadow price_changed: {e}"))?;
        }
        "stock_sold" | "stock_received" | "stock_adjusted" => {
            let field = if req.event_type == "stock_adjusted" {
                "delta"
            } else {
                "qty"
            };
            let raw = round(data.get(field).unwrap_or(&serde_json::Value::Null));
            let delta = if req.event_type == "stock_sold" { -raw } else { raw };
            tx.execute(
                "UPDATE p_products SET stock = stock + ?1, row_hlc = ?2, updated_at = ?3
                  WHERE id = ?4 AND deleted = 0",
                rusqlite::params![delta, req.hlc, now, text(&data, "product_id")],
            )
            .map_err(|e| format!("shadow stock: {e}"))?;
        }
        "product_deleted" => {
            tx.execute(
                "UPDATE p_products SET deleted = 1, row_hlc = ?1, updated_at = ?2
                  WHERE id = ?3 AND ?1 > row_hlc",
                rusqlite::params![req.hlc, now, text(&data, "id")],
            )
            .map_err(|e| format!("shadow product_deleted: {e}"))?;
        }
        "checkout_completed" => {
            let tx_id = text(&data, "transaction_id");
            tx.execute(
                "INSERT OR REPLACE INTO p_transactions (id, total_cents, ts, row_hlc, device_id)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    tx_id,
                    round(data.get("total_cents").unwrap_or(&serde_json::Value::Null)),
                    now,
                    req.hlc,
                    req.device_id
                ],
            )
            .map_err(|e| format!("shadow checkout header: {e}"))?;
            if let Some(lines) = data.get("lines").and_then(|v| v.as_array()) {
                for line in lines {
                    tx.execute(
                        "INSERT OR REPLACE INTO p_transaction_items (tx_id, product_id, qty, unit_cents)
                         VALUES (?1, ?2, ?3, ?4)",
                        rusqlite::params![
                            tx_id,
                            text(line, "product_id"),
                            round(line.get("qty").unwrap_or(&serde_json::Value::Null)),
                            round(line.get("unit_cents").unwrap_or(&serde_json::Value::Null))
                        ],
                    )
                    .map_err(|e| format!("shadow checkout line: {e}"))?;
                }
            }
        }
        // Device state is projected by its own lanes; the envelope is still logged.
        "device_paired" | "device_revoked" => {}
        other => {
            // Unknown types are logged but never guessed at.
            let _ = other;
        }
    }

    tx.execute(
        "INSERT INTO projection_cursor (projection_name, last_event_id, last_hlc, updated_at)
         VALUES ('default', ?1, ?2, ?3)
         ON CONFLICT(projection_name) DO UPDATE SET
           last_event_id = excluded.last_event_id,
           last_hlc = excluded.last_hlc,
           updated_at = excluded.updated_at
         WHERE excluded.last_hlc >= projection_cursor.last_hlc",
        rusqlite::params![req.event_id, req.hlc, now],
    )
    .map_err(|e| format!("shadow cursor: {e}"))?;

    tx.commit().map_err(|e| format!("shadow commit: {e}"))?;
    Ok(ShadowEventReport {
        recorded: true,
        reduced: true,
    })
}

#[tauri::command]
pub fn record_shadow_event(
    app: tauri::AppHandle,
    request: ShadowEventRequest,
) -> Result<ShadowEventReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "record_shadow_event",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            record_shadow_event_core(&mut conn, &request).map_err(TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE event_log (event_id TEXT PRIMARY KEY, aggregate TEXT, hlc TEXT,
                device_id TEXT, schema_v INTEGER, event_type TEXT, data_json TEXT,
                synced_to_cloud INTEGER NOT NULL DEFAULT 0, created_at TEXT);
             CREATE TABLE p_products (id TEXT PRIMARY KEY, name TEXT, price_cents INTEGER,
                stock INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
                row_hlc TEXT, updated_at TEXT);
             CREATE TABLE p_transactions (id TEXT PRIMARY KEY, total_cents INTEGER, ts TEXT,
                row_hlc TEXT, device_id TEXT);
             CREATE TABLE p_transaction_items (tx_id TEXT, product_id TEXT, qty INTEGER,
                unit_cents INTEGER);
             CREATE TABLE projection_cursor (projection_name TEXT PRIMARY KEY,
                last_event_id TEXT, last_hlc TEXT, updated_at TEXT);",
        )
        .expect("schema");
        conn
    }

    fn ev(event_type: &str, data: serde_json::Value, hlc: &str) -> ShadowEventRequest {
        ShadowEventRequest {
            event_id: format!("EV-{hlc}-{event_type}"),
            aggregate: "product:P1".to_string(),
            hlc: hlc.to_string(),
            device_id: "dev".to_string(),
            schema_v: 1,
            event_type: event_type.to_string(),
            data_json: data.to_string(),
            created_at: "2026-11-05T09:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn create_then_stock_moves_reduce_onto_the_projection() {
        let mut conn = seeded();
        record_shadow_event_core(
            &mut conn,
            &ev(
                "product_created",
                serde_json::json!({"id":"P1","name":"Phone","price_cents":10000}),
                "0001",
            ),
        )
        .expect("create");
        record_shadow_event_core(
            &mut conn,
            &ev("stock_received", serde_json::json!({"product_id":"P1","qty":5}), "0002"),
        )
        .expect("receive");
        record_shadow_event_core(
            &mut conn,
            &ev("stock_sold", serde_json::json!({"product_id":"P1","qty":2}), "0003"),
        )
        .expect("sold");

        let (name, price, stock): (String, i64, i64) = conn
            .query_row("SELECT name, price_cents, stock FROM p_products WHERE id='P1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(name, "Phone");
        assert_eq!(price, 10000);
        assert_eq!(stock, 3, "5 received minus 2 sold");

        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM event_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(events, 3);
        let cursor: String = conn
            .query_row("SELECT last_event_id FROM projection_cursor", [], |r| r.get(0))
            .unwrap();
        assert!(cursor.contains("0003"), "{cursor}");
    }

    #[test]
    fn a_stale_hlc_does_not_regress_the_projection() {
        let mut conn = seeded();
        record_shadow_event_core(
            &mut conn,
            &ev("product_created", serde_json::json!({"id":"P1","name":"New","price_cents":1}), "0002"),
        )
        .unwrap();
        record_shadow_event_core(
            &mut conn,
            &ev("product_renamed", serde_json::json!({"id":"P1","new_name":"Old"}), "0001"),
        )
        .unwrap();
        let name: String = conn
            .query_row("SELECT name FROM p_products WHERE id='P1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "New", "the LWW guard rejects the older HLC");
    }

    #[test]
    fn checkout_reduces_header_and_lines_idempotently() {
        let mut conn = seeded();
        let envelope = ev(
            "checkout_completed",
            serde_json::json!({
                "transaction_id": "T1",
                "total_cents": 250000,
                "lines": [
                    {"product_id":"P1","qty":1,"unit_cents":100000},
                    {"product_id":"P2","qty":3,"unit_cents":50000}
                ]
            }),
            "0003",
        );
        record_shadow_event_core(&mut conn, &envelope).expect("first");
        record_shadow_event_core(&mut conn, &envelope).expect_err("same event id is not replayable");

        let items: i64 = conn
            .query_row("SELECT COUNT(*) FROM p_transaction_items WHERE tx_id='T1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(items, 2);
        let total: i64 = conn
            .query_row("SELECT total_cents FROM p_transactions WHERE id='T1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 250000);
    }

    #[test]
    fn a_failing_projection_rolls_the_event_row_back() {
        let mut conn = seeded();
        conn.execute_batch("DROP TABLE p_products;").unwrap();
        let err = record_shadow_event_core(
            &mut conn,
            &ev("product_created", serde_json::json!({"id":"P1","name":"X","price_cents":1}), "0001"),
        )
        .expect_err("must roll back");
        assert!(err.contains("product_created"), "{err}");
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM event_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(events, 0, "no half-applied shadow state");
    }

    #[test]
    fn an_unknown_event_type_is_logged_without_guessing() {
        let mut conn = seeded();
        record_shadow_event_core(
            &mut conn,
            &ev("some_future_event", serde_json::json!({"x":1}), "0004"),
        )
        .expect("logged");
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM event_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(events, 1);
    }
}

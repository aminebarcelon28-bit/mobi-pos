//! Native trade-in / IMEI lanes (SEC-01 / ADR-005).
//!
//! The trade-in flow used to write three rows through the WebView pool: the
//! trade-in envelope, the IMEI record and the ownership event. They are native
//! now; the trade-in and IMEI rows keep their exact upsert semantics (version
//! bump, COALESCE-preserved columns), and the event is idempotent by id.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeInRequest {
    pub id: String,
    pub device_model: String,
    pub imei: String,
    pub brand: String,
    pub condition_grade: String,
    pub buyback_value: f64,
    pub resale_margin_percent: f64,
    pub resale_price: f64,
    pub customer_name: String,
    pub customer_phone: Option<String>,
    pub customer_id: Option<String>,
    pub credit_to_wallet: bool,
    pub created_at: String,
    pub json_payload: String,
    pub inspection_json: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImeiRecordRequest {
    pub imei: String,
    pub product_id: String,
    pub purchase_order_id: Option<String>,
    pub sale_transaction_id: Option<String>,
    pub warranty_expires_at: Option<String>,
    pub received_at: Option<String>,
    pub sold_at: Option<String>,
    pub warranty_months: Option<i64>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImeiEventRequest {
    pub id: String,
    pub imei: String,
    pub kind: String,
    pub ref_type: String,
    pub ref_id: String,
    pub at: String,
    pub actor: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WriteReport {
    pub changes: usize,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("ops app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("ops open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("ops busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("ops fk: {e}")))?;
    Ok(conn)
}

pub fn save_trade_in_core(conn: &Connection, req: &TradeInRequest) -> Result<usize, String> {
    conn.execute(
        "INSERT INTO trade_ins (id, device_model, imei, brand, condition_grade, buyback_value,
            resale_margin_percent, resale_price, customer_name, customer_phone, customer_id,
            credit_to_wallet, created_at, json_payload, inspection_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
           device_model=excluded.device_model,
           imei=excluded.imei,
           brand=excluded.brand,
           condition_grade=excluded.condition_grade,
           buyback_value=excluded.buyback_value,
           resale_margin_percent=excluded.resale_margin_percent,
           resale_price=excluded.resale_price,
           customer_name=excluded.customer_name,
           customer_phone=excluded.customer_phone,
           customer_id=excluded.customer_id,
           credit_to_wallet=excluded.credit_to_wallet,
           json_payload=excluded.json_payload,
           inspection_json=excluded.inspection_json,
           version=trade_ins.version + 1",
        rusqlite::params![
            req.id,
            req.device_model,
            req.imei,
            req.brand,
            req.condition_grade,
            req.buyback_value,
            req.resale_margin_percent,
            req.resale_price,
            req.customer_name,
            req.customer_phone,
            req.customer_id,
            if req.credit_to_wallet { 1 } else { 0 },
            req.created_at,
            req.json_payload,
            req.inspection_json
        ],
    )
    .map_err(|e| format!("save_trade_in: {e}"))
}

pub fn save_imei_record_core(conn: &Connection, req: &ImeiRecordRequest) -> Result<usize, String> {
    conn.execute(
        "INSERT INTO imei_records (imei, product_id, purchase_order_id, sale_transaction_id,
            warranty_expires_at, received_at, sold_at, warranty_months, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, 'in_stock'))
         ON CONFLICT(imei) DO UPDATE SET
           product_id=excluded.product_id,
           purchase_order_id=COALESCE(excluded.purchase_order_id, imei_records.purchase_order_id),
           sale_transaction_id=excluded.sale_transaction_id,
           warranty_expires_at=COALESCE(excluded.warranty_expires_at, imei_records.warranty_expires_at),
           received_at=COALESCE(excluded.received_at, imei_records.received_at),
           sold_at=excluded.sold_at,
           warranty_months=COALESCE(excluded.warranty_months, imei_records.warranty_months),
           status=COALESCE(?9, imei_records.status),
           version=imei_records.version + 1",
        rusqlite::params![
            req.imei,
            req.product_id,
            req.purchase_order_id,
            req.sale_transaction_id,
            req.warranty_expires_at,
            req.received_at,
            req.sold_at,
            req.warranty_months,
            req.status
        ],
    )
    .map_err(|e| format!("save_imei_record: {e}"))
}

pub fn append_imei_event_core(conn: &Connection, req: &ImeiEventRequest) -> Result<usize, String> {
    conn.execute(
        "INSERT OR IGNORE INTO imei_events (id, imei, kind, ref_type, ref_id, at, actor, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            req.id,
            req.imei,
            req.kind,
            req.ref_type,
            req.ref_id,
            req.at,
            req.actor,
            req.note
        ],
    )
    .map_err(|e| format!("append_imei_event: {e}"))
}

#[tauri::command]
pub fn save_trade_in(app: tauri::AppHandle, request: TradeInRequest) -> Result<WriteReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "save_trade_in",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            save_trade_in_core(&conn, &request)
                .map(|changes| WriteReport { changes })
                .map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn save_imei_record(app: tauri::AppHandle, request: ImeiRecordRequest) -> Result<WriteReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "save_imei_record",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            save_imei_record_core(&conn, &request)
                .map(|changes| WriteReport { changes })
                .map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn append_imei_event(app: tauri::AppHandle, request: ImeiEventRequest) -> Result<WriteReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "append_imei_event",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            append_imei_event_core(&conn, &request)
                .map(|changes| WriteReport { changes })
                .map_err(TrustError::op_failed)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE trade_ins (id TEXT PRIMARY KEY, device_model TEXT, imei TEXT, brand TEXT,
                condition_grade TEXT, buyback_value REAL, resale_margin_percent REAL, resale_price REAL,
                customer_name TEXT, customer_phone TEXT, customer_id TEXT, credit_to_wallet INTEGER,
                created_at TEXT, json_payload TEXT, inspection_json TEXT, version INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE imei_records (imei TEXT PRIMARY KEY, product_id TEXT, purchase_order_id TEXT,
                sale_transaction_id TEXT, warranty_expires_at TEXT, received_at TEXT, sold_at TEXT,
                warranty_months INTEGER, status TEXT, version INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE imei_events (id TEXT PRIMARY KEY, imei TEXT, kind TEXT, ref_type TEXT,
                ref_id TEXT, at TEXT, actor TEXT, note TEXT);",
        )
        .unwrap();
        conn
    }

    fn trade() -> TradeInRequest {
        TradeInRequest {
            id: "TI1".to_string(),
            device_model: "iPhone".to_string(),
            imei: "I1".to_string(),
            brand: "Apple".to_string(),
            condition_grade: "A".to_string(),
            buyback_value: 30000.0,
            resale_margin_percent: 20.0,
            resale_price: 36000.0,
            customer_name: "Ali".to_string(),
            customer_phone: None,
            customer_id: None,
            credit_to_wallet: true,
            created_at: "2026-11-05T10:00:00Z".to_string(),
            json_payload: "{\"id\":\"TI1\"}".to_string(),
            inspection_json: None,
        }
    }

    #[test]
    fn trade_in_upsert_bumps_version() {
        let conn = seeded();
        assert_eq!(save_trade_in_core(&conn, &trade()).unwrap(), 1);
        assert_eq!(save_trade_in_core(&conn, &trade()).unwrap(), 1);
        let (version, wallet): (i64, i64) = conn
            .query_row("SELECT version, credit_to_wallet FROM trade_ins WHERE id='TI1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(version, 2);
        assert_eq!(wallet, 1);
    }

    #[test]
    fn imei_upsert_preserves_purchase_link_when_absent() {
        let conn = seeded();
        let mut rec = ImeiRecordRequest {
            imei: "I1".to_string(),
            product_id: "P1".to_string(),
            purchase_order_id: Some("PO1".to_string()),
            sale_transaction_id: None,
            warranty_expires_at: None,
            received_at: Some("2026-11-01".to_string()),
            sold_at: None,
            warranty_months: Some(12),
            status: Some("in_stock".to_string()),
        };
        save_imei_record_core(&conn, &rec).unwrap();
        rec.purchase_order_id = None;
        rec.warranty_months = None;
        save_imei_record_core(&conn, &rec).unwrap();
        let (po, months, version): (String, i64, i64) = conn
            .query_row(
                "SELECT purchase_order_id, warranty_months, version FROM imei_records WHERE imei='I1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(po, "PO1", "COALESCE keeps the original purchase link");
        assert_eq!(months, 12);
        assert_eq!(version, 2);
    }

    #[test]
    fn imei_event_is_idempotent_by_id() {
        let conn = seeded();
        let ev = ImeiEventRequest {
            id: "imev|RETURN_IN|order|T1|I1".to_string(),
            imei: "I1".to_string(),
            kind: "RETURN_IN".to_string(),
            ref_type: "order".to_string(),
            ref_id: "T1".to_string(),
            at: "2026-11-05T10:00:00Z".to_string(),
            actor: String::new(),
            note: "retour".to_string(),
        };
        assert_eq!(append_imei_event_core(&conn, &ev).unwrap(), 1);
        assert_eq!(append_imei_event_core(&conn, &ev).unwrap(), 0);
    }
}

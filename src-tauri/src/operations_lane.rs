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

// ── purchase orders ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrderRequest {
    pub id: String,
    pub po_number: String,
    pub vendor_name: String,
    pub total_amount: f64,
    pub status: String,
    pub created_at: String,
    pub json_payload: String,
}

pub fn save_purchase_order_core(
    conn: &Connection,
    req: &PurchaseOrderRequest,
) -> Result<usize, String> {
    if req.id.trim().is_empty() {
        return Err("save_purchase_order: id required".to_string());
    }
    conn.execute(
        "INSERT INTO purchase_orders (id, po_number, vendor_name, total_amount, status, created_at, json_payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           po_number=excluded.po_number,
           vendor_name=excluded.vendor_name,
           total_amount=excluded.total_amount,
           status=excluded.status,
           json_payload=excluded.json_payload,
           version=purchase_orders.version + 1",
        rusqlite::params![
            req.id,
            req.po_number,
            req.vendor_name,
            req.total_amount,
            req.status,
            req.created_at,
            req.json_payload
        ],
    )
    .map_err(|e| format!("save_purchase_order: {e}"))
}

#[tauri::command]
pub fn save_purchase_order(
    app: tauri::AppHandle,
    request: PurchaseOrderRequest,
) -> Result<WriteReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "save_purchase_order",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            save_purchase_order_core(&conn, &request)
                .map(|changes| WriteReport { changes })
                .map_err(TrustError::op_failed)
        },
    )
}

// ── repair orders ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairOrderRequest {
    pub id: String,
    pub ticket_number: String,
    pub customer_name: String,
    pub customer_phone: String,
    pub customer_id: Option<String>,
    pub device_model: String,
    pub imei: Option<String>,
    pub status: String,
    pub labor_cost: i64,
    pub parts_cost: i64,
    pub total_cost: i64,
    pub deposit_amount: i64,
    pub parts_cost_basis: i64,
    pub costing_model: String,
    pub rework_of_repair_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub json_payload: String,
}

pub fn save_repair_order_core(
    conn: &Connection,
    req: &RepairOrderRequest,
) -> Result<usize, String> {
    if req.id.trim().is_empty() {
        return Err("save_repair_order: id required".to_string());
    }
    conn.execute(
        "INSERT INTO repair_orders (id, ticket_number, customer_name, customer_phone, customer_id, device_model, imei, status, labor_cost, parts_cost, total_cost, deposit_amount, parts_cost_basis, costing_model, rework_of_repair_id, created_at, updated_at, json_payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(id) DO UPDATE SET
           ticket_number=excluded.ticket_number,
           customer_name=excluded.customer_name,
           customer_phone=excluded.customer_phone,
           customer_id=excluded.customer_id,
           device_model=excluded.device_model,
           imei=excluded.imei,
           status=excluded.status,
           labor_cost=excluded.labor_cost,
           parts_cost=excluded.parts_cost,
           total_cost=excluded.total_cost,
           deposit_amount=excluded.deposit_amount,
           parts_cost_basis=excluded.parts_cost_basis,
           costing_model=excluded.costing_model,
           rework_of_repair_id=excluded.rework_of_repair_id,
           updated_at=excluded.updated_at,
           json_payload=excluded.json_payload,
           version=repair_orders.version + 1",
        rusqlite::params![
            req.id,
            req.ticket_number,
            req.customer_name,
            req.customer_phone,
            req.customer_id,
            req.device_model,
            req.imei,
            req.status,
            req.labor_cost,
            req.parts_cost,
            req.total_cost,
            req.deposit_amount,
            req.parts_cost_basis,
            req.costing_model,
            req.rework_of_repair_id,
            req.created_at,
            req.updated_at,
            req.json_payload
        ],
    )
    .map_err(|e| format!("save_repair_order: {e}"))
}

#[tauri::command]
pub fn save_repair_order(
    app: tauri::AppHandle,
    request: RepairOrderRequest,
) -> Result<WriteReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "save_repair_order",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            save_repair_order_core(&conn, &request)
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
                ref_id TEXT, at TEXT, actor TEXT, note TEXT);
             CREATE TABLE purchase_orders (id TEXT PRIMARY KEY, po_number TEXT, vendor_name TEXT,
                total_amount REAL, status TEXT, created_at TEXT, json_payload TEXT,
                version INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE repair_orders (id TEXT PRIMARY KEY, ticket_number TEXT, customer_name TEXT,
                customer_phone TEXT, customer_id TEXT, device_model TEXT, imei TEXT, status TEXT,
                labor_cost INTEGER, parts_cost INTEGER, total_cost INTEGER, deposit_amount INTEGER,
                parts_cost_basis INTEGER, costing_model TEXT, rework_of_repair_id TEXT,
                created_at TEXT, updated_at TEXT, json_payload TEXT,
                version INTEGER NOT NULL DEFAULT 1);",
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
    fn repair_order_upsert_bumps_the_version_and_keeps_costs() {
        let conn = seeded();
        let mut req = RepairOrderRequest {
            id: "R1".to_string(),
            ticket_number: "SAV-1".to_string(),
            customer_name: "Ali".to_string(),
            customer_phone: "0550".to_string(),
            customer_id: None,
            device_model: "iPhone".to_string(),
            imei: Some("I1".to_string()),
            status: "En attente".to_string(),
            labor_cost: 1000,
            parts_cost: 2500,
            total_cost: 3500,
            deposit_amount: 500,
            parts_cost_basis: 2000,
            costing_model: "manual".to_string(),
            rework_of_repair_id: None,
            created_at: "2026-11-05T10:00:00Z".to_string(),
            updated_at: "2026-11-05T10:00:00Z".to_string(),
            json_payload: "{\"id\":\"R1\"}".to_string(),
        };
        assert_eq!(save_repair_order_core(&conn, &req).unwrap(), 1);
        req.status = "Terminé".to_string();
        req.updated_at = "2026-11-05T11:00:00Z".to_string();
        assert_eq!(save_repair_order_core(&conn, &req).unwrap(), 1);
        let (status, total, version): (String, i64, i64) = conn
            .query_row(
                "SELECT status, total_cost, version FROM repair_orders WHERE id='R1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "Terminé");
        assert_eq!(total, 3500);
        assert_eq!(version, 2);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM repair_orders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn purchase_order_upsert_bumps_the_version() {
        let conn = seeded();
        let mut po = PurchaseOrderRequest {
            id: "PO1".to_string(),
            po_number: "PO-1".to_string(),
            vendor_name: "Sup".to_string(),
            total_amount: 1000.0,
            status: "Draft".to_string(),
            created_at: "2026-11-05T10:00:00Z".to_string(),
            json_payload: "{\"id\":\"PO1\"}".to_string(),
        };
        assert_eq!(save_purchase_order_core(&conn, &po).unwrap(), 1);
        po.status = "Received".to_string();
        po.total_amount = 1200.0;
        assert_eq!(save_purchase_order_core(&conn, &po).unwrap(), 1);
        let (status, total, version): (String, f64, i64) = conn
            .query_row(
                "SELECT status, total_amount, version FROM purchase_orders WHERE id='PO1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "Received");
        assert_eq!(total, 1200.0);
        assert_eq!(version, 2);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM purchase_orders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the upsert converges on one row");
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

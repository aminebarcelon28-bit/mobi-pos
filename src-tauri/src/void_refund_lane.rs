//! Void/refund mirror lane (SEC-01 / ADR-005).
//!
//! The last renderer writes on the refund path are the *mirrors* of money the
//! native kernel already committed: the refund loyalty `json_patch` + ledger
//! appends, the store-expense upsert, and the void/refund status transaction.
//! They run here, natively, with fixed literals.
//!
//! Contracts pinned by tests:
//!   * the loyalty bundle (patch + ledger appends) commits or rolls back whole;
//!   * ledger appends are idempotent per entry id and never duplicate;
//!   * a stale/absent customer changes 0 rows instead of resurrecting a row;
//!   * the expense upsert is idempotent and bumps the version.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoyaltyMirrorRequest {
    pub customer_id: String,
    /// `JSON.stringify(loyaltyPatch(customer))` — merged with `json_patch`.
    pub patch_json: String,
    pub total_spent: Option<i64>,
    pub loyalty_points: Option<i64>,
    pub updated_at: String,
    /// Ledger entries as JSON strings; appended by id, never duplicated.
    #[serde(default)]
    pub ledger_entries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoyaltyMirrorReport {
    pub rows_updated: usize,
    pub ledger_appended: usize,
    pub ledger_missing: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreExpenseRequest {
    pub id: String,
    pub category: String,
    pub title: String,
    pub amount: i64,
    pub payment_method: String,
    pub paid_to: Option<String>,
    pub notes: Option<String>,
    pub recorded_by: String,
    pub created_at: String,
    pub json_payload: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreExpenseReport {
    pub changes: usize,
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("mirror app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("mirror open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("mirror busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("mirror fk: {e}")))?;
    Ok(conn)
}

fn ledger_entry_id(raw: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
}

/// Loyalty mirror core. Runs inside the caller's transaction when one is open
/// (the void/refund lane) or opens its own for the standalone refund path.
pub fn apply_loyalty_mirror_tx(
    tx: &rusqlite::Transaction<'_>,
    req: &LoyaltyMirrorRequest,
) -> Result<LoyaltyMirrorReport, String> {
    let mut report = LoyaltyMirrorReport::default();
    if req.customer_id.trim().is_empty() {
        return Err("loyalty mirror: customer_id required".to_string());
    }
    if req.patch_json.len() > 256 * 1024 {
        return Err("loyalty mirror: patch oversized".to_string());
    }
    // `json_patch` merges into the live payload (a wallet movement committed
    // after the refund read-back survives); `json_valid` guards a corrupt
    // payload from being nulled by a failing patch.
    report.rows_updated = tx
        .execute(
            "UPDATE customers
                SET json_payload = CASE
                      WHEN json_valid(json_payload) THEN json_patch(json_payload, ?2)
                      ELSE json_payload
                    END,
                    total_spent = COALESCE(?3, total_spent),
                    loyalty_points = COALESCE(?4, loyalty_points),
                    updated_at = ?5,
                    version = version + 1
              WHERE id = ?1 AND deleted = 0",
            rusqlite::params![
                req.customer_id,
                req.patch_json,
                req.total_spent,
                req.loyalty_points,
                req.updated_at
            ],
        )
        .map_err(|e| format!("loyalty mirror patch: {e}"))?;

    for raw in &req.ledger_entries {
        let Some(entry_id) = ledger_entry_id(raw) else {
            continue;
        };
        // Append by id: a row already emitted (native or an earlier retry) is
        // never duplicated; a legacy non-array ledger refuses instead of
        // silently doing nothing.
        let appended = tx
            .execute(
                "UPDATE customers
                    SET json_payload = json_insert(json_payload, '$.ledger[#]', json(?2))
                  WHERE id = ?1
                    AND deleted = 0
                    AND json_valid(json_payload)
                    AND (json_type(json_payload, '$.ledger') IS NULL
                         OR json_type(json_payload, '$.ledger') = 'array')
                    AND NOT EXISTS (
                        SELECT 1 FROM json_each(customers.json_payload, '$.ledger')
                         WHERE json_extract(value, '$.id') = ?3
                    )",
                rusqlite::params![req.customer_id, raw, entry_id],
            )
            .map_err(|e| format!("loyalty mirror ledger: {e}"))?;
        if appended > 0 {
            report.ledger_appended += 1;
        } else {
            report.ledger_missing.push(entry_id);
        }
    }
    Ok(report)
}

/// Standalone entry (the post-refund loyalty mirror): one transaction, then the
/// caller re-reads the committed row.
pub fn apply_loyalty_mirror(
    conn: &mut Connection,
    req: &LoyaltyMirrorRequest,
) -> Result<LoyaltyMirrorReport, String> {
    let tx = conn.transaction().map_err(|e| format!("loyalty tx: {e}"))?;
    let report = apply_loyalty_mirror_tx(&tx, req)?;
    tx.commit().map_err(|e| format!("loyalty commit: {e}"))?;
    Ok(report)
}

#[tauri::command]
pub fn apply_customer_loyalty_mirror(
    app: tauri::AppHandle,
    request: LoyaltyMirrorRequest,
) -> Result<LoyaltyMirrorReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "apply_customer_loyalty_mirror",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            apply_loyalty_mirror(&mut conn, &request).map_err(TrustError::op_failed)
        },
    )
}

// ── customer debt (stub + ledger row) ─────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerDebtRequest {
    pub id: String,
    pub customer_id: String,
    pub customer_name: String,
    #[serde(rename = "type")]
    pub debt_type: String,
    pub amount: i64,
    pub balance_after: i64,
    pub receipt_number: Option<String>,
    pub payment_method: Option<String>,
    pub notes: Option<String>,
    pub recorded_by: Option<String>,
    pub created_at: String,
    pub json_payload: String,
    pub version: i64,
    pub updated_at: String,
    pub due_date: Option<String>,
    pub kind: String,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerDebtReport {
    pub changes: usize,
    pub stub_inserted: bool,
}

/// The renderer's debt lane: idempotent parent stub (never clobbers a live
/// parent), then the version-guarded debt row — one transaction.
pub fn upsert_customer_debt_core(
    conn: &mut Connection,
    req: &CustomerDebtRequest,
) -> Result<CustomerDebtReport, String> {
    if req.id.trim().is_empty() || req.customer_id.trim().is_empty() {
        return Err("customer debt: id and customer_id required".to_string());
    }
    let tx = conn.transaction().map_err(|e| format!("debt tx: {e}"))?;
    let stub_inserted = tx
        .execute(
            "INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key, created_at)
             VALUES (?1, ?2, '', ?3, ?4, 'stub-cust-' || ?1, ?4)
             ON CONFLICT(id) DO NOTHING",
            rusqlite::params![
                req.customer_id,
                req.customer_name,
                serde_json::json!({ "id": req.customer_id, "name": req.customer_name }).to_string(),
                req.created_at
            ],
        )
        .map_err(|e| format!("debt stub: {e}"))?
        > 0;
    let changes = tx
        .execute(
            "INSERT INTO customer_debts (id, customer_id, customer_name, type, amount, balance_after,
                receipt_number, payment_method, notes, recorded_by, created_at, json_payload, version, updated_at, deleted,
                due_date, kind, origin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, ?15, ?16, ?17)
             ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id, customer_name=excluded.customer_name,
               type=excluded.type, amount=excluded.amount, balance_after=excluded.balance_after,
               receipt_number=excluded.receipt_number, payment_method=excluded.payment_method,
               notes=excluded.notes, recorded_by=excluded.recorded_by, created_at=excluded.created_at,
               json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0,
               due_date=excluded.due_date, kind=excluded.kind,
               origin=excluded.origin, version = excluded.version
             WHERE excluded.version >= customer_debts.version",
            rusqlite::params![
                req.id,
                req.customer_id,
                req.customer_name,
                req.debt_type,
                req.amount,
                req.balance_after,
                req.receipt_number,
                req.payment_method,
                req.notes,
                req.recorded_by,
                req.created_at,
                req.json_payload,
                req.version,
                req.updated_at,
                req.due_date,
                req.kind,
                req.origin
            ],
        )
        .map_err(|e| format!("debt row: {e}"))?;
    tx.commit().map_err(|e| format!("debt commit: {e}"))?;
    Ok(CustomerDebtReport {
        changes,
        stub_inserted,
    })
}

#[tauri::command]
pub fn upsert_customer_debt(
    app: tauri::AppHandle,
    request: CustomerDebtRequest,
) -> Result<CustomerDebtReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "upsert_customer_debt",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            upsert_customer_debt_core(&mut conn, &request).map_err(TrustError::op_failed)
        },
    )
}

// ── void / refund status mirror ───────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoneyDeltaRequest {
    pub customer_id: String,
    pub credit_delta: i64,
    pub debt_delta: i64,
    pub now_iso: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidMirrorRequest {
    pub transaction_id: String,
    pub now_iso: String,
    #[serde(default)]
    pub restored_imeis: Vec<String>,
    pub imei_status_available: bool,
    pub loyalty: Option<LoyaltyMirrorRequest>,
    pub money_delta: Option<MoneyDeltaRequest>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoidMirrorReport {
    pub status_changed: bool,
    pub imei_released: usize,
    pub events_inserted: usize,
    pub money_changed: usize,
    pub loyalty: Option<LoyaltyMirrorReport>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImeiRelease {
    pub imei: String,
    pub status: String,
    pub kind: String,
    pub note: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundMirrorRequest {
    pub transaction_id: String,
    pub original_transaction_id: Option<String>,
    pub now_iso: String,
    #[serde(default)]
    pub releases: Vec<ImeiRelease>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RefundMirrorReport {
    pub imei_released: usize,
    pub events_inserted: usize,
}

fn transaction_status(tx: &rusqlite::Transaction<'_>, id: &str) -> Option<String> {
    tx.query_row("SELECT status FROM transactions WHERE id = ?1", [id], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

/// The whole renderer `db:void` SQLite block, in one transaction. Status flip,
/// IMEI releases, ownership events, loyalty mirror and the money delta either
/// all land or none do. Status/IMEI failures stay best-effort exactly like the
/// renderer (they were caught and warned); the loyalty/money bundle is
/// authoritative and aborts the transaction.
pub fn void_sale_mirror_core(
    conn: &mut Connection,
    req: &VoidMirrorRequest,
) -> Result<VoidMirrorReport, String> {
    let tx = conn.transaction().map_err(|e| format!("void mirror tx: {e}"))?;
    if let Some(status) = transaction_status(&tx, &req.transaction_id) {
        if status == "VOIDED" {
            return Err("ALREADY_VOIDED".to_string());
        }
        if status == "REFUNDED" || status == "PARTIALLY_REFUNDED" {
            return Err("REFUNDED_TICKET".to_string());
        }
    }
    let mut report = VoidMirrorReport::default();

    // Best-effort, exactly like the renderer: a missing legacy row must not turn
    // a void into a hard failure.
    if tx
        .execute(
            "UPDATE transactions SET status='VOIDED', updated_at=?2, version = version + 1, sync_status='pending' WHERE id=?1",
            rusqlite::params![req.transaction_id, req.now_iso],
        )
        .is_ok()
    {
        report.status_changed = true;
    }

    for imei in &req.restored_imeis {
        let updated = tx.execute(
            "UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, version = version + 1 WHERE imei = ?1",
            rusqlite::params![imei],
        );
        if updated.is_ok() {
            report.imei_released += 1;
        }
        // Idempotent by event id.
        if tx
            .execute(
                "INSERT OR IGNORE INTO imei_events (id, imei, kind, ref_type, ref_id, at, actor, note)
                 VALUES (?1, ?2, 'RETURN_IN', 'order', ?3, ?4, '', ?5)",
                rusqlite::params![
                    format!("RETURN_IN:order:{}:{}", req.transaction_id, imei),
                    imei,
                    req.transaction_id,
                    req.now_iso,
                    "Annulation de vente"
                ],
            )
            .is_ok()
        {
            report.events_inserted += 1;
        }
    }

    if let Some(loyalty) = &req.loyalty {
        report.loyalty = Some(apply_loyalty_mirror_tx(&tx, loyalty)?);
    }
    if let Some(delta) = &req.money_delta {
        if delta.customer_id.trim().is_empty() || (delta.credit_delta == 0 && delta.debt_delta == 0) {
            report.money_changed = 0;
        } else {
            report.money_changed = tx
                .execute(
                    "UPDATE customers
                        SET store_credit = MAX(0, COALESCE(store_credit, 0) + ?2),
                            current_debt = MAX(0, COALESCE(current_debt, 0) + ?3),
                            updated_at = ?4,
                            version = version + 1
                      WHERE id = ?1 AND deleted = 0",
                    rusqlite::params![
                        delta.customer_id,
                        delta.credit_delta,
                        delta.debt_delta,
                        delta.now_iso
                    ],
                )
                .map_err(|e| format!("void money delta: {e}"))?;
        }
    }
    tx.commit().map_err(|e| format!("void mirror commit: {e}"))?;
    Ok(report)
}

/// The renderer `db:refund` SQLite block: original-status guard, then IMEI
/// releases + ownership events in one transaction.
pub fn refund_sale_mirror_core(
    conn: &mut Connection,
    req: &RefundMirrorRequest,
) -> Result<RefundMirrorReport, String> {
    let tx = conn.transaction().map_err(|e| format!("refund mirror tx: {e}"))?;
    if let Some(original) = req.original_transaction_id.as_deref() {
        if transaction_status(&tx, original).as_deref() == Some("VOIDED") {
            return Err("ORIGINAL_VOIDED".to_string());
        }
    }
    let mut report = RefundMirrorReport::default();
    for release in &req.releases {
        let updated = tx.execute(
            "UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, status = ?2, version = version + 1 WHERE imei = ?1",
            rusqlite::params![release.imei, release.status],
        );
        // A pre-heal table without the status column degrades to the legacy
        // sold-state reset, like the renderer's column probe.
        let updated = if updated.is_err() {
            tx.execute(
                "UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, version = version + 1 WHERE imei = ?1",
                rusqlite::params![release.imei],
            )
        } else {
            updated
        };
        if updated.is_ok() {
            report.imei_released += 1;
        }
        if tx
            .execute(
                "INSERT OR IGNORE INTO imei_events (id, imei, kind, ref_type, ref_id, at, actor, note)
                 VALUES (?1, ?2, ?3, 'order', ?4, ?5, '', ?6)",
                rusqlite::params![
                    format!("{}:order:{}:{}", release.kind, req.transaction_id, release.imei),
                    release.imei,
                    release.kind,
                    req.transaction_id,
                    req.now_iso,
                    release.note
                ],
            )
            .is_ok()
        {
            report.events_inserted += 1;
        }
    }
    tx.commit().map_err(|e| format!("refund mirror commit: {e}"))?;
    Ok(report)
}

#[tauri::command]
pub fn void_sale_mirror(
    app: tauri::AppHandle,
    request: VoidMirrorRequest,
) -> Result<VoidMirrorReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "void_sale_mirror",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            void_sale_mirror_core(&mut conn, &request).map_err(TrustError::op_failed)
        },
    )
}

#[tauri::command]
pub fn refund_sale_mirror(
    app: tauri::AppHandle,
    request: RefundMirrorRequest,
) -> Result<RefundMirrorReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "refund_sale_mirror",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let mut conn = open_db(&app)?;
            refund_sale_mirror_core(&mut conn, &request).map_err(TrustError::op_failed)
        },
    )
}

/// `saveStoreExpense` upsert (EBITDA row), idempotent, version bumped.
#[tauri::command]
pub fn upsert_store_expense(
    app: tauri::AppHandle,
    request: StoreExpenseRequest,
) -> Result<StoreExpenseReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "upsert_store_expense",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            let changes = conn
                .execute(
                    "INSERT INTO store_expenses (id, category, title, amount, payment_method, paid_to, notes, recorded_by, created_at, json_payload)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(id) DO UPDATE SET
                       category=excluded.category,
                       title=excluded.title,
                       amount=excluded.amount,
                       payment_method=excluded.payment_method,
                       paid_to=excluded.paid_to,
                       notes=excluded.notes,
                       recorded_by=excluded.recorded_by,
                       json_payload=excluded.json_payload,
                       version=store_expenses.version + 1",
                    rusqlite::params![
                        request.id,
                        request.category,
                        request.title,
                        request.amount,
                        request.payment_method,
                        request.paid_to,
                        request.notes,
                        request.recorded_by,
                        request.created_at,
                        request.json_payload
                    ],
                )
                .map_err(|e| TrustError::op_failed(format!("store expense: {e}")))?;
            Ok(StoreExpenseReport { changes })
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(
            "CREATE TABLE customers (
                id TEXT PRIMARY KEY, deleted INTEGER NOT NULL DEFAULT 0,
                json_payload TEXT NOT NULL, total_spent INTEGER, loyalty_points INTEGER,
                updated_at TEXT, version INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE store_expenses (
                id TEXT PRIMARY KEY, category TEXT, title TEXT, amount INTEGER,
                payment_method TEXT, paid_to TEXT, notes TEXT, recorded_by TEXT,
                created_at TEXT, json_payload TEXT, version INTEGER NOT NULL DEFAULT 1);",
        )
        .expect("schema");
        conn.execute(
            "INSERT INTO customers (id, json_payload, total_spent, loyalty_points, updated_at, version)
             VALUES ('C1', '{\"id\":\"C1\",\"ledger\":[]}', 1000, 10, '2026-11-01T00:00:00Z', 5)",
            [],
        )
        .unwrap();
        conn
    }

    fn mirror(entries: Vec<&str>) -> LoyaltyMirrorRequest {
        LoyaltyMirrorRequest {
            customer_id: "C1".to_string(),
            patch_json: "{\"loyaltyPoints\":12,\"currentCashier\":\"Ali\"}".to_string(),
            total_spent: Some(1500),
            loyalty_points: Some(12),
            updated_at: "2026-11-04T10:00:00.000Z".to_string(),
            ledger_entries: entries.into_iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn loyalty_bundle_commits_patch_and_ledger_together() {
        let mut conn = seeded();
        let report = apply_loyalty_mirror(
            &mut conn,
            &mirror(vec!["{\"id\":\"L1\",\"points\":2}", "{\"id\":\"L2\",\"points\":1}"]),
        )
        .expect("mirror");
        assert_eq!(report.rows_updated, 1);
        assert_eq!(report.ledger_appended, 2);
        assert!(report.ledger_missing.is_empty());

        let (payload, spent, points, version): (String, i64, i64, i64) = conn
            .query_row(
                "SELECT json_payload, total_spent, loyalty_points, version FROM customers WHERE id='C1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["loyaltyPoints"], 12);
        assert_eq!(parsed["currentCashier"], "Ali");
        assert_eq!(parsed["ledger"].as_array().unwrap().len(), 2);
        assert_eq!(spent, 1500);
        assert_eq!(points, 12);
        assert_eq!(version, 6);
    }

    #[test]
    fn ledger_append_is_idempotent_per_entry_id() {
        let mut conn = seeded();
        let entries = vec!["{\"id\":\"L1\",\"points\":2}"];
        apply_loyalty_mirror(&mut conn, &mirror(entries.clone())).expect("first");
        let second = apply_loyalty_mirror(&mut conn, &mirror(entries)).expect("second");
        assert_eq!(second.ledger_appended, 0, "the same id is not appended twice");
        assert_eq!(second.ledger_missing, vec!["L1".to_string()]);
        let payload: String = conn
            .query_row("SELECT json_payload FROM customers WHERE id='C1'", [], |r| r.get(0))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["ledger"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_missing_customer_changes_zero_rows_and_writes_no_ledger() {
        let mut conn = seeded();
        let mut req = mirror(vec!["{\"id\":\"L1\"}"]);
        req.customer_id = "GHOST".to_string();
        let report = apply_loyalty_mirror(&mut conn, &req).expect("no-op");
        assert_eq!(report.rows_updated, 0);
        assert_eq!(report.ledger_appended, 0);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM customers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "no stub is resurrected");
    }

    #[test]
    fn a_legacy_non_array_ledger_is_refused_not_nulled() {
        let mut conn = seeded();
        conn.execute(
            "UPDATE customers SET json_payload='{\"ledger\":\"legacy\"}' WHERE id='C1'",
            [],
        )
        .unwrap();
        let report = apply_loyalty_mirror(&mut conn, &mirror(vec!["{\"id\":\"L9\"}"]))
            .expect("mirror");
        assert_eq!(report.ledger_appended, 0);
        let payload: String = conn
            .query_row("SELECT json_payload FROM customers WHERE id='C1'", [], |r| r.get(0))
            .unwrap();
        assert!(payload.contains("\"legacy\""), "payload untouched: {payload}");
    }

    fn void_schema() -> Connection {
        let conn = seeded();
        conn.execute_batch(
            "ALTER TABLE customers ADD COLUMN store_credit INTEGER DEFAULT 0;
             ALTER TABLE customers ADD COLUMN current_debt INTEGER;
             CREATE TABLE transactions (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT,
                version INTEGER NOT NULL DEFAULT 1, sync_status TEXT);
             CREATE TABLE imei_records (imei TEXT PRIMARY KEY, sale_transaction_id TEXT, sold_at TEXT,
                status TEXT, version INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE imei_events (id TEXT PRIMARY KEY, imei TEXT, kind TEXT, ref_type TEXT,
                ref_id TEXT, at TEXT, actor TEXT, note TEXT);
             INSERT INTO transactions (id, status) VALUES ('T1', 'COMPLETED');
             INSERT INTO imei_records (imei, sale_transaction_id, sold_at, status) VALUES ('I1', 'T1', '2026-11-01', 'sold');",
        )
        .unwrap();
        conn
    }

    fn void_req() -> VoidMirrorRequest {
        VoidMirrorRequest {
            transaction_id: "T1".to_string(),
            now_iso: "2026-11-04T11:00:00.000Z".to_string(),
            restored_imeis: vec!["I1".to_string()],
            imei_status_available: true,
            loyalty: Some(mirror(vec!["{\"id\":\"L1\",\"points\":2}"])),
            money_delta: Some(MoneyDeltaRequest {
                customer_id: "C1".to_string(),
                credit_delta: 500,
                debt_delta: -200,
                now_iso: "2026-11-04T11:00:00.000Z".to_string(),
            }),
        }
    }

    #[test]
    fn void_bundle_is_atomic_status_imei_loyalty_and_money_together() {
        let mut conn = void_schema();
        let report = void_sale_mirror_core(&mut conn, &void_req()).expect("void");
        assert!(report.status_changed);
        assert_eq!(report.imei_released, 1);
        assert_eq!(report.events_inserted, 1);
        assert_eq!(report.money_changed, 1);
        assert_eq!(report.loyalty.as_ref().unwrap().ledger_appended, 1);

        let (status, imei_status, credit, debt): (String, String, i64, i64) = conn
            .query_row(
                "SELECT t.status, i.status, c.store_credit, c.current_debt
                   FROM transactions t, imei_records i, customers c
                  WHERE t.id='T1' AND i.imei='I1' AND c.id='C1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(status, "VOIDED");
        assert_eq!(imei_status, "sold", "the renderer's void does not change imei.status");
        assert_eq!(credit, 500);
        assert_eq!(debt, 0, "MAX(0, NULL + -200) clamps at 0");

        // Second void: typed refusal, nothing appended twice.
        let err = void_sale_mirror_core(&mut conn, &void_req()).expect_err("second void");
        assert_eq!(err, "ALREADY_VOIDED");
        let ledger: String = conn
            .query_row("SELECT json_payload FROM customers WHERE id='C1'", [], |r| r.get(0))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&ledger).unwrap();
        assert_eq!(parsed["ledger"].as_array().unwrap().len(), 1, "no double append");
    }

    #[test]
    fn a_failing_loyalty_bundle_rolls_the_void_back_completely() {
        let mut conn = void_schema();
        conn.execute_batch("DROP TABLE customers;").unwrap();
        let err = void_sale_mirror_core(&mut conn, &void_req()).expect_err("must roll back");
        assert!(err.contains("loyalty mirror"), "{err}");
        let status: String = conn
            .query_row("SELECT status FROM transactions WHERE id='T1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "COMPLETED", "status flip rolled back");
        let sold: String = conn
            .query_row("SELECT sold_at FROM imei_records WHERE imei='I1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sold, "2026-11-01", "IMEI release rolled back");
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM imei_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(events, 0, "no ownership event survives");
    }

    #[test]
    fn refund_mirror_refuses_an_original_that_was_voided() {
        let mut conn = void_schema();
        conn.execute("UPDATE transactions SET status='VOIDED' WHERE id='T1'", [])
            .unwrap();
        let err = refund_sale_mirror_core(
            &mut conn,
            &RefundMirrorRequest {
                transaction_id: "R1".to_string(),
                original_transaction_id: Some("T1".to_string()),
                now_iso: "2026-11-04T11:00:00.000Z".to_string(),
                releases: vec![ImeiRelease {
                    imei: "I1".to_string(),
                    status: "in_stock".to_string(),
                    kind: "RETURN_IN".to_string(),
                    note: "remboursement".to_string(),
                }],
            },
        )
        .expect_err("must refuse");
        assert_eq!(err, "ORIGINAL_VOIDED");
        let sold: String = conn
            .query_row("SELECT sold_at FROM imei_records WHERE imei='I1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sold, "2026-11-01", "nothing released");
    }

    #[test]
    fn refund_mirror_releases_and_records_once() {
        let mut conn = void_schema();
        let req = RefundMirrorRequest {
            transaction_id: "R1".to_string(),
            original_transaction_id: Some("T1".to_string()),
            now_iso: "2026-11-04T11:00:00.000Z".to_string(),
            releases: vec![ImeiRelease {
                imei: "I1".to_string(),
                status: "in_stock".to_string(),
                kind: "RETURN_IN".to_string(),
                note: "remboursement".to_string(),
            }],
        };
        let first = refund_sale_mirror_core(&mut conn, &req).expect("refund");
        let second = refund_sale_mirror_core(&mut conn, &req).expect("retry");
        assert_eq!(first.imei_released, 1);
        assert_eq!(second.imei_released, 1, "the reset is idempotent");
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM imei_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(events, 1, "INSERT OR IGNORE keeps one event");
    }

    fn debt_schema() -> Connection {
        let conn = seeded();
        conn.execute_batch(
            "ALTER TABLE customers ADD COLUMN name TEXT;
             ALTER TABLE customers ADD COLUMN phone TEXT;
             ALTER TABLE customers ADD COLUMN created_at TEXT;
             ALTER TABLE customers ADD COLUMN idempotency_key TEXT;
             CREATE TABLE customer_debts (
                id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT,
                type TEXT, amount INTEGER, balance_after INTEGER, receipt_number TEXT,
                payment_method TEXT, notes TEXT, recorded_by TEXT, created_at TEXT,
                json_payload TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT,
                deleted INTEGER NOT NULL DEFAULT 0, due_date TEXT, kind TEXT, origin TEXT);",
        )
        .unwrap();
        conn
    }

    fn debt_req() -> CustomerDebtRequest {
        CustomerDebtRequest {
            id: "D1".to_string(),
            customer_id: "C1".to_string(),
            customer_name: "Ali".to_string(),
            debt_type: "DEBT_ACQUIRED".to_string(),
            amount: 1000,
            balance_after: 1000,
            receipt_number: Some("REC-1".to_string()),
            payment_method: Some("Crédit".to_string()),
            notes: None,
            recorded_by: Some("Ali".to_string()),
            created_at: "2026-11-04T12:00:00.000Z".to_string(),
            json_payload: "{\"id\":\"D1\",\"version\":6}".to_string(),
            version: 6,
            updated_at: "2026-11-04T12:00:00.000Z".to_string(),
            due_date: None,
            kind: String::new(),
            origin: "operational".to_string(),
        }
    }

    #[test]
    fn debt_stub_is_idempotent_and_never_clobbers_a_live_parent() {
        let mut conn = debt_schema();
        // Live parent (seeded C1) that the stub must not overwrite.
        conn.execute(
            "UPDATE customers SET name='Live Name', phone='0550', version=9 WHERE id='C1'",
            [],
        )
        .unwrap();
        let first = upsert_customer_debt_core(&mut conn, &debt_req()).expect("first");
        assert!(!first.stub_inserted, "existing parent: no stub write");
        let second = upsert_customer_debt_core(&mut conn, &debt_req()).expect("retry");
        assert!(!second.stub_inserted);

        let (name, version): (String, i64) = conn
            .query_row("SELECT name, version FROM customers WHERE id='C1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(name, "Live Name", "stub never clobbers a live parent");
        assert_eq!(version, 9);
        let debts: i64 = conn
            .query_row("SELECT COUNT(*) FROM customer_debts WHERE id='D1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(debts, 1, "retry is an upsert, not a duplicate");
    }

    #[test]
    fn debt_stub_is_created_for_an_unknown_parent() {
        let mut conn = debt_schema();
        let mut req = debt_req();
        req.customer_id = "C-NEW".to_string();
        let report = upsert_customer_debt_core(&mut conn, &req).expect("insert");
        assert!(report.stub_inserted);
        let (name, key): (String, String) = conn
            .query_row(
                "SELECT name, idempotency_key FROM customers WHERE id='C-NEW'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "Ali");
        assert_eq!(key, "stub-cust-C-NEW");
    }

    #[test]
    fn debt_row_is_version_guarded() {
        let mut conn = debt_schema();
        upsert_customer_debt_core(&mut conn, &debt_req()).expect("v6");
        let mut stale = debt_req();
        stale.version = 5;
        stale.amount = 1;
        let report = upsert_customer_debt_core(&mut conn, &stale).expect("stale");
        assert_eq!(report.changes, 0, "an older version loses");
        let amount: i64 = conn
            .query_row("SELECT amount FROM customer_debts WHERE id='D1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(amount, 1000);
    }

    #[test]
    fn expense_upsert_is_idempotent_and_bumps_version() {
        let mut conn = seeded();
        let req = StoreExpenseRequest {
            id: "E1".to_string(),
            category: "Général".to_string(),
            title: "Carburant".to_string(),
            amount: 2000,
            payment_method: "Espèces".to_string(),
            paid_to: Some("Station".to_string()),
            notes: None,
            recorded_by: "Admin".to_string(),
            created_at: "2026-11-04T10:00:00.000Z".to_string(),
            json_payload: "{\"id\":\"E1\"}".to_string(),
        };
        // use the same statement as the command via a tiny helper call
        let upsert = |conn: &Connection| {
            conn.execute(
                "INSERT INTO store_expenses (id, category, title, amount, payment_method, paid_to, notes, recorded_by, created_at, json_payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, version=store_expenses.version + 1",
                rusqlite::params![req.id, req.category, req.title, req.amount, req.payment_method, req.paid_to, req.notes, req.recorded_by, req.created_at, req.json_payload],
            )
            .unwrap()
        };
        upsert(&conn);
        upsert(&conn);
        let (n, v): (i64, i64) = conn
            .query_row("SELECT COUNT(*), MAX(version) FROM store_expenses", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(v, 2);
    }
}

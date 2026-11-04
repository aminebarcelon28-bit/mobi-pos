//! Native shift-open lane (SEC-01 / ADR-005).
//!
//! Opening a cash session is fiscal state, so it does not get a quiet port. The
//! renderer used to `INSERT INTO cash_sessions` itself and then enqueue the sync
//! row separately; a crash between those two writes left a shift with no outbox
//! entry (a peer never learns the shift exists). This lane does all of it in ONE
//! native transaction:
//!
//!   * resolve the device identity natively (never from the caller);
//!   * refuse a second live shift for that device;
//!   * insert the `cash_sessions` row;
//!   * register the `entity_keys` idempotency key;
//!   * enqueue the `sync_outbox` UPSERT with the bumped version.
//!
//! Every statement is a fixed literal; the caller supplies values only.

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Caller-supplied shift fields. Deliberately has **no** device id: the device
/// is native state (`app_settings.sync.device_id`), so a renderer cannot claim
/// to be another terminal.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenShiftRequest {
    pub id: String,
    pub opened_at: String,
    pub opening_float: i64,
    pub cashier_name: String,
    #[serde(default)]
    pub opening_note: String,
    #[serde(default)]
    pub terminal_name: String,
    /// The session payload the renderer wants mirrored (display data).
    #[serde(default)]
    pub json_payload: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenShiftReport {
    pub session_id: String,
    pub device_id: String,
    pub idempotency_key: String,
    pub version: i64,
}

/// Typed refusal so the renderer can map it to `SHIFT_ALREADY_OPEN`.
#[derive(Debug, Clone)]
pub enum OpenShiftError {
    AlreadyOpen(String),
    Failed(String),
}

impl std::fmt::Display for OpenShiftError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenShiftError::AlreadyOpen(id) => write!(f, "SHIFT_ALREADY_OPEN: {id}"),
            OpenShiftError::Failed(msg) => write!(f, "{msg}"),
        }
    }
}

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("shift app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("shift open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("shift busy: {e}")))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::op_failed(format!("shift fk: {e}")))?;
    Ok(conn)
}

/// Resolve the terminal identity from `app_settings`, minting one if absent.
/// Same shape family as `settings_lane::ensure_device_id`.
pub fn resolve_device_id(conn: &Connection) -> String {
    let existing: Option<String> = conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'sync.device_id' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    if let Some(raw) = existing {
        if let Ok(serde_json::Value::String(id)) = serde_json::from_str::<serde_json::Value>(&raw) {
            if !id.is_empty() {
                return id;
            }
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let id = format!("device-{now}-{:08x}", std::process::id());
    let _ = conn.execute(
        "INSERT INTO app_settings (key, value_json, updated_at)
         VALUES ('sync.device_id', ?1, datetime('now','utc'))
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        rusqlite::params![serde_json::to_string(&id).unwrap_or_default()],
    );
    id
}

fn existing_key(conn: &Connection, entity: &str, id: &str) -> Option<(String, i64)> {
    conn.query_row(
        "SELECT idempotency_key, COALESCE(version, 1) FROM entity_keys
          WHERE entity_type = ?1 AND entity_id = ?2",
        rusqlite::params![entity, id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
    )
    .ok()
}

/// The fiscal transaction. One transaction: session + entity key + outbox, or
/// nothing at all.
pub fn open_shift_core(
    conn: &mut Connection,
    req: &OpenShiftRequest,
) -> Result<OpenShiftReport, OpenShiftError> {
    let device_id = resolve_device_id(conn);

    let live: Option<String> = conn
        .query_row(
            "SELECT id FROM cash_sessions
              WHERE device_id = ?1 AND status IN ('OPEN','CLOSING') LIMIT 1",
            rusqlite::params![device_id],
            |r| r.get(0),
        )
        .ok();
    if let Some(id) = live {
        return Err(OpenShiftError::AlreadyOpen(id));
    }

    let tx = conn
        .transaction()
        .map_err(|e| OpenShiftError::Failed(format!("shift tx: {e}")))?;

    let terminal = if req.terminal_name.trim().is_empty() {
        "Caisse Comptoir"
    } else {
        req.terminal_name.as_str()
    };
    let payload = if req.json_payload.trim().is_empty() {
        "{}".to_string()
    } else {
        req.json_payload.clone()
    };

    tx.execute(
        "INSERT INTO cash_sessions (
            id, opened_at, closed_at, opening_float, expected_cash, actual_cash, status,
            cashier_name, opening_note, closing_note, discrepancy,
            json_payload, updated_at, version, device_id, terminal_name
         ) VALUES (?1, ?2, NULL, ?3, NULL, NULL, 'OPEN', ?4, ?5, NULL, 0, ?6, ?2, 1, ?7, ?8)",
        rusqlite::params![
            req.id,
            req.opened_at,
            req.opening_float,
            req.cashier_name,
            req.opening_note,
            payload,
            device_id,
            terminal
        ],
    )
    .map_err(|e| OpenShiftError::Failed(format!("shift insert: {e}")))?;

    let (key, current_version) = match existing_key(&tx, "cash_session", &req.id) {
        Some(v) => v,
        None => {
            let k = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT OR IGNORE INTO entity_keys (entity_type, entity_id, idempotency_key, version)
                 VALUES ('cash_session', ?1, ?2, 1)",
                rusqlite::params![req.id, k],
            )
            .map_err(|e| OpenShiftError::Failed(format!("entity key: {e}")))?;
            (k, 1)
        }
    };
    let version = current_version + 1;

    // The clock is stored on the entity key row exactly like `bumpEntityVersion`.
    tx.execute(
        "UPDATE entity_keys SET version = ?1
          WHERE entity_type = 'cash_session' AND entity_id = ?2",
        rusqlite::params![version, req.id],
    )
    .map_err(|e| OpenShiftError::Failed(format!("entity key version: {e}")))?;

    // The outbox payload is rebuilt natively: the caller's JSON is display data,
    // but `deviceId` and `version` are native truth and cannot be spoofed.
    let mut payload_value: serde_json::Value =
        serde_json::from_str(&payload).unwrap_or_else(|_| serde_json::json!({}));
    if !payload_value.is_object() {
        payload_value = serde_json::json!({});
    }
    if let Some(obj) = payload_value.as_object_mut() {
        obj.insert(
            "deviceId".to_string(),
            serde_json::Value::String(device_id.clone()),
        );
        obj.insert("version".to_string(), serde_json::json!(version));
    }
    let outbox_payload = payload_value.to_string();
    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES (?1, 'cash_session', ?2, 'UPSERT', ?3, 'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation = 'UPSERT',
             payload_json = excluded.payload_json,
             status = 'pending',
             retry_count = 0,
             next_retry_at = NULL,
             last_error = NULL,
             updated_at = ?4",
        rusqlite::params![key, req.id, outbox_payload, req.opened_at],
    )
    .map_err(|e| OpenShiftError::Failed(format!("shift outbox: {e}")))?;

    tx.commit()
        .map_err(|e| OpenShiftError::Failed(format!("shift commit: {e}")))?;

    Ok(OpenShiftReport {
        session_id: req.id.clone(),
        device_id,
        idempotency_key: key,
        version,
    })
}

/// Native shift open. `OperationalWrites`, fixed literals, one transaction.
#[tauri::command]
pub fn open_shift(
    app: tauri::AppHandle,
    request: OpenShiftRequest,
) -> Result<OpenShiftReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "open_shift",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            if request.id.trim().is_empty() || request.opened_at.trim().is_empty() {
                return Err(TrustError::op_failed("open_shift: id and opened_at required"));
            }
            let mut conn = open_db(&app)?;
            open_shift_core(&mut conn, &request)
                .map_err(|e| TrustError::op_failed(e.to_string()))
        },
    )
}

/// Cashier hand-over on an open shift (fiscal attribution). Same transaction
/// shape as open: session row updated, entity key + outbox kept in step.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetShiftCashierRequest {
    pub id: String,
    pub cashier_name: String,
    pub updated_at: String,
    #[serde(default)]
    pub json_payload: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetShiftCashierReport {
    pub session_id: String,
    pub version: i64,
    pub idempotency_key: String,
}

pub fn set_shift_cashier_core(
    conn: &mut Connection,
    req: &SetShiftCashierRequest,
) -> Result<SetShiftCashierReport, String> {
    let cashier = req.cashier_name.trim();
    if cashier.is_empty() {
        return Err("CASHIER_NAME_REQUIRED".to_string());
    }
    let device_id = resolve_device_id(conn);

    let tx = conn.transaction().map_err(|e| format!("cashier tx: {e}"))?;

    let current_version: i64 = tx
        .query_row(
            "SELECT COALESCE(version, 1) FROM cash_sessions WHERE id = ?1",
            rusqlite::params![req.id],
            |r| r.get(0),
        )
        .map_err(|_| "SHIFT_NOT_OPEN".to_string())?;

    let payload = if req.json_payload.trim().is_empty() {
        "{}".to_string()
    } else {
        req.json_payload.clone()
    };

    // The session row and the entity key share one version: compute it from both
    // before writing, so the row cannot lag the outbox.
    let existing = existing_key(&tx, "cash_session", &req.id);
    let current_key_version = existing.as_ref().map(|(_, v)| *v).unwrap_or(1);
    let version = current_version.max(current_key_version) + 1;

    tx.execute(
        "UPDATE cash_sessions
            SET cashier_name = ?1,
                json_payload = ?2,
                updated_at = ?3,
                version = ?5
          WHERE id = ?4",
        rusqlite::params![cashier, payload, req.updated_at, req.id, version],
    )
    .map_err(|e| format!("cashier update: {e}"))?;

    let key = match existing {
        Some((k, _)) => k,
        None => {
            let k = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT OR IGNORE INTO entity_keys (entity_type, entity_id, idempotency_key, version)
                 VALUES ('cash_session', ?1, ?2, ?3)",
                rusqlite::params![req.id, k, version],
            )
            .map_err(|e| format!("cashier entity key: {e}"))?;
            k
        }
    };
    tx.execute(
        "UPDATE entity_keys SET version = ?1
          WHERE entity_type = 'cash_session' AND entity_id = ?2",
        rusqlite::params![version, req.id],
    )
    .map_err(|e| format!("cashier key version: {e}"))?;

    let mut payload_value: serde_json::Value =
        serde_json::from_str(&payload).unwrap_or_else(|_| serde_json::json!({}));
    if !payload_value.is_object() {
        payload_value = serde_json::json!({});
    }
    if let Some(obj) = payload_value.as_object_mut() {
        obj.insert(
            "deviceId".to_string(),
            serde_json::Value::String(device_id),
        );
        obj.insert("version".to_string(), serde_json::json!(version));
        obj.insert(
            "currentCashier".to_string(),
            serde_json::Value::String(cashier.to_string()),
        );
    }
    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES (?1, 'cash_session', ?2, 'UPSERT', ?3, 'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation = 'UPSERT',
             payload_json = excluded.payload_json,
             status = 'pending',
             retry_count = 0,
             next_retry_at = NULL,
             last_error = NULL,
             updated_at = ?4",
        rusqlite::params![key, req.id, payload_value.to_string(), req.updated_at],
    )
    .map_err(|e| format!("cashier outbox: {e}"))?;

    tx.commit().map_err(|e| format!("cashier commit: {e}"))?;
    Ok(SetShiftCashierReport {
        session_id: req.id.clone(),
        version,
        idempotency_key: key,
    })
}

/// Native cashier hand-over. `OperationalWrites`, fixed literals, one transaction.
#[tauri::command]
pub fn set_shift_cashier(
    app: tauri::AppHandle,
    request: SetShiftCashierRequest,
) -> Result<SetShiftCashierReport, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "set_shift_cashier",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            if request.id.trim().is_empty() || request.updated_at.trim().is_empty() {
                return Err(TrustError::op_failed(
                    "set_shift_cashier: id and updated_at required",
                ));
            }
            let mut conn = open_db(&app)?;
            set_shift_cashier_core(&mut conn, &request)
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
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT, version INTEGER);
             INSERT INTO app_settings (key, value_json) VALUES ('sync.device_id', '\"device-native\"');
             CREATE TABLE cash_sessions (
                id TEXT PRIMARY KEY, opened_at TEXT NOT NULL, closed_at TEXT,
                opening_float INTEGER NOT NULL, expected_cash INTEGER, actual_cash INTEGER,
                status TEXT NOT NULL DEFAULT 'OPEN', cashier_name TEXT,
                opening_note TEXT, closing_note TEXT, discrepancy INTEGER,
                json_payload TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
                device_id TEXT, terminal_name TEXT);
             CREATE TABLE entity_keys (
                entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (entity_type, entity_id));
             CREATE TABLE sync_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
                entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
                payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_error TEXT,
                updated_at TEXT);",
        )
        .expect("schema");
        conn
    }

    fn request() -> OpenShiftRequest {
        OpenShiftRequest {
            id: "SHIFT-T1".to_string(),
            opened_at: "2026-11-04T08:00:00.000Z".to_string(),
            opening_float: 5000,
            cashier_name: "Caissier".to_string(),
            opening_note: "ouverture".to_string(),
            terminal_name: "Caisse Comptoir".to_string(),
            json_payload: "{\"id\":\"SHIFT-T1\",\"deviceId\":\"SPOOFED\",\"status\":\"OPEN\"}"
                .to_string(),
        }
    }

    #[test]
    fn cashier_handover_updates_the_row_and_keeps_outbox_in_step() {
        let mut conn = seeded();
        open_shift_core(&mut conn, &request()).expect("open");
        let before: i64 = conn
            .query_row("SELECT version FROM cash_sessions WHERE id='SHIFT-T1'", [], |r| r.get(0))
            .unwrap();

        let report = set_shift_cashier_core(
            &mut conn,
            &SetShiftCashierRequest {
                id: "SHIFT-T1".to_string(),
                cashier_name: "Caissier Nuit".to_string(),
                updated_at: "2026-11-04T09:00:00.000Z".to_string(),
                json_payload: "{\"id\":\"SHIFT-T1\",\"currentCashier\":\"Caissier Nuit\"}"
                    .to_string(),
            },
        )
        .expect("handover");

        let (name, version): (String, i64) = conn
            .query_row(
                "SELECT cashier_name, version FROM cash_sessions WHERE id='SHIFT-T1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "Caissier Nuit");
        assert!(version > before, "handover bumps the version");
        assert_eq!(report.version, version);

        let (payload, key): (String, String) = conn
            .query_row(
                "SELECT payload_json, idempotency_key FROM sync_outbox WHERE entity_id='SHIFT-T1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(key, report.idempotency_key);
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["currentCashier"], "Caissier Nuit");
        assert_eq!(parsed["version"], version);
        assert_eq!(parsed["deviceId"], "device-native");
    }

    #[test]
    fn cashier_handover_refuses_an_unknown_shift() {
        let mut conn = seeded();
        let err = set_shift_cashier_core(
            &mut conn,
            &SetShiftCashierRequest {
                id: "SHIFT-MISSING".to_string(),
                cashier_name: "X".to_string(),
                updated_at: "2026-11-04T09:00:00.000Z".to_string(),
                json_payload: "{}".to_string(),
            },
        )
        .expect_err("unknown shift must fail");
        assert_eq!(err, "SHIFT_NOT_OPEN");
        let outbox: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(outbox, 0, "nothing is written when the shift is missing");
    }

    #[test]
    fn opens_a_shift_with_outbox_and_entity_key_parity() {
        let mut conn = seeded();
        let report = open_shift_core(&mut conn, &request()).expect("open");

        let (status, device): (String, String) = conn
            .query_row(
                "SELECT status, device_id FROM cash_sessions WHERE id='SHIFT-T1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "OPEN");
        assert_eq!(device, "device-native", "device id comes from native state");

        let keys: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM entity_keys WHERE entity_type='cash_session' AND entity_id='SHIFT-T1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(keys, 1, "entity key registered in the same transaction");

        let (etype, op, payload, key): (String, String, String, String) = conn
            .query_row(
                "SELECT entity_type, operation, payload_json, idempotency_key FROM sync_outbox",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(etype, "cash_session");
        assert_eq!(op, "UPSERT");
        assert_eq!(key, report.idempotency_key, "outbox key is the entity key");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["deviceId"], "device-native", "payload cannot spoof device");
        assert_eq!(parsed["version"], report.version);
        assert_eq!(report.version, 2, "first write bumps the clock to 2");
    }

    #[test]
    fn refuses_a_second_live_shift_and_writes_nothing() {
        let mut conn = seeded();
        open_shift_core(&mut conn, &request()).expect("first open");
        let mut second = request();
        second.id = "SHIFT-T2".to_string();
        let err = open_shift_core(&mut conn, &second).expect_err("second must refuse");
        assert!(matches!(err, OpenShiftError::AlreadyOpen(_)), "{err}");
        let sessions: i64 = conn
            .query_row("SELECT COUNT(*) FROM cash_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sessions, 1, "the refused open wrote no session");
        let outbox: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))
            .unwrap();
        assert_eq!(outbox, 1, "and no extra outbox row");
    }

    #[test]
    fn a_failing_outbox_write_rolls_back_the_session() {
        let mut conn = seeded();
        conn.execute_batch("DROP TABLE sync_outbox;").unwrap();
        let _ = open_shift_core(&mut conn, &request()).expect_err("outbox missing must fail");
        let sessions: i64 = conn
            .query_row("SELECT COUNT(*) FROM cash_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sessions, 0, "session insert is rolled back with the outbox");
    }
}

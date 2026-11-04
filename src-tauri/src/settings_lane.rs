//! Renderer settings/maintenance lanes moved native (SEC-01 item 6).
//!
//! The remaining renderer writes after the schema migration were all
//! settings-shaped: the device identity, `sync.*` flags, the monthly maintenance
//! marker, the idle vacuum, and an orphan-allocation cleanup. They now run as
//! role-bound native commands with fixed SQL; the renderer supplies parameters,
//! never statements.
//!
//! `set_sync_setting` is allowlisted to the `sync.` namespace: it must never
//! become a generic app_settings writer (that table carries PIN material).

use crate::trust_core::ipc_authorizer::TrustError;
use rusqlite::Connection;

fn open_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::op_failed(format!("settings app dir: {e}")))?;
    let conn = Connection::open(crate::e2e::live_db_path(&dir))
        .map_err(|e| TrustError::op_failed(format!("settings open: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_millis(15000))
        .map_err(|e| TrustError::op_failed(format!("settings busy: {e}")))?;
    Ok(conn)
}

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value_json FROM app_settings WHERE key = ?1 LIMIT 1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?1, ?2, datetime('now','utc'))
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        rusqlite::params![key, value],
    )
    .map(|_| ())
    .map_err(|e| format!("settings write {key}: {e}"))
}

fn validate_sync_key(key: &str) -> Result<(), String> {
    if !key.starts_with("sync.") || key.len() > 120 {
        return Err(format!("set_sync_setting: key not allowed ({key})"));
    }
    if key.chars().any(|c| c.is_control()) {
        return Err("set_sync_setting: control character in key".to_string());
    }
    Ok(())
}

/// The terminal identity. Returns the stored value, or mints and stores one.
#[tauri::command]
pub fn ensure_device_id(app: tauri::AppHandle) -> Result<String, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "ensure_device_id",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            if let Some(raw) = read_setting(&conn, "sync.device_id") {
                if let Ok(serde_json::Value::String(id)) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if !id.is_empty() {
                        return Ok(id);
                    }
                }
            }
            // Same shape family as newId("device"): time + entropy, no renderer input.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let entropy: u64 = {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                (now, std::process::id()).hash(&mut h);
                h.finish()
            };
            let id = format!("device-{now}-{:08x}", (entropy as u32));
            write_setting(&conn, "sync.device_id", &serde_json::to_string(&id).unwrap_or_default())
                .map_err(TrustError::op_failed)?;
            Ok(id)
        },
    )
}

/// Sensitive settings must never be writable through this lane: PIN material,
/// tokens, licence/MAC data and key envelopes all have dedicated native paths.
const SENSITIVE_KEY_PARTS: &[&str] = &[
    "pin", "token", "secret", "credential", "license", "licence", "mac", "key",
    "password", "hash", "salt",
];

fn key_is_safe(key: &str) -> bool {
    if key.is_empty() || key.len() > 160 {
        return false;
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
    {
        return false;
    }
    let lower = key.to_ascii_lowercase();
    !SENSITIVE_KEY_PARTS.iter().any(|p| lower.contains(p))
}

/// Generic application-settings write for non-sensitive keys (UI preferences,
/// store profile, sync flags). Sensitive keys are refused by name.
#[tauri::command]
pub fn set_app_setting(
    app: tauri::AppHandle,
    key: String,
    value_json: String,
) -> Result<(), TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "set_app_setting",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            if !key_is_safe(&key) {
                return Err(TrustError::op_failed(format!(
                    "set_app_setting: key refused ({key})"
                )));
            }
            if value_json.len() > 256 * 1024 {
                return Err(TrustError::op_failed("set_app_setting: value oversized"));
            }
            let conn = open_db(&app)?;
            write_setting(&conn, &key, &value_json).map_err(TrustError::op_failed)
        },
    )
}

/// Allowlisted `sync.*` settings write.
#[tauri::command]
pub fn set_sync_setting(
    app: tauri::AppHandle,
    key: String,
    value_json: String,
) -> Result<(), TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "set_sync_setting",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            validate_sync_key(&key).map_err(TrustError::op_failed)?;
            if value_json.len() > 64 * 1024 {
                return Err(TrustError::op_failed("setting value oversized"));
            }
            let conn = open_db(&app)?;
            write_setting(&conn, &key, &value_json).map_err(TrustError::op_failed)
        },
    )
}

/// Monthly idle maintenance: WAL checkpoint + bounded incremental vacuum.
#[tauri::command]
pub fn idle_maintenance(app: tauri::AppHandle) -> Result<(), TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "idle_maintenance",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|e| TrustError::op_failed(format!("checkpoint: {e}")))?;
            conn.execute_batch("PRAGMA incremental_vacuum(256);")
                .map_err(|e| TrustError::op_failed(format!("incremental vacuum: {e}")))?;
            Ok(())
        },
    )
}

/// Remove orphaned `alloc-*-item-*` twins (no sale filter = the boot cleanup).
#[tauri::command]
pub fn purge_orphan_allocations(app: tauri::AppHandle) -> Result<usize, TrustError> {
    crate::trust_core::ipc_authorizer::authorize_and_execute(
        "purge_orphan_allocations",
        crate::trust_core::capability_policy::Capability::OperationalWrites,
        |_| {
            let conn = open_db(&app)?;
            conn.execute(
                "DELETE FROM sale_batch_allocations
                  WHERE id GLOB 'alloc-*-item-*' AND deleted = 0
                    AND EXISTS (
                        SELECT 1 FROM sale_batch_allocations AS keep
                         WHERE keep.sale_id = sale_batch_allocations.sale_id
                           AND keep.batch_id = sale_batch_allocations.batch_id
                           AND keep.qty_consumed = sale_batch_allocations.qty_consumed
                           AND keep.unit_cost_at_sale = sale_batch_allocations.unit_cost_at_sale
                           AND keep.id NOT GLOB 'alloc-*-item-*'
                           AND keep.deleted = 0
                    )",
                [],
            )
            .map_err(|e| TrustError::op_failed(format!("orphan allocations: {e}")))
        },
    )
}

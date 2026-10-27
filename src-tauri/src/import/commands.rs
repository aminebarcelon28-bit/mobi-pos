//! IPC Commands for Smart Import / Easy Migration (Phase 1/2)

use crate::trust_core::{
    capability_policy::Capability,
    ipc_authorizer::{authorize_and_execute, TrustError},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::Manager;

use super::{
    commit::{commit_staged_batch, CommitResult},
    init_staging_db, inspect_file_bytes, open_live_db_readonly,
    ImportBatch, InspectResult, StagingRow,
};

#[derive(Debug, Clone, Deserialize)]
pub struct ImportInspectRequest {
    pub file_base64: Option<String>,
    pub file_path: Option<String>,
    pub file_name: String,
    pub sheet_index: Option<usize>,
    pub encoding_override: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportStageRequest {
    pub file_base64: Option<String>,
    pub file_path: Option<String>,
    pub file_name: String,
    pub sheet_index: Option<usize>,
    pub encoding_override: Option<String>,
    pub entity_type_override: Option<String>,
    pub column_overrides: Option<HashMap<usize, String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportStageResponse {
    pub batch: ImportBatch,
    pub staged_rows: Vec<StagingRow>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportCommitRequest {
    pub batch_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportGetBatchRequest {
    pub batch_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportBatchDetailsResponse {
    pub batch: ImportBatch,
    pub rows: Vec<StagingRow>,
}

fn read_file_payload(req_base64: Option<&str>, req_path: Option<&str>) -> Result<Vec<u8>, TrustError> {
    if let Some(b64) = req_base64 {
        // Strip data url prefix if present (e.g. data:text/csv;base64,...)
        let cleaned = if let Some(idx) = b64.find(";base64,") {
            &b64[idx + 8..]
        } else {
            b64
        };
        STANDARD.decode(cleaned.as_bytes()).map_err(|e| {
            TrustError::OperationFailed(format!("Invalid base64 file data: {}", e))
        })
    } else if let Some(path_str) = req_path {
        std::fs::read(path_str).map_err(|e| {
            TrustError::OperationFailed(format!("Failed to read file from path: {}", e))
        })
    } else {
        Err(TrustError::IPCProtocolError {
            reason: "Either file_base64 or file_path must be provided",
        })
    }
}

fn open_staging_db(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::OperationFailed(e.to_string()))?;
    let path = dir.join("import_staging.db");
    let conn = Connection::open(&path).map_err(|e| TrustError::OperationFailed(e.to_string()))?;
    init_staging_db(&conn).map_err(|e| TrustError::OperationFailed(e.to_string()))?;
    Ok(conn)
}

fn open_live_db_writable(app: &tauri::AppHandle) -> Result<Connection, TrustError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TrustError::OperationFailed(e.to_string()))?;
    let db_path = crate::e2e::live_db_path(&dir);
    let conn = Connection::open(&db_path).map_err(|e| TrustError::OperationFailed(e.to_string()))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| TrustError::OperationFailed(e.to_string()))?;
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(|e| TrustError::OperationFailed(e.to_string()))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| TrustError::OperationFailed(e.to_string()))?;
    Ok(conn)
}

#[tauri::command]
pub fn import_inspect_file(
    _app: tauri::AppHandle,
    request: ImportInspectRequest,
) -> Result<InspectResult, TrustError> {
    authorize_and_execute("import_inspect_file", Capability::ReadOperationalData, |_| {
        let bytes = read_file_payload(request.file_base64.as_deref(), request.file_path.as_deref())?;
        inspect_file_bytes(
            &bytes,
            &request.file_name,
            request.sheet_index,
            request.encoding_override.as_deref(),
        )
            .map_err(|e| TrustError::OperationFailed(e.to_string()))
    })
}

#[tauri::command]
pub fn import_stage_file(
    app: tauri::AppHandle,
    request: ImportStageRequest,
) -> Result<ImportStageResponse, TrustError> {
    authorize_and_execute("import_stage_file", Capability::OperationalWrites, |_| {
        let bytes = read_file_payload(request.file_base64.as_deref(), request.file_path.as_deref())?;
        let mut staging_conn = open_staging_db(&app)?;

        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| TrustError::OperationFailed(e.to_string()))?;
        let live_db_path = crate::e2e::live_db_path(&dir);
        let live_ro_conn = open_live_db_readonly(&live_db_path).map_err(|error| {
            TrustError::OperationFailed(format!(
                "Could not open the live database for import conflict checks: {error}"
            ))
        })?;

        let parsed = super::parser::parse_bytes_with_encoding_override(
            &bytes,
            &request.file_name,
            request.sheet_index,
            request.encoding_override.as_deref(),
        )
        .map_err(|e| TrustError::OperationFailed(e.to_string()))?;

        let batch_id = super::generate_batch_id(&parsed.file_sha256);
        let (staged_rows, entity_type, _warnings) = super::map::stage_table_with_overrides(
            &parsed,
            &batch_id,
            Some(&live_ro_conn),
            request.entity_type_override.as_deref(),
            request.column_overrides.as_ref(),
        )
        .map_err(|e| TrustError::OperationFailed(e.to_string()))?;

        let mut created = 0i64;
        let mut updated = 0i64;
        let mut skipped = 0i64;
        let mut rejected = 0i64;

        for r in &staged_rows {
            match r.action {
                super::StagingRowAction::Create => created += 1,
                super::StagingRowAction::Update => updated += 1,
                super::StagingRowAction::Skip => skipped += 1,
                super::StagingRowAction::Reject => rejected += 1,
            }
        }

        let batch = ImportBatch {
            batch_id: batch_id.clone(),
            file_name: request.file_name.clone(),
            file_sha256: parsed.file_sha256,
            entity_type: entity_type.as_str().to_string(),
            mapping_config_json: serde_json::json!({
                "sheet_index": request.sheet_index.unwrap_or(0),
                "encoding_override": request.encoding_override,
                "column_overrides": request.column_overrides
            })
            .to_string(),
            row_count: staged_rows.len() as i64,
            created_count: created,
            updated_count: updated,
            skipped_count: skipped,
            rejected_count: rejected,
            status: "staged".to_string(),
            created_at: super::current_iso_timestamp(),
            committed_at: None,
            rolled_back_at: None,
        };

        super::insert_staging_batch_tx(&mut staging_conn, &batch, &staged_rows)
            .map_err(|e| TrustError::OperationFailed(e.to_string()))?;

        Ok(ImportStageResponse {
            batch,
            staged_rows,
        })
    })
}

#[tauri::command]
pub fn import_commit_batch(
    app: tauri::AppHandle,
    request: ImportCommitRequest,
) -> Result<CommitResult, TrustError> {
    authorize_and_execute("import_commit_batch", Capability::OperationalWrites, |_| {
        let mut staging_conn = open_staging_db(&app)?;
        let mut live_conn = open_live_db_writable(&app)?;

        commit_staged_batch(&mut staging_conn, &mut live_conn, &request.batch_id)
            .map_err(|e| TrustError::OperationFailed(e.to_string()))
    })
}

#[tauri::command]
pub fn import_get_staged_batch(
    app: tauri::AppHandle,
    request: ImportGetBatchRequest,
) -> Result<ImportBatchDetailsResponse, TrustError> {
    authorize_and_execute("import_get_staged_batch", Capability::ReadOperationalData, |_| {
        let staging_conn = open_staging_db(&app)?;

        let batch: ImportBatch = staging_conn
            .query_row(
                "SELECT batch_id, file_name, file_sha256, entity_type, mapping_config_json, \
                 row_count, created_count, updated_count, skipped_count, rejected_count, \
                 status, created_at, committed_at, rolled_back_at \
                 FROM import_batches WHERE batch_id = ?1",
                rusqlite::params![request.batch_id],
                |r| {
                    Ok(ImportBatch {
                        batch_id: r.get(0)?,
                        file_name: r.get(1)?,
                        file_sha256: r.get(2)?,
                        entity_type: r.get(3)?,
                        mapping_config_json: r.get(4)?,
                        row_count: r.get(5)?,
                        created_count: r.get(6)?,
                        updated_count: r.get(7)?,
                        skipped_count: r.get(8)?,
                        rejected_count: r.get(9)?,
                        status: r.get(10)?,
                        created_at: r.get(11)?,
                        committed_at: r.get(12)?,
                        rolled_back_at: r.get(13)?,
                    })
                },
            )
            .map_err(|e| TrustError::OperationFailed(e.to_string()))?;

        let mut stmt = staging_conn
            .prepare(
                "SELECT batch_id, row_index, raw_row_json, normalized_json, action, \
                 matched_entity_id, rejection_reason, warnings_json, needs_review, idempotency_key \
                 FROM import_staging_rows WHERE batch_id = ?1 ORDER BY row_index ASC",
            )
            .map_err(|e| TrustError::OperationFailed(e.to_string()))?;

        let rows_iter = stmt
            .query_map(rusqlite::params![request.batch_id], |r| {
                let action_str: String = r.get(4)?;
                let action = match action_str.as_str() {
                    "create" => super::StagingRowAction::Create,
                    "update" => super::StagingRowAction::Update,
                    "skip" => super::StagingRowAction::Skip,
                    _ => super::StagingRowAction::Reject,
                };
                let needs_review_int: i64 = r.get(8)?;

                Ok(StagingRow {
                    batch_id: r.get(0)?,
                    row_index: r.get(1)?,
                    raw_row_json: r.get(2)?,
                    normalized_json: r.get(3)?,
                    action,
                    matched_entity_id: r.get(5)?,
                    rejection_reason: r.get(6)?,
                    warnings_json: r.get(7)?,
                    needs_review: needs_review_int != 0,
                    idempotency_key: r.get(9)?,
                })
            })
            .map_err(|e| TrustError::OperationFailed(e.to_string()))?;

        let mut rows = Vec::new();
        for r in rows_iter {
            rows.push(r.map_err(|e| TrustError::OperationFailed(e.to_string()))?);
        }

        Ok(ImportBatchDetailsResponse { batch, rows })
    })
}

#[tauri::command]
pub fn import_list_batches(
    app: tauri::AppHandle,
) -> Result<Vec<ImportBatch>, TrustError> {
    authorize_and_execute("import_list_batches", Capability::ReadOperationalData, |_| {
        let staging_conn = open_staging_db(&app)?;
        let mut stmt = staging_conn
            .prepare(
                "SELECT batch_id, file_name, file_sha256, entity_type, mapping_config_json, \
                 row_count, created_count, updated_count, skipped_count, rejected_count, \
                 status, created_at, committed_at, rolled_back_at \
                 FROM import_batches ORDER BY created_at DESC LIMIT 20",
            )
            .map_err(|e| TrustError::OperationFailed(e.to_string()))?;

        let batches_iter = stmt
            .query_map([], |r| {
                Ok(ImportBatch {
                    batch_id: r.get(0)?,
                    file_name: r.get(1)?,
                    file_sha256: r.get(2)?,
                    entity_type: r.get(3)?,
                    mapping_config_json: r.get(4)?,
                    row_count: r.get(5)?,
                    created_count: r.get(6)?,
                    updated_count: r.get(7)?,
                    skipped_count: r.get(8)?,
                    rejected_count: r.get(9)?,
                    status: r.get(10)?,
                    created_at: r.get(11)?,
                    committed_at: r.get(12)?,
                    rolled_back_at: r.get(13)?,
                })
            })
            .map_err(|e| TrustError::OperationFailed(e.to_string()))?;

        let mut list = Vec::new();
        for b in batches_iter {
            list.push(b.map_err(|e| TrustError::OperationFailed(e.to_string()))?);
        }
        Ok(list)
    })
}

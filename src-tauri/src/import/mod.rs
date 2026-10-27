//! Smart Import / Easy Migration (Slice 1)
//!
//! Option A: Dedicated sidecar staging database (`import_staging.db`) with read-only
//! live DB conflict detection (`SQLITE_OPEN_READ_ONLY` + `PRAGMA query_only = ON`).
//! Zero schema changes or migrations on `mobi_pos.db` in Slice 1.

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

pub mod parser;
pub mod detect;
pub mod map;
pub mod confidence;
pub mod eval_harness;
pub mod torture_tests;
pub mod commit;
pub mod commands;
pub mod dst_simulator;

#[derive(Debug, Error)]
pub enum ImportError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Excel parsing error: {0}")]
    Calamine(String),

    #[error("Zip bomb or excessive decompression ratio suspected: {0}")]
    ZipBombSuspected(String),

    #[error("Character encoding error: {0}")]
    InvalidEncoding(String),

    #[error("Maximum row limit exceeded ({0} > 100,000)")]
    MaxRowsExceeded(usize),

    #[error("File is empty or contains no readable data")]
    EmptyFile,

    #[error("Import error: {0}")]
    Other(String),
}

pub(crate) fn normalize_supplier_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Supported import destinations vs Reject / Defer Classes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityType {
    // Target MVP Entities
    Products,
    OpeningStock,
    Customers,

    // Reject / Defer Classes (detected to avoid misclassification into MVP)
    Suppliers,
    CustomerDebts,
    ActiveRepairs,
    SerializedImeis,
    TradeIns,

    // Unclassified / Ambiguous
    Unknown,
}

impl EntityType {
    pub fn is_target_mvp(&self) -> bool {
        matches!(
            self,
            EntityType::Products
                | EntityType::OpeningStock
                | EntityType::Customers
                | EntityType::CustomerDebts
        )
    }

    pub fn is_reject_class(&self) -> bool {
        matches!(
            self,
            EntityType::Suppliers
                | EntityType::ActiveRepairs
                | EntityType::SerializedImeis
                | EntityType::TradeIns
        )
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            EntityType::Products => "products",
            EntityType::OpeningStock => "opening_stock",
            EntityType::Customers => "customers",
            EntityType::Suppliers => "suppliers",
            EntityType::CustomerDebts => "customer_debts",
            EntityType::ActiveRepairs => "active_repairs",
            EntityType::SerializedImeis => "serialized_imeis",
            EntityType::TradeIns => "trade_ins",
            EntityType::Unknown => "unknown",
        }
    }
}

/// Logical Column Categories
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnType {
    // Product fields
    Barcode,
    Sku,
    Title,
    Price,
    CostPrice,
    WholesalePrice,
    Quantity,
    MinStock,
    Category,
    Brand,
    CompatibleModel,
    Warranty,
    SupplierName,
    SupplierPhone,

    // Customer fields
    CustomerName,
    Phone,
    SecondaryPhone,
    Email,
    Address,
    Notes,
    HistoricalTotalSpent,
    HistoricalStoreCredit,

    // Reject / Defer fields
    DebtBalance,
    Imei,
    Nif,
    RepairFault,
    RepairDevice,
    RepairDeposit,

    // Ignored / Unmapped
    Ignored,
}

impl ColumnType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ColumnType::Barcode => "barcode",
            ColumnType::Sku => "sku",
            ColumnType::Title => "title",
            ColumnType::Price => "price",
            ColumnType::CostPrice => "cost_price",
            ColumnType::WholesalePrice => "wholesale_price",
            ColumnType::Quantity => "quantity",
            ColumnType::MinStock => "min_stock",
            ColumnType::Category => "category",
            ColumnType::Brand => "brand",
            ColumnType::CompatibleModel => "compatible_model",
            ColumnType::Warranty => "warranty",
            ColumnType::SupplierName => "supplier_name",
            ColumnType::SupplierPhone => "supplier_phone",
            ColumnType::CustomerName => "customer_name",
            ColumnType::Phone => "phone",
            ColumnType::SecondaryPhone => "secondary_phone",
            ColumnType::Email => "email",
            ColumnType::Address => "address",
            ColumnType::Notes => "notes",
            ColumnType::HistoricalTotalSpent => "historical_total_spent",
            ColumnType::HistoricalStoreCredit => "historical_store_credit",
            ColumnType::DebtBalance => "debt_balance",
            ColumnType::Imei => "imei",
            ColumnType::Nif => "nif",
            ColumnType::RepairFault => "repair_fault",
            ColumnType::RepairDevice => "repair_device",
            ColumnType::RepairDeposit => "repair_deposit",
            ColumnType::Ignored => "ignored",
        }
    }
}

/// Staging row classification action
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StagingRowAction {
    Create,
    Update,
    Skip,
    Reject,
}

impl StagingRowAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            StagingRowAction::Create => "create",
            StagingRowAction::Update => "update",
            StagingRowAction::Skip => "skip",
            StagingRowAction::Reject => "reject",
        }
    }
}

/// Structured Diagnostic Warning
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportWarning {
    pub code: String,
    pub message: String,
}

/// Metadata header for an import batch
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportBatch {
    pub batch_id: String,
    pub file_name: String,
    pub file_sha256: String,
    pub entity_type: String,
    pub mapping_config_json: String,
    pub row_count: i64,
    pub created_count: i64,
    pub updated_count: i64,
    pub skipped_count: i64,
    pub rejected_count: i64,
    pub status: String,
    pub created_at: String,
    pub committed_at: Option<String>,
    pub rolled_back_at: Option<String>,
}

/// Single staged row in import_staging.db
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StagingRow {
    pub batch_id: String,
    pub row_index: i64,
    pub raw_row_json: String,
    pub normalized_json: Option<String>,
    pub action: StagingRowAction,
    pub matched_entity_id: Option<String>,
    pub rejection_reason: Option<String>,
    pub warnings_json: String,
    pub needs_review: bool,
    pub idempotency_key: String,
}

/// Pre-flight inspection result for the UI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectResult {
    pub file_sha256: String,
    pub file_name: String,
    pub detected_encoding: Option<String>,
    pub sheets: Vec<String>,
    pub active_sheet: String,
    pub detected_entity: EntityType,
    pub headers: Vec<String>,
    pub column_mappings: Vec<crate::import::confidence::ColumnMatchScore>,
    pub warnings: Vec<ImportWarning>,
    pub preview_rows: Vec<Vec<String>>,
    pub total_rows: usize,
}

/// Compute exact civil ISO 8601 timestamp (YYYY-MM-DDTHH:MM:SSZ) from system clock
pub fn current_iso_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    let mut y = 1970;
    let mut rem_days = days;
    loop {
        let leap = if (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0) { 366 } else { 365 };
        if rem_days >= leap {
            rem_days -= leap;
            y += 1;
        } else {
            break;
        }
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
    let month_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    for &d in &month_days {
        if rem_days >= d {
            rem_days -= d;
            month += 1;
        } else {
            break;
        }
    }
    let day = rem_days + 1;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, month, day, h, m, s)
}

/// Generate a unique, monotonically-sortable batch ID for an import execution
pub fn generate_batch_id(file_sha256: &str) -> String {
    let now_millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let prefix = if file_sha256.len() >= 8 {
        &file_sha256[..8]
    } else {
        file_sha256
    };
    format!("batch_{}_{}", prefix, now_millis)
}

/// Inspect raw file bytes and return detection results, sheet names, mappings, and preview rows
pub fn inspect_file_bytes(
    bytes: &[u8],
    file_name: &str,
    sheet_index: Option<usize>,
    encoding_override: Option<&str>,
) -> Result<InspectResult, ImportError> {
    let parsed = parser::parse_bytes_with_encoding_override(
        bytes,
        file_name,
        sheet_index,
        encoding_override,
    )?;
    let (entity, col_scores, mut warnings) = map::map_table_columns(&parsed);
    warnings.extend(parsed.warnings);

    let preview_limit = 10.min(parsed.rows.len());
    let preview_rows = parsed.rows[..preview_limit].to_vec();

    Ok(InspectResult {
        file_sha256: parsed.file_sha256,
        file_name: file_name.to_string(),
        detected_encoding: parsed.detected_encoding,
        sheets: parsed.sheet_names,
        active_sheet: parsed.active_sheet,
        detected_entity: entity,
        headers: parsed.headers,
        column_mappings: col_scores,
        warnings,
        preview_rows,
        total_rows: parsed.rows.len(),
    })
}

/// Complete pipeline: parse file bytes, run read-only live conflict checks, and stage into staging DB
pub fn stage_file_bytes(
    staging_conn: &mut Connection,
    bytes: &[u8],
    file_name: &str,
    sheet_index: Option<usize>,
    live_ro_conn: Option<&Connection>,
) -> Result<(ImportBatch, Vec<StagingRow>), ImportError> {
    let parsed = parser::parse_bytes(bytes, file_name, sheet_index)?;
    let batch_id = generate_batch_id(&parsed.file_sha256);
    let (staged_rows, entity_type, _warnings) = map::stage_table(&parsed, &batch_id, live_ro_conn)?;

    let mut created = 0i64;
    let mut updated = 0i64;
    let mut skipped = 0i64;
    let mut rejected = 0i64;

    for r in &staged_rows {
        match r.action {
            StagingRowAction::Create => created += 1,
            StagingRowAction::Update => updated += 1,
            StagingRowAction::Skip => skipped += 1,
            StagingRowAction::Reject => rejected += 1,
        }
    }

    let batch = ImportBatch {
        batch_id: batch_id.clone(),
        file_name: file_name.to_string(),
        file_sha256: parsed.file_sha256,
        entity_type: entity_type.as_str().to_string(),
        mapping_config_json: "{}".to_string(),
        row_count: staged_rows.len() as i64,
        created_count: created,
        updated_count: updated,
        skipped_count: skipped,
        rejected_count: rejected,
        status: "staged".to_string(),
        created_at: current_iso_timestamp(),
        committed_at: None,
        rolled_back_at: None,
    };

    insert_staging_batch_tx(staging_conn, &batch, &staged_rows)?;
    Ok((batch, staged_rows))
}

/// Initialize Option A sidecar database (`import_staging.db`).
/// Creates tables `import_batches` and `import_staging_rows` with non-vacuous CHECK constraints.
pub fn init_staging_db(conn: &Connection) -> Result<(), ImportError> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA cache_size = -64000;
        PRAGMA temp_store = MEMORY;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS import_batches (
            batch_id TEXT PRIMARY KEY,
            file_name TEXT NOT NULL,
            file_sha256 TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            mapping_config_json TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            created_count INTEGER NOT NULL DEFAULT 0,
            updated_count INTEGER NOT NULL DEFAULT 0,
            skipped_count INTEGER NOT NULL DEFAULT 0,
            rejected_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK(status IN ('staged', 'committed', 'rolled_back', 'failed')),
            created_at TEXT NOT NULL,
            committed_at TEXT,
            rolled_back_at TEXT,
            CHECK (row_count = created_count + updated_count + skipped_count + rejected_count)
        );

        CREATE INDEX IF NOT EXISTS idx_import_batches_sha ON import_batches(file_sha256);

        CREATE TABLE IF NOT EXISTS import_staging_rows (
            batch_id TEXT NOT NULL,
            row_index INTEGER NOT NULL,
            raw_row_json TEXT NOT NULL,
            normalized_json TEXT,
            action TEXT NOT NULL CHECK(action IN ('create', 'update', 'skip', 'reject')),
            matched_entity_id TEXT,
            rejection_reason TEXT,
            warnings_json TEXT NOT NULL DEFAULT '[]',
            needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0, 1)),
            idempotency_key TEXT NOT NULL,
            PRIMARY KEY (batch_id, row_index),
            FOREIGN KEY (batch_id) REFERENCES import_batches(batch_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_import_staging_rows_key ON import_staging_rows(idempotency_key);
        "#
    )?;
    Ok(())
}

/// Open live `mobi_pos.db` in strictly read-only mode with query_only=ON
pub fn open_live_db_readonly(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.execute_batch("PRAGMA query_only = ON;")?;
    Ok(conn)
}

/// Insert a complete batch and staged rows into `import_staging.db` within a single atomic transaction.
pub fn insert_staging_batch_tx(
    conn: &mut Connection,
    batch: &ImportBatch,
    rows: &[StagingRow],
) -> Result<(), ImportError> {
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // Idempotent replacement: clean up any existing staged rows and batch header
    tx.execute(
        "DELETE FROM import_staging_rows WHERE batch_id = ?1",
        rusqlite::params![batch.batch_id],
    )?;
    tx.execute(
        "DELETE FROM import_batches WHERE batch_id = ?1",
        rusqlite::params![batch.batch_id],
    )?;

    tx.execute(
        r#"
        INSERT INTO import_batches (
            batch_id, file_name, file_sha256, entity_type,
            mapping_config_json, row_count, created_count,
            updated_count, skipped_count, rejected_count,
            status, created_at, committed_at, rolled_back_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
        )
        "#,
        rusqlite::params![
            batch.batch_id,
            batch.file_name,
            batch.file_sha256,
            batch.entity_type,
            batch.mapping_config_json,
            batch.row_count,
            batch.created_count,
            batch.updated_count,
            batch.skipped_count,
            batch.rejected_count,
            batch.status,
            batch.created_at,
            batch.committed_at,
            batch.rolled_back_at,
        ],
    )?;

    {
        let mut stmt = tx.prepare(
            r#"
            INSERT INTO import_staging_rows (
                batch_id, row_index, raw_row_json, normalized_json,
                action, matched_entity_id, rejection_reason,
                warnings_json, needs_review, idempotency_key
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
            )
            "#,
        )?;

        for r in rows {
            stmt.execute(rusqlite::params![
                r.batch_id,
                r.row_index,
                r.raw_row_json,
                r.normalized_json,
                r.action.as_str(),
                r.matched_entity_id,
                r.rejection_reason,
                r.warnings_json,
                if r.needs_review { 1 } else { 0 },
                r.idempotency_key,
            ])?;
        }
    }

    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_staging_db_and_positive_insert() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_staging_db(&conn).unwrap();

        let batch = ImportBatch {
            batch_id: "batch_001".to_string(),
            file_name: "test.csv".to_string(),
            file_sha256: "dummy_sha256".to_string(),
            entity_type: "products".to_string(),
            mapping_config_json: "{}".to_string(),
            row_count: 2,
            created_count: 1,
            updated_count: 1,
            skipped_count: 0,
            rejected_count: 0,
            status: "staged".to_string(),
            created_at: "2026-10-21T10:00:00Z".to_string(),
            committed_at: None,
            rolled_back_at: None,
        };

        let rows = vec![
            StagingRow {
                batch_id: "batch_001".to_string(),
                row_index: 0,
                raw_row_json: "[\"Chargeur\", \"1500\"]".to_string(),
                normalized_json: Some("{\"title\":\"Chargeur\",\"price\":{\"minor\":150000,\"dzd\":1500}}".to_string()),
                action: StagingRowAction::Create,
                matched_entity_id: None,
                rejection_reason: None,
                warnings_json: "[]".to_string(),
                needs_review: false,
                idempotency_key: "idem_0".to_string(),
            },
            StagingRow {
                batch_id: "batch_001".to_string(),
                row_index: 1,
                raw_row_json: "[\"Cable\", \"500\"]".to_string(),
                normalized_json: Some("{\"title\":\"Cable\",\"price\":{\"minor\":50000,\"dzd\":500}}".to_string()),
                action: StagingRowAction::Update,
                matched_entity_id: Some("prod_123".to_string()),
                rejection_reason: None,
                warnings_json: "[]".to_string(),
                needs_review: false,
                idempotency_key: "idem_1".to_string(),
            },
        ];

        insert_staging_batch_tx(&mut conn, &batch, &rows).unwrap();

        let count: i64 = conn
            .query_row("SELECT count(*) FROM import_staging_rows WHERE batch_id = 'batch_001'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_negative_check_constraint_fails() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_staging_db(&conn).unwrap();

        // row_count is 10, but sum of (created + updated + skipped + rejected) is 9
        let invalid_batch = ImportBatch {
            batch_id: "batch_invalid".to_string(),
            file_name: "test.csv".to_string(),
            file_sha256: "dummy_sha256".to_string(),
            entity_type: "products".to_string(),
            mapping_config_json: "{}".to_string(),
            row_count: 10,
            created_count: 5,
            updated_count: 4,
            skipped_count: 0,
            rejected_count: 0, // Sum = 9 != 10!
            status: "staged".to_string(),
            created_at: "2026-10-21T10:00:00Z".to_string(),
            committed_at: None,
            rolled_back_at: None,
        };

        let res = insert_staging_batch_tx(&mut conn, &invalid_batch, &[]);
        assert!(res.is_err(), "Expected CHECK constraint failure on row_count sum mismatch!");
        if let Err(ImportError::Sqlite(err)) = res {
            assert!(
                err.to_string().contains("CHECK constraint failed"),
                "Expected CHECK constraint error message, got: {}",
                err
            );
        } else {
            panic!("Expected Sqlite error, got {:?}", res);
        }
    }
}

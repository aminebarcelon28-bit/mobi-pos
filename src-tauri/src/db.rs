//! PO-recon persistence: vendor alias cache + 384-dim vector index.
//!
//! Adaptation note (vs greenfield spec): this repo's live DB (`mobi_pos.db`,
//! migrations v1–v105 in `lib.rs`) already owns `products(id TEXT PK, ...)`
//! and `products_fts` (v6 FTS5 over title/brand/sku/barcode/category).
//! This module therefore NEVER recreates `products` or `products_fts`
//! (`CREATE ... IF NOT EXISTS` would be a silent no-op on the live DB but
//! would mint a divergent INTEGER schema on fresh test DBs). It only ensures:
//!   - `vendor_aliases(supplier_name, raw_vendor_name -> products.id TEXT)`
//!   - `vec_products` vec0 table: `product_row INTEGER PRIMARY KEY,
//!      embedding float[384] distance_metric=cosine, product_tid TEXT`
//!     (TEXT product UUIDs live in a metadata column — supported since
//!     sqlite-vec 0.1.6 — because vec0 partition keys must be INTEGER).
//!
//! Stock writes go to the existing FIFO `stock_batches` + `inventory_ledger`
//! (see `commands.rs`), not a greenfield `stock_ledger` table.

use rusqlite::{ffi::sqlite3_auto_extension, Connection, Result};
use std::path::Path;

/// Register the sqlite-vec extension for every connection opened afterwards.
/// Must be called once before `Connection::open` (auto-extension hook).
#[allow(clippy::missing_transmute_annotations)]
pub fn register_vec_extension() {
    unsafe {
        sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }
}

/// SQL applied both by `ensure_po_recon_tables` (rusqlite, tests/standalone)
/// and by the tauri-plugin-sql v106 migration in `lib.rs` (live app DB).
/// Deliberately omits `products` / `products_fts`: owned by v1/v6.
pub const PO_RECON_MIGRATION_V106: &str = r#"
CREATE TABLE IF NOT EXISTS vendor_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_name TEXT NOT NULL,
    raw_vendor_name TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(supplier_name, raw_vendor_name)
);
CREATE INDEX IF NOT EXISTS idx_vendor_alias_lookup
ON vendor_aliases(supplier_name, raw_vendor_name);

CREATE TABLE IF NOT EXISTS scan_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    user_id TEXT,
    supplier_name TEXT NOT NULL,
    items_count INTEGER NOT NULL,
    grand_total REAL NOT NULL,
    delta REAL NOT NULL,
    is_balanced INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_scan_audit_log_trace
ON scan_audit_log(trace_id);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_products USING vec0(
    product_row INTEGER PRIMARY KEY,
    embedding float[384] distance_metric=cosine,
    product_tid TEXT
);
"#;

/// SQL applied by the tauri-plugin-sql v106 migration (live app DB).
/// NOTE: sqlx (behind tauri-plugin-sql) does NOT load the sqlite-vec
/// extension, so `USING vec0` here would abort boot with
/// "no such module: vec0" and brick startup. This migration therefore only
/// creates the plain `vendor_aliases` table; `vec_products` is created lazily
/// by `ensure_po_recon_tables` (rusqlite with the extension registered) on
/// first PO-recon invoke.
pub const PO_RECON_PLUGIN_MIGRATION_V106: &str = r#"
CREATE TABLE IF NOT EXISTS vendor_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_name TEXT NOT NULL,
    raw_vendor_name TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(supplier_name, raw_vendor_name)
);
CREATE INDEX IF NOT EXISTS idx_vendor_alias_lookup
ON vendor_aliases(supplier_name, raw_vendor_name);

CREATE TABLE IF NOT EXISTS scan_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    user_id TEXT,
    supplier_name TEXT NOT NULL,
    items_count INTEGER NOT NULL,
    grand_total REAL NOT NULL,
    delta REAL NOT NULL,
    is_balanced INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_scan_audit_log_trace
ON scan_audit_log(trace_id);
"#;

/// Ensure PO-recon tables exist on an open rusqlite connection.
pub fn ensure_po_recon_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(PO_RECON_MIGRATION_V106)?;
    Ok(())
}

pub fn initialize_database(db_path: &Path) -> Result<Connection> {
    register_vec_extension();

    let conn = Connection::open(db_path)?;

    // High-concurrency WAL configuration (matches spec).
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;

    ensure_po_recon_tables(&conn)?;

    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db() -> Connection {
        register_vec_extension();
        let conn = Connection::open_in_memory().expect("in-memory open");
        conn.execute_batch(
            r#"
            CREATE TABLE products (
                id TEXT PRIMARY KEY, sku TEXT NOT NULL, barcode TEXT NOT NULL,
                title TEXT NOT NULL, cost_price REAL DEFAULT 0
            );
            "#,
        )
        .unwrap();
        ensure_po_recon_tables(&conn).expect("recon tables");
        conn
    }

    #[test]
    fn test_vec_version_available() {
        let conn = open_test_db();
        let ver: String = conn
            .query_row("SELECT vec_version()", [], |r| r.get(0))
            .expect("vec_version() must be registered");
        assert!(!ver.is_empty());
    }

    /// Acceptance §11.1: 384-dim inserts succeed; 383/385-dim fail loudly.
    #[test]
    fn test_vec_dimension_constraint() {
        let conn = open_test_db();

        let ok_vec = vec![0.1f32; 384];
        let ok_bytes: &[u8] = bytemuck::cast_slice(&ok_vec);
        conn.execute(
            "INSERT INTO vec_products(product_row, product_tid, embedding) VALUES (?1, ?2, ?3)",
            rusqlite::params![1i64, "prod-1", ok_bytes],
        )
        .expect("384-dim insert must succeed");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM vec_products", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);

        for (bad_dim, row) in [(383usize, 2i64), (385usize, 3i64)] {
            let bad = vec![0.1f32; bad_dim];
            let bad_bytes: &[u8] = bytemuck::cast_slice(&bad);
            let err = conn
                .execute(
                    "INSERT INTO vec_products(product_row, product_tid, embedding) VALUES (?1, ?2, ?3)",
                    rusqlite::params![row, format!("prod-{row}"), bad_bytes],
                )
                .expect_err(&format!("{bad_dim}-dim insert must fail"));
            let msg = err.to_string();
            assert!(
                msg.to_lowercase().contains("dimension")
                    || msg.to_lowercase().contains("384")
                    || msg.to_lowercase().contains("size")
                    || msg.to_lowercase().contains("blob"),
                "unexpected error for {bad_dim}-dim insert: {msg}"
            );
        }
    }

    /// TIME-002: all SQLite timestamp defaults mint ISO8601 UTC
    /// (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), never `datetime('now','utc')`
    /// (`YYYY-MM-DD HH:MM:SS`, space-separated, second precision) or bare
    /// `CURRENT_TIMESTAMP`. Mixed formats break lexicographic cross-table
    /// ordering and lose causal tiebreak precision.
    /// NOTE (bounded residual): the live v104 `sale_batch_allocations` body
    /// in lib.rs is sqlx-checksum-frozen and keeps `CURRENT_TIMESTAMP` on
    /// already-migrated DBs; TS writers stamp `created_at` explicitly so the
    /// default never fires there. This test pins the forward-mint points.
    #[test]
    fn test_timestamp_defaults_unified_iso8601() {
        for sql in [PO_RECON_MIGRATION_V106, PO_RECON_PLUGIN_MIGRATION_V106] {
            let lower = sql.to_lowercase();
            assert!(
                !lower.contains("datetime('now'"),
                "legacy datetime('now') default still present"
            );
            assert!(
                !lower.contains("current_timestamp"),
                "legacy CURRENT_TIMESTAMP default still present"
            );
            assert!(
                sql.contains("strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
                "ISO8601 strftime default missing"
            );
        }
        // End-to-end: a default-minted row parses as ISO8601 T/Z with millis.
        let conn = open_test_db();
        conn.execute(
            "INSERT INTO products(id, sku, barcode, title) VALUES ('p1','SKU1','BC1','Widget')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vendor_aliases(supplier_name, raw_vendor_name, product_id) VALUES ('ACME','widgit','p1')",
            [],
        )
        .unwrap();
        let minted: String = conn
            .query_row(
                "SELECT created_at FROM vendor_aliases WHERE supplier_name='ACME'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            minted.len() == 24 && minted.contains('T') && minted.ends_with('Z'),
            "default-minted created_at is not ISO8601 millis UTC: {minted}"
        );
    }

    #[test]
    fn test_vendor_alias_unique() {
        let conn = open_test_db();
        conn.execute(
            "INSERT INTO products(id, sku, barcode, title) VALUES ('p1','SKU1','BC1','Widget')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vendor_aliases(supplier_name, raw_vendor_name, product_id) VALUES ('ACME','widgit','p1')",
            [],
        )
        .unwrap();
        // Same (supplier, raw) pair re-inserted via REPLACE semantics elsewhere;
        // plain INSERT must violate the UNIQUE constraint.
        assert!(conn
            .execute(
                "INSERT INTO vendor_aliases(supplier_name, raw_vendor_name, product_id) VALUES ('ACME','widgit','p1')",
                [],
            )
            .is_err());
    }
}

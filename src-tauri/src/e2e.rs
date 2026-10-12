//! E2E test hooks — test builds ONLY.
//!
//! The module is always compiled so `run()` shares the single `db_filename()`
//! source of truth, but the three `e2e_*` *commands* (the IPC surface) exist
//! only under `#[cfg(any(debug_assertions, feature = "e2e"))]` and are
//! registered in the handler on the same cfg. Consumer production builds
//! (release without `--features e2e`) contain no `e2e_*` IPC surface
//! (Gate 1.3 proves it).
//!
//! Design (owner resolutions #7 / #8; isolated `.e2e` mode since Phase 1):
//! - All commands operate on the ISOLATED test database (`mobi_pos.db` inside
//!   the `com.mobi.pos.e2e` data dir — the workspace-patched sql plugin
//!   rejects any other filename, so isolation lives in the data DIR, never
//!   the name). `e2e_reset_db` / `e2e_seed_state` / `e2e_reset_and_seed` are
//!   destructive within that container only: reset wipes domain rows, seed
//!   writes `E2E-`-prefixed rows. Production data is never opened.
//! - The merchant cloud is still never touched: under `feature = "e2e"` the
//!   cloud-credential commands are sealed (read -> None, write/delete ->
//!   denied), so SyncManager never arms push/pull in a test run.
//! - `e2e_reset_db`: clears all **data** rows (schema, migrations ledger,
//!   triggers — including the v109 `REFUND_BYPASS` guard — are preserved).
//! - `e2e_seed_state`: inserts products / one open shift / mock sales with
//!   schema-correct minimal rows (all money as integer DA; `REAL` columns
//!   receive integer-valued floats, exact by construction).
//! - `e2e_get_db_state`: out-of-band oracle — raw table counts, `user_version`
//!   and `PRAGMA integrity_check` via rusqlite. Imports no app math.
//!
//! These commands intentionally bypass `authorize_and_execute`: they exist
//! only in test builds. Trust tables (audit/device/PIN) may be cleared here;
//! reset preserves the migration ledger + sync epoch flags, and the cloud
//! credential seal (lib.rs) keeps test runs from reaching the network.
//!
//! ISOLATED-CONTAINER NOTE: the e2e flavor opens the `com.mobi.pos.e2e`
//! data dir — reset wipes test-container rows, seed writes test rows. Take
//! no backup of production data for e2e runs (nothing production is opened);
//! seeded rows carry `E2E-` id prefixes.

#[cfg(any(debug_assertions, feature = "e2e"))]
use rusqlite::{Connection, OptionalExtension};
#[cfg(any(debug_assertions, feature = "e2e"))]
use std::path::PathBuf;
#[cfg(any(debug_assertions, feature = "e2e"))]
use tauri::Manager;

/// DB filename shared with the `tauri-plugin-sql` migration URL in `run()`
/// and the TS loader (`sqlPluginAdapter.ts`).
///
/// ALWAYS `mobi_pos.db`: the workspace-patched plugin confines `load` to
/// exactly that filename (4.4 traversal hardening — any other name is
/// rejected and the app boots degraded). Isolation lives in the data DIR
/// (the `com.mobi.pos.e2e` identifier), never in the filename.
pub fn db_filename() -> &'static str {
    "mobi_pos.db"
}

/// Full live-DB path for NATIVE code (refund, PIN, audit, outbox, backups…).
/// Every `app_dir.join("mobi_pos.db")` site must go through here so the e2e
/// flavor keeps ONE database file per data dir — a hardcoded name here
/// re-splits the brain the harness was built to unify (Phase 1 finding).
pub fn live_db_path(app_dir: &std::path::Path) -> std::path::PathBuf {
    app_dir.join(db_filename())
}

#[cfg(any(debug_assertions, feature = "e2e"))]
fn resolve_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(crate::e2e::live_db_path(&dir))
}

#[cfg(any(debug_assertions, feature = "e2e"))]
fn open_db(path: &std::path::Path) -> Result<Connection, String> {
    // Same extensions as the app's own native handles (db.rs): real data
    // may contain the lazily-created `vec_products` vec0 table (PO recon),
    // and counting it without the module fails with `no such module: vec0`.
    crate::db::register_vec_extension();
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[cfg(any(debug_assertions, feature = "e2e"))]
fn user_version(conn: &Connection) -> Result<u32, String> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

#[cfg(any(debug_assertions, feature = "e2e"))]
fn user_tables(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' \
             AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(names)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetReport {
    pub db_path: String,
    pub db_filename: String,
    pub tables_cleared: Vec<String>,
    pub rows_deleted: u64,
    pub user_version: u32,
    pub migrated_version: i64,
}

/// Wipe all DATA rows from the isolated test DB, preserving schema,
/// the migration ledgers (`_sqlx_migrations`, `schema_migrations` — wiping
/// the ledger makes sqlx re-run non-idempotent ALTERs on next boot and
/// bricks the file) and all triggers/views.
///
/// FTS discipline (hard-won): `products_fts_*` shadow tables are managed by
/// FTS5 — deleting their rows directly destroys the index cookie and
/// corrupts the index (`invalid fts5 file format ... run 'rebuild'`, caught
/// by the Phase 1 harness run). Shadows are SKIPPED; the index content is
/// cleared with `DELETE FROM products_fts` (structure + cookie survive) and
/// verified with `integrity-check`. Base `products` rows are deleted first
/// so the `trg_products_fts_*` triggers keep the index consistent.
///
/// The whole sweep runs in ONE transaction: all or nothing, never a
/// half-wiped file.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_reset_db(app: tauri::AppHandle) -> Result<ResetReport, String> {
    let path = resolve_db_path(&app)?;
    let mut conn = open_db(&path)?;
    // Fail-closed on a damaged file (Phase 3 incident: one wrapper snapshot
    // showed freelist damage; a sweep over damaged pages can neither be
    // trusted nor safely completed). Surface, never touch.
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if integrity != "ok" {
        return Err(format!(
            "e2e_reset_db refused: integrity_check failed ({integrity}); \
             restore from a known-good snapshot instead"
        ));
    }
    // FK off for the sweep only (parents are deleted before children in
    // places); re-enabled right after commit. The connection is short-lived.
    conn.pragma_update(None, "foreign_keys", "OFF")
        .map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut cleared = Vec::new();
    let mut rows_deleted: u64 = 0;
    for table in user_tables(&tx)? {
        // Migration ledgers: wiping them re-triggers the full chain.
        if table == "schema_migrations" || table == "_sqlx_migrations" {
            continue;
        }
        // FTS5 shadow tables: managed by FTS, never touched directly.
        if table.starts_with("products_fts_") {
            continue;
        }
        if table == "app_settings" {
            // Preserved (baseline, like the ledger):
            // - `sync.backfill_v*` / `sync.remirror*`: one-shot epoch markers;
            //   wiping them makes the next boot re-mirror Dexie ghosts into
            //   the clean file (Phase 1 finding).
            // - `manager_pin` / `cashier_users`: team identity mirrors. The
            //   native keystore (not SQLite) is the PIN authority, but the
            //   first-boot setup gate reads these mirrors — wiping them
            //   forces every post-reset boot through setup (P1 defect §11).
            //   Preserving them keeps post-reset boots on the lock screen.
            // Merchant data keys are still wiped. Preserved keys are
            // reported so specs can assert the exact set.
            let mut stmt = tx
                .prepare(
                    "SELECT key FROM app_settings WHERE key LIKE 'sync.backfill_v%' \
                     OR key LIKE 'sync.remirror%' OR key IN ('manager_pin','cashier_users')",
                )
                .map_err(|e| format!("reset app_settings scan: {e}"))?;
            let preserved: Vec<String> = stmt
                .query_map([], |r| r.get(0))
                .map_err(|e| format!("reset app_settings scan: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("reset app_settings scan: {e}"))?;
            let n = tx
                .execute(
                    "DELETE FROM app_settings WHERE key NOT LIKE 'sync.backfill_v%' \
                     AND key NOT LIKE 'sync.remirror%' \
                     AND key NOT IN ('manager_pin','cashier_users')",
                    [],
                )
                .map_err(|e| format!("reset app_settings: {e}"))?;
            rows_deleted += n as u64;
            cleared.push(format!("{table} (flags kept: {preserved:?})"));
            continue;
        }
        let n = tx
            .execute(&format!("DELETE FROM \"{table}\""), [])
            .map_err(|e| format!("reset {table}: {e}"))?;
        rows_deleted += n as u64;
        cleared.push(table);
    }
    // Reset AUTOINCREMENT counters so repeated seeds are deterministic.
    let _ = tx.execute("DELETE FROM sqlite_sequence", []);
    // FTS self-check: fails closed on a corrupt index instead of handing
    // tests a file whose search silently disagrees with its tables.
    tx.execute(
        "INSERT INTO products_fts(products_fts) VALUES('integrity-check')",
        [],
    )
    .map_err(|e| format!("reset fts integrity-check: {e}"))?;
    tx.commit().map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    // Best-effort checkpoint; the sqlx pool may hold the WAL.
    let _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)", []);
    let version = user_version(&conn)?;
    let migrated: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok(ResetReport {
        db_path: path.to_string_lossy().into_owned(),
        db_filename: db_filename().to_string(),
        tables_cleared: cleared,
        rows_deleted,
        user_version: version,
        migrated_version: migrated,
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedProduct {
    pub id: String,
    pub title: String,
    pub price_da: i64,
    pub stock: i64,
    #[serde(default)]
    pub barcode: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    /// Unit cost (DA). Default 0 (no below-cost gate). Set above the test
    /// price to arm the `overrideCartItemPrice` below-cost manager gate.
    #[serde(default)]
    pub cost_da: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedShift {
    pub id: String,
    pub opening_float: i64,
    pub cashier_name: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedLine {
    pub product_id: String,
    pub quantity: i64,
    pub applied_price_da: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedSale {
    pub id: String,
    pub receipt_number: String,
    pub total_da: i64,
    #[serde(default)]
    pub lines: Vec<SeedLine>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedSetting {
    pub key: String,
    pub value_json: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedCustomer {
    pub id: String,
    pub name: String,
    pub phone: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedPayload {
    #[serde(default)]
    pub products: Vec<SeedProduct>,
    #[serde(default)]
    pub open_shift: Option<SeedShift>,
    #[serde(default)]
    pub mock_sales: Vec<SeedSale>,
    /// Raw `app_settings` rows (fixtures/flags). Keys are written verbatim;
    /// prefer the `E2E-` prefix for test-only keys. Never used for PIN
    /// material: the native keystore is the PIN authority — settings only
    /// carry UI mirrors (see the P1 defect note in §11 of e2e/DISCOVERY.md).
    #[serde(default)]
    pub settings: Vec<SeedSetting>,
    /// Customers (id/name/phone). Seeded rows carry `e2e-cust-` idempotency
    /// keys; json_payload is `{}` (the app backfills mirrors on read).
    #[serde(default)]
    pub customers: Vec<SeedCustomer>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedReport {
    pub db_path: String,
    pub products: usize,
    pub shifts: usize,
    pub sales: usize,
    pub sale_lines: usize,
    pub settings: usize,
    pub customers: usize,
}

#[cfg(any(debug_assertions, feature = "e2e"))]
fn non_empty(what: &str, v: &str) -> Result<(), String> {
    if v.trim().is_empty() {
        return Err(format!("{what}: empty id"));
    }
    Ok(())
}

/// Seed products / one open shift / mock sales into the isolated test DB
/// in a single rusqlite transaction (atomic: all or nothing).
///
/// Integer-quantity invariant (owner resolution #6): quantities are `i64`;
/// a fractional JSON value (e.g. `1.5`) fails deserialization and the seed
/// is rejected — it never reaches the DB.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_seed_state(
    app: tauri::AppHandle,
    payload: SeedPayload,
) -> Result<SeedReport, String> {
    for p in &payload.products {
        non_empty("product.id", &p.id)?;
        non_empty("product.title", &p.title)?;
        if p.price_da < 0 {
            return Err(format!("product {}: negative price_da", p.id));
        }
        if p.stock < 0 {
            return Err(format!("product {}: negative stock", p.id));
        }
        if p.cost_da < 0 {
            return Err(format!("product {}: negative cost_da", p.id));
        }
    }
    if let Some(s) = &payload.open_shift {
        non_empty("open_shift.id", &s.id)?;
        if s.opening_float < 0 {
            return Err("open_shift: negative opening_float".into());
        }
    }
    for s in &payload.settings {
        non_empty("setting.key", &s.key)?;
    }
    for c in &payload.customers {
        non_empty("customer.id", &c.id)?;
        non_empty("customer.name", &c.name)?;
    }
    for s in &payload.mock_sales {
        non_empty("mock_sale.id", &s.id)?;
        non_empty("mock_sale.receipt_number", &s.receipt_number)?;
        if s.total_da < 0 {
            return Err(format!("mock_sale {}: negative total_da", s.id));
        }
        for l in &s.lines {
            if l.quantity < 1 {
                return Err(format!("mock_sale {}: quantity must be >= 1", s.id));
            }
            if l.applied_price_da < 0 {
                return Err(format!("mock_sale {}: negative applied_price_da", s.id));
            }
        }
    }

    let path = resolve_db_path(&app)?;
    let mut conn = open_db(&path)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut sale_lines = 0usize;
    for p in &payload.products {
        let barcode = p.barcode.clone().unwrap_or_else(|| p.id.clone());
        let category = p.category.clone().unwrap_or_else(|| "Test".to_string());
        // REAL columns receive integer-valued floats: exact, never 19.99-style.
        // idempotency_key is UNIQUE with a DEFAULT '' that would collide
        // across rows — always mint a per-row key.
        tx.execute(
            "INSERT INTO products \
             (id, sku, barcode, title, brand, compatible_model, category, \
              price, wholesale_price, cost_price, stock, image_url, json_payload, updated_at, \
              idempotency_key) \
             VALUES (?1, ?1, ?2, ?3, '', NULL, ?4, ?5, 0, ?6, ?7, NULL, '{}', datetime('now','utc'), \
               'e2e-prod-' || ?1) \
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, price=excluded.price, \
               stock=excluded.stock, barcode=excluded.barcode, category=excluded.category, \
               cost_price=excluded.cost_price, idempotency_key=excluded.idempotency_key",
            rusqlite::params![
                p.id,
                barcode,
                p.title,
                category,
                p.price_da as f64,
                p.cost_da as f64,
                p.stock
            ],
        )
            .map_err(|e| format!("seed product {}: {e}", p.id))?;
        // Opening ledger baseline: the app treats `products.stock` as the
        // cached SUM of `inventory_ledger` (recomputed on checkout/refund),
        // and PO receiving mints +qty rows. A seed without a baseline would
        // make the first recompute collapse cached stock to the delta sum.
        // Tagged E2E-SEED so it is never mistaken for merchant movements.
        if p.stock > 0 {
            tx.execute(
                "INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, \
                 device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version) \
                 VALUES ('E2E-BASE-' || ?1, ?1, ?2, 'SEED', 'seed', ?1, \
                 'e2e-seed', 'e2e-base-' || ?1, 'pending', datetime('now','utc'), datetime('now','utc'), 0, 1) \
                 ON CONFLICT(id) DO UPDATE SET delta=excluded.delta",
                rusqlite::params![p.id, p.stock],
            )
            .map_err(|e| format!("seed product {} baseline: {e}", p.id))?;
        }
    }
    let mut shifts = 0usize;
    if let Some(s) = &payload.open_shift {
        tx.execute(
            "INSERT INTO cash_sessions \
             (id, opened_at, opening_float, status, cashier_name, json_payload, updated_at) \
             VALUES (?1, datetime('now','utc'), ?2, 'OPEN', ?3, '{}', datetime('now','utc')) \
             ON CONFLICT(id) DO UPDATE SET opening_float=excluded.opening_float, \
               status='OPEN', cashier_name=excluded.cashier_name",
            rusqlite::params![s.id, s.opening_float, s.cashier_name],
        )
        .map_err(|e| format!("seed open_shift: {e}"))?;
        shifts = 1;
    }
    for s in &payload.mock_sales {
        tx.execute(
            "INSERT INTO transactions \
             (id, receipt_number, subtotal, discount_total, total, pricing_tier, \
              payment_method, status, created_at, json_payload, idempotency_key) \
             VALUES (?1, ?2, ?3, 0, ?3, 'Retail', 'Espèces', 'COMPLETED', \
               datetime('now','utc'), '{}', 'e2e-sale-' || ?1) \
             ON CONFLICT(id) DO UPDATE SET total=excluded.total, subtotal=excluded.subtotal, \
               idempotency_key=excluded.idempotency_key",
            rusqlite::params![s.id, s.receipt_number, s.total_da as f64],
        )
        .map_err(|e| format!("seed mock_sale {}: {e}", s.id))?;
        for (idx, l) in s.lines.iter().enumerate() {
            let item_id = format!("{}-L{idx}", s.id);
            tx.execute(
                "INSERT INTO transaction_items \
                 (id, transaction_id, product_id, quantity, applied_price, discount, json_payload, \
                  idempotency_key) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, '{}', 'e2e-line-' || ?1) \
                 ON CONFLICT(id) DO UPDATE SET quantity=excluded.quantity, \
                   applied_price=excluded.applied_price, idempotency_key=excluded.idempotency_key",
                rusqlite::params![
                    item_id,
                    s.id,
                    l.product_id,
                    l.quantity,
                    l.applied_price_da as f64
                ],
            )
            .map_err(|e| format!("seed mock_sale {} line {idx}: {e}", s.id))?;
            sale_lines += 1;
        }
    }
    for s in &payload.settings {
        tx.execute(
            "INSERT INTO app_settings (key, value_json, updated_at) \
             VALUES (?1, ?2, datetime('now','utc')) \
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, \
               updated_at=excluded.updated_at",
            rusqlite::params![s.key, s.value_json],
        )
        .map_err(|e| format!("seed setting {}: {e}", s.key))?;
    }
    for c in &payload.customers {
        tx.execute(
            "INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key) \
             VALUES (?1, ?2, ?3, '{}', datetime('now','utc'), 'e2e-cust-' || ?1) \
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone",
            rusqlite::params![c.id, c.name, c.phone],
        )
        .map_err(|e| format!("seed customer {}: {e}", c.id))?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(SeedReport {
        db_path: path.to_string_lossy().into_owned(),
        products: payload.products.len(),
        shifts,
        sales: payload.mock_sales.len(),
        sale_lines,
        settings: payload.settings.len(),
        customers: payload.customers.len(),
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCount {
    pub name: String,
    pub rows: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStateReport {
    pub db_path: String,
    pub db_filename: String,
    pub user_version: u32,
    /// MAX(version) from sqlx's `_sqlx_migrations` ledger (0 when absent).
    /// THIS is the migration baseline — NOT `PRAGMA user_version`, which
    /// sqlx does not maintain (always 0; the C6 boot gate reads a pragma
    /// nothing writes — pre-existing quirk, reported, out of scope).
    pub migrated_version: i64,
    pub integrity_check: String,
    pub tables: Vec<TableCount>,
    /// All `app_settings` keys (small table; lets specs assert that a reset
    /// kept exactly the sync epoch flags and no merchant settings).
    pub settings_keys: Vec<String>,
    /// Full settings map (small table). Lets specs READ-then-APPEND roster
    /// JSON (e.g. provisioning a test cashier) without fabricating state.
    /// Test-build only; never leaves the machine.
    pub settings_values: Vec<SettingValue>,
    /// Newest sales (id, receipt_number, total_da, status), newest first.
    /// Lets specs find the sale a UI flow just created without guessing ids.
    pub recent_sales: Vec<RecentSale>,
    /// Shift math for the Z-report equality check: the open shift (if any)
    /// plus cash-sale / cash-refund totals over COMPLETED rows.
    /// `expected_cash = opening_float + cash_sales - cash_refunds`
    /// (deposits/expenses/drops live in cash_movements — Phase 3 extends).
    pub shift_summary: ShiftSummary,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSale {
    pub id: String,
    pub receipt_number: String,
    pub total_da: f64,
    pub status: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSummary {
    pub open_shift_id: Option<String>,
    pub opening_float_da: f64,
    /// Gross COMPLETED non-refund Espèces-method totals (SQLite columns).
    /// This is NOT drawer cash for split tenders (a mixed sale counts its
    /// full total here while only the cash legs reach the drawer — see the
    /// app's legs-minus-change rule in cashTerms). Drawer-cash assertions
    /// must sum tender legs via e2e_get_sale, never this field alone.
    pub cash_sales_da: f64,
    pub cash_refunds_da: f64,
    /// MANUAL_DEPOSIT movements (drawer top-ups). ALLOCATION rows (refund
    /// trail, informational) never enter drawer math — same exclusion as
    /// the app's own readers.
    pub movements_in_da: f64,
    /// EXPENSE movements (drawer payouts/drops).
    pub movements_out_da: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftOut {
    pub found: bool,
    pub id: String,
    pub status: String,
    pub opening_float_da: f64,
    pub expected_cash_da: Option<f64>,
    pub actual_cash_da: Option<f64>,
    pub discrepancy_da: Option<f64>,
    pub closed_at: Option<String>,
}

/// Test-harness bridge (Phase 4, owner-directed): mirror a UI-opened shift
/// (Dexie authority) into SQLite `cash_sessions` with status OPEN so the
/// native `refund_sale_atomic` step-13 session gate can verify it.
///
/// NO production code path calls this. It exists because the app has no
/// production writer of UI shift opens into SQLite `cash_sessions` (logged
/// as a P1 defect in `e2e/DISCOVERY.md` §11) — without the mirror every
/// production-path cash refund fails `NO_OPEN_SHIFT`. Idempotent per id.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_mirror_shift_open(
    app: tauri::AppHandle,
    id: String,
    opening_float: f64,
    cashier_name: String,
) -> Result<bool, String> {
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    conn.execute(
        "INSERT INTO cash_sessions \
         (id, opened_at, opening_float, status, cashier_name, json_payload, updated_at) \
         VALUES (?1, datetime('now','utc'), ?2, 'OPEN', ?3, '{}', datetime('now','utc')) \
         ON CONFLICT(id) DO UPDATE SET status='OPEN', opening_float=excluded.opening_float, \
           cashier_name=excluded.cashier_name, updated_at=datetime('now','utc')",
        rusqlite::params![id, opening_float, cashier_name],
    )
    .map_err(|e| format!("mirror shift: {e}"))?;
    Ok(true)
}

/// Shift row reader (close verification: frozen status + discrepancy).
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_get_shift(app: tauri::AppHandle, id: String) -> Result<ShiftOut, String> {
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    let row: Option<(String, f64, Option<f64>, Option<f64>, Option<f64>, Option<String>)> = conn
        .query_row(
            "SELECT status, opening_float, expected_cash, actual_cash, discrepancy, closed_at \
             FROM cash_sessions WHERE id = ?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((status, opening_float_da, expected_cash_da, actual_cash_da, discrepancy_da, closed_at)) =
        row
    else {
        return Ok(ShiftOut {
            found: false,
            id,
            status: String::new(),
            opening_float_da: 0.0,
            expected_cash_da: None,
            actual_cash_da: None,
            discrepancy_da: None,
            closed_at: None,
        });
    };
    Ok(ShiftOut {
        found: true,
        id,
        status,
        opening_float_da,
        expected_cash_da,
        actual_cash_da,
        discrepancy_da,
        closed_at,
    })
}

/// Out-of-band test oracle: raw table counts + `user_version` +
/// `PRAGMA integrity_check`, read directly via rusqlite.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_get_db_state(app: tauri::AppHandle) -> Result<DbStateReport, String> {
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    let version = user_version(&conn)?;
    let migrated: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut tables = Vec::new();
    for table in user_tables(&conn)? {
        let rows: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| {
                r.get(0)
            })
            .map_err(|e| format!("count {table}: {e}"))?;
        tables.push(TableCount { name: table, rows });
    }
    let settings_keys: Vec<String> = conn
        .prepare("SELECT key FROM app_settings ORDER BY key")
        .and_then(|mut s| {
            s.query_map([], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .unwrap_or_default();
    let settings_values: Vec<SettingValue> = conn
        .prepare("SELECT key, value_json FROM app_settings ORDER BY key")
        .and_then(|mut s| {
            s.query_map([], |r| {
                Ok(SettingValue {
                    key: r.get(0)?,
                    value_json: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap_or_default();
    let recent_sales: Vec<RecentSale> = conn
        .prepare(
            "SELECT id, receipt_number, total, status FROM transactions \
             ORDER BY rowid DESC LIMIT 10",
        )
        .and_then(|mut s| {
            s.query_map([], |r| {
                Ok(RecentSale {
                    id: r.get(0)?,
                    receipt_number: r.get(1)?,
                    total_da: r.get(2)?,
                    status: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap_or_default();
    // Open shift (at most one by the SHIFT_ALREADY_OPEN invariant) + cash
    // lane totals. Cash sales = COMPLETED, non-refund, Espèces tender rows;
    // cash refunds = COMPLETED refund rows with cash tendered. Integer DA
    // domain: REAL columns hold integer-valued floats (exact).
    let open_row: Option<(String, f64)> = conn
        .query_row(
            "SELECT id, opening_float FROM cash_sessions WHERE status = 'OPEN' \
             ORDER BY opened_at DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let cash_sales_da: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(total), 0) FROM transactions \
             WHERE status = 'COMPLETED' AND COALESCE(is_refund, 0) = 0 \
             AND payment_method = 'Espèces'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let cash_refunds_da: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(total), 0) FROM transactions \
             WHERE status = 'COMPLETED' AND COALESCE(is_refund, 0) = 1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let (open_shift_id, opening_float_da) = open_row
        .map(|(id, f)| (Some(id), f))
        .unwrap_or((None, 0.0));
    let movements_in_da: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM cash_movements WHERE type = 'MANUAL_DEPOSIT'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let movements_out_da: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM cash_movements WHERE type = 'EXPENSE'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(DbStateReport {
        db_path: path.to_string_lossy().into_owned(),
        db_filename: db_filename().to_string(),
        user_version: version,
        migrated_version: migrated,
        integrity_check: integrity,
        tables,
        settings_keys,
        settings_values,
        recent_sales,
        shift_summary: ShiftSummary {
            open_shift_id,
            opening_float_da,
            cash_sales_da,
            cash_refunds_da,
            movements_in_da,
            movements_out_da,
        },
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductStockOut {
    pub id: String,
    pub found: bool,
    /// Cached `products.stock` (what tiles display).
    pub cached_stock: i64,
    /// Durable `SUM(delta)` over `inventory_ledger` (authority).
    /// `None` when the product has no ledger rows (pre-baseline legacy).
    pub ledger_sum: Option<i64>,
}

/// Stock oracle pair: cached display value AND durable ledger sum.
/// Money assertions must use `ledger_sum`; a cache/sum mismatch is UI
/// mirror drift (proven: tile aria went stale post-sale while the ledger
/// stayed exact), never ledger corruption — report it as such.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_get_product_stock(
    app: tauri::AppHandle,
    id: String,
) -> Result<ProductStockOut, String> {
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    let cached: Option<i64> = conn
        .query_row("SELECT stock FROM products WHERE id = ?1", [&id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(cached_stock) = cached else {
        return Ok(ProductStockOut {
            id,
            found: false,
            cached_stock: 0,
            ledger_sum: None,
        });
    };
    let ledger_sum: Option<i64> = conn
        .query_row(
            "SELECT SUM(delta) FROM inventory_ledger WHERE product_id = ?1 AND deleted = 0",
            [&id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(ProductStockOut {
        id,
        found: true,
        cached_stock,
        ledger_sum,
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingValue {
    pub key: String,
    pub value_json: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtEntryOut {
    pub amount_da: f64,
    pub balance_after_da: f64,
    pub receipt_number: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerLedgerOut {
    pub customer_id: String,
    pub found_customer: bool,
    pub entries: Vec<DebtEntryOut>,
}

/// Customer debt ledger reader (amounts as stored REAL dinars; specs
/// convert with their own oracle). Ground truth for split-tender debt legs.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_get_customer_ledger(
    app: tauri::AppHandle,
    customer_id: String,
) -> Result<CustomerLedgerOut, String> {
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    let found_customer: bool = conn
        .query_row(
            "SELECT 1 FROM customers WHERE id = ?1",
            [&customer_id],
            |_| Ok(()),
        )
        .is_ok();
    let mut stmt = conn
        .prepare(
            "SELECT amount, balance_after, COALESCE(receipt_number, '') FROM customer_debts \
             WHERE customer_id = ?1 ORDER BY rowid",
        )
        .map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map([&customer_id], |r| {
            Ok(DebtEntryOut {
                amount_da: r.get(0)?,
                balance_after_da: r.get(1)?,
                receipt_number: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(CustomerLedgerOut {
        customer_id,
        found_customer,
        entries,
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleLineOut {
    pub product_id: String,
    pub quantity: i64,
    pub applied_price_da: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TenderOut {
    pub method: String,
    pub amount_da: f64,
}

fn parse_tenders(payload: &str) -> Vec<TenderOut> {
    let v: serde_json::Value = serde_json::from_str(payload).unwrap_or(serde_json::Value::Null);
    v.get("tenders")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| TenderOut {
                    method: t
                        .get("method")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .to_string(),
                    amount_da: t.get("amount").and_then(|a| a.as_f64()).unwrap_or(0.0),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleOut {
    pub found: bool,
    pub id: String,
    pub receipt_number: String,
    pub subtotal_da: f64,
    pub discount_total_da: f64,
    pub total_da: f64,
    pub payment_method: String,
    pub cash_tendered_da: f64,
    pub change_due_da: f64,
    pub status: String,
    pub lines: Vec<SaleLineOut>,
    /// Tender legs parsed from the stored receipt JSON (`fullTx.tenders`).
    /// SQLite has no payments table — legs live here. Empty for legacy rows.
    pub tenders: Vec<TenderOut>,
}

/// Stored-sale reader for the three-way equality check (oracle vs UI vs
/// stored). Read-only ground truth: amounts come back as stored (REAL
/// dinars); specs convert to integer minor units with their own oracle —
/// never with app math.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_get_sale(app: tauri::AppHandle, id: String) -> Result<SaleOut, String> {
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    let row: Option<(String, f64, f64, f64, String, f64, f64, String, String)> = conn
        .query_row(
            "SELECT receipt_number, subtotal, discount_total, total, payment_method, \
             cash_tendered, change_due, status, json_payload FROM transactions WHERE id = ?1",
            rusqlite::params![id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((receipt_number, subtotal_da, discount_total_da, total_da, payment_method, cash_tendered_da, change_due_da, status, json_payload)) = row
    else {
        return Ok(SaleOut {
            found: false,
            id,
            receipt_number: String::new(),
            subtotal_da: 0.0,
            discount_total_da: 0.0,
            total_da: 0.0,
            payment_method: String::new(),
            cash_tendered_da: 0.0,
            change_due_da: 0.0,
            status: String::new(),
            lines: vec![],
            tenders: vec![],
        });
    };
    let mut stmt = conn
        .prepare(
            "SELECT product_id, quantity, applied_price FROM transaction_items \
             WHERE transaction_id = ?1 ORDER BY rowid",
        )
        .map_err(|e| e.to_string())?;
    let lines = stmt
        .query_map(rusqlite::params![id], |r| {
            Ok(SaleLineOut {
                product_id: r.get(0)?,
                quantity: r.get(1)?,
                applied_price_da: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(SaleOut {
        found: true,
        id,
        receipt_number,
        subtotal_da,
        discount_total_da,
        total_da,
        payment_method,
        cash_tendered_da,
        change_due_da,
        status,
        tenders: parse_tenders(&json_payload),
        lines,
    })
}

// ── Phase 1 harness commands (Gate 1): read/setup-only, never sale creation ──
// Money tests drive sales through the same paths the UI uses (TS
// `processPayment` + native `refund_sale_atomic`). The commands below exist
// only for fixture setup (`e2e_reset_and_seed`) and ground-truth reads.
// D1/D4/D6/D7 are NOT fixed here: setup-or-lock boot, native PIN mint,
// shift-mirror and Z-render gaps are bypassed in specs and catalogued in
// `e2e/DISCOVERY.md` §§11-13.

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetAndSeedReport {
    pub fixture: String,
    pub reset: ResetReport,
    pub seed: SeedReport,
}

/// Named fixture presets (all money integer DA; ids `E2E-`-prefixed).
/// Unknown names are rejected — specs must use a known fixture so runs are
/// reproducible from the fixture name alone.
#[cfg(any(debug_assertions, feature = "e2e"))]
fn fixture_payload(name: &str) -> Result<SeedPayload, String> {
    let mk = |id: &str, title: &str, price_da: i64, stock: i64| SeedProduct {
        id: id.to_string(),
        title: title.to_string(),
        price_da,
        stock,
        barcode: None,
        category: None,
        cost_da: 0,
    };
    let shift = |id: &str, opening_float: i64| SeedShift {
        id: id.to_string(),
        opening_float,
        cashier_name: "E2E Caissier".to_string(),
    };
    match name {
        "smoke" => Ok(SeedPayload {
            products: vec![
                mk("E2E-SMOKE-A", "E2E Savon", 1000, 50),
                mk("E2E-SMOKE-B", "E2E Huile", 2500, 30),
            ],
            open_shift: Some(shift("E2E-SHIFT-SMOKE", 10000)),
            ..Default::default()
        }),
        "money" => Ok(SeedPayload {
            products: vec![
                mk("E2E-MNY-01", "E2E The", 100, 200),
                mk("E2E-MNY-02", "E2E Cafe", 1999, 200),
                mk("E2E-MNY-03", "E2E Sucre 1DA", 1, 500),
                mk("E2E-MNY-04", "E2E Gros", 123456, 20),
            ],
            open_shift: Some(shift("E2E-SHIFT-MONEY", 50000)),
            ..Default::default()
        }),
        "stress" => Ok(SeedPayload {
            products: vec![
                mk("E2E-STR-A", "E2E Stress A", 500, 10000),
                mk("E2E-STR-B", "E2E Stress B", 1500, 10000),
                mk("E2E-STR-C", "E2E Stress C", 3000, 10000),
            ],
            open_shift: Some(shift("E2E-SHIFT-STRESS", 100000)),
            ..Default::default()
        }),
        "fault" => Ok(SeedPayload {
            products: vec![mk("E2E-FLT-A", "E2E Fault A", 1000, 100)],
            open_shift: Some(shift("E2E-SHIFT-FAULT", 20000)),
            ..Default::default()
        }),
        _ => Err(format!(
            "unknown fixture '{name}' (valid: smoke, money, stress, fault)"
        )),
    }
}

/// One-call setup: wipe the isolated container, then load a named fixture.
/// Every money/stress/fault spec starts from this — tests never depend on
/// each other and runs reproduce from the fixture name alone.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_reset_and_seed(
    app: tauri::AppHandle,
    fixture: String,
) -> Result<ResetAndSeedReport, String> {
    let reset = e2e_reset_db(app.clone())?;
    let payload = fixture_payload(&fixture)?;
    let seed = e2e_seed_state(app, payload)?;
    Ok(ResetAndSeedReport {
        fixture,
        reset,
        seed,
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSnapshot {
    pub db_path: String,
    pub sales_count: i64,
    pub sales_total_da: f64,
    pub refunds_count: i64,
    pub refunds_total_da: f64,
    pub receipt_numbers: Vec<String>,
    /// Drawer expectation per the app rule:
    /// `opening_float + cash_sales − cash_refunds + deposits − expenses`.
    pub cash_drawer_expected_da: f64,
    pub audit_count: i64,
    /// Structural linkage walk (see `audit_chain_ok` docs): specs assert
    /// `audit_links_verified == audit_total_links` directly.
    pub audit_links_verified: usize,
    pub audit_total_links: u64,
    /// The app's OWN verifier (`audit_verify`); false carries `audit_detail`.
    /// Mapping (shared-keystore container, see below): Intact → true;
    /// Unsealed with full linkage → true (expected fresh state); Broken
    /// with full linkage whose reason is ONLY head-vs-chain divergence
    /// ("truncation suspected") → true WITH the reason preserved — the
    /// keystore head is process-global while data dirs are per-identifier,
    /// so a production-sealed head can never anchor a container chain.
    /// Any linkage mismatch or partial walk → false. Specs additionally
    /// assert `audit_links_verified == audit_total_links` and monotonic
    /// `audit_count` directly, so a real in-container tamper still reddens.
    pub audit_chain_ok: bool,
    pub audit_detail: String,
    pub integrity_check: String,
}

/// `SUM(x)` over a table that may not exist on upgraded files returns 0.0;
/// any other error fails closed.
#[cfg(any(debug_assertions, feature = "e2e"))]
fn sum_or_zero(conn: &Connection, sql: &str) -> Result<f64, String> {
    match conn.query_row(sql, [], |r| r.get::<_, Option<f64>>(0)) {
        Ok(v) => Ok(v.unwrap_or(0.0)),
        Err(e) => {
            let s = e.to_string();
            if s.contains("no such table") || s.contains("no such column") {
                Ok(0.0)
            } else {
                Err(s)
            }
        }
    }
}

/// Integer minor units live in the TS oracle — this snapshot reports stored
/// REAL dinars as-is; specs convert with their own math, never app math.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_ledger_snapshot(app: tauri::AppHandle) -> Result<LedgerSnapshot, String> {
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    // Drawer-correct sale scope (Gate 4 re-probe): a refunded original is
    // still a sale that put cash in the drawer (its refund is tracked
    // separately via cash_refunds). Filtering `status = 'COMPLETED'` dropped
    // refunded originals and understated the drawer by exactly their value
    // (observed -3000 on a 1006-sale DB). VOIDED rows stay excluded, matching
    // the modal's `status !== 'VOIDED'` rule.
    let sales_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE COALESCE(status, 'COMPLETED') IN ('COMPLETED', 'REFUNDED') \
             AND COALESCE(is_refund, 0) = 0",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let sales_total_da: f64 = sum_or_zero(
        &conn,
        "SELECT SUM(total) FROM transactions WHERE COALESCE(status, 'COMPLETED') IN ('COMPLETED', 'REFUNDED') \
         AND COALESCE(is_refund, 0) = 0",
    )?;
    let refunds_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE status = 'COMPLETED' \
             AND COALESCE(is_refund, 0) = 1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let refunds_total_da: f64 = sum_or_zero(
        &conn,
        "SELECT SUM(total) FROM transactions WHERE status = 'COMPLETED' \
         AND COALESCE(is_refund, 0) = 1",
    )?;
    let receipt_numbers: Vec<String> = conn
        .prepare("SELECT receipt_number FROM transactions ORDER BY rowid")
        .and_then(|mut s| {
            s.query_map([], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| e.to_string())?;
    let opening_float_da: f64 = conn
        .query_row(
            "SELECT COALESCE(opening_float, 0) FROM cash_sessions \
             WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let cash_sales_da: f64 = sum_or_zero(
        &conn,
        "SELECT SUM(total) FROM transactions WHERE COALESCE(status, 'COMPLETED') IN ('COMPLETED', 'REFUNDED') \
         AND COALESCE(is_refund, 0) = 0 AND payment_method = 'Espèces'",
    )?;
    let cash_refunds_da: f64 = sum_or_zero(
        &conn,
        "SELECT SUM(total) FROM transactions WHERE status = 'COMPLETED' \
         AND COALESCE(is_refund, 0) = 1",
    )?;
    let deposits_da: f64 = sum_or_zero(
        &conn,
        "SELECT SUM(amount) FROM cash_movements WHERE type = 'MANUAL_DEPOSIT'",
    )?;
    let expenses_da: f64 = sum_or_zero(
        &conn,
        "SELECT SUM(amount) FROM cash_movements WHERE type = 'EXPENSE'",
    )?;
    let audit_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM audit_chain", [], |r| r.get(0))
        .unwrap_or(0);
    let (audit_chain_ok, audit_detail, audit_links_verified, audit_total_links) =
        match crate::trust_core::audit_append::audit_verify(app) {
            Ok(st) => {
                // See the field docs: head-anchored verdicts are N/A under a
                // shared keystore; linkage-full is the in-container signal.
                let full = st.links_verified as u64 == st.total_links;
                let ok = match &st.state {
                    crate::trust_core::audit_append::ChainState::Intact => true,
                    crate::trust_core::audit_append::ChainState::Unsealed => full,
                    crate::trust_core::audit_append::ChainState::Broken(reason) => {
                        full && reason.starts_with("truncation suspected")
                    }
                };
                (
                    ok,
                    format!(
                        "{:?} links_verified={} total_links={} head_seq={:?}",
                        st.state, st.links_verified, st.total_links, st.head_seq
                    ),
                    st.links_verified,
                    st.total_links,
                )
            }
            Err(e) => (false, format!("audit_verify failed: {e:?}"), 0, 0),
        };
    Ok(LedgerSnapshot {
        db_path: path.to_string_lossy().into_owned(),
        sales_count,
        sales_total_da,
        refunds_count,
        refunds_total_da,
        receipt_numbers,
        cash_drawer_expected_da: opening_float_da + cash_sales_da - cash_refunds_da
            + deposits_da
            - expenses_da,
        audit_count,
        audit_links_verified,
        audit_total_links,
        audit_chain_ok,
        audit_detail,
        integrity_check: integrity,
    })
}

/// The ledger auditor. Independent SQL reconciliation over the isolated DB;
/// empty = every global invariant holds. Called by `afterEach` in every
/// money/stress/fault spec (`e2e/lib/ledger.ts: assertLedgerClean`).
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_run_invariants(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let path = resolve_db_path(&app)?;
    let conn = open_db(&path)?;
    let mut violations: Vec<String> = Vec::new();
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if integrity != "ok" {
        violations.push(format!("integrity_check: {integrity}"));
    }
    let fk: Vec<String> = conn
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut s| {
            s.query_map([], |r| {
                Ok(format!(
                    "fkviolation table={} rowid={} fktable={} fkrow={}",
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?
                ))
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| e.to_string())?;
    violations.extend(fk.into_iter().take(5));
    let dups: Vec<String> = conn
        .prepare(
            "SELECT receipt_number, COUNT(*) FROM transactions \
             GROUP BY receipt_number HAVING COUNT(*) > 1 LIMIT 5",
        )
        .and_then(|mut s| {
            s.query_map([], |r| {
                Ok(format!(
                    "duplicate receipt_number {} x{}",
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?
                ))
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| e.to_string())?;
    violations.extend(dups);
    let neg_sales: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE total < 0 \
             AND COALESCE(is_refund, 0) = 0",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if neg_sales > 0 {
        violations.push(format!("negative non-refund sale totals: {neg_sales}"));
    }
    let orphans: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM transaction_items WHERE transaction_id NOT IN \
             (SELECT id FROM transactions)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if orphans > 0 {
        violations.push(format!("orphan transaction_items: {orphans}"));
    }
    let neg_stock: i64 = conn
        .query_row("SELECT COUNT(*) FROM products WHERE stock < 0", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    if neg_stock > 0 {
        violations.push(format!("negative product stock rows: {neg_stock}"));
    }
    match conn.query_row(
        "SELECT COUNT(*) FROM cash_movements WHERE session_id NOT IN \
         (SELECT id FROM cash_sessions)",
        [],
        |r| r.get::<_, i64>(0),
    ) {
        Ok(0) | Err(_) => {}
        Ok(n) => violations.push(format!("orphan cash_movements: {n}")),
    }
    let _ = path;
    Ok(violations)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintedOut {
    /// Always false until the Phase 7.2 byte-capture seam lands: there is
    /// currently no in-memory capture of printer/drawer output, and this
    /// command will not pretend otherwise.
    pub captured: bool,
    pub receipt_text: String,
    pub drawer_pulses: u32,
    pub note: String,
}

/// Printer/drawer capture placeholder (Phase 7.2). Returns
/// `captured:false` — specs must treat this as "not yet verifiable", never
/// as an empty receipt.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_get_printed() -> Result<PrintedOut, String> {
    Ok(PrintedOut {
        captured: false,
        receipt_text: String::new(),
        drawer_pulses: 0,
        note: "no byte-capture seam yet; Phase 7.2 routes printer/drawer output here".into(),
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    /// Stamped at compile time by `scripts/build-e2e.mjs` (`E2E_GIT_SHA`).
    /// `wdio.conf.ts` compares this to `git rev-parse HEAD` and aborts on
    /// mismatch, on the wrong identifier, or on a non-mock gateway.
    pub git_sha: String,
    pub pkg_version: String,
    pub profile: String,
    pub features: String,
    pub identifier_expected: String,
    pub data_dir: String,
    pub db_path: String,
    /// Under `--features e2e` the cloud-credential commands are sealed
    /// (read → None, write/delete → denied), so the suite only ever runs
    /// against the mock/offline lane.
    pub gateway_mode: String,
    /// No injectable clock exists yet (Q-08) — wall time, tests must not
    /// depend on it.
    pub clock_mode: String,
}

/// Build provenance for the Gate 1.6 guard.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_build_info(app: tauri::AppHandle) -> Result<BuildInfo, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(BuildInfo {
        git_sha: option_env!("E2E_GIT_SHA").unwrap_or("unknown").to_string(),
        pkg_version: env!("CARGO_PKG_VERSION").to_string(),
        profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
        .to_string(),
        features: if cfg!(feature = "e2e") {
            "e2e"
        } else {
            "debug-only"
        }
        .to_string(),
        identifier_expected: "com.mobi.pos.e2e".to_string(),
        data_dir: dir.to_string_lossy().into_owned(),
        db_path: crate::e2e::live_db_path(&dir).to_string_lossy().into_owned(),
        gateway_mode: "sealed-mock".to_string(),
        clock_mode: "wall-no-seam".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The live filename is fixed by the 4.4 `load` confinement: a test-only
    /// filename is rejected by the plugin, so isolation lives in the data
    /// dir (e2e identifier), never in the name.
    #[test]
    fn e2e_db_filename_is_isolated() {
        assert_eq!(db_filename(), "mobi_pos.db");
        assert_eq!(crate::e2e::live_db_path(std::path::Path::new("D")).file_name().unwrap(), "mobi_pos.db");
    }

    #[test]
    fn probe_bundled_fts5() {
        // Diagnostic for the harness reset failure
        // ("vtable constructor failed: products_fts"): does THIS crate's
        // rusqlite build carry the FTS5 module?
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let r = conn.execute_batch(
            "CREATE VIRTUAL TABLE f USING fts5(x); INSERT INTO f VALUES('hello'); DELETE FROM f;",
        );
        assert!(r.is_ok(), "bundled rusqlite lacks FTS5: {r:?}");
    }

    // Validation helper is test-harness-only (same cfg as the seed command
    // that owns it); without the cfg this test would reference a function
    // that does not exist in release-test builds (caught by
    // `cargo test --release`).
    #[cfg(any(debug_assertions, feature = "e2e"))]
    #[test]
    fn seed_validation_rejects_negative_and_empty() {        assert!(non_empty("x", "").is_err());
        assert!(non_empty("x", "a").is_ok());
        // Fractional quantities cannot even be expressed: SeedLine.quantity
        // is i64, so `1.5` fails JSON deserialization before validation.
        let bad: Result<SeedLine, _> =
            serde_json::from_str(r#"{"productId":"p","quantity":1.5,"appliedPriceDa":100}"#);
        assert!(bad.is_err());
    }
}

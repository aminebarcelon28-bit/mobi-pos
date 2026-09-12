// MobiPOS shared library — ALL app logic lives here (required for Tauri mobile).
// main.rs stays a thin passthrough calling mobi_pos_lib::run().

pub mod printer;

use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

#[tauri::command]
fn sqlite_print_raw_escpos(printer_name: String, data: Vec<u8>) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (&printer_name, &data);
        return Err(
            "Impression non supportée sur mobile (Bluetooth/BLE à brancher). Ticket conservé."
                .into(),
        );
    }
    #[cfg(not(mobile))]
    {
        crate::printer::print_raw_bytes(&printer_name, &data)
    }
}

#[tauri::command]
fn sqlite_open_cash_drawer(printer_name: String) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = &printer_name;
        return Err("Tiroir-caisse non supporté sur mobile.".into());
    }
    #[cfg(not(mobile))]
    {
        let pulse_bytes = vec![0x1Bu8, 0x70, 0x00, 0x19, 0xFA];
        crate::printer::print_raw_bytes(&printer_name, &pulse_bytes)
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct CloudCredentials {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for CloudCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudCredentials")
            .field("url", &self.url)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

#[tauri::command]
fn get_cloud_credentials() -> Result<Option<CloudCredentials>, String> {
    let entry = keyring::Entry::new("mobi-pos-cloud-sync", "credentials")
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(secret) => {
            let creds: CloudCredentials = serde_json::from_str(&secret)
                .map_err(|e| format!("Invalid credentials format: {}", e))?;
            Ok(Some(creds))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn set_cloud_credentials(url: String, token: String) -> Result<(), String> {
    let creds = CloudCredentials { url, token };
    let json = serde_json::to_string(&creds).map_err(|e| e.to_string())?;
    let entry = keyring::Entry::new("mobi-pos-cloud-sync", "credentials")
        .map_err(|e| e.to_string())?;
    entry.set_password(&json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_cloud_credentials() -> Result<(), String> {
    let entry = keyring::Entry::new("mobi-pos-cloud-sync", "credentials")
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn create_database_backup(app_handle: tauri::AppHandle) -> Result<String, String> {
    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("mobi_pos.db");
    if !db_path.exists() {
        return Err("Fichier mobi_pos.db introuvable".into());
    }
    let backups_dir = app_dir.join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup_filename = format!("mobi_pos_backup_{}.db", timestamp);
    let backup_path = backups_dir.join(&backup_filename);
    std::fs::copy(&db_path, &backup_path).map_err(|e| e.to_string())?;

    // Also snapshot WAL and SHM companion files (rules.md R3.12 / Section 10 Blocker prevention)
    let wal_path = app_dir.join("mobi_pos.db-wal");
    if wal_path.exists() {
        let backup_wal = backups_dir.join(format!("mobi_pos_backup_{}.db-wal", timestamp));
        let _ = std::fs::copy(&wal_path, &backup_wal);
    }
    let shm_path = app_dir.join("mobi_pos.db-shm");
    if shm_path.exists() {
        let backup_shm = backups_dir.join(format!("mobi_pos_backup_{}.db-shm", timestamp));
        let _ = std::fs::copy(&shm_path, &backup_shm);
    }

    Ok(backup_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn restore_database_backup(app_handle: tauri::AppHandle, backup_path: String) -> Result<(), String> {
    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;
    let canonical_backups_dir = std::fs::canonicalize(&backups_dir)
        .map_err(|e| format!("Dossier backups inaccessible: {}", e))?;

    let path = std::path::PathBuf::from(&backup_path);
    if !path.exists() {
        return Err("Le fichier de sauvegarde spécifié n'existe pas".into());
    }
    let canonical_path = std::fs::canonicalize(&path)
        .map_err(|e| format!("Chemin invalide: {}", e))?;

    // Guard against path traversal: must strictly be within backups directory
    if !canonical_path.starts_with(&canonical_backups_dir) {
        return Err("Accès refusé: le fichier doit provenir du dossier backups autorisé".into());
    }

    let db_path = app_dir.join("mobi_pos.db");
    std::fs::copy(&canonical_path, &db_path).map_err(|e| e.to_string())?;

    // Cleanly restore or clean up companion WAL and SHM files
    let companion_wal = canonical_path.with_extension("db-wal");
    let target_wal = app_dir.join("mobi_pos.db-wal");
    if companion_wal.exists() {
        let _ = std::fs::copy(&companion_wal, &target_wal);
    } else if target_wal.exists() {
        let _ = std::fs::remove_file(&target_wal);
    }

    let companion_shm = canonical_path.with_extension("db-shm");
    let target_shm = app_dir.join("mobi_pos.db-shm");
    if companion_shm.exists() {
        let _ = std::fs::copy(&companion_shm, &target_shm);
    } else if target_shm.exists() {
        let _ = std::fs::remove_file(&target_shm);
    }

    Ok(())
}

#[tauri::command]
fn list_database_backups(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
    if !backups_dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    let entries = std::fs::read_dir(backups_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if name.starts_with("mobi_pos_backup_") && name.ends_with(".db") {
                files.push(entry.path().to_string_lossy().into_owned());
            }
        }
    }
    files.sort();
    files.reverse();
    Ok(files)
}

#[tauri::command]
fn swap_staging_database(app_handle: tauri::AppHandle, staging_file: String) -> Result<(), String> {
    // Guard against path traversal: strictly allow only alphanumeric, underscores, hyphens, and .db extension
    if staging_file.contains('/') || staging_file.contains('\\') || staging_file.contains("..") {
        return Err("Nom de fichier de staging invalide (traversée interdite)".into());
    }
    if !staging_file.ends_with(".db") {
        return Err("Le fichier de staging doit porter l'extension .db".into());
    }

    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let staging_path = app_dir.join(&staging_file);
    if !staging_path.exists() {
        return Err("Fichier de staging introuvable".into());
    }
    let db_path = app_dir.join("mobi_pos.db");
    std::fs::copy(&staging_path, &db_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&staging_path);
    Ok(())
}

/// Windows-only legacy cleanup (duplicate v1.4.5 install). Dead code on mobile.
#[cfg(desktop)]
fn cleanup_legacy_duplicate() {
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let legacy_dir = std::path::PathBuf::from(&local_app_data).join("mobi-pos");
        if legacy_dir.exists() {
            let _ = std::fs::remove_dir_all(&legacy_dir);
        }
    }
    let shortcut_names = ["mobi-pos.lnk"];
    let mut dirs_to_check: Vec<std::path::PathBuf> = Vec::new();
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        dirs_to_check.push(std::path::PathBuf::from(&profile).join("Desktop"));
    }
    if let Some(public) = std::env::var_os("PUBLIC") {
        dirs_to_check.push(std::path::PathBuf::from(&public).join("Desktop"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs_to_check.push(
            std::path::PathBuf::from(&appdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("mobi-pos"),
        );
    }
    if let Some(pd) = std::env::var_os("PROGRAMDATA") {
        dirs_to_check.push(
            std::path::PathBuf::from(&pd)
                .join("Microsoft")
                .join("Windows")
                .join("Programs")
                .join("mobi-pos"),
        );
    }
    for dir in &dirs_to_check {
        if !dir.exists() {
            continue;
        }
        if dir.file_name().map(|n| n == "mobi-pos").unwrap_or(false) && dir.is_dir() {
            let _ = std::fs::remove_dir_all(dir);
            continue;
        }
        for name in &shortcut_names {
            let lnk = dir.join(name);
            if lnk.exists() {
                let _ = std::fs::remove_file(&lnk);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let _ = Command::new("reg")
            .args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\mobi-pos",
                "/f",
            ])
            .output();
    }
}

fn base_schema_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "mobi-pos base schema (ported from rusqlite init_schema)",
            sql: r#"
            CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY, sku TEXT NOT NULL, barcode TEXT NOT NULL, title TEXT NOT NULL,
                brand TEXT NOT NULL, compatible_model TEXT, category TEXT NOT NULL,
                price REAL NOT NULL, wholesale_price REAL DEFAULT 0, cost_price REAL DEFAULT 0,
                stock INTEGER NOT NULL DEFAULT 0, image_url TEXT, is_serialized INTEGER DEFAULT 0,
                imei_number TEXT, vendor_name TEXT, lead_time_days INTEGER DEFAULT 0,
                daily_sales_velocity REAL DEFAULT 0, reorder_point INTEGER DEFAULT 0,
                json_payload TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
            CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
            CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
            CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
            CREATE INDEX IF NOT EXISTS idx_products_imei ON products(imei_number);
            CREATE TABLE IF NOT EXISTS customers (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
                registered_device TEXT, loyalty_points INTEGER DEFAULT 0, store_credit REAL DEFAULT 0,
                pricing_tier TEXT DEFAULT 'Retail', loyalty_tier TEXT DEFAULT 'Bronze',
                total_spent REAL DEFAULT 0, loyalty_card_code TEXT, barcode TEXT,
                json_payload TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
            CREATE INDEX IF NOT EXISTS idx_customers_barcode ON customers(barcode);
            CREATE INDEX IF NOT EXISTS idx_customers_loyalty_card ON customers(loyalty_card_code);
            CREATE TABLE IF NOT EXISTS loyalty_ledger (
                id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, timestamp TEXT NOT NULL,
                entry_type TEXT NOT NULL, points INTEGER NOT NULL, balance_after INTEGER NOT NULL,
                description TEXT NOT NULL, reference_id TEXT,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_loyalty_ledger_cust ON loyalty_ledger(customer_id);
            CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY, receipt_number TEXT NOT NULL, customer_id TEXT,
                subtotal REAL NOT NULL, tax REAL DEFAULT 0, discount_total REAL DEFAULT 0,
                total REAL NOT NULL, cost_total REAL DEFAULT 0, profit REAL DEFAULT 0,
                profit_margin REAL DEFAULT 0, pricing_tier TEXT DEFAULT 'Retail',
                payment_method TEXT DEFAULT 'Espèces', cash_tendered REAL DEFAULT 0,
                change_due REAL DEFAULT 0, status TEXT NOT NULL DEFAULT 'COMPLETED',
                created_at TEXT NOT NULL, json_payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_transactions_receipt ON transactions(receipt_number);
            CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
            CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
            CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);
            CREATE TABLE IF NOT EXISTS transaction_items (
                id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, product_id TEXT NOT NULL,
                quantity INTEGER NOT NULL, applied_price REAL NOT NULL, discount REAL DEFAULT 0,
                imei_number TEXT, cost_price REAL DEFAULT 0, json_payload TEXT NOT NULL,
                FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_txn_items_txn ON transaction_items(transaction_id);
            CREATE INDEX IF NOT EXISTS idx_txn_items_prod ON transaction_items(product_id);
            CREATE TABLE IF NOT EXISTS repair_orders (
                id TEXT PRIMARY KEY, ticket_number TEXT NOT NULL, customer_name TEXT NOT NULL,
                customer_phone TEXT NOT NULL, device_model TEXT NOT NULL, imei TEXT,
                status TEXT NOT NULL, labor_cost REAL DEFAULT 0, parts_cost REAL DEFAULT 0,
                total_cost REAL DEFAULT 0, deposit_amount REAL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT, json_payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_repair_ticket ON repair_orders(ticket_number);
            CREATE INDEX IF NOT EXISTS idx_repair_imei ON repair_orders(imei);
            CREATE INDEX IF NOT EXISTS idx_repair_phone ON repair_orders(customer_phone);
            CREATE TABLE IF NOT EXISTS purchase_orders (
                id TEXT PRIMARY KEY, po_number TEXT NOT NULL, vendor_name TEXT NOT NULL,
                total_amount REAL NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
                json_payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_po_number ON purchase_orders(po_number);
            CREATE TABLE IF NOT EXISTS trade_ins (
                id TEXT PRIMARY KEY, device_model TEXT NOT NULL, imei TEXT NOT NULL,
                brand TEXT NOT NULL, condition_grade TEXT NOT NULL, buyback_value REAL NOT NULL,
                resale_margin_percent REAL DEFAULT 0, resale_price REAL NOT NULL,
                customer_name TEXT NOT NULL, credit_to_wallet INTEGER DEFAULT 0,
                created_at TEXT NOT NULL, json_payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_trade_ins_imei ON trade_ins(imei);
            CREATE TABLE IF NOT EXISTS imei_records (
                imei TEXT PRIMARY KEY, product_id TEXT NOT NULL, purchase_order_id TEXT,
                sale_transaction_id TEXT, warranty_expires_at TEXT,
                received_at TEXT NOT NULL, sold_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_imei_prod ON imei_records(product_id);
            CREATE TABLE IF NOT EXISTS security_audit_logs (
                id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, user TEXT NOT NULL,
                action TEXT NOT NULL, details TEXT NOT NULL, requires_pin INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON security_audit_logs(timestamp);
            CREATE TABLE IF NOT EXISTS cash_drops (
                id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, amount REAL NOT NULL,
                reason TEXT NOT NULL, user TEXT NOT NULL, is_payout INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_cash_timestamp ON cash_drops(timestamp);
            CREATE TABLE IF NOT EXISTS product_bundles (
                id TEXT PRIMARY KEY, bundle_title TEXT NOT NULL, barcode TEXT NOT NULL,
                bundle_price REAL NOT NULL, child_skus_json TEXT NOT NULL, json_payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_bundles_barcode ON product_bundles(barcode);
            CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cash_sessions (
                id TEXT PRIMARY KEY, opened_at TEXT NOT NULL, closed_at TEXT,
                opening_float INTEGER NOT NULL, expected_cash INTEGER, actual_cash INTEGER,
                status TEXT NOT NULL DEFAULT 'OPEN', cashier_name TEXT,
                opening_note TEXT, closing_note TEXT, discrepancy INTEGER,
                json_payload TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_status ON cash_sessions(status);
            CREATE INDEX IF NOT EXISTS idx_sessions_opened_at ON cash_sessions(opened_at);
            CREATE TABLE IF NOT EXISTS cash_movements (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
                amount INTEGER NOT NULL, reason TEXT NOT NULL, cashier_name TEXT,
                created_at TEXT NOT NULL, json_payload TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES cash_sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_movements_session ON cash_movements(session_id);
            CREATE INDEX IF NOT EXISTS idx_movements_type ON cash_movements(type);
            CREATE VIEW IF NOT EXISTS v_inventory_valuation AS
            SELECT COUNT(*) as total_skus, COALESCE(SUM(stock),0) as total_units,
                COALESCE(CAST(ROUND(SUM(stock * cost_price)) AS INTEGER),0) as total_cost_value,
                COALESCE(CAST(ROUND(SUM(stock * price)) AS INTEGER),0) as total_retail_value,
                COALESCE(CAST(ROUND(SUM(stock * (price - cost_price))) AS INTEGER),0) as potential_profit_margin
            FROM products WHERE stock > 0;
            CREATE TABLE IF NOT EXISTS customer_debts (
                id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT NOT NULL,
                type TEXT NOT NULL, amount REAL NOT NULL, balance_after REAL NOT NULL,
                receipt_number TEXT, payment_method TEXT, notes TEXT, recorded_by TEXT,
                created_at TEXT NOT NULL, json_payload TEXT NOT NULL,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_customer_debts_cust ON customer_debts(customer_id);
            CREATE INDEX IF NOT EXISTS idx_customer_debts_created ON customer_debts(created_at);
            CREATE TABLE IF NOT EXISTS store_expenses (
                id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL,
                amount REAL NOT NULL, payment_method TEXT NOT NULL, paid_to TEXT,
                notes TEXT, recorded_by TEXT NOT NULL, created_at TEXT NOT NULL,
                json_payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_store_expenses_category ON store_expenses(category);
            CREATE INDEX IF NOT EXISTS idx_store_expenses_created ON store_expenses(created_at);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "sync columns: device_id, idempotency_key, sync_status, timestamps, deleted",
            sql: r#"
            ALTER TABLE products ADD COLUMN device_id TEXT DEFAULT 'legacy';
            ALTER TABLE products ADD COLUMN idempotency_key TEXT DEFAULT '';
            ALTER TABLE products ADD COLUMN sync_status TEXT DEFAULT 'pending';
            ALTER TABLE products ADD COLUMN created_at TEXT DEFAULT '';
            ALTER TABLE products ADD COLUMN deleted INTEGER DEFAULT 0;
            ALTER TABLE customers ADD COLUMN device_id TEXT DEFAULT 'legacy';
            ALTER TABLE customers ADD COLUMN idempotency_key TEXT DEFAULT '';
            ALTER TABLE customers ADD COLUMN sync_status TEXT DEFAULT 'pending';
            ALTER TABLE customers ADD COLUMN created_at TEXT DEFAULT '';
            ALTER TABLE customers ADD COLUMN deleted INTEGER DEFAULT 0;
            ALTER TABLE transactions ADD COLUMN device_id TEXT DEFAULT 'legacy';
            ALTER TABLE transactions ADD COLUMN idempotency_key TEXT DEFAULT '';
            ALTER TABLE transactions ADD COLUMN sync_status TEXT DEFAULT 'pending';
            ALTER TABLE transactions ADD COLUMN updated_at TEXT DEFAULT '';
            ALTER TABLE transactions ADD COLUMN deleted INTEGER DEFAULT 0;
            ALTER TABLE transaction_items ADD COLUMN device_id TEXT DEFAULT 'legacy';
            ALTER TABLE transaction_items ADD COLUMN idempotency_key TEXT DEFAULT '';
            ALTER TABLE transaction_items ADD COLUMN sync_status TEXT DEFAULT 'pending';
            ALTER TABLE transaction_items ADD COLUMN created_at TEXT DEFAULT '';
            ALTER TABLE transaction_items ADD COLUMN updated_at TEXT DEFAULT '';
            ALTER TABLE transaction_items ADD COLUMN deleted INTEGER DEFAULT 0;
            UPDATE products SET idempotency_key = 'legacy-' || id WHERE idempotency_key = '';
            UPDATE products SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE created_at = '';
            UPDATE customers SET idempotency_key = 'legacy-' || id WHERE idempotency_key = '';
            UPDATE customers SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE created_at = '';
            UPDATE transactions SET idempotency_key = 'legacy-' || id WHERE idempotency_key = '';
            UPDATE transactions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE updated_at = '';
            UPDATE transaction_items SET idempotency_key = 'legacy-' || id WHERE idempotency_key = '';
            UPDATE transaction_items SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE created_at = '';
            UPDATE transaction_items SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE updated_at = '';
            CREATE UNIQUE INDEX IF NOT EXISTS uq_products_idem ON products(idempotency_key);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_idem ON customers(idempotency_key);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_idem ON transactions(idempotency_key);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_txn_items_idem ON transaction_items(idempotency_key);
            CREATE INDEX IF NOT EXISTS idx_products_updated ON products(updated_at, id);
            CREATE INDEX IF NOT EXISTS idx_products_sync ON products(sync_status, updated_at);
            CREATE INDEX IF NOT EXISTS idx_transactions_updated ON transactions(updated_at, id);
            CREATE INDEX IF NOT EXISTS idx_transactions_sync ON transactions(sync_status, updated_at);
            CREATE INDEX IF NOT EXISTS idx_txn_items_updated ON transaction_items(updated_at, id);
            CREATE INDEX IF NOT EXISTS idx_txn_items_sync ON transaction_items(sync_status, updated_at);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "inventory_ledger (append-only) + sync_outbox (local only) + compat views",
            sql: r#"
            CREATE TABLE IF NOT EXISTS inventory_ledger (
                id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
                delta INTEGER NOT NULL, reason TEXT NOT NULL
                    CHECK (reason IN ('SALE','VOID','REFUND','RECEIVE','ADJUST','SEED')),
                ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                sync_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (sync_status IN ('pending','inflight','synced','failed')),
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_ledger_updated ON inventory_ledger(updated_at, id);
            CREATE INDEX IF NOT EXISTS idx_ledger_product ON inventory_ledger(product_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_ledger_sync ON inventory_ledger(sync_status, updated_at);
            CREATE INDEX IF NOT EXISTS idx_ledger_ref ON inventory_ledger(ref_type, ref_id);
            CREATE TABLE IF NOT EXISTS sync_outbox (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE,
                entity_type TEXT NOT NULL CHECK (entity_type IN ('product','order','order_item','ledger','customer')),
                entity_id TEXT NOT NULL,
                operation TEXT NOT NULL CHECK (operation IN ('UPSERT','DELETE')),
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','inflight','synced','failed')),
                retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT, last_error TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_outbox_status ON sync_outbox(status, next_retry_at, rowid);
            CREATE INDEX IF NOT EXISTS idx_outbox_entity ON sync_outbox(entity_type, entity_id);
            INSERT OR IGNORE INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status)
            SELECT 'seed-' || id, id, stock, 'SEED', 'migration', 'v3', 'legacy', 'seed-' || id, 'pending'
            FROM products WHERE stock != 0;
            DROP VIEW IF EXISTS orders;
            CREATE VIEW IF NOT EXISTS orders AS SELECT * FROM transactions;
            DROP VIEW IF EXISTS order_items;
            CREATE VIEW IF NOT EXISTS order_items AS SELECT * FROM transaction_items;
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "full-sync: wide outbox entity types + stable entity_keys",
            sql: r#"
            CREATE TABLE IF NOT EXISTS sync_outbox_wide (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE,
                entity_type TEXT NOT NULL CHECK (entity_type IN ('product','order','order_item','ledger','customer','repair_order','purchase_order','trade_in','imei','audit_log','cash_drop','bundle','customer_debt','store_expense','cash_session','cash_movement','setting')),
                entity_id TEXT NOT NULL,
                operation TEXT NOT NULL CHECK (operation IN ('UPSERT','DELETE')),
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','inflight','synced','failed')),
                retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT, last_error TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            INSERT OR IGNORE INTO sync_outbox_wide (rowid, idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, next_retry_at, last_error, created_at, updated_at)
            SELECT rowid, idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, next_retry_at, last_error, created_at, updated_at FROM sync_outbox;
            DROP TABLE sync_outbox;
            ALTER TABLE sync_outbox_wide RENAME TO sync_outbox;
            CREATE INDEX IF NOT EXISTS idx_outbox_status ON sync_outbox(status, next_retry_at, rowid);
            CREATE INDEX IF NOT EXISTS idx_outbox_entity ON sync_outbox(entity_type, entity_id);
            CREATE TABLE IF NOT EXISTS entity_keys (
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                PRIMARY KEY (entity_type, entity_id)
            );
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add optimistic concurrency version column to local tables",
            sql: r#"
            ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE transactions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE transaction_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE inventory_ledger ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE customers ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            "#,
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = base_schema_migrations();

    let mut builder = tauri::Builder::default().plugin(
        tauri_plugin_sql::Builder::default()
            .add_migrations("sqlite:mobi_pos.db", migrations)
            .build(),
    );

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder = builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                cleanup_legacy_duplicate();
            }
            let _ = app.path().app_data_dir();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sqlite_print_raw_escpos,
            sqlite_open_cash_drawer,
            get_cloud_credentials,
            set_cloud_credentials,
            delete_cloud_credentials,
            create_database_backup,
            restore_database_backup,
            list_database_backups,
            swap_staging_database
        ]);

    if let Err(err) = builder.run(tauri::generate_context!()) {
        eprintln!("Error while running tauri application: {}", err);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cloud_credentials_redaction_and_serialization() {
        let creds = CloudCredentials {
            url: "libsql://test-db.turso.io".to_string(),
            token: "super-secret-token-12345".to_string(),
        };
        let debug_str = format!("{:?}", creds);
        assert!(!debug_str.contains("super-secret-token-12345"), "Token must be redacted in Debug output");
        assert!(debug_str.contains("[REDACTED]"));

        let serialized = serde_json::to_string(&creds).expect("Serialization must succeed");
        let deserialized: CloudCredentials = serde_json::from_str(&serialized).expect("Deserialization must succeed");
        assert_eq!(deserialized.url, creds.url);
        assert_eq!(deserialized.token, creds.token);
    }
}

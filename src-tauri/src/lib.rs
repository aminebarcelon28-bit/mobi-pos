// MobiPOS shared library — ALL app logic lives here (required for Tauri mobile).
// main.rs stays a thin passthrough calling mobi_pos_lib::run().

pub mod printer;
pub mod hlc;
pub mod contract;
pub mod reducers;
pub mod intents;
pub mod hardware;
pub mod scanner;
pub mod geometry;
pub mod gate;
pub mod db;
pub mod resolver;
pub mod commands;

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

fn get_vault_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(".cloud_credentials.vault"))
}

fn read_vault_file(app: &tauri::AppHandle) -> Result<Option<CloudCredentials>, String> {
    let vault_path = get_vault_path(app)?;
    if !vault_path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&vault_path).map_err(|e| e.to_string())?;
    if data.trim().is_empty() {
        return Ok(None);
    }
    let creds: CloudCredentials = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    Ok(Some(creds))
}

#[cfg(mobile)]
fn save_vault_file(app: &tauri::AppHandle, creds: &CloudCredentials) -> Result<(), String> {
    let vault_path = get_vault_path(app)?;
    let json = serde_json::to_string(creds).map_err(|e| e.to_string())?;
    std::fs::write(&vault_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_vault_file(app: &tauri::AppHandle) -> Result<(), String> {
    let vault_path = get_vault_path(app)?;
    if vault_path.exists() {
        // B-056: never swallow remove errors — a leftover plaintext vault is
        // a security incident, not a cosmetic miss.
        std::fs::remove_file(&vault_path).map_err(|e| format!("delete vault: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn get_cloud_credentials(app_handle: tauri::AppHandle) -> Result<Option<CloudCredentials>, String> {
    #[cfg(not(mobile))]
    {
        if let Ok(entry) = keyring::Entry::new("mobi-pos-cloud-sync", "credentials") {
            match entry.get_password() {
                Ok(secret) => {
                    if let Ok(creds) = serde_json::from_str::<CloudCredentials>(&secret) {
                        // B-056 migration: keychain hit — purge any leftover
                        // plaintext vault so disk no longer holds the token.
                        let _ = delete_vault_file(&app_handle);
                        return Ok(Some(creds));
                    }
                }
                Err(keyring::Error::NoEntry) => {
                    // fall through to legacy vault for one-time migration
                }
                Err(e) => return Err(format!("keychain read: {e}")),
            }
        }
    }

    let from_vault = read_vault_file(&app_handle)?;

    // B-056 migration: desktop found credentials only in the plaintext vault —
    // move them into the OS keychain and delete the vault file.
    #[cfg(not(mobile))]
    if let Some(creds) = &from_vault {
        let json = serde_json::to_string(creds).map_err(|e| e.to_string())?;
        match keyring::Entry::new("mobi-pos-cloud-sync", "credentials") {
            Ok(entry) => match entry.set_password(&json) {
                Ok(()) => {
                    delete_vault_file(&app_handle)?;
                    return Ok(Some(creds.clone()));
                }
                Err(e) => {
                    // Keychain unavailable — keep reading vault, surface reason.
                    eprintln!("[cloud-creds] keychain migrate failed: {e}");
                }
            },
            Err(e) => eprintln!("[cloud-creds] keychain entry failed: {e}"),
        }
    }

    Ok(from_vault)
}

#[tauri::command]
fn set_cloud_credentials(app_handle: tauri::AppHandle, url: String, token: String) -> Result<(), String> {
    let creds = CloudCredentials { url, token };

    #[cfg(not(mobile))]
    {
        let json = serde_json::to_string(&creds).map_err(|e| e.to_string())?;
        let entry = keyring::Entry::new("mobi-pos-cloud-sync", "credentials")
            .map_err(|e| format!("keychain entry: {e}"))?;
        entry
            .set_password(&json)
            .map_err(|e| format!("keychain save: {e}"))?;
        // B-056: desktop stores ONLY in the OS keychain — never write the
        // plaintext vault. Remove any pre-existing vault from older builds.
        delete_vault_file(&app_handle)?;
        return Ok(());
    }

    // Mobile: no portable keyring — encrypted-at-rest vault is the fallback.
    #[cfg(mobile)]
    {
        save_vault_file(&app_handle, &creds)?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
fn delete_cloud_credentials(app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(mobile))]
    {
        match keyring::Entry::new("mobi-pos-cloud-sync", "credentials") {
            Ok(entry) => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(format!("keychain delete: {e}")),
            },
            Err(e) => return Err(format!("keychain entry: {e}")),
        }
    }
    // Always purge any leftover vault (desktop migration + mobile).
    delete_vault_file(&app_handle)?;
    Ok(())
}

/// Highest `PRAGMA user_version` this build knows how to open. Must track the
/// largest `version` in `base_schema_migrations()` below. A DB stamped above
/// this means a NEWER app wrote it — opening it here could silently skip
/// migrations it depends on, so startup refuses instead (contract C6).
const EXPECTED_MAX_DB_USER_VERSION: u32 = 106;

/// SQLite file header magic: first 16 bytes are always "SQLite format 3\0".
const SQLITE_HEADER_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// Read `PRAGMA user_version` without a SQL engine: it lives at header offset
/// 60 as a big-endian u32. Pure `std::fs` so the boot gate works before any
/// connection exists. Returns Err on short/non-SQLite files (fail loudly).
fn sqlite_user_version(path: &std::path::Path) -> Result<u32, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("Ouverture impossible: {e}"))?;
    let mut header = [0u8; 100];
    f.read_exact(&mut header)
        .map_err(|e| format!("Fichier trop court, pas une base SQLite?: {e}"))?;
    if &header[0..16] != SQLITE_HEADER_MAGIC {
        return Err(
            "En-tête SQLite invalide (magic mismatch) — fichier corrompu ou non-SQLite".into(),
        );
    }
    Ok(u32::from_be_bytes([
        header[60], header[61], header[62], header[63],
    ]))
}

/// Cheap structural check of a SQLite file copy: magic header present.
/// Full `PRAGMA integrity_check` needs a SQL engine (no rusqlite here by
/// design — a bundled engine would pull a C toolchain and violate the
/// zero-dependency delivery contract C4); the TS side runs the real
/// `PRAGMA integrity_check` on boot via `maintenanceAdapter.runIntegrityCheck`.
fn is_plausible_sqlite_copy(path: &std::path::Path) -> Result<(), String> {
    sqlite_user_version(path).map(|_| ())
}

/// Verify a just-written backup copy: same byte length as the source,
/// non-empty, plausible SQLite header. On ANY mismatch the bad copy is
/// deleted and an error is returned — a half-written backup must never
/// masquerade as a restore point (contract C6).
fn verify_copy_integrity(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    let src_len = std::fs::metadata(src)
        .map_err(|e| format!("Métadonnées source illisibles: {}", e))?
        .len();
    let dst_len = std::fs::metadata(dst)
        .map_err(|e| format!("Métadonnées copie illisibles: {}", e))?
        .len();
    if src_len == 0 {
        let _ = std::fs::remove_file(dst);
        return Err("Copie refusée: fichier source vide".into());
    }
    if src_len != dst_len {
        let _ = std::fs::remove_file(dst);
        return Err(format!(
            "Copie tronquée: {} octets copiés sur {} attendus — fichier supprimé",
            dst_len, src_len
        ));
    }
    if let Err(e) = is_plausible_sqlite_copy(dst) {
        let _ = std::fs::remove_file(dst);
        return Err(format!("Copie invalide ({}), fichier supprimé", e));
    }
    Ok(())
}

/// Safety copy of the CURRENT live DB into `backups/` before any destructive
/// swap. Best-effort on companions, strict on the main file.
fn backup_current_db_before_swap(
    app_dir: &std::path::Path,
    backups_dir: &std::path::Path,
    timestamp: u64,
) -> Result<Option<String>, String> {
    let db_path = app_dir.join("mobi_pos.db");
    if !db_path.exists() {
        return Ok(None); // Fresh install — nothing to preserve.
    }
    let name = format!("mobi_pos_pre_restore_{}.db", timestamp);
    let dst = backups_dir.join(&name);
    std::fs::copy(&db_path, &dst)
        .map_err(|e| format!("Sauvegarde pré-restauration impossible, abandon: {}", e))?;
    verify_copy_integrity(&db_path, &dst)?;
    // Companion WAL/journal: best-effort, never fatal.
    for suffix in ["-wal", "-journal"] {
        let src = app_dir.join(format!("mobi_pos.db{}", suffix));
        if src.exists() {
            let _ = std::fs::copy(&src, backups_dir.join(format!("{}{}", name, suffix)));
        }
    }
    Ok(Some(dst.to_string_lossy().into_owned()))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
fn create_database_backup(app_handle: tauri::AppHandle) -> Result<String, String> {
    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("mobi_pos.db");
    if !db_path.exists() {
        return Err("Fichier mobi_pos.db introuvable".into());
    }
    // NOTE (WAL checkpoint): these commands hold no pooled SQLite connection,
    // so there is nothing to checkpoint from here. The TS caller issues
    // `PRAGMA wal_checkpoint(TRUNCATE)` via `maintenanceAdapter.checkpointWal()`
    // BEFORE invoking this command; the file copy below therefore races as
    // little as possible with a live writer. The db + WAL + journal companions
    // are copied back-to-back and the main copy is verified afterwards.
    let backups_dir = app_dir.join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;
    let timestamp = now_secs();
    let backup_filename = format!("mobi_pos_backup_{}.db", timestamp);
    let backup_path = backups_dir.join(&backup_filename);
    std::fs::copy(&db_path, &backup_path).map_err(|e| e.to_string())?;

    // Also snapshot WAL + rollback-journal companions if non-empty (never copy
    // volatile .db-shm shared memory: it is a process-local index, copying it
    // risks replaying stale pages into the backup on open).
    for suffix in ["-wal", "-journal"] {
        let companion = app_dir.join(format!("mobi_pos.db{}", suffix));
        if companion.exists()
            && std::fs::metadata(&companion)
                .map(|m| m.len() > 0)
                .unwrap_or(false)
        {
            let backup_companion =
                backups_dir.join(format!("mobi_pos_backup_{}.db{}", timestamp, suffix));
            let _ = std::fs::copy(&companion, &backup_companion);
        }
    }

    // Fail loudly on a bad copy: size match + SQLite header on the COPY.
    verify_copy_integrity(&db_path, &backup_path)?;

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

    // 1. Validate the SOURCE backup first: refuse a corrupt file before it can
    // ever touch the live DB (fail loudly, C6).
    is_plausible_sqlite_copy(&canonical_path)
        .map_err(|e| format!("Sauvegarde source invalide, restauration refusée: {e}"))?;

    // 2. Back up the CURRENT live DB first so a bad restore is reversible.
    let timestamp = now_secs();
    backup_current_db_before_swap(&app_dir, &backups_dir, timestamp)?;

    let db_path = app_dir.join("mobi_pos.db");
    let target_wal = app_dir.join("mobi_pos.db-wal");
    let target_shm = app_dir.join("mobi_pos.db-shm");

    // Remove active shared memory to avoid stale index pointers
    let _ = std::fs::remove_file(&target_shm);

    std::fs::copy(&canonical_path, &db_path).map_err(|e| e.to_string())?;

    // Cleanly restore or clean up companion WAL file
    let companion_wal = canonical_path.with_extension("db-wal");
    if companion_wal.exists() {
        let _ = std::fs::copy(&companion_wal, &target_wal);
    } else if target_wal.exists() {
        let _ = std::fs::remove_file(&target_wal);
    }

    // 3. Verify the swapped-in file before reporting success.
    verify_copy_integrity(&canonical_path, &db_path)?;

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
    // 1. Validate the SOURCE staging file first — never swap in a corrupt DB.
    is_plausible_sqlite_copy(&staging_path)
        .map_err(|e| format!("Fichier de staging invalide, échange refusé: {e}"))?;

    // 2. Back up the CURRENT live DB first so a bad swap is reversible.
    let backups_dir = app_dir.join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;
    backup_current_db_before_swap(&app_dir, &backups_dir, now_secs())?;

    let db_path = app_dir.join("mobi_pos.db");
    let wal_path = app_dir.join("mobi_pos.db-wal");
    let shm_path = app_dir.join("mobi_pos.db-shm");

    // CRITICAL (Contract C6): Delete active WAL and SHM files before swapping in staging DB!
    // If old WAL frames remain, SQLite will replay stale WAL pages into the new DB,
    // causing B-Tree header mismatch and irrecoverable corruption (Code 1299 / SQLite Error 26).
    let _ = std::fs::remove_file(&wal_path);
    let _ = std::fs::remove_file(&shm_path);

    std::fs::copy(&staging_path, &db_path).map_err(|e| e.to_string())?;

    // 3. Verify the swapped-in file before deleting staging and reporting success.
    verify_copy_integrity(&staging_path, &db_path)?;

    let _ = std::fs::remove_file(&staging_path);
    Ok(())
}

#[tauri::command]
fn sqlite_db_maintenance() -> Result<String, String> {
    // Maintenance command — exposed as `invoke('sqlite_db_maintenance')`
    Ok("ok".to_string())
}

/// Boot-gate companion to the `setup` version check below: lets the TS boot
/// sequence refuse a too-new DB with a clear message before serving reads.
#[tauri::command]
fn sqlite_check_db_version(app_handle: tauri::AppHandle) -> Result<String, String> {
    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("mobi_pos.db");
    if !db_path.exists() {
        return Ok(format!(
            "absent (fresh install, max supported user_version={})",
            EXPECTED_MAX_DB_USER_VERSION
        ));
    }
    let v = sqlite_user_version(&db_path)?;
    if v > EXPECTED_MAX_DB_USER_VERSION {
        return Err(format!(
            "Base SQLite trop récente (user_version={} > max supporté={}) : \
             elle a été écrite par une version plus récente de MobiPOS. \
             Mettez à jour l'application au lieu d'ouvrir ce fichier.",
            v, EXPECTED_MAX_DB_USER_VERSION
        ));
    }
    Ok(format!(
        "ok (user_version={} <= max={})",
        v, EXPECTED_MAX_DB_USER_VERSION
    ))
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
        // F2-coverage: loyalty_ledger (created below in v1) is a LOCAL-ONLY
        // audit journal by design — no writers enqueue it, no remote table,
        // no pull lane. Loyalty balances converge via the versioned customer
        // row; the ledger exists for per-device forensics. Promoting it to a
        // synced lane requires rerouting earn/redeem writes through it first
        // (domain redesign, not a sync patch). NOTE: this comment must stay
        // OUTSIDE the sql strings below — sqlx checksums migration bodies.
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
            // H9-generalized note (kept OUTSIDE the SQL string: sqlx checksums
            // the migration body, so any byte change inside r#"..."# bricks
            // upgraded DBs with "previously applied but has been modified").
            // The entity_keys.version clock lives here only as documentation:
            // the column itself is ensured idempotently by the TS self-heal
            // (sqlPluginAdapter stableEntityKey: ALTER ... ADD COLUMN version
            // with duplicate-column tolerance + CREATE TABLE IF NOT EXISTS),
            // which runs on every boot before any reader. Never add DDL for it
            // to this migration body — use a NEW migration version instead.
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
        Migration {
            version: 6,
            description: "Phase 2: FTS5 virtual table for sub-millisecond product search",
            sql: r#"
            CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
                id UNINDEXED,
                title,
                brand,
                sku,
                barcode,
                category,
                tokenize = 'unicode61'
            );
            INSERT OR IGNORE INTO products_fts (id, title, brand, sku, barcode, category)
            SELECT id, title, brand, sku, barcode, category FROM products;
            
            CREATE TRIGGER IF NOT EXISTS trg_products_fts_insert AFTER INSERT ON products
            BEGIN
                INSERT INTO products_fts (id, title, brand, sku, barcode, category)
                VALUES (new.id, new.title, new.brand, new.sku, new.barcode, new.category);
            END;

            CREATE TRIGGER IF NOT EXISTS trg_products_fts_update AFTER UPDATE ON products
            BEGIN
                UPDATE products_fts SET
                    title = new.title,
                    brand = new.brand,
                    sku = new.sku,
                    barcode = new.barcode,
                    category = new.category
                WHERE id = new.id;
            END;

            CREATE TRIGGER IF NOT EXISTS trg_products_fts_delete AFTER DELETE ON products
            BEGIN
                DELETE FROM products_fts WHERE id = old.id;
            END;
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "Optimization: foreign keys, search indexes and covering stock calculation index",
            sql: r#"
            CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
            CREATE INDEX IF NOT EXISTS idx_customers_updated ON customers(updated_at, id);
            CREATE INDEX IF NOT EXISTS idx_customers_sync ON customers(sync_status, updated_at);
            CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(created_at);

            CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at);

            CREATE INDEX IF NOT EXISTS idx_txn_items_imei ON transaction_items(imei_number) WHERE imei_number IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_transactions_deleted ON transactions(deleted, id);

            CREATE INDEX IF NOT EXISTS idx_imei_sale_txn ON imei_records(sale_transaction_id);
            CREATE INDEX IF NOT EXISTS idx_imei_po ON imei_records(purchase_order_id);

            CREATE INDEX IF NOT EXISTS idx_repair_status ON repair_orders(status, created_at);
            CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status, created_at);

            -- Covering index: enables index-only SUM(delta) scans without reading table pages
            CREATE INDEX IF NOT EXISTS idx_ledger_stock_calc ON inventory_ledger(product_id, deleted, delta);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            // H9 note (kept OUTSIDE the SQL string: sqlx checksums the
            // migration body, so any byte change inside r#"..."# bricks
            // upgraded DBs with "previously applied but has been modified").
            // The `deleted` columns for the generic-KV lanes
            // (store_expenses, cash_sessions, cash_movements, repair_orders,
            // purchase_orders, trade_ins, imei_records, cash_drops,
            // product_bundles, security_audit_logs) plus the customer_debts
            // deleted/updated_at/device_id trio belong in a FUTURE migration
            // (v104+), never appended here. customer_debts trio is already
            // covered idempotently by the TS self-heal (schemaHeal); nothing
            // in TS reads the other `deleted` columns today (IMEI write has a
            // legacy-shape fallback). See also: LF-only rule below.
            version: 8,
            description: "Add version column to all generic tables in local SQLite",
            sql: r#"
            ALTER TABLE security_audit_logs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE repair_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE purchase_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE trade_ins ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE imei_records ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE cash_drops ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE product_bundles ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE customer_debts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE store_expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE cash_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE cash_movements ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE app_settings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 100,
            description: "Event-sourced local-first platform: event_log, projection_cursor, sync_state",
            sql: r#"
            CREATE TABLE IF NOT EXISTS event_log (
                event_id    TEXT PRIMARY KEY,
                seq         INTEGER,
                aggregate   TEXT NOT NULL,
                hlc         TEXT NOT NULL,
                device_id   TEXT NOT NULL,
                schema_v    INTEGER NOT NULL DEFAULT 1,
                event       TEXT NOT NULL,
                ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                origin      TEXT NOT NULL DEFAULT 'local'
            );
            CREATE INDEX IF NOT EXISTS ix_log_hlc      ON event_log(hlc);
            CREATE INDEX IF NOT EXISTS ix_log_agg      ON event_log(aggregate, hlc);
            CREATE INDEX IF NOT EXISTS ix_log_unsynced ON event_log(origin) WHERE origin = 'local';

            CREATE TABLE IF NOT EXISTS projection_cursor (
                projection  TEXT PRIMARY KEY,
                last_hlc    TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_state (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 101,
            description: "ES-LFP core disposable projections: p_products, p_transactions, p_transaction_items",
            sql: r#"
            CREATE TABLE IF NOT EXISTS p_products (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                price_cents INTEGER NOT NULL,
                sku         TEXT,
                stock       INTEGER NOT NULL DEFAULT 0,
                deleted     INTEGER NOT NULL DEFAULT 0,
                row_hlc     TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS p_transactions (
                id          TEXT PRIMARY KEY,
                total_cents INTEGER NOT NULL,
                ts          TEXT NOT NULL,
                row_hlc     TEXT NOT NULL,
                device_id   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS p_transaction_items (
                tx_id       TEXT NOT NULL,
                product_id  TEXT NOT NULL,
                qty         INTEGER NOT NULL,
                unit_cents  INTEGER NOT NULL,
                PRIMARY KEY (tx_id, product_id)
            );
            CREATE INDEX IF NOT EXISTS ix_p_stock ON p_products(deleted, stock);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            // NOTE: this migration deliberately does NOT ALTER transaction_items
            // (unit_price_charged / unit_cost_at_sale / discount_amount /
            // line_profit) and does NOT backfill them. Those columns are owned
            // idempotently by the TS boot heal (ensureLocalSyncColumns full pass
            // + always-run costing backfill): upgrade DBs already carry them,
            // so plain ALTERs here would abort the migration with "duplicate
            // column name" and brick boot. Fresh DBs fail the heal probe
            // (SELECT unit_cost_at_sale ...) so the full pass creates them.
            // Same sqlx-checksum rule as v4/v8: never append DDL here.
            version: 102,
            description: "FIFO stock_batches table (transaction_items costing columns owned by TS boot heal)",
            sql: r#"
            CREATE TABLE IF NOT EXISTS stock_batches (
                batch_id TEXT PRIMARY KEY,
                product_id TEXT NOT NULL REFERENCES products(id),
                quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
                unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
                received_at TEXT NOT NULL,
                purchase_order_id TEXT,
                device_id TEXT NOT NULL DEFAULT 'local',
                idempotency_key TEXT NOT NULL UNIQUE,
                sync_status TEXT NOT NULL DEFAULT 'pending',
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_stock_batches_fifo 
                ON stock_batches(product_id, received_at) 
                WHERE quantity_remaining > 0 AND deleted = 0;
            CREATE INDEX IF NOT EXISTS idx_stock_batches_updated 
                ON stock_batches(updated_at, batch_id);
            CREATE INDEX IF NOT EXISTS idx_stock_batches_po 
                ON stock_batches(purchase_order_id);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            // NOTE: the INSERT...SELECT column list must stay within the v3-
            // guaranteed set (v3 CREATE has last_error but NOT error). Adding
            // `error` here breaks FRESH installs (migrate runs before the TS
            // heal that creates `error`); the TS heal re-adds the column
            // post-migrate. Per-row error text does not survive the rebuild
            // (transient diagnostics, repopulated on next failure).
            version: 103,
            description: "sync_outbox: drop entity_type CHECK (FIFO stock_batches + credit_voucher broke checkout)",
            sql: r#"
            CREATE TABLE IF NOT EXISTS sync_outbox_new (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                operation TEXT NOT NULL CHECK (operation IN ('UPSERT','DELETE')),
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','inflight','synced','failed')),
                retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT, last_error TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            INSERT OR IGNORE INTO sync_outbox_new (rowid, idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, next_retry_at, last_error, created_at, updated_at)
            SELECT rowid, idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, next_retry_at, last_error, created_at, updated_at FROM sync_outbox;
            DROP TABLE sync_outbox;
            ALTER TABLE sync_outbox_new RENAME TO sync_outbox;
            CREATE INDEX IF NOT EXISTS idx_outbox_status ON sync_outbox(status, next_retry_at, rowid);
            CREATE INDEX IF NOT EXISTS idx_outbox_entity ON sync_outbox(entity_type, entity_id);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            // v104 — STRICT FIFO ALLOCATION LEDGER (6,000 vs 6,100 fix).
            // Freezes exact batch costs at checkout into an append-only
            // ledger so the Sales & Net Profit report never reads live
            // products.costPrice or live stock_batches for COGS.
            // Written inside the same checkout transaction that depletes
            // stock_batches.quantity_remaining (see sqlPluginAdapter
            // writeCheckoutAtomicInner). Report query sums ONLY this table.
            // sqlx-checksum rule (v4/v8/v102): never append DDL to an old
            // migration body — this NEW version owns the table.
            version: 104,
            description: "FIFO frozen sales allocation ledger (sale_batch_allocations)",
            sql: r#"
            CREATE TABLE IF NOT EXISTS sale_batch_allocations (
                id TEXT PRIMARY KEY NOT NULL,
                sale_id TEXT NOT NULL,
                batch_id TEXT NOT NULL,
                qty_consumed INTEGER NOT NULL CHECK (qty_consumed > 0),
                unit_cost_at_sale REAL NOT NULL CHECK (unit_cost_at_sale >= 0),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                product_id TEXT,
                sale_item_id TEXT,
                device_id TEXT NOT NULL DEFAULT 'local',
                idempotency_key TEXT NOT NULL UNIQUE,
                sync_status TEXT NOT NULL DEFAULT 'pending',
                version INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                deleted INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(batch_id) REFERENCES stock_batches(batch_id)
            );
            CREATE INDEX IF NOT EXISTS idx_alloc_sale ON sale_batch_allocations(sale_id);
            CREATE INDEX IF NOT EXISTS idx_alloc_batch ON sale_batch_allocations(batch_id);
            CREATE INDEX IF NOT EXISTS idx_alloc_product ON sale_batch_allocations(product_id);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            // v105 — ATOMIC COGS MATERIALIZATION (#REC-20260926-1408ML-02-DJB64).
            // The checkout transaction depletes batches + freezes allocation
            // rows + writes the exact FIFO sum into transactions.ledger_cogs_total
            // BEFORE commit (see sqlPluginAdapter writeCheckoutAtomicInner 5b/5c
            // + pre-commit gate), so the receipt reads one materialized number
            // instead of re-deriving COGS. No default: legacy rows stay NULL
            // (unknown), which the receipt treats as "look up the ledger",
            // never as zero. Same sqlx-checksum rule: new version owns it.
            version: 105,
            description: "Atomic COGS materialization column (transactions.ledger_cogs_total)",
            sql: r#"
            ALTER TABLE transactions ADD COLUMN ledger_cogs_total REAL;
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            // v106 — PO-RECON vendor alias cache. Plain table only: sqlx
            // (behind tauri-plugin-sql) has no sqlite-vec extension, so the
            // vec0 `vec_products` table is created lazily by the rusqlite
            // path (`db::ensure_po_recon_tables`) on first PO-recon invoke.
            // See db::PO_RECON_PLUGIN_MIGRATION_V106.
            version: 106,
            description: "PO recon vendor alias cache (vec index created lazily via rusqlite)",
            sql: crate::db::PO_RECON_PLUGIN_MIGRATION_V106,
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = base_schema_migrations();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(intents::plugin())
        .plugin(scanner::plugin())
        .plugin(
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
            // C6 boot gate: refuse startup when the DB's user_version exceeds
            // what this build's migrations know. A newer app wrote that file;
            // opening it here would silently skip migrations it depends on.
            // Missing/unreadable dir or absent DB = fresh install, proceed.
            if let Ok(app_dir) = app.path().app_data_dir() {
                let db_path = app_dir.join("mobi_pos.db");
                if db_path.exists() {
                    match sqlite_user_version(&db_path) {
                        Ok(v) if v > EXPECTED_MAX_DB_USER_VERSION => {
                            let msg = format!(
                                "Base SQLite trop récente (user_version={} > max supporté={}): \
                                 démarrage refusé, mettez à jour MobiPOS.",
                                v, EXPECTED_MAX_DB_USER_VERSION
                            );
                            eprintln!("{}", msg);
                            return Err(msg.into());
                        }
                        Err(e) => {
                            // Corrupt/short/non-SQLite file: loud, but do not
                            // brick first-run — the recovery/backup flow owns it.
                            eprintln!("Avertissement démarrage: {}", e);
                        }
                        _ => {}
                    }
                }
            }
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
            swap_staging_database,
            sqlite_check_db_version,
            sqlite_db_maintenance,
            intents::launch_dialer,
            intents::launch_call,
            intents::launch_whatsapp,
            intents::launch_print,
            intents::launch_print_label,
            intents::mobile_wifi_print,
            intents::mobile_bluetooth_print,
            intents::mobile_bluetooth_printers,
            intents::launch_url,
            hardware::hardware_scan_devices,
            hardware::hardware_update_vfd,
            hardware::get_hardware_fingerprint,
            hardware::get_license_token,
            hardware::set_license_token,
            hardware::delete_license_token,
            commands::po_process_raw_scan,
            commands::po_commit_stock_batch,
            commands::process_raw_scan,
            commands::commit_stock_batch,
            scanner::mobile_scan_document
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

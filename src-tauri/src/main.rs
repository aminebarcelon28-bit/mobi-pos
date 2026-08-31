// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;

use db::DatabaseManager;
use std::sync::Arc;
use tauri::Manager;

/// Remove the legacy lowercase "mobi-pos" installation that caused duplicate
/// app entries on Windows when upgrading from v1.4.5.  This runs once on every
/// launch and is a no-op if the stale folder/shortcuts are already gone.
fn cleanup_legacy_duplicate() {
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let legacy_dir = std::path::PathBuf::from(&local_app_data).join("mobi-pos");
        if legacy_dir.exists() {
            let _ = std::fs::remove_dir_all(&legacy_dir);
        }
    }

    // Remove stale desktop shortcuts (both user and public desktops)
    let shortcut_names = ["mobi-pos.lnk"];
    let mut dirs_to_check: Vec<std::path::PathBuf> = Vec::new();

    if let Some(profile) = std::env::var_os("USERPROFILE") {
        dirs_to_check.push(std::path::PathBuf::from(&profile).join("Desktop"));
    }
    if let Some(public) = std::env::var_os("PUBLIC") {
        dirs_to_check.push(std::path::PathBuf::from(&public).join("Desktop"));
    }
    // Start-menu entries
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
                .join("Start Menu")
                .join("Programs")
                .join("mobi-pos"),
        );
    }

    for dir in &dirs_to_check {
        if !dir.exists() {
            continue;
        }
        // If the path itself is a directory named "mobi-pos" (start-menu folder), remove it
        if dir.file_name().map(|n| n == "mobi-pos").unwrap_or(false) && dir.is_dir() {
            let _ = std::fs::remove_dir_all(dir);
            continue;
        }
        // Otherwise look for stale shortcut files
        for name in &shortcut_names {
            let lnk = dir.join(name);
            if lnk.exists() {
                let _ = std::fs::remove_file(&lnk);
            }
        }
    }

    // Clean orphaned registry uninstall entry (best-effort, ignore errors)
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Auto-clean any leftover duplicate "mobi-pos" install from v1.4.5
            cleanup_legacy_duplicate();

            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("./data"));
            let db_manager = DatabaseManager::new(&app_data_dir)
                .expect("failed to initialize high-performance SQLite database");
            app.manage(Arc::new(db_manager));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sqlite_get_stats,
            commands::sqlite_integrity_check,
            commands::sqlite_checkpoint_wal,
            commands::sqlite_vacuum,
            commands::sqlite_backup_to_file,
            commands::sqlite_save_product,
            commands::sqlite_bulk_save_products,
            commands::sqlite_get_all_products,
            commands::sqlite_delete_product,
            commands::sqlite_save_customer,
            commands::sqlite_bulk_save_customers,
            commands::sqlite_get_all_customers,
            commands::sqlite_delete_customer,
            commands::sqlite_process_sale_transaction_atomic,
            commands::sqlite_void_transaction_atomic,
            commands::sqlite_process_refund_atomic,
            commands::sqlite_get_all_transactions,
            commands::sqlite_save_repair_order,
            commands::sqlite_get_all_repair_orders,
            commands::sqlite_delete_repair_order,
            commands::sqlite_save_purchase_order,
            commands::sqlite_get_all_purchase_orders,
            commands::sqlite_save_trade_in,
            commands::sqlite_get_all_trade_ins,
            commands::sqlite_save_imei_record,
            commands::sqlite_get_all_imei_records,
            commands::sqlite_save_audit_log,
            commands::sqlite_get_all_audit_logs,
            commands::sqlite_save_cash_drop,
            commands::sqlite_get_cash_drops,
            commands::sqlite_save_bundle,
            commands::sqlite_get_all_bundles,
            commands::sqlite_delete_bundle,
            commands::sqlite_set_setting,
            commands::sqlite_get_setting,
            commands::sqlite_get_all_settings,
            commands::sqlite_save_customer_debt,
            commands::sqlite_get_all_customer_debts,
            commands::sqlite_save_store_expense,
            commands::sqlite_get_all_store_expenses,
            commands::sqlite_delete_store_expense,
            commands::sqlite_clear_all_data,
            commands::sqlite_export_full_json,
            commands::sqlite_import_full_json,
            commands::sqlite_start_shift,
            commands::sqlite_log_expense,
            commands::sqlite_close_shift,
            commands::sqlite_get_active_shift,
            commands::sqlite_get_all_shifts,
            commands::sqlite_get_shift_details,
            commands::sqlite_get_inventory_valuation,
            commands::sqlite_generate_session_backup_json,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

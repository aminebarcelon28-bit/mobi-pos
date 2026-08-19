// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;

use db::DatabaseManager;
use std::sync::Arc;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
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
            commands::sqlite_clear_all_data,
            commands::sqlite_export_full_json,
            commands::sqlite_import_full_json,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

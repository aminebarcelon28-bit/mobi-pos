use crate::db::{DatabaseManager, DbStats, IntegrityReport};
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn sqlite_get_stats(db: State<'_, Arc<DatabaseManager>>) -> Result<DbStats, String> {
    db.get_stats().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_integrity_check(db: State<'_, Arc<DatabaseManager>>) -> Result<IntegrityReport, String> {
    db.run_integrity_check().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_checkpoint_wal(db: State<'_, Arc<DatabaseManager>>) -> Result<String, String> {
    db.checkpoint_wal().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_vacuum(db: State<'_, Arc<DatabaseManager>>) -> Result<String, String> {
    db.vacuum().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_backup_to_file(db: State<'_, Arc<DatabaseManager>>, dest_path: String) -> Result<String, String> {
    db.backup_to_file(&dest_path).map_err(|e| e.to_string())
}

// ── PRODUCTS ──

#[tauri::command]
pub fn sqlite_save_product(db: State<'_, Arc<DatabaseManager>>, product: Value) -> Result<(), String> {
    db.save_product(&product).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_bulk_save_products(db: State<'_, Arc<DatabaseManager>>, products: Vec<Value>) -> Result<(), String> {
    db.bulk_save_products(&products).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_all_products(db: State<'_, Arc<DatabaseManager>>) -> Result<Vec<Value>, String> {
    db.get_all_products().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_delete_product(db: State<'_, Arc<DatabaseManager>>, id: String) -> Result<(), String> {
    db.delete_product(&id).map_err(|e| e.to_string())
}

// ── CUSTOMERS ──

#[tauri::command]
pub fn sqlite_save_customer(db: State<'_, Arc<DatabaseManager>>, customer: Value) -> Result<(), String> {
    db.save_customer(&customer).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_bulk_save_customers(db: State<'_, Arc<DatabaseManager>>, customers: Vec<Value>) -> Result<(), String> {
    db.bulk_save_customers(&customers).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_all_customers(db: State<'_, Arc<DatabaseManager>>) -> Result<Vec<Value>, String> {
    db.get_all_customers().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_delete_customer(db: State<'_, Arc<DatabaseManager>>, id: String) -> Result<(), String> {
    db.delete_customer(&id).map_err(|e| e.to_string())
}

// ── SALE TRANSACTIONS ──

#[tauri::command]
pub fn sqlite_process_sale_transaction_atomic(
    db: State<'_, Arc<DatabaseManager>>,
    transaction: Value,
    updated_products: Vec<Value>,
    updated_customer: Option<Value>,
    audit_entry: Option<Value>,
) -> Result<(), String> {
    db.process_sale_transaction_atomic(
        &transaction,
        &updated_products,
        updated_customer.as_ref(),
        audit_entry.as_ref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_all_transactions(db: State<'_, Arc<DatabaseManager>>) -> Result<Vec<Value>, String> {
    db.get_all_transactions().map_err(|e| e.to_string())
}

// ── REPAIRS ──

#[tauri::command]
pub fn sqlite_save_repair_order(db: State<'_, Arc<DatabaseManager>>, repair: Value) -> Result<(), String> {
    db.save_repair_order(&repair).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_all_repair_orders(db: State<'_, Arc<DatabaseManager>>) -> Result<Vec<Value>, String> {
    db.get_all_repair_orders().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_delete_repair_order(db: State<'_, Arc<DatabaseManager>>, id: String) -> Result<(), String> {
    db.delete_repair_order(&id).map_err(|e| e.to_string())
}

// ── PURCHASE ORDERS ──

#[tauri::command]
pub fn sqlite_save_purchase_order(db: State<'_, Arc<DatabaseManager>>, po: Value) -> Result<(), String> {
    db.save_purchase_order(&po).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_all_purchase_orders(db: State<'_, Arc<DatabaseManager>>) -> Result<Vec<Value>, String> {
    db.get_all_purchase_orders().map_err(|e| e.to_string())
}

// ── TRADE-INS ──

#[tauri::command]
pub fn sqlite_save_trade_in(db: State<'_, Arc<DatabaseManager>>, trade: Value) -> Result<(), String> {
    db.save_trade_in(&trade).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_all_trade_ins(db: State<'_, Arc<DatabaseManager>>) -> Result<Vec<Value>, String> {
    db.get_all_trade_ins().map_err(|e| e.to_string())
}

// ── IMEI RECORDS ──

#[tauri::command]
pub fn sqlite_save_imei_record(db: State<'_, Arc<DatabaseManager>>, record: Value) -> Result<(), String> {
    db.save_imei_record(&record).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_all_imei_records(db: State<'_, Arc<DatabaseManager>>) -> Result<Vec<Value>, String> {
    db.get_all_imei_records().map_err(|e| e.to_string())
}

// ── AUDIT LOGS ──

#[tauri::command]
pub fn sqlite_save_audit_log(db: State<'_, Arc<DatabaseManager>>, entry: Value) -> Result<(), String> {
    db.save_audit_log(&entry).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_all_audit_logs(db: State<'_, Arc<DatabaseManager>>) -> Result<Vec<Value>, String> {
    db.get_all_audit_logs().map_err(|e| e.to_string())
}

// ── CASH DROPS ──

#[tauri::command]
pub fn sqlite_save_cash_drop(db: State<'_, Arc<DatabaseManager>>, drop: Value, is_payout: bool) -> Result<(), String> {
    db.save_cash_drop(&drop, is_payout).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_cash_drops(db: State<'_, Arc<DatabaseManager>>, is_payout: bool) -> Result<Vec<Value>, String> {
    db.get_cash_drops(is_payout).map_err(|e| e.to_string())
}

// ── BUNDLES ──

#[tauri::command]
pub fn sqlite_save_bundle(db: State<'_, Arc<DatabaseManager>>, bundle: Value) -> Result<(), String> {
    db.save_bundle(&bundle).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_all_bundles(db: State<'_, Arc<DatabaseManager>>) -> Result<Vec<Value>, String> {
    db.get_all_bundles().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_delete_bundle(db: State<'_, Arc<DatabaseManager>>, id: String) -> Result<(), String> {
    db.delete_bundle(&id).map_err(|e| e.to_string())
}

// ── APP SETTINGS ──

#[tauri::command]
pub fn sqlite_set_setting(db: State<'_, Arc<DatabaseManager>>, key: String, value: Value) -> Result<(), String> {
    db.set_setting(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_setting(db: State<'_, Arc<DatabaseManager>>, key: String) -> Result<Option<Value>, String> {
    db.get_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_get_all_settings(db: State<'_, Arc<DatabaseManager>>) -> Result<Vec<Value>, String> {
    db.get_all_settings().map_err(|e| e.to_string())
}

// ── CLEAR & FULL EXPORT/IMPORT ──

#[tauri::command]
pub fn sqlite_clear_all_data(db: State<'_, Arc<DatabaseManager>>) -> Result<(), String> {
    db.clear_all_data().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_export_full_json(db: State<'_, Arc<DatabaseManager>>) -> Result<String, String> {
    db.export_full_json().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sqlite_import_full_json(db: State<'_, Arc<DatabaseManager>>, json_string: String) -> Result<(), String> {
    db.import_full_json(&json_string).map_err(|e| e.to_string())
}

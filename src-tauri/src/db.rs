use parking_lot::Mutex;
use rusqlite::{params, Connection, Result, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct DatabaseManager {
    conn: Arc<Mutex<Connection>>,
    db_path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DbStats {
    pub db_path: String,
    pub db_size_bytes: u64,
    pub wal_size_bytes: u64,
    pub page_count: i64,
    pub page_size: i64,
    pub journal_mode: String,
    pub synchronous: String,
    pub foreign_keys: bool,
    pub total_products: i64,
    pub total_customers: i64,
    pub total_transactions: i64,
    pub total_repair_orders: i64,
    pub total_purchase_orders: i64,
    pub integrity_status: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IntegrityReport {
    pub is_healthy: bool,
    pub integrity_messages: Vec<String>,
    pub foreign_key_violations: Vec<String>,
    pub checked_at: String,
}

impl DatabaseManager {
    pub fn new(app_data_dir: &Path) -> Result<Self> {
        fs::create_dir_all(app_data_dir).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to create DB directory: {}", e),
            )))
        })?;

        let db_path = app_data_dir.join("mobi_pos.db");
        let conn = Connection::open(&db_path)?;

        // Configure High-Performance & Zero-Data-Loss PRAGMAs
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            PRAGMA cache_size = -64000;
            PRAGMA mmap_size = 268435456;
            PRAGMA temp_store = MEMORY;
            PRAGMA auto_vacuum = INCREMENTAL;
            ",
        )?;

        let manager = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path,
        };

        manager.init_schema()?;
        Ok(manager)
    }

    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock();

        conn.execute_batch(
            "
            -- 1. Schema Migrations Table
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );

            -- 2. Products Table
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                sku TEXT NOT NULL,
                barcode TEXT NOT NULL,
                title TEXT NOT NULL,
                brand TEXT NOT NULL,
                compatible_model TEXT,
                category TEXT NOT NULL,
                price REAL NOT NULL,
                wholesale_price REAL DEFAULT 0,
                cost_price REAL DEFAULT 0,
                stock INTEGER NOT NULL DEFAULT 0,
                image_url TEXT,
                is_serialized INTEGER DEFAULT 0,
                imei_number TEXT,
                vendor_name TEXT,
                lead_time_days INTEGER DEFAULT 0,
                daily_sales_velocity REAL DEFAULT 0,
                reorder_point INTEGER DEFAULT 0,
                json_payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
            CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
            CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
            CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
            CREATE INDEX IF NOT EXISTS idx_products_imei ON products(imei_number);

            -- 3. Customers Table
            CREATE TABLE IF NOT EXISTS customers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                email TEXT,
                registered_device TEXT,
                loyalty_points INTEGER DEFAULT 0,
                store_credit REAL DEFAULT 0,
                pricing_tier TEXT DEFAULT 'Retail',
                loyalty_tier TEXT DEFAULT 'Bronze',
                total_spent REAL DEFAULT 0,
                loyalty_card_code TEXT,
                barcode TEXT,
                json_payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
            CREATE INDEX IF NOT EXISTS idx_customers_barcode ON customers(barcode);
            CREATE INDEX IF NOT EXISTS idx_customers_loyalty_card ON customers(loyalty_card_code);

            -- 4. Customer Loyalty Ledger Table
            CREATE TABLE IF NOT EXISTS loyalty_ledger (
                id TEXT PRIMARY KEY,
                customer_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                entry_type TEXT NOT NULL,
                points INTEGER NOT NULL,
                balance_after INTEGER NOT NULL,
                description TEXT NOT NULL,
                reference_id TEXT,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_loyalty_ledger_cust ON loyalty_ledger(customer_id);

            -- 5. Sale Transactions Table
            CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY,
                receipt_number TEXT NOT NULL,
                customer_id TEXT,
                subtotal REAL NOT NULL,
                tax REAL DEFAULT 0,
                discount_total REAL DEFAULT 0,
                total REAL NOT NULL,
                cost_total REAL DEFAULT 0,
                profit REAL DEFAULT 0,
                profit_margin REAL DEFAULT 0,
                pricing_tier TEXT DEFAULT 'Retail',
                payment_method TEXT DEFAULT 'Espèces',
                cash_tendered REAL DEFAULT 0,
                change_due REAL DEFAULT 0,
                created_at TEXT NOT NULL,
                json_payload TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_transactions_receipt ON transactions(receipt_number);
            CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
            CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);

            -- 6. Transaction Items Table
            CREATE TABLE IF NOT EXISTS transaction_items (
                id TEXT PRIMARY KEY,
                transaction_id TEXT NOT NULL,
                product_id TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                applied_price REAL NOT NULL,
                discount REAL DEFAULT 0,
                imei_number TEXT,
                cost_price REAL DEFAULT 0,
                json_payload TEXT NOT NULL,
                FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_txn_items_txn ON transaction_items(transaction_id);
            CREATE INDEX IF NOT EXISTS idx_txn_items_prod ON transaction_items(product_id);

            -- 7. Repair Orders Table
            CREATE TABLE IF NOT EXISTS repair_orders (
                id TEXT PRIMARY KEY,
                ticket_number TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                customer_phone TEXT NOT NULL,
                device_model TEXT NOT NULL,
                imei TEXT,
                status TEXT NOT NULL,
                labor_cost REAL DEFAULT 0,
                parts_cost REAL DEFAULT 0,
                total_cost REAL DEFAULT 0,
                deposit_amount REAL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT,
                json_payload TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_repair_ticket ON repair_orders(ticket_number);
            CREATE INDEX IF NOT EXISTS idx_repair_imei ON repair_orders(imei);
            CREATE INDEX IF NOT EXISTS idx_repair_phone ON repair_orders(customer_phone);

            -- 8. Purchase Orders Table
            CREATE TABLE IF NOT EXISTS purchase_orders (
                id TEXT PRIMARY KEY,
                po_number TEXT NOT NULL,
                vendor_name TEXT NOT NULL,
                total_amount REAL NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                json_payload TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_po_number ON purchase_orders(po_number);

            -- 9. Trade-In Buyback Table
            CREATE TABLE IF NOT EXISTS trade_ins (
                id TEXT PRIMARY KEY,
                device_model TEXT NOT NULL,
                imei TEXT NOT NULL,
                brand TEXT NOT NULL,
                condition_grade TEXT NOT NULL,
                buyback_value REAL NOT NULL,
                resale_margin_percent REAL DEFAULT 0,
                resale_price REAL NOT NULL,
                customer_name TEXT NOT NULL,
                credit_to_wallet INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                json_payload TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_trade_ins_imei ON trade_ins(imei);

            -- 10. IMEI Serialized Records Table
            CREATE TABLE IF NOT EXISTS imei_records (
                imei TEXT PRIMARY KEY,
                product_id TEXT NOT NULL,
                purchase_order_id TEXT,
                sale_transaction_id TEXT,
                warranty_expires_at TEXT,
                received_at TEXT NOT NULL,
                sold_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_imei_prod ON imei_records(product_id);

            -- 11. Security Audit Logs Table
            CREATE TABLE IF NOT EXISTS security_audit_logs (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                user TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT NOT NULL,
                requires_pin INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON security_audit_logs(timestamp);

            -- 12. Cash Drops & Payouts Table
            CREATE TABLE IF NOT EXISTS cash_drops (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                amount REAL NOT NULL,
                reason TEXT NOT NULL,
                user TEXT NOT NULL,
                is_payout INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_cash_timestamp ON cash_drops(timestamp);

            -- 13. Product Bundles Table
            CREATE TABLE IF NOT EXISTS product_bundles (
                id TEXT PRIMARY KEY,
                bundle_title TEXT NOT NULL,
                barcode TEXT NOT NULL,
                bundle_price REAL NOT NULL,
                child_skus_json TEXT NOT NULL,
                json_payload TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_bundles_barcode ON product_bundles(barcode);

            -- 14. App Settings Table
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            ",
        )?;

        // Record initial migration
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'))",
            [],
        )?;

        Ok(())
    }

    pub fn get_stats(&self) -> Result<DbStats> {
        let conn = self.conn.lock();

        let db_size_bytes = fs::metadata(&self.db_path).map(|m| m.len()).unwrap_or(0);
        let wal_path = format!("{}-wal", self.db_path.display());
        let wal_size_bytes = fs::metadata(wal_path).map(|m| m.len()).unwrap_or(0);

        let page_count: i64 = conn.query_row("PRAGMA page_count;", [], |r| r.get(0)).unwrap_or(0);
        let page_size: i64 = conn.query_row("PRAGMA page_size;", [], |r| r.get(0)).unwrap_or(4096);
        let journal_mode: String = conn.query_row("PRAGMA journal_mode;", [], |r| r.get(0)).unwrap_or_else(|_| "wal".into());
        let synchronous: String = conn.query_row("PRAGMA synchronous;", [], |r| {
            let val: i64 = r.get(0)?;
            Ok(match val {
                0 => "OFF",
                1 => "NORMAL",
                2 => "FULL",
                3 => "EXTRA",
                _ => "NORMAL",
            }.into())
        }).unwrap_or_else(|_| "NORMAL".into());
        let foreign_keys: bool = conn.query_row("PRAGMA foreign_keys;", [], |r| {
            let val: i64 = r.get(0)?;
            Ok(val != 0)
        }).unwrap_or(true);

        let total_products: i64 = conn.query_row("SELECT COUNT(*) FROM products", [], |r| r.get(0)).unwrap_or(0);
        let total_customers: i64 = conn.query_row("SELECT COUNT(*) FROM customers", [], |r| r.get(0)).unwrap_or(0);
        let total_transactions: i64 = conn.query_row("SELECT COUNT(*) FROM transactions", [], |r| r.get(0)).unwrap_or(0);
        let total_repair_orders: i64 = conn.query_row("SELECT COUNT(*) FROM repair_orders", [], |r| r.get(0)).unwrap_or(0);
        let total_purchase_orders: i64 = conn.query_row("SELECT COUNT(*) FROM purchase_orders", [], |r| r.get(0)).unwrap_or(0);

        let integrity_check: String = conn.query_row("PRAGMA quick_check;", [], |r| r.get(0)).unwrap_or_else(|_| "ok".into());

        Ok(DbStats {
            db_path: self.db_path.to_string_lossy().into_owned(),
            db_size_bytes,
            wal_size_bytes,
            page_count,
            page_size,
            journal_mode,
            synchronous,
            foreign_keys,
            total_products,
            total_customers,
            total_transactions,
            total_repair_orders,
            total_purchase_orders,
            integrity_status: integrity_check,
        })
    }

    pub fn run_integrity_check(&self) -> Result<IntegrityReport> {
        let conn = self.conn.lock();

        let mut integrity_messages = Vec::new();
        let mut stmt = conn.prepare("PRAGMA integrity_check;")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for msg in rows {
            if let Ok(m) = msg {
                integrity_messages.push(m);
            }
        }

        let mut foreign_key_violations = Vec::new();
        let mut fk_stmt = conn.prepare("PRAGMA foreign_key_check;")?;
        let fk_rows = fk_stmt.query_map([], |row| {
            let table: String = row.get(0)?;
            let rowid: i64 = row.get(1)?;
            let parent: String = row.get(2)?;
            Ok(format!("Table '{}' rowid {} refers to invalid row in parent '{}'", table, rowid, parent))
        })?;
        for fk in fk_rows {
            if let Ok(f) = fk {
                foreign_key_violations.push(f);
            }
        }

        let is_healthy = integrity_messages.len() == 1
            && integrity_messages[0].to_lowercase() == "ok"
            && foreign_key_violations.is_empty();

        Ok(IntegrityReport {
            is_healthy,
            integrity_messages,
            foreign_key_violations,
            checked_at: chrono_now_string(),
        })
    }

    pub fn checkpoint_wal(&self) -> Result<String> {
        let conn = self.conn.lock();
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE);", [])?;
        Ok("WAL Checkpoint completed successfully (TRUNCATE mode).".into())
    }

    pub fn vacuum(&self) -> Result<String> {
        let conn = self.conn.lock();
        conn.execute("VACUUM;", [])?;
        Ok("SQLite database VACUUM complete. Pages defragmented.".into())
    }

    pub fn backup_to_file(&self, dest_path: &str) -> Result<String> {
        let conn = self.conn.lock();
        let query = format!("VACUUM INTO '{}';", dest_path.replace('\'', "''"));
        conn.execute(&query, [])?;
        Ok(format!("Backup snapshot written to {}", dest_path))
    }

    // ── PRODUCTS ──

    pub fn save_product(&self, product: &Value) -> Result<()> {
        let conn = self.conn.lock();
        let id = product["id"].as_str().unwrap_or_default();
        let sku = product["sku"].as_str().unwrap_or_default();
        let barcode = product["barcode"].as_str().unwrap_or_default();
        let title = product["title"].as_str().unwrap_or_default();
        let brand = product["brand"].as_str().unwrap_or_default();
        let compatible_model = product["compatibleModel"].as_str();
        let category = product["category"].as_str().unwrap_or_default();
        let price = product["price"].as_f64().unwrap_or(0.0);
        let wholesale_price = product["wholesalePrice"].as_f64().unwrap_or(0.0);
        let cost_price = product["costPrice"].as_f64().unwrap_or(0.0);
        let stock = product["stock"].as_i64().unwrap_or(0);
        let image_url = product["imageUrl"].as_str();
        let is_serialized = if product["isSerialized"].as_bool().unwrap_or(false) { 1 } else { 0 };
        let imei_number = product["imeiNumber"].as_str();
        let vendor_name = product["vendorName"].as_str();
        let lead_time_days = product["leadTimeDays"].as_i64().unwrap_or(0);
        let daily_sales_velocity = product["dailySalesVelocity"].as_f64().unwrap_or(0.0);
        let reorder_point = product["reorderPoint"].as_i64().unwrap_or(0);
        let json_payload = serde_json::to_string(product).unwrap_or_default();
        let updated_at = chrono_now_string();

        conn.execute(
            "INSERT OR REPLACE INTO products (
                id, sku, barcode, title, brand, compatible_model, category,
                price, wholesale_price, cost_price, stock, image_url,
                is_serialized, imei_number, vendor_name, lead_time_days,
                daily_sales_velocity, reorder_point, json_payload, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                id, sku, barcode, title, brand, compatible_model, category,
                price, wholesale_price, cost_price, stock, image_url,
                is_serialized, imei_number, vendor_name, lead_time_days,
                daily_sales_velocity, reorder_point, json_payload, updated_at
            ],
        )?;
        Ok(())
    }

    pub fn bulk_save_products(&self, products: &[Value]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO products (
                    id, sku, barcode, title, brand, compatible_model, category,
                    price, wholesale_price, cost_price, stock, image_url,
                    is_serialized, imei_number, vendor_name, lead_time_days,
                    daily_sales_velocity, reorder_point, json_payload, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            )?;

            let now = chrono_now_string();
            for p in products {
                let id = p["id"].as_str().unwrap_or_default();
                let sku = p["sku"].as_str().unwrap_or_default();
                let barcode = p["barcode"].as_str().unwrap_or_default();
                let title = p["title"].as_str().unwrap_or_default();
                let brand = p["brand"].as_str().unwrap_or_default();
                let compatible_model = p["compatibleModel"].as_str();
                let category = p["category"].as_str().unwrap_or_default();
                let price = p["price"].as_f64().unwrap_or(0.0);
                let wholesale_price = p["wholesalePrice"].as_f64().unwrap_or(0.0);
                let cost_price = p["costPrice"].as_f64().unwrap_or(0.0);
                let stock = p["stock"].as_i64().unwrap_or(0);
                let image_url = p["imageUrl"].as_str();
                let is_serialized = if p["isSerialized"].as_bool().unwrap_or(false) { 1 } else { 0 };
                let imei_number = p["imeiNumber"].as_str();
                let vendor_name = p["vendorName"].as_str();
                let lead_time_days = p["leadTimeDays"].as_i64().unwrap_or(0);
                let daily_sales_velocity = p["dailySalesVelocity"].as_f64().unwrap_or(0.0);
                let reorder_point = p["reorderPoint"].as_i64().unwrap_or(0);
                let json_payload = serde_json::to_string(p).unwrap_or_default();

                stmt.execute(params![
                    id, sku, barcode, title, brand, compatible_model, category,
                    price, wholesale_price, cost_price, stock, image_url,
                    is_serialized, imei_number, vendor_name, lead_time_days,
                    daily_sales_velocity, reorder_point, json_payload, now
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_all_products(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json_payload FROM products ORDER BY title ASC")?;
        let rows = stmt.query_map([], |row| {
            let s: String = row.get(0)?;
            Ok(serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
        })?;

        let mut results = Vec::new();
        for r in rows {
            if let Ok(v) = r {
                if !v.is_null() {
                    results.push(v);
                }
            }
        }
        Ok(results)
    }

    pub fn delete_product(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM products WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── CUSTOMERS & LEDGER ──

    pub fn save_customer(&self, customer: &Value) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        save_customer_internal(&tx, customer)?;
        tx.commit()?;
        Ok(())
    }

    pub fn bulk_save_customers(&self, customers: &[Value]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for c in customers {
            save_customer_internal(&tx, c)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_all_customers(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json_payload FROM customers ORDER BY name ASC")?;
        let rows = stmt.query_map([], |row| {
            let s: String = row.get(0)?;
            Ok(serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
        })?;

        let mut results = Vec::new();
        for r in rows {
            if let Ok(v) = r {
                if !v.is_null() {
                    results.push(v);
                }
            }
        }
        Ok(results)
    }

    pub fn delete_customer(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM customers WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── ATOMIC SALE TRANSACTION (100% ACID ZERO DATA LOSS) ──

    pub fn process_sale_transaction_atomic(
        &self,
        transaction: &Value,
        updated_products: &[Value],
        updated_customer: Option<&Value>,
        audit_entry: Option<&Value>,
    ) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        // 1. Insert Transaction Record
        let txn_id = transaction["id"].as_str().unwrap_or_default();
        let receipt_number = transaction["receiptNumber"].as_str().unwrap_or_default();
        let customer_id = transaction["customer"]["id"].as_str();
        let subtotal = transaction["subtotal"].as_f64().unwrap_or(0.0);
        let tax = transaction["tax"].as_f64().unwrap_or(0.0);
        let discount_total = transaction["discountTotal"].as_f64().unwrap_or(0.0);
        let total = transaction["total"].as_f64().unwrap_or(0.0);
        let cost_total = transaction["costTotal"].as_f64().unwrap_or(0.0);
        let profit = transaction["profit"].as_f64().unwrap_or(0.0);
        let profit_margin = transaction["profitMargin"].as_f64().unwrap_or(0.0);
        let pricing_tier = transaction["pricingTier"].as_str().unwrap_or("Retail");
        let payment_method = transaction["paymentMethod"].as_str().unwrap_or("Espèces");
        let cash_tendered = transaction["cashTendered"].as_f64().unwrap_or(0.0);
        let change_due = transaction["changeDue"].as_f64().unwrap_or(0.0);
        let created_at = transaction["createdAt"].as_str().unwrap_or_default();
        let json_payload = serde_json::to_string(transaction).unwrap_or_default();

        tx.execute(
            "INSERT OR REPLACE INTO transactions (
                id, receipt_number, customer_id, subtotal, tax, discount_total,
                total, cost_total, profit, profit_margin, pricing_tier,
                payment_method, cash_tendered, change_due, created_at, json_payload
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                txn_id, receipt_number, customer_id, subtotal, tax, discount_total,
                total, cost_total, profit, profit_margin, pricing_tier,
                payment_method, cash_tendered, change_due, created_at, json_payload
            ],
        )?;

        // 2. Insert Transaction Items
        if let Some(items) = transaction["items"].as_array() {
            let mut item_stmt = tx.prepare(
                "INSERT OR REPLACE INTO transaction_items (
                    id, transaction_id, product_id, quantity, applied_price,
                    discount, imei_number, cost_price, json_payload
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;

            for (idx, item) in items.iter().enumerate() {
                let item_id = format!("{}-item-{}", txn_id, idx);
                let product_id = item["product"]["id"].as_str().unwrap_or_default();
                let quantity = item["quantity"].as_i64().unwrap_or(1);
                let applied_price = item["appliedPrice"].as_f64().unwrap_or(0.0);
                let discount = item["discount"].as_f64().unwrap_or(0.0);
                let imei_number = item["imeiNumber"].as_str();
                let cost_price = item["product"]["costPrice"].as_f64().unwrap_or(0.0);
                let item_json = serde_json::to_string(item).unwrap_or_default();

                item_stmt.execute(params![
                    item_id, txn_id, product_id, quantity, applied_price,
                    discount, imei_number, cost_price, item_json
                ])?;

                // If serialized, mark IMEI as sold in imei_records
                if let Some(imei) = imei_number {
                    if !imei.trim().is_empty() {
                        tx.execute(
                            "UPDATE imei_records SET sale_transaction_id = ?1, sold_at = ?2 WHERE imei = ?3",
                            params![txn_id, created_at, imei],
                        )?;
                    }
                }
            }
        }

        // 3. Update Product Stock (with bulk statement)
        {
            let mut prod_stmt = tx.prepare(
                "INSERT OR REPLACE INTO products (
                    id, sku, barcode, title, brand, compatible_model, category,
                    price, wholesale_price, cost_price, stock, image_url,
                    is_serialized, imei_number, vendor_name, lead_time_days,
                    daily_sales_velocity, reorder_point, json_payload, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            )?;

            let now = chrono_now_string();
            for p in updated_products {
                let id = p["id"].as_str().unwrap_or_default();
                let sku = p["sku"].as_str().unwrap_or_default();
                let barcode = p["barcode"].as_str().unwrap_or_default();
                let title = p["title"].as_str().unwrap_or_default();
                let brand = p["brand"].as_str().unwrap_or_default();
                let compatible_model = p["compatibleModel"].as_str();
                let category = p["category"].as_str().unwrap_or_default();
                let price = p["price"].as_f64().unwrap_or(0.0);
                let wholesale_price = p["wholesalePrice"].as_f64().unwrap_or(0.0);
                let cost_price = p["costPrice"].as_f64().unwrap_or(0.0);
                let stock = p["stock"].as_i64().unwrap_or(0);
                let image_url = p["imageUrl"].as_str();
                let is_serialized = if p["isSerialized"].as_bool().unwrap_or(false) { 1 } else { 0 };
                let imei_number = p["imeiNumber"].as_str();
                let vendor_name = p["vendorName"].as_str();
                let lead_time_days = p["leadTimeDays"].as_i64().unwrap_or(0);
                let daily_sales_velocity = p["dailySalesVelocity"].as_f64().unwrap_or(0.0);
                let reorder_point = p["reorderPoint"].as_i64().unwrap_or(0);
                let json_payload = serde_json::to_string(p).unwrap_or_default();

                prod_stmt.execute(params![
                    id, sku, barcode, title, brand, compatible_model, category,
                    price, wholesale_price, cost_price, stock, image_url,
                    is_serialized, imei_number, vendor_name, lead_time_days,
                    daily_sales_velocity, reorder_point, json_payload, now
                ])?;
            }
        }

        // 4. Update Customer & Loyalty Ledger
        if let Some(cust) = updated_customer {
            save_customer_internal(&tx, cust)?;
        }

        // 5. Insert Security Audit Entry
        if let Some(audit) = audit_entry {
            let id = audit["id"].as_str().unwrap_or_default();
            let timestamp = audit["timestamp"].as_str().unwrap_or_default();
            let user = audit["user"].as_str().unwrap_or("System");
            let action = audit["action"].as_str().unwrap_or_default();
            let details = audit["details"].as_str().unwrap_or_default();
            let requires_pin = if audit["requiresPin"].as_bool().unwrap_or(false) { 1 } else { 0 };

            tx.execute(
                "INSERT OR REPLACE INTO security_audit_logs (id, timestamp, user, action, details, requires_pin) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, timestamp, user, action, details, requires_pin],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn get_all_transactions(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json_payload FROM transactions ORDER BY rowid DESC")?;
        let rows = stmt.query_map([], |row| {
            let s: String = row.get(0)?;
            Ok(serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
        })?;

        let mut results = Vec::new();
        for r in rows {
            if let Ok(v) = r {
                if !v.is_null() {
                    results.push(v);
                }
            }
        }
        Ok(results)
    }

    // ── REPAIR ORDERS ──

    pub fn save_repair_order(&self, repair: &Value) -> Result<()> {
        let conn = self.conn.lock();
        let id = repair["id"].as_str().unwrap_or_default();
        let ticket_number = repair["ticketNumber"].as_str().unwrap_or_default();
        let customer_name = repair["customerName"].as_str().unwrap_or_default();
        let customer_phone = repair["customerPhone"].as_str().unwrap_or_default();
        let device_model = repair["deviceModel"].as_str().unwrap_or_default();
        let imei = repair["imei"].as_str();
        let status = repair["status"].as_str().unwrap_or("Diagnostic");
        let labor_cost = repair["laborCost"].as_f64().unwrap_or(0.0);
        let parts_cost = repair["partsCost"].as_f64().unwrap_or(0.0);
        let total_cost = repair["totalCost"].as_f64().unwrap_or(0.0);
        let deposit_amount = repair["depositAmount"].as_f64().unwrap_or(0.0);
        let created_at = repair["createdAt"].as_str().unwrap_or_default();
        let updated_at = repair["updatedAt"].as_str();
        let json_payload = serde_json::to_string(repair).unwrap_or_default();

        conn.execute(
            "INSERT OR REPLACE INTO repair_orders (
                id, ticket_number, customer_name, customer_phone, device_model,
                imei, status, labor_cost, parts_cost, total_cost, deposit_amount,
                created_at, updated_at, json_payload
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                id, ticket_number, customer_name, customer_phone, device_model,
                imei, status, labor_cost, parts_cost, total_cost, deposit_amount,
                created_at, updated_at, json_payload
            ],
        )?;
        Ok(())
    }

    pub fn get_all_repair_orders(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json_payload FROM repair_orders ORDER BY rowid DESC")?;
        let rows = stmt.query_map([], |row| {
            let s: String = row.get(0)?;
            Ok(serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
        })?;

        let mut results = Vec::new();
        for r in rows {
            if let Ok(v) = r {
                if !v.is_null() {
                    results.push(v);
                }
            }
        }
        Ok(results)
    }

    pub fn delete_repair_order(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM repair_orders WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── PURCHASE ORDERS ──

    pub fn save_purchase_order(&self, po: &Value) -> Result<()> {
        let conn = self.conn.lock();
        let id = po["id"].as_str().unwrap_or_default();
        let po_number = po["poNumber"].as_str().unwrap_or_default();
        let vendor_name = po["vendorName"].as_str().unwrap_or_default();
        let total_amount = po["totalAmount"].as_f64().unwrap_or(0.0);
        let status = po["status"].as_str().unwrap_or("Draft");
        let created_at = po["createdAt"].as_str().unwrap_or_default();
        let json_payload = serde_json::to_string(po).unwrap_or_default();

        conn.execute(
            "INSERT OR REPLACE INTO purchase_orders (
                id, po_number, vendor_name, total_amount, status, created_at, json_payload
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, po_number, vendor_name, total_amount, status, created_at, json_payload],
        )?;
        Ok(())
    }

    pub fn get_all_purchase_orders(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json_payload FROM purchase_orders ORDER BY rowid DESC")?;
        let rows = stmt.query_map([], |row| {
            let s: String = row.get(0)?;
            Ok(serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
        })?;

        let mut results = Vec::new();
        for r in rows {
            if let Ok(v) = r {
                if !v.is_null() {
                    results.push(v);
                }
            }
        }
        Ok(results)
    }

    // ── TRADE-INS ──

    pub fn save_trade_in(&self, trade: &Value) -> Result<()> {
        let conn = self.conn.lock();
        let id = trade["id"].as_str().unwrap_or_default();
        let device_model = trade["deviceModel"].as_str().unwrap_or_default();
        let imei = trade["imei"].as_str().unwrap_or_default();
        let brand = trade["brand"].as_str().unwrap_or_default();
        let condition_grade = trade["conditionGrade"].as_str().unwrap_or_default();
        let buyback_value = trade["buybackValue"].as_f64().unwrap_or(0.0);
        let resale_margin_percent = trade["resaleMarginPercent"].as_f64().unwrap_or(0.0);
        let resale_price = trade["resalePrice"].as_f64().unwrap_or(0.0);
        let customer_name = trade["customerName"].as_str().unwrap_or_default();
        let credit_to_wallet = if trade["creditToWallet"].as_bool().unwrap_or(false) { 1 } else { 0 };
        let created_at = trade["createdAt"].as_str().unwrap_or_default();
        let json_payload = serde_json::to_string(trade).unwrap_or_default();

        conn.execute(
            "INSERT OR REPLACE INTO trade_ins (
                id, device_model, imei, brand, condition_grade, buyback_value,
                resale_margin_percent, resale_price, customer_name, credit_to_wallet,
                created_at, json_payload
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id, device_model, imei, brand, condition_grade, buyback_value,
                resale_margin_percent, resale_price, customer_name, credit_to_wallet,
                created_at, json_payload
            ],
        )?;
        Ok(())
    }

    pub fn get_all_trade_ins(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json_payload FROM trade_ins ORDER BY rowid DESC")?;
        let rows = stmt.query_map([], |row| {
            let s: String = row.get(0)?;
            Ok(serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
        })?;

        let mut results = Vec::new();
        for r in rows {
            if let Ok(v) = r {
                if !v.is_null() {
                    results.push(v);
                }
            }
        }
        Ok(results)
    }

    // ── IMEI RECORDS ──

    pub fn save_imei_record(&self, record: &Value) -> Result<()> {
        let conn = self.conn.lock();
        let imei = record["imei"].as_str().unwrap_or_default();
        let product_id = record["productId"].as_str().unwrap_or_default();
        let purchase_order_id = record["purchaseOrderId"].as_str();
        let sale_transaction_id = record["saleTransactionId"].as_str();
        let warranty_expires_at = record["warrantyExpiresAt"].as_str();
        let received_at = record["receivedAt"].as_str().unwrap_or_default();
        let sold_at = record["soldAt"].as_str();

        conn.execute(
            "INSERT OR REPLACE INTO imei_records (
                imei, product_id, purchase_order_id, sale_transaction_id,
                warranty_expires_at, received_at, sold_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                imei, product_id, purchase_order_id, sale_transaction_id,
                warranty_expires_at, received_at, sold_at
            ],
        )?;
        Ok(())
    }

    pub fn get_all_imei_records(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT imei, product_id, purchase_order_id, sale_transaction_id, warranty_expires_at, received_at, sold_at FROM imei_records")?;
        let rows = stmt.query_map([], |row| {
            let imei: String = row.get(0)?;
            let product_id: String = row.get(1)?;
            let purchase_order_id: Option<String> = row.get(2)?;
            let sale_transaction_id: Option<String> = row.get(3)?;
            let warranty_expires_at: Option<String> = row.get(4)?;
            let received_at: String = row.get(5)?;
            let sold_at: Option<String> = row.get(6)?;

            Ok(serde_json::json!({
                "imei": imei,
                "productId": product_id,
                "purchaseOrderId": purchase_order_id,
                "saleTransactionId": sale_transaction_id,
                "warrantyExpiresAt": warranty_expires_at,
                "receivedAt": received_at,
                "soldAt": sold_at
            }))
        })?;

        let mut results = Vec::new();
        for r in rows {
            if let Ok(v) = r {
                results.push(v);
            }
        }
        Ok(results)
    }

    // ── AUDIT LOGS ──

    pub fn save_audit_log(&self, entry: &Value) -> Result<()> {
        let conn = self.conn.lock();
        let id = entry["id"].as_str().unwrap_or_default();
        let timestamp = entry["timestamp"].as_str().unwrap_or_default();
        let user = entry["user"].as_str().unwrap_or("System");
        let action = entry["action"].as_str().unwrap_or_default();
        let details = entry["details"].as_str().unwrap_or_default();
        let requires_pin = if entry["requiresPin"].as_bool().unwrap_or(false) { 1 } else { 0 };

        conn.execute(
            "INSERT OR REPLACE INTO security_audit_logs (id, timestamp, user, action, details, requires_pin) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, timestamp, user, action, details, requires_pin],
        )?;
        Ok(())
    }

    pub fn get_all_audit_logs(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT id, timestamp, user, action, details, requires_pin FROM security_audit_logs ORDER BY rowid DESC")?;
        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let timestamp: String = row.get(1)?;
            let user: String = row.get(2)?;
            let action: String = row.get(3)?;
            let details: String = row.get(4)?;
            let requires_pin: i64 = row.get(5)?;

            Ok(serde_json::json!({
                "id": id,
                "timestamp": timestamp,
                "user": user,
                "action": action,
                "details": details,
                "requiresPin": requires_pin != 0
            }))
        })?;

        let mut results = Vec::new();
        for r in rows {
            if let Ok(v) = r {
                results.push(v);
            }
        }
        Ok(results)
    }

    // ── CASH DROPS & PAYOUTS ──

    pub fn save_cash_drop(&self, drop: &Value, is_payout: bool) -> Result<()> {
        let conn = self.conn.lock();
        let id = drop["id"].as_str().unwrap_or_default();
        let timestamp = drop["timestamp"].as_str().unwrap_or_default();
        let amount = drop["amount"].as_f64().unwrap_or(0.0);
        let reason = drop["reason"].as_str().unwrap_or_default();
        let user = drop["user"].as_str().unwrap_or("Admin");
        let is_payout_int = if is_payout { 1 } else { 0 };

        conn.execute(
            "INSERT OR REPLACE INTO cash_drops (id, timestamp, amount, reason, user, is_payout) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, timestamp, amount, reason, user, is_payout_int],
        )?;
        Ok(())
    }

    pub fn get_cash_drops(&self, is_payout: bool) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let is_payout_int = if is_payout { 1 } else { 0 };
        let mut stmt = conn.prepare("SELECT id, timestamp, amount, reason, user FROM cash_drops WHERE is_payout = ?1 ORDER BY rowid DESC")?;
        let rows = stmt.query_map(params![is_payout_int], |row| {
            let id: String = row.get(0)?;
            let timestamp: String = row.get(1)?;
            let amount: f64 = row.get(2)?;
            let reason: String = row.get(3)?;
            let user: String = row.get(4)?;

            Ok(serde_json::json!({
                "id": id,
                "timestamp": timestamp,
                "amount": amount,
                "reason": reason,
                "user": user
            }))
        })?;

        let mut results = Vec::new();
        for r in rows {
            if let Ok(v) = r {
                results.push(v);
            }
        }
        Ok(results)
    }

    // ── BUNDLES ──

    pub fn save_bundle(&self, bundle: &Value) -> Result<()> {
        let conn = self.conn.lock();
        let id = bundle["id"].as_str().unwrap_or_default();
        let bundle_title = bundle["bundleTitle"].as_str().unwrap_or_default();
        let barcode = bundle["barcode"].as_str().unwrap_or_default();
        let bundle_price = bundle["bundlePrice"].as_f64().unwrap_or(0.0);
        let child_skus_json = serde_json::to_string(&bundle["childSkus"]).unwrap_or_else(|_| "[]".into());
        let json_payload = serde_json::to_string(bundle).unwrap_or_default();

        conn.execute(
            "INSERT OR REPLACE INTO product_bundles (id, bundle_title, barcode, bundle_price, child_skus_json, json_payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, bundle_title, barcode, bundle_price, child_skus_json, json_payload],
        )?;
        Ok(())
    }

    pub fn get_all_bundles(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json_payload FROM product_bundles ORDER BY bundle_title ASC")?;
        let rows = stmt.query_map([], |row| {
            let s: String = row.get(0)?;
            Ok(serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
        })?;

        let mut results = Vec::new();
        for r in rows {
            if let Ok(v) = r {
                if !v.is_null() {
                    results.push(v);
                }
            }
        }
        Ok(results)
    }

    pub fn delete_bundle(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM product_bundles WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── APP SETTINGS ──

    pub fn set_setting(&self, key: &str, value: &Value) -> Result<()> {
        let conn = self.conn.lock();
        let value_json = serde_json::to_string(value).unwrap_or_default();
        let updated_at = chrono_now_string();

        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
            params![key, value_json, updated_at],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT value_json FROM app_settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            let s: String = row.get(0)?;
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                return Ok(Some(v));
            }
        }
        Ok(None)
    }

    pub fn get_all_settings(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT key, value_json FROM app_settings")?;
        let rows = stmt.query_map([], |row| {
            let key: String = row.get(0)?;
            let value_json: String = row.get(1)?;
            let val = serde_json::from_str::<Value>(&value_json).unwrap_or(Value::Null);
            Ok(serde_json::json!({
                "key": key,
                "value": val
            }))
        })?;

        let mut results = Vec::new();
        for r in rows {
            if let Ok(v) = r {
                results.push(v);
            }
        }
        Ok(results)
    }

    // ── CLEAR & FULL EXPORT/IMPORT ──

    pub fn clear_all_data(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            "
            DELETE FROM transaction_items;
            DELETE FROM transactions;
            DELETE FROM loyalty_ledger;
            DELETE FROM customers;
            DELETE FROM products;
            DELETE FROM repair_orders;
            DELETE FROM purchase_orders;
            DELETE FROM trade_ins;
            DELETE FROM imei_records;
            DELETE FROM security_audit_logs;
            DELETE FROM cash_drops;
            DELETE FROM product_bundles;
            ",
        )?;
        Ok(())
    }

    pub fn export_full_json(&self) -> Result<String> {
        let products = self.get_all_products()?;
        let customers = self.get_all_customers()?;
        let transactions = self.get_all_transactions()?;
        let repair_orders = self.get_all_repair_orders()?;
        let purchase_orders = self.get_all_purchase_orders()?;
        let trade_ins = self.get_all_trade_ins()?;
        let imei_records = self.get_all_imei_records()?;
        let security_logs = self.get_all_audit_logs()?;
        let cash_drops = self.get_cash_drops(false)?;
        let payouts = self.get_cash_drops(true)?;
        let bundles = self.get_all_bundles()?;
        let settings = self.get_all_settings()?;

        let export_obj = serde_json::json!({
            "exportedAt": chrono_now_string(),
            "engine": "SQLite WAL v1.0",
            "version": "2.0.0-sqlite",
            "products": products,
            "customers": customers,
            "transactions": transactions,
            "repairOrders": repair_orders,
            "purchaseOrders": purchase_orders,
            "tradeIns": trade_ins,
            "imeiRecords": imei_records,
            "securityAuditLogs": security_logs,
            "cashDrops": cash_drops,
            "payouts": payouts,
            "bundles": bundles,
            "settings": settings,
        });

        serde_json::to_string_pretty(&export_obj).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })
    }

    pub fn import_full_json(&self, json_string: &str) -> Result<()> {
        let val: Value = serde_json::from_str(json_string).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("JSON Parse Error: {}", e),
            )))
        })?;

        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        // Clean tables
        tx.execute_batch(
            "
            DELETE FROM transaction_items;
            DELETE FROM transactions;
            DELETE FROM loyalty_ledger;
            DELETE FROM customers;
            DELETE FROM products;
            DELETE FROM repair_orders;
            DELETE FROM purchase_orders;
            DELETE FROM trade_ins;
            DELETE FROM imei_records;
            DELETE FROM security_audit_logs;
            DELETE FROM cash_drops;
            DELETE FROM product_bundles;
            ",
        )?;

        // Import products
        if let Some(products) = val["products"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO products (
                    id, sku, barcode, title, brand, compatible_model, category,
                    price, wholesale_price, cost_price, stock, image_url,
                    is_serialized, imei_number, vendor_name, lead_time_days,
                    daily_sales_velocity, reorder_point, json_payload, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            )?;
            let now = chrono_now_string();
            for p in products {
                let id = p["id"].as_str().unwrap_or_default();
                let sku = p["sku"].as_str().unwrap_or_default();
                let barcode = p["barcode"].as_str().unwrap_or_default();
                let title = p["title"].as_str().unwrap_or_default();
                let brand = p["brand"].as_str().unwrap_or_default();
                let compatible_model = p["compatibleModel"].as_str();
                let category = p["category"].as_str().unwrap_or_default();
                let price = p["price"].as_f64().unwrap_or(0.0);
                let wholesale_price = p["wholesalePrice"].as_f64().unwrap_or(0.0);
                let cost_price = p["costPrice"].as_f64().unwrap_or(0.0);
                let stock = p["stock"].as_i64().unwrap_or(0);
                let image_url = p["imageUrl"].as_str();
                let is_serialized = if p["isSerialized"].as_bool().unwrap_or(false) { 1 } else { 0 };
                let imei_number = p["imeiNumber"].as_str();
                let vendor_name = p["vendorName"].as_str();
                let lead_time_days = p["leadTimeDays"].as_i64().unwrap_or(0);
                let daily_sales_velocity = p["dailySalesVelocity"].as_f64().unwrap_or(0.0);
                let reorder_point = p["reorderPoint"].as_i64().unwrap_or(0);
                let json_payload = serde_json::to_string(p).unwrap_or_default();

                stmt.execute(params![
                    id, sku, barcode, title, brand, compatible_model, category,
                    price, wholesale_price, cost_price, stock, image_url,
                    is_serialized, imei_number, vendor_name, lead_time_days,
                    daily_sales_velocity, reorder_point, json_payload, now
                ])?;
            }
        }

        // Import customers
        if let Some(customers) = val["customers"].as_array() {
            for c in customers {
                save_customer_internal(&tx, c)?;
            }
        }

        // Import transactions
        if let Some(txns) = val["transactions"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO transactions (
                    id, receipt_number, customer_id, subtotal, tax, discount_total,
                    total, cost_total, profit, profit_margin, pricing_tier,
                    payment_method, cash_tendered, change_due, created_at, json_payload
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            )?;
            for t in txns {
                let id = t["id"].as_str().unwrap_or_default();
                let receipt_number = t["receiptNumber"].as_str().unwrap_or_default();
                let customer_id = t["customer"]["id"].as_str();
                let subtotal = t["subtotal"].as_f64().unwrap_or(0.0);
                let tax = t["tax"].as_f64().unwrap_or(0.0);
                let discount_total = t["discountTotal"].as_f64().unwrap_or(0.0);
                let total = t["total"].as_f64().unwrap_or(0.0);
                let cost_total = t["costTotal"].as_f64().unwrap_or(0.0);
                let profit = t["profit"].as_f64().unwrap_or(0.0);
                let profit_margin = t["profitMargin"].as_f64().unwrap_or(0.0);
                let pricing_tier = t["pricingTier"].as_str().unwrap_or("Retail");
                let payment_method = t["paymentMethod"].as_str().unwrap_or("Espèces");
                let cash_tendered = t["cashTendered"].as_f64().unwrap_or(0.0);
                let change_due = t["changeDue"].as_f64().unwrap_or(0.0);
                let created_at = t["createdAt"].as_str().unwrap_or_default();
                let json_payload = serde_json::to_string(t).unwrap_or_default();

                stmt.execute(params![
                    id, receipt_number, customer_id, subtotal, tax, discount_total,
                    total, cost_total, profit, profit_margin, pricing_tier,
                    payment_method, cash_tendered, change_due, created_at, json_payload
                ])?;
            }
        }

        // Import repair orders
        if let Some(repairs) = val["repairOrders"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO repair_orders (
                    id, ticket_number, customer_name, customer_phone, device_model,
                    imei, status, labor_cost, parts_cost, total_cost, deposit_amount,
                    created_at, updated_at, json_payload
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            )?;
            for r in repairs {
                let id = r["id"].as_str().unwrap_or_default();
                let ticket_number = r["ticketNumber"].as_str().unwrap_or_default();
                let customer_name = r["customerName"].as_str().unwrap_or_default();
                let customer_phone = r["customerPhone"].as_str().unwrap_or_default();
                let device_model = r["deviceModel"].as_str().unwrap_or_default();
                let imei = r["imei"].as_str();
                let status = r["status"].as_str().unwrap_or("Diagnostic");
                let labor_cost = r["laborCost"].as_f64().unwrap_or(0.0);
                let parts_cost = r["partsCost"].as_f64().unwrap_or(0.0);
                let total_cost = r["totalCost"].as_f64().unwrap_or(0.0);
                let deposit_amount = r["depositAmount"].as_f64().unwrap_or(0.0);
                let created_at = r["createdAt"].as_str().unwrap_or_default();
                let updated_at = r["updatedAt"].as_str();
                let json_payload = serde_json::to_string(r).unwrap_or_default();

                stmt.execute(params![
                    id, ticket_number, customer_name, customer_phone, device_model,
                    imei, status, labor_cost, parts_cost, total_cost, deposit_amount,
                    created_at, updated_at, json_payload
                ])?;
            }
        }

        // Import settings
        if let Some(settings) = val["settings"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
            )?;
            let now = chrono_now_string();
            for s in settings {
                let key = s["key"].as_str().unwrap_or_default();
                let value_json = serde_json::to_string(&s["value"]).unwrap_or_default();
                stmt.execute(params![key, value_json, now])?;
            }
        }

        tx.commit()?;
        Ok(())
    }
}

fn save_customer_internal(tx: &Transaction, customer: &Value) -> Result<()> {
    let id = customer["id"].as_str().unwrap_or_default();
    let name = customer["name"].as_str().unwrap_or_default();
    let phone = customer["phone"].as_str().unwrap_or_default();
    let email = customer["email"].as_str();
    let registered_device = customer["registeredDevice"].as_str();
    let loyalty_points = customer["loyaltyPoints"].as_i64().unwrap_or(0);
    let store_credit = customer["storeCredit"].as_f64().unwrap_or(0.0);
    let pricing_tier = customer["pricingTier"].as_str().unwrap_or("Retail");
    let loyalty_tier = customer["loyaltyTier"].as_str().unwrap_or("Bronze");
    let total_spent = customer["totalSpent"].as_f64().unwrap_or(0.0);
    let loyalty_card_code = customer["loyaltyCardCode"].as_str();
    let barcode = customer["barcode"].as_str();
    let json_payload = serde_json::to_string(customer).unwrap_or_default();
    let updated_at = chrono_now_string();

    tx.execute(
        "INSERT OR REPLACE INTO customers (
            id, name, phone, email, registered_device, loyalty_points, store_credit,
            pricing_tier, loyalty_tier, total_spent, loyalty_card_code, barcode,
            json_payload, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id, name, phone, email, registered_device, loyalty_points, store_credit,
            pricing_tier, loyalty_tier, total_spent, loyalty_card_code, barcode,
            json_payload, updated_at
        ],
    )?;

    // Save customer ledger entries if present
    if let Some(ledger) = customer["ledger"].as_array() {
        let mut ledger_stmt = tx.prepare(
            "INSERT OR REPLACE INTO loyalty_ledger (
                id, customer_id, timestamp, entry_type, points, balance_after,
                description, reference_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;

        for entry in ledger {
            let entry_id = entry["id"].as_str().unwrap_or_default();
            let timestamp = entry["timestamp"].as_str().unwrap_or_default();
            let entry_type = entry["type"].as_str().unwrap_or("earn");
            let points = entry["points"].as_i64().unwrap_or(0);
            let balance_after = entry["balanceAfter"].as_i64().unwrap_or(0);
            let description = entry["description"].as_str().unwrap_or_default();
            let reference_id = entry["referenceId"].as_str();

            ledger_stmt.execute(params![
                entry_id, id, timestamp, entry_type, points, balance_after,
                description, reference_id
            ])?;
        }
    }

    Ok(())
}

fn chrono_now_string() -> String {
    let now = std::time::SystemTime::now();
    let duration = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs();
    format!("{}-08-19T19:00:00Z", secs)
}

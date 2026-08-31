use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Result, Transaction};
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
            PRAGMA wal_autocheckpoint = 1000;
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
                status TEXT NOT NULL DEFAULT 'COMPLETED',
                created_at TEXT NOT NULL,
                json_payload TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_transactions_receipt ON transactions(receipt_number);
            CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
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

            -- 15. Cash Sessions Table (POS Drawer Shifts)
            CREATE TABLE IF NOT EXISTS cash_sessions (
                id TEXT PRIMARY KEY,
                opened_at TEXT NOT NULL,
                closed_at TEXT,
                opening_float INTEGER NOT NULL,
                expected_cash INTEGER,
                actual_cash INTEGER,
                status TEXT NOT NULL DEFAULT 'OPEN',
                cashier_name TEXT,
                opening_note TEXT,
                closing_note TEXT,
                discrepancy INTEGER,
                json_payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_status ON cash_sessions(status);
            CREATE INDEX IF NOT EXISTS idx_sessions_opened_at ON cash_sessions(opened_at);

            -- 16. Drawer Movements Table (Expenses & Manual Deposits)
            CREATE TABLE IF NOT EXISTS cash_movements (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                amount INTEGER NOT NULL,
                reason TEXT NOT NULL,
                cashier_name TEXT,
                created_at TEXT NOT NULL,
                json_payload TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES cash_sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_movements_session ON cash_movements(session_id);
            CREATE INDEX IF NOT EXISTS idx_movements_type ON cash_movements(type);

            -- 17. Real-Time Inventory Valuation SQL View
            CREATE VIEW IF NOT EXISTS v_inventory_valuation AS
            SELECT
                COUNT(*) as total_skus,
                COALESCE(SUM(stock), 0) as total_units,
                COALESCE(CAST(ROUND(SUM(stock * cost_price)) AS INTEGER), 0) as total_cost_value,
                COALESCE(CAST(ROUND(SUM(stock * price)) AS INTEGER), 0) as total_retail_value,
                COALESCE(CAST(ROUND(SUM(stock * (price - cost_price))) AS INTEGER), 0) as potential_profit_margin
            FROM products
            WHERE stock > 0;

            -- 18. Customer Debts (Kredy) Table
            CREATE TABLE IF NOT EXISTS customer_debts (
                id TEXT PRIMARY KEY,
                customer_id TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                type TEXT NOT NULL,
                amount REAL NOT NULL,
                balance_after REAL NOT NULL,
                receipt_number TEXT,
                payment_method TEXT,
                notes TEXT,
                recorded_by TEXT,
                created_at TEXT NOT NULL,
                json_payload TEXT NOT NULL,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_customer_debts_cust ON customer_debts(customer_id);
            CREATE INDEX IF NOT EXISTS idx_customer_debts_created ON customer_debts(created_at);

            -- 19. Store Expenses (EBITDA) Table
            CREATE TABLE IF NOT EXISTS store_expenses (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                title TEXT NOT NULL,
                amount REAL NOT NULL,
                payment_method TEXT NOT NULL,
                paid_to TEXT,
                notes TEXT,
                recorded_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                json_payload TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_store_expenses_category ON store_expenses(category);
            CREATE INDEX IF NOT EXISTS idx_store_expenses_created ON store_expenses(created_at);
            ",
        )?;

        // Backward compatibility migration for older SQLite database files
        let _ = conn.execute("ALTER TABLE transactions ADD COLUMN status TEXT DEFAULT 'COMPLETED'", []);
        let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)", []);

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
        let status = transaction["status"].as_str().unwrap_or("COMPLETED");
        let created_at = transaction["createdAt"].as_str().unwrap_or_default();
        let json_payload = serde_json::to_string(transaction).unwrap_or_default();

        tx.execute(
            "INSERT OR REPLACE INTO transactions (
                id, receipt_number, customer_id, subtotal, tax, discount_total,
                total, cost_total, profit, profit_margin, pricing_tier,
                payment_method, cash_tendered, change_due, status, created_at, json_payload
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                txn_id, receipt_number, customer_id, subtotal, tax, discount_total,
                total, cost_total, profit, profit_margin, pricing_tier,
                payment_method, cash_tendered, change_due, status, created_at, json_payload
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
                let cost_price = item["unitCostPrice"]
                    .as_f64()
                    .or_else(|| item["product"]["costPrice"].as_f64())
                    .unwrap_or(0.0);
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

    pub fn void_transaction_atomic(
        &self,
        transaction_id: &str,
        voided_transaction: &Value,
        restored_products: &[Value],
        updated_customer: Option<&Value>,
        restored_imeis: &[String],
        audit_entry: Option<&Value>,
    ) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        // 1. Update the transaction row with voided JSON payload (preserves audit trail)
        let json_payload = serde_json::to_string(voided_transaction).unwrap_or_default();
        tx.execute(
            "UPDATE transactions SET status = 'VOIDED', json_payload = ?1 WHERE id = ?2",
            params![json_payload, transaction_id],
        )?;

        // 2. Restore Product stock
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
            for p in restored_products {
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

        // 3. Release restored IMEIs
        for imei in restored_imeis {
            tx.execute(
                "UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL WHERE imei = ?1",
                params![imei],
            )?;
        }

        // 4. Update Customer & Loyalty Ledger if customer changed
        if let Some(cust) = updated_customer {
            save_customer_internal(&tx, cust)?;
        }

        // 5. Insert Audit Log
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

    pub fn process_refund_atomic(
        &self,
        refund_transaction: &Value,
        updated_original_transaction: Option<&Value>,
        restocked_products: &[Value],
        updated_customer: Option<&Value>,
        restored_imeis: &[String],
        audit_entry: Option<&Value>,
    ) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        // 1. Insert Refund Transaction Record
        let txn_id = refund_transaction["id"].as_str().unwrap_or_default();
        let receipt_number = refund_transaction["receiptNumber"].as_str().unwrap_or_default();
        let customer_id = refund_transaction["customer"]["id"].as_str();
        let subtotal = refund_transaction["subtotal"].as_f64().unwrap_or(0.0);
        let tax = refund_transaction["tax"].as_f64().unwrap_or(0.0);
        let discount_total = refund_transaction["discountTotal"].as_f64().unwrap_or(0.0);
        let total = refund_transaction["total"].as_f64().unwrap_or(0.0);
        let cost_total = refund_transaction["costTotal"].as_f64().unwrap_or(0.0);
        let profit = refund_transaction["profit"].as_f64().unwrap_or(0.0);
        let profit_margin = refund_transaction["profitMargin"].as_f64().unwrap_or(0.0);
        let pricing_tier = refund_transaction["pricingTier"].as_str().unwrap_or("Retail");
        let payment_method = refund_transaction["paymentMethod"].as_str().unwrap_or("Espèces");
        let cash_tendered = refund_transaction["cashTendered"].as_f64().unwrap_or(0.0);
        let change_due = refund_transaction["changeDue"].as_f64().unwrap_or(0.0);
        let status = refund_transaction["status"].as_str().unwrap_or("REFUNDED");
        let created_at = refund_transaction["createdAt"].as_str().unwrap_or_default();
        let json_payload = serde_json::to_string(refund_transaction).unwrap_or_default();

        tx.execute(
            "INSERT OR REPLACE INTO transactions (
                id, receipt_number, customer_id, subtotal, tax, discount_total,
                total, cost_total, profit, profit_margin, pricing_tier,
                payment_method, cash_tendered, change_due, status, created_at, json_payload
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                txn_id, receipt_number, customer_id, subtotal, tax, discount_total,
                total, cost_total, profit, profit_margin, pricing_tier,
                payment_method, cash_tendered, change_due, status, created_at, json_payload
            ],
        )?;

        // 2. Update Original Transaction if provided
        if let Some(orig) = updated_original_transaction {
            let orig_id = orig["id"].as_str().unwrap_or_default();
            let orig_status = orig["status"].as_str().unwrap_or("REFUNDED");
            let orig_json = serde_json::to_string(orig).unwrap_or_default();
            tx.execute(
                "UPDATE transactions SET status = ?1, json_payload = ?2 WHERE id = ?3",
                params![orig_status, orig_json, orig_id],
            )?;
        }

        // 3. Update Restocked Products
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
            for p in restocked_products {
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

        // 4. Release restored IMEIs
        for imei in restored_imeis {
            tx.execute(
                "UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL WHERE imei = ?1",
                params![imei],
            )?;
        }

        // 5. Update Customer & Loyalty Ledger
        if let Some(cust) = updated_customer {
            save_customer_internal(&tx, cust)?;
        }

        // 6. Insert Audit Log
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

    // ── CUSTOMER DEBTS (KREDY) ──

    pub fn save_customer_debt(&self, debt: &Value) -> Result<()> {
        let conn = self.conn.lock();
        let id = debt["id"].as_str().unwrap_or_default();
        let customer_id = debt["customerId"].as_str().unwrap_or_default();
        let customer_name = debt["customerName"].as_str().unwrap_or_default();
        let movement_type = debt["type"].as_str().unwrap_or("DEBT_ACQUIRED");
        let amount = debt["amount"].as_f64().unwrap_or(0.0);
        let balance_after = debt["balanceAfter"].as_f64().unwrap_or(0.0);
        let receipt_number = debt["receiptNumber"].as_str();
        let payment_method = debt["paymentMethod"].as_str();
        let notes = debt["notes"].as_str();
        let recorded_by = debt["recordedBy"].as_str();
        let created_at = debt["createdAt"].as_str().unwrap_or_default();
        let json_payload = serde_json::to_string(debt).unwrap_or_default();

        conn.execute(
            "INSERT OR REPLACE INTO customer_debts (
                id, customer_id, customer_name, type, amount, balance_after,
                receipt_number, payment_method, notes, recorded_by, created_at, json_payload
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id, customer_id, customer_name, movement_type, amount, balance_after,
                receipt_number, payment_method, notes, recorded_by, created_at, json_payload
            ],
        )?;
        Ok(())
    }

    pub fn get_all_customer_debts(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json_payload FROM customer_debts ORDER BY created_at DESC")?;
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

    // ── STORE EXPENSES (EBITDA) ──

    pub fn save_store_expense(&self, expense: &Value) -> Result<()> {
        let conn = self.conn.lock();
        let id = expense["id"].as_str().unwrap_or_default();
        let category = expense["category"].as_str().unwrap_or("Autre Charge");
        let title = expense["title"].as_str().unwrap_or_default();
        let amount = expense["amount"].as_f64().unwrap_or(0.0);
        let payment_method = expense["paymentMethod"].as_str().unwrap_or("Espèces");
        let paid_to = expense["paidTo"].as_str();
        let notes = expense["notes"].as_str();
        let recorded_by = expense["recordedBy"].as_str().unwrap_or("Admin");
        let created_at = expense["createdAt"].as_str().unwrap_or_default();
        let json_payload = serde_json::to_string(expense).unwrap_or_default();

        conn.execute(
            "INSERT OR REPLACE INTO store_expenses (
                id, category, title, amount, payment_method, paid_to, notes,
                recorded_by, created_at, json_payload
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id, category, title, amount, payment_method, paid_to, notes,
                recorded_by, created_at, json_payload
            ],
        )?;
        Ok(())
    }

    pub fn get_all_store_expenses(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json_payload FROM store_expenses ORDER BY created_at DESC")?;
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

    pub fn delete_store_expense(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM store_expenses WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_all_cash_movements(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json_payload FROM cash_movements ORDER BY created_at ASC")?;
        let rows = stmt.query_map([], |r| {
            let s: String = r.get(0)?;
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

    // ── CLEAR & FULL EXPORT/IMPORT ──

    pub fn clear_all_data(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            "
            DELETE FROM cash_movements;
            DELETE FROM cash_sessions;
            DELETE FROM customer_debts;
            DELETE FROM store_expenses;
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
        let customer_debts = self.get_all_customer_debts()?;
        let store_expenses = self.get_all_store_expenses()?;
        let cash_sessions = self.get_all_shifts()?;
        let cash_movements = self.get_all_cash_movements()?;

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
            "customerDebts": customer_debts,
            "storeExpenses": store_expenses,
            "cashSessions": cash_sessions,
            "cashMovements": cash_movements,
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
            DELETE FROM cash_movements;
            DELETE FROM cash_sessions;
            DELETE FROM customer_debts;
            DELETE FROM store_expenses;
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
                    payment_method, cash_tendered, change_due, status, created_at, json_payload
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
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
                let status = t["status"].as_str().unwrap_or("COMPLETED");
                let created_at = t["createdAt"].as_str().unwrap_or_default();
                let json_payload = serde_json::to_string(t).unwrap_or_default();

                stmt.execute(params![
                    id, receipt_number, customer_id, subtotal, tax, discount_total,
                    total, cost_total, profit, profit_margin, pricing_tier,
                    payment_method, cash_tendered, change_due, status, created_at, json_payload
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

        // Import purchase orders
        if let Some(pos) = val["purchaseOrders"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO purchase_orders (
                    id, po_number, vendor_name, total_amount, status, created_at, json_payload
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for p in pos {
                let id = p["id"].as_str().unwrap_or_default();
                let po_number = p["poNumber"].as_str().unwrap_or_default();
                let vendor_name = p["vendorName"].as_str().unwrap_or_default();
                let total_amount = p["totalAmount"].as_f64().unwrap_or(0.0);
                let status = p["status"].as_str().unwrap_or("Draft");
                let created_at = p["createdAt"].as_str().unwrap_or_default();
                let json_payload = serde_json::to_string(p).unwrap_or_default();

                stmt.execute(params![id, po_number, vendor_name, total_amount, status, created_at, json_payload])?;
            }
        }

        // Import trade-ins
        if let Some(trades) = val["tradeIns"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO trade_ins (
                    id, device_model, imei, brand, condition_grade, buyback_value,
                    resale_margin_percent, resale_price, customer_name, credit_to_wallet,
                    created_at, json_payload
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )?;
            for t in trades {
                let id = t["id"].as_str().unwrap_or_default();
                let device_model = t["deviceModel"].as_str().unwrap_or_default();
                let imei = t["imei"].as_str().unwrap_or_default();
                let brand = t["brand"].as_str().unwrap_or_default();
                let condition_grade = t["conditionGrade"].as_str().unwrap_or_default();
                let buyback_value = t["buybackValue"].as_f64().unwrap_or(0.0);
                let resale_margin_percent = t["resaleMarginPercent"].as_f64().unwrap_or(0.0);
                let resale_price = t["resalePrice"].as_f64().unwrap_or(0.0);
                let customer_name = t["customerName"].as_str().unwrap_or_default();
                let credit_to_wallet = if t["creditToWallet"].as_bool().unwrap_or(false) { 1 } else { 0 };
                let created_at = t["createdAt"].as_str().unwrap_or_default();
                let json_payload = serde_json::to_string(t).unwrap_or_default();

                stmt.execute(params![
                    id, device_model, imei, brand, condition_grade, buyback_value,
                    resale_margin_percent, resale_price, customer_name, credit_to_wallet,
                    created_at, json_payload
                ])?;
            }
        }

        // Import IMEI records
        if let Some(imeis) = val["imeiRecords"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO imei_records (
                    imei, product_id, purchase_order_id, sale_transaction_id,
                    warranty_expires_at, received_at, sold_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for i in imeis {
                let imei = i["imei"].as_str().unwrap_or_default();
                let product_id = i["productId"].as_str().unwrap_or_default();
                let purchase_order_id = i["purchaseOrderId"].as_str();
                let sale_transaction_id = i["saleTransactionId"].as_str();
                let warranty_expires_at = i["warrantyExpiresAt"].as_str();
                let received_at = i["receivedAt"].as_str().unwrap_or_default();
                let sold_at = i["soldAt"].as_str();

                stmt.execute(params![
                    imei, product_id, purchase_order_id, sale_transaction_id,
                    warranty_expires_at, received_at, sold_at
                ])?;
            }
        }

        // Import audit logs
        if let Some(logs) = val["securityAuditLogs"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO security_audit_logs (id, timestamp, user, action, details, requires_pin) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for l in logs {
                let id = l["id"].as_str().unwrap_or_default();
                let timestamp = l["timestamp"].as_str().unwrap_or_default();
                let user = l["user"].as_str().unwrap_or("System");
                let action = l["action"].as_str().unwrap_or_default();
                let details = l["details"].as_str().unwrap_or_default();
                let requires_pin = if l["requiresPin"].as_bool().unwrap_or(false) { 1 } else { 0 };

                stmt.execute(params![id, timestamp, user, action, details, requires_pin])?;
            }
        }

        // Import cash drops & payouts
        if let Some(drops) = val["cashDrops"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO cash_drops (id, timestamp, amount, reason, user, is_payout) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            )?;
            for d in drops {
                let id = d["id"].as_str().unwrap_or_default();
                let timestamp = d["timestamp"].as_str().unwrap_or_default();
                let amount = d["amount"].as_f64().unwrap_or(0.0);
                let reason = d["reason"].as_str().unwrap_or_default();
                let user = d["user"].as_str().unwrap_or("Admin");
                stmt.execute(params![id, timestamp, amount, reason, user])?;
            }
        }
        if let Some(payouts) = val["payouts"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO cash_drops (id, timestamp, amount, reason, user, is_payout) VALUES (?1, ?2, ?3, ?4, ?5, 1)",
            )?;
            for p in payouts {
                let id = p["id"].as_str().unwrap_or_default();
                let timestamp = p["timestamp"].as_str().unwrap_or_default();
                let amount = p["amount"].as_f64().unwrap_or(0.0);
                let reason = p["reason"].as_str().unwrap_or_default();
                let user = p["user"].as_str().unwrap_or("Admin");
                stmt.execute(params![id, timestamp, amount, reason, user])?;
            }
        }

        // Import bundles
        if let Some(bundles) = val["bundles"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO product_bundles (id, bundle_title, barcode, bundle_price, child_skus_json, json_payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for b in bundles {
                let id = b["id"].as_str().unwrap_or_default();
                let bundle_title = b["bundleTitle"].as_str().unwrap_or_default();
                let barcode = b["barcode"].as_str().unwrap_or_default();
                let bundle_price = b["bundlePrice"].as_f64().unwrap_or(0.0);
                let child_skus_json = serde_json::to_string(&b["childSkus"]).unwrap_or_else(|_| "[]".into());
                let json_payload = serde_json::to_string(b).unwrap_or_default();

                stmt.execute(params![id, bundle_title, barcode, bundle_price, child_skus_json, json_payload])?;
            }
        }

        // Import Customer Debts
        if let Some(debts) = val["customerDebts"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO customer_debts (
                    id, customer_id, customer_name, type, amount, balance_after,
                    receipt_number, payment_method, notes, recorded_by, created_at, json_payload
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )?;
            for d in debts {
                let id = d["id"].as_str().unwrap_or_default();
                let customer_id = d["customerId"].as_str().unwrap_or_default();
                let customer_name = d["customerName"].as_str().unwrap_or_default();
                let movement_type = d["type"].as_str().unwrap_or("DEBT_ACQUIRED");
                let amount = d["amount"].as_f64().unwrap_or(0.0);
                let balance_after = d["balanceAfter"].as_f64().unwrap_or(0.0);
                let receipt_number = d["receiptNumber"].as_str();
                let payment_method = d["paymentMethod"].as_str();
                let notes = d["notes"].as_str();
                let recorded_by = d["recordedBy"].as_str();
                let created_at = d["createdAt"].as_str().unwrap_or_default();
                let json_payload = serde_json::to_string(d).unwrap_or_default();

                stmt.execute(params![
                    id, customer_id, customer_name, movement_type, amount, balance_after,
                    receipt_number, payment_method, notes, recorded_by, created_at, json_payload
                ])?;
            }
        }

        // Import Store Expenses
        if let Some(expenses) = val["storeExpenses"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO store_expenses (
                    id, category, title, amount, payment_method, paid_to, notes,
                    recorded_by, created_at, json_payload
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;
            for e in expenses {
                let id = e["id"].as_str().unwrap_or_default();
                let category = e["category"].as_str().unwrap_or("Autre Charge");
                let title = e["title"].as_str().unwrap_or_default();
                let amount = e["amount"].as_f64().unwrap_or(0.0);
                let payment_method = e["paymentMethod"].as_str().unwrap_or("Espèces");
                let paid_to = e["paidTo"].as_str();
                let notes = e["notes"].as_str();
                let recorded_by = e["recordedBy"].as_str().unwrap_or("Admin");
                let created_at = e["createdAt"].as_str().unwrap_or_default();
                let json_payload = serde_json::to_string(e).unwrap_or_default();

                stmt.execute(params![
                    id, category, title, amount, payment_method, paid_to, notes,
                    recorded_by, created_at, json_payload
                ])?;
            }
        }

        // Import Cash Sessions
        if let Some(sessions) = val["cashSessions"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO cash_sessions (
                    id, opened_at, closed_at, opening_float, expected_cash, actual_cash,
                    status, cashier_name, opening_note, closing_note, discrepancy,
                    json_payload, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )?;
            for s in sessions {
                let id = s["id"].as_str().unwrap_or_default();
                let opened_at = s["openedAt"].as_str().unwrap_or_default();
                let closed_at = s["closedAt"].as_str();
                let opening_float = s["openingFloat"].as_i64().unwrap_or(0);
                let expected_cash = s["expectedCash"].as_i64();
                let actual_cash = s["actualCash"].as_i64();
                let status = s["status"].as_str().unwrap_or("CLOSED");
                let cashier_name = s["cashierName"].as_str();
                let opening_note = s["openingNote"].as_str();
                let closing_note = s["closingNote"].as_str();
                let discrepancy = s["discrepancy"].as_i64();
                let json_payload = serde_json::to_string(s).unwrap_or_default();
                let updated_at = s["updatedAt"].as_str().unwrap_or(opened_at);

                stmt.execute(params![
                    id, opened_at, closed_at, opening_float, expected_cash, actual_cash,
                    status, cashier_name, opening_note, closing_note, discrepancy,
                    json_payload, updated_at
                ])?;
            }
        }

        // Import Cash Movements
        if let Some(movements) = val["cashMovements"].as_array() {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO cash_movements (
                    id, session_id, type, amount, reason, cashier_name, created_at, json_payload
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for m in movements {
                let id = m["id"].as_str().unwrap_or_default();
                let session_id = m["sessionId"].as_str().unwrap_or_default();
                let m_type = m["type"].as_str().unwrap_or("EXPENSE");
                let amount = m["amount"].as_i64().unwrap_or(0);
                let reason = m["reason"].as_str().unwrap_or_default();
                let cashier_name = m["cashierName"].as_str();
                let created_at = m["createdAt"].as_str().unwrap_or_default();
                let json_payload = serde_json::to_string(m).unwrap_or_default();

                stmt.execute(params![
                    id, session_id, m_type, amount, reason, cashier_name, created_at, json_payload
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

    // ── CASH REGISTER SESSIONS & MOVEMENTS (INTEGER PRECISION MATH) ──

    pub fn start_shift(
        &self,
        opening_float: i64,
        cashier_name: Option<&str>,
        opening_note: Option<&str>,
        denominations_json: Option<&str>,
    ) -> Result<Value> {
        let conn = self.conn.lock();

        // If an open shift already exists, return it
        let existing: Option<String> = conn
            .query_row(
                "SELECT json_payload FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;

        if let Some(json_str) = existing {
            if let Ok(v) = serde_json::from_str::<Value>(&json_str) {
                return Ok(v);
            }
        }

        let now = chrono_now_string();
        let session_id = format!("SHIFT-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs());
        let cashier = cashier_name.unwrap_or("Caissier Principal");
        let note = opening_note.unwrap_or("");

        let session_obj = serde_json::json!({
            "id": session_id,
            "openedAt": now,
            "closedAt": Value::Null,
            "openingFloat": opening_float,
            "expectedCash": Value::Null,
            "actualCash": Value::Null,
            "status": "OPEN",
            "cashierName": cashier,
            "openingNote": note,
            "closingNote": Value::Null,
            "discrepancy": 0,
            "denominations": denominations_json.and_then(|d| serde_json::from_str::<Value>(d).ok()).unwrap_or(Value::Null),
            "updatedAt": now
        });

        let json_payload = serde_json::to_string(&session_obj).unwrap_or_default();

        conn.execute(
            "INSERT INTO cash_sessions (
                id, opened_at, closed_at, opening_float, expected_cash,
                actual_cash, status, cashier_name, opening_note, closing_note,
                discrepancy, json_payload, updated_at
            ) VALUES (?1, ?2, NULL, ?3, NULL, NULL, 'OPEN', ?4, ?5, NULL, 0, ?6, ?7)",
            params![
                session_id, now, opening_float, cashier, note, json_payload, now
            ],
        )?;

        Ok(session_obj)
    }

    pub fn log_cash_movement(
        &self,
        session_id_opt: Option<&str>,
        movement_type: &str,
        amount: i64,
        reason: &str,
        cashier_name: Option<&str>,
    ) -> Result<Value> {
        let conn = self.conn.lock();

        let session_id = match session_id_opt {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => {
                conn.query_row(
                    "SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1",
                    [],
                    |r| r.get::<_, String>(0),
                ).map_err(|_| rusqlite::Error::QueryReturnedNoRows)?
            }
        };

        let now = chrono_now_string();
        let mov_id = format!("MOV-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
        let cashier = cashier_name.unwrap_or("Caissier");

        let mov_obj = serde_json::json!({
            "id": mov_id,
            "sessionId": session_id,
            "type": movement_type,
            "amount": amount,
            "reason": reason,
            "cashierName": cashier,
            "createdAt": now
        });

        let json_payload = serde_json::to_string(&mov_obj).unwrap_or_default();

        conn.execute(
            "INSERT INTO cash_movements (
                id, session_id, type, amount, reason, cashier_name, created_at, json_payload
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                mov_id, session_id, movement_type, amount, reason, cashier, now, json_payload
            ],
        )?;

        Ok(mov_obj)
    }

    pub fn get_active_shift(&self) -> Result<Option<Value>> {
        let conn = self.conn.lock();

        let row_opt = conn.query_row(
            "SELECT id, json_payload FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        ).optional()?;

        match row_opt {
            Some((session_id, json_payload)) => {
                let mut session_val: Value = serde_json::from_str(&json_payload).unwrap_or(Value::Null);

                // Fetch movements for this session
                let mut stmt = conn.prepare(
                    "SELECT json_payload FROM cash_movements WHERE session_id = ?1 ORDER BY created_at ASC",
                )?;
                let mov_rows = stmt.query_map(params![session_id], |r| {
                    let s: String = r.get(0)?;
                    Ok(serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
                })?;

                let mut movements = Vec::new();
                for m in mov_rows {
                    if let Ok(v) = m {
                        if !v.is_null() {
                            movements.push(v);
                        }
                    }
                }

                session_val["movements"] = serde_json::json!(movements);
                Ok(Some(session_val))
            }
            None => Ok(None),
        }
    }

    pub fn get_all_shifts(&self) -> Result<Vec<Value>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json_payload FROM cash_sessions ORDER BY opened_at DESC")?;
        let rows = stmt.query_map([], |r| {
            let s: String = r.get(0)?;
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

    pub fn get_shift_details(&self, session_id: &str) -> Result<Value> {
        let conn = self.conn.lock();
        let json_payload: String = conn.query_row(
            "SELECT json_payload FROM cash_sessions WHERE id = ?1",
            params![session_id],
            |r| r.get(0),
        )?;

        let mut session_val: Value = serde_json::from_str(&json_payload).unwrap_or(Value::Null);

        let mut stmt = conn.prepare(
            "SELECT json_payload FROM cash_movements WHERE session_id = ?1 ORDER BY created_at ASC",
        )?;
        let mov_rows = stmt.query_map(params![session_id], |r| {
            let s: String = r.get(0)?;
            Ok(serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
        })?;

        let mut movements = Vec::new();
        for m in mov_rows {
            if let Ok(v) = m {
                if !v.is_null() {
                    movements.push(v);
                }
            }
        }

        session_val["movements"] = serde_json::json!(movements);
        Ok(session_val)
    }

    pub fn close_shift(
        &self,
        session_id_opt: Option<&str>,
        blind_count: i64,
        closing_note: Option<&str>,
        cashier_name: Option<&str>,
    ) -> Result<Value> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        let session_id = match session_id_opt {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => {
                tx.query_row(
                    "SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1",
                    [],
                    |r| r.get::<_, String>(0),
                ).map_err(|_| rusqlite::Error::QueryReturnedNoRows)?
            }
        };

        let (opened_at, opening_float): (String, i64) = tx.query_row(
            "SELECT opened_at, opening_float FROM cash_sessions WHERE id = ?1",
            params![session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        // Sum movements: Deposits vs Expenses (in integer precision)
        let manual_deposits: i64 = tx.query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM cash_movements WHERE session_id = ?1 AND type = 'MANUAL_DEPOSIT'",
            params![session_id],
            |r| r.get(0),
        ).unwrap_or(0);

        let expenses: i64 = tx.query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM cash_movements WHERE session_id = ?1 AND type = 'EXPENSE'",
            params![session_id],
            |r| r.get(0),
        ).unwrap_or(0);

        let (raw_cash_sales, cash_refunds, total_sale_margins) = {
            let mut raw_cash: i64 = 0;
            let mut refunds: i64 = 0;
            let mut margins: i64 = 0;

            let mut stmt = tx.prepare(
                "SELECT json_payload, total, profit, payment_method FROM transactions WHERE created_at >= ?1",
            )?;

            let rows = stmt.query_map(params![opened_at], |r| {
                let json_str: String = r.get(0)?;
                let total_val: f64 = r.get(1)?;
                let profit_val: f64 = r.get(2)?;
                let payment_method: String = r.get(3)?;
                Ok((json_str, total_val, profit_val, payment_method))
            })?;

            for row in rows {
                if let Ok((json_str, total_val, profit_val, payment_method)) = row {
                    let parsed: Value = serde_json::from_str(&json_str).unwrap_or(serde_json::Value::Null);

                    // Exclude voided transactions
                    let status = parsed.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    if status == "VOIDED" {
                        continue;
                    }

                    let is_refund = parsed.get("isRefund").and_then(|v| v.as_bool()).unwrap_or(false);

                    if is_refund {
                        // Determine how much physical cash was returned to customer
                        let mut cash_refund_amount: i64 = 0;
                        let refund_method = parsed
                            .get("refundMethod")
                            .and_then(|v| v.as_str())
                            .unwrap_or(payment_method.as_str());
                        if refund_method == "Espèces" {
                            cash_refund_amount = total_val.round() as i64;
                        }
                        refunds += cash_refund_amount;
                    } else {
                        // Regular Sale — inspect split tenders if present
                        let mut cash_collected: i64 = 0;

                        if let Some(tenders) = parsed.get("tenders").and_then(|v| v.as_array()) {
                            for tender in tenders {
                                let method = tender.get("method").and_then(|v| v.as_str()).unwrap_or("");
                                if method == "Espèces" {
                                    let amt = tender.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
                                    cash_collected += amt.round() as i64;
                                }
                            }
                        } else if payment_method == "Espèces" {
                            cash_collected = total_val.round() as i64;
                        }

                        raw_cash += cash_collected;
                        margins += profit_val.round() as i64;
                    }
                }
            }
            (raw_cash, refunds, margins)
        };

        let cash_sales = raw_cash_sales - cash_refunds;

        // Automated Expected Cash Formula: opening_float + cash_sales + manual_deposits - expenses
        let expected_cash = opening_float + cash_sales + manual_deposits - expenses;
        let actual_cash = blind_count;
        let discrepancy = actual_cash - expected_cash;
        let daily_net_profit = total_sale_margins - expenses;
        let now = chrono_now_string();
        let cashier = cashier_name.unwrap_or("Caissier Principal");
        let note = closing_note.unwrap_or("");

        let session_obj = serde_json::json!({
            "id": session_id,
            "openedAt": opened_at,
            "closedAt": now,
            "openingFloat": opening_float,
            "cashSales": cash_sales,
            "manualDeposits": manual_deposits,
            "expenses": expenses,
            "expectedCash": expected_cash,
            "actualCash": actual_cash,
            "discrepancy": discrepancy,
            "dailyNetProfit": daily_net_profit,
            "status": "CLOSED",
            "cashierName": cashier,
            "closingNote": note,
            "updatedAt": now
        });

        let json_payload = serde_json::to_string(&session_obj).unwrap_or_default();

        tx.execute(
            "UPDATE cash_sessions SET
                closed_at = ?1,
                expected_cash = ?2,
                actual_cash = ?3,
                discrepancy = ?4,
                status = 'CLOSED',
                closing_note = ?5,
                json_payload = ?6,
                updated_at = ?7
            WHERE id = ?8",
            params![
                now, expected_cash, actual_cash, discrepancy, note, json_payload, now, session_id
            ],
        )?;

        tx.commit()?;
        Ok(session_obj)
    }

    pub fn get_inventory_valuation(&self) -> Result<Value> {
        let conn = self.conn.lock();

        let row = conn.query_row(
            "SELECT total_skus, total_units, total_cost_value, total_retail_value, potential_profit_margin FROM v_inventory_valuation",
            [],
            |r| {
                Ok(serde_json::json!({
                    "totalSkus": r.get::<_, i64>(0)?,
                    "totalUnits": r.get::<_, i64>(1)?,
                    "totalCostValue": r.get::<_, i64>(2)?,
                    "totalRetailValue": r.get::<_, i64>(3)?,
                    "potentialProfitMargin": r.get::<_, i64>(4)?,
                }))
            },
        ).unwrap_or_else(|_| serde_json::json!({
            "totalSkus": 0,
            "totalUnits": 0,
            "totalCostValue": 0,
            "totalRetailValue": 0,
            "potentialProfitMargin": 0,
        }));

        Ok(row)
    }

    pub fn generate_session_backup_json(&self, session_id: &str) -> Result<String> {
        let shift_details = self.get_shift_details(session_id)?;
        let inventory_valuation = self.get_inventory_valuation()?;
        let integrity_report = self.run_integrity_check()?;

        let backup = serde_json::json!({
            "backupType": "CASH_SESSION_Z_REPORT_BACKUP",
            "generatedAt": chrono_now_string(),
            "session": shift_details,
            "inventoryValuationSnapshot": inventory_valuation,
            "dbIntegrity": integrity_report
        });

        serde_json::to_string_pretty(&backup).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
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
    let millis = duration.subsec_millis();

    let days = secs / 86400;
    let day_secs = secs % 86400;
    let hours = day_secs / 3600;
    let mins = (day_secs % 3600) / 60;
    let s = day_secs % 60;

    // Howard Hinnant's algorithm for Gregorian day-to-date conversion
    let z = days as i64 + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, m, d, hours, mins, s, millis)
}

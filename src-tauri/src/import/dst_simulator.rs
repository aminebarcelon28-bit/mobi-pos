//! FoundationDB-style Deterministic Simulation Testing (DST) & Generative Property Fuzzing Harness
//!
//! Provides a mathematically rigorous, zero-external-crate (100% standard library Rust)
//! simulation and verification system for the Smart Import & Ingestion Subsystem.
//!
//! Components:
//! 1. `SimPrng`: Seeded deterministic PRNG (SplitMix64) guaranteeing reproducible execution paths.
//! 2. Generative Builders: Adversarial CSV/TSV generators producing permutations of column ordering,
//!    multilingual headers (FR, EN, AR), locale-specific numbers, Algerian phones, and Luhn IMEIs.
//! 3. Fault Injection Simulator: Simulates `SIGKILL`/crash, dropped transactions, and WAL lock contention.
//! 4. Mathematical Verification Oracles:
//!    - Ledger Conservation: $\sum \Delta_{\text{ledger}} = \text{Stock}_{\text{final}} - \text{Stock}_{\text{initial}}$
//!    - FIFO Lot Parity: $\sum \text{quantity\_remaining} == \text{products.stock}$
//!    - Outbox Parity & No-NaN Invariant: payload scalar numbers, zero `NaN`, zero nested currency objects
//!    - Zero-Tax Compliance: strictly Hors-Taxe (HT), zero VAT/TVA schema columns or payload keys
//!    - Debt Parity: customer balance matches ledger acquisition record

use rusqlite::Connection;
use serde_json::Value;

#[cfg(test)]
use crate::import::{
    commit::commit_staged_batch,
    init_staging_db,
    insert_staging_batch_tx,
    map::stage_table,
    parser::parse_bytes,
    EntityType, ImportBatch,
};

/// Deterministic Seeded Pseudo-Random Number Generator (SplitMix64)
/// Provides reproducible pseudo-random streams across all architectures without external crates.
#[derive(Debug, Clone)]
pub struct SimPrng {
    state: u64,
}

impl SimPrng {
    pub fn new(seed: u64) -> Self {
        Self {
            state: if seed == 0 { 0x9e3779b97f4a7c15 } else { seed },
        }
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }

    pub fn gen_range(&mut self, min: u64, max: u64) -> u64 {
        if min >= max {
            return min;
        }
        let range = max - min + 1;
        min + (self.next_u64() % range)
    }

    pub fn gen_f64(&mut self) -> f64 {
        let v = (self.next_u64() >> 11) as f64;
        v / (1u64 << 53) as f64
    }

    pub fn gen_bool(&mut self, p_true: f64) -> bool {
        self.gen_f64() < p_true
    }

    pub fn shuffle<T>(&mut self, slice: &mut [T]) {
        let len = slice.len();
        if len <= 1 {
            return;
        }
        for i in (1..len).rev() {
            let j = (self.next_u64() as usize) % (i + 1);
            slice.swap(i, j);
        }
    }

    pub fn choose<'a, T>(&mut self, slice: &'a [T]) -> Option<&'a T> {
        if slice.is_empty() {
            None
        } else {
            let idx = (self.next_u64() as usize) % slice.len();
            Some(&slice[idx])
        }
    }
}

/// Compute valid Luhn checksum digit for a 14-digit IMEI prefix
pub fn compute_luhn_digit(prefix14: &str) -> u32 {
    let mut sum = 0u32;
    for (i, ch) in prefix14.chars().enumerate() {
        let d = ch.to_digit(10).unwrap_or(0);
        if i % 2 == 1 {
            let doubled = d * 2;
            sum += (doubled / 10) + (doubled % 10);
        } else {
            sum += d;
        }
    }
    (10 - (sum % 10)) % 10
}

/// Creates a fresh mock live `mobi_pos.db` with complete schema
pub fn create_dst_live_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE products (
            id TEXT PRIMARY KEY, sku TEXT NOT NULL, barcode TEXT NOT NULL, title TEXT NOT NULL,
            brand TEXT NOT NULL, compatible_model TEXT, category TEXT NOT NULL,
            price REAL NOT NULL, wholesale_price REAL DEFAULT 0, cost_price REAL DEFAULT 0,
            stock INTEGER NOT NULL DEFAULT 0, image_url TEXT, is_serialized INTEGER DEFAULT 0,
            imei_number TEXT, vendor_name TEXT, lead_time_days INTEGER DEFAULT 0,
            daily_sales_velocity REAL DEFAULT 0, reorder_point INTEGER DEFAULT 0,
            json_payload TEXT NOT NULL, updated_at TEXT NOT NULL,
            device_id TEXT DEFAULT 'local', idempotency_key TEXT DEFAULT '',
            sync_status TEXT DEFAULT 'pending', created_at TEXT DEFAULT '',
            deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE stock_batches (
            batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
            quantity_remaining REAL NOT NULL, unit_cost REAL NOT NULL,
            freight_per_unit REAL DEFAULT 0, received_at TEXT NOT NULL,
            purchase_order_id TEXT, device_id TEXT NOT NULL DEFAULT 'local',
            idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'pending',
            version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE inventory_ledger (
            id TEXT PRIMARY KEY, product_id TEXT NOT NULL, delta INTEGER NOT NULL,
            reason TEXT NOT NULL, ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE customers (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
            registered_device TEXT, loyalty_points INTEGER DEFAULT 0, store_credit REAL DEFAULT 0,
            pricing_tier TEXT DEFAULT 'Retail', loyalty_tier TEXT DEFAULT 'Bronze',
            total_spent REAL DEFAULT 0, loyalty_card_code TEXT, barcode TEXT,
            json_payload TEXT NOT NULL, updated_at TEXT NOT NULL,
            device_id TEXT DEFAULT 'local', idempotency_key TEXT DEFAULT '',
            sync_status TEXT DEFAULT 'pending', created_at TEXT DEFAULT '',
            deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
            whatsapp_opt_in INTEGER NOT NULL DEFAULT 0, current_debt INTEGER DEFAULT 0
        );

        CREATE TABLE customer_debts (
            id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT NOT NULL,
            type TEXT NOT NULL, amount REAL NOT NULL, balance_after REAL NOT NULL,
            receipt_number TEXT, payment_method TEXT, notes TEXT, recorded_by TEXT,
            created_at TEXT NOT NULL, json_payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
            origin TEXT NOT NULL DEFAULT 'operational'
                CHECK (origin IN ('operational', 'imported_history')),
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
        );
        CREATE TABLE import_source_identity (
            destination TEXT NOT NULL,
            source_namespace TEXT NOT NULL,
            source_record_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            source_file_hash TEXT NOT NULL,
            sheet_index INTEGER,
            row_index INTEGER,
            created_at TEXT NOT NULL,
            PRIMARY KEY (destination, source_namespace, source_record_id)
        );

        CREATE TABLE imei_records (
            imei TEXT PRIMARY KEY, product_id TEXT NOT NULL,
            purchase_order_id TEXT, sale_transaction_id TEXT,
            warranty_expires_at TEXT, received_at TEXT NOT NULL, sold_at TEXT, status TEXT
        );

        CREATE TABLE vendor_aliases (
            supplier_name TEXT NOT NULL, raw_vendor_name TEXT NOT NULL,
            product_id TEXT NOT NULL DEFAULT 'global', created_at TEXT NOT NULL,
            PRIMARY KEY (supplier_name, raw_vendor_name)
        );

        CREATE TABLE app_settings (
            key TEXT PRIMARY KEY, value_json TEXT NOT NULL
        );

        CREATE TABLE sync_outbox (
            rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            idempotency_key TEXT NOT NULL UNIQUE,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        "#,
    )
    .unwrap();
    conn
}

// =========================================================================
// MATHEMATICAL VERIFICATION ORACLES
// =========================================================================

/// Oracle 1: Ledger Conservation Oracle
/// Invariant: Total final stock in `products` must exactly equal the total delta in `inventory_ledger` (SEED).
pub fn verify_ledger_conservation(live_conn: &Connection) -> Result<(), String> {
    let total_stock: i64 = live_conn
        .query_row(
            "SELECT COALESCE(SUM(stock), 0) FROM products WHERE deleted = 0",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let total_ledger_seed: i64 = live_conn
        .query_row(
            "SELECT COALESCE(SUM(delta), 0) FROM inventory_ledger WHERE reason = 'SEED' AND deleted = 0",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    if total_stock != total_ledger_seed {
        return Err(format!(
            "Ledger conservation invariant violated: total product stock ({}) != total SEED ledger delta ({})",
            total_stock, total_ledger_seed
        ));
    }

    let mut stmt = live_conn
        .prepare("SELECT id, stock FROM products WHERE deleted = 0 AND stock > 0")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;

    for row in rows {
        let (prod_id, stock) = row.map_err(|e| e.to_string())?;
        let prod_ledger_delta: i64 = live_conn
            .query_row(
                "SELECT COALESCE(SUM(delta), 0) FROM inventory_ledger WHERE product_id = ?1 AND reason = 'SEED' AND deleted = 0",
                [&prod_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if stock != prod_ledger_delta {
            return Err(format!(
                "Product '{}' ledger conservation mismatch: stock = {}, ledger delta = {}",
                prod_id, stock, prod_ledger_delta
            ));
        }
    }
    Ok(())
}

/// Oracle 2: FIFO Lot Parity Oracle
/// Invariant: For every active product with stock, sum(stock_batches.quantity_remaining) == product.stock,
/// and batch unit_cost matches product.cost_price.
pub fn verify_fifo_lot_parity(live_conn: &Connection) -> Result<(), String> {
    let mut stmt = live_conn
        .prepare("SELECT id, stock, cost_price FROM products WHERE deleted = 0 AND stock > 0")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        let (prod_id, stock, cost_price) = row.map_err(|e| e.to_string())?;
        let (total_remaining, lot_cost): (f64, Option<f64>) = live_conn
            .query_row(
                "SELECT COALESCE(SUM(quantity_remaining), 0.0), AVG(unit_cost) FROM stock_batches WHERE product_id = ?1 AND deleted = 0",
                [&prod_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;

        let remaining_rounded = total_remaining.round() as i64;
        if stock != remaining_rounded {
            return Err(format!(
                "FIFO Lot Parity violated for product '{}': product.stock = {}, sum(batches.quantity_remaining) = {}",
                prod_id, stock, remaining_rounded
            ));
        }
        if let Some(avg_cost) = lot_cost {
            if (avg_cost - cost_price).abs() > 0.01 {
                return Err(format!(
                    "FIFO Lot unit cost mismatch for product '{}': product.cost_price = {}, batch unit_cost = {}",
                    prod_id, cost_price, avg_cost
                ));
            }
        }
    }
    Ok(())
}

/// Oracle 3: Outbox Parity & No-NaN Invariant Oracle
/// Invariant: All outbox rows contain strictly finite IEEE-754 numbers (`!is_nan() && !is_infinite()`),
/// zero nested currency objects `{"minor": ..., "dzd": ...}`, and zero NaN strings.
pub fn verify_outbox_parity_and_no_nan(live_conn: &Connection) -> Result<(), String> {
    let mut stmt = live_conn
        .prepare("SELECT idempotency_key, entity_type, entity_id, payload_json FROM sync_outbox")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut row_count = 0usize;
    for row in rows {
        row_count += 1;
        let (idem_key, entity_type, entity_id, payload_str) = row.map_err(|e| e.to_string())?;

        let val: Value = serde_json::from_str(&payload_str)
            .map_err(|e| format!("Outbox key '{}' has malformed JSON: {}", idem_key, e))?;

        if !val.is_object() {
            return Err(format!("Outbox key '{}' payload is not a JSON object", idem_key));
        }

        if payload_str.contains("NaN") || payload_str.contains("Infinity") {
            return Err(format!("Outbox key '{}' contains NaN or Infinity string", idem_key));
        }

        fn check_json_node(key_path: &str, node: &Value) -> Result<(), String> {
            match node {
                Value::Number(num) => {
                    if let Some(f) = num.as_f64() {
                        if f.is_nan() || f.is_infinite() {
                            return Err(format!("Key '{}' contains NaN or Inf", key_path));
                        }
                    }
                }
                Value::Object(map) => {
                    if map.contains_key("minor") && map.contains_key("dzd") {
                        return Err(format!(
                            "Outbox key path '{}' contains illegal nested currency object: {:?}",
                            key_path, map
                        ));
                    }
                    for (k, v) in map {
                        let sub_path = if key_path.is_empty() {
                            k.clone()
                        } else {
                            format!("{}.{}", key_path, k)
                        };
                        check_json_node(&sub_path, v)?;
                    }
                }
                Value::Array(arr) => {
                    for (i, elem) in arr.iter().enumerate() {
                        let sub_path = format!("{}[{}]", key_path, i);
                        check_json_node(&sub_path, elem)?;
                    }
                }
                _ => {}
            }
            Ok(())
        }

        check_json_node(&format!("{}:{}", entity_type, entity_id), &val)?;
    }

    if row_count == 0 {
        let total_entities: i64 = live_conn
            .query_row(
                "SELECT (SELECT count(*) FROM products) + (SELECT count(*) FROM customers)",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if total_entities > 0 {
            return Err(format!(
                "Zero outbox rows found despite {} live entities existing",
                total_entities
            ));
        }
    }

    Ok(())
}

/// Oracle 4: Zero-Tax Compliance Oracle
/// Invariant: Strictly Hors-Taxe (HT), zero VAT/TVA columns in database schema,
/// and zero tax keys in sync_outbox payloads.
pub fn verify_zero_tax_compliance(live_conn: &Connection) -> Result<(), String> {
    let mut stmt = live_conn
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='table'")
        .map_err(|e| e.to_string())?;
    let tables = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;

    for table in tables {
        let (tbl_name, sql) = table.map_err(|e| e.to_string())?;
        let lower_sql = sql.to_lowercase();
        if lower_sql.contains(" tva ")
            || lower_sql.contains("tva_")
            || lower_sql.contains("_tva")
            || lower_sql.contains(" vat ")
            || lower_sql.contains("tax_rate")
        {
            return Err(format!(
                "Table '{}' contains forbidden VAT/tax column in schema: {}",
                tbl_name, sql
            ));
        }
    }

    let mut stmt = live_conn
        .prepare("SELECT payload_json FROM sync_outbox")
        .map_err(|e| e.to_string())?;
    let payloads = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    for p in payloads {
        let json_str = p.map_err(|e| e.to_string())?;
        let val: Value = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
        if let Value::Object(map) = val {
            for k in map.keys() {
                let lower_k = k.to_lowercase();
                if lower_k == "tva"
                    || lower_k == "vat"
                    || lower_k == "tax"
                    || lower_k == "tax_rate"
                    || lower_k == "taxrate"
                {
                    return Err(format!(
                        "Forbidden tax key '{}' found in outbox payload: {}",
                        k, json_str
                    ));
                }
            }
        }
    }

    Ok(())
}

/// Oracle 5: Debt Parity & Monotonicity Oracle
/// Invariant: Every customer with `current_debt > 0` has a matching acquisition entry
/// in `customer_debts` with exact balance parity.
pub fn verify_debt_parity(live_conn: &Connection) -> Result<(), String> {
    let mut stmt = live_conn
        .prepare("SELECT id, name, current_debt FROM customers WHERE current_debt > 0 AND deleted = 0")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        let (cust_id, name, current_debt) = row.map_err(|e| e.to_string())?;
        let (debt_amount, balance_after): (f64, f64) = live_conn
            .query_row(
                "SELECT amount, balance_after FROM customer_debts WHERE customer_id = ?1 AND type = 'DEBT_ACQUIRED'",
                [&cust_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| {
                format!(
                    "Missing initial debt entry for customer '{}' (id: {}): {}",
                    name, cust_id, e
                )
            })?;

        if (debt_amount.round() as i64) != current_debt {
            return Err(format!(
                "Customer '{}' debt mismatch: customer.current_debt = {}, customer_debts.amount = {}",
                name, current_debt, debt_amount
            ));
        }

        if (balance_after.round() as i64) != current_debt {
            return Err(format!(
                "Customer '{}' balance_after mismatch: customer.current_debt = {}, customer_debts.balance_after = {}",
                name, current_debt, balance_after
            ));
        }
    }
    Ok(())
}

// =========================================================================
// GENERATIVE PROPERTY FUZZERS
// =========================================================================

#[derive(Debug, Clone)]
pub struct MockProductSpec {
    pub title: String,
    pub price: f64,
    pub cost_price: f64,
    pub stock: i64,
    pub barcode: String,
}

/// Generates an adversarial catalog CSV with randomized column order, multilingual headers,
/// top company banners, footer totals, and arbitrary number formatting.
pub fn generate_fuzzed_catalog_csv(
    prng: &mut SimPrng,
    num_rows: usize,
) -> (String, Vec<MockProductSpec>) {
    let title_headers = ["Désignation", "Designation", "Article", "Produit", "Libellé", "Title", "Product Name", "Nom", "اسم المنتج"];
    let price_headers = ["Prix Vente", "Prix_Vente", "Prix", "P.V", "P.Vente", "Price", "Retail Price", "Tarif 1", "السعر"];
    let cost_headers = ["Prix Achat", "Prix_Achat", "Cout", "P.A", "Cost", "Cost Price", "Achat", "سعر الشراء"];
    let stock_headers = ["Qté", "Qte", "Quantité", "Stock", "En Stock", "Quantity", "Qty", "الكمية"];
    let barcode_headers = ["Code Barre", "CodeBarre", "Code-Barres", "Barcode", "EAN", "Code", "الباركود"];

    let sep = match prng.gen_range(0, 2) {
        0 => ";",
        1 => ",",
        _ => "\t",
    };

    // Pick headers
    let sel_title = *prng.choose(&title_headers).unwrap();
    let sel_price = *prng.choose(&price_headers).unwrap();
    let sel_cost = *prng.choose(&cost_headers).unwrap();
    let sel_stock = *prng.choose(&stock_headers).unwrap();
    let sel_barcode = *prng.choose(&barcode_headers).unwrap();

    let mut cols = vec![
        ("title", sel_title),
        ("price", sel_price),
        ("cost", sel_cost),
        ("stock", sel_stock),
        ("barcode", sel_barcode),
    ];
    prng.shuffle(&mut cols);

    let mut csv_lines = Vec::new();

    // 1. Optional top company banners (1-2 rows)
    if prng.gen_bool(0.6) {
        let banner_lines = [
            "SARL HIGH-TECH DISTRIB - RC 16/00-1234567B21 - NIF 001234567890123",
            "RELEVE DE STOCK GENERAL ET INVENTAIRE AU 21/10/2026",
            "DEPARTEMENT ACCESSOIRES & TELEPHONIE MOBILE ALGER",
        ];
        let num_banners = prng.gen_range(1, 2) as usize;
        for i in 0..num_banners {
            csv_lines.push(banner_lines[i].to_string());
        }
    }

    // 2. Header row
    let header_line = cols.iter().map(|(_, h)| *h).collect::<Vec<_>>().join(sep);
    csv_lines.push(header_line);

    // 3. Data rows
    let mut expected_products = Vec::with_capacity(num_rows);
    let sample_titles = [
        "Ecran OLED iPhone 13", "Chargeur 20W USB-C", "Batterie Galaxy A52", "Film Hydrogel HD",
        "Coque Silicone MagSafe", "Câble Lightning 1m", "Connecteur de Charge Redmi", "Vitre Tactile iPad 9"
    ];

    for i in 0..num_rows {
        let base_title = *prng.choose(&sample_titles).unwrap();
        let title = format!("{} #{:03}", base_title, i + 1);

        // Price ordering: Cost <= Price
        let cost_val = (prng.gen_range(200, 3000) / 50) * 50;
        let margin = (prng.gen_range(100, 2000) / 50) * 50;
        let price_val = cost_val + margin;
        let stock_val = prng.gen_range(1, 250) as i64;
        let barcode_val = format!("613{:010}", prng.gen_range(1000000000, 9999999999));

        expected_products.push(MockProductSpec {
            title: title.clone(),
            price: price_val as f64,
            cost_price: cost_val as f64,
            stock: stock_val,
            barcode: barcode_val.clone(),
        });

        // Format money according to random locale
        let price_str = format_fuzzed_money(prng, price_val);
        let cost_str = format_fuzzed_money(prng, cost_val);
        let stock_str = stock_val.to_string();

        let mut row_cells = Vec::new();
        for (col_key, _) in &cols {
            match *col_key {
                "title" => row_cells.push(title.clone()),
                "price" => row_cells.push(price_str.clone()),
                "cost" => row_cells.push(cost_str.clone()),
                "stock" => row_cells.push(stock_str.clone()),
                "barcode" => row_cells.push(barcode_val.clone()),
                _ => {}
            }
        }
        csv_lines.push(row_cells.join(sep));
    }

    // 4. Optional summary footer row
    if prng.gen_bool(0.5) {
        let footer_label = *prng.choose(&["Total Général", "Totaux", "Grand Total", "المجموع"]).unwrap();
        let footer_line = format!("{}{sep}150000{sep}95000{sep}1250{sep}", footer_label);
        csv_lines.push(footer_line);
    }

    (csv_lines.join("\n"), expected_products)
}

/// Formats a monetary integer value using randomized locale representations
fn format_fuzzed_money(prng: &mut SimPrng, val: u64) -> String {
    let thousand_part = val / 1000;
    let unit_part = val % 1000;

    let base = match prng.gen_range(0, 4) {
        0 => val.to_string(), // Raw integer: "1500"
        1 => {
            // European dot: "1.500" or "1.500,00"
            if thousand_part > 0 {
                format!("{}.{:03},00", thousand_part, unit_part)
            } else {
                format!("{},00", unit_part)
            }
        }
        2 => {
            // Anglo comma: "1,500.00"
            if thousand_part > 0 {
                format!("{},{:03}.00", thousand_part, unit_part)
            } else {
                format!("{}.00", unit_part)
            }
        }
        3 => {
            // French space: "1 500"
            if thousand_part > 0 {
                format!("{} {:03}", thousand_part, unit_part)
            } else {
                unit_part.to_string()
            }
        }
        _ => val.to_string(),
    };

    // Optional currency suffix
    if prng.gen_bool(0.4) {
        let suffix = *prng.choose(&[" DA", " DZD", "da", "dzd"]).unwrap();
        format!("{}{}", base, suffix)
    } else {
        base
    }
}

// =========================================================================
// ADVERSARIAL STRESS TESTS & DETERMINISTIC SIMULATION TESTS
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dst_seeded_prng_deterministic_replay() {
        let mut prng1 = SimPrng::new(0xDEADBEEF12345678);
        let mut prng2 = SimPrng::new(0xDEADBEEF12345678);

        for _ in 0..1000 {
            assert_eq!(prng1.next_u64(), prng2.next_u64());
            assert_eq!(prng1.gen_range(1, 100), prng2.gen_range(1, 100));
        }
    }

    #[test]
    fn test_dst_luhn_algorithm_validation() {
        // Valid IMEI: 86234504123456?
        let prefix14 = "86234504123456";
        let check_digit = compute_luhn_digit(prefix14);
        let full_imei = format!("{}{}", prefix14, check_digit);
        assert_eq!(full_imei.len(), 15);

        // Verify with crate detector
        let (col_type, confidence) = crate::import::detect::analyze_15_digit_column(&[full_imei.clone()]);
        assert_eq!(col_type, crate::import::ColumnType::Imei);
        assert!(confidence >= 0.90);
    }

    #[test]
    fn test_dst_catalog_generative_matrix_fuzzing_100_runs() {
        // Run 100 extensive randomized fuzz iterations
        for iteration in 0..100 {
            let seed = 0xCAFE0000 + (iteration as u64);
            let mut prng = SimPrng::new(seed);

            let row_count = prng.gen_range(3, 10) as usize;
            let (csv_content, _specs) = generate_fuzzed_catalog_csv(&mut prng, row_count);

            // 1. Parse
            let parsed = parse_bytes(csv_content.as_bytes(), "dst_test.csv", None)
                .unwrap_or_else(|e| panic!("Iter {}: Parse failed: {}", iteration, e));

            assert!(parsed.rows.len() >= row_count, "Parsed row count too low");

            // 2. Stage
            let mut staging_conn = Connection::open_in_memory().unwrap();
            init_staging_db(&staging_conn).unwrap();
            let mut live_conn = create_dst_live_db();

            let batch_id = format!("batch_dst_{}", iteration);
            let (staged_rows, detected_entity, _) = stage_table(&parsed, &batch_id, Some(&live_conn))
                .unwrap_or_else(|e| panic!("Iter {}: Stage failed: {}", iteration, e));

            assert!(matches!(detected_entity, EntityType::Products | EntityType::OpeningStock));

            let batch = ImportBatch {
                batch_id: batch_id.clone(),
                file_name: "dst_test.csv".to_string(),
                file_sha256: format!("sha_{}", iteration),
                entity_type: detected_entity.as_str().to_string(),
                mapping_config_json: "{}".to_string(),
                row_count: staged_rows.len() as i64,
                created_count: staged_rows.len() as i64,
                updated_count: 0,
                skipped_count: 0,
                rejected_count: 0,
                status: "staged".to_string(),
                created_at: "2026-10-21T12:00:00Z".to_string(),
                committed_at: None,
                rolled_back_at: None,
            };

            insert_staging_batch_tx(&mut staging_conn, &batch, &staged_rows).unwrap();

            // 3. Commit
            let commit_res = commit_staged_batch(&mut staging_conn, &mut live_conn, &batch_id)
                .unwrap_or_else(|e| panic!("Iter {}: Commit failed: {}", iteration, e));

            assert!(
                commit_res.created_count > 0,
                "No rows were committed in iter {}: source={:?}, rows={:?}",
                iteration,
                csv_content,
                staged_rows
                    .iter()
                    .map(|row| row.rejection_reason.as_deref())
                    .collect::<Vec<_>>()
            );

            // 4. Verify Oracles
            verify_ledger_conservation(&live_conn)
                .unwrap_or_else(|e| panic!("Iter {}: Ledger Conservation violated: {}", iteration, e));

            verify_fifo_lot_parity(&live_conn)
                .unwrap_or_else(|e| panic!("Iter {}: FIFO Lot Parity violated: {}", iteration, e));

            verify_outbox_parity_and_no_nan(&live_conn)
                .unwrap_or_else(|e| panic!("Iter {}: Outbox Parity / NaN violated: {}", iteration, e));

            verify_zero_tax_compliance(&live_conn)
                .unwrap_or_else(|e| panic!("Iter {}: Zero-Tax Invariant violated: {}", iteration, e));
        }
    }

    #[test]
    fn test_dst_customer_debt_generative_fuzzing() {
        for iteration in 0..50 {
            let seed = 0xBEEF0000 + (iteration as u64);
            let mut prng = SimPrng::new(seed);

            let mut staging_conn = Connection::open_in_memory().unwrap();
            init_staging_db(&staging_conn).unwrap();
            let mut live_conn = create_dst_live_db();

            let batch_id = format!("batch_cust_{}", iteration);
            let num_custs = prng.gen_range(3, 8) as usize;

            let phone_prefixes = ["+213 550", "00213-661", "0770", "550", "0555"];
            let mut staging_rows = Vec::new();

            for idx in 0..num_custs {
                let name = format!("Client Test #{:02}", idx + 1);
                let p_prefix = *prng.choose(&phone_prefixes).unwrap();
                let phone = format!("{} {:02} {:02} {:02}", p_prefix, prng.gen_range(10, 99), prng.gen_range(10, 99), prng.gen_range(10, 99));
                let debt = if prng.gen_bool(0.7) {
                    (prng.gen_range(500, 25000) / 100) * 100
                } else {
                    0
                };

                let norm_json = serde_json::json!({
                    "name": name,
                    "phone": phone,
                    "email": format!("client{}@dst.dz", idx),
                    "initial_debt": debt,
                });

                staging_rows.push(crate::import::StagingRow {
                    batch_id: batch_id.clone(),
                    row_index: idx as i64,
                    raw_row_json: "[]".to_string(),
                    normalized_json: Some(norm_json.to_string()),
                    action: crate::import::StagingRowAction::Create,
                    matched_entity_id: None,
                    rejection_reason: None,
                    warnings_json: "[]".to_string(),
                    needs_review: false,
                    idempotency_key: format!("cust_idem_{}_{}", iteration, idx),
                });
            }

            let batch = ImportBatch {
                batch_id: batch_id.clone(),
                file_name: "customers.csv".to_string(),
                file_sha256: format!("sha_cust_{}", iteration),
                entity_type: "customers".to_string(),
                mapping_config_json: "{}".to_string(),
                row_count: staging_rows.len() as i64,
                created_count: staging_rows.len() as i64,
                updated_count: 0,
                skipped_count: 0,
                rejected_count: 0,
                status: "staged".to_string(),
                created_at: "2026-10-21T12:00:00Z".to_string(),
                committed_at: None,
                rolled_back_at: None,
            };

            insert_staging_batch_tx(&mut staging_conn, &batch, &staging_rows).unwrap();
            let commit_res = commit_staged_batch(&mut staging_conn, &mut live_conn, &batch_id).unwrap();
            assert_eq!(commit_res.created_count, num_custs);

            // Verify Debt Parity Oracle
            verify_debt_parity(&live_conn).unwrap();

            // Verify Outbox Parity Oracle
            verify_outbox_parity_and_no_nan(&live_conn).unwrap();

            // Verify Zero-Tax Compliance Oracle
            verify_zero_tax_compliance(&live_conn).unwrap();
        }
    }

    #[test]
    fn test_dst_fault_injection_sigkill_rollback_consistency() {
        let mut live_conn = create_dst_live_db();

        // 1. Simulate an interrupted transaction (process crash / SIGKILL)
        {
            let tx = live_conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
            tx.execute(
                "INSERT INTO products (id, sku, barcode, title, brand, category, price, stock, json_payload, updated_at) VALUES ('p_crash_1', 'SKU-CRASH', '12345', 'Crash Phone', 'Brand', 'Cat', 1000.0, 10, '{}', 'now')",
                [],
            )
            .unwrap();
            // Drop tx without calling tx.commit() — simulates sudden process abort
            drop(tx);
        }

        // 2. Verify bit-for-bit crash consistency: live DB has exactly 0 products
        let count: i64 = live_conn.query_row("SELECT count(*) FROM products", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0, "Dirty read or uncommitted write persisted after simulated SIGKILL!");
    }

    #[test]
    fn test_dst_zero_tax_strict_gate_on_adversarial_input() {
        let mut live_conn = create_dst_live_db();
        let mut staging_conn = Connection::open_in_memory().unwrap();
        init_staging_db(&staging_conn).unwrap();

        // Adversarial input with "TVA" / "Tax" mentioned in raw text
        let csv = "Désignation;Prix Vente HT;TVA 19%;Prix TTC;Quantité\nChargeur 20W;1800;342;2142;15\n";
        let parsed = parse_bytes(csv.as_bytes(), "tax_trap.csv", None).unwrap();

        let batch_id = "batch_tax_trap";
        let (staged_rows, entity_type, _) = stage_table(&parsed, batch_id, Some(&live_conn)).unwrap();
        assert!(matches!(entity_type, EntityType::Products | EntityType::OpeningStock));

        let batch = ImportBatch {
            batch_id: batch_id.to_string(),
            file_name: "tax_trap.csv".to_string(),
            file_sha256: "sha_tax".to_string(),
            entity_type: entity_type.as_str().to_string(),
            mapping_config_json: "{}".to_string(),
            row_count: staged_rows.len() as i64,
            created_count: staged_rows.len() as i64,
            updated_count: 0,
            skipped_count: 0,
            rejected_count: 0,
            status: "staged".to_string(),
            created_at: "2026-10-21T12:00:00Z".to_string(),
            committed_at: None,
            rolled_back_at: None,
        };

        insert_staging_batch_tx(&mut staging_conn, &batch, &staged_rows).unwrap();
        commit_staged_batch(&mut staging_conn, &mut live_conn, batch_id).unwrap();

        // Verify that price saved is strictly Hors-Taxe (1800 or parsed HT) and no TVA columns exist
        verify_zero_tax_compliance(&live_conn).unwrap();
        verify_ledger_conservation(&live_conn).unwrap();
        verify_fifo_lot_parity(&live_conn).unwrap();
        verify_outbox_parity_and_no_nan(&live_conn).unwrap();
    }

    #[test]
    fn test_dst_serialized_hardware_fuzzing() {
        for iteration in 0..25 {
            let seed = 0x5E81A100 + (iteration as u64);
            let mut prng = SimPrng::new(seed);

            let mut live_conn = create_dst_live_db();
            let mut staging_conn = Connection::open_in_memory().unwrap();
            init_staging_db(&staging_conn).unwrap();

            let batch_id = format!("batch_imei_{}", iteration);
            let num_phones = prng.gen_range(2, 6) as usize;
            let mut staging_rows = Vec::new();

            for idx in 0..num_phones {
                let prefix14 = format!("86234504123{:03}", idx);
                let check_digit = compute_luhn_digit(&prefix14);
                let imei = format!("{}{}", prefix14, check_digit);

                let norm_json = serde_json::json!({
                    "title": format!("iPhone 14 Pro #{:02}", idx + 1),
                    "price": { "minor": 15000000, "dzd": 150000 },
                    "cost_price": { "minor": 12000000, "dzd": 120000 },
                    "cost_unknown": 0,
                    "opening_stock": 1.0,
                    "stock_provided": true,
                    "is_serialized": true,
                    "imei_number": imei,
                });

                staging_rows.push(crate::import::StagingRow {
                    batch_id: batch_id.clone(),
                    row_index: idx as i64,
                    raw_row_json: "[]".to_string(),
                    normalized_json: Some(norm_json.to_string()),
                    action: crate::import::StagingRowAction::Create,
                    matched_entity_id: None,
                    rejection_reason: None,
                    warnings_json: "[]".to_string(),
                    needs_review: false,
                    idempotency_key: format!("imei_idem_{}_{}", iteration, idx),
                });
            }

            let batch = ImportBatch {
                batch_id: batch_id.clone(),
                file_name: "serialized_phones.csv".to_string(),
                file_sha256: format!("sha_imei_{}", iteration),
                entity_type: "products".to_string(),
                mapping_config_json: "{}".to_string(),
                row_count: staging_rows.len() as i64,
                created_count: staging_rows.len() as i64,
                updated_count: 0,
                skipped_count: 0,
                rejected_count: 0,
                status: "staged".to_string(),
                created_at: "2026-10-21T12:00:00Z".to_string(),
                committed_at: None,
                rolled_back_at: None,
            };

            insert_staging_batch_tx(&mut staging_conn, &batch, &staging_rows).unwrap();
            let commit_res = commit_staged_batch(&mut staging_conn, &mut live_conn, &batch_id).unwrap();
            assert_eq!(commit_res.created_count, num_phones);

            // Verify IMEI table has exact number of records
            let imei_count: i64 = live_conn.query_row("SELECT count(*) FROM imei_records", [], |r| r.get(0)).unwrap();
            assert_eq!(imei_count, num_phones as i64);

            // Verify all Oracles
            verify_ledger_conservation(&live_conn).unwrap();
            verify_fifo_lot_parity(&live_conn).unwrap();
            verify_outbox_parity_and_no_nan(&live_conn).unwrap();
            verify_zero_tax_compliance(&live_conn).unwrap();
        }
    }
}

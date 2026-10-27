//! Smart Import Batch Commit Engine
//!
//! Atomically transfers staged rows from `import_staging.db` into live `mobi_pos.db`
//! within a single ACID transaction. Updates `products`, `stock_batches`, `inventory_ledger`,
//! `customers`, and `sync_outbox`, and marks the batch as committed.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{current_iso_timestamp, normalize_supplier_name, ImportError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitResult {
    pub batch_id: String,
    pub parsed_count: usize,
    pub created_count: usize,
    pub updated_count: usize,
    pub skipped_count: usize,
    pub rejected_count: usize,
}

fn apply_import_stock_snapshot(
    tx: &rusqlite::Transaction<'_>,
    product_id: &str,
    current_stock: i64,
    target_stock: i64,
    unit_cost: f64,
    batch_id: &str,
    row_index: i64,
    idempotency_key: &str,
    now: &str,
) -> Result<(), ImportError> {
    let delta = target_stock - current_stock;
    if delta == 0 {
        return Ok(());
    }

    if delta < 0 {
        let mut stmt = tx.prepare(
            "SELECT batch_id, quantity_remaining, unit_cost, freight_per_unit, received_at, version \
             FROM stock_batches WHERE product_id = ?1 AND deleted = 0 AND quantity_remaining > 0 \
             ORDER BY received_at ASC, batch_id ASC",
        )?;
        let batches = stmt
            .query_map([product_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let available: f64 = batches.iter().map(|batch| batch.1).sum();
        if (available - current_stock as f64).abs() > 0.000_001 {
            return Err(ImportError::Other(format!(
                "Cannot apply stock snapshot for product {product_id}: stock_batches total {available} does not match products.stock {current_stock}"
            )));
        }

        let mut remaining = (-delta) as f64;
        for (stock_batch_id, quantity, batch_cost, freight, received_at, version) in batches {
            if remaining <= 0.0 {
                break;
            }
            let reduction = quantity.min(remaining);
            let updated_quantity = quantity - reduction;
            tx.execute(
                "UPDATE stock_batches SET quantity_remaining = ?1, version = version + 1, \
                 sync_status = 'pending', updated_at = ?2 WHERE batch_id = ?3",
                rusqlite::params![updated_quantity, now, stock_batch_id],
            )?;
            let stock_batch_payload = json!({
                "batchId": stock_batch_id,
                "batch_id": stock_batch_id,
                "productId": product_id,
                "product_id": product_id,
                "quantityRemaining": updated_quantity,
                "quantity_remaining": updated_quantity,
                "unitCost": batch_cost,
                "unit_cost": batch_cost,
                "freightPerUnit": freight,
                "freight_per_unit": freight,
                "receivedAt": received_at,
                "received_at": received_at,
                "version": version + 1
            });
            tx.execute(
                "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                 VALUES (?1, 'stock_batches', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, \
                 status = 'pending', updated_at = excluded.updated_at",
                rusqlite::params![
                    format!("outbox_{}", stock_batch_id),
                    stock_batch_id,
                    stock_batch_payload.to_string(),
                    now,
                ],
            )?;
            remaining -= reduction;
        }
        if remaining > 0.000_001 {
            return Err(ImportError::Other(format!(
                "Could not reduce FIFO stock batches by the requested amount for product {product_id}"
            )));
        }
    } else {
        let stock_batch_id = format!("sbatch_import_{batch_id}_{row_index}");
        let stock_batch_key = format!("stock_{}", idempotency_key);
        tx.execute(
            "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, freight_per_unit, \
             received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, deleted) \
             VALUES (?1, ?2, ?3, ?4, 0, ?5, NULL, 'local', ?6, 'pending', 1, 0)",
            rusqlite::params![stock_batch_id, product_id, delta as f64, unit_cost, now, stock_batch_key],
        )?;
        let stock_batch_payload = json!({
            "batchId": stock_batch_id,
            "batch_id": stock_batch_id,
            "productId": product_id,
            "product_id": product_id,
            "quantityRemaining": delta,
            "quantity_remaining": delta,
            "unitCost": unit_cost,
            "unit_cost": unit_cost,
            "freightPerUnit": 0,
            "freight_per_unit": 0,
            "receivedAt": now,
            "received_at": now,
            "version": 1
        });
        tx.execute(
            "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
             VALUES (?1, 'stock_batches', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
             ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, \
             status = 'pending', updated_at = excluded.updated_at",
            rusqlite::params![
                format!("outbox_{}", stock_batch_id),
                stock_batch_id,
                stock_batch_payload.to_string(),
                now,
            ],
        )?;
    }

    let ledger_id = format!("ledg_adjust_{batch_id}_{row_index}");
    let ledger_key = format!("ledg_adjust_{}", idempotency_key);
    tx.execute(
        "INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, \
         idempotency_key, sync_status, created_at, updated_at, deleted) \
         VALUES (?1, ?2, ?3, 'ADJUST', 'import_batch', ?4, 'local', ?5, 'pending', ?6, ?6, 0)",
        rusqlite::params![ledger_id, product_id, delta, batch_id, ledger_key, now],
    )?;
    let ledger_payload = json!({
        "id": ledger_id,
        "productId": product_id,
        "product_id": product_id,
        "delta": delta,
        "reason": "ADJUST",
        "refType": "import_batch",
        "ref_type": "import_batch",
        "refId": batch_id,
        "ref_id": batch_id,
        "createdAt": now,
        "created_at": now
    });
    tx.execute(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
         VALUES (?1, 'ledger', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, \
         status = 'pending', updated_at = excluded.updated_at",
        rusqlite::params![
            format!("outbox_{}", ledger_id),
            ledger_id,
            ledger_payload.to_string(),
            now,
        ],
    )?;
    Ok(())
}

/// Calculates the GS1 Modulo-10 check digit for a 12-digit string
pub fn calculate_ean13_check_digit(twelve_digits: &str) -> u8 {
    let mut sum: u32 = 0;
    for (idx, b) in twelve_digits.bytes().enumerate() {
        if b.is_ascii_digit() {
            let digit = (b - b'0') as u32;
            let weight = if idx % 2 == 0 { 1 } else { 3 };
            sum += digit * weight;
        }
    }
    let remainder = sum % 10;
    if remainder == 0 { 0 } else { (10 - remainder) as u8 }
}

/// Generates a valid 13-digit EAN-13 barcode with GS1 Modulo-10 checksum
pub fn generate_ean13_barcode(prefix: &str, sequence_num: u64) -> String {
    let base = format!("{}{:09}", prefix, sequence_num % 1_000_000_000);
    let check = calculate_ean13_check_digit(&base);
    format!("{}{}", base, check)
}

/// Generates a structured human-readable SKU: [CAT]-[BRAND]-[SEQ]
pub fn generate_structured_sku(category: &str, brand: &str, seq: usize) -> String {
    let c = category.to_lowercase();
    let cat_code = if c.contains("câble") || c.contains("cable") || c.contains("hdmi") {
        "CAB"
    } else if c.contains("charge") || c.contains("secteur") || c.contains("charger") {
        "CHG"
    } else if c.contains("audio") || c.contains("écouteur") || c.contains("ecouteur") || c.contains("casque") || c.contains("enceinte") {
        "AUD"
    } else if c.contains("batterie") || c.contains("power") {
        "BAT"
    } else if c.contains("support") || c.contains("stand") || c.contains("refroidissement") {
        "SUP"
    } else if c.contains("verre") || c.contains("film") || c.contains("hydrogel") || c.contains("protège") || c.contains("protege") {
        "PRT"
    } else if c.contains("coque") && (c.contains("iphone") || c.contains("apple")) {
        "COQ-IPH"
    } else if c.contains("coque") && (c.contains("samsung") || c.contains("galaxy")) {
        "COQ-SAM"
    } else if c.contains("coque") {
        "COQ"
    } else if c.contains("reprise") || c.contains("occasion") || c.contains("téléphone") || c.contains("telephone") {
        "TEL"
    } else {
        "PRD"
    };

    let b = brand.to_lowercase();
    let brd_code = if b.contains("apple") {
        "APP"
    } else if b.contains("samsung") {
        "SAM"
    } else if b.contains("xiaomi") || b.contains("redmi") {
        "XIA"
    } else if b.contains("huawei") {
        "HUA"
    } else if b.contains("google") || b.contains("pixel") {
        "GOO"
    } else if b.contains("anker") {
        "ANK"
    } else if b.contains("belkin") {
        "BEL"
    } else if b.contains("hoco") {
        "HOC"
    } else if b.contains("ldnio") {
        "LDN"
    } else {
        "AUT"
    };

    format!("{}-{}-{:04}", cat_code, brd_code, 1000 + (seq % 90000))
}

/// Atomically commit all valid staged rows in a batch to the live database.
pub fn commit_staged_batch(
    staging_conn: &mut Connection,
    live_conn: &mut Connection,
    batch_id: &str,
) -> Result<CommitResult, ImportError> {
    // 1. Verify batch exists and is staged
    let (entity_type, status, parsed_count, staged_skipped_count, rejected_count, source_file_hash, mapping_config_json): (String, String, i64, i64, i64, String, String) = staging_conn
        .query_row(
            "SELECT entity_type, status, row_count, skipped_count, rejected_count, file_sha256, mapping_config_json \
             FROM import_batches WHERE batch_id = ?1",
            rusqlite::params![batch_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                ImportError::Other(format!("Import batch '{}' not found", batch_id))
            }
            other => ImportError::Sqlite(other),
        })?;

    if status != "staged" {
        return Err(ImportError::Other(format!(
            "Batch '{}' cannot be committed because it is already in '{}' state",
            batch_id, status
        )));
    }

    // 2. Fetch staged rows with actions create or update
    let mut stmt = staging_conn.prepare(
        "SELECT row_index, normalized_json, action, matched_entity_id, idempotency_key \
         FROM import_staging_rows \
         WHERE batch_id = ?1 AND action IN ('create', 'update') \
         ORDER BY row_index ASC",
    )?;

    struct StagedRowToCommit {
        row_index: i64,
        normalized_json: String,
        action: String,
        matched_entity_id: Option<String>,
        idempotency_key: String,
    }

    let rows_iter = stmt.query_map(rusqlite::params![batch_id], |r| {
        Ok(StagedRowToCommit {
            row_index: r.get(0)?,
            normalized_json: r.get::<_, Option<String>>(1)?.unwrap_or_else(|| "{}".to_string()),
            action: r.get(2)?,
            matched_entity_id: r.get(3)?,
            idempotency_key: r.get(4)?,
        })
    })?;

    let mut rows_to_commit = Vec::new();
    for r in rows_iter {
        rows_to_commit.push(r?);
    }

    let now = current_iso_timestamp();
    let sheet_index = serde_json::from_str::<Value>(&mapping_config_json)
        .ok()
        .and_then(|value| value["sheet_index"].as_u64())
        .unwrap_or(0);
    let mut created_count = 0usize;
    let mut updated_count = 0usize;
    let mut skipped_count = staged_skipped_count.max(0) as usize;
    let rejected_count = rejected_count.max(0) as usize;
    let mut products_to_verify = Vec::new();
    let mut customers_to_verify = Vec::new();
    let mut suppliers_to_verify = Vec::new();

    // 3. Begin single atomic transaction on live database
    live_conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    let tx = live_conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // Heal any legacy empty category or brand fields
    let _ = tx.execute(
        "UPDATE products SET category = 'Tous les produits' WHERE category = '' OR category IS NULL",
        [],
    );
    let _ = tx.execute(
        "UPDATE products SET brand = 'Autre' WHERE brand = '' OR brand IS NULL",
        [],
    );

    // Self-heal any existing products in live database with missing barcodes or raw batch SKUs
    if let Ok(mut heal_stmt) = tx.prepare(
        "SELECT id, category, brand, sku, barcode FROM products WHERE (barcode = '' OR barcode IS NULL) OR (sku LIKE 'prod_batch_%' OR sku LIKE 'prod_web_%')"
    ) {
        let unhealed: Vec<(String, String, String, String, String)> = heal_stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                ))
            })
            .map(|mapped| mapped.filter_map(|r| r.ok()).collect())
            .unwrap_or_default();

        for (idx, (p_id, cat, brd, cur_sku, cur_bc)) in unhealed.into_iter().enumerate() {
            let new_bc = if cur_bc.trim().is_empty() {
                let seed = 1792600000000u64 + (idx as u64) + 1;
                generate_ean13_barcode("613", seed)
            } else {
                cur_bc
            };
            let new_sku = if cur_sku.trim().is_empty() || cur_sku.starts_with("prod_batch_") || cur_sku.starts_with("prod_web_") {
                generate_structured_sku(&cat, &brd, idx + 1)
            } else {
                cur_sku
            };
            let _ = tx.execute(
                "UPDATE products SET barcode = ?1, sku = ?2 WHERE id = ?3",
                rusqlite::params![new_bc, new_sku, p_id],
            );
        }
    }

    match entity_type.as_str() {
        "products" | "opening_stock" | "serialized_imeis" => {
            let mut insert_prod_stmt = tx.prepare(
                r#"
                INSERT INTO products (
                    id, sku, barcode, title, brand, compatible_model, category,
                    price, wholesale_price, cost_price, stock, image_url,
                    is_serialized, imei_number, vendor_name, lead_time_days,
                    daily_sales_velocity, reorder_point, json_payload, updated_at,
                    device_id, idempotency_key, sync_status, created_at, deleted, version
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7,
                    ?8, ?9, ?10, ?11, NULL,
                    ?12, ?13, ?14, 0,
                    0, 0, ?15, ?16,
                    'local', ?17, 'pending', ?16, 0, 1
                )
                "#,
            )?;

            let mut update_prod_stmt = tx.prepare(
                r#"
                UPDATE products SET
                    title = CASE WHEN ?1 != '' THEN ?1 ELSE title END,
                    price = CASE WHEN ?2 > 0 THEN ?2 ELSE price END,
                    cost_price = CASE WHEN ?3 > 0 THEN ?3 ELSE cost_price END,
                    brand = CASE WHEN ?4 != '' THEN ?4 ELSE brand END,
                    compatible_model = CASE WHEN ?5 != '' THEN ?5 ELSE compatible_model END,
                    category = CASE WHEN ?6 != '' THEN ?6 ELSE category END,
                    stock = ?7,
                    vendor_name = CASE WHEN ?8 != '' THEN ?8 ELSE vendor_name END,
                    is_serialized = CASE WHEN ?9 = 1 THEN 1 ELSE is_serialized END,
                    imei_number = CASE WHEN ?10 != '' THEN ?10 ELSE imei_number END,
                    json_payload = CASE WHEN ?11 != '' THEN ?11 ELSE json_payload END,
                    version = version + 1,
                    sync_status = 'pending',
                    updated_at = ?12
                WHERE id = ?13
                "#,
            )?;

            let mut insert_stock_batch_stmt = tx.prepare(
                r#"
                INSERT INTO stock_batches (
                    batch_id, product_id, quantity_remaining, unit_cost, freight_per_unit,
                    received_at, purchase_order_id, device_id, idempotency_key, sync_status, version, deleted
                ) VALUES (
                    ?1, ?2, ?3, ?4, 0,
                    ?5, NULL, 'local', ?6, 'pending', 1, 0
                )
                "#,
            )?;

            let mut insert_ledger_stmt = tx.prepare(
                r#"
                INSERT INTO inventory_ledger (
                    id, product_id, delta, reason, ref_type, ref_id, device_id,
                    idempotency_key, sync_status, created_at, updated_at, deleted
                ) VALUES (
                    ?1, ?2, ?3, 'SEED', 'import_batch', ?4, 'local',
                    ?5, 'pending', ?6, ?6, 0
                )
                "#,
            )?;

            let mut insert_imei_stmt = tx.prepare(
                r#"
                INSERT INTO imei_records (
                    imei, product_id, purchase_order_id, sale_transaction_id,
                    warranty_expires_at, received_at, sold_at, status
                ) VALUES (
                    ?1, ?2, NULL, NULL, NULL, ?3, NULL, 'in_stock'
                )
                ON CONFLICT(imei) DO NOTHING
                "#,
            )?;

            let mut outbox_generic_stmt = tx.prepare(
                r#"
                INSERT INTO sync_outbox (
                    idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)
                ON CONFLICT(idempotency_key) DO UPDATE SET
                    operation = excluded.operation,
                    payload_json = excluded.payload_json,
                    status = 'pending',
                    updated_at = excluded.updated_at
                "#,
            )?;

            for item in &rows_to_commit {
                let payload: Value = serde_json::from_str(&item.normalized_json).unwrap_or(Value::Null);
                let imei_number = payload["imei_number"].as_str().unwrap_or_default();
                if !imei_number.is_empty() {
                    let registered: Option<String> = tx
                        .query_row(
                            "SELECT product_id FROM imei_records WHERE imei = ?1",
                            [imei_number],
                            |row| row.get(0),
                        )
                        .optional()?;
                    if registered.is_some() {
                        return Err(ImportError::Other(format!(
                            "IMEI on source row {} was registered after staging; no import changes were committed",
                            item.row_index + 1
                        )));
                    }
                }
                if payload.is_null() {
                    skipped_count += 1;
                    continue;
                }

                let title = payload["title"].as_str().unwrap_or("Produit sans nom");
                let barcode = payload["barcode"].as_str().unwrap_or("");
                let sku = payload["sku"].as_str().unwrap_or("");
                let brand = payload["brand"].as_str().unwrap_or("");
                let compatible_model = payload["compatible_model"].as_str().unwrap_or("");
                let category = payload["category"].as_str().unwrap_or("");
                let brand_val = if !brand.trim().is_empty() { brand.trim() } else { "Autre" };
                let category_val = if !category.trim().is_empty() { category.trim() } else { "Tous les produits" };
                let price_dzd = if payload["price"].is_object() {
                    payload["price"]["dzd"].as_i64().unwrap_or(0) as f64
                } else {
                    payload["price"].as_f64().unwrap_or(0.0)
                };
                let cost_dzd = if payload["cost_price"].is_object() {
                    payload["cost_price"]["dzd"].as_i64().unwrap_or(0) as f64
                } else {
                    payload["cost_price"].as_f64().unwrap_or(0.0)
                };
                let opening_stock = payload["opening_stock"].as_f64().unwrap_or(0.0);
                let opening_stock_units = opening_stock.round() as i64;
                let stock_provided = payload["stock_provided"].as_bool().unwrap_or(false);
                let cost_unknown = payload["cost_unknown"].as_i64().unwrap_or(1) != 0;
                let is_serialized = payload["is_serialized"].as_bool().unwrap_or(false);
                let imei_number = payload["imei_number"].as_str().unwrap_or("");
                let vendor_name = payload["vendor_name"].as_str().unwrap_or("Fournisseur Général");

                let final_barcode = if !barcode.trim().is_empty() {
                    barcode.trim().to_string()
                } else {
                    // Generate valid unique EAN-13 barcode with GS1 Modulo-10 checksum (GS1 RCN prefix 200)
                    let base_seed = 1792600000000u64 + (item.row_index as u64) + 1;
                    generate_ean13_barcode("200", base_seed)
                };

                let final_sku = if !sku.trim().is_empty() {
                    sku.trim().to_string()
                } else if !imei_number.trim().is_empty() {
                    imei_number.trim().to_string()
                } else {
                    generate_structured_sku(category_val, brand_val, (item.row_index as usize) + 1)
                };

                if item.action == "create" {
                    if opening_stock_units > 0 && cost_unknown {
                        return Err(ImportError::Other(format!(
                            "Product row {} has positive stock without an explicit unit cost",
                            item.row_index + 1
                        )));
                    }
                    let prod_id = format!("prod_{}_{}", batch_id, item.row_index);

                    let full_product_json = json!({
                        "id": prod_id,
                        "sku": final_sku,
                        "barcode": final_barcode,
                        "title": title,
                        "brand": brand_val,
                        "compatibleModel": compatible_model,
                        "compatible_model": compatible_model,
                        "category": category_val,
                        "price": price_dzd,
                        "wholesalePrice": 0.0,
                        "wholesale_price": 0.0,
                        "costPrice": cost_dzd,
                        "cost_price": cost_dzd,
                        "stock": opening_stock_units,
                        "imageUrl": "",
                        "image_url": "",
                        "isSerialized": is_serialized,
                        "is_serialized": is_serialized,
                        "imeiNumber": if imei_number.is_empty() { None } else { Some(imei_number) },
                        "imei_number": if imei_number.is_empty() { None } else { Some(imei_number) },
                        "warrantyMonths": payload.get("warranty_months").cloned().unwrap_or(serde_json::Value::Null),
                        "warranty_months": payload.get("warranty_months").cloned().unwrap_or(serde_json::Value::Null),
                        "warrantyExplicitlyDisabled": payload["warranty_explicitly_disabled"].as_bool().unwrap_or(false),
                        "warranty_explicitly_disabled": payload["warranty_explicitly_disabled"].as_bool().unwrap_or(false),
                        "vendorName": vendor_name,
                        "vendor_name": vendor_name,
                        "leadTimeDays": 7,
                        "lead_time_days": 7,
                        "dailySalesVelocity": 0,
                        "daily_sales_velocity": 0,
                        "reorderPoint": 5,
                        "reorder_point": 5,
                        "createdAt": now,
                        "created_at": now,
                        "updatedAt": now,
                        "updated_at": now,
                        "version": 1
                    });
                    let full_product_str = full_product_json.to_string();

                    insert_prod_stmt.execute(rusqlite::params![
                        prod_id,
                        final_sku,
                        final_barcode,
                        title,
                        brand_val,
                        compatible_model,
                        category_val,
                        price_dzd,
                        0.0, // wholesale_price
                        cost_dzd,
                        opening_stock_units,
                        if is_serialized { 1 } else { 0 },
                        if imei_number.is_empty() { None } else { Some(imei_number) },
                        vendor_name,
                        full_product_str,
                        now,
                        item.idempotency_key,
                    ])?;

                    if is_serialized && !imei_number.is_empty() {
                        if insert_imei_stmt.execute(rusqlite::params![imei_number, prod_id, now])? != 1 {
                            return Err(ImportError::Other(format!(
                                "IMEI on source row {} could not be registered; no import changes were committed",
                                item.row_index + 1
                            )));
                        }

                        let imei_payload = json!({
                            "imei": imei_number,
                            "productId": prod_id,
                            "product_id": prod_id,
                            "receivedAt": now,
                            "received_at": now,
                            "status": "in_stock"
                        });
                        outbox_generic_stmt.execute(rusqlite::params![
                            format!("outbox_imei_{}", imei_number),
                            "imei_records",
                            imei_number,
                            "UPSERT",
                            imei_payload.to_string(),
                            now,
                        ])?;
                    }

                    if opening_stock_units > 0 {
                        let stock_batch_id = format!("sbatch_{}_{}", batch_id, item.row_index);
                        insert_stock_batch_stmt.execute(rusqlite::params![
                            stock_batch_id,
                            prod_id,
                            opening_stock_units as f64,
                            cost_dzd,
                            now,
                            format!("stock_{}", item.idempotency_key),
                        ])?;

                        let sbatch_payload = json!({
                            "batchId": stock_batch_id,
                            "batch_id": stock_batch_id,
                            "productId": prod_id,
                            "product_id": prod_id,
                            "quantityRemaining": opening_stock_units,
                            "quantity_remaining": opening_stock_units,
                            "unitCost": cost_dzd,
                            "unit_cost": cost_dzd,
                            "freightPerUnit": 0,
                            "freight_per_unit": 0,
                            "receivedAt": now,
                            "received_at": now,
                            "version": 1
                        });
                        outbox_generic_stmt.execute(rusqlite::params![
                            format!("outbox_{}", stock_batch_id),
                            "stock_batches",
                            stock_batch_id,
                            "UPSERT",
                            sbatch_payload.to_string(),
                            now,
                        ])?;

                        let ledger_id = format!("ledg_{}_{}", batch_id, item.row_index);
                        insert_ledger_stmt.execute(rusqlite::params![
                            ledger_id,
                            prod_id,
                            opening_stock_units,
                            batch_id,
                            format!("ledg_{}", item.idempotency_key),
                            now,
                        ])?;

                        let ledger_payload = json!({
                            "id": ledger_id,
                            "productId": prod_id,
                            "product_id": prod_id,
                            "delta": opening_stock.round() as i64,
                            "reason": "SEED",
                            "refType": "import_batch",
                            "ref_type": "import_batch",
                            "refId": batch_id,
                            "ref_id": batch_id,
                            "createdAt": now,
                            "created_at": now
                        });
                        outbox_generic_stmt.execute(rusqlite::params![
                            format!("outbox_{}", ledger_id),
                            "ledger",
                            ledger_id,
                            "UPSERT",
                            ledger_payload.to_string(),
                            now,
                        ])?;
                    }

                    outbox_generic_stmt.execute(rusqlite::params![
                        format!("outbox_{}", prod_id),
                        "product",
                        prod_id,
                        "UPSERT",
                        full_product_str,
                        now,
                    ])?;

                    products_to_verify.push(prod_id);
                    created_count += 1;
                } else if item.action == "update" {
                    if let Some(ref target_id) = item.matched_entity_id {
                        let current_stock: i64 = tx.query_row(
                            "SELECT stock FROM products WHERE id = ?1",
                            [target_id],
                            |row| row.get(0),
                        )?;
                        let target_stock = if stock_provided {
                            opening_stock.round() as i64
                        } else {
                            current_stock
                        };
                        if stock_provided {
                            let batch_quantity: f64 = tx.query_row(
                                "SELECT COALESCE(SUM(quantity_remaining), 0) FROM stock_batches \
                                 WHERE product_id = ?1 AND deleted = 0",
                                [target_id],
                                |row| row.get(0),
                            )?;
                            if (batch_quantity - current_stock as f64).abs() > 0.000_001 {
                                return Err(ImportError::Other(format!(
                                    "Stock batch projection mismatch for product row {}; reconcile inventory before importing",
                                    item.row_index + 1
                                )));
                            }
                            if target_stock > current_stock && cost_unknown {
                                return Err(ImportError::Other(format!(
                                    "Product row {} increases stock without an explicit unit cost",
                                    item.row_index + 1
                                )));
                            }
                        }
                        let update_product_json = json!({
                            "id": target_id,
                            "sku": final_sku,
                            "barcode": final_barcode,
                            "title": title,
                            "brand": brand_val,
                            "compatibleModel": compatible_model,
                            "compatible_model": compatible_model,
                            "category": category_val,
                            "price": price_dzd,
                            "wholesalePrice": 0.0,
                            "wholesale_price": 0.0,
                            "costPrice": cost_dzd,
                            "cost_price": cost_dzd,
                            "stock": target_stock,
                            "imageUrl": "",
                            "image_url": "",
                            "isSerialized": is_serialized,
                            "is_serialized": is_serialized,
                            "imeiNumber": if imei_number.is_empty() { None } else { Some(imei_number) },
                            "imei_number": if imei_number.is_empty() { None } else { Some(imei_number) },
                            "warrantyMonths": payload.get("warranty_months").cloned().unwrap_or(serde_json::Value::Null),
                            "warranty_months": payload.get("warranty_months").cloned().unwrap_or(serde_json::Value::Null),
                            "warrantyExplicitlyDisabled": payload["warranty_explicitly_disabled"].as_bool().unwrap_or(false),
                            "warranty_explicitly_disabled": payload["warranty_explicitly_disabled"].as_bool().unwrap_or(false),
                            "vendorName": vendor_name,
                            "vendor_name": vendor_name,
                            "leadTimeDays": 7,
                            "lead_time_days": 7,
                            "dailySalesVelocity": 0,
                            "daily_sales_velocity": 0,
                            "reorderPoint": 5,
                            "reorder_point": 5,
                            "updatedAt": now,
                            "updated_at": now,
                            "version": 1
                        });
                        let update_product_str = update_product_json.to_string();

                        update_prod_stmt.execute(rusqlite::params![
                            title,
                            price_dzd,
                            cost_dzd,
                            brand_val,
                            compatible_model,
                            category_val,
                            target_stock,
                            vendor_name,
                            if is_serialized { 1 } else { 0 },
                            imei_number,
                            update_product_str,
                            now,
                            target_id,
                        ])?;

                        if stock_provided {
                            apply_import_stock_snapshot(
                                &tx,
                                target_id,
                                current_stock,
                                target_stock,
                                cost_dzd,
                                batch_id,
                                item.row_index,
                                &item.idempotency_key,
                                &now,
                            )?;
                        }

                        outbox_generic_stmt.execute(rusqlite::params![
                            format!("outbox_{}", target_id),
                            "product",
                            target_id,
                            "UPSERT",
                            update_product_str,
                            now,
                        ])?;

                        if is_serialized && !imei_number.is_empty() {
                            if insert_imei_stmt.execute(rusqlite::params![imei_number, target_id, now])? != 1 {
                                return Err(ImportError::Other(format!(
                                    "IMEI on source row {} could not be registered; no import changes were committed",
                                    item.row_index + 1
                                )));
                            }

                            let imei_payload = json!({
                                "imei": imei_number,
                                "productId": target_id,
                                "product_id": target_id,
                                "receivedAt": now,
                                "received_at": now
                            });
                            outbox_generic_stmt.execute(rusqlite::params![
                                format!("outbox_imei_{}", imei_number),
                                "imei_records",
                                imei_number,
                                "UPSERT",
                                imei_payload.to_string(),
                                now,
                            ])?;
                        }

                        products_to_verify.push(target_id.clone());
                        updated_count += 1;
                    } else {
                        skipped_count += 1;
                    }
                }
            }
        }

        "customers" => {
            let mut insert_cust_stmt = tx.prepare(
                r#"
                INSERT INTO customers (
                    id, name, phone, email, registered_device, loyalty_points, store_credit,
                    pricing_tier, loyalty_tier, total_spent, loyalty_card_code, barcode,
                    json_payload, updated_at, device_id, idempotency_key, sync_status,
                    created_at, deleted, version, whatsapp_opt_in, current_debt
                ) VALUES (
                    ?1, ?2, ?3, ?4, 'local', 0, 0,
                    'Retail', 'Bronze', 0, NULL, NULL,
                    ?5, ?6, 'local', ?7, 'pending',
                    ?6, 0, 1, 0, 0
                )
                "#,
            )?;

            let mut update_cust_stmt = tx.prepare(
                r#"
                UPDATE customers SET
                    name = CASE WHEN ?1 != '' THEN ?1 ELSE name END,
                    phone = CASE WHEN ?2 != '' THEN ?2 ELSE phone END,
                    email = CASE WHEN ?3 != '' THEN ?3 ELSE email END,
                    json_payload = ?4,
                    version = version + 1,
                    sync_status = 'pending',
                    updated_at = ?5
                WHERE id = ?6
                "#,
            )?;

            let mut outbox_stmt = tx.prepare(
                r#"
                INSERT INTO sync_outbox (
                    idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at
                ) VALUES (?1, 'customer', ?2, 'UPSERT', ?3, 'pending', ?4, ?4)
                ON CONFLICT(idempotency_key) DO UPDATE SET
                    operation = 'UPSERT',
                    payload_json = excluded.payload_json,
                    status = 'pending',
                    updated_at = excluded.updated_at
                "#,
            )?;

            for item in &rows_to_commit {
                let source_record_id =
                    format!("{source_file_hash}:sheet:{sheet_index}:row:{}", item.row_index);
                let payload_hash = format!("{:x}", Sha256::digest(item.normalized_json.as_bytes()));
                let prior_identity: Option<(String, String)> = tx
                    .query_row(
                        "SELECT target_id, payload_hash FROM import_source_identity \
                         WHERE destination = 'customers' AND source_namespace = 'smart_import_file' \
                         AND source_record_id = ?1",
                        [&source_record_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                if let Some((_, prior_payload_hash)) = prior_identity {
                    if prior_payload_hash != payload_hash {
                        return Err(ImportError::Other(format!(
                            "Source identity conflict for customer row {}: the same file/sheet/row has changed payload",
                            item.row_index + 1
                        )));
                    }
                    skipped_count += 1;
                    continue;
                }

                let payload: Value = serde_json::from_str(&item.normalized_json).unwrap_or(Value::Null);
                if payload.is_null() {
                    skipped_count += 1;
                    continue;
                }

                let name = payload["name"].as_str().unwrap_or("Client");
                let phone = payload["phone"].as_str().unwrap_or("");
                let email = payload["email"].as_str().unwrap_or("");
                let profile_fields = &payload["profile_fields"];
                let name = if profile_fields["name"].as_bool().unwrap_or(!name.is_empty()) {
                    name
                } else {
                    ""
                };
                let phone = if profile_fields["phone"].as_bool().unwrap_or(!phone.is_empty()) {
                    phone
                } else {
                    ""
                };
                let email = if profile_fields["email"].as_bool().unwrap_or(!email.is_empty()) {
                    email
                } else {
                    ""
                };

                if item.action == "create" {
                    let cust_id = format!("cust_{}_{}", batch_id, item.row_index);

                    insert_cust_stmt.execute(rusqlite::params![
                        cust_id,
                        name,
                        phone,
                        email,
                        item.normalized_json,
                        now,
                        item.idempotency_key,
                    ])?;

                    let outbox_payload = if item.normalized_json.trim().is_empty() {
                        "{}".to_string()
                    } else {
                        item.normalized_json.clone()
                    };

                    outbox_stmt.execute(rusqlite::params![
                        format!("outbox_{}", cust_id),
                        cust_id,
                        outbox_payload,
                        now,
                    ])?;

                    customers_to_verify.push(cust_id.clone());
                    tx.execute(
                        "INSERT INTO import_source_identity \
                         (destination, source_namespace, source_record_id, target_id, payload_hash, source_file_hash, sheet_index, row_index, created_at) \
                         VALUES ('customers', 'smart_import_file', ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        rusqlite::params![
                            source_record_id,
                            cust_id,
                            payload_hash,
                            source_file_hash,
                            sheet_index as i64,
                            item.row_index,
                            now,
                        ],
                    )?;
                    created_count += 1;
                } else if item.action == "update" {
                    if let Some(ref target_id) = item.matched_entity_id {
                        let existing_json: String = tx.query_row(
                            "SELECT json_payload FROM customers WHERE id = ?1",
                            [target_id],
                            |row| row.get(0),
                        )?;
                        let mut merged_payload = serde_json::from_str::<Value>(&existing_json)
                            .ok()
                            .and_then(|value| value.as_object().cloned())
                            .unwrap_or_default();
                        if let Some(fields) = payload["profile_fields"].as_object() {
                            for (field, provided) in fields {
                                if provided.as_bool() != Some(true) {
                                    continue;
                                }
                                if let Some(value) = payload.get(field) {
                                    let target_field = match field.as_str() {
                                        "secondary_phone" => "secondaryPhone",
                                        other => other,
                                    };
                                    merged_payload.insert(target_field.to_string(), value.clone());
                                }
                            }
                        }
                        let merged_json = Value::Object(merged_payload).to_string();
                        update_cust_stmt.execute(rusqlite::params![
                            name,
                            phone,
                            email,
                            merged_json,
                            now,
                            target_id,
                        ])?;

                        outbox_stmt.execute(rusqlite::params![
                            format!("outbox_{}", target_id),
                            target_id,
                            merged_json,
                            now,
                        ])?;

                        customers_to_verify.push(target_id.clone());
                        tx.execute(
                            "INSERT INTO import_source_identity \
                             (destination, source_namespace, source_record_id, target_id, payload_hash, source_file_hash, sheet_index, row_index, created_at) \
                             VALUES ('customers', 'smart_import_file', ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                            rusqlite::params![
                                source_record_id,
                                target_id,
                                payload_hash,
                                source_file_hash,
                                sheet_index as i64,
                                item.row_index,
                                now,
                            ],
                        )?;
                        updated_count += 1;
                    } else {
                        skipped_count += 1;
                    }
                }
            }
        }

        "customer_debts" => {
            for item in &rows_to_commit {
                let source_record_id =
                    format!("{source_file_hash}:sheet:{sheet_index}:row:{}", item.row_index);
                let payload_hash = format!("{:x}", Sha256::digest(item.normalized_json.as_bytes()));
                let prior_identity: Option<(String, String)> = tx
                    .query_row(
                        "SELECT target_id, payload_hash FROM import_source_identity \
                         WHERE destination = 'customer_debts' AND source_namespace = 'smart_import_file' \
                         AND source_record_id = ?1",
                        [&source_record_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                if let Some((_, prior_payload_hash)) = prior_identity {
                    if prior_payload_hash != payload_hash {
                        return Err(ImportError::Other(format!(
                            "Source identity conflict for debt row {}: the same file/sheet/row has changed payload",
                            item.row_index + 1
                        )));
                    }
                    skipped_count += 1;
                    continue;
                }

                let payload: Value = serde_json::from_str(&item.normalized_json)?;
                let name = payload["name"].as_str().unwrap_or_default().trim();
                let phone = payload["phone"].as_str().unwrap_or_default().trim();
                let email = payload["email"].as_str().unwrap_or_default().trim();
                let balance = payload["balance"].as_i64().ok_or_else(|| {
                    ImportError::Other(format!(
                        "Debt snapshot row {} has no valid DZD balance",
                        item.row_index + 1
                    ))
                })?;
                if balance < 0 {
                    return Err(ImportError::Other(format!(
                        "Debt snapshot row {} has a negative balance",
                        item.row_index + 1
                    )));
                }

                let phone_matches: Vec<String> = if phone.is_empty() {
                    Vec::new()
                } else {
                    let mut stmt = tx.prepare(
                        "SELECT id FROM customers WHERE phone = ?1 AND deleted = 0",
                    )?;
                    let matches = stmt
                        .query_map([phone], |row| row.get(0))?
                        .collect::<Result<Vec<_>, _>>()?;
                    matches
                };
                let email_matches: Vec<String> = if email.is_empty() {
                    Vec::new()
                } else {
                    let mut stmt = tx.prepare(
                        "SELECT id FROM customers WHERE LOWER(TRIM(email)) = LOWER(TRIM(?1)) AND deleted = 0",
                    )?;
                    let matches = stmt
                        .query_map([email], |row| row.get(0))?
                        .collect::<Result<Vec<_>, _>>()?;
                    matches
                };
                if phone_matches.len() > 1 || email_matches.len() > 1 {
                    return Err(ImportError::Other(format!(
                        "Debt snapshot row {} matches multiple customers",
                        item.row_index + 1
                    )));
                }
                if let (Some(phone_id), Some(email_id)) =
                    (phone_matches.first(), email_matches.first())
                {
                    if phone_id != email_id {
                        return Err(ImportError::Other(format!(
                            "Debt snapshot row {} phone and email identify different customers",
                            item.row_index + 1
                        )));
                    }
                }
                let resolved_id = phone_matches
                    .first()
                    .or_else(|| email_matches.first())
                    .cloned();
                if let (Some(staged_id), Some(resolved_id)) =
                    (item.matched_entity_id.as_deref(), resolved_id.as_deref())
                {
                    if staged_id != resolved_id {
                        return Err(ImportError::Other(format!(
                            "Debt snapshot row {} customer identity changed after preview",
                            item.row_index + 1
                        )));
                    }
                }
                let customer_id = resolved_id.unwrap_or_else(|| {
                    item.matched_entity_id
                        .clone()
                        .unwrap_or_else(|| format!("cust_debt_{}_{}", batch_id, item.row_index))
                });
                let existing_customer: Option<(i64, String, String, String)> = tx
                    .query_row(
                        "SELECT COALESCE(current_debt, 0), name, phone, COALESCE(json_payload, '{}') \
                         FROM customers WHERE id = ?1 AND deleted = 0",
                        [&customer_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                let created_customer = existing_customer.is_none();

                let ledger_balance: i64 = if created_customer {
                    0
                } else {
                    tx.query_row(
                        "SELECT MAX(0, CAST(ROUND(COALESCE(SUM(CASE \
                           WHEN type = 'DEBT_ACQUIRED' THEN amount \
                           WHEN type = 'PAYMENT_SETTLED' THEN -amount ELSE 0 END), 0)) AS INTEGER)) \
                         FROM customer_debts WHERE customer_id = ?1 AND deleted = 0",
                        [&customer_id],
                        |row| row.get(0),
                    )?
                };
                let cached_balance = existing_customer
                    .as_ref()
                    .map(|customer| customer.0)
                    .unwrap_or(0);
                let debt_customer_name = existing_customer
                    .as_ref()
                    .map(|customer| customer.1.as_str())
                    .unwrap_or(name);
                if ledger_balance != cached_balance {
                    return Err(ImportError::Other(format!(
                        "Customer debt ledger/cache mismatch for row {}: reconcile before importing",
                        item.row_index + 1
                    )));
                }
                if !created_customer && ledger_balance == balance {
                    tx.execute(
                        "INSERT INTO import_source_identity \
                         (destination, source_namespace, source_record_id, target_id, payload_hash, source_file_hash, sheet_index, row_index, created_at) \
                         VALUES ('customer_debts', 'smart_import_file', ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        rusqlite::params![
                            source_record_id,
                            customer_id,
                            payload_hash,
                            source_file_hash,
                            sheet_index as i64,
                            item.row_index,
                            now,
                        ],
                    )?;
                    skipped_count += 1;
                    continue;
                }
                if !created_customer && ledger_balance != 0 {
                    return Err(ImportError::Other(format!(
                        "Debt snapshot row {} cannot replace an existing non-zero ledger; import itemized history or reconcile first",
                        item.row_index + 1
                    )));
                }

                let debt_id = format!(
                    "debt_import_{:x}",
                    Sha256::digest(source_record_id.as_bytes())
                );
                if created_customer {
                    let customer_payload = json!({
                        "id": customer_id,
                        "name": name,
                        "phone": phone,
                        "email": email,
                        "currentDebt": balance,
                        "current_debt": balance,
                        "version": 1
                    });
                    tx.execute(
                        "INSERT INTO customers \
                         (id, name, phone, email, json_payload, updated_at, device_id, idempotency_key, \
                          sync_status, created_at, deleted, version, current_debt) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'local', ?7, 'pending', ?6, 0, 1, ?8)",
                        rusqlite::params![
                            customer_id,
                            name,
                            phone,
                            if email.is_empty() { None } else { Some(email) },
                            customer_payload.to_string(),
                            now,
                            format!("import_customer_{batch_id}_{}", item.row_index),
                            balance,
                        ],
                    )?;
                    tx.execute(
                        "INSERT INTO sync_outbox \
                         (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                         VALUES (?1, 'customer', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, \
                         status = 'pending', updated_at = excluded.updated_at",
                        rusqlite::params![
                            format!("outbox_{customer_id}"),
                            customer_id,
                            customer_payload.to_string(),
                            now,
                        ],
                    )?;
                } else {
                    let (_, _, existing_phone, existing_payload) =
                        existing_customer.as_ref().unwrap();
                    let mut customer_payload = serde_json::from_str::<Value>(existing_payload)
                        .ok()
                        .and_then(|value| value.as_object().cloned())
                        .unwrap_or_default();
                    customer_payload.insert("currentDebt".to_string(), json!(balance));
                    let updated_customer_payload = Value::Object(customer_payload).to_string();
                    tx.execute(
                        "UPDATE customers SET current_debt = ?1, json_payload = ?2, \
                         version = version + 1, sync_status = 'pending', updated_at = ?3 WHERE id = ?4",
                        rusqlite::params![balance, updated_customer_payload, now, customer_id],
                    )?;
                    let customer_payload = json!({
                        "id": customer_id,
                        "name": debt_customer_name,
                        "phone": existing_phone,
                        "currentDebt": balance,
                        "current_debt": balance,
                        "json_payload": updated_customer_payload,
                        "version": 1
                    });
                    tx.execute(
                        "INSERT INTO sync_outbox \
                         (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                         VALUES (?1, 'customer', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, \
                         status = 'pending', updated_at = excluded.updated_at",
                        rusqlite::params![
                            format!("outbox_{customer_id}"),
                            customer_id,
                            customer_payload.to_string(),
                            now,
                        ],
                    )?;
                }

                if balance > 0 {
                    let debt_payload = json!({
                        "id": debt_id,
                        "customerId": customer_id,
                        "customer_id": customer_id,
                        "customerName": debt_customer_name,
                        "customer_name": debt_customer_name,
                        "type": "DEBT_ACQUIRED",
                        "amount": balance,
                        "balanceAfter": balance,
                        "balance_after": balance,
                        "receiptNumber": "IMPORT",
                        "receipt_number": "IMPORT",
                        "paymentMethod": null,
                        "payment_method": null,
                        "notes": "Solde d'ouverture importé",
                        "recordedBy": "Système",
                        "recorded_by": "Système",
                        "origin": "imported_history",
                        "kind": "",
                        "createdAt": now,
                        "created_at": now,
                        "version": 1
                    });
                    tx.execute(
                        "INSERT INTO customer_debts \
                         (id, customer_id, customer_name, type, amount, balance_after, receipt_number, \
                          payment_method, notes, recorded_by, created_at, json_payload, version, updated_at, \
                          deleted, due_date, kind, origin) \
                         VALUES (?1, ?2, ?3, 'DEBT_ACQUIRED', ?4, ?4, 'IMPORT', NULL, \
                          'Solde d''ouverture importé', 'Système', ?5, ?6, 1, ?5, 0, NULL, '', 'imported_history')",
                        rusqlite::params![
                            debt_id,
                            customer_id,
                            debt_customer_name,
                            balance,
                            now,
                            debt_payload.to_string(),
                        ],
                    )?;
                    tx.execute(
                        "INSERT INTO sync_outbox \
                         (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at) \
                         VALUES (?1, 'customer_debt', ?2, 'UPSERT', ?3, 'pending', ?4, ?4) \
                         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json = excluded.payload_json, \
                         status = 'pending', updated_at = excluded.updated_at",
                        rusqlite::params![
                            format!("outbox_{debt_id}"),
                            debt_id,
                            debt_payload.to_string(),
                            now,
                        ],
                    )?;
                }

                tx.execute(
                    "INSERT INTO import_source_identity \
                     (destination, source_namespace, source_record_id, target_id, payload_hash, source_file_hash, sheet_index, row_index, created_at) \
                     VALUES ('customer_debts', 'smart_import_file', ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        source_record_id,
                        if balance > 0 { debt_id } else { customer_id.clone() },
                        payload_hash,
                        source_file_hash,
                        sheet_index as i64,
                        item.row_index,
                        now,
                    ],
                )?;
                customers_to_verify.push(customer_id);
                if created_customer {
                    created_count += 1;
                } else {
                    updated_count += 1;
                }
            }
        }

        "suppliers" => {
            let existing_dir_json: String = tx
                .query_row(
                    "SELECT value_json FROM app_settings WHERE key = 'vendor_directory'",
                    [],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or_else(|| "{}".to_string());

            let mut vendor_dir: serde_json::Map<String, Value> =
                serde_json::from_str(&existing_dir_json)?;
            let mut directory_changed = false;

            for item in &rows_to_commit {
                let payload: Value = serde_json::from_str(&item.normalized_json)?;

                let name = payload["name"].as_str().unwrap_or_default().trim();
                let phone = payload["phone"].as_str().unwrap_or("").trim();
                let email = payload["email"].as_str().unwrap_or("").trim();
                let address = payload["address"].as_str().unwrap_or("").trim();
                let notes = payload["notes"].as_str().unwrap_or("").trim();

                if name.is_empty() {
                    return Err(ImportError::Other(format!(
                        "Supplier row {} has no name",
                        item.row_index + 1
                    )));
                }

                let normalized_name = normalize_supplier_name(name);
                let matching_keys: Vec<String> = vendor_dir
                    .keys()
                    .filter(|key| normalize_supplier_name(key) == normalized_name)
                    .cloned()
                    .collect();
                if matching_keys.len() > 1 {
                    return Err(ImportError::Other(format!(
                        "Supplier row {} now matches multiple directory entries",
                        item.row_index + 1
                    )));
                }
                let existing_key = matching_keys.first().cloned();
                let was_existing = existing_key.is_some();
                if let (Some(staged_key), Some(current_key)) =
                    (item.matched_entity_id.as_deref(), existing_key.as_deref())
                {
                    if staged_key != current_key {
                        return Err(ImportError::Other(format!(
                            "Supplier identity changed after preview on row {}",
                            item.row_index + 1
                        )));
                    }
                }
                let key = existing_key.unwrap_or_else(|| name.to_string());
                let mut entry = vendor_dir
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| json!({ "id": key, "name": name, "contact": {} }));
                let entry_id = entry
                    .get("id")
                    .cloned()
                    .unwrap_or_else(|| json!(key));
                let entry_name = entry
                    .get("name")
                    .cloned()
                    .unwrap_or_else(|| json!(name));
                let mut contact = entry
                    .get("contact")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();

                let mut changed = false;
                for (field, supplied) in [
                    ("phone", phone),
                    ("email", email),
                    ("address", address),
                ] {
                    if supplied.is_empty() {
                        continue;
                    }
                    let existing = contact
                        .get(field)
                        .and_then(Value::as_str)
                        .or_else(|| entry.get(field).and_then(Value::as_str))
                        .unwrap_or_default()
                        .trim();
                    let conflict = if existing.is_empty() {
                        false
                    } else if field == "email" {
                        !existing.eq_ignore_ascii_case(supplied)
                    } else if field == "phone" {
                        super::map::normalize_algerian_phone(existing)
                            .as_deref()
                            .map(|value| value != supplied)
                            .unwrap_or(existing != supplied)
                    } else {
                        existing != supplied
                    };
                    if conflict {
                        return Err(ImportError::Other(format!(
                            "Supplier row {} conflicts with the current {field}",
                            item.row_index + 1
                        )));
                    }
                    if existing.is_empty() {
                        contact.insert(field.to_string(), json!(supplied));
                        changed = true;
                    }
                }
                if !phone.is_empty()
                    && contact
                        .get("whatsapp")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim()
                        .is_empty()
                {
                    contact.insert("whatsapp".to_string(), json!(phone));
                    changed = true;
                }

                entry["id"] = entry_id;
                entry["name"] = entry_name;
                entry["contact"] = Value::Object(contact);
                if !notes.is_empty()
                    && entry.get("notes").and_then(Value::as_str).unwrap_or_default() != notes
                {
                    entry["notes"] = json!(notes);
                    changed = true;
                }
                if changed || !vendor_dir.contains_key(&key) {
                    entry["updatedAt"] = json!(now);
                    vendor_dir.insert(key.clone(), entry);
                    suppliers_to_verify.push(key);
                    directory_changed = true;
                    if was_existing {
                        updated_count += 1;
                    } else {
                        created_count += 1;
                    }
                } else {
                    skipped_count += 1;
                }
            }

            if directory_changed {
                let updated_dir_json = serde_json::to_string(&vendor_dir)?;
                tx.execute(
                    r#"
                    INSERT INTO app_settings (key, value_json, updated_at)
                    VALUES ('vendor_directory', ?1, ?2)
                    ON CONFLICT(key) DO UPDATE SET
                        value_json = excluded.value_json,
                        updated_at = excluded.updated_at
                    "#,
                    rusqlite::params![updated_dir_json, now],
                )?;

                tx.execute(
                    r#"
                    INSERT INTO sync_outbox (
                        idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at
                    ) VALUES (?1, 'app_settings', 'vendor_directory', 'UPSERT', ?2, 'pending', ?3, ?3)
                    ON CONFLICT(idempotency_key) DO UPDATE SET
                        payload_json = excluded.payload_json,
                        status = 'pending',
                        updated_at = excluded.updated_at
                    "#,
                    rusqlite::params![format!("outbox_vendor_dir_{}", batch_id), updated_dir_json, now],
                )?;
            }
        }

        other => {
            if rows_to_commit.is_empty() {
                // A batch containing only quarantined/skipped rows has no
                // writes to apply. Commit the batch state so the UI can
                // report its row-level rejection summary.
            } else {
                return Err(ImportError::Other(format!(
                    "Cannot commit unsupported entity type: {}",
                    other
                )));
            }
        }
    }

    // 4. Commit transaction on live database
    tx.commit()?;

    // 5. Read back every committed identity before reporting success.
    let verified_count = match entity_type.as_str() {
        "products" | "opening_stock" | "serialized_imeis" => {
            let mut stmt = live_conn.prepare(
                "SELECT COUNT(*) FROM products WHERE id = ?1 AND deleted = 0",
            )?;
            let mut verified = 0usize;
            for id in &products_to_verify {
                verified += stmt.query_row([id], |row| row.get::<_, i64>(0))? as usize;
            }
            verified
        }
        "customers" | "customer_debts" => {
            let mut stmt = live_conn.prepare(
                "SELECT COUNT(*) FROM customers WHERE id = ?1 AND deleted = 0",
            )?;
            let mut verified = 0usize;
            for id in &customers_to_verify {
                verified += stmt.query_row([id], |row| row.get::<_, i64>(0))? as usize;
            }
            verified
        }
        "suppliers" => {
            if suppliers_to_verify.is_empty() {
                0
            } else {
                let directory_json: String = live_conn.query_row(
                    "SELECT value_json FROM app_settings WHERE key = 'vendor_directory'",
                    [],
                    |row| row.get(0),
                )?;
                let directory: serde_json::Map<String, Value> =
                    serde_json::from_str(&directory_json)?;
                suppliers_to_verify
                    .iter()
                    .filter(|key| {
                        directory.keys().any(|stored| {
                            normalize_supplier_name(stored) == normalize_supplier_name(key)
                        })
                    })
                    .count()
            }
        }
        _ => created_count + updated_count,
    };
    let expected_count = created_count + updated_count;
    if verified_count != expected_count {
        staging_conn.execute(
            "UPDATE import_batches SET status = 'verification_failed' WHERE batch_id = ?1",
            [batch_id],
        )?;
        return Err(ImportError::Other(format!(
            "Import committed but read-back verification found {verified_count} of {expected_count} expected records"
        )));
    }

    // 6. Update batch status in staging DB
    staging_conn.execute(
        "UPDATE import_batches SET status = 'committed', committed_at = ?1 WHERE batch_id = ?2",
        rusqlite::params![now, batch_id],
    )?;

    Ok(CommitResult {
        batch_id: batch_id.to_string(),
        parsed_count: parsed_count.max(0) as usize,
        created_count,
        updated_count,
        skipped_count,
        rejected_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::{init_staging_db, ImportBatch, StagingRow, StagingRowAction};

    fn create_test_live_db() -> Connection {
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
                version INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT '',
                deleted INTEGER NOT NULL DEFAULT 0
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

            CREATE TABLE IF NOT EXISTS customer_debts (
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

            CREATE TABLE IF NOT EXISTS imei_records (
                imei TEXT PRIMARY KEY, product_id TEXT NOT NULL,
                purchase_order_id TEXT, sale_transaction_id TEXT, status TEXT,
                warranty_expires_at TEXT, received_at TEXT NOT NULL, sold_at TEXT
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

    #[test]
    fn test_commit_products_batch_end_to_end() {
        let mut staging_conn = Connection::open_in_memory().unwrap();
        init_staging_db(&staging_conn).unwrap();

        let mut live_conn = create_test_live_db();

        let batch_id = "batch_test_001";
        let batch = ImportBatch {
            batch_id: batch_id.to_string(),
            file_name: "products.xlsx".to_string(),
            file_sha256: "sha_001".to_string(),
            entity_type: "products".to_string(),
            mapping_config_json: "{}".to_string(),
            row_count: 2,
            created_count: 2,
            updated_count: 0,
            skipped_count: 0,
            rejected_count: 0,
            status: "staged".to_string(),
            created_at: "2026-10-21T10:00:00Z".to_string(),
            committed_at: None,
            rolled_back_at: None,
        };

        let rows = vec![
            StagingRow {
                batch_id: batch_id.to_string(),
                row_index: 0,
                raw_row_json: "[\"Chargeur 20W\", \"6132450019283\", \"1800\", \"1200\", \"10\"]".to_string(),
                normalized_json: Some(
                    serde_json::json!({
                        "title": "Chargeur 20W",
                        "barcode": "6132450019283",
                        "sku": "CHG-20W",
                        "brand": "Apple",
                        "category": "Accessoires",
                        "price": { "minor": 180000, "dzd": 1800 },
                        "cost_price": { "minor": 120000, "dzd": 1200 },
                        "cost_unknown": 0,
                        "opening_stock": 10.0,
                        "stock_provided": true
                    })
                    .to_string(),
                ),
                action: StagingRowAction::Create,
                matched_entity_id: None,
                rejection_reason: None,
                warnings_json: "[]".to_string(),
                needs_review: false,
                idempotency_key: "idem_0".to_string(),
            },
            StagingRow {
                batch_id: batch_id.to_string(),
                row_index: 1,
                raw_row_json: "[\"Câble Type-C\", \"6132450019290\", \"600\", \"300\", \"25\"]".to_string(),
                normalized_json: Some(
                    serde_json::json!({
                        "title": "Câble Type-C",
                        "barcode": "6132450019290",
                        "sku": "CBL-TC",
                        "brand": "Samsung",
                        "category": "Accessoires",
                        "price": { "minor": 60000, "dzd": 600 },
                        "cost_price": { "minor": 30000, "dzd": 300 },
                        "cost_unknown": 0,
                        "opening_stock": 25.0,
                        "stock_provided": true
                    })
                    .to_string(),
                ),
                action: StagingRowAction::Create,
                matched_entity_id: None,
                rejection_reason: None,
                warnings_json: "[]".to_string(),
                needs_review: false,
                idempotency_key: "idem_1".to_string(),
            },
        ];

        crate::import::insert_staging_batch_tx(&mut staging_conn, &batch, &rows).unwrap();

        // Commit batch
        let res = commit_staged_batch(&mut staging_conn, &mut live_conn, batch_id).unwrap();
        assert_eq!(res.created_count, 2);
        assert_eq!(res.updated_count, 0);

        // Verify products created in live DB
        let prod_count: i64 = live_conn
            .query_row("SELECT count(*) FROM products", [], |r| r.get(0))
            .unwrap();
        assert_eq!(prod_count, 2);

        // Verify stock batches created
        let stock_batches_count: i64 = live_conn
            .query_row("SELECT count(*) FROM stock_batches", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stock_batches_count, 2);

        // Verify inventory ledger rows created with reason SEED
        let ledger_count: i64 = live_conn
            .query_row("SELECT count(*) FROM inventory_ledger WHERE reason = 'SEED'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ledger_count, 2);

        // Verify sync outbox rows created with valid payload_json
        let (outbox_count, payload): (i64, String) = live_conn
            .query_row(
                "SELECT count(*), payload_json FROM sync_outbox WHERE entity_type = 'product'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(outbox_count, 2);
        assert!(!payload.is_empty());

        // Verify batch status is now committed in staging DB
        let status: String = staging_conn
            .query_row("SELECT status FROM import_batches WHERE batch_id = ?1", [batch_id], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "committed");

        // Verify committing again fails
        let re_commit = commit_staged_batch(&mut staging_conn, &mut live_conn, batch_id);
        assert!(re_commit.is_err());
    }

    #[test]
    fn test_product_import_stock_snapshot_adjusts_fifo_batches_and_ledger() {
        let mut staging_conn = Connection::open_in_memory().unwrap();
        init_staging_db(&staging_conn).unwrap();
        let mut live_conn = create_test_live_db();

        live_conn
            .execute(
                "INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price, cost_price, stock, json_payload, updated_at, created_at) \
                 VALUES ('prod_existing', 'SKU-1', '6132450019283', 'Cable', 'Autre', 'Accessoires', 100, 0, 40, 10, '{}', 'now', 'now')",
                [],
            )
            .unwrap();
        for (batch_id, quantity, received_at) in [
            ("lot_old", 6.0, "2026-01-01"),
            ("lot_new", 4.0, "2026-01-02"),
        ] {
            live_conn
                .execute(
                    "INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, freight_per_unit, received_at, idempotency_key) \
                     VALUES (?1, 'prod_existing', ?2, 40, 0, ?3, ?4)",
                    rusqlite::params![batch_id, quantity, received_at, format!("key_{batch_id}")],
                )
                .unwrap();
        }
        live_conn
            .execute(
                "INSERT INTO inventory_ledger (id, product_id, delta, reason, device_id, idempotency_key, created_at, updated_at) \
                 VALUES ('seed_existing', 'prod_existing', 10, 'SEED', 'local', 'seed_key', 'now', 'now')",
                [],
            )
            .unwrap();

        let batch_id = "batch_snapshot";
        let batch = ImportBatch {
            batch_id: batch_id.to_string(),
            file_name: "stock.csv".to_string(),
            file_sha256: "snapshot".to_string(),
            entity_type: "products".to_string(),
            mapping_config_json: "{}".to_string(),
            row_count: 1,
            created_count: 0,
            updated_count: 1,
            skipped_count: 0,
            rejected_count: 0,
            status: "staged".to_string(),
            created_at: "now".to_string(),
            committed_at: None,
            rolled_back_at: None,
        };
        let row = StagingRow {
            batch_id: batch_id.to_string(),
            row_index: 0,
            raw_row_json: "[]".to_string(),
            normalized_json: Some(
                json!({
                    "title": "Cable",
                    "barcode": "6132450019283",
                    "sku": "SKU-1",
                    "brand": "Autre",
                    "category": "Accessoires",
                    "price": { "minor": 12000, "dzd": 120 },
                    "cost_price": { "minor": 4000, "dzd": 40 },
                    "cost_unknown": 0,
                    "opening_stock": 4.0,
                    "stock_provided": true
                })
                .to_string(),
            ),
            action: super::super::StagingRowAction::Update,
            matched_entity_id: Some("prod_existing".to_string()),
            rejection_reason: None,
            warnings_json: "[]".to_string(),
            needs_review: false,
            idempotency_key: "snapshot_row_key".to_string(),
        };
        crate::import::insert_staging_batch_tx(&mut staging_conn, &batch, &[row]).unwrap();

        let result = commit_staged_batch(&mut staging_conn, &mut live_conn, batch_id).unwrap();
        assert_eq!(result.parsed_count, 1);
        assert_eq!(result.updated_count, 1);
        let stock: i64 = live_conn
            .query_row("SELECT stock FROM products WHERE id = 'prod_existing'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stock, 4);
        let batches_total: f64 = live_conn
            .query_row("SELECT SUM(quantity_remaining) FROM stock_batches WHERE product_id = 'prod_existing'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(batches_total, 4.0);
        let ledger_total: i64 = live_conn
            .query_row("SELECT SUM(delta) FROM inventory_ledger WHERE product_id = 'prod_existing'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(ledger_total, 4);
        let adjustment: i64 = live_conn
            .query_row("SELECT delta FROM inventory_ledger WHERE reason = 'ADJUST'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(adjustment, -6);
    }

    #[test]
    fn test_customer_profile_import_does_not_create_debt() {
        let mut staging_conn = Connection::open_in_memory().unwrap();
        init_staging_db(&staging_conn).unwrap();

        let mut live_conn = create_test_live_db();

        let batch_id = "batch_cust_001";
        let batch = ImportBatch {
            batch_id: batch_id.to_string(),
            file_name: "clients.csv".to_string(),
            file_sha256: "sha_c001".to_string(),
            entity_type: "customers".to_string(),
            mapping_config_json: "{}".to_string(),
            row_count: 1,
            created_count: 1,
            updated_count: 0,
            skipped_count: 0,
            rejected_count: 0,
            status: "staged".to_string(),
            created_at: "2026-10-21T10:00:00Z".to_string(),
            committed_at: None,
            rolled_back_at: None,
        };

        let rows = vec![StagingRow {
            batch_id: batch_id.to_string(),
            row_index: 0,
            raw_row_json: "[\"Mohamed Benali\", \"0550123456\", \"client@test.dz\"]".to_string(),
            normalized_json: Some(
                serde_json::json!({
                    "name": "Mohamed Benali",
                    "phone": "0550123456",
                    "email": "client@test.dz",
                    "initial_debt": 5000,
                    "ledger": []
                })
                .to_string(),
            ),
            action: StagingRowAction::Create,
            matched_entity_id: None,
            rejection_reason: None,
            warnings_json: "[]".to_string(),
            needs_review: false,
            idempotency_key: "idem_c0".to_string(),
        }];

        crate::import::insert_staging_batch_tx(&mut staging_conn, &batch, &rows).unwrap();

        let res = commit_staged_batch(&mut staging_conn, &mut live_conn, batch_id).unwrap();
        assert_eq!(res.created_count, 1);

        let (cust_count, current_debt): (i64, i64) = live_conn
            .query_row("SELECT count(*), current_debt FROM customers", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(cust_count, 1);
        assert_eq!(current_debt, 0);

        let debt_count: i64 = live_conn
            .query_row("SELECT count(*) FROM customer_debts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(debt_count, 0);

        let (cust_outbox_count, payload): (i64, String) = live_conn
            .query_row(
                "SELECT count(*), payload_json FROM sync_outbox WHERE entity_type = 'customer'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(cust_outbox_count, 1);
        assert!(!payload.is_empty());

        let debt_outbox_count: i64 = live_conn
            .query_row(
                "SELECT count(*) FROM sync_outbox WHERE entity_type = 'customer_debt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(debt_outbox_count, 0);
    }

    #[test]
    fn customer_source_identity_replay_is_noop_and_payload_change_conflicts() {
        fn stage(
            staging_conn: &mut Connection,
            batch_id: &str,
            name: &str,
            key: &str,
        ) {
            let batch = ImportBatch {
                batch_id: batch_id.to_string(),
                file_name: "clients.csv".to_string(),
                file_sha256: "same-file-hash".to_string(),
                entity_type: "customers".to_string(),
                mapping_config_json: r#"{"sheet_index":1}"#.to_string(),
                row_count: 1,
                created_count: 1,
                updated_count: 0,
                skipped_count: 0,
                rejected_count: 0,
                status: "staged".to_string(),
                created_at: "2026-10-21T10:00:00Z".to_string(),
                committed_at: None,
                rolled_back_at: None,
            };
            let row = StagingRow {
                batch_id: batch_id.to_string(),
                row_index: 4,
                raw_row_json: format!(r#"["{name}","0550123456"]"#),
                normalized_json: Some(
                    json!({
                        "name": name,
                        "phone": "0550123456",
                        "email": "",
                        "profile_fields": { "name": true, "phone": true, "email": false }
                    })
                    .to_string(),
                ),
                action: StagingRowAction::Create,
                matched_entity_id: None,
                rejection_reason: None,
                warnings_json: "[]".to_string(),
                needs_review: false,
                idempotency_key: key.to_string(),
            };
            crate::import::insert_staging_batch_tx(staging_conn, &batch, &[row]).unwrap();
        }

        let mut staging_conn = Connection::open_in_memory().unwrap();
        init_staging_db(&staging_conn).unwrap();
        let mut live_conn = create_test_live_db();
        stage(&mut staging_conn, "batch_identity_1", "Client initial", "idem_identity_1");
        let first = commit_staged_batch(&mut staging_conn, &mut live_conn, "batch_identity_1").unwrap();
        assert_eq!(first.created_count, 1);

        stage(&mut staging_conn, "batch_identity_2", "Client initial", "idem_identity_2");
        let replay =
            commit_staged_batch(&mut staging_conn, &mut live_conn, "batch_identity_2").unwrap();
        assert_eq!(replay.created_count, 0);
        assert_eq!(replay.updated_count, 0);
        assert_eq!(replay.skipped_count, 1);

        stage(&mut staging_conn, "batch_identity_3", "Client modifié", "idem_identity_3");
        let conflict = commit_staged_batch(&mut staging_conn, &mut live_conn, "batch_identity_3");
        assert!(conflict
            .unwrap_err()
            .to_string()
            .contains("Source identity conflict"));
        let name: String = live_conn
            .query_row("SELECT name FROM customers", [], |row| row.get(0))
            .unwrap();
        assert_eq!(name, "Client initial");
    }

    #[test]
    fn test_ean13_and_sku_generation() {
        // EAN-13 check digit test vectors
        // 613831844988 -> check digit 5
        assert_eq!(calculate_ean13_check_digit("613831844988"), 5);
        // 200000000001 -> check digit 5
        let barcode = generate_ean13_barcode("613", 1);
        assert_eq!(barcode.len(), 13);
        assert!(barcode.starts_with("613000000001"));

        // SKU tests
        let sku_cable = generate_structured_sku("Câbles", "Autre", 1);
        assert_eq!(sku_cable, "CAB-AUT-1001");

        let sku_chargeur = generate_structured_sku("Chargeurs", "Apple", 4);
        assert_eq!(sku_chargeur, "CHG-APP-1004");

        let sku_audio = generate_structured_sku("Audio", "Samsung", 5);
        assert_eq!(sku_audio, "AUD-SAM-1005");
    }
}

//! Column Mapping & Data Normalization for Smart Import
//!
//! Enforces:
//! - Dual-unit money staging (`minor: i64` + `dzd: i64`).
//! - Algerian phone zero-restoration and role disambiguation.
//! - Missing cost preservation (`cost_unknown = 1, unit_cost = 0`).
//! - Missing warranty preservation (`warranty_months: null`).
//! - Loyalty milestone pre-anchoring (`reconcileLoyaltyState` guard).
//! - Read-only live DB conflict probing (`SQLITE_OPEN_READ_ONLY`).

use rusqlite::{Connection, OptionalExtension};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

use crate::import::{
    confidence::{ColumnMatchScore, ConfidenceCategory, AUTO_MAP_THRESHOLD},
    detect::{
        fold_arabic_indic_digits, infer_column_thousand_dot, match_header_synonym,
        ThousandDotInference,
    },
    parser::ParsedTable,
    normalize_supplier_name, ColumnType, EntityType, ImportError, ImportWarning, StagingRow,
    StagingRowAction,
};
use crate::money::Money;

fn supplier_entry_field<'a>(entry: &'a serde_json::Value, field: &str) -> &'a str {
    entry
        .get("contact")
        .and_then(|contact| contact.get(field))
        .and_then(serde_json::Value::as_str)
        .or_else(|| entry.get(field).and_then(serde_json::Value::as_str))
        .unwrap_or_default()
}

fn import_imei_identity(raw_imei: &str, raw_barcode: &str) -> Option<String> {
    let explicit_digits: String = crate::import::detect::normalize_numeric_string(raw_imei)
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();
    if explicit_digits.len() == 15 {
        return Some(explicit_digits);
    }

    let barcode_digits: String = raw_barcode
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();
    if barcode_digits.len() == 15 && crate::import::detect::luhn_check_imei(&barcode_digits) {
        return Some(barcode_digits);
    }
    None
}

/// Normalize Algerian phone string to canonical 10-digit mobile or 9-digit landline
pub fn normalize_algerian_phone(raw: &str) -> Option<String> {
    let normalized = crate::import::detect::normalize_numeric_string(raw);
    let clean: String = normalized
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+')
        .collect();
    if clean.is_empty() {
        return None;
    }

    let digits_only: String = if clean.starts_with("+213") {
        clean[4..].to_string()
    } else if clean.starts_with("00213") {
        clean[5..].to_string()
    } else if clean.starts_with('0') {
        clean[1..].to_string()
    } else {
        clean.clone()
    };

    // Mobile: 9 digits starting with 5, 6, 7 -> canonical 10 digits (05/06/07)
    if digits_only.len() == 9 && digits_only.starts_with(['5', '6', '7']) {
        return Some(format!("0{}", digits_only));
    }

    // Landline: 8 digits starting with 2, 3, 4 -> canonical 9 digits (02x/03x/04x)
    if digits_only.len() == 8 && digits_only.starts_with(['2', '3', '4']) {
        return Some(format!("0{}", digits_only));
    }

    // Already 10 digits starting with 0
    if clean.len() == 10 && clean.starts_with('0') {
        return Some(clean);
    }

    None
}

/// Parse and normalize inventory stock quantity string
pub fn parse_quantity_cell(raw: &str) -> f64 {
    parse_quantity_cell_checked(raw).unwrap_or(0.0)
}

fn parse_quantity_cell_checked(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }

    let lower = trimmed.to_lowercase();
    if lower == "en stock" || lower == "disponible" || lower == "متوفر" || lower == "in stock" || lower == "oui" || lower == "yes" {
        return Some(1.0);
    }
    if lower == "rupture" || lower == "épuisé" || lower == "epuise" || lower == "non disponible" || lower == "out of stock" || lower == "غير متوفر" || lower == "non" || lower == "no" {
        return Some(0.0);
    }

    // Fold arabic-indic digits and clean whitespace
    let folded = fold_arabic_indic_digits(
        &crate::import::detect::normalize_arabic_numeric_separators(trimmed),
    );
    let stripped = folded
        .replace("pcs", "")
        .replace("pieces", "")
        .replace("pièces", "")
        .replace("unités", "")
        .replace("unites", "")
        .replace("boîtes", "")
        .replace("boites", "")
        .replace("cartons", "")
        .replace("carton", "")
        .replace("paquets", "")
        .replace("paquet", "")
        .replace("kg", "")
        .replace("g", "")
        .replace("u", "")
        .replace(' ', "");

    let normalized = stripped.replace(',', ".");
    normalized.parse::<f64>().ok()
}

/// Detect foreign currency markers in money cells
pub fn detect_foreign_currency(raw: &str) -> Option<&'static str> {
    let upper = raw.to_uppercase();
    if upper.contains('$') || upper.contains("USD") {
        Some("USD")
    } else if upper.contains('€') || upper.contains("EUR") {
        Some("EUR")
    } else if upper.contains('£') || upper.contains("GBP") {
        Some("GBP")
    } else {
        None
    }
}

/// Parse warranty string into months and whether warranty is explicitly disabled
pub fn parse_warranty_cell(raw: &str) -> (Option<i64>, bool) {
    let trimmed = raw.trim().to_lowercase();
    if trimmed.is_empty() {
        return (None, false);
    }
    if trimmed == "0"
        || trimmed == "sans"
        || trimmed == "aucune"
        || trimmed == "non"
        || trimmed == "بدون ضمان"
        || trimmed == "لا يوجد"
    {
        return (Some(0), true);
    }
    // Check years: e.g. "1 an", "2 ans", "1 year"
    if trimmed.contains("an") || trimmed.contains("year") || trimmed.contains("سنة") || trimmed.contains("عام") {
        let clean: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
        if let Ok(years) = clean.parse::<i64>() {
            return (Some(years * 12), false);
        }
    }
    // Check months: e.g. "6 mois", "12 mois", "3 m", "شهر"
    let clean: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
    if let Ok(months) = clean.parse::<i64>() {
        return (Some(months), false);
    }
    (None, false)
}

/// Parse and normalize price/money string to dual-unit (minor centimes + DZD whole)
pub fn parse_money_cell(
    raw: &str,
    dot_inference: ThousandDotInference,
) -> Result<(i64, i64), ImportError> {
    let folded = fold_arabic_indic_digits(
        &crate::import::detect::normalize_arabic_numeric_separators(raw.trim()),
    );
    if let Some(currency) = detect_foreign_currency(&folded) {
        return Err(ImportError::Other(format!(
            "Foreign currency {currency} requires an explicit DZD conversion"
        )));
    }
    let mut cleaned = folded
        .replace("د.ج", "")
        .replace("دج", "")
        .replace("Dzd", "")
        .replace("dzd", "")
        .replace("DZD", "")
        .replace("da", "")
        .replace("DA", "")
        .replace([' ', '\u{00A0}', '\u{202F}', '\u{2009}'], "");

    if cleaned.is_empty() {
        return Ok((0, 0));
    }

    // Check for accounting negative format: (1500) or (1500.50)
    let is_accounting_negative = cleaned.starts_with('(') && cleaned.ends_with(')');
    if is_accounting_negative {
        cleaned = cleaned[1..cleaned.len() - 1].to_string();
    }
    let is_negative = is_accounting_negative || cleaned.starts_with('-');
    if cleaned.starts_with('-') {
        cleaned = cleaned[1..].to_string();
    }

    // Smart separator disambiguation:
    if cleaned.contains(',') && cleaned.contains('.') {
        let first_comma = cleaned.find(',').unwrap();
        let first_dot = cleaned.find('.').unwrap();
        if first_comma < first_dot {
            // e.g. 12,500.50 (US/Arabic folded) -> comma is thousands, dot is decimal
            cleaned = cleaned.replace(',', "");
        } else {
            // e.g. 12.500,50 (French/European) -> dot is thousands, comma is decimal
            cleaned = cleaned.replace('.', "").replace(',', ".");
        }
    } else if cleaned.contains(',') {
        // Only commas present:
        let parts: Vec<&str> = cleaned.split(',').collect();
        if parts.len() > 2 || (parts.len() == 2 && parts[1].len() == 3 && dot_inference == ThousandDotInference::ThousandsDot) {
            cleaned = cleaned.replace(',', "");
        } else {
            cleaned = cleaned.replace(',', ".");
        }
    } else if cleaned.contains('.') {
        // Only dots present: apply column-level thousand dot rule
        if dot_inference == ThousandDotInference::ThousandsDot {
            cleaned = cleaned.replace('.', "");
        }
    }

    let money = Money::from_user_input(&cleaned)
        .map_err(|e| ImportError::Other(format!("Money parsing failed for '{}' (cleaned='{}'): {:?}", raw, cleaned, e)))?;

    let minor = if is_negative {
        -money.to_minor()
    } else {
        money.to_minor()
    };
    // Convert minor centimes to integer DZD via half-up rounding
    let dzd = if is_negative {
        -money.mul_div_half_up(1, 100).map(|m| m.to_minor()).unwrap_or(money.to_minor() / 100)
    } else {
        money.mul_div_half_up(1, 100).map(|m| m.to_minor()).unwrap_or(money.to_minor() / 100)
    };

    Ok((minor, dzd))
}

/// Infer product category from title keywords (conforming to POS CategoryType)
pub fn infer_category_from_title(title: &str) -> String {
    let lower = title.to_lowercase();
    if lower.contains("câble") || lower.contains("cable") || lower.contains("hdmi") || lower.contains("cordon") || lower.contains("usb-c") || lower.contains("lightning") {
        "Câbles".to_string()
    } else if lower.contains("chargeur") || lower.contains("adaptateur") || lower.contains("secteur") || lower.contains("charger") {
        "Chargeurs".to_string()
    } else if lower.contains("écouteur") || lower.contains("ecouteur") || lower.contains("casque") || lower.contains("audio") || lower.contains("enceinte") || lower.contains("airpod") || lower.contains("bluetooth") {
        "Audio".to_string()
    } else if lower.contains("batterie externe") || lower.contains("power bank") || lower.contains("powerbank") || lower.contains("batterie") {
        "Batteries Externes".to_string()
    } else if lower.contains("support") || lower.contains("refroidissement") || lower.contains("stand") || lower.contains("trépied") || lower.contains("holder") {
        "Supports".to_string()
    } else if lower.contains("verre") || lower.contains("film") || lower.contains("hydrogel") || lower.contains("protection") || lower.contains("protecteur") || lower.contains("vitre") {
        "Protège-Écran".to_string()
    } else if lower.contains("coque") || lower.contains("étui") || lower.contains("etui") || lower.contains("cover") || lower.contains("silicone") {
        if lower.contains("samsung") || lower.contains("galaxy") {
            "Coques Samsung".to_string()
        } else if lower.contains("google") || lower.contains("pixel") {
            "Coques Google".to_string()
        } else {
            "Coques iPhone".to_string()
        }
    } else {
        "Tous les produits".to_string()
    }
}

/// Infer brand from title keywords
pub fn infer_brand_from_title(title: &str) -> String {
    let lower = title.to_lowercase();
    if lower.contains("apple") || lower.contains("iphone") || lower.contains("ipad") || lower.contains("macbook") || lower.contains("airpod") {
        "Apple".to_string()
    } else if lower.contains("samsung") || lower.contains("galaxy") {
        "Samsung".to_string()
    } else if lower.contains("xiaomi") || lower.contains("redmi") || lower.contains("poco") {
        "Xiaomi".to_string()
    } else if lower.contains("huawei") || lower.contains("honor") {
        "Huawei".to_string()
    } else if lower.contains("google") || lower.contains("pixel") {
        "Google".to_string()
    } else {
        "Autre".to_string()
    }
}

/// Compute SHA-256 idempotency key for staged row
pub fn compute_idempotency_key(batch_id: &str, row_idx: usize, key_payload: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(batch_id.as_bytes());
    hasher.update(row_idx.to_be_bytes());
    hasher.update(key_payload.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Sniff column data type from actual cell values
pub fn sniff_column_content(
    header_val: &str,
    rows: &[Vec<String>],
    col_idx: usize,
) -> (ColumnType, f64, String) {
    let normalized_header = header_val.to_lowercase().replace(['_', '-', '.', ':', '/', '\\'], " ");
    if normalized_header.split_whitespace().any(|token| {
        matches!(token, "date" | "dates" | "échéance" | "echeance" | "created" | "updated")
    }) {
        return (
            ColumnType::Ignored,
            0.0,
            "Date-like header is not an importable entity field".to_string(),
        );
    }

    let mut sample_values = Vec::new();
    for row in rows.iter().take(50) {
        if let Some(val) = row.get(col_idx) {
            let t = val.trim();
            if !t.is_empty() {
                sample_values.push(t.to_string());
            }
        }
    }

    if sample_values.is_empty() {
        return (ColumnType::Ignored, 0.0, "Empty column".to_string());
    }

    let total = sample_values.len() as f64;

    // 1. Check Phone: count how many normalize to valid Algerian phone
    let phone_count = sample_values
        .iter()
        .filter(|v| {
            let value = v.trim();
            let parts: Vec<&str> = value.split(['-', '/']).collect();
            let date_shaped = parts.len() == 3
                && ((parts[0].len() == 4 && parts[1].len() <= 2 && parts[2].len() <= 2)
                    || (parts[2].len() == 4 && parts[0].len() <= 2 && parts[1].len() <= 2));
            !date_shaped && normalize_algerian_phone(value).is_some()
        })
        .count();
    if (phone_count as f64) / total >= 0.70 {
        return (
            ColumnType::Phone,
            0.90,
            format!("Content sniffer: {}/{} values are Algerian phone numbers", phone_count, total as usize),
        );
    }

    // 2. Check Barcode: count valid EAN-13, UPC-A, EAN-8
    let barcode_count = sample_values
        .iter()
        .filter(|v| crate::import::detect::is_valid_barcode(v))
        .count();
    if (barcode_count as f64) / total >= 0.70 {
        return (
            ColumnType::Barcode,
            0.90,
            format!("Content sniffer: {}/{} values are valid barcodes", barcode_count, total as usize),
        );
    }

    // 3. Check 15-digit / 20-digit IMEI vs NIF
    let (fiscal_type, fiscal_conf) = crate::import::detect::analyze_15_digit_column(&sample_values);
    if fiscal_conf >= 0.85 {
        return (
            fiscal_type,
            fiscal_conf,
            "Content sniffer: 15-digit values classified by Luhn rate".to_string(),
        );
    }

    // 4. Check Email
    let email_count = sample_values
        .iter()
        .filter(|v| {
            let t = v.trim();
            t.contains('@') && t.contains('.') && !t.contains(' ')
        })
        .count();
    if (email_count as f64) / total >= 0.60 {
        return (
            ColumnType::Email,
            0.95,
            format!("Content sniffer: {}/{} values are email addresses", email_count, total as usize),
        );
    }

    // 5. Check Quantity with explicit units or stock status
    let qty_explicit_count = sample_values
        .iter()
        .filter(|v| {
            let l = v.trim().to_lowercase();
            l.contains("pcs")
                || l.contains("piece")
                || l.contains("pièce")
                || l.contains("unité")
                || l.contains("boite")
                || l.contains("carton")
                || l == "en stock"
                || l == "disponible"
                || l == "rupture"
                || l == "متوفر"
                || l == "غير متوفر"
        })
        .count();
    if (qty_explicit_count as f64) / total >= 0.50 {
        return (
            ColumnType::Quantity,
            0.95,
            format!("Content sniffer: {}/{} values have stock units or status", qty_explicit_count, total as usize),
        );
    }

    // 6. Check Currency / Price
    let price_count = sample_values
        .iter()
        .filter(|v| parse_money_cell(v, ThousandDotInference::None).is_ok())
        .count();
    if (price_count as f64) / total >= 0.70 {
        return (
            ColumnType::Price,
            0.75,
            format!("Content sniffer: {}/{} values parse as currency", price_count, total as usize),
        );
    }

    // 7. Text content (names / titles / supplier keywords)
    let is_mostly_text = sample_values
        .iter()
        .filter(|v| v.chars().any(|c| c.is_alphabetic()))
        .count();
    if (is_mostly_text as f64) / total >= 0.70 {
        let supplier_keywords = [
            "sarl", "eurl", "ets", "grossiste", "import", "export",
            "distributeur", "fournisseur", "societe", "spa", "snc", "distribution",
            "مورد", "موزع", "شركة", "ش.ذ.م.م", "تجارة جملة", "تاجر جملة", "استيراد", "تصدير", "مؤسسة",
        ];
        let has_supplier_kw = sample_values.iter().any(|v| {
            let l = v.to_lowercase();
            let folded = crate::import::detect::fold_arabic_orthography(&l);
            supplier_keywords.iter().any(|&kw| l.contains(kw) || folded.contains(kw))
        });
        if has_supplier_kw {
            return (
                ColumnType::SupplierName,
                0.85,
                "Content sniffer: company keywords matching supplier".to_string(),
            );
        }

        let product_keywords = [
            "cable", "câble", "chargeur", "souris", "clavier", "ecran", "écran", "batterie",
            "coque", "verre", "connecteur", "adaptateur", "casque", "ecouteur", "écouteur",
            "iphone", "samsung", "redmi", "xiaomi", "oppo", "huawei", "pro", "max", "ultra",
            "usb", "type-c", "type c", "lightning", "sans fil", "bluetooth", "support",
            "carte", "cle usb", "clé usb", "go", "gb", "mah", "watt", "w",
        ];
        let has_product_kw = sample_values.iter().any(|v| {
            let l = v.to_lowercase();
            product_keywords.iter().any(|&kw| l.contains(kw))
        });
        if has_product_kw {
            return (
                ColumnType::Title,
                0.85,
                "Content sniffer: vocabulary matching product catalog titles".to_string(),
            );
        }

        return (
            ColumnType::CustomerName,
            0.75,
            "Content sniffer: textual data matching names/designations".to_string(),
        );
    }

    (ColumnType::Ignored, 0.0, "Unrecognized content".to_string())
}

/// Match and map columns from parsed table
pub fn map_table_columns(table: &ParsedTable) -> (EntityType, Vec<ColumnMatchScore>, Vec<ImportWarning>) {
    let mut warnings = table.warnings.clone();
    let mut column_scores = Vec::new();
    let mut detected_types = Vec::new();

    for (col_idx, header) in table.headers.iter().enumerate() {
        let (mut col_type, mut conf) = match_header_synonym(header);
        let mut reasons = Vec::new();

        if conf >= AUTO_MAP_THRESHOLD {
            reasons.push(format!("Header '{}' matched synonym for {:?}", header, col_type));
            let (sniffed_type, sniffed_conf, reason) =
                sniff_column_content(header, &table.rows, col_idx);
            if sniffed_conf >= 0.80 && sniffed_type != col_type {
                reasons.push(format!(
                    "Content sample suggests {:?} ({}) but the explicit header mapping was retained",
                    sniffed_type, reason
                ));
            }
        } else {
            // Run content sniffer across column rows
            let (sniffed_type, sniffed_conf, reason) =
                sniff_column_content(header, &table.rows, col_idx);
            if sniffed_conf > conf {
                col_type = sniffed_type;
                conf = sniffed_conf;
                reasons.push(reason);
            } else {
                reasons.push(format!("Unrecognized or low-confidence header '{}'", header));
            }
        }

        detected_types.push(col_type);

        let samples: Vec<String> = table
            .rows
            .iter()
            .filter_map(|r| r.get(col_idx).map(|s| s.trim()))
            .filter(|s| !s.is_empty())
            .take(3)
            .map(|s| s.to_string())
            .collect();

        column_scores.push(
            ColumnMatchScore::new(
                col_idx,
                header.clone(),
                col_type.as_str().to_string(),
                conf,
                reasons,
            )
            .with_samples(samples),
        );
    }

    // Disambiguate multi-price & quantity columns if present
    let price_col_indices: Vec<usize> = detected_types
        .iter()
        .enumerate()
        .filter(|(_, &t)| t == ColumnType::Price)
        .map(|(i, _)| i)
        .collect();

    // Case 1: If 2 or more price columns exist, check if one of them is actually Quantity (small integer counts)
    let has_explicit_qty = detected_types.contains(&ColumnType::Quantity);
    if !has_explicit_qty && price_col_indices.len() >= 2 {
        for &col_idx in &price_col_indices {
            let mut small_int_count = 0;
            let mut total_samples = 0;
            for row in table.rows.iter().take(25) {
                if let Some(cell) = row.get(col_idx) {
                    let t = cell.trim();
                    if !t.is_empty() {
                        total_samples += 1;
                        if let Ok(n) = t.parse::<i64>() {
                            if (0..=1000).contains(&n) {
                                small_int_count += 1;
                            }
                        }
                    }
                }
            }
            if total_samples >= 2 && small_int_count == total_samples {
                // All sampled rows are integers between 0 and 1000 -> Map to Quantity!
                detected_types[col_idx] = ColumnType::Quantity;
                column_scores[col_idx].mapped_column = ColumnType::Quantity.as_str().to_string();
                column_scores[col_idx].confidence = 0.90;
                column_scores[col_idx].category = ConfidenceCategory::AutoMap;
                column_scores[col_idx].reasons.push("Disambiguation: integer values in 0..1000 range mapped to Quantity".to_string());
                break;
            }
        }
    }

    // Re-filter price columns after possible quantity deduction
    let price_col_indices: Vec<usize> = detected_types
        .iter()
        .enumerate()
        .filter(|(_, &t)| t == ColumnType::Price)
        .map(|(i, _)| i)
        .collect();

    // Case 2: Exactly 2 price columns (e.g. Retail and Cost, or Tarif 1 and Tarif 2)
    if price_col_indices.len() == 2 {
        let p1_idx = price_col_indices[0];
        let p2_idx = price_col_indices[1];

        let mut p1_greater_count = 0;
        let mut p2_greater_count = 0;
        let mut p1_values = Vec::new();
        let mut p2_values = Vec::new();

        for row in table.rows.iter().take(50) {
            let v1 = row.get(p1_idx).and_then(|s| parse_money_cell(s, ThousandDotInference::None).ok()).map(|(_, dzd)| dzd).unwrap_or(0);
            let v2 = row.get(p2_idx).and_then(|s| parse_money_cell(s, ThousandDotInference::None).ok()).map(|(_, dzd)| dzd).unwrap_or(0);

            if v1 > 0 && v2 > 0 {
                p1_values.push(v1);
                p2_values.push(v2);
            }
            if v1 > v2 && v2 > 0 {
                p1_greater_count += 1;
            } else if v2 > v1 && v1 > 0 {
                p2_greater_count += 1;
            }
        }

        let lower_idx = if p1_greater_count > p2_greater_count {
            Some(p2_idx)
        } else if p2_greater_count > p1_greater_count {
            Some(p1_idx)
        } else {
            p1_values.sort_unstable();
            p2_values.sort_unstable();
            let median1 = p1_values.get(p1_values.len() / 2).copied();
            let median2 = p2_values.get(p2_values.len() / 2).copied();
            match (median1, median2) {
                (Some(a), Some(b)) if a < b => Some(p1_idx),
                (Some(a), Some(b)) if b < a => Some(p2_idx),
                _ => {
                    warnings.push(ImportWarning {
                        code: "PriceColumnOrderAmbiguous".to_string(),
                        message: "Two price columns have no consistent lower-price ordering; confirm cost and selling price mappings.".to_string(),
                    });
                    None
                }
            }
        };

        if lower_idx == Some(p2_idx) {
            // p1 is higher (Retail Selling Price), p2 is lower (Purchase Cost Price)
            detected_types[p2_idx] = ColumnType::CostPrice;
            column_scores[p2_idx].mapped_column = ColumnType::CostPrice.as_str().to_string();
            column_scores[p2_idx].confidence = 0.90;
            column_scores[p2_idx].category = ConfidenceCategory::AutoMap;
            column_scores[p2_idx].reasons.push("Automatic price ordering: lower price mapped to CostPrice (Buying Price)".to_string());
        } else if lower_idx == Some(p1_idx) {
            // p2 is higher (Retail Selling Price), p1 is lower (Purchase Cost Price)
            detected_types[p1_idx] = ColumnType::CostPrice;
            column_scores[p1_idx].mapped_column = ColumnType::CostPrice.as_str().to_string();
            column_scores[p1_idx].confidence = 0.90;
            column_scores[p1_idx].category = ConfidenceCategory::AutoMap;
            column_scores[p1_idx].reasons.push("Automatic price ordering: lower price mapped to CostPrice (Buying Price)".to_string());
        }
    } else if price_col_indices.len() >= 3 {
        // Multi-price ordering check: if headers are Prix 1, Prix 2, Prix 3
        let p1_idx = price_col_indices[0];
        let p2_idx = price_col_indices[1];
        let p3_idx = price_col_indices[2];

        let mut descending_count = 0;
        let mut ascending_count = 0;
        for row in table.rows.iter().take(15) {
            let v1 = row.get(p1_idx).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
            let v2 = row.get(p2_idx).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
            let v3 = row.get(p3_idx).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);

            if v1 > v2 && v2 > v3 && v3 > 0.0 {
                descending_count += 1;
            } else if v3 > v2 && v2 > v1 && v1 > 0.0 {
                ascending_count += 1;
            }
        }

        if descending_count >= 2 {
            // P1 (highest) -> Retail, P2 (middle) -> Wholesale, P3 (lowest) -> CostPrice
            detected_types[p3_idx] = ColumnType::CostPrice;
            column_scores[p3_idx].mapped_column = ColumnType::CostPrice.as_str().to_string();
            column_scores[p3_idx].confidence = 0.90;
            column_scores[p3_idx].category = ConfidenceCategory::AutoMap;
            column_scores[p3_idx].reasons.push("Inverted multi-price ordering: smallest price mapped to CostPrice".to_string());

            detected_types[p2_idx] = ColumnType::WholesalePrice;
            column_scores[p2_idx].mapped_column = ColumnType::WholesalePrice.as_str().to_string();
            column_scores[p2_idx].confidence = 0.90;
            column_scores[p2_idx].category = ConfidenceCategory::AutoMap;
            column_scores[p2_idx].reasons.push("Inverted multi-price ordering: middle price mapped to WholesalePrice".to_string());
        } else if ascending_count >= 2 {
            // P1 (lowest) -> CostPrice, P2 (middle) -> Wholesale, P3 (highest) -> Retail Price
            detected_types[p1_idx] = ColumnType::CostPrice;
            column_scores[p1_idx].mapped_column = ColumnType::CostPrice.as_str().to_string();
            column_scores[p1_idx].confidence = 0.90;
            column_scores[p1_idx].category = ConfidenceCategory::AutoMap;
            column_scores[p1_idx].reasons.push("Ascending multi-price ordering: smallest price mapped to CostPrice".to_string());

            detected_types[p2_idx] = ColumnType::WholesalePrice;
            column_scores[p2_idx].mapped_column = ColumnType::WholesalePrice.as_str().to_string();
            column_scores[p2_idx].confidence = 0.90;
            column_scores[p2_idx].category = ConfidenceCategory::AutoMap;
            column_scores[p2_idx].reasons.push("Ascending multi-price ordering: middle price mapped to WholesalePrice".to_string());
        }
    }

    let (entity, _, entity_warnings) =
        crate::import::detect::detect_table_entity(&table.headers, &detected_types, &table.rows);
    warnings.extend(entity_warnings);

    (entity, column_scores, warnings)
}

pub fn column_type_from_str(s: &str) -> ColumnType {
    match s {
        "barcode" => ColumnType::Barcode,
        "sku" => ColumnType::Sku,
        "title" => ColumnType::Title,
        "price" => ColumnType::Price,
        "cost_price" => ColumnType::CostPrice,
        "wholesale_price" => ColumnType::WholesalePrice,
        "quantity" => ColumnType::Quantity,
        "min_stock" => ColumnType::MinStock,
        "category" => ColumnType::Category,
        "brand" => ColumnType::Brand,
        "compatible_model" => ColumnType::CompatibleModel,
        "warranty" => ColumnType::Warranty,
        "supplier_name" => ColumnType::SupplierName,
        "supplier_phone" => ColumnType::SupplierPhone,
        "customer_name" => ColumnType::CustomerName,
        "phone" => ColumnType::Phone,
        "secondary_phone" => ColumnType::SecondaryPhone,
        "email" => ColumnType::Email,
        "address" => ColumnType::Address,
        "notes" => ColumnType::Notes,
        "debt_balance" => ColumnType::DebtBalance,
        "imei" => ColumnType::Imei,
        "nif" => ColumnType::Nif,
        "repair_fault" => ColumnType::RepairFault,
        "repair_device" => ColumnType::RepairDevice,
        "repair_deposit" => ColumnType::RepairDeposit,
        _ => ColumnType::Ignored,
    }
}

/// Stage all rows in a parsed table into normalized StagingRows ready for `import_staging.db`
pub fn stage_table(
    table: &ParsedTable,
    batch_id: &str,
    live_ro_conn: Option<&Connection>,
) -> Result<(Vec<StagingRow>, EntityType, Vec<ImportWarning>), ImportError> {
    stage_table_with_overrides(table, batch_id, live_ro_conn, None, None)
}

/// Stage all rows in a parsed table with optional explicit entity type and column overrides
pub fn stage_table_with_overrides(
    table: &ParsedTable,
    batch_id: &str,
    live_ro_conn: Option<&Connection>,
    entity_override: Option<&str>,
    column_overrides: Option<&HashMap<usize, String>>,
) -> Result<(Vec<StagingRow>, EntityType, Vec<ImportWarning>), ImportError> {
    let (detected_entity_type, col_scores, warnings) = map_table_columns(table);
    let mut entity_type = detected_entity_type;

    if let Some(eo) = entity_override {
        if !matches!(
            detected_entity_type,
            EntityType::ActiveRepairs
                | EntityType::CustomerDebts
                | EntityType::SerializedImeis
                | EntityType::TradeIns
        ) {
            match eo {
                "products" => entity_type = EntityType::Products,
                "opening_stock" => entity_type = EntityType::OpeningStock,
                "customers" => entity_type = EntityType::Customers,
                "customer_debts" => entity_type = EntityType::CustomerDebts,
                "suppliers" => entity_type = EntityType::Suppliers,
                _ => {}
            }
        }
    }

    // Build index lookup map for columns
    let mut col_map: HashMap<ColumnType, usize> = HashMap::new();
    let mut dot_inferences: HashMap<usize, ThousandDotInference> = HashMap::new();

    for score in &col_scores {
        let ctype = column_type_from_str(&score.mapped_column);
        col_map.insert(ctype, score.column_index);

        // Precompute thousand-dot inference for price and debt columns
        if matches!(ctype, ColumnType::Price | ColumnType::CostPrice | ColumnType::WholesalePrice | ColumnType::DebtBalance) {
            let col_vals: Vec<String> = table
                .rows
                .iter()
                .filter_map(|r| r.get(score.column_index).cloned())
                .collect();
            let (inf, _) = infer_column_thousand_dot(&col_vals);
            dot_inferences.insert(score.column_index, inf);
        }
    }

    // Apply explicit column overrides if supplied by user
    if let Some(overrides) = column_overrides {
        for (&col_idx, mapped_str) in overrides {
            let overridden_type = column_type_from_str(mapped_str);
            if overridden_type != ColumnType::Ignored {
                col_map.insert(overridden_type, col_idx);
                if matches!(overridden_type, ColumnType::Price | ColumnType::CostPrice | ColumnType::WholesalePrice | ColumnType::DebtBalance) {
                    let col_vals: Vec<String> = table
                        .rows
                        .iter()
                        .filter_map(|r| r.get(col_idx).cloned())
                        .collect();
                    let (inf, _) = infer_column_thousand_dot(&col_vals);
                    dot_inferences.insert(col_idx, inf);
                }
            } else {
                col_map.retain(|_, &mut idx| idx != col_idx);
            }
        }
    }

    let mut staged_rows = Vec::new();
    let mut phone_counts: HashMap<String, usize> = HashMap::new();
    let mut email_counts: HashMap<String, usize> = HashMap::new();
    let mut barcode_counts: HashMap<String, usize> = HashMap::new();
    let mut sku_counts: HashMap<String, usize> = HashMap::new();
    let mut imei_counts: HashMap<String, usize> = HashMap::new();
    let mut supplier_name_counts: HashMap<String, usize> = HashMap::new();

    // Performance: prepare cached statements once outside the loop for high-throughput live conflict probing
    let mut product_stmt = if col_map.contains_key(&ColumnType::Barcode) {
        live_ro_conn
            .map(|conn| conn.prepare_cached("SELECT id FROM products WHERE barcode = ?1 LIMIT 1"))
            .transpose()?
    } else {
        None
    };
    let mut product_sku_stmt = if col_map.contains_key(&ColumnType::Sku) {
        live_ro_conn
            .map(|conn| conn.prepare_cached("SELECT id FROM products WHERE sku = ?1 LIMIT 1"))
            .transpose()?
    } else {
        None
    };
    let mut product_title_stmt = if !col_map.contains_key(&ColumnType::Barcode)
        && !col_map.contains_key(&ColumnType::Sku)
    {
        live_ro_conn
            .map(|conn| conn.prepare_cached("SELECT id FROM products WHERE LOWER(TRIM(title)) = LOWER(TRIM(?1)) LIMIT 1"))
            .transpose()?
    } else {
        None
    };
    let mut product_stock_stmt = if col_map.contains_key(&ColumnType::Quantity) {
        live_ro_conn
            .map(|conn| {
                conn.prepare_cached(
                    "SELECT p.stock, COALESCE(SUM(sb.quantity_remaining), 0) \
                     FROM products p LEFT JOIN stock_batches sb \
                       ON sb.product_id = p.id AND sb.deleted = 0 \
                     WHERE p.id = ?1 AND p.deleted = 0 GROUP BY p.id",
                )
            })
            .transpose()?
    } else {
        None
    };
    let imei_table_exists = live_ro_conn
        .map(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'imei_records')",
                [],
                |row| row.get::<_, bool>(0),
            )
        })
        .transpose()?
        .unwrap_or(false);
    let mut imei_record_stmt = if imei_table_exists
        && (col_map.contains_key(&ColumnType::Imei) || col_map.contains_key(&ColumnType::Barcode))
    {
        live_ro_conn
            .map(|conn| conn.prepare_cached("SELECT product_id FROM imei_records WHERE imei = ?1 LIMIT 1"))
            .transpose()?
    } else {
        None
    };
    let mut customer_stmt = if col_map.contains_key(&ColumnType::Phone) {
        live_ro_conn
            .map(|conn| conn.prepare_cached("SELECT id FROM customers WHERE phone = ?1 AND deleted = 0"))
            .transpose()?
    } else {
        None
    };
    let mut customer_email_stmt = if col_map.contains_key(&ColumnType::Email) {
        live_ro_conn
            .map(|conn| conn.prepare_cached("SELECT id FROM customers WHERE LOWER(TRIM(email)) = LOWER(TRIM(?1)) AND deleted = 0"))
            .transpose()?
    } else {
        None
    };
    let existing_supplier_directory = if entity_type == EntityType::Suppliers {
        if let Some(conn) = live_ro_conn {
            let directory_json: Option<String> = conn
                .query_row(
                    "SELECT value_json FROM app_settings WHERE key = 'vendor_directory'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            directory_json
                .map(|json| serde_json::from_str(&json))
                .transpose()?
                .unwrap_or_default()
        } else {
            serde_json::Map::new()
        }
    } else {
        serde_json::Map::new()
    };

    for raw_cells in &table.rows {
        if entity_type == EntityType::Products || entity_type == EntityType::OpeningStock {
            let raw_imei = col_map
                .get(&ColumnType::Imei)
                .and_then(|&index| raw_cells.get(index))
                .map(String::as_str)
                .unwrap_or_default();
            let raw_barcode = col_map
                .get(&ColumnType::Barcode)
                .and_then(|&index| raw_cells.get(index))
                .map(String::as_str)
                .unwrap_or_default();
            if let Some(imei) = import_imei_identity(raw_imei, raw_barcode) {
                *imei_counts.entry(imei).or_insert(0) += 1;
            }
        }
        if let Some(&phone_idx) = col_map.get(&ColumnType::Phone) {
            let phone = raw_cells
                .get(phone_idx)
                .and_then(|raw| normalize_algerian_phone(raw))
                .unwrap_or_default();
            if !phone.is_empty() {
                *phone_counts.entry(phone).or_insert(0) += 1;
            }
            if entity_type == EntityType::Suppliers {
                if let Some(name_index) = col_map
                    .get(&ColumnType::SupplierName)
                    .or_else(|| col_map.get(&ColumnType::CustomerName))
                    .or_else(|| col_map.get(&ColumnType::Title))
                {
                    if let Some(name) = raw_cells
                        .get(*name_index)
                        .map(|value| normalize_supplier_name(value))
                        .filter(|name| !name.is_empty())
                    {
                        *supplier_name_counts.entry(name).or_insert(0) += 1;
                    }
                }
            }
        }
        if let Some(&email_idx) = col_map.get(&ColumnType::Email) {
            if let Some(email) = raw_cells
                .get(email_idx)
                .map(|value| value.trim().to_lowercase())
                .filter(|value| !value.is_empty())
            {
                *email_counts.entry(email).or_insert(0) += 1;
            }
        }
    }

    for (row_idx, raw_cells) in table.rows.iter().enumerate() {
        let raw_row_json = serde_json::to_string(raw_cells)?;
        let mut row_warnings = Vec::new();
        let mut normalized_payload = json!({});
        let mut action = StagingRowAction::Create;
        let mut matched_id = None;
        let mut needs_review = false;
        let scientific_identity_loss = [ColumnType::Barcode, ColumnType::Imei]
            .iter()
            .filter_map(|column| col_map.get(column).and_then(|index| raw_cells.get(*index)))
            .any(|value| crate::import::detect::is_scientific_notation(value));

        // Check if row has raw formula strings like =SUM(...)
        for cell in raw_cells {
            if cell.starts_with('=') || cell.starts_with('@') {
                row_warnings.push(ImportWarning {
                    code: "FormulaPrefixWarning".to_string(),
                    message: format!("Cell contains formula syntax: {}", cell),
                });
            }
        }

        match entity_type {
            EntityType::Products | EntityType::OpeningStock | EntityType::SerializedImeis => {
                let mut raw_title = col_map
                    .get(&ColumnType::Title)
                    .or_else(|| col_map.get(&ColumnType::CustomerName))
                    .and_then(|&i| raw_cells.get(i))
                    .map(|s| s.trim())
                    .unwrap_or("");

                // Fallback: if raw_title is empty, search unmapped cells for alphabetic text
                if raw_title.is_empty() {
                    for (c_idx, cell) in raw_cells.iter().enumerate() {
                        let is_mapped = col_map.values().any(|&v| v == c_idx);
                        if !is_mapped && cell.chars().any(|c| c.is_alphabetic()) && cell.trim().len() >= 2 {
                            raw_title = cell.trim();
                            break;
                        }
                    }
                }

                let raw_barcode = col_map
                    .get(&ColumnType::Barcode)
                    .and_then(|&i| raw_cells.get(i))
                    .map(|s| s.as_str())
                    .unwrap_or_default();
                let (barcode, secondary_barcode) = crate::import::detect::extract_primary_barcode(raw_barcode);

                let raw_sku = col_map
                    .get(&ColumnType::Sku)
                    .and_then(|&i| raw_cells.get(i))
                    .map(|s| s.as_str())
                    .unwrap_or_default();
                let sku = crate::import::detect::normalize_numeric_string(raw_sku);

                let raw_imei = col_map
                    .get(&ColumnType::Imei)
                    .and_then(|&i| raw_cells.get(i))
                    .map(|s| s.as_str())
                    .unwrap_or_default();
                let clean_imei_digits: String = raw_imei.chars().filter(|c| c.is_ascii_digit()).collect();
                let imei = if clean_imei_digits.len() == 15 {
                    if crate::import::detect::luhn_check_imei(&clean_imei_digits) {
                        clean_imei_digits
                    } else {
                        row_warnings.push(ImportWarning {
                            code: "InvalidImeiLuhnChecksum".to_string(),
                            message: format!("IMEI '{}' has an invalid Luhn check digit; this row is quarantined.", raw_imei),
                        });
                        action = StagingRowAction::Reject;
                        needs_review = true;
                        clean_imei_digits
                    }
                } else if !raw_imei.is_empty() {
                    let norm = crate::import::detect::normalize_numeric_string(raw_imei);
                    let norm_digits: String = norm.chars().filter(|c| c.is_ascii_digit()).collect();
                    if norm_digits.len() == 15 {
                        norm_digits
                    } else {
                        norm
                    }
                } else {
                    String::new()
                };

                let clean_barcode_digits: String = barcode.chars().filter(|c| c.is_ascii_digit()).collect();
                let barcode_is_imei = clean_barcode_digits.len() == 15 && crate::import::detect::luhn_check_imei(&clean_barcode_digits);

                let is_serialized = !imei.is_empty() || barcode_is_imei;
                let imei_number = if !imei.is_empty() {
                    Some(imei.clone())
                } else if barcode_is_imei {
                    Some(clean_barcode_digits)
                } else {
                    None
                };

                if let Some(imei) = imei_number.as_deref() {
                    if imei_counts.get(imei).copied().unwrap_or_default() > 1 {
                        row_warnings.push(ImportWarning {
                            code: "DuplicateImeiInSource".to_string(),
                            message: "This IMEI appears more than once in the source file; all matching rows are quarantined.".to_string(),
                        });
                        action = StagingRowAction::Reject;
                        needs_review = true;
                    }
                    if let Some(stmt) = imei_record_stmt.as_mut() {
                        let registered: Option<String> =
                            stmt.query_row([imei], |row| row.get(0)).optional()?;
                        if registered.is_some() {
                            row_warnings.push(ImportWarning {
                                code: "ImeiAlreadyRegistered".to_string(),
                                message: "This IMEI is already registered to a device; its product link and warranty cannot be changed by import.".to_string(),
                            });
                            action = StagingRowAction::Reject;
                            needs_review = true;
                        }
                    }
                }

                if raw_title.is_empty() && barcode.is_empty() && sku.is_empty() && imei.is_empty() {
                    action = StagingRowAction::Skip;
                    row_warnings.push(ImportWarning {
                        code: "EmptyProductRow".to_string(),
                        message: "Ligne vide ou sans identification de produit — ignorée.".to_string(),
                    });
                } else if raw_title.is_empty() {
                    action = StagingRowAction::Reject;
                    needs_review = true;
                    row_warnings.push(ImportWarning {
                        code: "MissingProductName".to_string(),
                        message: "Le nom du produit est obligatoire; cette ligne est mise en quarantaine.".to_string(),
                    });
                }

                let title = if !raw_title.is_empty() {
                    raw_title.to_string()
                } else if !barcode.is_empty() {
                    format!("Article {}", barcode)
                } else if !sku.is_empty() {
                    format!("Article {}", sku)
                } else if !imei.is_empty() {
                    format!("Téléphone {}", imei)
                } else {
                    format!("Produit {}", row_idx + 1)
                };

                let raw_brand = col_map.get(&ColumnType::Brand).and_then(|&i| raw_cells.get(i)).map(|s| s.trim()).filter(|s| !s.is_empty()).map(|s| s.to_string());
                let brand = Some(raw_brand.unwrap_or_else(|| infer_brand_from_title(&title)));
                let compatible_model = col_map.get(&ColumnType::CompatibleModel).and_then(|&i| raw_cells.get(i)).cloned();
                let raw_category = col_map.get(&ColumnType::Category).and_then(|&i| raw_cells.get(i)).map(|s| s.trim()).filter(|s| !s.is_empty()).map(|s| s.to_string());
                let category = Some(raw_category.unwrap_or_else(|| infer_category_from_title(&title)));

                let vendor_name = col_map
                    .get(&ColumnType::SupplierName)
                    .and_then(|&i| raw_cells.get(i))
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());

                let vendor_phone = col_map
                    .get(&ColumnType::SupplierPhone)
                    .and_then(|&i| raw_cells.get(i))
                    .and_then(|s| normalize_algerian_phone(s));

                // Validate barcode if present
                if !barcode.is_empty() {
                    let b_count = barcode_counts.entry(barcode.clone()).or_insert(0);
                    *b_count += 1;
                    if *b_count > 1 {
                        row_warnings.push(ImportWarning {
                            code: "DuplicateBarcodeInBatch".to_string(),
                            message: format!("Barcode '{}' appears multiple times in this file (row {})", barcode, row_idx + 1),
                        });
                        needs_review = true;
                        action = StagingRowAction::Reject;
                    }

                    // Check GS1 (01) fail closed
                    if barcode.starts_with("(01)") {
                        row_warnings.push(ImportWarning {
                            code: "Gs1CompositeRejected".to_string(),
                            message: "GS1 AI composite barcode string cannot be imported directly".to_string(),
                        });
                        action = StagingRowAction::Reject;
                    } else if barcode.ends_with("000000") && barcode.len() == 13 {
                        row_warnings.push(ImportWarning {
                            code: "BarcodePrecisionLossSuspected".to_string(),
                            message: "Barcode appears truncated by Excel scientific notation".to_string(),
                        });
                        needs_review = true;
                    }
                }

                if !sku.is_empty() {
                    let s_count = sku_counts.entry(sku.clone()).or_insert(0);
                    *s_count += 1;
                    if *s_count > 1 {
                        row_warnings.push(ImportWarning {
                            code: "DuplicateSkuInBatch".to_string(),
                            message: format!("SKU '{}' appears multiple times in this file (row {})", sku, row_idx + 1),
                        });
                        needs_review = true;
                        action = StagingRowAction::Reject;
                    }
                }

                // Retail Price
                let price_raw = col_map
                    .get(&ColumnType::Price)
                    .and_then(|&i| raw_cells.get(i))
                    .map(|s| s.as_str());

                let price_raw = price_raw.unwrap_or("");
                let price_inf = col_map
                    .get(&ColumnType::Price)
                    .and_then(|i| dot_inferences.get(i).copied())
                    .unwrap_or(ThousandDotInference::None);
                let (price_minor, price_dzd) = match parse_money_cell(price_raw, price_inf) {
                    Ok((minor, dzd)) if minor >= 0 && !price_raw.trim().is_empty() => (minor, dzd),
                    Ok(_) => {
                        row_warnings.push(ImportWarning {
                            code: "InvalidSellingPrice".to_string(),
                            message: "Selling price is missing or negative; this row is quarantined.".to_string(),
                        });
                        action = StagingRowAction::Reject;
                        needs_review = true;
                        (0, 0)
                    }
                    Err(error) => {
                        row_warnings.push(ImportWarning {
                            code: if detect_foreign_currency(price_raw).is_some() {
                                "ForeignCurrencyDetected".to_string()
                            } else {
                                "InvalidSellingPrice".to_string()
                            },
                            message: format!("Selling price cannot be safely imported: {error}"),
                        });
                        action = StagingRowAction::Reject;
                        needs_review = true;
                        (0, 0)
                    }
                };

                // Cost Price
                let mut cost_unknown = 0;
                let (cost_minor, cost_dzd) = if let Some(&cost_col_idx) = col_map.get(&ColumnType::CostPrice) {
                    let cost_raw = raw_cells.get(cost_col_idx).map(|s| s.as_str()).unwrap_or("");
                    let cost_inf = dot_inferences.get(&cost_col_idx).copied().unwrap_or(ThousandDotInference::None);
                    if cost_raw.trim().is_empty() || cost_raw.trim() == "0" {
                        cost_unknown = 1;
                        (0, 0)
                    } else {
                        match parse_money_cell(cost_raw, cost_inf) {
                            Ok((minor, dzd)) if minor >= 0 => (minor, dzd),
                            Ok(_) => {
                                row_warnings.push(ImportWarning {
                                    code: "InvalidCostPrice".to_string(),
                                    message: "Cost price cannot be negative; this row is quarantined.".to_string(),
                                });
                                action = StagingRowAction::Reject;
                                needs_review = true;
                                (0, 0)
                            }
                            Err(error) => {
                                row_warnings.push(ImportWarning {
                                    code: if detect_foreign_currency(cost_raw).is_some() {
                                        "ForeignCurrencyDetected".to_string()
                                    } else {
                                        "InvalidCostPrice".to_string()
                                    },
                                    message: format!("Cost price cannot be safely imported: {error}"),
                                });
                                action = StagingRowAction::Reject;
                                needs_review = true;
                                (0, 0)
                            }
                        }
                    }
                } else {
                    cost_unknown = 1;
                    (0, 0)
                };

                // Selling below cost warning
                if cost_unknown == 0 && cost_dzd > price_dzd && price_dzd > 0 {
                    row_warnings.push(ImportWarning {
                        code: "SellingBelowCostWarning".to_string(),
                        message: format!("Cost price ({} DZD) exceeds retail price ({} DZD)", cost_dzd, price_dzd),
                    });
                    needs_review = true;
                }

                // Catalog quantities are integer snapshots; an empty cell does not overwrite live stock.
                let quantity_raw = col_map
                    .get(&ColumnType::Quantity)
                    .and_then(|&i| raw_cells.get(i))
                    .map(String::as_str)
                    .unwrap_or("");
                let stock_provided = col_map.contains_key(&ColumnType::Quantity)
                    && !quantity_raw.trim().is_empty();
                let parsed_qty = if stock_provided {
                    parse_quantity_cell_checked(quantity_raw)
                } else {
                    Some(0.0)
                };
                let raw_qty = match parsed_qty {
                    Some(value) if value.is_finite() && value >= 0.0 => {
                        if value.fract() != 0.0 {
                            row_warnings.push(ImportWarning {
                                code: "FractionalStockRounded".to_string(),
                                message: "Stock is stored as a whole-unit count; fractional quantity will be rounded to the nearest unit.".to_string(),
                            });
                            needs_review = true;
                        }
                        value
                    }
                    _ => {
                        row_warnings.push(ImportWarning {
                            code: "InvalidStockQuantity".to_string(),
                            message: "Stock quantity must be a non-negative whole number; this row is quarantined.".to_string(),
                        });
                        action = StagingRowAction::Reject;
                        needs_review = true;
                        0.0
                    }
                };
                let qty = if is_serialized && !stock_provided { 1.0 } else { raw_qty };

                // Warranty
                let (warranty_months, warranty_explicitly_disabled) = if let Some(&w_idx) = col_map.get(&ColumnType::Warranty) {
                    let raw_w = raw_cells.get(w_idx).map(|s| s.as_str()).unwrap_or("");
                    parse_warranty_cell(raw_w)
                } else {
                    (None, false)
                };

                // Resolve both stable identifiers; conflicting matches are quarantined.
                let barcode_match = if barcode.is_empty() {
                    None
                } else if let Some(stmt) = product_stmt.as_mut() {
                    stmt.query_row([&barcode], |r| r.get::<_, String>(0)).optional()?
                } else {
                    None
                };
                let sku_match = if sku.is_empty() {
                    None
                } else if let Some(stmt) = product_sku_stmt.as_mut() {
                    stmt.query_row([&sku], |r| r.get::<_, String>(0)).optional()?
                } else {
                    None
                };

                match (barcode_match, sku_match) {
                    (Some(barcode_id), Some(sku_id)) if barcode_id != sku_id => {
                        row_warnings.push(ImportWarning {
                            code: "ConflictingProductIdentity".to_string(),
                            message: "Barcode and SKU identify different existing products; this row is quarantined.".to_string(),
                        });
                        action = StagingRowAction::Reject;
                    }
                    (Some(id), _) | (_, Some(id)) => {
                        if action != StagingRowAction::Reject {
                            action = StagingRowAction::Update;
                            matched_id = Some(id);
                        }
                    }
                    (None, None) if barcode.is_empty() && sku.is_empty() && !title.is_empty() && !title.starts_with("Produit ") => {
                        if let Some(stmt) = product_title_stmt.as_mut() {
                            if let Some(id) = stmt
                                .query_row([&title], |r| r.get::<_, String>(0))
                                .optional()?
                            {
                                action = StagingRowAction::Update;
                                matched_id = Some(id);
                            }
                        }
                    }
                    _ => {}
                }

                if stock_provided && qty > 0.0 && cost_unknown != 0 {
                    let mut reason = "A positive stock snapshot requires an explicit unit cost; this row is quarantined.".to_string();
                    let mut code = "MissingUnitCostForStockIncrease";
                    if action == StagingRowAction::Update {
                        if let (Some(target_id), Some(stmt)) =
                            (matched_id.as_deref(), product_stock_stmt.as_mut())
                        {
                            let state: Option<(i64, f64)> = stmt
                                .query_row([target_id], |row| Ok((row.get(0)?, row.get(1)?)))
                                .optional()?;
                            if let Some((current_stock, batch_quantity)) = state {
                                if (batch_quantity - current_stock as f64).abs() > 0.000_001 {
                                    code = "StockBatchProjectionMismatch";
                                    reason = "Current stock does not reconcile with FIFO batches; reconcile inventory before importing a snapshot.".to_string();
                                } else if qty.round() as i64 <= current_stock {
                                    code = "";
                                    reason.clear();
                                }
                            }
                        }
                    }
                    if !code.is_empty() {
                        row_warnings.push(ImportWarning {
                            code: code.to_string(),
                            message: reason,
                        });
                        action = StagingRowAction::Reject;
                        needs_review = true;
                    }
                }

                normalized_payload = json!({
                    "title": title,
                    "barcode": barcode,
                    "secondary_barcode": secondary_barcode,
                    "sku": sku,
                    "brand": brand,
                    "compatible_model": compatible_model,
                    "category": category,
                    "price": { "minor": price_minor, "dzd": price_dzd },
                    "cost_price": { "minor": cost_minor, "dzd": cost_dzd },
                    "cost_unknown": cost_unknown,
                    "opening_stock": qty,
                    "stock_provided": stock_provided,
                    "warranty_months": warranty_months,
                    "warranty_explicitly_disabled": warranty_explicitly_disabled,
                    "is_serialized": is_serialized,
                    "imei_number": imei_number,
                    "vendor_name": vendor_name,
                    "vendor_phone": vendor_phone
                });
            }

            EntityType::Customers => {
                let mut raw_name = col_map
                    .get(&ColumnType::CustomerName)
                    .or_else(|| col_map.get(&ColumnType::Title))
                    .and_then(|&i| raw_cells.get(i))
                    .map(|s| s.trim())
                    .unwrap_or("");

                // Fallback: if raw_name is empty, search unmapped cells for alphabetic text
                if raw_name.is_empty() {
                    for (c_idx, cell) in raw_cells.iter().enumerate() {
                        let is_mapped = col_map.values().any(|&v| v == c_idx);
                        if !is_mapped && cell.chars().any(|c| c.is_alphabetic()) && cell.trim().len() >= 2 {
                            raw_name = cell.trim();
                            break;
                        }
                    }
                }

                let raw_phone = col_map
                    .get(&ColumnType::Phone)
                    .and_then(|&i| raw_cells.get(i))
                    .map(|s| s.as_str())
                    .unwrap_or("");

                let phone = normalize_algerian_phone(raw_phone).unwrap_or_default();
                let raw_secondary_phone = col_map
                    .get(&ColumnType::SecondaryPhone)
                    .and_then(|&i| raw_cells.get(i))
                    .map(String::as_str)
                    .unwrap_or("");
                let secondary_phone =
                    normalize_algerian_phone(raw_secondary_phone).unwrap_or_default();
                let email = col_map
                    .get(&ColumnType::Email)
                    .and_then(|&i| raw_cells.get(i))
                    .map(|value| value.trim().to_lowercase())
                    .filter(|value| !value.is_empty());
                let address = col_map
                    .get(&ColumnType::Address)
                    .and_then(|&i| raw_cells.get(i))
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty());
                let notes = col_map
                    .get(&ColumnType::Notes)
                    .and_then(|&i| raw_cells.get(i))
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty());
                let debt_column_present = col_map.contains_key(&ColumnType::DebtBalance);

                if raw_name.is_empty() && phone.is_empty() {
                    action = StagingRowAction::Skip;
                    row_warnings.push(ImportWarning {
                        code: "EmptyCustomerRow".to_string(),
                        message: "Ligne vide (sans nom ni téléphone valide) — ignorée.".to_string(),
                    });
                } else if raw_name.is_empty() {
                    action = StagingRowAction::Reject;
                    row_warnings.push(ImportWarning {
                        code: "MissingCustomerName".to_string(),
                        message: "Le nom du client est obligatoire; cette ligne est mise en quarantaine.".to_string(),
                    });
                }
                if debt_column_present {
                    action = StagingRowAction::Reject;
                    needs_review = true;
                    row_warnings.push(ImportWarning {
                        code: "DebtRequiresDedicatedDestination".to_string(),
                        message: "A customer profile import cannot change debt; select the dedicated debt destination.".to_string(),
                    });
                }

                let name = if !raw_name.is_empty() {
                    raw_name.to_string()
                } else if !phone.is_empty() {
                    format!("Client {}", phone)
                } else {
                    format!("Client {}", row_idx + 1)
                };

                if !phone.is_empty() {
                    if phone_counts.get(&phone).copied().unwrap_or(0) > 1 {
                        row_warnings.push(ImportWarning {
                            code: "AmbiguousSharedPhone".to_string(),
                            message: format!("Phone {} is shared across multiple customer names", phone),
                        });
                        needs_review = true;
                        action = StagingRowAction::Reject;
                    }
                }
                if let Some(email_value) = email.as_deref() {
                    if email_counts.get(email_value).copied().unwrap_or(0) > 1 {
                        row_warnings.push(ImportWarning {
                            code: "DuplicateEmailInBatch".to_string(),
                            message: format!("Email '{}' appears multiple times in this file", email_value),
                        });
                        needs_review = true;
                        action = StagingRowAction::Reject;
                    }
                }

                let phone_matches = if phone.is_empty() {
                    Vec::new()
                } else if let Some(stmt) = customer_stmt.as_mut() {
                    stmt.query_map([&phone], |r| r.get::<_, String>(0))?
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    Vec::new()
                };
                let email_matches = if let Some(email_value) = email.as_deref() {
                    if let Some(stmt) = customer_email_stmt.as_mut() {
                        stmt.query_map([email_value], |r| r.get::<_, String>(0))?
                            .collect::<Result<Vec<_>, _>>()?
                    } else {
                        Vec::new()
                    }
                } else {
                    Vec::new()
                };
                if phone_matches.len() > 1 || email_matches.len() > 1 {
                    row_warnings.push(ImportWarning {
                        code: "AmbiguousExistingCustomerIdentity".to_string(),
                        message: "Phone or email matches multiple existing clients; this row is quarantined.".to_string(),
                    });
                    action = StagingRowAction::Reject;
                    needs_review = true;
                } else {
                    match (phone_matches.first(), email_matches.first()) {
                    (Some(phone_id), Some(email_id)) if phone_id != email_id => {
                        row_warnings.push(ImportWarning {
                            code: "ConflictingCustomerIdentity".to_string(),
                            message: "Phone and email identify different existing clients; this row is quarantined.".to_string(),
                        });
                        action = StagingRowAction::Reject;
                    }
                    (Some(id), _) | (_, Some(id)) => {
                        if action != StagingRowAction::Reject {
                            action = StagingRowAction::Update;
                            matched_id = Some(id.clone());
                        }
                    }
                    _ => {}
                    }
                }

                normalized_payload = json!({
                    "name": name,
                    "phone": phone,
                    "secondary_phone": secondary_phone,
                    "email": email,
                    "address": address,
                    "notes": notes,
                    "profile_fields": {
                        "name": !raw_name.is_empty(),
                        "phone": !raw_phone.trim().is_empty(),
                        "secondary_phone": !raw_secondary_phone.trim().is_empty(),
                        "email": email.is_some(),
                        "address": address.is_some(),
                        "notes": notes.is_some()
                    },
                    "debt_column_present": debt_column_present
                });
            }

            EntityType::CustomerDebts => {
                let name = col_map
                    .get(&ColumnType::CustomerName)
                    .or_else(|| col_map.get(&ColumnType::Title))
                    .and_then(|&i| raw_cells.get(i))
                    .map(|value| value.trim())
                    .unwrap_or_default();
                let raw_phone = col_map
                    .get(&ColumnType::Phone)
                    .and_then(|&i| raw_cells.get(i))
                    .map(String::as_str)
                    .unwrap_or_default();
                let phone = normalize_algerian_phone(raw_phone).unwrap_or_default();
                let email = col_map
                    .get(&ColumnType::Email)
                    .and_then(|&i| raw_cells.get(i))
                    .map(|value| value.trim().to_lowercase())
                    .filter(|value| !value.is_empty());

                if phone.is_empty() && email.is_none() {
                    action = StagingRowAction::Reject;
                    needs_review = true;
                    row_warnings.push(ImportWarning {
                        code: "MissingCustomerDebtIdentity".to_string(),
                        message: "A debt snapshot must identify the customer by phone or email.".to_string(),
                    });
                }
                if name.is_empty() {
                    action = StagingRowAction::Reject;
                    needs_review = true;
                    row_warnings.push(ImportWarning {
                        code: "MissingCustomerName".to_string(),
                        message: "A customer name is required for a debt snapshot.".to_string(),
                    });
                }
                if phone_counts.get(&phone).copied().unwrap_or(0) > 1 && !phone.is_empty() {
                    action = StagingRowAction::Reject;
                    needs_review = true;
                    row_warnings.push(ImportWarning {
                        code: "AmbiguousSharedPhone".to_string(),
                        message: format!("Phone {phone} is shared across multiple source rows."),
                    });
                }
                if let Some(email_value) = email.as_deref() {
                    if email_counts.get(email_value).copied().unwrap_or(0) > 1 {
                        action = StagingRowAction::Reject;
                        needs_review = true;
                        row_warnings.push(ImportWarning {
                            code: "DuplicateEmailInBatch".to_string(),
                            message: format!("Email '{email_value}' appears multiple times in this file."),
                        });
                    }
                }

                let phone_matches = if phone.is_empty() {
                    Vec::new()
                } else if let Some(stmt) = customer_stmt.as_mut() {
                    stmt.query_map([&phone], |row| row.get::<_, String>(0))?
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    Vec::new()
                };
                let email_matches = if let Some(email_value) = email.as_deref() {
                    if let Some(stmt) = customer_email_stmt.as_mut() {
                        stmt.query_map([email_value], |row| row.get::<_, String>(0))?
                            .collect::<Result<Vec<_>, _>>()?
                    } else {
                        Vec::new()
                    }
                } else {
                    Vec::new()
                };

                if phone_matches.len() > 1 || email_matches.len() > 1 {
                    action = StagingRowAction::Reject;
                    needs_review = true;
                    row_warnings.push(ImportWarning {
                        code: "AmbiguousExistingCustomerIdentity".to_string(),
                        message: "Phone or email matches multiple existing clients.".to_string(),
                    });
                } else if let (Some(phone_id), Some(email_id)) =
                    (phone_matches.first(), email_matches.first())
                {
                    if phone_id != email_id {
                        action = StagingRowAction::Reject;
                        needs_review = true;
                        row_warnings.push(ImportWarning {
                            code: "ConflictingCustomerIdentity".to_string(),
                            message: "Phone and email identify different existing clients.".to_string(),
                        });
                    } else {
                        matched_id = Some(phone_id.clone());
                        action = StagingRowAction::Update;
                    }
                } else if let Some(id) = phone_matches.first().or_else(|| email_matches.first()) {
                    matched_id = Some(id.clone());
                    action = StagingRowAction::Update;
                }

                let debt_amount = col_map
                    .get(&ColumnType::DebtBalance)
                    .and_then(|&index| raw_cells.get(index))
                    .map(|raw| {
                        let inference = dot_inferences
                            .get(&col_map[&ColumnType::DebtBalance])
                            .copied()
                            .unwrap_or(ThousandDotInference::None);
                        parse_money_cell(raw, inference)
                    });
                let balance = match debt_amount {
                    Some(Ok((_, value))) if value >= 0 => value,
                    Some(Ok(_)) => {
                        action = StagingRowAction::Reject;
                        needs_review = true;
                        row_warnings.push(ImportWarning {
                            code: "InvalidDebtSnapshot".to_string(),
                            message: "Debt snapshots must be non-negative.".to_string(),
                        });
                        0
                    }
                    Some(Err(error)) => {
                        action = StagingRowAction::Reject;
                        needs_review = true;
                        row_warnings.push(ImportWarning {
                            code: "InvalidDebtSnapshot".to_string(),
                            message: format!("Debt balance cannot be safely imported: {error}"),
                        });
                        0
                    }
                    None => {
                        action = StagingRowAction::Reject;
                        needs_review = true;
                        row_warnings.push(ImportWarning {
                            code: "MissingDebtSnapshot".to_string(),
                            message: "Map a debt balance column to import an opening-balance snapshot.".to_string(),
                        });
                        0
                    }
                };

                if action == StagingRowAction::Update {
                    if let (Some(conn), Some(target_id)) = (live_ro_conn, matched_id.as_deref()) {
                        let cached_and_ledger: Option<(Option<i64>, i64)> = conn
                            .query_row(
                                "SELECT current_debt, MAX(0, CAST(ROUND(COALESCE((SELECT SUM(CASE \
                                   WHEN type = 'DEBT_ACQUIRED' THEN amount \
                                   WHEN type = 'PAYMENT_SETTLED' THEN -amount ELSE 0 END) \
                                   FROM customer_debts WHERE customer_id = customers.id AND deleted = 0), 0)) AS INTEGER)) \
                                 FROM customers WHERE id = ?1 AND deleted = 0",
                                [target_id],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            )
                            .optional()?;
                        if let Some((cached, ledger)) = cached_and_ledger {
                            let cached = cached.unwrap_or(0);
                            if cached != ledger {
                                action = StagingRowAction::Reject;
                                needs_review = true;
                                row_warnings.push(ImportWarning {
                                    code: "CustomerDebtLedgerCacheMismatch".to_string(),
                                    message: "The customer's cached debt differs from the ledger; reconcile it before importing.".to_string(),
                                });
                            } else if balance == ledger {
                                action = StagingRowAction::Skip;
                                row_warnings.push(ImportWarning {
                                    code: "DebtSnapshotAlreadyMatches".to_string(),
                                    message: "The imported snapshot already matches the verified debt balance.".to_string(),
                                });
                            } else if ledger != 0 {
                                action = StagingRowAction::Reject;
                                needs_review = true;
                                row_warnings.push(ImportWarning {
                                    code: "DebtSnapshotRequiresReconciliation".to_string(),
                                    message: "A non-zero ledger cannot be replaced by a snapshot; reconcile the source history first.".to_string(),
                                });
                            }
                        }
                    }
                }
                if action != StagingRowAction::Skip {
                    row_warnings.push(ImportWarning {
                        code: "DebtSnapshotUsesImportTime".to_string(),
                        message: "No source date was supplied; the opening entry will use the actual import time.".to_string(),
                    });
                }

                normalized_payload = json!({
                    "name": name,
                    "phone": phone,
                    "email": email,
                    "balance": balance,
                    "snapshot_mode": "opening_balance"
                });
            }

            EntityType::Suppliers => {
                let mut raw_name = col_map
                    .get(&ColumnType::SupplierName)
                    .or_else(|| col_map.get(&ColumnType::CustomerName))
                    .or_else(|| col_map.get(&ColumnType::Title))
                    .and_then(|&i| raw_cells.get(i))
                    .map(|s| s.trim())
                    .unwrap_or_default();

                // Fallback: if raw_name is empty, search unmapped cells for alphabetic text
                if raw_name.is_empty() {
                    for (c_idx, cell) in raw_cells.iter().enumerate() {
                        let is_mapped = col_map.values().any(|&v| v == c_idx);
                        if !is_mapped && cell.chars().any(|c| c.is_alphabetic()) && cell.trim().len() >= 2 {
                            raw_name = cell.trim();
                            break;
                        }
                    }
                }

                let raw_phone = col_map
                    .get(&ColumnType::SupplierPhone)
                    .or_else(|| col_map.get(&ColumnType::Phone))
                    .and_then(|&i| raw_cells.get(i))
                    .map(|s| s.as_str())
                    .unwrap_or_default();
                let phone = normalize_algerian_phone(raw_phone).unwrap_or_default();

                let email = col_map.get(&ColumnType::Email).and_then(|&i| raw_cells.get(i)).map(|s| s.trim().to_string());
                let address = col_map.get(&ColumnType::Address).and_then(|&i| raw_cells.get(i)).map(|s| s.trim().to_string());
                let notes = col_map.get(&ColumnType::Notes).and_then(|&i| raw_cells.get(i)).map(|s| s.trim().to_string());

                if raw_name.is_empty() && phone.is_empty() {
                    action = StagingRowAction::Skip;
                    row_warnings.push(ImportWarning {
                        code: "EmptySupplierRow".to_string(),
                        message: "Ligne vide ou sans identification de fournisseur — ignorée.".to_string(),
                    });
                } else if entity_override != Some("suppliers") {
                    action = StagingRowAction::Reject;
                    row_warnings.push(ImportWarning {
                        code: "DeferredEntitySuppliers".to_string(),
                        message: "Table contains supplier records (deferred v2 feature). Use explicit Suppliers import mode to import.".to_string(),
                    });
                } else {
                    let normalized_name = normalize_supplier_name(&raw_name);
                    if supplier_name_counts.get(&normalized_name).copied().unwrap_or(0) > 1 {
                        action = StagingRowAction::Reject;
                        needs_review = true;
                        row_warnings.push(ImportWarning {
                            code: "DuplicateSupplierNameInBatch".to_string(),
                            message: "This supplier name appears more than once in the import; resolve the duplicate rows before applying.".to_string(),
                        });
                    } else {
                    let matches: Vec<_> = existing_supplier_directory
                        .iter()
                        .filter(|(key, _)| normalize_supplier_name(key) == normalized_name)
                        .collect();
                    if matches.len() > 1 {
                        action = StagingRowAction::Reject;
                        needs_review = true;
                        row_warnings.push(ImportWarning {
                            code: "AmbiguousSupplierName".to_string(),
                            message: "Multiple supplier directory entries share this normalized name.".to_string(),
                        });
                    } else if let Some((key, existing)) = matches.first() {
                        matched_id = Some((*key).clone());
                        action = StagingRowAction::Update;

                        let supplied_email = email.as_deref().unwrap_or_default().trim();
                        let supplied_address = address.as_deref().unwrap_or_default().trim();
                        let existing_phone = supplier_entry_field(existing, "phone");
                        let existing_email = supplier_entry_field(existing, "email");
                        let existing_address = supplier_entry_field(existing, "address");
                        let phone_conflict = !phone.is_empty()
                            && !existing_phone.trim().is_empty()
                            && normalize_algerian_phone(existing_phone)
                                .as_deref()
                                .map(|value| value != phone)
                                .unwrap_or_else(|| existing_phone.trim() != phone);
                        let email_conflict = !supplied_email.is_empty()
                            && !existing_email.trim().is_empty()
                            && !existing_email.trim().eq_ignore_ascii_case(supplied_email);
                        let address_conflict = !supplied_address.is_empty()
                            && !existing_address.trim().is_empty()
                            && existing_address.trim() != supplied_address;
                        if phone_conflict || email_conflict || address_conflict {
                            action = StagingRowAction::Reject;
                            needs_review = true;
                            row_warnings.push(ImportWarning {
                                code: "ConflictingSupplierContact".to_string(),
                                message: "A supplied non-empty phone, email, or address conflicts with the existing supplier; review the record before applying.".to_string(),
                            });
                        }
                    }
                    }
                }

                let name = if !raw_name.is_empty() {
                    raw_name.to_string()
                } else {
                    format!("Fournisseur {}", phone)
                };

                normalized_payload = json!({
                    "name": name,
                    "phone": phone,
                    "email": email,
                    "address": address,
                    "notes": notes
                });
            }

            _ => {
                // Reject / defer classes (Suppliers, Debts, SAV, IMEI)
                action = StagingRowAction::Reject;
                row_warnings.push(ImportWarning {
                    code: "EntityDeferredFromMVP".to_string(),
                    message: format!("Entity {:?} is deferred to v2 and cannot be staged in MVP", entity_type),
                });
            }
        }

        if scientific_identity_loss {
            row_warnings.push(ImportWarning {
                code: "ScientificNotationIdentityRejected".to_string(),
                message: "Excel converted this to scientific notation; re-export the column as text."
                    .to_string(),
            });
            action = StagingRowAction::Reject;
            needs_review = true;
        }

        let idempotency_key = compute_idempotency_key(batch_id, row_idx, &raw_row_json);

        staged_rows.push(StagingRow {
            batch_id: batch_id.to_string(),
            row_index: row_idx as i64,
            raw_row_json,
            normalized_json: Some(normalized_payload.to_string()),
            action,
            matched_entity_id: matched_id,
            rejection_reason: if action == StagingRowAction::Reject {
                Some(
                    row_warnings
                        .iter()
                        .map(|warning| format!("{}: {}", warning.code, warning.message))
                        .collect::<Vec<_>>()
                        .join("; "),
                )
            } else {
                None
            },
            warnings_json: serde_json::to_string(&row_warnings)?,
            needs_review,
            idempotency_key,
        });
    }

    Ok((staged_rows, entity_type, warnings))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(headers: &[&str], rows: &[&[&str]]) -> ParsedTable {
        ParsedTable {
            file_sha256: "test".to_string(),
            detected_encoding: None,
            headers: headers.iter().map(|header| (*header).to_string()).collect(),
            rows: rows
                .iter()
                .map(|row| row.iter().map(|cell| (*cell).to_string()).collect())
                .collect(),
            original_row_indices: (2..=rows.len() + 1).collect(),
            warnings: Vec::new(),
            sheet_names: Vec::new(),
            active_sheet: String::new(),
        }
    }

    #[test]
    fn parses_dzd_formats_and_rejects_foreign_currency() {
        assert_eq!(
            parse_money_cell("1 450,50 DA", ThousandDotInference::None).unwrap(),
            (145_050, 1_451)
        );
        assert_eq!(
            parse_money_cell("1,250.50 DZD", ThousandDotInference::None).unwrap(),
            (125_050, 1_251)
        );
        assert!(parse_money_cell("€ 10.00", ThousandDotInference::None).is_err());
        assert!(parse_money_cell("$10.00", ThousandDotInference::None).is_err());
        assert_eq!(
            parse_money_cell("١٬٢٥٠٫٥٠ دج", ThousandDotInference::None).unwrap(),
            (125_050, 1_251)
        );
        assert_eq!(parse_quantity_cell("١٬٢٥٠"), 1250.0);
        assert_eq!(parse_quantity_cell("١٢٫٥"), 12.5);
    }

    #[test]
    fn maps_french_import_headers_and_resolves_ambiguous_price_columns() {
        let table = parsed(
            &["Réf Code", "Désignation Article", "P.Achat", "Prix Vente TTC", "Dispo"],
            &[&["SKU-01", "Écran Protège Caméra", "1 000,00 DA", "1 450,50 DA", "8"]],
        );
        let (_, scores, _) = map_table_columns(&table);
        let mapped: Vec<&str> = scores.iter().map(|score| score.mapped_column.as_str()).collect();
        assert_eq!(mapped, ["sku", "title", "cost_price", "price", "quantity"]);

        let table = parsed(
            &["Product", "Price 1", "Price 2", "Stock"],
            &[
                &["Cable A", "100 DA", "150 DA", "4"],
                &["Cable B", "200 DA", "260 DA", "6"],
                &["Cable C", "80 DA", "120 DA", "2"],
            ],
        );
        let (_, scores, _) = map_table_columns(&table);
        assert_eq!(scores[1].mapped_column, "cost_price");
        assert_eq!(scores[2].mapped_column, "price");
    }

    #[test]
    fn preserves_vcard_primary_and_secondary_phones_separately() {
        let table = parsed(
            &[
                "Nom Client",
                "Téléphone",
                "Téléphone secondaire",
                "Email",
                "Adresse",
                "Notes",
            ],
            &[&[
                "Amel Benali",
                "+213 550 12 34 56",
                "0661987654",
                "amel@example.test",
                "12 Rue des Lilas, Alger",
                "Client fidèle",
            ]],
        );

        let (_, scores, _) = map_table_columns(&table);
        assert_eq!(scores[1].mapped_column, "phone");
        assert_eq!(scores[2].mapped_column, "secondary_phone");
        assert_eq!(scores[4].mapped_column, "address");
        assert_eq!(scores[5].mapped_column, "notes");

        let (rows, _, _) =
            stage_table_with_overrides(&table, "batch", None, Some("customers"), None).unwrap();
        let payload: serde_json::Value =
            serde_json::from_str(rows[0].normalized_json.as_deref().unwrap()).unwrap();
        assert_eq!(payload["phone"], "0550123456");
        assert_eq!(payload["secondary_phone"], "0661987654");
        assert_eq!(payload["name"], "Amel Benali");
        assert_eq!(payload["profile_fields"]["address"], true);
        assert_eq!(payload["address"], "12 Rue des Lilas, Alger");
    }

    #[test]
    fn quarantines_debt_columns_from_customer_profile_imports() {
        let table = parsed(
            &["Nom Client", "Téléphone", "Dette Initiale"],
            &[&["Nadia Dette", "0550000101", "1 250,00 DA"]],
        );
        let (rows, entity, _) =
            stage_table_with_overrides(&table, "batch", None, Some("customers"), None).unwrap();
        assert_eq!(entity, EntityType::Customers);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(rows[0]
            .rejection_reason
            .as_deref()
            .unwrap()
            .contains("DebtRequiresDedicatedDestination"));
    }

    #[test]
    fn quarantines_all_duplicate_customer_identities_in_source() {
        let table = parsed(
            &["Nom Client", "Téléphone"],
            &[
                &["Client A", "0550000101"],
                &["Client B", "+213 550 00 01 01"],
            ],
        );
        let (rows, _, _) =
            stage_table_with_overrides(&table, "batch", None, Some("customers"), None).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row.action == StagingRowAction::Reject));

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT, deleted INTEGER DEFAULT 0);
             CREATE TABLE products (id TEXT PRIMARY KEY, title TEXT, sku TEXT, barcode TEXT);
             INSERT INTO customers (id, name, phone) VALUES
               ('c1', 'Client 1', '0550000101'),
               ('c2', 'Client 2', '0550000101');",
        )
        .unwrap();
        let table = parsed(
            &["Nom Client", "Téléphone"],
            &[&["Client Importé", "0550000101"]],
        );
        let (rows, _, _) =
            stage_table_with_overrides(&table, "batch", Some(&conn), Some("customers"), None)
                .unwrap();
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(rows[0]
            .rejection_reason
            .as_deref()
            .unwrap()
            .contains("AmbiguousExistingCustomerIdentity"));
    }

    #[test]
    fn supplier_contacts_match_normalized_names_and_quarantine_conflicts() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
             CREATE TABLE products (id TEXT PRIMARY KEY, title TEXT, sku TEXT, barcode TEXT);
             CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT, deleted INTEGER DEFAULT 0);
             INSERT INTO app_settings (key, value_json) VALUES (
               'vendor_directory',
               '{\"SARL Exemple\":{\"name\":\"SARL Exemple\",\"contact\":{\"phone\":\"0550123456\",\"email\":\"contact@example.test\",\"address\":\"Alger\"}}}'
             );",
        )
        .unwrap();
        let overrides = HashMap::from([
            (0, "supplier_name".to_string()),
            (1, "phone".to_string()),
            (2, "email".to_string()),
            (3, "address".to_string()),
        ]);
        let update_table = parsed(
            &["Fournisseur", "Téléphone", "Email", "Adresse"],
            &[&["sarl   exemple", "0550123456", "CONTACT@example.test", "Alger"]],
        );
        let (rows, entity, _) = stage_table_with_overrides(
            &update_table,
            "batch",
            Some(&conn),
            Some("suppliers"),
            Some(&overrides),
        )
        .unwrap();
        assert_eq!(entity, EntityType::Suppliers);
        assert_eq!(rows[0].action, StagingRowAction::Update);
        assert_eq!(rows[0].matched_entity_id.as_deref(), Some("SARL Exemple"));

        let conflict_table = parsed(
            &["Fournisseur", "Téléphone"],
            &[&["SARL Exemple", "0661987654"]],
        );
        let (rows, _, _) = stage_table_with_overrides(
            &conflict_table,
            "batch",
            Some(&conn),
            Some("suppliers"),
            Some(&HashMap::from([
                (0, "supplier_name".to_string()),
                (1, "phone".to_string()),
            ])),
        )
        .unwrap();
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(rows[0]
            .rejection_reason
            .as_deref()
            .unwrap()
            .contains("ConflictingSupplierContact"));
    }

    #[test]
    fn quarantines_all_duplicate_supplier_names_in_one_import() {
        let table = parsed(
            &["Fournisseur", "Téléphone"],
            &[
                &["SARL Exemple", "0550123456"],
                &["sarl   exemple", "0661987654"],
            ],
        );
        let (rows, _, _) = stage_table_with_overrides(
            &table,
            "batch",
            None,
            Some("suppliers"),
            Some(&HashMap::from([
                (0, "supplier_name".to_string()),
                (1, "phone".to_string()),
            ])),
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row.action == StagingRowAction::Reject));
        assert!(rows.iter().all(|row| row
            .rejection_reason
            .as_deref()
            .unwrap()
            .contains("DuplicateSupplierNameInBatch")));
    }

    #[test]
    fn requires_known_cost_for_positive_stock_and_checks_fifo_projection() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE products (id TEXT PRIMARY KEY, title TEXT, sku TEXT, barcode TEXT, stock INTEGER NOT NULL, deleted INTEGER DEFAULT 0);
             CREATE TABLE stock_batches (batch_id TEXT PRIMARY KEY, product_id TEXT, quantity_remaining REAL, deleted INTEGER DEFAULT 0);
             INSERT INTO products (id, title, sku, barcode, stock) VALUES ('p1', 'Existing', 'SKU-1', '1001', 5);
             INSERT INTO stock_batches (batch_id, product_id, quantity_remaining) VALUES ('b1', 'p1', 5);",
        )
        .unwrap();
        let table = parsed(
            &["SKU", "Désignation Article", "Prix Vente", "Dispo"],
            &[
                &["NEW-1", "New Product", "1000", "5"],
                &["SKU-1", "Existing", "1100", "3"],
                &["SKU-1", "Existing", "1100", "7"],
            ],
        );
        let (rows, _, _) =
            stage_table_with_overrides(&table, "batch", Some(&conn), Some("products"), None)
                .unwrap();
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(rows[0]
            .rejection_reason
            .as_deref()
            .unwrap()
            .contains("MissingUnitCostForStockIncrease"));
        assert_eq!(rows[1].action, StagingRowAction::Update);
        assert_eq!(rows[2].action, StagingRowAction::Reject);
        assert!(rows[2]
            .rejection_reason
            .as_deref()
            .unwrap()
            .contains("MissingUnitCostForStockIncrease"));

        conn.execute(
            "UPDATE stock_batches SET quantity_remaining = 4 WHERE batch_id = 'b1'",
            [],
        )
        .unwrap();
        let reduced_snapshot = parsed(
            &["SKU", "Désignation Article", "Prix Vente", "Dispo"],
            &[&["SKU-1", "Existing", "1100", "3"]],
        );
        let (rows, _, _) = stage_table_with_overrides(
            &reduced_snapshot,
            "batch",
            Some(&conn),
            Some("products"),
            None,
        )
        .unwrap();
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(rows[0]
            .rejection_reason
            .as_deref()
            .unwrap()
            .contains("StockBatchProjectionMismatch"));
    }

    #[test]
    fn quarantines_invalid_prices_and_missing_product_names() {
        let table = parsed(
            &["Désignation Article", "Prix Vente", "Prix Achat", "Dispo", "Code barre"],
            &[
                &["Écran de protection", "800.00 DZD", "500", "3", "6132450019283"],
                &["Chargeur", "prix inconnu", "", "2", "6132450019290"],
                &["", "250.00 DZD", "", "1", "6132450019306"],
                &["Coque", "€ 15.00", "", "1", "6132450019313"],
            ],
        );
        let (rows, _, _) =
            stage_table_with_overrides(&table, "batch", None, Some("products"), None).unwrap();
        assert_eq!(rows[0].action, StagingRowAction::Create);
        assert_eq!(rows[1].action, StagingRowAction::Reject);
        assert!(rows[1].rejection_reason.as_deref().unwrap().contains("InvalidSellingPrice"));
        assert_eq!(rows[2].action, StagingRowAction::Reject);
        assert!(rows[2].rejection_reason.as_deref().unwrap().contains("MissingProductName"));
        assert_eq!(rows[3].action, StagingRowAction::Reject);
        assert!(rows[3].rejection_reason.as_deref().unwrap().contains("ForeignCurrencyDetected"));
    }
}

//! Column & Entity Detection for Smart Import
//!
//! Includes:
//! - Multi-language header synonyms (French, Arabic, English, Algerian retail vernacular).
//! - Column-level statistical sniffers:
//!   - Column-wide Luhn pass-rate: $\ge 90\%$ for `SerializedImeis` vs $\le 35\%$ for `AlgerianNif`.
//!   - GS1 `(01)` composite fail-closed.
//!   - Phone format & role disambiguation (Customer vs Supplier vs Repair).
//!   - Column-level thousand-dot vs decimal classification.
//!   - Multi-price column ordering ($P_{\text{cost}} \le P_{\text{wholesale}} \le P_{\text{retail}}$).
//! - Entity classification (MVP targets: `Products`, `OpeningStock`, `Customers`; Reject classes: `Suppliers`, `CustomerDebts`, `ActiveRepairs`, `SerializedImeis`).

use crate::import::{ColumnType, EntityType, ImportWarning};

pub fn is_scientific_notation(raw: &str) -> bool {
    let normalized = raw.trim().to_ascii_lowercase();
    let Some((significand, exponent)) = normalized
        .split_once('e')
        .filter(|(significand, exponent)| !significand.is_empty() && !exponent.is_empty())
    else {
        return false;
    };
    let exponent_digits = exponent.trim_start_matches(['+', '-']);
    significand.parse::<f64>().is_ok()
        && !exponent_digits.is_empty()
        && exponent_digits
            .chars()
            .all(|character| character.is_ascii_digit())
}

/// Expands scientific notation like "6.13123456789E+12" to "6131234567890" with exact integer precision
pub fn expand_scientific_notation(s: &str) -> Option<String> {
    let lower = s.to_lowercase();
    let parts: Vec<&str> = lower.split('e').collect();
    if parts.len() != 2 {
        return None;
    }

    let significand = parts[0];
    let exp_str = parts[1].trim_start_matches('+');
    let exp: usize = exp_str.parse().ok()?;
    if exp > 25 {
        return None; // Beyond reasonable barcode/IMEI length
    }

    if let Some(dot_idx) = significand.find('.') {
        let int_part = &significand[..dot_idx];
        let frac_part = &significand[dot_idx + 1..];
        if exp >= frac_part.len() {
            let zeros = "0".repeat(exp - frac_part.len());
            Some(format!("{}{}{}", int_part, frac_part, zeros))
        } else {
            Some(format!("{}{}.{}", int_part, &frac_part[..exp], &frac_part[exp..]))
        }
    } else {
        let zeros = "0".repeat(exp);
        Some(format!("{}{}", significand, zeros))
    }
}

/// Normalizes numeric identifiers (barcodes, IMEIs, phones) by:
/// 1. Stripping invisible Unicode characters (\u{200B}, \u{200C}, \u{FEFF}, \u{00A0}, \u{202F})
/// 2. Stripping trailing float ".0" or ",0" (common Excel export artifact)
/// 3. Expanding scientific notation (e.g. 6.13123456789E+12 -> 6131234567890)
pub fn normalize_numeric_string(raw: &str) -> String {
    let s: String = raw
        .chars()
        .filter(|&c| c != '\u{200B}' && c != '\u{200C}' && c != '\u{FEFF}' && c != '\u{00A0}' && c != '\u{202F}')
        .collect();
    let trimmed = s.trim();

    // 1. Strip trailing .0 or ,0 from float conversions
    let without_zero = if trimmed.ends_with(".0") || trimmed.ends_with(",0") {
        &trimmed[..trimmed.len() - 2]
    } else {
        trimmed
    };

    // 2. Expand scientific notation if present and non-negative
    if (without_zero.contains('e') || without_zero.contains('E')) && !without_zero.contains('-') {
        if let Some(expanded) = expand_scientific_notation(without_zero) {
            return expanded;
        }
    }

    without_zero.to_string()
}

/// Check if string is a valid Luhn MOD-10 number (for 15-digit IMEI)
pub fn luhn_check_imei(raw: &str) -> bool {
    let normalized = normalize_numeric_string(raw);
    let clean: String = normalized.chars().filter(|c| c.is_ascii_digit()).collect();
    if clean.len() != 15 {
        return false;
    }
    let mut sum = 0;
    let bytes = clean.as_bytes();
    for i in 0..15 {
        let mut d = (bytes[14 - i] - b'0') as u32;
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    sum % 10 == 0
}

/// Check if string is a valid EAN-13 barcode with correct check digit
pub fn is_valid_ean13(raw: &str) -> bool {
    let normalized = normalize_numeric_string(raw);
    let clean: String = normalized.chars().filter(|c| c.is_ascii_digit()).collect();
    if clean.len() != 13 {
        return false;
    }
    let bytes = clean.as_bytes();
    let mut sum = 0;
    for i in 0..12 {
        let d = (bytes[i] - b'0') as u32;
        if i % 2 == 1 {
            sum += d * 3;
        } else {
            sum += d;
        }
    }
    let check = (10 - (sum % 10)) % 10;
    check == (bytes[12] - b'0') as u32
}

/// Check if string is a valid UPC-A (12-digit) barcode with correct check digit
pub fn is_valid_upc_a(raw: &str) -> bool {
    let normalized = normalize_numeric_string(raw);
    let clean: String = normalized.chars().filter(|c| c.is_ascii_digit()).collect();
    if clean.len() != 12 {
        return false;
    }
    let bytes = clean.as_bytes();
    let mut sum = 0;
    for i in 0..11 {
        let d = (bytes[i] - b'0') as u32;
        if i % 2 == 0 {
            sum += d * 3;
        } else {
            sum += d;
        }
    }
    let check = (10 - (sum % 10)) % 10;
    check == (bytes[11] - b'0') as u32
}

/// Check if string is a valid EAN-8 (8-digit) barcode with correct check digit
pub fn is_valid_ean8(raw: &str) -> bool {
    let normalized = normalize_numeric_string(raw);
    let clean: String = normalized.chars().filter(|c| c.is_ascii_digit()).collect();
    if clean.len() != 8 {
        return false;
    }
    let bytes = clean.as_bytes();
    let mut sum = 0;
    for i in 0..7 {
        let d = (bytes[i] - b'0') as u32;
        if i % 2 == 0 {
            sum += d * 3;
        } else {
            sum += d;
        }
    }
    let check = (10 - (sum % 10)) % 10;
    check == (bytes[7] - b'0') as u32
}

/// Universal barcode validator supporting EAN-13, UPC-A, and EAN-8
pub fn is_valid_barcode(raw: &str) -> bool {
    let normalized = normalize_numeric_string(raw);
    let clean: String = normalized.chars().filter(|c| c.is_ascii_digit()).collect();
    match clean.len() {
        13 => is_valid_ean13(&clean),
        12 => is_valid_upc_a(&clean),
        8 => is_valid_ean8(&clean),
        _ => false,
    }
}

/// Disambiguate 15-digit / 20-digit fiscal columns: column-wide Luhn pass rate distinguishes IMEI from Algerian NIF
pub fn analyze_15_digit_column(values: &[String]) -> (ColumnType, f64) {
    let non_empty: Vec<&str> = values
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    if non_empty.is_empty() {
        return (ColumnType::Ignored, 0.0);
    }

    let mut count_candidates = 0;
    let mut count_luhn_pass = 0;

    for val in &non_empty {
        let normalized = normalize_numeric_string(val);
        let clean: String = normalized.chars().filter(|c| c.is_ascii_digit()).collect();
        // Algerian NIF is 15 digits (20 for branches), while IMEI is strictly 15 digits
        if clean.len() == 15 || clean.len() == 20 {
            count_candidates += 1;
            if clean.len() == 15 && luhn_check_imei(&clean) {
                count_luhn_pass += 1;
            }
        }
    }

    if count_candidates == 0 {
        return (ColumnType::Ignored, 0.0);
    }

    let luhn_rate = (count_luhn_pass as f64) / (count_candidates as f64);

    if luhn_rate >= 0.90 {
        // High Luhn pass rate: IMEI column (Reject/defer class)
        (ColumnType::Imei, 0.95)
    } else if luhn_rate <= 0.35 {
        // Low Luhn pass rate (~10% random chance) or 20-digit branch NIFs: Algerian NIF fiscal ID
        (ColumnType::Nif, 0.90)
    } else {
        (ColumnType::Imei, 0.60) // Ambiguous
    }
}

/// Normalizes Arabic-Indic digits (Eastern Arabic ٠-٩ and Extended ۰-۹) and separators
pub fn fold_arabic_indic_digits(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{0660}' | '\u{06F0}' => '0',
            '\u{0661}' | '\u{06F1}' => '1',
            '\u{0662}' | '\u{06F2}' => '2',
            '\u{0663}' | '\u{06F3}' => '3',
            '\u{0664}' | '\u{06F4}' => '4',
            '\u{0665}' | '\u{06F5}' => '5',
            '\u{0666}' | '\u{06F6}' => '6',
            '\u{0667}' | '\u{06F7}' => '7',
            '\u{0668}' | '\u{06F8}' => '8',
            '\u{0669}' | '\u{06F9}' => '9',
            '\u{066B}' => '.', // Arabic decimal point
            '\u{066C}' => ',', // Arabic thousands separator
            '\u{00A0}' | '\u{202F}' => ' ', // Non-breaking spaces
            other => other,
        })
        .collect()
}

pub fn normalize_arabic_numeric_separators(text: &str) -> String {
    text.chars()
        .filter_map(|character| match character {
            '\u{066C}' => None,
            '\u{066B}' => Some('.'),
            other => Some(other),
        })
        .collect()
}

/// Result of column-level decimal separator analysis
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThousandDotInference {
    /// Dot is definitely a thousands separator (e.g. 45.000, 1.250.000)
    ThousandsDot,
    /// Dot is a standard decimal point (e.g. 12.50, 45.000 where mixed)
    DecimalDot,
    /// Column is ambiguous (e.g. single 45.000 with no other decimals)
    Ambiguous,
    /// No dotted numbers present
    None,
}

/// Extracts primary and optional secondary barcode from a cell containing multiple barcodes
/// e.g. "6132450019289 / 6132450019296" or "6132450019289, 6132450019296"
pub fn extract_primary_barcode(raw: &str) -> (String, Option<String>) {
    let trimmed = raw.trim();
    if trimmed.contains('/') || trimmed.contains('|') || (trimmed.contains(',') && !trimmed.contains('.')) {
        let tokens: Vec<&str> = trimmed
            .split(&['/', '|', ','][..])
            .map(|t| t.trim())
            .filter(|t| !t.is_empty())
            .collect();
        let mut valid_barcodes = Vec::new();
        for t in tokens {
            let norm = normalize_numeric_string(t);
            if is_valid_barcode(&norm) || (norm.len() >= 6 && norm.chars().all(|c| c.is_ascii_digit())) {
                valid_barcodes.push(norm);
            }
        }
        if !valid_barcodes.is_empty() {
            let primary = valid_barcodes[0].clone();
            let secondary = if valid_barcodes.len() > 1 {
                Some(valid_barcodes[1].clone())
            } else {
                None
            };
            return (primary, secondary);
        }
    }
    let norm = normalize_numeric_string(trimmed);
    (norm, None)
}

/// Folds Arabic orthographic variants and strips Tashkeel diacritics
pub fn fold_arabic_orthography(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            // Strip Tashkeel (harakat) and Tatweel
            '\u{064B}'..='\u{065F}' | '\u{0640}' => {}
            // Fold Hamza variants to bare Alif
            '\u{0622}' | '\u{0623}' | '\u{0625}' | '\u{0671}' => out.push('\u{0627}'),
            // Fold Taa Marbuta to Haa
            '\u{0629}' => out.push('\u{0647}'),
            // Fold Alif Maqsura to Yaa
            '\u{0649}' => out.push('\u{064A}'),
            other => out.push(other),
        }
    }
    out
}

#[inline]
pub fn is_thousands_grouped_dotted(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() < 2 {
        return false;
    }
    let first = parts[0];
    if first.is_empty() || first.len() > 3 || !first.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    parts[1..].iter().all(|p| p.len() == 3 && p.chars().all(|c| c.is_ascii_digit()))
}

#[inline]
pub fn is_one_or_two_decimal_dotted(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 2 {
        return false;
    }
    let first = parts[0];
    let second = parts[1];
    !first.is_empty()
        && first.chars().all(|c| c.is_ascii_digit())
        && (second.len() == 1 || second.len() == 2)
        && second.chars().all(|c| c.is_ascii_digit())
}

/// Infer whether `.` in a numeric/currency column represents thousands or decimal
pub fn infer_column_thousand_dot(values: &[String]) -> (ThousandDotInference, f64) {
    let mut dotted_count = 0;
    let mut exactly_three_decimals = 0;
    let mut one_or_two_decimals = 0;

    for v in values {
        let folded = fold_arabic_indic_digits(v.trim());
        let clean = folded.replace(' ', "").replace("DA", "").replace("دج", "").replace("د.ج", "");
        if clean.contains('.') && !clean.contains(',') {
            dotted_count += 1;
            if is_thousands_grouped_dotted(&clean) {
                exactly_three_decimals += 1;
            } else if is_one_or_two_decimal_dotted(&clean) {
                one_or_two_decimals += 1;
            }
        }
    }

    if dotted_count == 0 {
        return (ThousandDotInference::None, 1.0);
    }

    if one_or_two_decimals > 0 {
        // If any number has 1 or 2 decimals (e.g. 12.50), dot is a decimal point across the column!
        (ThousandDotInference::DecimalDot, 0.95)
    } else if exactly_three_decimals == dotted_count && dotted_count >= 3 {
        // Every single dotted value has strictly 3 digits and sample size >= 3 -> Thousands grouping!
        (ThousandDotInference::ThousandsDot, 0.95)
    } else if exactly_three_decimals == dotted_count {
        // Small sample (1-2 rows) -> Ambiguous, needs user confirmation
        (ThousandDotInference::Ambiguous, 0.70)
    } else {
        (ThousandDotInference::Ambiguous, 0.50)
    }
}

/// Header synonym mapping table with weights
pub fn match_header_synonym(header: &str) -> (ColumnType, f64) {
    let h = header.trim().to_lowercase();
    let h = h.replace(['_', '-', '.', ':', '\'', '(', ')', '[', ']', '/', '\\'], " ");
    let tokens: Vec<&str> = h.split_whitespace().collect();

    // 1. Barcode / Code barre / EAN
    if tokens.iter().any(|&t| t == "barcode" || t == "cb" || t == "ean" || t == "codebarre" || t == "upc")
        || (tokens.contains(&"code") && tokens.contains(&"barre"))
        || h.contains("code barre")
        || h.contains("بارکود")
        || h.contains("كود بار")
    {
        return (ColumnType::Barcode, 0.95);
    }

    // 2. SKU / Reference / Ref / Code article
    if tokens.iter().any(|&t| t == "sku" || t == "ref" || t == "réf" || t == "reference" || t == "référence")
        || (tokens.contains(&"code") && (tokens.contains(&"article") || tokens.contains(&"produit")))
        || h.contains("المرجع")
    {
        return (ColumnType::Sku, 0.90);
    }

    // 3. Title / Designation / Nom produit
    if tokens.iter().any(|&t| t == "title" || t == "item" || t == "label" || t == "designation" || t == "désignation" || t == "designat" || t == "article" || t == "libelle" || t == "libellé" || t == "produit" || t == "product")
        || (tokens.contains(&"nom") && tokens.contains(&"produit"))
        || h.starts_with("designa")
        || h.contains("اسم المنتج")
        || h.contains("تعيين")
    {
        return (ColumnType::Title, 0.95);
    }

    // 4. Cost Price / Prix d'achat / P.A / Cost
    if tokens
        .iter()
        .any(|&t| t == "achat" || t == "pa" || t == "cost" || t == "cout" || t == "coût" || t == "revient" || t == "p_achat")
        || (tokens.contains(&"prix") && (tokens.contains(&"achat") || tokens.contains(&"revient")))
        || h == "p a"
        || h.starts_with("p a ")
        || h.contains("سعر الشراء")
    {
        return (ColumnType::CostPrice, 0.95);
    }

    // 5. Wholesale Price / Prix de gros / P.Gros
    if tokens.iter().any(|&t| t == "gros" || t == "wholesale")
        || (tokens.contains(&"prix") && tokens.contains(&"gros"))
        || h.contains("سعر الجملة")
    {
        return (ColumnType::WholesalePrice, 0.95);
    }

    // 6. Retail Price / Prix vente / P.V / Price
    if tokens.iter().any(|&t| t == "prix" || t == "pv" || t == "price" || t == "tarif")
        || (tokens.contains(&"prix") && (tokens.contains(&"vente") || tokens.contains(&"detail") || tokens.contains(&"détail")))
        || h.contains("سعر البيع")
        || h == "prix"
    {
        return (ColumnType::Price, 0.90);
    }

    // 7. Quantity / Stock / Qte / Quantité
    if tokens.iter().any(|&t| t == "qte" || t == "quantite" || t == "quantité" || t == "qty" || t == "stock" || t == "dispo" || t == "disponible")
        || h.contains("الكمية")
        || h.contains("المخزون")
    {
        return (ColumnType::Quantity, 0.95);
    }

    // 8. Supplier Phone / Tel Fournisseur (must precede general Phone)
    if (h.contains("fourn") || h.contains("supplier") || h.contains("grossiste") || h.contains("مورد"))
        && (tokens.iter().any(|&t| t == "tel" || t == "tél" || t == "telephone" || t == "téléphone" || t == "phone" || t == "mobile")
            || h.contains("الهاتف") || h.contains("رقم الهاتف"))
    {
        return (ColumnType::SupplierPhone, 0.95);
    }

    // 8b. Secondary phone columns must not replace the primary phone mapping.
    if (tokens.iter().any(|&t| t == "tel" || t == "tél" || t == "telephone" || t == "téléphone" || t == "phone" || t == "mobile")
        || h.contains("الهاتف"))
        && tokens.iter().any(|&t| matches!(t, "second" | "secondary" | "secondaire" | "2" | "ثانوي" | "الثاني"))
    {
        return (ColumnType::SecondaryPhone, 0.95);
    }

    // 8c. Phone / Telephone / Tel / Mobile
    if tokens.iter().any(|&t| t == "tel" || t == "tél" || t == "telephone" || t == "téléphone" || t == "phone" || t == "mobile")
        || h.contains("الهاتف")
        || h.contains("رقم الهاتف")
    {
        return (ColumnType::Phone, 0.90);
    }

    // 9. Customer Name / Nom Client
    if tokens.iter().any(|&t| t == "client" || t == "customer" || t == "nom")
        || (tokens.contains(&"nom") && tokens.contains(&"client"))
        || h.contains("اسم الزبون")
        || h.contains("العميل")
    {
        return (ColumnType::CustomerName, 0.90);
    }

    // 10. Supplier / Fournisseur
    if tokens.iter().any(|&t| t == "fournisseur" || t == "fourn" || t == "supplier" || t == "grossiste" || t == "distributeur")
        || h.contains("fournisseur")
        || h.contains("المورد")
        || h.contains("اسم المورد")
    {
        return (ColumnType::SupplierName, 0.90);
    }

    // 11. Debt / Solde / Dette / Credit
    if tokens.iter().any(|&t| t == "dette" || t == "solde" || t == "reste" || t == "credit" || t == "crédit")
        || h.contains("الديون")
        || h.contains("الباقي")
    {
        return (ColumnType::DebtBalance, 0.90);
    }

    // 12. IMEI
    if tokens.iter().any(|&t| t == "imei" || t == "num_serie" || t == "serial" || t == "n_serie")
        || h.contains("imei")
        || h.contains("num_serie")
        || h.contains("numero de serie")
        || h.contains("numéro de série")
        || h.contains("الرقم التسلسلي")
    {
        return (ColumnType::Imei, 0.95);
    }

    // 13. NIF / AI / RC
    if tokens.iter().any(|&t| t == "nif" || t == "rc" || t == "ai" || t == "registre") {
        return (ColumnType::Nif, 0.95);
    }

    // 14. Repair / Panne / SAV
    if tokens.iter().any(|&t| t == "panne" || t == "sav" || t == "reparation" || t == "réparation" || t == "acompte")
        || h.contains("العطب")
        || h.contains("تصليح")
    {
        return (ColumnType::RepairFault, 0.95);
    }

    // 15. Category / Catégorie / Famille / Rayon
    if tokens.iter().any(|&t| t == "category" || t == "categorie" || t == "catégorie" || t == "famille" || t == "rayon" || t == "classe")
        || h.contains("الفئة")
        || h.contains("التصنيف")
        || h.contains("القسم")
    {
        return (ColumnType::Category, 0.95);
    }

    // 16. Brand / Marque / Fabricant
    if tokens.iter().any(|&t| t == "brand" || t == "marque" || t == "fabricant" || t == "constructeur")
        || h.contains("الماركة")
        || h.contains("العلامة")
    {
        return (ColumnType::Brand, 0.95);
    }

    // 17. Compatible Model / Modèle Compatible
    if tokens.iter().any(|&t| t == "modele" || t == "modèle" || t == "model" || t == "compatible")
        || h.contains("الموديل")
        || h.contains("الطراز")
    {
        return (ColumnType::CompatibleModel, 0.90);
    }

    // 18. Warranty / Garantie
    if tokens.iter().any(|&t| t == "garantie" || t == "warranty" || t == "guarantee" || t == "waranty")
        || h.contains("ضمان")
        || h.contains("الضمان")
    {
        return (ColumnType::Warranty, 0.95);
    }

    // 19. Email / Courriel
    if tokens.iter().any(|&t| t == "email" || t == "mail" || t == "courriel")
        || h.contains("البريد")
        || h.contains("الإيميل")
    {
        return (ColumnType::Email, 0.95);
    }

    // 20. Address / City
    if tokens.iter().any(|&t| {
        matches!(
            t,
            "adresse" | "adr" | "address" | "city" | "ville" | "wilaya"
        )
    }) || h.contains("العنوان")
        || h.contains("المدينة")
    {
        return (ColumnType::Address, 0.95);
    }

    // 21. Notes / Comments
    if tokens.iter().any(|&t| {
        matches!(
            t,
            "note" | "notes" | "remarque" | "remarques" | "comment" | "comments" | "commentaire"
        )
    }) || h.contains("ملاحظات")
        || h.contains("تعليق")
    {
        return (ColumnType::Notes, 0.95);
    }

    (ColumnType::Ignored, 0.0)
}

/// Detect entity type of the entire file from columns and row contents
pub fn detect_table_entity(
    headers: &[String],
    column_types: &[ColumnType],
    rows: &[Vec<String>],
) -> (EntityType, f64, Vec<ImportWarning>) {
    let mut warnings = Vec::new();

    // Check for reject classes first:
    // 1. Trade-in history must not be interpreted as catalog stock.
    if headers.iter().any(|header| {
        let normalized = header.to_lowercase().replace(['_', '-', '.', ':', '/', '\\'], " ");
        normalized.contains("reprise")
            || normalized.contains("trade in")
            || normalized.contains("tradein")
            || normalized.contains("استبدال")
            || normalized.contains("مستعمل")
    }) {
        warnings.push(ImportWarning {
            code: "DeferredEntityTradeIns".to_string(),
            message: "Table contains trade-in records (deferred v2 feature). Cannot auto-map as Products or Customers.".to_string(),
        });
        return (EntityType::TradeIns, 0.95, warnings);
    }

    // 2. ActiveRepairs reject class
    if column_types.iter().any(|&c| c == ColumnType::RepairFault || c == ColumnType::RepairDevice)
        || headers.iter().any(|h| {
            let l = h.to_lowercase();
            l.contains("panne") || l.contains("acompte") || l.contains("sav") || l.contains("reparation")
        })
    {
        warnings.push(ImportWarning {
            code: "DeferredEntityActiveRepairs".to_string(),
            message: "Table contains repair/SAV fields (deferred v2 feature). Cannot auto-map as Products or Customers.".to_string(),
        });
        return (EntityType::ActiveRepairs, 0.95, warnings);
    }

    // Target MVP Entities indicators:
    let has_product_cols = column_types.iter().any(|&c| {
        c == ColumnType::Barcode
            || c == ColumnType::Title
            || c == ColumnType::Price
            || c == ColumnType::CostPrice
            || c == ColumnType::Brand
            || c == ColumnType::CompatibleModel
            || c == ColumnType::Sku
    });
    let has_qty_col = column_types.iter().any(|&c| c == ColumnType::Quantity);

    // 3. SerializedImeis reject class (only when table is an isolated serial list without catalog pricing/stock)
    if column_types.iter().any(|&c| c == ColumnType::Imei) {
        let has_catalog_pricing = column_types.iter().any(|&c| {
            c == ColumnType::Price
                || c == ColumnType::CostPrice
                || c == ColumnType::Quantity
                || c == ColumnType::Barcode
        });
        if !has_catalog_pricing {
            warnings.push(ImportWarning {
                code: "DeferredEntitySerializedImeis".to_string(),
                message: "Table contains serialized IMEI inventory (deferred v2 feature).".to_string(),
            });
            return (EntityType::SerializedImeis, 0.95, warnings);
        }
    }

    // 4. Suppliers reject class (by header/NIF or by company keyword analysis in contact rows)
    if !has_product_cols {
        let has_supplier_header = headers.iter().any(|h| {
            let l = h.to_lowercase();
            l.contains("fournisseur")
                || l.contains("fourn")
                || l.contains("supplier")
                || l.contains("مورد")
                || l.contains("المورد")
        });
        let has_fiscal_id = column_types.iter().any(|&c| c == ColumnType::Nif);
        if has_supplier_header && has_fiscal_id {
            warnings.push(ImportWarning {
                code: "DeferredEntitySuppliers".to_string(),
                message: "Table contains supplier records (deferred v2 feature).".to_string(),
            });
            return (EntityType::Suppliers, 0.95, warnings);
        }

        // Check if table looks like a contact list (Name + Phone) with wholesale/supplier keywords
        let name_col_idx = column_types.iter().position(|&c| c == ColumnType::CustomerName || c == ColumnType::SupplierName);
        if let Some(col_idx) = name_col_idx {
            if column_types.iter().any(|&c| c == ColumnType::Phone || c == ColumnType::SupplierPhone) {
                let mut supplier_kw_count = 0;
                let mut total_names = 0;
                let supplier_keywords = [
                    "eurl", "sarl", "ets", "grossiste", "import", "export",
                    "distributeur", "fournisseur", "societe", "spa", "snc", "distribution",
                    "مورد", "موزع", "شركة", "ش.ذ.م.م", "تجارة جملة", "تاجر جملة", "استيراد", "تصدير", "مؤسسة",
                ];

                // Check header of the name column itself (in case headerless TSV promoted row 0 to header)
                let h_raw = headers.get(col_idx).map(|s| s.to_lowercase()).unwrap_or_default();
                let h_folded = fold_arabic_orthography(&h_raw);
                if supplier_keywords.iter().any(|&kw| h_raw.contains(kw) || h_folded.contains(kw)) {
                    supplier_kw_count += 1;
                    total_names += 1;
                }

                for row in rows.iter().take(50) {
                    if let Some(cell) = row.get(col_idx) {
                        let cell_lower = cell.to_lowercase();
                        let cell_folded = fold_arabic_orthography(&cell_lower);
                        if supplier_keywords.iter().any(|&kw| cell_lower.contains(kw) || cell_folded.contains(kw)) {
                            supplier_kw_count += 1;
                        }
                        total_names += 1;
                    }
                }

                if total_names > 0 && (supplier_kw_count as f64 / total_names as f64) >= 0.25 {
                    warnings.push(ImportWarning {
                        code: "DeferredEntitySuppliers".to_string(),
                        message: "Contact list contains wholesale/supplier keywords (deferred v2 feature).".to_string(),
                    });
                    return (EntityType::Suppliers, 0.90, warnings);
                }
            }
        }
    }

    // A name alone is not a safe customer identity for replaying debt-ledger
    // rows; without phone/email, importing them would create duplicate clients.
    let has_debt_col = column_types.iter().any(|&c| c == ColumnType::DebtBalance);
    let has_customer_identity = column_types
        .iter()
        .any(|&c| c == ColumnType::Phone || c == ColumnType::Email);
    if has_debt_col && !has_customer_identity {
        warnings.push(ImportWarning {
            code: "DeferredEntityCustomerDebts".to_string(),
            message: "Table contains standalone customer debt ledger records without phone or email identity (deferred v2 feature).".to_string(),
        });
        return (EntityType::CustomerDebts, 0.95, warnings);
    }

    // Customer vs Product disambiguation:
    let has_phone = column_types.iter().any(|&c| c == ColumnType::Phone);
    let has_customer_header = headers.iter().any(|header| {
        let normalized = header.to_lowercase().replace(['_', '-', '.', ':', '/', '\\'], " ");
        normalized.split_whitespace().any(|token| {
            matches!(
                token,
                "client" | "clients" | "customer" | "customers" | "nom" | "name" | "زبون" | "عميل" | "العميل"
            )
        })
    });
    let has_customer_cols = has_phone || (has_customer_header && column_types.iter().any(|&c| c == ColumnType::CustomerName));

    // If customer columns are present (with or without debt balance):
    if has_customer_cols && !has_product_cols {
        return (EntityType::Customers, 0.95, warnings);
    }

    if has_product_cols {
        if has_qty_col {
            return (EntityType::OpeningStock, 0.95, warnings);
        } else {
            return (EntityType::Products, 0.90, warnings);
        }
    }

    if has_customer_cols {
        return (EntityType::Customers, 0.90, warnings);
    }

    (EntityType::Unknown, 0.0, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_luhn_check_imei() {
        assert!(luhn_check_imei("356938035643809"));
        assert!(!luhn_check_imei("356938035643803")); // Invalid checksum
        assert!(!luhn_check_imei("12345")); // Too short
    }

    #[test]
    fn detects_compact_french_cost_price_headers() {
        assert_eq!(match_header_synonym("P.A").0, ColumnType::CostPrice);
        assert_eq!(match_header_synonym("Cout").0, ColumnType::CostPrice);
        assert_eq!(match_header_synonym("Prix de revient").0, ColumnType::CostPrice);
    }

    #[test]
    fn test_ean13_validation() {
        assert!(is_valid_ean13("6132450019289"));
        assert!(!is_valid_ean13("6132450019283")); // Invalid check digit (sum=91 -> check is 9, not 3)
    }

    #[test]
    fn test_analyze_15_digit_imei_vs_nif() {
        // 10 valid IMEIs -> Luhn rate 100% -> Imei
        let imei_cols: Vec<String> = (0..10).map(|_| "356938035643809".to_string()).collect();
        let (kind, conf) = analyze_15_digit_column(&imei_cols);
        assert_eq!(kind, ColumnType::Imei);
        assert!(conf >= 0.90);

        // 10 NIFs (randomly ~10% Luhn pass) -> Nif
        let nif_cols = vec![
            "000116090000034".to_string(),
            "000216090000011".to_string(),
            "000316090000022".to_string(),
            "000416090000033".to_string(),
            "000516090000044".to_string(),
            "000616090000055".to_string(),
            "000716090000066".to_string(),
            "000816090000077".to_string(),
            "000916090000088".to_string(),
            "001016090000099".to_string(),
        ];
        let (kind_nif, conf_nif) = analyze_15_digit_column(&nif_cols);
        assert_eq!(kind_nif, ColumnType::Nif);
        assert!(conf_nif >= 0.90);
    }

    #[test]
    fn test_thousand_dot_inference() {
        // All dotted values have exactly 3 decimals and >= 3 samples -> ThousandsDot
        let col_thousands = vec![
            "45.000".to_string(),
            "120.000".to_string(),
            "1.250.000".to_string(),
            "8.500".to_string(),
            "500".to_string(),
        ];
        let (inf, conf) = infer_column_thousand_dot(&col_thousands);
        assert_eq!(inf, ThousandDotInference::ThousandsDot);
        assert!(conf >= 0.90);

        // Mixed with 2 decimals -> DecimalDot
        let col_decimal = vec![
            "45.000".to_string(),
            "12.50".to_string(),
            "100.00".to_string(),
        ];
        let (inf_dec, _) = infer_column_thousand_dot(&col_decimal);
        assert_eq!(inf_dec, ThousandDotInference::DecimalDot);
    }
}

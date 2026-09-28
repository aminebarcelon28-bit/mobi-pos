use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrBoundingBox {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedTableRow {
    pub raw_line: String,
    pub description: String,
    pub quantity: f64,
    pub unit_cost: f64,
    pub line_total: f64,
    pub contains_barcode: bool,
    pub extracted_barcode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExtractedDocumentSummary {
    pub detected_supplier: Option<String>,
    pub detected_invoice_number: Option<String>,
    pub detected_date: Option<String>,
    pub detected_subtotal: Option<f64>,
    pub detected_tax: Option<f64>,
    pub detected_freight: Option<f64>,
    pub detected_grand_total: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedDocumentResult {
    pub rows: Vec<ExtractedTableRow>,
    pub summary: ExtractedDocumentSummary,
}

pub struct SpatialLayoutParser {
    qty_regex: Regex,
    price_regex: Regex,
    gtin_regex: Regex,
    index_prefix_regex: Regex,
    mult_regex: Regex,
    sep_regex: Regex,
}

fn try_parse_pure_numeric(s: &str) -> Option<f64> {
    if s.is_empty() {
        return None;
    }
    // If both '.' and ',' exist, determine which is decimal by last occurrence
    if s.contains('.') && s.contains(',') {
        let dot_pos = s.rfind('.').unwrap();
        let comma_pos = s.rfind(',').unwrap();
        if dot_pos > comma_pos {
            // Anglo-Saxon format: 3,150.00 -> 3150.00
            let norm = s.replace(',', "");
            return norm.parse::<f64>().ok();
        } else {
            // French/European format: 3.150,00 -> 3150.00
            let norm = s.replace('.', "").replace(',', ".");
            return norm.parse::<f64>().ok();
        }
    }

    if s.contains(',') {
        let norm = s.replace(',', ".");
        return norm.parse::<f64>().ok();
    }

    s.parse::<f64>().ok()
}

pub fn repair_ocr_digit_confusions(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        let has_digit_neighbor = (i > 0 && chars[i - 1].is_ascii_digit())
            || (i + 1 < chars.len() && chars[i + 1].is_ascii_digit());
        let rep = match c {
            'O' | 'o' => '0',
            'I' | 'l' if has_digit_neighbor || s.contains(',') || s.contains('.') => '1',
            'S' | 's' if has_digit_neighbor => '5',
            'B' if has_digit_neighbor => '8',
            'Z' | 'z' if has_digit_neighbor => '2',
            _ => c,
        };
        out.push(rep);
    }
    out
}

/// Parses amounts in standard, French, and Algerian invoice formats:
/// Supports "3 150,00", "31 500,00", "350,00", "3.150,00", "3,150.00", "12500.00", "3150 DA", etc.
pub fn parse_french_algerian_amount(s: &str) -> Option<f64> {
    let clean = s.trim();
    let clean = clean
        .trim_matches(|c: char| c == '$' || c == '€' || c == '£' || c == '|' || c == '[' || c == ']' || c == '(' || c == ')')
        .trim();

    let mut text = clean.to_string();
    for word in &["DZD", "dzd", "DA", "da", "Dinar", "dinars", "USD", "EUR", "$", "€"] {
        text = text.replace(word, "");
    }
    let text = text.trim();

    // Filter out spaces (thousand separators), apostrophes, and non-breaking spaces
    let without_spaces: String = text
        .chars()
        .filter(|&c| c != ' ' && c != '\u{a0}' && c != '\u{202f}' && c != '\u{2009}' && c != '\u{feff}' && c != '\'')
        .collect();

    if without_spaces.is_empty() {
        return None;
    }

    // Direct numeric parse attempt
    if let Some(val) = try_parse_pure_numeric(&without_spaces) {
        return Some(val);
    }

    // OCR correction for common digit confusions (O->0, l->1, S->5, B->8)
    let repaired = repair_ocr_digit_confusions(&without_spaces);
    try_parse_pure_numeric(&repaired)
}

/// Identifies metadata lines, serial numbers, barcodes, or reference tags that belong
/// to the immediately preceding invoice row.
pub fn is_metadata_or_subline(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    if t.starts_with('[') && t.ends_with(']') {
        return true;
    }
    let lower = t.to_lowercase();
    lower.starts_with("[s/n:")
        || lower.starts_with("[gtin:")
        || lower.starts_with("[ref:")
        || lower.starts_with("[p/n:")
        || lower.starts_with("s/n:")
        || lower.starts_with("gtin:")
        || lower.starts_with("sn:")
        || lower.starts_with("ref:")
        || lower.starts_with("p/n:")
        || lower.starts_with("pn:")
        || lower.starts_with("ean:")
        || lower.starts_with("barcode:")
}

/// Extracts a barcode, GTIN, or Serial Number from explicit tags or raw digit sequences.
pub fn extract_barcode_or_sn_from_text(s: &str) -> Option<String> {
    let re_tag = Regex::new(r"(?i)\[(?:GTIN|S/N|SN|EAN|BARCODE|CODE)[:\s]*([A-Z0-9]+)\]").unwrap();
    if let Some(cap) = re_tag.captures(s) {
        if let Some(m) = cap.get(1) {
            return Some(m.as_str().to_string());
        }
    }
    let re_tag2 = Regex::new(r"(?i)\b(?:GTIN|S/N|SN|EAN|BARCODE)[:\s]+([A-Z0-9]+)\b").unwrap();
    if let Some(cap) = re_tag2.captures(s) {
        if let Some(m) = cap.get(1) {
            return Some(m.as_str().to_string());
        }
    }
    let re_digits = Regex::new(r"\b(\d{8}|\d{12}|\d{13}|\d{14})\b").unwrap();
    for cap in re_digits.captures_iter(s) {
        if let Some(m) = cap.get(1) {
            return Some(m.as_str().to_string());
        }
    }
    None
}

/// Extracts reference / part numbers from bracketed or prefixed expressions.
pub fn extract_ref_code_from_text(s: &str) -> Option<String> {
    let re_ref = Regex::new(r"(?i)\[(?:REF|P/N|PN|ART|SKU)[:\s]*([^\]]+)\]").unwrap();
    if let Some(cap) = re_ref.captures(s) {
        if let Some(m) = cap.get(1) {
            return Some(m.as_str().trim().to_string());
        }
    }
    let re_bracket = Regex::new(r"\[([A-Z0-9_\-\./]+)\]").unwrap();
    if let Some(cap) = re_bracket.captures(s) {
        if let Some(m) = cap.get(1) {
            let val = m.as_str().trim();
            if val.len() >= 3 && !val.chars().all(|c| c.is_ascii_digit()) {
                return Some(val.to_string());
            }
        }
    }
    None
}

/// Identifies table header rows such as "Désignation | Qté | P.U. | Montant"
pub fn is_table_header_line(s: &str) -> bool {
    let lower = s.to_lowercase();
    let has_desc = lower.contains("désignation")
        || lower.contains("designation")
        || lower.contains("description")
        || lower.contains("article")
        || lower.contains("libellé")
        || lower.contains("libelle");
    let has_metric = lower.contains("qté")
        || lower.contains("qte")
        || lower.contains("quantit")
        || lower.contains("p.u")
        || lower.contains("prix")
        || lower.contains("montant")
        || lower.contains("total")
        || lower.contains("tva");
    has_desc && has_metric
}

/// Identifies invoice summary rows (totals, taxes, freight)
pub fn is_document_summary_line(s: &str) -> bool {
    let lower = s.to_lowercase();
    lower.contains("total ht")
        || lower.contains("sous-total")
        || lower.contains("sous total")
        || lower.contains("net a payer")
        || lower.contains("net à payer")
        || lower.contains("total ttc")
        || lower.contains("total général")
        || lower.contains("total general")
        || lower.contains("montant total")
        || lower.contains("total facture")
        || lower.starts_with("tva ")
        || lower.starts_with("t.v.a")
        || lower.contains("timbre fiscal")
        || lower.contains("droit de timbre")
        || lower.contains("frais de port")
        || lower.contains("transport")
        || lower.contains("remise globale")
        || lower.contains("escompte")
}

pub fn extract_summary_amounts(line: &str, summary: &mut ExtractedDocumentSummary) {
    let lower = line.to_lowercase();
    let re_amt = Regex::new(r"(\d{1,3}(?:[ \u{a0}]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2}|\b\d{3,}\b)").unwrap();
    let amounts: Vec<f64> = re_amt
        .captures_iter(line)
        .filter_map(|cap| cap.get(1))
        .filter_map(|m| parse_french_algerian_amount(m.as_str()))
        .collect();

    if let Some(&last_amt) = amounts.last() {
        if lower.contains("total ttc")
            || lower.contains("net a payer")
            || lower.contains("net à payer")
            || lower.contains("total facture")
            || lower.contains("total général")
            || lower.contains("total general")
            || lower.contains("montant total")
        {
            summary.detected_grand_total = Some(last_amt);
        } else if lower.contains("total ht") || lower.contains("sous-total") || lower.contains("sous total") {
            summary.detected_subtotal = Some(last_amt);
        } else if lower.contains("tva") || lower.contains("t.v.a") {
            summary.detected_tax = Some(last_amt);
        } else if lower.contains("port") || lower.contains("transport") || lower.contains("livraison") {
            summary.detected_freight = Some(last_amt);
        }
    }
}

pub fn is_invoice_header_metadata_line(s: &str) -> bool {
    let lower = s.to_lowercase();
    lower.starts_with("fournisseur")
        || lower.starts_with("supplier")
        || lower.starts_with("facture")
        || lower.starts_with("invoice")
        || lower.starts_with("bl n")
        || lower.starts_with("bon de")
        || lower.starts_with("devis n")
        || lower.starts_with("date")
        || lower.starts_with("le :")
        || lower.starts_with("client")
        || lower.starts_with("doit :")
        || lower.starts_with("doit:")
        || lower.starts_with("adresse")
        || lower.starts_with("tel :")
        || lower.starts_with("tél :")
        || lower.starts_with("email :")
        || lower.starts_with("e-mail :")
        || lower.starts_with("nif")
        || lower.starts_with("nis")
        || lower.starts_with("r.c")
        || lower.starts_with("rc :")
        || lower.starts_with("page ")
        || lower.starts_with("sarl ")
        || lower.starts_with("eurl ")
        || lower.starts_with("ets ")
        || lower.starts_with("spa ")
}

pub fn extract_invoice_metadata(line: &str, summary: &mut ExtractedDocumentSummary) -> bool {
    let mut matched = false;
    let lower = line.to_lowercase();
    if summary.detected_invoice_number.is_none()
        && (lower.contains("facture n")
            || lower.contains("facture no")
            || lower.contains("bl n")
            || lower.contains("invoice #"))
    {
        let re = Regex::new(r"(?i)(?:facture|bl|invoice)\s*(?:n[°o\.]*|#)\s*[:\s]*([A-Z0-9_\-\./]+)").unwrap();
        if let Some(cap) = re.captures(line) {
            if let Some(m) = cap.get(1) {
                summary.detected_invoice_number = Some(m.as_str().trim().to_string());
                matched = true;
            }
        }
    }
    if summary.detected_date.is_none()
        && (lower.contains("date") || lower.contains("le :") || lower.starts_with("le "))
    {
        let re_date = Regex::new(r"\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b").unwrap();
        if let Some(cap) = re_date.captures(line) {
            if let Some(m) = cap.get(1) {
                summary.detected_date = Some(m.as_str().trim().to_string());
                matched = true;
            }
        }
    }
    if summary.detected_supplier.is_none() {
        if lower.contains("fournisseur") {
            let re_sup = Regex::new(r"(?i)fournisseur\s*[:\s]+([^\n\|]+)").unwrap();
            if let Some(cap) = re_sup.captures(line) {
                if let Some(m) = cap.get(1) {
                    let s = m.as_str().trim();
                    if s.len() >= 2 {
                        summary.detected_supplier = Some(s.to_string());
                        matched = true;
                    }
                }
            }
        } else if lower.starts_with("sarl ")
            || lower.starts_with("eurl ")
            || lower.starts_with("ets ")
            || lower.starts_with("spa ")
        {
            summary.detected_supplier = Some(line.trim().to_string());
            matched = true;
        }
    }
    matched
}

impl Default for SpatialLayoutParser {
    fn default() -> Self {
        Self::new()
    }
}

impl SpatialLayoutParser {
    pub fn new() -> Self {
        Self {
            qty_regex: Regex::new(r"(?i)\b(?:qty[:\s]*)?(\d+(?:[.,]\d+)?)\s*(?:x|pcs|ea|pk|bx|units|u)?\b").unwrap(),
            price_regex: Regex::new(r"(?i)(?:\$|€)?\s*(\d{1,3}(?:[ \u{a0}]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2}|\b\d{3,}\b)\s*(?:DA|DZD|\$|€)?").unwrap(),
            gtin_regex: Regex::new(r"\b(\d{8}|\d{12}|\d{13}|\d{14})\b").unwrap(),
            index_prefix_regex: Regex::new(r"^\s*\d+[\.\)\-]\s*").unwrap(),
            mult_regex: Regex::new(r"(?i)\s+(\d+(?:[.,]\d+)?)\s*(?:x|\*|@)\s*(\d{1,3}(?:[ \u{a0}]\d{3})*(?:[.,]\d{2})?|\d+[.,]\d{2}|\b\d+\b)\s*(?:=\s*(\d{1,3}(?:[ \u{a0}]\d{3})*(?:[.,]\d{2})?|\d+[.,]\d{2}|\b\d+\b))?\s*(?:DA|DZD)?$").unwrap(),
            sep_regex: Regex::new(r"(?:\t|\s{2,})").unwrap(),
        }
    }

    /// Verifies standard Modulo-10 check digits for GTIN-8, UPC-A (12), EAN-13, and GTIN-14
    pub fn verify_modulo10_gtin(&self, code: &str) -> bool {
        if !code.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        let len = code.len();
        if len != 8 && len != 12 && len != 13 && len != 14 {
            return false;
        }

        let digits: Vec<u32> = code.chars().map(|c| c.to_digit(10).unwrap()).collect();
        let payload = &digits[..len - 1];
        let check_digit = digits[len - 1];

        let sum: u32 = payload
            .iter()
            .rev()
            .enumerate()
            .map(|(idx, &d)| if idx % 2 == 0 { d * 3 } else { d })
            .sum();

        let calculated_check = (10 - (sum % 10)) % 10;
        calculated_check == check_digit
    }

    /// Mathematical Invariant Column Extraction (MICE):
    /// Analyzes the tail of a text line to extract (description, qty, unit_cost, line_total)
    /// verified by |(qty * unit_cost) - line_total| <= 1.0 DA, leaving embedded product codes intact.
    pub fn parse_trailing_accounting_math(&self, line: &str) -> Option<(String, f64, f64, f64)> {
        let raw = line.trim();
        if raw.is_empty() {
            return None;
        }

        // 1. Multiplier syntax: e.g. "50 x 350,00 = 17 500,00" or "10 x 3150"
        if let Some(caps) = self.mult_regex.captures(raw) {
            if let (Some(m_qty), Some(m_cost)) = (caps.get(1), caps.get(2)) {
                if let (Some(q), Some(c)) = (
                    parse_french_algerian_amount(m_qty.as_str()),
                    parse_french_algerian_amount(m_cost.as_str()),
                ) {
                    if q > 0.0 && c >= 0.0 {
                        let total = if let Some(m_tot) = caps.get(3) {
                            parse_french_algerian_amount(m_tot.as_str())
                                .unwrap_or_else(|| (q * c * 100.0).round() / 100.0)
                        } else {
                            (q * c * 100.0).round() / 100.0
                        };
                        let desc_end = caps.get(0).unwrap().start();
                        let desc = raw[..desc_end].trim().to_string();
                        if !desc.is_empty() {
                            return Some((desc, q, c, total));
                        }
                    }
                }
            }
        }

        // 2. Multi-space or tab delimiters: e.g. "Description    10     3 150,00     31 500,00"
        let parts: Vec<&str> = self
            .sep_regex
            .split(raw)
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .collect();

        if parts.len() >= 4 {
            let p_tot = parts[parts.len() - 1];
            let p_cost = parts[parts.len() - 2];
            let p_qty = parts[parts.len() - 3];
            if let (Some(q), Some(c), Some(t)) = (
                parse_french_algerian_amount(p_qty),
                parse_french_algerian_amount(p_cost),
                parse_french_algerian_amount(p_tot),
            ) {
                if q > 0.0 && ((q * c) - t).abs() <= 1.0 {
                    let desc_parts = &parts[..parts.len() - 3];
                    let desc = desc_parts.join(" ");
                    return Some((desc, q, c, t));
                }
            }
        } else if parts.len() == 3 {
            let p_cost_or_tot = parts[2];
            let p_qty = parts[1];
            if let (Some(q), Some(amt)) = (
                parse_french_algerian_amount(p_qty),
                parse_french_algerian_amount(p_cost_or_tot),
            ) {
                if q > 0.0 {
                    let desc = parts[0].to_string();
                    let cost = (amt / q * 100.0).round() / 100.0;
                    return Some((desc, q, cost, amt));
                }
            }
        }

        // 3. Suffix Invariant Search:
        // Handles multi-word amounts (e.g. "31 500,00", "128 000,00 DA")
        let words: Vec<&str> = raw.split_whitespace().collect();
        if words.len() >= 4 {
            for t_words in 1..=3 {
                for c_words in 1..=3 {
                    for q_words in 1..=2 {
                        let needed = t_words + c_words + q_words;
                        if words.len() <= needed {
                            continue;
                        }

                        let t_start = words.len() - t_words;
                        let c_start = t_start - c_words;
                        let q_start = c_start - q_words;

                        let t_str = words[t_start..].join(" ");
                        let c_str = words[c_start..t_start].join(" ");
                        let q_str = words[q_start..c_start].join(" ");

                        if let (Some(q), Some(c), Some(t)) = (
                            parse_french_algerian_amount(&q_str),
                            parse_french_algerian_amount(&c_str),
                            parse_french_algerian_amount(&t_str),
                        ) {
                            if q > 0.0 && c > 0.0 && ((q * c) - t).abs() <= 1.0 {
                                let desc = words[..q_start].join(" ");
                                if !desc.is_empty() {
                                    return Some((desc, q, c, t));
                                }
                            }
                        }
                    }
                }
            }

            // 4. Invariant Self-Healing:
            // When OCR has a single character typo or slight blur, but 2 numbers agree mathematically
            for t_words in 1..=3 {
                for c_words in 1..=3 {
                    for q_words in 1..=2 {
                        let needed = t_words + c_words + q_words;
                        if words.len() <= needed {
                            continue;
                        }

                        let t_start = words.len() - t_words;
                        let c_start = t_start - c_words;
                        let q_start = c_start - q_words;

                        let t_str = words[t_start..].join(" ");
                        let c_str = words[c_start..t_start].join(" ");
                        let q_str = words[q_start..c_start].join(" ");

                        let p_q = parse_french_algerian_amount(&q_str);
                        let p_c = parse_french_algerian_amount(&c_str);
                        let p_t = parse_french_algerian_amount(&t_str);

                        // Case A: q and t are clean, c was blurry/noisy
                        if let (Some(q), Some(t)) = (p_q, p_t) {
                            if q > 0.0 && t > 0.0 {
                                let c_calc = (t / q * 100.0).round() / 100.0;
                                if let Some(c) = p_c {
                                    if (c - c_calc).abs() / c_calc < 0.20 {
                                        let desc = words[..q_start].join(" ");
                                        if !desc.is_empty() {
                                            return Some((desc, q, c_calc, t));
                                        }
                                    }
                                }
                            }
                        }

                        // Case B: q and c are clean, t was blurry/noisy
                        if let (Some(q), Some(c)) = (p_q, p_c) {
                            if q > 0.0 && c > 0.0 {
                                let t_calc = (q * c * 100.0).round() / 100.0;
                                if let Some(t) = p_t {
                                    if (t - t_calc).abs() / t_calc < 0.20 {
                                        let desc = words[..q_start].join(" ");
                                        if !desc.is_empty() {
                                            return Some((desc, q, c, t_calc));
                                        }
                                    }
                                }
                            }
                        }

                        // Case C: c and t are clean, q was misread
                        if let (Some(c), Some(t)) = (p_c, p_t) {
                            if c > 0.0 && t > 0.0 {
                                let q_calc = (t / c).round();
                                if q_calc >= 1.0 && ((q_calc * c) - t).abs() <= 1.0 {
                                    if let Some(q) = p_q {
                                        if (q - q_calc).abs() <= 2.0 {
                                            let desc = words[..q_start].join(" ");
                                            if !desc.is_empty() {
                                                return Some((desc, q_calc, c, t));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        None
    }

    /// End-to-end document parsing: extracts rows, classifies tables, removes header/footer noise,
    /// and extracts document metadata (supplier name, date, invoice number, totals).
    pub fn parse_document(&self, mut boxes: Vec<OcrBoundingBox>) -> ParsedDocumentResult {
        if boxes.is_empty() {
            return ParsedDocumentResult {
                rows: Vec::new(),
                summary: ExtractedDocumentSummary::default(),
            };
        }

        // Sort boxes vertically by top-y coordinate (safe float sort)
        boxes.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));

        let mut lines: Vec<Vec<OcrBoundingBox>> = Vec::new();
        for b in boxes {
            if b.text.trim().is_empty() {
                continue;
            }

            let mut matched_line = false;
            let b_center_y = b.y + b.h * 0.5;

            for line in lines.iter_mut() {
                let avg_y = line.iter().map(|item| item.y).sum::<f64>() / line.len() as f64;
                let avg_h = line.iter().map(|item| item.h).sum::<f64>() / line.len() as f64;
                let line_center_y = avg_y + avg_h * 0.5;
                let min_h = avg_h.min(b.h);
                let max_h = avg_h.max(b.h);

                // Interval overlap: [y, y + h]
                let overlap = (avg_y + avg_h).min(b.y + b.h) - avg_y.max(b.y);
                let overlap_ratio = if min_h > 0.0 { overlap / min_h } else { 0.0 };
                let center_dist = (b_center_y - line_center_y).abs();

                // Merge if vertical overlap is significant OR center-to-center is within normal line height
                if overlap_ratio >= 0.25 || center_dist <= (max_h * 0.70) {
                    line.push(b.clone());
                    matched_line = true;
                    break;
                }
            }

            if !matched_line {
                lines.push(vec![b]);
            }
        }

        // Sort lines vertically by average Y coordinate
        lines.sort_by(|l1, l2| {
            let y1 = l1.iter().map(|b| b.y).sum::<f64>() / l1.len() as f64;
            let y2 = l2.iter().map(|b| b.y).sum::<f64>() / l2.len() as f64;
            y1.partial_cmp(&y2).unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut structured_rows: Vec<ExtractedTableRow> = Vec::new();
        let mut summary = ExtractedDocumentSummary::default();

        for mut line in lines {
            // Sort line tokens horizontally from left to right (safe float sort)
            line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));

            // Reconstruct text, inserting column spaces when horizontal gaps exceed 4% width
            let mut line_raw = String::new();
            for (i, b) in line.iter().enumerate() {
                if i > 0 {
                    let prev = &line[i - 1];
                    let gap = b.x - (prev.x + prev.w);
                    if gap > 0.04 {
                        line_raw.push_str("   ");
                    } else {
                        line_raw.push(' ');
                    }
                }
                line_raw.push_str(b.text.trim());
            }

            let trimmed_line = line_raw.trim();
            if trimmed_line.len() < 2 {
                continue;
            }

            // 1. Check for attached sublines / metadata (e.g. [S/N: ...], [GTIN: ...], [REF: ...])
            if is_metadata_or_subline(trimmed_line) && !structured_rows.is_empty() {
                let last_idx = structured_rows.len() - 1;
                let last = &mut structured_rows[last_idx];

                if let Some(bc) = extract_barcode_or_sn_from_text(trimmed_line) {
                    last.extracted_barcode = Some(bc);
                    last.contains_barcode = true;
                }
                if let Some(ref_code) = extract_ref_code_from_text(trimmed_line) {
                    if !last.description.contains(&ref_code) {
                        last.description = format!("{} ({})", last.description, ref_code);
                    }
                }
                last.raw_line = format!("{}\n{}", last.raw_line, trimmed_line);
                continue;
            }

            // 2. Table Column Headers Filter (skip headers like "Désignation | Qté | P.U. | Montant")
            if is_table_header_line(trimmed_line) {
                continue;
            }

            // 3. Document Summary & Footers (e.g. "TOTAL HT", "TOTAL TTC", "NET A PAYER", "TVA")
            if is_document_summary_line(trimmed_line) {
                extract_summary_amounts(trimmed_line, &mut summary);
                continue;
            }

            // 4. Extract document metadata (Supplier, Date, Invoice No) from headers
            let is_meta_line = is_invoice_header_metadata_line(trimmed_line);
            let meta_extracted = extract_invoice_metadata(trimmed_line, &mut summary);
            if is_meta_line || meta_extracted {
                continue;
            }

            // 5. Pipe-delimited row parsing
            if trimmed_line.contains('|') {
                let cols: Vec<&str> = trimmed_line
                    .split('|')
                    .map(|c| c.trim())
                    .filter(|c| !c.is_empty())
                    .collect();

                if cols.len() >= 3 {
                    let mut desc = self.index_prefix_regex.replace(cols[0], "").trim().to_string();
                    let bc = extract_barcode_or_sn_from_text(cols[0]);
                    let ref_code = extract_ref_code_from_text(cols[0]);
                    if let Some(ref r) = ref_code {
                        if !desc.contains(r) {
                            desc = format!("{} ({})", desc, r);
                        }
                    }

                    let (quantity, unit_cost, line_total) = if cols.len() >= 4 {
                        let qty = parse_french_algerian_amount(cols[1]).unwrap_or(1.0);
                        let cost = parse_french_algerian_amount(cols[2]).unwrap_or(0.0);
                        let total = parse_french_algerian_amount(cols[3])
                            .unwrap_or_else(|| (qty * cost * 100.0).round() / 100.0);
                        (qty, cost, total)
                    } else {
                        let qty = parse_french_algerian_amount(cols[1]).unwrap_or(1.0);
                        let amount = parse_french_algerian_amount(cols[2]).unwrap_or(0.0);
                        let cost = if qty > 0.0 {
                            (amount / qty * 100.0).round() / 100.0
                        } else {
                            amount
                        };
                        (qty, cost, amount)
                    };

                    structured_rows.push(ExtractedTableRow {
                        raw_line: trimmed_line.to_string(),
                        description: desc,
                        quantity,
                        unit_cost,
                        line_total,
                        contains_barcode: bc.is_some(),
                        extracted_barcode: bc,
                    });
                    continue;
                }
            }

            // 6. MICE: Invariant-based extraction for non-pipe lines (multi-space, tabs, or single spaces)
            if let Some((clean_desc, qty, cost, total)) = self.parse_trailing_accounting_math(trimmed_line) {
                let mut desc = self.index_prefix_regex.replace(&clean_desc, "").trim().to_string();
                let bc = extract_barcode_or_sn_from_text(trimmed_line);
                let ref_code = extract_ref_code_from_text(trimmed_line);
                if let Some(ref r) = ref_code {
                    if !desc.contains(r) {
                        desc = format!("{} ({})", desc, r);
                    }
                }

                structured_rows.push(ExtractedTableRow {
                    raw_line: trimmed_line.to_string(),
                    description: desc,
                    quantity: qty,
                    unit_cost: cost,
                    line_total: total,
                    contains_barcode: bc.is_some(),
                    extracted_barcode: bc,
                });
                continue;
            }

            // 7. Fallback for freeform unstructured lines
            let mut extracted_barcode = None;
            for cap in self.gtin_regex.captures_iter(trimmed_line) {
                if let Some(m) = cap.get(1) {
                    let code = m.as_str();
                    if self.verify_modulo10_gtin(code) {
                        extracted_barcode = Some(code.to_string());
                        break;
                    }
                }
            }
            if extracted_barcode.is_none() {
                extracted_barcode = extract_barcode_or_sn_from_text(trimmed_line);
            }

            let mut monetary_values: Vec<f64> = Vec::new();
            for cap in self.price_regex.captures_iter(trimmed_line) {
                if let Some(m) = cap.get(1) {
                    if let Some(val) = parse_french_algerian_amount(m.as_str()) {
                        if !monetary_values.contains(&val) {
                            monetary_values.push(val);
                        }
                    }
                }
            }

            let mut quantity: f64 = 1.0;
            if let Some(cap) = self.qty_regex.captures(trimmed_line) {
                if let Some(m) = cap.get(1) {
                    if let Some(q) = parse_french_algerian_amount(m.as_str()) {
                        if q > 0.0 && !monetary_values.contains(&q) {
                            quantity = q;
                        }
                    }
                }
            }

            let (unit_cost, line_total) = match monetary_values.len() {
                0 => (0.0, 0.0),
                1 => (
                    monetary_values[0],
                    (monetary_values[0] * quantity * 100.0).round() / 100.0,
                ),
                _ => {
                    let total = monetary_values[monetary_values.len() - 1];
                    let cost = monetary_values[monetary_values.len() - 2];
                    (cost, total)
                }
            };

            let mut clean_desc = self.price_regex.replace_all(trimmed_line, "").to_string();
            clean_desc = self.qty_regex.replace_all(&clean_desc, "").to_string();
            clean_desc = self.index_prefix_regex.replace(&clean_desc, "").to_string();
            if let Some(ref bc) = extracted_barcode {
                clean_desc = clean_desc.replace(bc, "");
            }

            let final_description = clean_desc
                .split_whitespace()
                .filter(|word| word.len() > 1 || word.chars().all(|c| c.is_alphanumeric()))
                .collect::<Vec<&str>>()
                .join(" ");

            if final_description.is_empty() {
                continue;
            }

            structured_rows.push(ExtractedTableRow {
                raw_line: trimmed_line.to_string(),
                description: final_description,
                quantity,
                unit_cost,
                line_total,
                contains_barcode: extracted_barcode.is_some(),
                extracted_barcode,
            });
        }

        ParsedDocumentResult {
            rows: structured_rows,
            summary,
        }
    }

    /// Aggregates OCR word bounding boxes or text lines into structured invoice rows.
    pub fn reconstruct_rows(&self, boxes: Vec<OcrBoundingBox>) -> Vec<ExtractedTableRow> {
        self.parse_document(boxes).rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gtin_checksums() {
        let parser = SpatialLayoutParser::new();
        assert!(parser.verify_modulo10_gtin("012000000133")); // Valid 12-digit UPC
        assert!(parser.verify_modulo10_gtin("4006381333931")); // Valid 13-digit EAN
        assert!(parser.verify_modulo10_gtin("0745883815234")); // Valid 13-digit Belkin GTIN
        assert!(!parser.verify_modulo10_gtin("4006381333932")); // Invalid check digit
    }

    #[test]
    fn test_french_algerian_amount_parser() {
        assert_eq!(parse_french_algerian_amount("3 150,00"), Some(3150.0));
        assert_eq!(parse_french_algerian_amount("31 500,00"), Some(31500.0));
        assert_eq!(parse_french_algerian_amount("350,00"), Some(350.0));
        assert_eq!(parse_french_algerian_amount("12500.00"), Some(12500.0));
        assert_eq!(parse_french_algerian_amount("3 150,00 DA"), Some(3150.0));
        assert_eq!(parse_french_algerian_amount("10"), Some(10.0));
    }

    #[test]
    fn test_user_tabular_invoice_parsing() {
        let raw_lines = vec![
            "1. ADAPT. SECT. 20W TYPE-C A2305 ORIG APPL    |  10 |     3 150,00 |           31 500,00",
            "   [S/N: 019425208421]",
            "2. ETUI SILIC. NOIR IPH 15 PROMAX             |  20 |     1 850,00 |           37 000,00",
            "   [REF: APC-15PM-B]",
            "3. BELKIN BRAIDED CABLE USBC-USBC 200CM / 2M  |  15 |     1 400,00 |           21 000,00",
            "   [GTIN: 0745883815234]",
            "4. ANKER 735 CHARGER GAN 3 65W 3-PORT FAST    |   5 |     4 200,00 |           21 000,00",
            "   [P/N: A2667G11]",
            "5. FILM VERRE TREMPE PRIVACY S24 ULTRA 9H     |  50 |       350,00 |           17 500,00",
            "   [ACC-SCR-S24U]",
        ];

        let mut boxes = Vec::new();
        for (idx, line) in raw_lines.iter().enumerate() {
            boxes.push(OcrBoundingBox {
                text: line.to_string(),
                x: 0.1,
                y: 0.1 + (idx as f64) * 0.05,
                w: 0.8,
                h: 0.03,
                confidence: 0.99,
            });
        }

        let parser = SpatialLayoutParser::new();
        let rows = parser.reconstruct_rows(boxes);

        assert_eq!(rows.len(), 5, "Must produce exactly 5 structured rows");

        // Row 0
        assert_eq!(rows[0].description, "ADAPT. SECT. 20W TYPE-C A2305 ORIG APPL");
        assert_eq!(rows[0].quantity, 10.0);
        assert_eq!(rows[0].unit_cost, 3150.0);
        assert_eq!(rows[0].line_total, 31500.0);
        assert_eq!(rows[0].extracted_barcode, Some("019425208421".to_string()));

        // Row 1
        assert_eq!(rows[1].description, "ETUI SILIC. NOIR IPH 15 PROMAX (APC-15PM-B)");
        assert_eq!(rows[1].quantity, 20.0);
        assert_eq!(rows[1].unit_cost, 1850.0);
        assert_eq!(rows[1].line_total, 37000.0);

        // Row 2
        assert_eq!(rows[2].description, "BELKIN BRAIDED CABLE USBC-USBC 200CM / 2M");
        assert_eq!(rows[2].quantity, 15.0);
        assert_eq!(rows[2].unit_cost, 1400.0);
        assert_eq!(rows[2].line_total, 21000.0);
        assert_eq!(rows[2].extracted_barcode, Some("0745883815234".to_string()));

        // Row 3
        assert_eq!(rows[3].description, "ANKER 735 CHARGER GAN 3 65W 3-PORT FAST (A2667G11)");
        assert_eq!(rows[3].quantity, 5.0);
        assert_eq!(rows[3].unit_cost, 4200.0);
        assert_eq!(rows[3].line_total, 21000.0);

        // Row 4
        assert_eq!(rows[4].description, "FILM VERRE TREMPE PRIVACY S24 ULTRA 9H (ACC-SCR-S24U)");
        assert_eq!(rows[4].quantity, 50.0);
        assert_eq!(rows[4].unit_cost, 350.0);
        assert_eq!(rows[4].line_total, 17500.0);

        let subtotal: f64 = rows.iter().map(|r| r.line_total).sum();
        assert_eq!(subtotal, 128000.0);
    }

    #[test]
    fn test_user_non_pipe_invoice_parsing() {
        let raw_lines = vec![
            "FOURNISSEUR: ACME ELECTRONICS DISTRIBUTION",
            "FACTURE N°: FA-2026-0901",
            "DATE: 28/09/2026",
            "Désignation    Qté    P.U.    Montant",
            "1. ADAPT. SECT. 20W TYPE-C A2305 ORIG APPL    10     3 150,00           31 500,00",
            "   [S/N: 019425208421]",
            "2. ETUI SILIC. NOIR IPH 15 PROMAX             20     1 850,00           37 000,00",
            "   [REF: APC-15PM-B]",
            "3. BELKIN BRAIDED CABLE USBC-USBC 200CM / 2M  15     1 400,00           21 000,00",
            "   [GTIN: 0745883815234]",
            "4. ANKER 735 CHARGER GAN 3 65W 3-PORT FAST     5     4 200,00           21 000,00",
            "   [P/N: A2667G11]",
            "5. FILM VERRE TREMPE PRIVACY S24 ULTRA 9H     50       350,00           17 500,00",
            "   [ACC-SCR-S24U]",
            "TOTAL HT : 128 000,00 DA",
            "TVA 0% : 0,00 DA",
            "NET A PAYER : 128 000,00 DA",
        ];

        let mut boxes = Vec::new();
        for (idx, line) in raw_lines.iter().enumerate() {
            boxes.push(OcrBoundingBox {
                text: line.to_string(),
                x: 0.05,
                y: 0.05 + (idx as f64) * 0.05,
                w: 0.9,
                h: 0.03,
                confidence: 0.99,
            });
        }

        let parser = SpatialLayoutParser::new();
        let parsed = parser.parse_document(boxes);

        // Verify summary extraction
        assert_eq!(
            parsed.summary.detected_supplier.as_deref(),
            Some("ACME ELECTRONICS DISTRIBUTION")
        );
        assert_eq!(
            parsed.summary.detected_invoice_number.as_deref(),
            Some("FA-2026-0901")
        );
        assert_eq!(parsed.summary.detected_date.as_deref(), Some("28/09/2026"));
        assert_eq!(parsed.summary.detected_grand_total, Some(128000.0));

        // Verify product rows count: exactly 5 (headers and summary footers excluded!)
        assert_eq!(
            parsed.rows.len(),
            5,
            "Headers and summary footers must not be parsed as products"
        );

        // Verify that model numbers are preserved 100% intact without regex mangling
        assert_eq!(
            parsed.rows[0].description,
            "ADAPT. SECT. 20W TYPE-C A2305 ORIG APPL"
        );
        assert_eq!(parsed.rows[0].quantity, 10.0);
        assert_eq!(parsed.rows[0].unit_cost, 3150.0);
        assert_eq!(parsed.rows[0].line_total, 31500.0);
        assert_eq!(
            parsed.rows[0].extracted_barcode.as_deref(),
            Some("019425208421")
        );

        assert_eq!(
            parsed.rows[1].description,
            "ETUI SILIC. NOIR IPH 15 PROMAX (APC-15PM-B)"
        );
        assert_eq!(parsed.rows[1].quantity, 20.0);
        assert_eq!(parsed.rows[1].unit_cost, 1850.0);
        assert_eq!(parsed.rows[1].line_total, 37000.0);

        assert_eq!(
            parsed.rows[2].description,
            "BELKIN BRAIDED CABLE USBC-USBC 200CM / 2M"
        );
        assert_eq!(parsed.rows[2].quantity, 15.0);
        assert_eq!(parsed.rows[2].unit_cost, 1400.0);
        assert_eq!(parsed.rows[2].line_total, 21000.0);
        assert_eq!(
            parsed.rows[2].extracted_barcode.as_deref(),
            Some("0745883815234")
        );

        assert_eq!(
            parsed.rows[3].description,
            "ANKER 735 CHARGER GAN 3 65W 3-PORT FAST (A2667G11)"
        );
        assert_eq!(parsed.rows[3].quantity, 5.0);
        assert_eq!(parsed.rows[3].unit_cost, 4200.0);
        assert_eq!(parsed.rows[3].line_total, 21000.0);

        assert_eq!(
            parsed.rows[4].description,
            "FILM VERRE TREMPE PRIVACY S24 ULTRA 9H (ACC-SCR-S24U)"
        );
        assert_eq!(parsed.rows[4].quantity, 50.0);
        assert_eq!(parsed.rows[4].unit_cost, 350.0);
        assert_eq!(parsed.rows[4].line_total, 17500.0);

        let subtotal: f64 = parsed.rows.iter().map(|r| r.line_total).sum();
        assert_eq!(subtotal, 128000.0);
    }

    #[test]
    fn test_mice_trailing_accounting_math() {
        let parser = SpatialLayoutParser::new();

        // Multiplier syntax
        let m1 = parser
            .parse_trailing_accounting_math("Chargeur 25W Type-C 10 x 2500,00 = 25 000,00 DA")
            .unwrap();
        assert_eq!(m1.0, "Chargeur 25W Type-C");
        assert_eq!(m1.1, 10.0);
        assert_eq!(m1.2, 2500.0);
        assert_eq!(m1.3, 25000.0);

        // Single space suffix invariant
        let m2 = parser
            .parse_trailing_accounting_math("Ecran OLED iPhone 13 5 12 500,00 62 500,00")
            .unwrap();
        assert_eq!(m2.0, "Ecran OLED iPhone 13");
        assert_eq!(m2.1, 5.0);
        assert_eq!(m2.2, 12500.0);
        assert_eq!(m2.3, 62500.0);
    }
}

//! Universal File Parsers for Smart Import
//!
//! Robustly supports:
//! - `.xlsx`, `.xlsm`, `.xlsb`, `.ods`, `.xls` (BIFF8 binary) via `calamine`.
//! - HTML `<table>` disguised as `.xls` or `.html`.
//! - SpreadsheetML 2003 XML disguised as `.xls` or `.xml`.
//! - `.dbf` (dBase III, IV, FoxPro, Visual FoxPro) binary table reader.
//! - `.vcf` (vCard 2.1/3.0/4.0) phone contacts export.
//! - `.json` and `.jsonl` (JSON Lines).
//! - `.sql` dumps with `INSERT INTO` statements.
//! - `.csv`, `.tsv`, `.txt` with automatic delimiter detection (`;`, `,`, `\t`, `|`, `:`).
//! - Character Encodings: `UTF-8` (with/without BOM), `UTF-16 LE`, `UTF-16 BE`, `Windows-1256` (Arabic), `Windows-1252` (French).
//! - Security guards: Zip-bomb defense, compression ratio bounds, maximum row bounds, and raw value preservation.

use calamine::{open_workbook_auto_from_rs, Reader};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};

use crate::import::{ImportError, ImportWarning};

pub const MAX_FILE_BYTES: usize = 50 * 1024 * 1024; // 50 MiB compressed
pub const MAX_UNCOMPRESSED_BYTES: u64 = 128 * 1024 * 1024; // 128 MiB uncompressed
pub const MAX_COMPRESSION_RATIO: u64 = 100; // 100:1 max ratio per entry
pub const MAX_ROWS: usize = 100_000;
pub const MAX_COLS: usize = 256;

#[derive(Debug, Clone)]
pub struct ParsedTable {
    pub file_sha256: String,
    pub detected_encoding: Option<String>,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub original_row_indices: Vec<usize>,
    pub warnings: Vec<ImportWarning>,
    pub sheet_names: Vec<String>,
    pub active_sheet: String,
}

/// Compute SHA-256 hex string of bytes
pub fn compute_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Decode raw bytes using encoding_rs.
/// Supports:
/// 1. UTF-8 (and strips UTF-8 BOM 0xEF, 0xBB, 0xBF)
/// 2. UTF-16 LE (BOM 0xFF, 0xFE or null-byte pattern)
/// 3. UTF-16 BE (BOM 0xFE, 0xFF or null-byte pattern)
/// 4. Windows-1256 (Arabic) vs Windows-1252 (French) via script coherence.
pub fn decode_bytes(bytes: &[u8]) -> Result<(String, &'static str), ImportError> {
    if bytes.is_empty() {
        return Ok((String::new(), "UTF-8"));
    }

    // 1. Check UTF-16 LE BOM (0xFF, 0xFE)
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return Ok((s.to_string(), "UTF-16LE"));
    }

    // 2. Check UTF-16 BE BOM (0xFE, 0xFF)
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (s, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return Ok((s.to_string(), "UTF-16BE"));
    }

    // Check for BOM-less UTF-16LE / BE (common in Windows exports)
    if bytes.len() >= 4 {
        if bytes[1] == 0 && bytes[3] == 0 && bytes[0] != 0 && bytes[2] != 0 {
            let (s, _, _) = encoding_rs::UTF_16LE.decode(bytes);
            return Ok((s.to_string(), "UTF-16LE"));
        } else if bytes[0] == 0 && bytes[2] == 0 && bytes[1] != 0 && bytes[3] != 0 {
            let (s, _, _) = encoding_rs::UTF_16BE.decode(bytes);
            return Ok((s.to_string(), "UTF-16BE"));
        }
    }

    // Strip UTF-8 BOM (0xEF, 0xBB, 0xBF) if present
    let slice = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        bytes
    };

    // 3. Try standard UTF-8
    if let Ok(s) = std::str::from_utf8(slice) {
        return Ok((s.to_string(), "UTF-8"));
    }

    // 4. Decode Windows-1256 (Arabic)
    let (s_1256, _, _) = encoding_rs::WINDOWS_1256.decode(slice);

    // 5. Decode Windows-1252 (Western / French)
    let (s_1252, _, _) = encoding_rs::WINDOWS_1252.decode(slice);

    // Compare the share of candidate-script characters, not only raw counts.
    let arabic_count = s_1256
        .chars()
        .filter(|c| ('\u{0600}'..='\u{06FF}').contains(c))
        .count();
    let french_count = s_1252
        .chars()
        .filter(|c| matches!(*c, 'é' | 'è' | 'ê' | 'à' | 'ç' | 'î' | 'ô' | 'ù' | 'É' | 'È' | 'Ç'))
        .count();
    let arabic_share = arabic_count * 1_000_000 / s_1256.chars().count().max(1);
    let french_share = french_count * 1_000_000 / s_1252.chars().count().max(1);

    if arabic_share > french_share {
        Ok((s_1256.to_string(), "WINDOWS-1256"))
    } else {
        Ok((s_1252.to_string(), "WINDOWS-1252"))
    }
}

pub fn decode_bytes_with_override(
    bytes: &[u8],
    encoding_override: Option<&str>,
) -> Result<(String, &'static str), ImportError> {
    let Some(encoding) = encoding_override else {
        return decode_bytes(bytes);
    };

    if bytes.starts_with(&[0xEF, 0xBB, 0xBF])
        || bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0xFE, 0xFF])
    {
        return decode_bytes(bytes);
    }

    let (codec, label) = match encoding {
        "UTF-8" => (encoding_rs::UTF_8, "UTF-8"),
        "WINDOWS-1252" => (encoding_rs::WINDOWS_1252, "WINDOWS-1252"),
        "WINDOWS-1256" => (encoding_rs::WINDOWS_1256, "WINDOWS-1256"),
        "UTF-16LE" => (encoding_rs::UTF_16LE, "UTF-16LE"),
        "UTF-16BE" => (encoding_rs::UTF_16BE, "UTF-16BE"),
        _ => {
            return Err(ImportError::Other(format!(
                "Unsupported character encoding override: {encoding}"
            )))
        }
    };
    let (decoded, _, _) = codec.decode(bytes);
    Ok((decoded.into_owned(), label))
}

/// Sniff CSV/TSV delimiter based on count outside double quotes and line consistency
pub fn sniff_delimiter(text: &str) -> u8 {
    let mut semicolon_counts = Vec::new();
    let mut comma_counts = Vec::new();
    let mut tab_counts = Vec::new();
    let mut pipe_counts = Vec::new();
    let mut colon_counts = Vec::new();

    for line in text.lines().take(20) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut semi = 0usize;
        let mut comma = 0usize;
        let mut tab = 0usize;
        let mut pipe = 0usize;
        let mut colon = 0usize;
        let mut in_quotes = false;

        for c in trimmed.chars() {
            if c == '"' {
                in_quotes = !in_quotes;
            } else if !in_quotes {
                match c {
                    ';' => semi += 1,
                    ',' => comma += 1,
                    '\t' => tab += 1,
                    '|' => pipe += 1,
                    ':' => colon += 1,
                    _ => {}
                }
            }
        }
        if semi > 0 || comma > 0 || tab > 0 || pipe > 0 || colon > 0 {
            semicolon_counts.push(semi);
            comma_counts.push(comma);
            tab_counts.push(tab);
            pipe_counts.push(pipe);
            colon_counts.push(colon);
        }
    }

    if semicolon_counts.is_empty() {
        return b',';
    }

    // Consistency score: a delimiter that appears with the same non-zero count on every line has variance 0
    fn score_delimiter(counts: &[usize]) -> f64 {
        if counts.is_empty() || counts.iter().all(|&c| c == 0) {
            return 0.0;
        }
        let first = counts[0];
        if first == 0 {
            return 0.0;
        }
        let is_uniform = counts.iter().all(|&c| c == first);
        let sum: usize = counts.iter().sum();
        let consistency_bonus = if is_uniform { 1000.0 } else { 0.0 };
        (sum as f64) + consistency_bonus
    }

    let scores = [
        (b';', score_delimiter(&semicolon_counts)),
        (b',', score_delimiter(&comma_counts)),
        (b'\t', score_delimiter(&tab_counts)),
        (b'|', score_delimiter(&pipe_counts)),
        (b':', score_delimiter(&colon_counts)),
    ];

    let mut best = scores[0];
    for s in &scores[1..] {
        if s.1 > best.1 {
            best = *s;
        }
    }

    if best.1 > 0.0 {
        best.0
    } else {
        b','
    }
}

/// Guard against ZIP bombs in .xlsx containers before calamine allocation
pub fn check_zip_bomb(bytes: &[u8]) -> Result<(), ImportError> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(ImportError::ZipBombSuspected(format!(
            "File size exceeds 50 MiB upload limit ({} bytes)",
            bytes.len()
        )));
    }

    // Only inspect if bytes start with ZIP signature PK\x03\x04
    if bytes.starts_with(b"PK\x03\x04") {
        let cursor = Cursor::new(bytes);
        if let Ok(mut archive) = zip::ZipArchive::new(cursor) {
            let mut total_uncompressed: u64 = 0;
            for i in 0..archive.len() {
                if let Ok(file) = archive.by_index(i) {
                    let uncompressed = file.size();
                    let compressed = file.compressed_size();

                    total_uncompressed = total_uncompressed.saturating_add(uncompressed);
                    if total_uncompressed > MAX_UNCOMPRESSED_BYTES {
                        return Err(ImportError::ZipBombSuspected(format!(
                            "Total uncompressed ZIP size exceeds {} MiB limit",
                            MAX_UNCOMPRESSED_BYTES / (1024 * 1024)
                        )));
                    }

                    if compressed > 0 && (uncompressed / compressed) > MAX_COMPRESSION_RATIO {
                        let fname = file.name().ok().map(|s| s.to_string()).unwrap_or_else(|| "unknown".to_string());
                        return Err(ImportError::ZipBombSuspected(format!(
                            "ZIP entry {} exceeds max compression ratio ({} > 100:1)",
                            fname,
                            uncompressed / compressed
                        )));
                    }
                }
            }
        }
    }

    Ok(())
}

fn xml_attribute(attributes: &str, name: &str) -> Option<String> {
    let pattern = format!(r#"(?:^|\s){}="([^"]*)""#, regex::escape(name));
    regex::Regex::new(&pattern)
        .ok()?
        .captures(attributes)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().replace("&amp;", "&"))
}

fn xml_tag_attributes(xml: &str, tag: &str) -> Vec<String> {
    let pattern = format!(r"(?s)<{}\b([^>]*)>", regex::escape(tag));
    regex::Regex::new(&pattern)
        .map(|regex| {
            regex
                .captures_iter(xml)
                .filter_map(|captures| captures.get(1).map(|value| value.as_str().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn xlsx_zero_padding_formats(
    bytes: &[u8],
    active_sheet: &str,
) -> std::collections::HashMap<(usize, usize), usize> {
    let mut result = std::collections::HashMap::new();
    let mut archive = match zip::ZipArchive::new(Cursor::new(bytes)) {
        Ok(archive) => archive,
        Err(_) => return result,
    };

    let mut read_entry = |path: &str| -> Option<String> {
        let mut entry = archive.by_name(path).ok()?;
        let mut content = String::new();
        entry.read_to_string(&mut content).ok()?;
        Some(content)
    };

    let workbook_xml = match read_entry("xl/workbook.xml") {
        Some(xml) => xml,
        None => return result,
    };
    let relationship_id = xml_tag_attributes(&workbook_xml, "sheet")
        .into_iter()
        .find(|attributes| xml_attribute(attributes, "name").as_deref() == Some(active_sheet))
        .and_then(|attributes| xml_attribute(&attributes, "r:id"));
    let Some(relationship_id) = relationship_id else {
        return result;
    };

    let relationships_xml = match read_entry("xl/_rels/workbook.xml.rels") {
        Some(xml) => xml,
        None => return result,
    };
    let target = xml_tag_attributes(&relationships_xml, "Relationship")
        .into_iter()
        .find(|attributes| {
            xml_attribute(attributes, "Id").as_deref() == Some(relationship_id.as_str())
        })
        .and_then(|attributes| xml_attribute(&attributes, "Target"));
    let Some(target) = target else {
        return result;
    };
    let worksheet_path = if target.starts_with('/') {
        target.trim_start_matches('/').to_string()
    } else if target.starts_with("xl/") {
        target
    } else {
        format!("xl/{target}")
    };

    let styles_xml = match read_entry("xl/styles.xml") {
        Some(xml) => xml,
        None => return result,
    };
    let mut number_formats = std::collections::HashMap::new();
    for attributes in xml_tag_attributes(&styles_xml, "numFmt") {
        let (Some(id), Some(code)) = (
            xml_attribute(&attributes, "numFmtId").and_then(|value| value.parse::<u32>().ok()),
            xml_attribute(&attributes, "formatCode"),
        ) else {
            continue;
        };
        let format = code.split(';').next().unwrap_or_default();
        if !format.is_empty() && format.chars().all(|character| character == '0') {
            number_formats.insert(id, format.len());
        }
    }

    let cell_xfs = regex::Regex::new(r"(?s)<cellXfs\b[^>]*>(.*?)</cellXfs>")
        .ok()
        .and_then(|regex| regex.captures(&styles_xml))
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str())
        .unwrap_or_default();
    let style_widths: Vec<Option<usize>> = xml_tag_attributes(cell_xfs, "xf")
        .iter()
        .map(|attributes| {
            xml_attribute(attributes, "numFmtId")
                .and_then(|value| value.parse::<u32>().ok())
                .and_then(|format_id| number_formats.get(&format_id).copied())
        })
        .collect();
    let worksheet_xml = match read_entry(&worksheet_path) {
        Some(xml) => xml,
        None => return result,
    };
    let cell_regex = match regex::Regex::new(r#"(?s)<c\b([^>]*)>(?:.*?)</c>"#) {
        Ok(regex) => regex,
        Err(_) => return result,
    };

    for captures in cell_regex.captures_iter(&worksheet_xml) {
        let Some(attributes) = captures.get(1).map(|value| value.as_str()) else {
            continue;
        };
        let (Some(reference), Some(style_id)) = (
            xml_attribute(attributes, "r"),
            xml_attribute(attributes, "s").and_then(|value| value.parse::<usize>().ok()),
        ) else {
            continue;
        };
        let Some(width) = style_widths.get(style_id).copied().flatten() else {
            continue;
        };
        let split = reference.find(|character: char| character.is_ascii_digit());
        let Some(split) = split else {
            continue;
        };
        let column = reference[..split]
            .chars()
            .try_fold(0usize, |value, character| {
                character
                    .to_ascii_uppercase()
                    .is_ascii_uppercase()
                    .then(|| {
                        value * 26
                            + (character.to_ascii_uppercase() as usize
                                - 'A' as usize
                                + 1)
                    })
            })
            .map(|value| value.saturating_sub(1));
        let row = reference[split..]
            .parse::<usize>()
            .ok()
            .map(|value| value.saturating_sub(1));
        if let (Some(row), Some(column)) = (row, column) {
            result.insert((row, column), width);
        }
    }

    result
}

/// Parse delimited text (CSV, TSV, clipboard text) into raw rows
pub fn parse_delimited_text(text: &str, delimiter: u8) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut current_row = Vec::new();
    let mut current_cell = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut i = 0;

    let delim_char = delimiter as char;

    while i < len {
        let ch = chars[i];
        if in_quotes {
            if ch == '"' {
                if i + 1 < len && chars[i + 1] == '"' {
                    // Escaped quote: ""
                    current_cell.push('"');
                    i += 1;
                } else {
                    in_quotes = false;
                }
            } else {
                current_cell.push(ch);
            }
        } else {
            if ch == '"' {
                in_quotes = true;
            } else if ch == delim_char {
                current_row.push(current_cell.trim().to_string());
                current_cell.clear();
            } else if ch == '\r' {
                if i + 1 < len && chars[i + 1] == '\n' {
                    i += 1;
                }
                current_row.push(current_cell.trim().to_string());
                current_cell.clear();
                rows.push(current_row);
                current_row = Vec::new();
            } else if ch == '\n' {
                current_row.push(current_cell.trim().to_string());
                current_cell.clear();
                rows.push(current_row);
                current_row = Vec::new();
            } else {
                current_cell.push(ch);
            }
        }
        i += 1;
    }

    if !current_cell.is_empty() || !current_row.is_empty() {
        current_row.push(current_cell.trim().to_string());
        rows.push(current_row);
    }

    rows
}

/// Unescape basic HTML entities
fn unescape_html_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&eacute;", "é")
        .replace("&egrave;", "è")
        .replace("&ecirc;", "ê")
        .replace("&agrave;", "à")
        .replace("&ccedil;", "ç")
        .replace("&icirc;", "î")
        .replace("&ocirc;", "ô")
        .replace("&ugrave;", "ù")
        .replace("&Eacute;", "É")
        .replace("&Egrave;", "È")
        .replace("&Ccedil;", "Ç")
}

/// Strip inner HTML tags
fn strip_html_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(c);
        }
    }
    unescape_html_entities(out.trim())
}

/// Parse HTML `<table>` disguised as `.xls` or `.html`
pub fn parse_html_table(html: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let lower = html.to_lowercase();
    let mut search_pos = 0;

    while let Some(tr_start) = lower[search_pos..].find("<tr") {
        let abs_tr_start = search_pos + tr_start;
        let tr_open_end = match lower[abs_tr_start..].find('>') {
            Some(p) => abs_tr_start + p + 1,
            None => break,
        };

        let tr_end = match lower[tr_open_end..].find("</tr>") {
            Some(p) => tr_open_end + p,
            None => lower.len(),
        };

        let tr_content = &html[tr_open_end..tr_end];
        let mut row_cells = Vec::new();
        let mut cell_pos = 0;
        let tr_lower = tr_content.to_lowercase();

        while cell_pos < tr_content.len() {
            // Find next <td or <th
            let next_td = tr_lower[cell_pos..].find("<td");
            let next_th = tr_lower[cell_pos..].find("<th");

            let (tag_kind, rel_pos) = match (next_td, next_th) {
                (Some(td), Some(th)) => if td < th { ("td", td) } else { ("th", th) },
                (Some(td), None) => ("td", td),
                (None, Some(th)) => ("th", th),
                (None, None) => break,
            };

            let tag_start = cell_pos + rel_pos;
            let tag_open_end = match tr_lower[tag_start..].find('>') {
                Some(p) => tag_start + p + 1,
                None => break,
            };

            let close_tag = if tag_kind == "td" { "</td>" } else { "</th>" };
            let (tag_content, next_pos) = match tr_lower[tag_open_end..].find(close_tag) {
                Some(p) => (&tr_content[tag_open_end..tag_open_end + p], tag_open_end + p + close_tag.len()),
                None => (&tr_content[tag_open_end..], tr_content.len()),
            };

            row_cells.push(strip_html_tags(tag_content));
            cell_pos = next_pos;
        }

        if !row_cells.is_empty() {
            rows.push(row_cells);
        }

        search_pos = tr_end + 5;
    }

    rows
}

/// Parse XML Spreadsheet 2003 (SpreadsheetML) disguised as `.xls` or `.xml`
pub fn parse_spreadsheetml_xml(xml: &str) -> Result<Vec<Vec<String>>, ImportError> {
    let mut rows = Vec::new();
    let lower = xml.to_lowercase();
    let mut search_pos = 0;

    while let Some(row_start) = lower[search_pos..].find("<row") {
        let abs_row_start = search_pos + row_start;
        let row_open_end = match lower[abs_row_start..].find('>') {
            Some(p) => abs_row_start + p + 1,
            None => break,
        };

        let row_end = match lower[row_open_end..].find("</row>") {
            Some(p) => row_open_end + p,
            None => lower.len(),
        };

        let row_content = &xml[row_open_end..row_end];
        let mut row_cells = Vec::new();
        let mut cell_pos = 0;
        let row_lower = row_content.to_lowercase();

        while let Some(cell_start) = row_lower[cell_pos..].find("<cell") {
            let abs_cell_start = cell_pos + cell_start;
            let cell_open_end = match row_lower[abs_cell_start..].find('>') {
                Some(p) => abs_cell_start + p + 1,
                None => break,
            };

            let cell_end = match row_lower[cell_open_end..].find("</cell>") {
                Some(p) => cell_open_end + p,
                None => row_content.len(),
            };

            let cell_content = &row_content[cell_open_end..cell_end];
            let cell_lower = cell_content.to_lowercase();

            let val = if let Some(data_start) = cell_lower.find("<data") {
                let d_open_end = match cell_lower[data_start..].find('>') {
                    Some(p) => data_start + p + 1,
                    None => data_start,
                };
                let d_end = match cell_lower[d_open_end..].find("</data>") {
                    Some(p) => d_open_end + p,
                    None => cell_content.len(),
                };
                unescape_html_entities(cell_content[d_open_end..d_end].trim())
            } else {
                strip_html_tags(cell_content)
            };

            row_cells.push(val);
            cell_pos = cell_end + 7;
        }

        if !row_cells.is_empty() {
            rows.push(row_cells);
        }

        search_pos = row_end + 6;
    }

    Ok(rows)
}

/// Check if bytes represent a dBase / FoxPro DBF file
pub fn is_dbf_file(bytes: &[u8], lower_name: &str) -> bool {
    if bytes.len() < 32 {
        return false;
    }
    let valid_versions: [u8; 11] = [
        0x02, 0x03, 0x30, 0x31, 0x32, 0x43, 0x83, 0x8B, 0xCB, 0xF5, 0xFB,
    ];
    let is_version = valid_versions.contains(&bytes[0]);
    let month = bytes[2];
    let day = bytes[3];
    let valid_date = (1..=12).contains(&month) && (1..=31).contains(&day);

    if !is_version || !valid_date {
        return false;
    }

    let header_len = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
    let record_len = u16::from_le_bytes([bytes[10], bytes[11]]) as usize;

    if header_len < 32 || record_len == 0 {
        return false;
    }

    lower_name.ends_with(".dbf") || (header_len <= bytes.len() && bytes.len() >= header_len + record_len)
}

/// Parse dBase III / IV / FoxPro binary table (.dbf)
pub fn parse_dbf_bytes(bytes: &[u8]) -> Result<Vec<Vec<String>>, ImportError> {
    if bytes.len() < 32 {
        return Err(ImportError::EmptyFile);
    }

    let num_records = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    let header_len = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
    let record_len = u16::from_le_bytes([bytes[10], bytes[11]]) as usize;

    if header_len < 32 || header_len > bytes.len() || record_len == 0 {
        return Err(ImportError::Other("Invalid DBF header structure".to_string()));
    }

    // Read field descriptors (32 bytes each)
    let mut fields: Vec<(String, usize)> = Vec::new();
    let mut offset = 32;

    while offset + 32 <= header_len {
        if bytes[offset] == 0x0D {
            break; // Header terminator
        }
        // Field name is up to 11 bytes, null-terminated
        let name_bytes = &bytes[offset..offset + 11];
        let name_len = name_bytes.iter().position(|&b| b == 0).unwrap_or(11);
        let field_name = String::from_utf8_lossy(&name_bytes[..name_len]).trim().to_string();
        let field_length = bytes[offset + 16] as usize;

        if !field_name.is_empty() && field_length > 0 {
            fields.push((field_name, field_length));
        }

        offset += 32;
    }

    if fields.is_empty() {
        return Err(ImportError::Other("DBF file contains no field descriptors".to_string()));
    }

    let headers: Vec<String> = fields.iter().map(|(n, _)| n.clone()).collect();
    let mut rows = vec![headers];

    // Read records
    let mut rec_offset = header_len;
    let mut count = 0;

    while rec_offset + record_len <= bytes.len() && count < num_records && count < MAX_ROWS {
        // First byte of record is deletion flag (0x20 = active, 0x2A = deleted)
        let is_deleted = bytes[rec_offset] == 0x2A;
        if !is_deleted {
            let mut row = Vec::new();
            let mut field_pos = rec_offset + 1;

            for (_, f_len) in &fields {
                if field_pos + f_len <= bytes.len() {
                    let field_bytes = &bytes[field_pos..field_pos + f_len];
                    let (val, _) = decode_bytes(field_bytes)?;
                    row.push(val.trim().to_string());
                } else {
                    row.push(String::new());
                }
                field_pos += f_len;
            }
            rows.push(row);
        }
        rec_offset += record_len;
        count += 1;
    }

    Ok(rows)
}

fn unfold_vcard_lines(text: &str) -> Vec<String> {
    let mut unfolded = Vec::<String>::new();
    for physical in text.lines() {
        let line = physical.trim_end_matches('\r');
        if let Some(previous) = unfolded.last_mut() {
            if previous.ends_with('=') {
                previous.pop();
                previous.push_str(line.trim_start());
                continue;
            }
        }
        if (line.starts_with(' ') || line.starts_with('\t')) && !unfolded.is_empty() {
            unfolded.last_mut().unwrap().push_str(line.trim_start());
        } else {
            unfolded.push(line.to_string());
        }
    }
    unfolded
}

fn decode_quoted_printable(value: &str, charset: Option<&str>) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'=' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (
                (bytes[index + 1] as char).to_digit(16),
                (bytes[index + 2] as char).to_digit(16),
            ) {
                decoded.push(((high << 4) | low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }

    match charset.unwrap_or("").to_ascii_lowercase().as_str() {
        "windows-1252" | "cp1252" | "iso-8859-1" | "latin1" => {
            encoding_rs::WINDOWS_1252.decode(&decoded).0.into_owned()
        }
        "windows-1256" | "cp1256" => {
            encoding_rs::WINDOWS_1256.decode(&decoded).0.into_owned()
        }
        _ => String::from_utf8(decoded.clone()).unwrap_or_else(|_| {
            encoding_rs::WINDOWS_1252.decode(&decoded).0.into_owned()
        }),
    }
}

fn unescape_vcard_value(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('n' | 'N') => output.push('\n'),
                Some(escaped) => output.push(escaped),
                None => output.push('\\'),
            }
        } else {
            output.push(ch);
        }
    }
    output
}

fn vcard_property(line: &str) -> Option<(String, Vec<String>, String)> {
    let (property, value) = line.split_once(':')?;
    let mut parts = property.split(';');
    let name = parts.next()?.rsplit('.').next()?.to_ascii_uppercase();
    let params = parts.map(|part| part.to_ascii_uppercase()).collect();
    Some((name, params, value.to_string()))
}

/// Parse vCard 2.1/3.0/4.0 contacts, preserving additional fields for staging.
pub fn parse_vcf_text(text: &str) -> Vec<Vec<String>> {
    let mut rows = vec![vec![
        "Nom Client".to_string(),
        "Téléphone".to_string(),
        "Téléphone secondaire".to_string(),
        "Email".to_string(),
        "Adresse".to_string(),
        "Notes".to_string(),
    ]];
    let mut current: Option<Vec<String>> = None;
    let mut phones = Vec::<String>::new();

    for line in unfold_vcard_lines(text) {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("BEGIN:VCARD") {
            current = Some(vec![String::new(); 5]);
            phones.clear();
            continue;
        }
        if trimmed.eq_ignore_ascii_case("END:VCARD") {
            if let Some(mut contact) = current.take() {
                let phone = phones.first().cloned().unwrap_or_default();
                let secondary = phones.get(1).cloned().unwrap_or_default();
                if !contact[0].is_empty() || !phone.is_empty() {
                    contact[1] = phone;
                    contact.insert(2, secondary);
                    rows.push(contact);
                }
            }
            continue;
        }

        let Some(contact) = current.as_mut() else {
            continue;
        };
        let Some((name, params, raw_value)) = vcard_property(trimmed) else {
            continue;
        };
        let charset = params.iter().find_map(|param| {
            param
                .strip_prefix("CHARSET=")
                .map(|value| value.trim_matches('"').trim())
        });
        let encoded = params.iter().any(|param| {
            param == "ENCODING=QUOTED-PRINTABLE" || param == "ENCODING=QP"
        });
        let value = if encoded {
            decode_quoted_printable(&raw_value, charset)
        } else {
            raw_value
        };
        let value = unescape_vcard_value(value.trim());

        match name.as_str() {
            "FN" if !value.is_empty() => contact[0] = value,
            "N" if contact[0].is_empty() => {
                let parts: Vec<&str> = value.split(';').collect();
                contact[0] = format!(
                    "{} {}",
                    parts.get(1).copied().unwrap_or("").trim(),
                    parts.first().copied().unwrap_or("").trim()
                )
                .trim()
                .to_string();
            }
            "TEL" if !value.is_empty() && !phones.contains(&value) => phones.push(value),
            "EMAIL" if contact[2].is_empty() => contact[2] = value,
            "ADR" => {
                contact[3] = value
                    .split(';')
                    .map(str::trim)
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ");
            }
            "NOTE" => contact[4] = value,
            _ => {}
        }
    }

    rows
}

/// Helper to convert a JSON array of objects to tabular rows
fn parse_json_array_of_objects(arr: &[serde_json::Value]) -> Result<Vec<Vec<String>>, ImportError> {
    let mut headers: Vec<String> = Vec::new();
    for item in arr {
        if let Some(obj) = item.as_object() {
            for key in obj.keys() {
                if !headers.contains(key) {
                    headers.push(key.clone());
                }
            }
        }
    }

    if headers.is_empty() {
        return Err(ImportError::EmptyFile);
    }

    let mut rows = vec![headers.clone()];
    for item in arr {
        if let Some(obj) = item.as_object() {
            let mut row = Vec::new();
            for h in &headers {
                let val = match obj.get(h) {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Number(n)) => n.to_string(),
                    Some(serde_json::Value::Bool(b)) => b.to_string(),
                    Some(serde_json::Value::Null) | None => String::new(),
                    Some(other) => other.to_string(),
                };
                row.push(val);
            }
            rows.push(row);
        }
    }
    Ok(rows)
}

/// Parse JSON or JSON Lines (.json, .jsonl)
pub fn parse_json_text(text: &str) -> Result<Vec<Vec<String>>, ImportError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(ImportError::EmptyFile);
    }

    // 1. Try JSON Array of Objects: [ { "a": 1 }, { "a": 2 } ]
    if trimmed.starts_with('[') {
        let parsed: serde_json::Value = serde_json::from_str(trimmed)?;
        if let Some(arr) = parsed.as_array() {
            return parse_json_array_of_objects(arr);
        }
    }

    // 2. Try JSON Object wrapping an array of objects: { "products": [ ... ] } or { "data": [ ... ] }
    if trimmed.starts_with('{') {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(obj) = parsed.as_object() {
                for key in ["products", "data", "items", "articles", "rows", "records", "clients", "customers"] {
                    if let Some(val) = obj.get(key) {
                        if let Some(arr) = val.as_array() {
                            return parse_json_array_of_objects(arr);
                        }
                    }
                }
                for val in obj.values() {
                    if let Some(arr) = val.as_array() {
                        if arr.iter().any(|item| item.is_object()) {
                            return parse_json_array_of_objects(arr);
                        }
                    }
                }
            }
        }
    }

    // 3. Try JSON Lines: each line is {"...": ...}
    let mut line_objects = Vec::new();
    let mut headers = Vec::new();

    for line in trimmed.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(l) {
            if let Some(obj) = val.as_object() {
                for key in obj.keys() {
                    if !headers.contains(key) {
                        headers.push(key.clone());
                    }
                }
                line_objects.push(obj.clone());
            }
        }
    }

    if !line_objects.is_empty() && !headers.is_empty() {
        let mut rows = vec![headers.clone()];
        for obj in line_objects {
            let mut row = Vec::new();
            for h in &headers {
                let val = match obj.get(h) {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Number(n)) => n.to_string(),
                    Some(serde_json::Value::Bool(b)) => b.to_string(),
                    Some(serde_json::Value::Null) | None => String::new(),
                    Some(other) => other.to_string(),
                };
                row.push(val);
            }
            rows.push(row);
        }
        return Ok(rows);
    }

    Err(ImportError::Other("Unrecognized JSON format".to_string()))
}

fn split_sql_statements(text: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    let mut quote = None;
    let mut line_comment = false;
    let mut block_comment = false;

    while let Some(ch) = chars.next() {
        if line_comment {
            if ch == '\n' {
                line_comment = false;
                current.push(' ');
            }
            continue;
        }
        if block_comment {
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                block_comment = false;
                current.push(' ');
            }
            continue;
        }
        if let Some(delimiter) = quote {
            current.push(ch);
            if ch == '\\' {
                if let Some(escaped) = chars.next() {
                    current.push(escaped);
                }
            } else if ch == delimiter {
                if chars.peek() == Some(&delimiter) {
                    current.push(chars.next().unwrap());
                } else {
                    quote = None;
                }
            }
            continue;
        }

        if ch == '-' && chars.peek() == Some(&'-') {
            chars.next();
            line_comment = true;
        } else if ch == '#' {
            line_comment = true;
        } else if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            block_comment = true;
        } else if matches!(ch, '\'' | '"' | '`') {
            quote = Some(ch);
            current.push(ch);
        } else if ch == ';' {
            if !current.trim().is_empty() {
                statements.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.trim().is_empty() {
        statements.push(current);
    }
    statements
}

fn skip_sql_space(input: &str, index: &mut usize) {
    while let Some(ch) = input[*index..].chars().next() {
        if !ch.is_whitespace() {
            break;
        }
        *index += ch.len_utf8();
    }
}

fn consume_sql_keyword(input: &str, index: &mut usize, keyword: &str) -> bool {
    skip_sql_space(input, index);
    let end = *index + keyword.len();
    if end <= input.len()
        && input[*index..end].eq_ignore_ascii_case(keyword)
        && input[end..]
            .chars()
            .next()
            .map(|ch| !ch.is_ascii_alphanumeric() && ch != '_')
            .unwrap_or(true)
    {
        *index = end;
        true
    } else {
        false
    }
}

fn parse_sql_identifier(input: &str, index: &mut usize) -> Option<String> {
    skip_sql_space(input, index);
    let first = input[*index..].chars().next()?;
    let (close, quoted) = match first {
        '`' | '"' => (Some(first), true),
        '[' => (Some(']'), true),
        _ => (None, false),
    };
    if quoted {
        *index += first.len_utf8();
        let start = *index;
        while let Some(ch) = input[*index..].chars().next() {
            if Some(ch) == close {
                let identifier = input[start..*index].to_string();
                *index += ch.len_utf8();
                return Some(identifier);
            }
            *index += ch.len_utf8();
        }
        return None;
    }

    let start = *index;
    while let Some(ch) = input[*index..].chars().next() {
        if ch.is_whitespace() || matches!(ch, '(' | ')' | ',') {
            break;
        }
        *index += ch.len_utf8();
    }
    (start < *index).then(|| input[start..*index].to_string())
}

fn parse_sql_string(input: &str, index: &mut usize, quote: char) -> Result<String, ImportError> {
    *index += quote.len_utf8();
    let mut value = String::new();
    while let Some(ch) = input[*index..].chars().next() {
        *index += ch.len_utf8();
        if ch == '\\' {
            let escaped = input[*index..]
                .chars()
                .next()
                .ok_or_else(|| ImportError::Other("Unterminated SQL escape".to_string()))?;
            *index += escaped.len_utf8();
            value.push(match escaped {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
        } else if ch == quote {
            if input[*index..].starts_with(quote) {
                *index += quote.len_utf8();
                value.push(quote);
            } else {
                return Ok(value);
            }
        } else {
            value.push(ch);
        }
    }
    Err(ImportError::Other("Unterminated SQL string literal".to_string()))
}

fn parse_sql_tuple(input: &str, index: &mut usize) -> Result<Vec<String>, ImportError> {
    skip_sql_space(input, index);
    if !input[*index..].starts_with('(') {
        return Err(ImportError::Other("Expected SQL VALUES tuple".to_string()));
    }
    *index += 1;
    let mut values = Vec::new();

    loop {
        skip_sql_space(input, index);
        let Some(first) = input[*index..].chars().next() else {
            return Err(ImportError::Other("Unterminated SQL VALUES tuple".to_string()));
        };
        let value = if first == '\'' || first == '"' {
            parse_sql_string(input, index, first)?
        } else {
            let start = *index;
            while let Some(ch) = input[*index..].chars().next() {
                if matches!(ch, ',' | ')') {
                    break;
                }
                if ch == '(' {
                    return Err(ImportError::Other("SQL expressions are not accepted as data".to_string()));
                }
                *index += ch.len_utf8();
            }
            let token = input[start..*index].trim();
            let upper = token.to_ascii_uppercase();
            if !matches!(upper.as_str(), "NULL" | "TRUE" | "FALSE")
                && token.parse::<f64>().is_err()
            {
                return Err(ImportError::Other("SQL expressions are not accepted as data".to_string()));
            }
            if upper == "NULL" { String::new() } else { token.to_string() }
        };
        values.push(value);
        skip_sql_space(input, index);
        if input[*index..].starts_with(',') {
            *index += 1;
            continue;
        }
        if input[*index..].starts_with(')') {
            *index += 1;
            return Ok(values);
        }
        return Err(ImportError::Other("Malformed SQL VALUES tuple".to_string()));
    }
}

fn canonical_sql_columns(table: &str) -> Option<Vec<String>> {
    match table {
        "products" | "product" => Some(
            "id,sku,barcode,title,brand,compatible_model,category,price,wholesale_price,cost_price,stock"
                .split(',')
                .map(str::to_string)
                .collect(),
        ),
        "customers" | "customer" | "clients" | "client" => Some(
            "id,name,phone,email,loyalty_points,store_credit,pricing_tier,total_spent"
                .split(',')
                .map(str::to_string)
                .collect(),
        ),
        _ => None,
    }
}

fn parse_sql_insert_statement(statement: &str) -> Result<Option<(String, Vec<String>, Vec<Vec<String>>)>, ImportError> {
    let mut index = 0;
    if !consume_sql_keyword(statement, &mut index, "INSERT") {
        return Ok(None);
    }
    if consume_sql_keyword(statement, &mut index, "OR") {
        let _ = parse_sql_identifier(statement, &mut index);
    }
    if !consume_sql_keyword(statement, &mut index, "INTO") {
        return Ok(None);
    }
    let Some(raw_table) = parse_sql_identifier(statement, &mut index) else {
        return Ok(None);
    };
    let table = raw_table
        .rsplit('.')
        .next()
        .unwrap_or(&raw_table)
        .trim_matches(['`', '"', '[', ']'])
        .to_ascii_lowercase();
    let Some(mut columns) = canonical_sql_columns(&table) else {
        return Ok(None);
    };

    skip_sql_space(statement, &mut index);
    if statement[index..].starts_with('(') {
        index += 1;
        columns.clear();
        loop {
            let Some(column) = parse_sql_identifier(statement, &mut index) else {
                return Err(ImportError::Other("Malformed SQL INSERT column list".to_string()));
            };
            columns.push(
                column
                    .rsplit('.')
                    .next()
                    .unwrap_or(&column)
                    .trim_matches(['`', '"', '[', ']'])
                    .to_string(),
            );
            skip_sql_space(statement, &mut index);
            if statement[index..].starts_with(',') {
                index += 1;
            } else if statement[index..].starts_with(')') {
                index += 1;
                break;
            } else {
                return Err(ImportError::Other("Malformed SQL INSERT column list".to_string()));
            }
        }
    }

    if !consume_sql_keyword(statement, &mut index, "VALUES") {
        return Err(ImportError::Other("Only SQL INSERT ... VALUES is supported".to_string()));
    }
    let mut records = Vec::new();
    loop {
        skip_sql_space(statement, &mut index);
        if index >= statement.len() {
            break;
        }
        if !statement[index..].starts_with('(') {
            break;
        }
        let values = parse_sql_tuple(statement, &mut index)?;
        if values.len() != columns.len() {
            return Err(ImportError::Other(format!(
                "SQL INSERT column/value count mismatch ({} columns, {} values)",
                columns.len(),
                values.len()
            )));
        }
        records.push(values);
        skip_sql_space(statement, &mut index);
        if statement[index..].starts_with(',') {
            index += 1;
            continue;
        }
        break;
    }
    if records.is_empty() {
        return Err(ImportError::Other("SQL INSERT has no data tuples".to_string()));
    }
    Ok(Some((table, columns, records)))
}

/// Extract literal data from supported SQL INSERT statements without executing SQL.
pub fn parse_sql_insert_text(text: &str) -> Result<Vec<Vec<String>>, ImportError> {
    let mut table_name: Option<String> = None;
    let mut headers = Vec::<String>::new();
    let mut records = Vec::<(Vec<String>, Vec<String>)>::new();

    for statement in split_sql_statements(text) {
        let Some((table, columns, values)) = parse_sql_insert_statement(&statement)? else {
            continue;
        };
        if table_name.as_ref().is_some_and(|existing| existing != &table) {
            return Err(ImportError::Other(
                "A SQL import must contain INSERT statements for one supported table".to_string(),
            ));
        }
        table_name = Some(table);
        for column in &columns {
            if !headers.contains(column) {
                headers.push(column.clone());
            }
        }
        records.extend(values.into_iter().map(|row| (columns.clone(), row)));
    }

    if records.is_empty() || headers.is_empty() {
        return Err(ImportError::Other("No supported SQL INSERT ... VALUES statements found".to_string()));
    }

    let rows: Vec<Vec<String>> = records
        .into_iter()
        .map(|(columns, values)| {
            let mut row = vec![String::new(); headers.len()];
            for (column, value) in columns.iter().zip(values) {
                if let Some(index) = headers.iter().position(|header| header == column) {
                    row[index] = value;
                }
            }
            row
        })
        .collect();
    let mut table = vec![headers];
    table.extend(rows);
    Ok(table)
}

/// Clean table: strips banners, finds header row, handles summary footer rows
pub fn clean_raw_table(
    raw_rows: Vec<Vec<String>>,
    file_sha256: String,
    sheet_names: Vec<String>,
    active_sheet: String,
    detected_encoding: Option<String>,
) -> Result<ParsedTable, ImportError> {
    if raw_rows.is_empty() {
        return Err(ImportError::EmptyFile);
    }

    let mut warnings = Vec::new();

    // 1. Filter out completely blank lines
    let non_blank: Vec<(usize, Vec<String>)> = raw_rows
        .into_iter()
        .enumerate()
        .filter(|(_, r)| r.iter().any(|cell| !cell.trim().is_empty()))
        .collect();

    if non_blank.is_empty() {
        return Err(ImportError::EmptyFile);
    }

    // 2. Identify header row:
    // Score the first 15 candidate rows. Real table headers have:
    // - High match with known retail header synonyms (Désignation, Prix, Stock, Code barre, Téléphone, etc.)
    // - Mostly text labels (not large numeric IDs, barcodes, or prices)
    // - Full column width
    let mut best_header_idx = 0;
    let mut best_score: i32 = -999;
    let mut first_multi_col_idx = 0;
    let mut found_multi_col = false;

    for (idx, (_, row)) in non_blank.iter().enumerate().take(15) {
        let non_empty_cells: Vec<&str> = row.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        if non_empty_cells.len() < 2 {
            continue;
        }
        if !found_multi_col {
            first_multi_col_idx = idx;
            found_multi_col = true;
        }

        let mut matching_synonyms = 0;
        let mut numeric_cells = 0;
        let mut text_cells = 0;

        for &cell in &non_empty_cells {
            let (ctype, conf) = crate::import::detect::match_header_synonym(cell);
            if conf >= 0.85 && ctype != crate::import::ColumnType::Ignored {
                matching_synonyms += 1;
            }

            let is_num = cell.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',' || c == '-');
            if is_num && cell.len() >= 3 {
                numeric_cells += 1;
            } else if cell.chars().any(|c| c.is_alphabetic()) {
                text_cells += 1;
            }
        }

        let row_score = (matching_synonyms * 30) as i32 + (text_cells * 5) as i32 - (numeric_cells * 25) as i32;

        if row_score > best_score {
            best_score = row_score;
            best_header_idx = idx;
        }
    }

    // If a candidate row achieved a strong header synonym score (>= 25), use it as header_idx!
    // Otherwise fall back to the first row with >= 2 columns (e.g. for headerless files).
    let header_idx = if best_score >= 25 {
        if best_header_idx > 0 {
            warnings.push(ImportWarning {
                code: "BannerRowsSkipped".to_string(),
                message: format!("Skipped {} banner/metadata rows before table headers", best_header_idx),
            });
        }
        best_header_idx
    } else {
        first_multi_col_idx
    };

    let (_orig_header_line, mut headers) = non_blank[header_idx].clone();

    // Fill empty header names with Col_1, Col_2... and strip invisible characters
    for (i, h) in headers.iter_mut().enumerate() {
        let clean: String = h
            .chars()
            .filter(|&c| c != '\u{200B}' && c != '\u{200C}' && c != '\u{FEFF}' && c != '\u{00A0}' && c != '\u{202F}')
            .collect();
        let trimmed = clean.trim();
        if trimmed.is_empty() {
            *h = format!("Col_{}", i + 1);
        } else {
            *h = trimmed.to_string();
        }
    }

    // Disambiguate duplicate header names: e.g. "Prix", "Prix" -> "Prix", "Prix_2"
    let mut seen_headers = std::collections::HashMap::new();
    for h in headers.iter_mut() {
        let base = h.clone();
        let count = seen_headers.entry(base.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            *h = format!("{}_{}", base, count);
        }
    }

    let mut data_rows = Vec::new();
    let mut orig_indices = Vec::new();

    // 3. Process remaining rows and check for summary/total rows at footer
    for &(orig_idx, ref row) in &non_blank[header_idx + 1..] {
        if row.iter().all(|c| c.trim().is_empty()) {
            continue;
        }

        // Check if row is a summary / total row (e.g., "Total", "TOTAL GÉNÉRAL", "المجموع")
        let first_non_empty = row.iter().find(|c| !c.trim().is_empty()).map(|s| s.to_lowercase());
        if let Some(text) = first_non_empty {
            if text.starts_with("total")
                || text.starts_with("totaux")
                || text.starts_with("somme")
                || text.starts_with("sous-total")
                || text.starts_with("sous total")
                || text.starts_with("grand total")
                || text.starts_with("nombre d")
                || text.starts_with("nombre de")
                || text.starts_with("nb articles")
                || text.starts_with("nb lignes")
                || text.starts_with("bilan")
                || text.starts_with("المجموع")
                || text.starts_with("المجموع العام")
                || text.starts_with("عدد المواد")
                || text.starts_with("عدد الأسطر")
            {
                warnings.push(ImportWarning {
                    code: "SummaryRowSkipped".to_string(),
                    message: format!("Summary/Total row skipped at original line {}", orig_idx + 1),
                });
                continue;
            }
        }

        data_rows.push(row.clone());
        orig_indices.push(orig_idx + 1);

        if data_rows.len() > MAX_ROWS {
            return Err(ImportError::MaxRowsExceeded(MAX_ROWS));
        }
    }

    Ok(ParsedTable {
        file_sha256,
        detected_encoding,
        headers,
        rows: data_rows,
        original_row_indices: orig_indices,
        warnings,
        sheet_names,
        active_sheet,
    })
}

/// Universal parser from raw bytes: handles XLSX, XLS, ODS, HTML, SpreadsheetML, DBF, VCF, JSON, SQL, and CSV/TSV
pub fn parse_bytes(
    bytes: &[u8],
    file_name: &str,
    sheet_index: Option<usize>,
) -> Result<ParsedTable, ImportError> {
    parse_bytes_with_encoding_override(bytes, file_name, sheet_index, None)
}

pub fn parse_bytes_with_encoding_override(
    bytes: &[u8],
    file_name: &str,
    sheet_index: Option<usize>,
    encoding_override: Option<&str>,
) -> Result<ParsedTable, ImportError> {
    let file_sha256 = compute_sha256(bytes);
    let lower_name = file_name.to_lowercase();

    // Pre-flight zip bomb / size checks
    check_zip_bomb(bytes)?;

    // 1. Binary dBase / FoxPro (.dbf)
    if is_dbf_file(bytes, &lower_name) {
        let raw_rows = parse_dbf_bytes(bytes)?;
        return clean_raw_table(
            raw_rows,
            file_sha256,
            vec!["dbf".to_string()],
            "dbf".to_string(),
            Some("DBF code page".to_string()),
        );
    }

    // 2. Genuine ZIP archives (.xlsx, .xlsm, .ods) or OLE2 binary Excel (.xls)
    let is_zip = bytes.starts_with(b"PK\x03\x04");
    let is_ole2 = bytes.starts_with(b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1");

    if is_zip || is_ole2 {
        let cursor = Cursor::new(bytes);
        let mut workbook = open_workbook_auto_from_rs(cursor).map_err(|error| {
            ImportError::Other(format!("Could not read Excel workbook: {error}"))
        })?;
        let sheet_names: Vec<String> = workbook.sheet_names();
        if sheet_names.is_empty() {
            return Err(ImportError::Other(
                "Excel workbook contains no worksheets".to_string(),
            ));
        }

        let sheet_to_use = match sheet_index {
            Some(idx) if idx < sheet_names.len() => sheet_names[idx].clone(),
            _ => {
                // Smart sheet selection: pick the sheet with the most populated rows,
                // giving a priority bonus to sheets named like products/stock/clients.
                let mut best_sheet = sheet_names[0].clone();
                let mut max_score = 0usize;

                for s_name in &sheet_names {
                    let name_lower = s_name.to_lowercase();
                    let bonus = if name_lower.contains("produit")
                        || name_lower.contains("article")
                        || name_lower.contains("stock")
                        || name_lower.contains("client")
                        || name_lower.contains("inventaire")
                    {
                        50
                    } else {
                        0
                    };

                    if let Ok(range) = workbook.worksheet_range(s_name) {
                        let non_empty_rows = range
                            .rows()
                            .filter(|r| r.iter().any(|c| !matches!(c, calamine::Data::Empty)))
                            .count();
                        let score = non_empty_rows + bonus;
                        if score > max_score {
                            max_score = score;
                            best_sheet = s_name.clone();
                        }
                    }
                }
                best_sheet
            }
        };

        let range = workbook
            .worksheet_range(&sheet_to_use)
            .map_err(|error| ImportError::Other(format!("Could not read worksheet: {error}")))?;
        let zero_padding_formats = xlsx_zero_padding_formats(bytes, &sheet_to_use);
        let (row_offset, column_offset) = range.start().unwrap_or((0, 0));
        let mut raw_rows = Vec::new();
        for (row_index, row) in range.rows().enumerate() {
            let mut row_strings = Vec::new();
            for (column_index, cell) in row.iter().enumerate() {
                let mut s = match cell {
                    calamine::Data::Int(v) => v.to_string(),
                    calamine::Data::Float(v) => {
                        let val = *v;
                        if val.fract() == 0.0 && val >= 0.0 && val < 1e16 {
                            format!("{:.0}", val)
                        } else {
                            val.to_string()
                        }
                    }
                    calamine::Data::String(s) => s.clone(),
                    calamine::Data::Bool(b) => b.to_string(),
                    calamine::Data::DateTime(d) => d.to_string(),
                    calamine::Data::Empty => String::new(),
                    calamine::Data::Error(e) => format!("ERR: {:?}", e),
                    _ => cell.to_string(),
                };
                let cell_position = (
                    row_index + row_offset as usize,
                    column_index + column_offset as usize,
                );
                if let Some(width) = zero_padding_formats.get(&cell_position) {
                    if !s.starts_with('-')
                        && !s.contains('.')
                        && s.chars().all(|c| c.is_ascii_digit())
                    {
                        s = format!("{:0>width$}", s, width = *width);
                    }
                }
                row_strings.push(s);
            }
            raw_rows.push(row_strings);
        }

        return clean_raw_table(raw_rows, file_sha256, sheet_names, sheet_to_use, None);
    }

    // 3. Text-based format sniffing (HTML-as-XLS, SpreadsheetML, VCF, JSON, SQL, or delimited CSV/TSV)
    let (decoded_text, encoding_used) = decode_bytes_with_override(bytes, encoding_override)?;
    let detected_encoding = Some(encoding_used.to_string());
    let trimmed = decoded_text.trim();

    // 3a. XML Spreadsheet 2003 disguised as .xls or .xml
    if trimmed.starts_with("<?xml") && trimmed.contains("<Workbook") {
        let raw_rows = parse_spreadsheetml_xml(&decoded_text)?;
        return clean_raw_table(
            raw_rows,
            file_sha256,
            vec!["spreadsheetml".to_string()],
            "spreadsheetml".to_string(),
            detected_encoding,
        );
    }

    // 3b. HTML table disguised as .xls or .html
    let lower_trimmed = trimmed.to_lowercase();
    if lower_trimmed.starts_with("<html") || lower_trimmed.starts_with("<!doctype html") || lower_trimmed.contains("<table") {
        let raw_rows = parse_html_table(&decoded_text);
        if !raw_rows.is_empty() {
            return clean_raw_table(
                raw_rows,
                file_sha256,
                vec!["html_table".to_string()],
                "html_table".to_string(),
                detected_encoding,
            );
        }
    }

    // 3c. vCard phone contacts (.vcf)
    if trimmed.starts_with("BEGIN:VCARD") || trimmed.contains("BEGIN:VCARD") {
        let raw_rows = parse_vcf_text(&decoded_text);
        return clean_raw_table(
            raw_rows,
            file_sha256,
            vec!["vcf_contacts".to_string()],
            "vcf_contacts".to_string(),
            detected_encoding,
        );
    }

    // 3d. JSON or JSON Lines (.json, .jsonl)
    if (trimmed.starts_with('[') && trimmed.ends_with(']')) || (trimmed.starts_with('{') && trimmed.contains('"')) {
        if let Ok(raw_rows) = parse_json_text(&decoded_text) {
            return clean_raw_table(
                raw_rows,
                file_sha256,
                vec!["json".to_string()],
                "json".to_string(),
                detected_encoding,
            );
        }
    }

    // 3e. SQL dump with INSERT INTO statements
    if lower_name.ends_with(".sql") || trimmed.to_uppercase().contains("INSERT INTO") {
        let raw_rows = parse_sql_insert_text(&decoded_text)?;
        return clean_raw_table(
            raw_rows,
            file_sha256,
            vec!["sql_dump".to_string()],
            "sql_dump".to_string(),
            detected_encoding,
        );
    }

    // 3f. Standard delimited text (CSV, TSV, TXT, clipboard)
    let delimiter = if lower_name.ends_with(".tsv") {
        b'\t'
    } else {
        sniff_delimiter(&decoded_text)
    };

    let raw_rows = parse_delimited_text(&decoded_text, delimiter);
    clean_raw_table(
        raw_rows,
        file_sha256,
        vec!["default".to_string()],
        "default".to_string(),
        detected_encoding,
    )
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn test_decode_utf8_and_bom() {
        let with_bom = [0xEF, 0xBB, 0xBF, b'H', b'e', b'l', b'l', b'o'];
        let (s, enc) = decode_bytes(&with_bom).unwrap();
        assert_eq!(enc, "UTF-8");
        assert_eq!(s, "Hello");
    }

    #[test]
    fn test_decode_utf16_le_and_be() {
        // "Test" in UTF-16LE with BOM
        let utf16_le = [0xFF, 0xFE, b'T', 0, b'e', 0, b's', 0, b't', 0];
        let (s_le, enc_le) = decode_bytes(&utf16_le).unwrap();
        assert_eq!(enc_le, "UTF-16LE");
        assert_eq!(s_le, "Test");

        // "Test" in UTF-16BE with BOM
        let utf16_be = [0xFE, 0xFF, 0, b'T', 0, b'e', 0, b's', 0, b't'];
        let (s_be, enc_be) = decode_bytes(&utf16_be).unwrap();
        assert_eq!(enc_be, "UTF-16BE");
        assert_eq!(s_be, "Test");
    }

    #[test]
    fn text_inspection_reports_and_honors_windows_1256_override() {
        let source = "SKU;Product;Price\nAR-01;منتج عربي;1250";
        let (encoded, _, had_errors) = encoding_rs::WINDOWS_1256.encode(source);
        assert!(!had_errors);

        let automatic = parse_bytes(encoded.as_ref(), "arabic.csv", None).unwrap();
        assert_eq!(automatic.detected_encoding.as_deref(), Some("WINDOWS-1256"));
        assert!(automatic.rows[0].iter().any(|cell| cell == "منتج عربي"));

        let overridden = parse_bytes_with_encoding_override(
            encoded.as_ref(),
            "arabic.csv",
            None,
            Some("WINDOWS-1252"),
        )
        .unwrap();
        assert_eq!(overridden.detected_encoding.as_deref(), Some("WINDOWS-1252"));
        assert!(!overridden.rows[0].iter().any(|cell| cell == "منتج عربي"));
    }

    #[test]
    fn test_decode_windows_1256_arabic() {
        let ar_bytes = [0xE3, 0xE4, 0xCA, 0xCC];
        let (s, enc) = decode_bytes(&ar_bytes).unwrap();
        assert_eq!(enc, "WINDOWS-1256");
        assert_eq!(s, "منتج");
    }

    #[test]
    fn test_decode_windows_1252_french() {
        let fr_bytes = [b'D', 0xE9, b's', b'i', b'g', b'n', b'a', b't', b'i', b'o', b'n'];
        let (s, enc) = decode_bytes(&fr_bytes).unwrap();
        assert_eq!(enc, "WINDOWS-1252");
        assert_eq!(s, "Désignation");
    }

    #[test]
    fn test_csv_sniff_and_parse() {
        let csv_data = "Désignation;Prix;Quantité\nChargeur Type-C;1500;10\nCâble USB-C;500;25\nTotal;2000;35\n";
        let table = parse_bytes(csv_data.as_bytes(), "products.csv", None).unwrap();
        assert_eq!(table.headers, vec!["Désignation", "Prix", "Quantité"]);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[0], vec!["Chargeur Type-C", "1500", "10"]);
        assert_eq!(table.warnings.len(), 1);
        assert_eq!(table.warnings[0].code, "SummaryRowSkipped");
    }

    #[test]
    fn rejects_malformed_xlsx_archives_instead_of_reading_binary_as_text() {
        let error = parse_bytes(b"PK\x03\x04not-a-valid-workbook", "broken.xlsx", None)
            .expect_err("malformed XLSX must not fall through to delimited text parsing");
        assert!(error.to_string().contains("Could not read Excel workbook"));
    }

    #[test]
    fn test_html_table_as_xls_parse() {
        let html_content = r#"
        <html>
        <head><meta charset="utf-8"></head>
        <body>
        <table border="1">
            <tr><th>Code Barre</th><th>Designation</th><th>Prix Vente</th></tr>
            <tr><td>6132450019289</td><td>Chargeur 20W &amp; Cable</td><td>1800 DA</td></tr>
            <tr><td>6132450019296</td><td>Ecran 6.5&quot;</td><td>4500 DA</td></tr>
        </table>
        </body>
        </html>
        "#;
        let table = parse_bytes(html_content.as_bytes(), "gestcom_export.xls", None).unwrap();
        assert_eq!(table.headers, vec!["Code Barre", "Designation", "Prix Vente"]);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[0], vec!["6132450019289", "Chargeur 20W & Cable", "1800 DA"]);
        assert_eq!(table.rows[1], vec!["6132450019296", "Ecran 6.5\"", "4500 DA"]);
    }

    #[test]
    fn test_vcf_contacts_parse() {
        let vcf_data = concat!(
            "\nBEGIN:VCARD\n",
            "VERSION:3.0\n",
            "FN:Mohamed Benali\n",
            "TEL;TYPE=CELL:0550123456\n",
            "NOTE:Client VIP\n",
            "END:VCARD\n",
            "BEGIN:VCARD\n",
            "VERSION:3.0\n",
            "FN:Karim Ziani\n",
            "TEL;TYPE=WORK:0661223344\n",
            "END:VCARD\n"
        );
        let table = parse_bytes(vcf_data.as_bytes(), "contacts.vcf", None).unwrap();
        assert_eq!(
            table.headers,
            vec![
                "Nom Client",
                "Téléphone",
                "Téléphone secondaire",
                "Email",
                "Adresse",
                "Notes"
            ]
        );
        assert_eq!(table.rows.len(), 2);
        assert_eq!(
            table.rows[0],
            vec![
                "Mohamed Benali",
                "0550123456",
                "",
                "",
                "",
                "Client VIP"
            ]
        );
        assert_eq!(
            table.rows[1],
            vec!["Karim Ziani", "0661223344", "", "", "", ""]
        );
    }

    #[test]
    fn test_json_and_jsonl_parse() {
        let json_array = r#"[
            {"barcode": "6132450019289", "title": "Chargeur", "price": 1500},
            {"barcode": "6132450019296", "title": "Cable", "price": 500}
        ]"#;
        let table = parse_bytes(json_array.as_bytes(), "export.json", None).unwrap();
        assert_eq!(table.headers.len(), 3);
        assert_eq!(table.rows.len(), 2);

        let json_lines = "{\"title\": \"Coque\", \"price\": 400}\n{\"title\": \"Verre\", \"price\": 300}\n";
        let table_l = parse_bytes(json_lines.as_bytes(), "export.jsonl", None).unwrap();
        assert_eq!(table_l.rows.len(), 2);
    }

    #[test]
    fn test_sql_dump_parse() {
        let sql_dump = "INSERT INTO `products` (`barcode`, `title`, `price`) VALUES ('6132450019289', 'Chargeur', 1500);\nINSERT INTO `products` (`barcode`, `title`, `price`) VALUES ('6132450019296', 'Cable', 500);\n";
        let table = parse_bytes(sql_dump.as_bytes(), "backup.sql", None).unwrap();
        assert_eq!(table.headers, vec!["barcode", "title", "price"]);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[0], vec!["6132450019289", "Chargeur", "1500"]);
    }

    #[test]
    fn test_vcard_folded_quoted_printable_and_extended_fields() {
        let vcf = concat!(
            "BEGIN:VCARD\r\n",
            "VERSION:2.1\r\n",
            "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=C3=89cran=20Pro=\r\n",
            " t=C3=A9g=C3=A9\r\n",
            "TEL;CELL:+213 550 12 34 56\r\n",
            "TEL;HOME:0661987654\r\n",
            "EMAIL;TYPE=INTERNET:amine@example.test\r\n",
            "ADR;TYPE=HOME:;;12 Rue de l'Indépendance;Alger;;16000;Algérie\r\n",
            "NOTE:Client fidèle\r\n",
            "END:VCARD\r\n",
            "BEGIN:VCARD\r\n",
            "VERSION:3.0\r\n",
            "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D9=85=D8=AD=D9=85=D8=AF\r\n",
            "TEL;TYPE=CELL:0550123456\r\n",
            "END:VCARD\r\n"
        );
        let rows = parse_vcf_text(vcf);
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[1],
            vec![
                "Écran Protégé",
                "+213 550 12 34 56",
                "0661987654",
                "amine@example.test",
                "12 Rue de l'Indépendance, Alger, 16000, Algérie",
                "Client fidèle"
            ]
        );
        assert_eq!(rows[2][0], "محمد");
    }

    #[test]
    fn test_sql_parser_extracts_literals_without_running_other_sql() {
        let dump = r#"
            -- comments may mention INSERT INTO products, but are not data
            CREATE TABLE products (barcode TEXT, title TEXT, price REAL);
            INSERT INTO products (barcode, title, price)
            VALUES
              ('6132450019289', 'Chargeur, bleu (20W); DROP TABLE products;', 1450.50),
              ('6132450019296', 'L''écran (anti-choc)', 800.00);
            /* DDL and DML are ignored as commands */
            DROP TABLE products;
            DELETE FROM products;
            UPDATE products SET title = 'not executed';
        "#;
        let rows = parse_sql_insert_text(dump).unwrap();
        assert_eq!(rows[0], vec!["barcode", "title", "price"]);
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[1],
            vec![
                "6132450019289",
                "Chargeur, bleu (20W); DROP TABLE products;",
                "1450.50"
            ]
        );
        assert_eq!(rows[2][1], "L'écran (anti-choc)");
    }

    #[test]
    fn test_sql_parser_rejects_expressions_and_mixed_entities() {
        assert!(parse_sql_insert_text(
            "INSERT INTO products (barcode, title, price) VALUES ('1', 'X', random());"
        )
        .is_err());
        assert!(parse_sql_insert_text(
            "INSERT INTO products (barcode, title, price) VALUES ('1', 'X', 1); \
             INSERT INTO customers (name, phone) VALUES ('Y', '0550123456');"
        )
        .is_err());
        assert!(parse_bytes(
            b"CREATE TABLE products(id TEXT); DROP TABLE products;",
            "hostile.sql",
            None
        )
        .is_err());
    }

    #[test]
    fn test_tsv_clipboard_parse() {
        let tsv_data = "Mohamed Benali\t0550123456\nKarim Benali\t0661223344\n";
        let table = parse_bytes(tsv_data.as_bytes(), "clipboard.tsv", None).unwrap();
        assert_eq!(table.headers, vec!["Mohamed Benali", "0550123456"]);
        assert_eq!(table.rows.len(), 1);
        assert_eq!(table.rows[0], vec!["Karim Benali", "0661223344"]);
    }

    #[test]
    fn test_cross_oracle_python_differential() {
        let dir = std::env::temp_dir();
        let csv_path = dir.join("cross_check_sample.csv");
        let csv_content = "Code;Designation;Prix Achat;Prix Vente;Qte\n6132450019283;Chargeur 20W;1200;1800;15\n;Câble Type-C;300;600;50\n";
        std::fs::write(&csv_path, csv_content).unwrap();

        let rust_table = parse_bytes(csv_content.as_bytes(), "cross_check_sample.csv", None).unwrap();

        let script_path = if std::path::Path::new("scripts/anonymize_export.py").exists() {
            "scripts/anonymize_export.py"
        } else {
            "../scripts/anonymize_export.py"
        };

        let output = std::process::Command::new("python")
            .env("PYTHONIOENCODING", "utf-8")
            .arg(script_path)
            .arg("--cross-check")
            .arg(&csv_path)
            .output()
            .expect("Failed to execute python cross-check oracle");

        assert!(output.status.success(), "Python oracle failed: {:?}", String::from_utf8_lossy(&output.stderr));

        let py_json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let py_rows = py_json["rows"].as_array().unwrap();

        let py_headers: Vec<String> = py_rows[0].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(rust_table.headers, py_headers);

        for (i, row) in rust_table.rows.iter().enumerate() {
            let py_row: Vec<String> = py_rows[i + 1].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            assert_eq!(row, &py_row);
        }

        let _ = std::fs::remove_file(csv_path);
    }
}

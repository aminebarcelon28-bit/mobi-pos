//! 3-tier PO line resolver: barcode → vendor-alias cache → vector search.
//!
//! Adaptation notes (vs greenfield spec):
//! - `products.id` is TEXT (`mobi_pos.db` v1), so `ProductCandidate.id` is
//!   `String`, and product columns are `title`/`cost_price` (not
//!   `name`/`unit_cost`); active filter is `COALESCE(deleted,0)=0` (v2), not
//!   `is_active=1`.
//! - Vector index is `vec_products(product_row INTEGER PK, embedding
//!   float[384], product_tid TEXT)` (see `db.rs`); resolution is two-step
//!   (KNN on vec table → product lookup) to avoid JOIN typing pitfalls.
//! - Embeddings: with `--features po-embed`, true 384-dim BGE-Small-EN via
//!   `fastembed`; default build uses deterministic 384-dim hashed + L2-normed
//!   vectors (same schema + Tier thresholds, offline-safe, no ONNX runtime).
//!   Enable `po-embed` for semantic recall; default errs toward Tier3 manual
//!   review, which is the safe direction.

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductCandidate {
    pub id: String,
    pub sku: String,
    pub name: String,
    pub current_cost: f64,
    pub distance: f32, // Cosine distance (0.0 = exact match)
    #[serde(default)]
    pub match_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MatchTier {
    Tier1ExactAlias,
    Tier2HighConfidence, // d <= 0.22 (~85%+ semantic overlap)
    Tier2ReviewNeeded,   // 0.22 < d <= 0.38
    Tier3Unmatched,      // d > 0.38
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedPoLine {
    pub raw_description: String,
    pub quantity: f64,
    pub unit_cost: f64,
    pub line_total: f64,
    pub match_tier: MatchTier,
    pub matched_product: Option<ProductCandidate>,
    pub candidate_suggestions: Vec<ProductCandidate>,
}

pub struct InventoryResolver {
    #[cfg(feature = "po-embed")]
    model: fastembed::TextEmbedding,
}

impl Default for InventoryResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl InventoryResolver {
    pub fn new() -> Self {
        #[cfg(feature = "po-embed")]
        {
            let model = fastembed::TextEmbedding::try_new(
                fastembed::InitOptions::new(fastembed::EmbeddingModel::BGESmallENV15)
                    .with_show_download_progress(false),
            )
            .expect("Failed to initialize local ONNX embedding runtime");
            Self { model }
        }
        #[cfg(not(feature = "po-embed"))]
        {
            Self {}
        }
    }

    /// Embeds a single string into a 384-dimensional vector of f32.
    pub fn embed_string(&self, text: &str) -> Vec<f32> {
        #[cfg(feature = "po-embed")]
        {
            let clean = text.to_lowercase();
            let result = self.model.embed(vec![clean], None).unwrap();
            result[0].clone()
        }
        #[cfg(not(feature = "po-embed"))]
        {
            deterministic_embed_384(text)
        }
    }

    /// Indexes an internal product into sqlite-vec (upsert by product_tid).
    pub fn index_product(&self, conn: &Connection, product_id: &str, name: &str) -> Result<()> {
        let vector = self.embed_string(name);
        debug_assert_eq!(vector.len(), 384);
        let vector_bytes: &[u8] = bytemuck::cast_slice(&vector);

        conn.execute(
            "DELETE FROM vec_products WHERE product_tid = ?1",
            params![product_id],
        )?;
        conn.execute(
            "INSERT INTO vec_products(product_tid, embedding) VALUES (?1, ?2)",
            params![product_id, vector_bytes],
        )?;

        Ok(())
    }

    /// Resolves an invoice line item against the database.
    #[allow(clippy::too_many_arguments)]
    pub fn resolve_line(
        &self,
        conn: &Connection,
        supplier_name: &str,
        raw_desc: &str,
        barcode: Option<&str>,
        qty: f64,
        unit_cost: f64,
        line_total: f64,
    ) -> Result<ResolvedPoLine> {
        // TIER 0: Direct Barcode Match (if available and valid)
        if let Some(bc) = barcode {
            let mut bc_stmt = conn.prepare(
                "SELECT id, sku, title, cost_price FROM products WHERE barcode = ?1 AND COALESCE(deleted,0) = 0 LIMIT 1",
            )?;
            let mut bc_rows = bc_stmt.query_map(params![bc], |r| {
                Ok(ProductCandidate {
                    id: r.get(0)?,
                    sku: r.get(1)?,
                    name: r.get(2)?,
                    current_cost: r.get(3)?,
                    distance: 0.0,
                    match_reason: Some("Code-barres exact".into()),
                })
            })?;

            if let Some(Ok(cand)) = bc_rows.next() {
                return Ok(ResolvedPoLine {
                    raw_description: raw_desc.to_string(),
                    quantity: qty,
                    unit_cost,
                    line_total,
                    match_tier: MatchTier::Tier1ExactAlias,
                    matched_product: Some(cand.clone()),
                    candidate_suggestions: vec![cand],
                });
            }
        }

        // TIER 1: Exact Vendor Alias Cache (O(1))
        let mut alias_stmt = conn.prepare(
            r#"
            SELECT p.id, p.sku, p.title, p.cost_price
            FROM vendor_aliases va
            JOIN products p ON va.product_id = p.id
            WHERE va.supplier_name = ?1 AND va.raw_vendor_name = ?2 AND COALESCE(p.deleted,0) = 0
            LIMIT 1
            "#,
        )?;

        let mut alias_rows = alias_stmt.query_map(params![supplier_name, raw_desc], |r| {
            Ok(ProductCandidate {
                id: r.get(0)?,
                sku: r.get(1)?,
                name: r.get(2)?,
                current_cost: r.get(3)?,
                distance: 0.0,
                match_reason: Some("Alias fournisseur mémorisé".into()),
            })
        })?;

        if let Some(Ok(cand)) = alias_rows.next() {
            return Ok(ResolvedPoLine {
                raw_description: raw_desc.to_string(),
                quantity: qty,
                unit_cost,
                line_total,
                match_tier: MatchTier::Tier1ExactAlias,
                matched_product: Some(cand.clone()),
                candidate_suggestions: vec![cand],
            });
        }

        // TIER 2: Dense Vector Similarity Search via sqlite-vec (two-step:
        // KNN over vec table, then product lookup to avoid virtual-table JOINs).
        let vector = self.embed_string(raw_desc);
        let query_bytes: &[u8] = bytemuck::cast_slice(&vector);

        let mut vec_stmt = conn.prepare(
            r#"
            SELECT product_tid, distance
            FROM vec_products
            WHERE embedding MATCH ?1 AND k = 5
            ORDER BY distance
            "#,
        )?;

        let knn: Vec<(String, f32)> = vec_stmt
            .query_map(params![query_bytes], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, f32>(1)?))
            })?
            .filter_map(Result::ok)
            .collect();

        let mut candidates: Vec<ProductCandidate> = Vec::new();
        if !knn.is_empty() {
            let mut p_stmt = conn.prepare(
                "SELECT id, sku, title, cost_price FROM products WHERE id = ?1 AND COALESCE(deleted,0) = 0 LIMIT 1",
            )?;
            for (tid, dist) in knn {
                let mut rows = p_stmt.query_map(params![tid], |r| {
                    Ok(ProductCandidate {
                        id: r.get(0)?,
                        sku: r.get(1)?,
                        name: r.get(2)?,
                        current_cost: r.get(3)?,
                        distance: dist.clamp(0.0, 1.0),
                        match_reason: None,
                    })
                })?;
                if let Some(Ok(c)) = rows.next() {
                    candidates.push(c);
                }
            }
        }

        if !candidates.is_empty() {
            re_rank_candidates(raw_desc, unit_cost, &mut candidates);
        }

        let top_match = candidates.first().cloned();
        let top_dist = top_match.as_ref().map_or(1.0, |c| c.distance);

        let match_tier = if top_dist <= 0.22 {
            MatchTier::Tier2HighConfidence
        } else if top_dist <= 0.38 {
            MatchTier::Tier2ReviewNeeded
        } else {
            MatchTier::Tier3Unmatched
        };

        Ok(ResolvedPoLine {
            raw_description: raw_desc.to_string(),
            quantity: qty,
            unit_cost,
            line_total,
            match_tier,
            matched_product: if top_dist <= 0.38 { top_match } else { None },
            candidate_suggestions: candidates,
        })
    }
}

fn extract_brand(s: &str) -> Option<&'static str> {
    let lower = s.to_lowercase();
    if lower.contains("apple") || lower.contains("iphone") || lower.contains("ipad") || lower.contains("appl") {
        Some("Apple")
    } else if lower.contains("samsung") || lower.contains("galaxy") {
        Some("Samsung")
    } else if lower.contains("anker") {
        Some("Anker")
    } else if lower.contains("belkin") {
        Some("Belkin")
    } else if lower.contains("xiaomi") || lower.contains("redmi") {
        Some("Xiaomi")
    } else if lower.contains("huawei") {
        Some("Huawei")
    } else if lower.contains("baseus") {
        Some("Baseus")
    } else {
        None
    }
}

fn extract_model(s: &str) -> Option<&'static str> {
    let lower = s.to_lowercase();
    if lower.contains("15 pro max") || lower.contains("15promax") || lower.contains("15pm") {
        Some("iPhone 15 Pro Max")
    } else if lower.contains("15 pro") {
        Some("iPhone 15 Pro")
    } else if lower.contains("15 plus") {
        Some("iPhone 15 Plus")
    } else if lower.contains("iphone 15") {
        Some("iPhone 15")
    } else if lower.contains("14 pro max") || lower.contains("14pm") {
        Some("iPhone 14 Pro Max")
    } else if lower.contains("14 pro") {
        Some("iPhone 14 Pro")
    } else if lower.contains("s24 ultra") || lower.contains("s24u") {
        Some("Galaxy S24 Ultra")
    } else if lower.contains("s24 plus") || lower.contains("s24+") {
        Some("Galaxy S24+")
    } else if lower.contains("s24") {
        Some("Galaxy S24")
    } else if lower.contains("s23 ultra") {
        Some("Galaxy S23 Ultra")
    } else {
        None
    }
}

fn extract_wattage(s: &str) -> Option<u32> {
    let lower = s.to_lowercase();
    for word in lower.split(|c: char| !c.is_alphanumeric()) {
        if word.ends_with('w') && word.len() > 1 {
            if let Ok(w) = word[..word.len() - 1].parse::<u32>() {
                if (5..=300).contains(&w) {
                    return Some(w);
                }
            }
        }
    }
    None
}

fn re_rank_candidates(
    raw_desc: &str,
    unit_cost: f64,
    candidates: &mut [ProductCandidate],
) {
    let scanned_brand = extract_brand(raw_desc);
    let scanned_model = extract_model(raw_desc);
    let scanned_watt = extract_wattage(raw_desc);

    for cand in candidates.iter_mut() {
        let cand_brand = extract_brand(&cand.name);
        let cand_model = extract_model(&cand.name);
        let cand_watt = extract_wattage(&cand.name);

        let mut adjusted_dist = cand.distance;
        let mut reasons = Vec::new();

        // 1. Brand Match vs Conflict
        if let (Some(sb), Some(cb)) = (scanned_brand, cand_brand) {
            if sb == cb {
                adjusted_dist -= 0.10;
                reasons.push(format!("Marque '{sb}' confirmée"));
            } else {
                adjusted_dist += 0.40;
                reasons.push(format!("Conflit marque ({sb} vs {cb})"));
            }
        }

        // 2. Model Generation Conflict
        if let (Some(sm), Some(cm)) = (scanned_model, cand_model) {
            if sm == cm {
                adjusted_dist -= 0.10;
                reasons.push(format!("Modèle '{sm}' confirmé"));
            } else {
                adjusted_dist += 0.35;
                reasons.push(format!("Conflit modèle ({sm} vs {cm})"));
            }
        }

        // 3. Wattage Match vs Conflict
        if let (Some(sw), Some(cw)) = (scanned_watt, cand_watt) {
            if sw == cw {
                adjusted_dist -= 0.15;
                reasons.push(format!("Puissance {sw}W confirmée"));
            } else {
                adjusted_dist += 0.30;
                reasons.push(format!("Conflit puissance ({sw}W vs {cw}W)"));
            }
        }

        // 4. Price Sanity Corroboration
        if unit_cost > 0.0 && cand.current_cost > 0.0 {
            let ratio = unit_cost / cand.current_cost;
            if (0.80..=1.25).contains(&ratio) {
                adjusted_dist -= 0.08;
                reasons.push("Prix cohérent avec le coût catalogue".to_string());
            } else if !(0.33..=3.0).contains(&ratio) {
                adjusted_dist += 0.25;
                reasons.push("Écart de prix anormal".to_string());
            }
        }

        cand.distance = adjusted_dist.clamp(0.0, 1.0);
        if !reasons.is_empty() {
            cand.match_reason = Some(reasons.join(", "));
        }
    }

    candidates.sort_by(|a, b| a.distance.total_cmp(&b.distance));
}

/// Deterministic 384-dim fallback embedding (no ONNX): token-hash averaging
/// with L2 normalization. Exact-duplicate strings map to distance 0.0;
/// unrelated strings spread toward 1.0. Safe direction: unknown paraphrases
/// land in Tier3 (manual review) until `po-embed` is enabled.
fn deterministic_embed_384(text: &str) -> Vec<f32> {
    const DIM: usize = 384;
    let mut acc = vec![0f32; DIM];
    let lower = text.to_lowercase();
    let tokens: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    // Include the full normalized string as a pseudo-token so exact matches
    // dominate even when token overlap is partial.
    let mut feats: Vec<&str> = Vec::with_capacity(tokens.len() + 1);
    feats.extend(tokens.iter().copied());
    feats.push(lower.as_str());

    if feats.is_empty() {
        acc[0] = 1.0;
        return acc;
    }
    for tok in feats {
        let h1 = fnv1a64(tok, 0xcbf29ce484222325);
        let h2 = fnv1a64(tok, 0x84222325cbf29ce4);
        // Each token votes on 8 pseudo-random dims (signed) — cheap
        // SimHash-style projection, deterministic across runs/platforms.
        for i in 0..8 {
            let dim = ((h1.wrapping_add((i as u64).wrapping_mul(h2 | 1))) % DIM as u64) as usize;
            let sign = if (h1 >> (i * 7)) & 1 == 1 { 1.0 } else { -1.0 };
            acc[dim] += sign;
        }
    }
    let norm = acc.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 1e-9 {
        for v in acc.iter_mut() {
            *v /= norm;
        }
    }
    acc
}

fn fnv1a64(s: &str, offset: u64) -> u64 {
    let mut h = offset;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{ensure_po_recon_tables, register_vec_extension};

    fn open_test_db() -> Connection {
        register_vec_extension();
        let conn = Connection::open_in_memory().expect("in-memory open");
        conn.execute_batch(
            r#"
            CREATE TABLE products (
                id TEXT PRIMARY KEY, sku TEXT NOT NULL, barcode TEXT NOT NULL,
                title TEXT NOT NULL, cost_price REAL DEFAULT 0, deleted INTEGER DEFAULT 0
            );
            "#,
        )
        .unwrap();
        ensure_po_recon_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn test_barcode_tier0_and_alias_tier1() {
        let conn = open_test_db();
        conn.execute(
            "INSERT INTO products(id, sku, barcode, title, cost_price) VALUES ('p1','SKU1','012000000133','Red Widget',10.0)",
            [],
        )
        .unwrap();
        let r = InventoryResolver::new();
        // Barcode hit
        let hit = r
            .resolve_line(&conn, "ACME", "whatever", Some("012000000133"), 2.0, 10.0, 20.0)
            .unwrap();
        assert_eq!(hit.match_tier, MatchTier::Tier1ExactAlias);
        assert_eq!(hit.matched_product.unwrap().id, "p1");
        // Alias hit
        conn.execute(
            "INSERT INTO vendor_aliases(supplier_name, raw_vendor_name, product_id) VALUES ('ACME','rud widget','p1')",
            [],
        )
        .unwrap();
        let alias = r
            .resolve_line(&conn, "ACME", "rud widget", None, 1.0, 10.0, 10.0)
            .unwrap();
        assert_eq!(alias.match_tier, MatchTier::Tier1ExactAlias);
    }

    #[test]
    fn test_vector_tier2_and_unmatched() {
        let conn = open_test_db();
        conn.execute(
            "INSERT INTO products(id, sku, barcode, title, cost_price) VALUES ('p1','SKU1','BC1','Red Widget Pro',10.0)",
            [],
        )
        .unwrap();
        let r = InventoryResolver::new();
        r.index_product(&conn, "p1", "Red Widget Pro").unwrap();
        // Exact-name query → distance 0 → high confidence
        let m = r
            .resolve_line(&conn, "ACME", "Red Widget Pro", None, 1.0, 10.0, 10.0)
            .unwrap();
        assert!(
            m.match_tier == MatchTier::Tier2HighConfidence
                || m.match_tier == MatchTier::Tier2ReviewNeeded,
            "exact name should match, got {:?}",
            m.match_tier
        );
        // Gibberish → unmatched
        let u = r
            .resolve_line(&conn, "ACME", "zzz qqq xxx jjj kkk www", None, 1.0, 1.0, 1.0)
            .unwrap();
        assert_eq!(u.match_tier, MatchTier::Tier3Unmatched);
        assert!(u.matched_product.is_none());
    }
}

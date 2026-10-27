//! Confidence Scoring & Thresholding for Smart Import

use serde::{Deserialize, Serialize};

pub const AUTO_MAP_THRESHOLD: f64 = 0.85;
pub const NEEDS_CONFIRMATION_THRESHOLD: f64 = 0.50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfidenceCategory {
    /// Score >= 0.85: Confident match, auto-mapped without blocking
    AutoMap,
    /// 0.50 <= Score < 0.85: Probable match, requires user review/confirmation
    NeedsConfirmation,
    /// Score < 0.50: Low confidence or unmapped
    Unmapped,
}

impl ConfidenceCategory {
    pub fn from_score(score: f64) -> Self {
        if score >= AUTO_MAP_THRESHOLD {
            ConfidenceCategory::AutoMap
        } else if score >= NEEDS_CONFIRMATION_THRESHOLD {
            ConfidenceCategory::NeedsConfirmation
        } else {
            ConfidenceCategory::Unmapped
        }
    }

    pub fn is_auto_mapped(&self) -> bool {
        matches!(self, ConfidenceCategory::AutoMap)
    }

    pub fn needs_confirmation(&self) -> bool {
        matches!(self, ConfidenceCategory::NeedsConfirmation)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMatchScore {
    pub column_index: usize,
    #[serde(alias = "source_header")]
    pub original_header: String,
    #[serde(alias = "matched_type")]
    pub mapped_column: String,
    pub confidence: f64,
    #[serde(alias = "tier")]
    pub category: ConfidenceCategory,
    pub reasons: Vec<String>,
    #[serde(default)]
    pub sample_values: Vec<String>,
}

impl ColumnMatchScore {
    pub fn new(
        column_index: usize,
        original_header: String,
        mapped_column: String,
        confidence: f64,
        reasons: Vec<String>,
    ) -> Self {
        let category = ConfidenceCategory::from_score(confidence);
        Self {
            column_index,
            original_header,
            mapped_column,
            confidence,
            category,
            reasons,
            sample_values: Vec::new(),
        }
    }

    pub fn with_samples(mut self, samples: Vec<String>) -> Self {
        self.sample_values = samples;
        self
    }
}


export type MatchTier = 'exact_key' | 'high_confidence' | 'medium_confidence' | 'low_confidence';

export interface RawScanInput {
  raw_text?: string;
  lines?: string[];
  supplier_name?: string;
}

export interface ExtractedScanData {
  clean_title: string;
  brand?: string;
  model?: string;
  spec?: string;
  sku?: string;
  barcode?: string;
  category?: string;
  pack_size?: number;
  extracted_tokens: string[];
}

export interface MatchScoreBreakdown {
  exact_key_hit: boolean;
  name_fuzzy_score: number;
  token_set_ratio: number;
  brand_match_score: number;
  spec_match_score: number;
  category_match_score: number;
  price_sanity_score?: number;
  brand_conflict_penalty: number;
  model_conflict_penalty: number;
  spec_conflict_penalty: number;
  final_composite_score: number;
}

export interface MatchCandidate {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  category?: string;
  current_cost: number;
  selling_price?: number;
  similarity_score: number; // 0.0 to 1.0 (or percentage 0 to 100)
  tier: MatchTier;
  reasoning: string;
  breakdown: MatchScoreBreakdown;
  price_delta?: {
    diff: number;
    percent: number;
    trend: 'increased' | 'decreased' | 'unchanged' | 'new';
  };
}

export interface MatchOptions {
  topN?: number;
  thresholdHigh?: number;
  thresholdMedium?: number;
  includeBreakdown?: boolean;
  scannedUnitCost?: number;
}

export interface MatchResultPayload {
  input_raw: string;
  extracted: ExtractedScanData;
  best_match: MatchCandidate | null;
  candidates: MatchCandidate[];
  processing_time_ms: number;
}


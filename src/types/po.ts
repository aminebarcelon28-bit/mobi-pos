/**
 * PO-recon data contracts — mirrors `src-tauri/src/{geometry,resolver,gate,commands}.rs`.
 *
 * Adaptation note: `ProductCandidate.id` is `string` (repo `products.id` is a
 * TEXT UUID, migrations v1), not `number` as in the greenfield spec. `MatchTier`
 * literals stay lowercase to match the Rust `#[serde(rename_all = "lowercase")]`
 * serialization (`tier1exactalias`, ...).
 */

export interface OcrBoundingBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export interface ProductCandidate {
  id: string;
  sku: string;
  name: string;
  current_cost: number;
  distance: number;
}

export type MatchTier = 'tier1exactalias' | 'tier2highconfidence' | 'tier2reviewneeded' | 'tier3unmatched';

export interface ResolvedPoLine {
  raw_description: string;
  quantity: number;
  unit_cost: number;
  line_total: number;
  match_tier: MatchTier;
  matched_product: ProductCandidate | null;
  candidate_suggestions: ProductCandidate[];
}

export interface InvariantReport {
  is_balanced: boolean;
  calculated_subtotal: number;
  calculated_grand_total: number;
  reported_grand_total: number;
  delta: number;
  faulty_row_indices: number[];
  validation_errors?: string[];
}

export interface ExtractedDocumentSummary {
  detected_supplier?: string | null;
  detected_invoice_number?: string | null;
  detected_date?: string | null;
  detected_subtotal?: number | null;
  detected_freight?: number | null;
  detected_grand_total?: number | null;
}

export interface ProcessRawScanResponse {
  invariant_report: InvariantReport;
  resolved_lines: ResolvedPoLine[];
  document_summary?: ExtractedDocumentSummary;
  bounding_boxes?: OcrBoundingBox[];
}

export interface ProcessRawScanRequest {
  supplier_name: string;
  bounding_boxes: OcrBoundingBox[];
  // Phase 1b-i (Addendum B): no reported-tax field — the software models no tax.
  reported_freight: number;
  reported_grand_total: number;
}

export interface CommitStockBatchItem {
  product_id: string;
  quantity: number;
  unit_cost: number;
  raw_supplier_name: string;
  save_as_alias: boolean;
  /** UPGRADE-07 — landed freight per unit (integer-DZD share ÷ qty). */
  freight_per_unit?: number;
}

export interface CommitStockBatchRequest {
  supplier_name: string;
  items: CommitStockBatchItem[];
  user_id?: string;
  /** UPGRADE-07 — total freight (integer DZD; physical shipping only). */
  freight_amount?: number;
  freight_method?: string;
  supplier_invoice_no?: string;
}

export interface EditableReviewLine {
  client_id: string;
  raw_description: string;
  quantity: number;
  unit_cost: number;
  line_total: number;
  selected_product_id: string | null;
  match_tier: MatchTier;
  save_alias: boolean;
  candidates: ProductCandidate[];
  match_reasoning?: string;
  match_confidence?: number;
  selling_price?: number;
}

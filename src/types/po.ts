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
}

export interface ExtractedDocumentSummary {
  detected_supplier?: string | null;
  detected_invoice_number?: string | null;
  detected_date?: string | null;
  detected_subtotal?: number | null;
  detected_tax?: number | null;
  detected_freight?: number | null;
  detected_grand_total?: number | null;
}

export interface ProcessRawScanResponse {
  invariant_report: InvariantReport;
  resolved_lines: ResolvedPoLine[];
  document_summary?: ExtractedDocumentSummary;
}

export interface ProcessRawScanRequest {
  supplier_name: string;
  bounding_boxes: OcrBoundingBox[];
  reported_tax: number;
  reported_freight: number;
  reported_grand_total: number;
}

export interface CommitStockBatchItem {
  product_id: string;
  quantity: number;
  unit_cost: number;
  raw_supplier_name: string;
  save_as_alias: boolean;
}

export interface CommitStockBatchRequest {
  supplier_name: string;
  items: CommitStockBatchItem[];
  user_id?: string;
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
}

/**
//! Typed IPC client for Smart Import & Migration subsystem
*/
import { invokeCommand } from '../platform/invoke';

export interface ColumnMatchScore {
  column_index: number;
  original_header?: string;
  mapped_column?: string;
  confidence: number;
  category?: 'auto_map' | 'needs_confirmation' | 'unmapped';
  reasons?: string[];
  sample_values?: string[];

  // Compatibility aliases
  source_header?: string;
  matched_type?: string;
  tier?: 'Automated' | 'NeedsConfirmation' | 'Unmapped';
}

export interface ImportWarning {
  code: string;
  message: string;
}

export interface InspectResult {
  file_sha256: string;
  file_name: string;
  detected_encoding: string | null;
  sheets: string[];
  active_sheet: string;
  detected_entity: string;
  headers: string[];
  column_mappings: ColumnMatchScore[];
  warnings: ImportWarning[];
  preview_rows: string[][];
  total_rows: number;
}

export interface ImportBatch {
  batch_id: string;
  file_name: string;
  file_sha256: string;
  entity_type: string;
  mapping_config_json: string;
  row_count: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  rejected_count: number;
  status: string;
  created_at: string;
  committed_at?: string | null;
  rolled_back_at?: string | null;
}

export interface StagingRow {
  batch_id: string;
  row_index: number;
  raw_row_json: string;
  normalized_json?: string | null;
  action: 'create' | 'update' | 'skip' | 'reject';
  matched_entity_id?: string | null;
  rejection_reason?: string | null;
  warnings_json: string;
  needs_review: boolean;
  idempotency_key: string;
}

export interface ImportStageResponse {
  batch: ImportBatch;
  staged_rows: StagingRow[];
}

export interface CommitResult {
  batch_id: string;
  parsed_count: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  rejected_count: number;
}

export interface ImportBatchDetailsResponse {
  batch: ImportBatch;
  rows: StagingRow[];
}

export interface InspectRequestPayload {
  file_base64?: string;
  file_path?: string;
  file_name: string;
  sheet_index?: number;
  encoding_override?: string;
}

export interface StageRequestPayload {
  file_base64?: string;
  file_path?: string;
  file_name: string;
  sheet_index?: number;
  encoding_override?: string;
  entity_type_override?: string;
  column_overrides?: Record<number, string>;
}

export async function inspectImportFile(request: InspectRequestPayload): Promise<InspectResult> {
  return invokeCommand<InspectResult>('import_inspect_file', { request });
}

export async function stageImportFile(request: StageRequestPayload): Promise<ImportStageResponse> {
  return invokeCommand<ImportStageResponse>('import_stage_file', { request });
}

export async function commitImportBatch(batch_id: string): Promise<CommitResult> {
  return invokeCommand<CommitResult>('import_commit_batch', { request: { batch_id } });
}

export async function getImportBatch(batch_id: string): Promise<ImportBatchDetailsResponse> {
  return invokeCommand<ImportBatchDetailsResponse>('import_get_staged_batch', { request: { batch_id } });
}

export async function listImportBatches(): Promise<ImportBatch[]> {
  return invokeCommand<ImportBatch[]>('import_list_batches');
}

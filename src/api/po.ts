import { invokeCommand } from '../platform/invoke';
import type {
  ProcessRawScanRequest,
  ProcessRawScanResponse,
  CommitStockBatchRequest,
} from '../types/po';

/**
 * Invokes the Rust PO-recon engine to reconstruct OCR geometry,
 * verify mathematical invoice invariants, and match products via Tier 0..2.
 */
export async function processRawScan(
  request: ProcessRawScanRequest
): Promise<ProcessRawScanResponse> {
  return await invokeCommand<ProcessRawScanResponse>(
    'po_process_raw_scan',
    { request },
    'INTERNAL_ERROR'
  );
}

/**
 * Commits a validated stock batch transactionally into SQLite:
 * Creates stock_batches (FIFO), inventory_ledger (RECEIVE), updates stock,
 * and saves new vendor aliases.
 */
export async function commitStockBatch(
  payload: CommitStockBatchRequest
): Promise<number> {
  return await invokeCommand<number>(
    'po_commit_stock_batch',
    { payload },
    'INTERNAL_ERROR'
  );
}

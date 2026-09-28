/**
 * FIFO COGS preview — dependency-free core (importable from node tests).
 *
 * Problem: every pre-checkout profit number (cart "Marge" badges, frozen
 * checkout costs, receipt drafts) used `product.costPrice` — the LATEST
 * purchase cost — for ALL units. With Unit 1 @500 and Unit 2 @400 sold
 * @3500 each, the preview computed (3500−400)×2 = 6200 instead of the true
 * FIFO profit (3500−500)+(3500−400) = 6100.
 *
 * The durable write (`writeCheckoutAtomic`) already depletes batches
 * oldest-first and corrects the stored row afterwards, but everything the
 * merchant sees BEFORE that correction — and every consumer that reads the
 * frozen (pre-correction) costs — must use the same FIFO basis, otherwise
 * the till displays 6200 for a 6100 sale.
 *
 * These helpers simulate the checkout depletion WITHOUT writing: oldest
 * batch first ordered by `(received_at ASC, batch_id ASC)` — the same
 * contract every batch SELECT in the adapter uses — overflow into the next
 * batch, uncovered remainder costed at the last-known (newest) purchase
 * cost — exactly mirroring the SHADOW fallback in `writeCheckoutAtomicInner`. Exchange return lines keep the
 * caller (latest) cost, mirroring the checkout restock leg which treats the
 * caller cost as authoritative.
 *
 * Preview == durable whenever no concurrent batch mutation lands between
 * preview and checkout (same assumption the cart stock check already makes);
 * the checkout depletion remains the single authority.
 */

export interface FifoPreviewBatch {
  batchId: string;
  /** On-hand units in this batch (negative/clamped to >= 0). */
  quantityRemaining: number;
  unitCost: number;
}

export interface FifoPreviewLine {
  productId: string;
  qty: number;
  isReturn?: boolean;
  /** Latest-catalog cost: caller snapshot for returns, shadow basis, and the
   * no-batch fallback — same role as `fallbackCost` at checkout. */
  fallbackCost: number;
}

export interface FifoPreviewResult {
  /** Blended integer-DA unit cost the checkout will store for this line. */
  unitCost: number;
  /** False when batches did not cover the full qty (remainder at last-known
   * cost, i.e. the sale will mint a SHADOW batch for the shortfall). */
  fullyCovered: boolean;
  coveredQty: number;
  shortQty: number;
}

function toFinite(n: unknown, fallback = 0): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function toIntMoney(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Simulate oldest-first depletion of `needQty` from `batches` (already
 * ordered oldest-first by the caller). Pure read-only replica of the
 * checkout loop: whole-batch takes first, overflow into the next batch.
 */
export function simulateFifoAllocation(
  batches: FifoPreviewBatch[],
  needQty: number,
): { allocations: Array<{ batchId: string; quantity: number; unitCost: number }>; totalCost: number; coveredQty: number; shortQty: number } {
  let need = Math.max(0, Math.floor(toFinite(needQty, 0)));
  let totalCost = 0;
  let coveredQty = 0;
  const allocations: Array<{ batchId: string; quantity: number; unitCost: number }> = [];
  for (const b of batches ?? []) {
    if (need <= 0) break;
    const avail = Math.max(0, Math.floor(toFinite(b.quantityRemaining, 0)));
    const take = Math.min(avail, need);
    if (take <= 0) continue;
    const unitCost = Math.max(0, toFinite(b.unitCost, 0));
    need -= take;
    coveredQty += take;
    totalCost += take * unitCost;
    allocations.push({ batchId: String(b.batchId), quantity: take, unitCost });
  }
  return { allocations, totalCost, coveredQty, shortQty: need };
}

/**
 * Per-line FIFO unit-cost preview for a cart in display/checkout order.
 * Lines sharing a product allocate SEQUENTIALLY from that product's batches
 * (line 1 takes the oldest units, line 2 the next, …) — mirroring the
 * single-transaction depletion loop, so multi-line previews never
 * double-count the same batch units.
 *
 * `batchesByProduct`: active (non-shadow, non-deleted) batches per product,
 * ordered oldest-first per `(received_at ASC, batch_id ASC)` — the same
 * WHERE/ORDER BY the checkout uses.
 */
export function previewFifoCostsForLines(
  batchesByProduct: Map<string, FifoPreviewBatch[]> | Record<string, FifoPreviewBatch[]>,
  lines: FifoPreviewLine[],
): FifoPreviewResult[] {
  const getBatches = (pid: string): FifoPreviewBatch[] => {
    if (batchesByProduct instanceof Map) return [...(batchesByProduct.get(pid) ?? [])];
    return [...((batchesByProduct as Record<string, FifoPreviewBatch[]>)[pid] ?? [])];
  };
  // Mutable per-product cursors so sequential lines consume in order.
  const cursors = new Map<string, { batches: FifoPreviewBatch[]; idx: number; leftInBatch: number; rawNewest: number | null }>();
  const cursorOf = (pid: string): { batches: FifoPreviewBatch[]; idx: number; leftInBatch: number; rawNewest: number | null } => {
    let c = cursors.get(pid);
    if (!c) {
      const raw = getBatches(pid);
      const batches = raw.map((b) => ({
        batchId: String(b.batchId),
        quantityRemaining: Math.max(0, Math.floor(toFinite(b.quantityRemaining, 0))),
        unitCost: Math.max(0, toFinite(b.unitCost, 0)),
      }));
      c = {
        batches,
        idx: 0,
        leftInBatch: batches.length > 0 ? batches[0].quantityRemaining : 0,
        // RAW newest cost for the shortfall basis (kept unsanitized so the
        // finite check below mirrors lastKnownPurchaseCost exactly: a corrupt
        // newest batch falls back to the caller cost, not to a sanitized 0).
        rawNewest: raw.length > 0 ? Number(raw[raw.length - 1]?.unitCost) : null,
      };
      cursors.set(pid, c);
    }
    return c;
  };

  return (lines ?? []).map((line) => {
    const fallback = Math.max(0, toFinite(line?.fallbackCost, 0));
    const qty = Math.max(0, Math.floor(toFinite(line?.qty, 0)));
    // Exchange return lines restock at the caller cost (checkout leg treats
    // the caller snapshot as authoritative) — never simulate depletion.
    if (line?.isReturn || qty <= 0) {
      return { unitCost: toIntMoney(fallback), fullyCovered: true, coveredQty: qty, shortQty: 0 };
    }
    const pid = String(line?.productId ?? '');
    const cursor = cursorOf(pid);
    let need = qty;
    let coveredCost = 0;
    let coveredQty = 0;
    while (need > 0 && cursor.idx < cursor.batches.length) {
      if (cursor.leftInBatch <= 0) {
        cursor.idx += 1;
        cursor.leftInBatch = cursor.idx < cursor.batches.length ? cursor.batches[cursor.idx].quantityRemaining : 0;
        continue;
      }
      const take = Math.min(cursor.leftInBatch, need);
      coveredCost += take * cursor.batches[cursor.idx].unitCost;
      coveredQty += take;
      need -= take;
      cursor.leftInBatch -= take;
    }
    const shortQty = need;
    // Last-known purchase cost basis for the uncovered remainder: newest
    // batch wins, caller fallback when no batches exist OR the newest value
    // is corrupt — identical to `lastKnownPurchaseCost(db, prodId,
    // fallbackCost)` at checkout (finite + >= 0, else fallback).
    const rawNewest = cursor.rawNewest;
    const lastKnown =
      rawNewest !== null && Number.isFinite(rawNewest) && rawNewest >= 0 ? rawNewest : fallback;
    const unitCost = toIntMoney((coveredCost + shortQty * lastKnown) / qty);
    return { unitCost, fullyCovered: shortQty === 0, coveredQty, shortQty };
  });
}

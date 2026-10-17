/**
 * UPGRADE-06 — supplier RMA loop + warranty claims + defective-return reader.
 *
 * Storage: plain SQLite tables `part_rmas`, `part_rma_lines`,
 * `warranty_claims` (migration v121) plus the pre-existing `defective_returns`
 * quarantine table (v116, previously write-only — this adapter is its first
 * reader). Merchant-local operational records: NOT trust tables and NOT
 * synced entities (no outbox lane — same posture as `defective_returns`).
 *
 * Money: all amounts are integer DZD with a single Math.round boundary at the
 * write site (B-033 doctrine). Basis amounts frozen on claims come from the
 * ticket's own cost basis, never re-derived here.
 *
 * Outside Tauri every read degrades to empty/null and every write fails
 * loudly (returns null/false; the WebView preview has no RMA tables).
 */
import { isTauriEnv } from './base';
import { newId } from '../../utils/ids';

export type PartRmaStatus = 'draft' | 'sent' | 'credited' | 'rejected' | 'closed';
export type WarrantyClaimStatus = 'open' | 'closed';

export interface DefectiveReturnRecord {
  id: string;
  productId: string;
  productName: string | null;
  imei: string | null;
  quantity: number;
  unitCost: number;
  reason: string | null;
  saleId: string | null;
  refundId: string | null;
  createdAt: string;
  /** Linked RMA (via part_rma_lines) — null while still in quarantine. */
  rmaId: string | null;
}

export interface RmaLineInput {
  defectiveReturnId?: string;
  productId: string;
  productName?: string;
  imei?: string;
  quantity: number;
  unitCost: number;
  reason?: string;
}

export interface RmaLineRecord {
  id: string;
  rmaId: string;
  defectiveReturnId: string | null;
  productId: string;
  productName: string | null;
  imei: string | null;
  quantity: number;
  unitCost: number;
  reason: string | null;
  createdAt: string;
}

export interface RmaRecord {
  id: string;
  supplierName: string;
  status: PartRmaStatus;
  vendorDisputeId: string | null;
  creditAmount: number;
  apReference: string | null;
  notes: string | null;
  openedAt: string;
  sentAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Aggregates over part_rma_lines (display only). */
  lineCount: number;
  linesTotalCost: number;
}

export interface PartRmaInput {
  supplierName: string;
  vendorDisputeId?: string | null;
  notes?: string;
  lines: RmaLineInput[];
}

export interface WarrantyClaimRecord {
  id: string;
  originalRepairId: string;
  reworkRepairId: string | null;
  status: WarrantyClaimStatus;
  laborBasis: number;
  partsBasis: number;
  rmaId: string | null;
  notes: string | null;
  openedAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

async function pluginDb() {
  const { getLocalDb, utcNowIso } = await import('../sqlPluginAdapter');
  const db = await getLocalDb();
  return { db, utcNowIso };
}

interface RawDefectiveRow {
  id: string;
  product_id: string;
  product_name: string | null;
  imei: string | null;
  quantity: number | string | null;
  unit_cost: number | string | null;
  reason: string | null;
  sale_id: string | null;
  refund_id: string | null;
  created_at: string;
  rma_id: string | null;
}

interface RawRmaRow {
  id: string;
  supplier_name: string;
  status: string | null;
  vendor_dispute_id: string | null;
  credit_amount: number | string | null;
  ap_reference: string | null;
  notes: string | null;
  opened_at: string;
  sent_at: string | null;
  closed_at: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface RawRmaAggRow {
  rma_id: string;
  n: number | string | null;
  total: number | string | null;
}

interface RawRmaLineRow {
  id: string;
  rma_id: string;
  defective_return_id: string | null;
  product_id: string;
  product_name: string | null;
  imei: string | null;
  quantity: number | string | null;
  unit_cost: number | string | null;
  reason: string | null;
  created_at: string;
}

interface RawClaimRow {
  id: string;
  original_repair_id: string;
  rework_repair_id: string | null;
  status: string | null;
  labor_basis: number | string | null;
  parts_basis: number | string | null;
  rma_id: string | null;
  notes: string | null;
  opened_at: string;
  closed_at: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

function toIntMoney(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function mapDefective(row: RawDefectiveRow): DefectiveReturnRecord {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    productName: row.product_name ? String(row.product_name) : null,
    imei: row.imei ? String(row.imei) : null,
    quantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
    unitCost: toIntMoney(row.unit_cost),
    reason: row.reason ? String(row.reason) : null,
    saleId: row.sale_id ? String(row.sale_id) : null,
    refundId: row.refund_id ? String(row.refund_id) : null,
    createdAt: String(row.created_at ?? ''),
    rmaId: row.rma_id ? String(row.rma_id) : null,
  };
}

function mapRma(row: RawRmaRow, agg?: RawRmaAggRow): RmaRecord {
  const status = (['draft', 'sent', 'credited', 'rejected', 'closed'] as const).includes(
    row.status as PartRmaStatus
  )
    ? (row.status as PartRmaStatus)
    : 'draft';
  return {
    id: String(row.id),
    supplierName: String(row.supplier_name ?? ''),
    status,
    vendorDisputeId: row.vendor_dispute_id ? String(row.vendor_dispute_id) : null,
    creditAmount: toIntMoney(row.credit_amount),
    apReference: row.ap_reference ? String(row.ap_reference) : null,
    notes: row.notes ? String(row.notes) : null,
    openedAt: String(row.opened_at ?? ''),
    sentAt: row.sent_at ? String(row.sent_at) : null,
    closedAt: row.closed_at ? String(row.closed_at) : null,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    lineCount: Number(agg?.n) || 0,
    linesTotalCost: toIntMoney(agg?.total),
  };
}

function mapClaim(row: RawClaimRow): WarrantyClaimRecord {
  return {
    id: String(row.id),
    originalRepairId: String(row.original_repair_id),
    reworkRepairId: row.rework_repair_id ? String(row.rework_repair_id) : null,
    status: row.status === 'closed' ? 'closed' : 'open',
    laborBasis: toIntMoney(row.labor_basis),
    partsBasis: toIntMoney(row.parts_basis),
    rmaId: row.rma_id ? String(row.rma_id) : null,
    notes: row.notes ? String(row.notes) : null,
    openedAt: String(row.opened_at ?? ''),
    closedAt: row.closed_at ? String(row.closed_at) : null,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

export function isSavRmaStorageAvailable(): boolean {
  return isTauriEnv();
}

// ── Defective returns (quarantine) — first reader of the v116 table ────────

/** Quarantined defective parts, newest first, with their RMA link if any. */
export async function listDefectiveReturns(): Promise<DefectiveReturnRecord[]> {
  if (!isTauriEnv()) return [];
  try {
    const { db } = await pluginDb();
    const rows = (await db.select(
      `SELECT d.id, d.product_id, d.product_name, d.imei, d.quantity, d.unit_cost,
              d.reason, d.sale_id, d.refund_id, d.created_at,
              (SELECT l.rma_id FROM part_rma_lines l WHERE l.defective_return_id = d.id LIMIT 1) AS rma_id
       FROM defective_returns d
       WHERE d.deleted = 0
       ORDER BY d.created_at DESC
       LIMIT 500`
    )) as RawDefectiveRow[];
    return (rows ?? []).map(mapDefective);
  } catch (err) {
    console.error('listDefectiveReturns failed:', err);
    return [];
  }
}

// ── Supplier RMAs ──────────────────────────────────────────────────────────

export async function listPartRmas(): Promise<RmaRecord[]> {
  if (!isTauriEnv()) return [];
  try {
    const { db } = await pluginDb();
    const [rows, aggs] = (await Promise.all([
      db.select(
        `SELECT id, supplier_name, status, vendor_dispute_id, credit_amount, ap_reference,
                notes, opened_at, sent_at, closed_at, created_at, updated_at
         FROM part_rmas
         ORDER BY opened_at DESC
         LIMIT 500`
      ),
      db.select(
        `SELECT rma_id, COUNT(*) AS n, COALESCE(SUM(unit_cost * quantity), 0) AS total
         FROM part_rma_lines GROUP BY rma_id`
      ),
    ])) as [RawRmaRow[], RawRmaAggRow[]];
    const aggByRma = new Map<string, RawRmaAggRow>();
    for (const a of aggs ?? []) aggByRma.set(String(a.rma_id), a);
    return (rows ?? []).map((r) => mapRma(r, aggByRma.get(String(r.id))));
  } catch (err) {
    console.error('listPartRmas failed:', err);
    return [];
  }
}

export async function listPartRmaLines(rmaId?: string): Promise<RmaLineRecord[]> {
  if (!isTauriEnv()) return [];
  try {
    const { db } = await pluginDb();
    const sql = `SELECT id, rma_id, defective_return_id, product_id, product_name, imei,
                        quantity, unit_cost, reason, created_at
                 FROM part_rma_lines
                 ${rmaId ? 'WHERE rma_id = $1' : ''}
                 ORDER BY created_at ASC`;
    const rows = (await db.select(sql, rmaId ? [rmaId] : [])) as RawRmaLineRow[];
    return (rows ?? []).map((row) => ({
      id: String(row.id),
      rmaId: String(row.rma_id),
      defectiveReturnId: row.defective_return_id ? String(row.defective_return_id) : null,
      productId: String(row.product_id),
      productName: row.product_name ? String(row.product_name) : null,
      imei: row.imei ? String(row.imei) : null,
      quantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
      unitCost: toIntMoney(row.unit_cost),
      reason: row.reason ? String(row.reason) : null,
      createdAt: String(row.created_at ?? ''),
    }));
  } catch (err) {
    console.error('listPartRmaLines failed:', err);
    return [];
  }
}

/**
 * Create a supplier RMA with its lines. Defective returns already claimed by
 * an earlier RMA are skipped (a quarantine item is claimed ONCE — a second
 * claim would double-count the recovery); when nothing remains the call
 * returns null and creates no header. Returns the RMA id on success.
 */
export async function createPartRma(input: PartRmaInput): Promise<string | null> {
  const supplier = input.supplierName?.trim();
  if (!isTauriEnv() || !supplier || input.lines.length === 0) return null;
  try {
    const { db, utcNowIso } = await pluginDb();
    const now = utcNowIso();

    let lines = input.lines;
    const wanted = lines
      .map((l) => l.defectiveReturnId)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (wanted.length > 0) {
      const existing = (await db.select(
        `SELECT defective_return_id FROM part_rma_lines WHERE defective_return_id IN (${wanted
          .map((_, i) => `$${i + 1}`)
          .join(',')})`,
        wanted
      )) as Array<{ defective_return_id: string | null }>;
      const linked = new Set(
        (existing ?? []).map((r) => String(r.defective_return_id ?? '')).filter((v) => v.length > 0)
      );
      lines = lines.filter((l) => !l.defectiveReturnId || !linked.has(l.defectiveReturnId));
      if (lines.length === 0) return null;
    }

    const id = newId('rma');
    await db.execute(
      `INSERT INTO part_rmas (id, supplier_name, status, vendor_dispute_id, credit_amount,
                              ap_reference, notes, opened_at, created_at, updated_at)
       VALUES ($1, $2, 'draft', $3, 0, NULL, $4, $5, $5, $5)`,
      [id, supplier, input.vendorDisputeId ?? null, input.notes ?? null, now]
    );
    for (const line of lines) {
      await db.execute(
        `INSERT INTO part_rma_lines (id, rma_id, defective_return_id, product_id, product_name,
                                     imei, quantity, unit_cost, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          newId('rmal'),
          id,
          line.defectiveReturnId ?? null,
          line.productId,
          line.productName ?? null,
          line.imei ?? null,
          Math.max(1, Math.floor(Number(line.quantity) || 1)),
          Math.max(0, Math.round(Number(line.unitCost) || 0)),
          line.reason ?? null,
          now,
        ]
      );
    }
    return id;
  } catch (err) {
    console.error('createPartRma failed:', err);
    return null;
  }
}

/**
 * Status transition + optional credit capture. Timestamps are set once
 * (sent/closed) and never overwritten; `credited` records the supplier's
 * credit (integer DZD), the AP reference, and an optional vendor-dispute link
 * (the AP-side record in `vendor_disputes` this RMA is settled against).
 */
export async function updatePartRmaStatus(
  id: string,
  status: PartRmaStatus,
  patch: {
    creditAmount?: number;
    apReference?: string;
    vendorDisputeId?: string | null;
    notes?: string;
  } = {}
): Promise<boolean> {
  if (!isTauriEnv() || !id) return false;
  try {
    const { db, utcNowIso } = await pluginDb();
    const now = utcNowIso();
    const rows = (await db.select(`SELECT sent_at, closed_at FROM part_rmas WHERE id = $1`, [
      id,
    ])) as Array<{ sent_at: string | null; closed_at: string | null }>;
    if (!rows || rows.length === 0) return false;
    const current = rows[0];
    const sentAt = current.sent_at ?? (status === 'sent' ? now : null);
    const closedAt = current.closed_at ?? (status === 'closed' ? now : null);
    await db.execute(
      `UPDATE part_rmas
       SET status = $2,
           credit_amount = $3,
           ap_reference = COALESCE($4, ap_reference),
           vendor_dispute_id = COALESCE($5, vendor_dispute_id),
           notes = COALESCE($6, notes),
           sent_at = $7,
           closed_at = $8,
           updated_at = $9
       WHERE id = $1`,
      [
        id,
        status,
        Math.max(0, Math.round(Number(patch.creditAmount) || 0)),
        patch.apReference ?? null,
        patch.vendorDisputeId ?? null,
        patch.notes ?? null,
        sentAt,
        closedAt,
        now,
      ]
    );
    return true;
  } catch (err) {
    console.error(`updatePartRmaStatus failed [${id}]:`, err);
    return false;
  }
}

// ── Warranty claims (redo link) ────────────────────────────────────────────

/**
 * Open the claim for a redo ticket — idempotent per rework ticket (returns
 * the existing claim id when one exists, so a retried intake cannot mint a
 * second claim for the same redo).
 */
export async function openWarrantyClaimIfRework(order: {
  id: string;
  reworkOfRepairId?: string;
  reworkOfTicketNumber?: string;
}): Promise<string | null> {
  if (!isTauriEnv() || !order?.reworkOfRepairId || !order?.id) return null;
  try {
    const { db, utcNowIso } = await pluginDb();
    const existing = (await db.select(
      `SELECT id FROM warranty_claims WHERE rework_repair_id = $1 LIMIT 1`,
      [order.id]
    )) as Array<{ id: string }>;
    if (existing && existing.length > 0) return String(existing[0].id);
    const id = newId('wclaim');
    const now = utcNowIso();
    await db.execute(
      `INSERT INTO warranty_claims (id, original_repair_id, rework_repair_id, status,
                                    labor_basis, parts_basis, rma_id, notes,
                                    opened_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'open', 0, 0, NULL, $4, $5, $5, $5)`,
      [
        id,
        order.reworkOfRepairId,
        order.id,
        `Reprise garantie — ticket d'origine ${order.reworkOfTicketNumber ?? order.reworkOfRepairId}`,
        now,
      ]
    );
    return id;
  } catch (err) {
    console.error('openWarrantyClaimIfRework failed:', err);
    return null;
  }
}

/**
 * Close the open claim of a delivered redo with the absorbed bases (the
 * labor the redo billed — 0 on a fully-free redo — and the redo's own frozen
 * parts cost basis). No-op when the claim is already closed or absent.
 */
export async function closeWarrantyClaimForRework(
  reworkRepairId: string,
  bases: { laborBasis: number; partsBasis: number; closedAt: string }
): Promise<boolean> {
  if (!isTauriEnv() || !reworkRepairId) return false;
  try {
    const { db } = await pluginDb();
    await db.execute(
      `UPDATE warranty_claims
       SET status = 'closed',
           labor_basis = $2,
           parts_basis = $3,
           closed_at = $4,
           updated_at = $4
       WHERE rework_repair_id = $1 AND status = 'open'`,
      [
        reworkRepairId,
        Math.max(0, Math.round(Number(bases.laborBasis) || 0)),
        Math.max(0, Math.round(Number(bases.partsBasis) || 0)),
        bases.closedAt,
      ]
    );
    return true;
  } catch (err) {
    console.error(`closeWarrantyClaimForRework failed [${reworkRepairId}]:`, err);
    return false;
  }
}

export async function listWarrantyClaims(): Promise<WarrantyClaimRecord[]> {
  if (!isTauriEnv()) return [];
  try {
    const { db } = await pluginDb();
    const rows = (await db.select(
      `SELECT id, original_repair_id, rework_repair_id, status, labor_basis, parts_basis,
              rma_id, notes, opened_at, closed_at, created_at, updated_at
       FROM warranty_claims
       ORDER BY opened_at DESC
       LIMIT 500`
    )) as RawClaimRow[];
    return (rows ?? []).map(mapClaim);
  } catch (err) {
    console.error('listWarrantyClaims failed:', err);
    return [];
  }
}

/** Attach (or detach with null) the parts RMA a claim's defective part went into. */
export async function linkClaimToRma(claimId: string, rmaId: string | null): Promise<boolean> {
  if (!isTauriEnv() || !claimId) return false;
  try {
    const { db, utcNowIso } = await pluginDb();
    await db.execute(`UPDATE warranty_claims SET rma_id = $2, updated_at = $3 WHERE id = $1`, [
      claimId,
      rmaId,
      utcNowIso(),
    ]);
    return true;
  } catch (err) {
    console.error(`linkClaimToRma failed [${claimId}]:`, err);
    return false;
  }
}

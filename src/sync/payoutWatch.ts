/**
 * Both-offline double-payout convergence detector (ad.md §§7/10 — C6).
 *
 * What deterministic ids + online claims cannot do: stop two OFFLINE tills
 * from each handing out cash for the same ticket. No protocol can un-hand
 * cash — so this module makes the event LOUD instead of silent:
 *
 * 1. Every refund/void/debt-settlement writes an audit entry tagged
 *    `[payout id=REF:<id>|VOID:<id>|DEBTPAY:<id> method=<m> amount=<n> device=<d>]`.
 *    Audit rows carry unique ids and already sync both directions.
 * 2. After each pull (and after each local payout), the detector scans merged
 *    local + peer audit rows. Two CASH payouts for the same payout id from two
 *    distinct devices = the same physical cash handed out twice.
 * 3. The first detector to see it writes ONE deterministic exception audit
 *    entry (`AUDIT-DUP-<id>`, converges via ON CONFLICT) so both devices show
 *    the same exception, and the UI toasts + lists it for the merchant.
 *
 * Non-cash methods (Avoir/Crédit) are convergence-safe by construction and
 * never flagged. Offline-first is untouched: detection is read-only until the
 * exception entry, which is an ordinary synced audit row.
 */

// NOTE: Dexie is imported LAZILY inside functions (never statically): this
// keeps the sync engine out of the database chunk (cold start, P11.3) and
// keeps this module importable in node test harnesses.

export const DUPLICATE_PAYOUT_ACTION = 'Double Encaissement Suspecté';

export interface PayoutTag {
  payoutId: string;
  kind: 'REFUND' | 'VOID' | 'DEBT';
  method: string;
  amount: number;
  device: string;
}

export interface DuplicatePayout extends PayoutTag {
  devices: string[];
  occurrences: number;
}

const TAG_RE = /\[payout\s+id=(REF:\S+|VOID:\S+|DEBTPAY:\S+)\s+method=(\S+)\s+amount=(\d+(?:\.\d+)?)\s+device=(\S+)\s*\]/;

/** Machine-readable payout marker appended to refund/void audit details. */
export function payoutTag(payoutId: string, method: string, amount: number, deviceId: string): string {
  const safeDevice = String(deviceId || 'unknown').replace(/[\s\]]/g, '_').slice(0, 64);
  return `[payout id=${payoutId} method=${method} amount=${Math.max(0, Math.round(amount))} device=${safeDevice}]`;
}

export function parsePayoutTag(details: string): PayoutTag | null {
  if (!details) return null;
  const m = TAG_RE.exec(details);
  if (!m) return null;
  return {
    payoutId: m[1],
    kind: m[1].startsWith('VOID:') ? 'VOID' : m[1].startsWith('DEBTPAY:') ? 'DEBT' : 'REFUND',
    method: m[2],
    amount: Number(m[3]),
    device: m[4],
  };
}

const isCashMethod = (method: string): boolean => method === 'Espèces';

/**
 * Pure convergence check: cash payouts for the same payout id from ≥2
 * distinct devices. Non-cash methods never flag (idempotent by design).
 */
export function findDuplicatePayouts(
  entries: Array<{ id?: string; action?: string; details?: string }>,
): DuplicatePayout[] {
  const byPayout = new Map<string, { tag: PayoutTag; devices: Set<string>; count: number }>();
  for (const e of entries ?? []) {
    if (!e || e.action === DUPLICATE_PAYOUT_ACTION) continue; // exceptions are not payouts
    const tag = parsePayoutTag(String(e.details ?? ''));
    if (!tag || !isCashMethod(tag.method)) continue;
    let g = byPayout.get(tag.payoutId);
    if (!g) {
      g = { tag, devices: new Set(), count: 0 };
      byPayout.set(tag.payoutId, g);
    }
    g.devices.add(tag.device);
    g.count += 1;
  }
  const out: DuplicatePayout[] = [];
  for (const g of byPayout.values()) {
    if (g.devices.size >= 2) {
      out.push({ ...g.tag, devices: [...g.devices].sort(), occurrences: g.count });
    }
  }
  return out;
}

type AuditRow = { id: string; action: string; details: string };

async function readAllAuditRows(): Promise<AuditRow[]> {
  const merged = new Map<string, AuditRow>();
  // Dexie replica first: it always carries pulled peer rows. The SQLite
  // authority mirror is Dexie-only for the audit lane, so SQLite alone would
  // miss the peer half of a duplicate.
  try {
    const { db: dexieDb } = await import('../db/database');
    const dexieRows = (await dexieDb.securityAuditLogs.toArray().catch(() => [])) as AuditRow[];
    for (const r of dexieRows ?? []) {
      if (r?.id) merged.set(String(r.id), { id: String(r.id), action: String(r.action ?? ''), details: String(r.details ?? '') });
    }
  } catch { /* replica unavailable */ }
  try {
    const { getLocalDb } = await import('../db/sqlPluginAdapter');
    const db = await getLocalDb();
    const sqlRows = (await db
      .select('SELECT id, action, details FROM security_audit_logs')
      .catch(() => [])) as AuditRow[];
    for (const r of sqlRows ?? []) {
      if (r?.id && !merged.has(String(r.id))) {
        merged.set(String(r.id), { id: String(r.id), action: String(r.action ?? ''), details: String(r.details ?? '') });
      }
    }
  } catch { /* plain web preview or locked DB */ }
  return [...merged.values()];
}

async function alreadyProcessed(payoutId: string): Promise<boolean> {
  try {
    const { db: dexieDb } = await import('../db/database');
    const row = await dexieDb.appSettings.get(`sync.payoutwatch.${payoutId}`).catch(() => undefined);
    return Boolean(row);
  } catch {
    return false;
  }
}

async function markProcessed(payoutId: string): Promise<void> {
  try {
    const { db: dexieDb } = await import('../db/database');
    await dexieDb.appSettings.put({ key: `sync.payoutwatch.${payoutId}`, value: 1 }).catch(() => {});
  } catch { /* marker best-effort; deterministic exception id dedupes anyway */ }
}

/**
 * Scan merged audit rows and file one deterministic exception entry per new
 * duplicate (converges across devices via the audit lane). Returns the newly
 * filed exceptions for immediate UI toast.
 */
export async function checkDuplicatePayouts(): Promise<DuplicatePayout[]> {  let entries: AuditRow[];
  try {
    entries = await readAllAuditRows();
  } catch {
    return [];
  }
  const dups = findDuplicatePayouts(entries);
  const fresh: DuplicatePayout[] = [];
  for (const d of dups) {
    try {
      if (await alreadyProcessed(d.payoutId)) continue;
    } catch {
      continue;
    }
    try {
      const { operationsAdapter } = await import('../db/adapters/operationsAdapter');
      const ticket = d.payoutId.replace(/^(REF|VOID):/, '');
      await operationsAdapter.saveAuditLog({
        id: `AUDIT-DUP-${d.payoutId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 48)}`,
        timestamp: new Date().toISOString(),
        user: 'Système (Sync)',
        action: DUPLICATE_PAYOUT_ACTION,
        details:
          `Ticket ${ticket} remboursé/annulé en ESPÈCES sur ${d.devices.length} appareils ` +
          `(${d.amount} DA constatés ${d.occurrences}×). ` +
          `La caisse a peut-être rendu la monnaie deux fois — contrôlez le fond de caisse.`,
        requiresPin: false,
      });
      await markProcessed(d.payoutId);
      fresh.push(d);
    } catch (err) {
      console.warn('[payoutWatch] Failed to file duplicate-payout exception:', err);
    }
  }
  return fresh;
}

export const OVERREFUND_ACTION = 'Dépassement Remboursement Suspecté';

export interface OverRefundViolation {
  originalId: string;
  receiptNumber: string;
  productId: string;
  purchased: number;
  refunded: number;
}

/**
 * Post-pull over-refund scan: pre-write and in-txn bounds stop same-device
 * abuse, but two OFFLINE tills refunding the same ticket through different
 * methods (or overlapping item sets) mint distinct deterministic refund ids
 * that each pass locally. After sync both rows stand and nothing re-checks
 * Σ refunded qty > purchased. This scans candidate originals (refunds
 * touched this round → their originals, plus touched originals directly),
 * files ONE deterministic exception audit entry per (original, product)
 * (converges via ON CONFLICT; processed markers stop re-toast), and returns
 * fresh violations for the diagnostics log. Read-only except the exception
 * rows. Voided originals are included deliberately: a voided ticket carrying
 * refunds is the legacy void-after-refund double-restore signature.
 */
export async function checkOverRefundedSales(candidateIds?: string[]): Promise<OverRefundViolation[]> {
  const fresh: OverRefundViolation[] = [];
  try {
    const { db: dexieDb } = await import('../db/database');
    const touched = [...new Set((candidateIds ?? []).map((s) => String(s ?? '')).filter(Boolean))];
    if (touched.length === 0) return fresh;
    type TxRow = {
      id?: string;
      isRefund?: boolean;
      status?: string;
      receiptNumber?: string;
      originalTransactionId?: string;
      items?: Array<{ product?: { id?: string }; quantity?: number }>;
      refundedItems?: Array<{ productId?: string; quantity?: number }>;
    };
    const touchedRows = (await dexieDb.transactions.bulkGet(touched).catch(() => [])) as Array<TxRow | undefined>;
    const originalIds = new Set<string>();
    for (const t of touchedRows ?? []) {
      if (!t) continue;
      if (t.isRefund && t.originalTransactionId) originalIds.add(String(t.originalTransactionId));
      else if (!t.isRefund && t.id) originalIds.add(String(t.id));
    }
    if (originalIds.size === 0) return fresh;
    const originals = new Map<string, TxRow>();
    const origRows = (await dexieDb.transactions.bulkGet([...originalIds]).catch(() => [])) as Array<TxRow | undefined>;
    for (const o of origRows ?? []) {
      if (o?.id) originals.set(String(o.id), o);
    }
    const allRefunds = (await dexieDb.transactions
      .filter((t) => Boolean((t as unknown as TxRow).isRefund))
      .toArray()
      .catch(() => [])) as TxRow[];
    for (const oid of originalIds) {
      const orig = originals.get(oid);
      if (!orig) continue;
      const purchased = new Map<string, number>();
      for (const it of orig.items ?? []) {
        const pid = String(it?.product?.id ?? '');
        if (pid) purchased.set(pid, (purchased.get(pid) ?? 0) + Math.abs(Number(it?.quantity ?? 0)));
      }
      const refunded = new Map<string, number>();
      for (const r of allRefunds ?? []) {
        if (String(r?.originalTransactionId ?? '') !== oid) continue;
        for (const ri of r?.refundedItems ?? []) {
          const pid = String(ri?.productId ?? '');
          if (pid) refunded.set(pid, (refunded.get(pid) ?? 0) + Math.abs(Number(ri?.quantity ?? 0)));
        }
      }
      for (const [pid, rq] of refunded) {
        const pq = purchased.get(pid) ?? 0;
        if (!(rq > pq)) continue;
        const marker = `OVERREFUND-${oid}-${pid}`;
        try {
          if (await alreadyProcessed(marker)) continue;
        } catch {
          continue;
        }
        try {
          const { operationsAdapter } = await import('../db/adapters/operationsAdapter');
          await operationsAdapter.saveAuditLog({
            id: `AUDIT-OVERREFUND-${`${oid}-${pid}`.replace(/[^A-Za-z0-9-]/g, '').slice(0, 48)}`,
            timestamp: new Date().toISOString(),
            user: 'Système (Sync)',
            action: OVERREFUND_ACTION,
            details:
              `Ticket ${String(orig.receiptNumber ?? oid)} : ${rq} unité(s) remboursée(s) pour ${pq} achetée(s) ` +
              `(article ${pid}). Les remboursements dépassent l'achat — contrôlez les avoirs et le stock.`,
            requiresPin: false,
          });
          await markProcessed(marker);
          fresh.push({
            originalId: oid,
            receiptNumber: String(orig.receiptNumber ?? oid),
            productId: pid,
            purchased: pq,
            refunded: rq,
          });
        } catch (err) {
          console.warn('[payoutWatch] Failed to file over-refund exception:', err);
        }
      }
    }
  } catch {
    return fresh;
  }
  return fresh;
}

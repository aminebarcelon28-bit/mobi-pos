/**
 * Push-batch dependency closure (SYNC-002).
 *
 * The push planner ranks a 500-row window and ships 50. Ranking alone
 * strands children whose parents sit beyond the cut (a refund applied
 * before its sale exists orphans the peer's ledger). After ranking, every
 * child in the batch pulls its missing parent in directly ahead of itself:
 * the batch stays dependency-closed no matter where the window cut fell.
 *
 * Scope (documented, not accidental): order_item → order, ledger →
 * order (ref_type 'order' only), customer_debt → customer. Product and
 * customer parents of orders are NOT closed over — the cloud tolerates
 * forward references there, and closing everything would unbound the
 * batch. One level only (parents of parents are rank-0 by construction).
 * Zero dependencies; the fetcher is injected so all of this unit-tests.
 */

export interface ParentRef {
  entity_type: string;
  entity_id: string;
}

/**
 * Minimal row shape; concrete OutboxRow (and test doubles) satisfy it.
 * Deliberately NO index signature: one would make every concrete row type
 * unassignable (TS-2345 at the call site, caught the hard way).
 */
export interface OutboxLike {
  entity_type: string;
  entity_id: string;
  payload_json?: unknown;
  rowid?: number;
}

function parsePayload(op: OutboxLike): Record<string, unknown> | null {
  const raw = op.payload_json;
  try {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    const parsed: unknown = JSON.parse(String(raw ?? '{}'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

/**
 * The parent an outbox row cannot be applied without, or null when the row
 * is a root (or its linkage is unreadable — corrupt payloads skip closure
 * rather than guessing). Pure.
 */
export function outboxParentOf(op: OutboxLike | null | undefined): ParentRef | null {
  if (!op) return null;
  const type = str(op.entity_type);
  const id = str(op.entity_id);
  if (!type || !id) return null;
  const payload = parsePayload(op);
  if (type === 'order_item') {
    const txnId =
      str(payload?.transaction_id) ||
      str(payload?.transactionId) ||
      id.replace(/-item-\d+$/, '');
    if (!txnId || txnId === id) return null;
    return { entity_type: 'order', entity_id: txnId };
  }
  if (type === 'ledger') {
    const refType = str(payload?.ref_type) || str(payload?.refType);
    const refId = str(payload?.ref_id) || str(payload?.refId);
    if (refType !== 'order' || !refId) return null;
    return { entity_type: 'order', entity_id: refId };
  }
  if (type === 'customer_debt') {
    const custId = str(payload?.customer_id) || str(payload?.customerId);
    if (!custId) return null;
    return { entity_type: 'customer', entity_id: custId };
  }
  return null;
}

/**
 * Prepends each batch child's missing parent directly ahead of it.
 * `fetchParent` returns the pending parent row or null (already synced or
 * absent — nothing to prepend). Duplicate-safe, cycle-safe (one level),
 * order-stable for everything else. Never throws: a failed fetch skips
 * that child (it retries next cycle with its parent, same as before).
 */
export async function closePushBatch<T extends OutboxLike>(
  batch: readonly T[],
  fetchParent: (parent: ParentRef) => Promise<T | null>,
): Promise<{ batch: T[]; pulled: number }> {
  // (Generic over the caller's row type so no test double or projection
  // needs the full OutboxRow shape.)
  const out: T[] = [...batch];
  const present = new Set(out.map((o) => `${o.entity_type}:${o.entity_id}`));
  let pulled = 0;
  for (const op of batch) {
    let parent: ParentRef | null = null;
    try {
      parent = outboxParentOf(op);
    } catch {
      continue;
    }
    if (!parent) continue;
    const key = `${parent.entity_type}:${parent.entity_id}`;
    if (present.has(key)) continue;
    let row: T | null = null;
    try {
      row = await fetchParent(parent);
    } catch {
      continue;
    }
    if (!row || row.entity_type !== parent.entity_type || row.entity_id !== parent.entity_id) continue;
    const idx = out.indexOf(op);
    out.splice(idx < 0 ? out.length : idx, 0, row);
    present.add(key);
    pulled += 1;
  }
  return { batch: out, pulled };
}

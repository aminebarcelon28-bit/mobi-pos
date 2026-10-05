/**
 * Durable hold-consume guard (STATE-009).
 *
 * retrieveSale() must restore each held ticket at most once, but the old
 * in-memory Set forgot everything on reload (any hold whose list-removal
 * didn't persist — e.g. quota failure — resurrected) and knew nothing of
 * other tabs (a stale tab replays a consumed hold).
 *
 * This module persists consumed hold ids alongside the holds themselves:
 * - same-tick, crash-safe ordering: callers persist the hold LIST first
 *   (hold gone), then record the consume. A kill between the two leaves a
 *   missing hold, which cannot double-restore — the safe direction.
 * - TTL-pruned (default 48 h, the hold lifetime): the set cannot grow
 *   without bound, and pruned ids belong to long-expired holds.
 * - cross-tab merge: a `storage` listener folds other tabs' consumes into
 *   the live Set, so a stale tab refuses an already-consumed hold.
 * - simultaneous same-millisecond retrieves across two tabs can still both
 *   pass (no distributed lock; navigator.locks coverage on old WebViews is
 *   uneven and sale-time guards — oversell, IMEI — remain the backstop for
 *   serialized/oversell-sensitive goods). Documented residual, not silence.
 *
 * Zero dependencies (localStorage + JSON + Date only) so the whole policy
 * unit-tests in node with a stubbed globalThis.localStorage.
 */

export const CONSUMED_HOLDS_STORAGE_KEY = 'mobi_consumed_holds_v1';

/** Maximum retained consume records (oldest-first eviction past the cap). */
export const MAX_CONSUMED_HOLDS = 500;

export interface ConsumedHoldEntry {
  id: string;
  at: number;
}

function readStorage(): unknown {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(CONSUMED_HOLDS_STORAGE_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeStorage(entries: ConsumedHoldEntry[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CONSUMED_HOLDS_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota/private-mode: memory stays authoritative for the session.
  }
}

/** Pure: drop expired/nonconforming entries, newest-first capped. */
export function pruneConsumedEntries(
  entries: unknown,
  nowMs: number,
  ttlMs: number,
): ConsumedHoldEntry[] {
  if (!Array.isArray(entries)) return [];
  const out: ConsumedHoldEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : '';
    const at = typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : 0;
    if (!id || at <= 0) continue;
    if (nowMs - at > ttlMs) continue;
    out.push({ id, at });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, Math.max(1, MAX_CONSUMED_HOLDS));
}

/** Pure: fold incoming ids into a live set; returns the newly added ids. */
export function mergeConsumedHoldIds(target: Set<string>, incoming: unknown): string[] {
  const added: string[] = [];
  const list = Array.isArray(incoming)
    ? incoming
    : typeof incoming === 'string'
      ? [incoming]
      : [];
  for (const raw of list) {
    const entry = typeof raw === 'string' ? { id: raw } : (raw as Record<string, unknown> | null);
    const id = entry !== null && typeof entry === 'object' ? String((entry as { id?: unknown }).id ?? '') : '';
    if (id && !target.has(id)) {
      target.add(id);
      added.push(id);
    }
  }
  return added;
}

/** Load the durable set (pruning + rewriting when stale entries exist). */
export function loadConsumedHoldIds(nowMs: number = Date.now(), ttlMs = 48 * 60 * 60 * 1000): Set<string> {
  const pruned = pruneConsumedEntries(readStorage(), nowMs, ttlMs);
  const raw = readStorage();
  if (Array.isArray(raw) && raw.length !== pruned.length) {
    writeStorage(pruned);
  }
  return new Set(pruned.map((e) => e.id));
}

/** Record one consume durably (same tick as the hold-list persist). */
export function recordConsumedHoldId(id: string, nowMs: number = Date.now(), ttlMs = 48 * 60 * 60 * 1000): void {
  if (!id) return;
  const pruned = pruneConsumedEntries(readStorage(), nowMs, ttlMs);
  if (!pruned.some((e) => e.id === id)) {
    pruned.unshift({ id, at: nowMs });
  }
  writeStorage(pruned.slice(0, MAX_CONSUMED_HOLDS));
}

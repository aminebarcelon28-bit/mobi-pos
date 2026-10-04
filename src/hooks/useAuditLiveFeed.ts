import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePosStore } from '../store/usePosStore';
import type { SecurityAuditLogEntry } from '../types/pos';
import type { AuditQueryBounds } from '../db/adapters/operationsAdapter';

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'degraded' | 'offline';

export interface AuditLiveFeed {
  /** Store entries merged with polled DB rows, de-duplicated, newest first. */
  entries: SecurityAuditLogEntry[];
  /** Ids that arrived since the feed last settled — drives the "nouveau" pulse. */
  freshIds: ReadonlySet<string>;
  /** Number of unseen arrivals, surfaced as a header badge. */
  unreadCount: number;
  status: LiveStatus;
  /** Timestamp of the last successful poll, or null before the first one. */
  lastSyncAt: Date | null;
  /** Force an immediate refresh. */
  refresh: () => Promise<void>;
  /** Clear the unread badge without touching the list. */
  markSeen: () => void;
}

export interface UseAuditLiveFeedOptions {
  /** Master switch — polling and arrival tracking both stop when false. */
  enabled: boolean;
  /** Poll cadence in ms. The brief asks for 5–10s; 7s is the default. */
  intervalMs?: number;
  /** Hard cap on the merged buffer so a long session cannot grow unbounded. */
  maxEntries?: number;
  /**
   * Date window, pushed down into the repository query.
   *
   * This is not a display filter. The register is read with a hard LIMIT, so
   * filtering in memory could only ever see the newest slice — a request for
   * last week would silently return nothing while rows beyond the cap exist.
   * Passing the bounds here makes the window a SQL range scan, and changing
   * them re-queries instead of re-filtering.
   */
  range?: AuditQueryBounds;
}

const DEFAULT_INTERVAL = 7_000;
const DEFAULT_MAX = 500;

function byNewest(a: SecurityAuditLogEntry, b: SecurityAuditLogEntry): number {
  return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
}

function isUsableIp(value: string | undefined | null): boolean {
  const v = (value || '').trim();
  return v !== '' && !/^(inconnue|non détectée.*)$/i.test(v);
}

/**
 * Live audit feed.
 *
 * The store already prepends local `logSecurityAction` calls to
 * `securityAuditLog`, so a session's own actions appear instantly. What the
 * store cannot see is an audit row written by a *peer* terminal and pulled in
 * by the cloud sync lane, nor one that was persisted after the 200-row
 * in-memory ring rolled over. This hook therefore pairs the reactive store
 * subscription (zero-latency local updates) with a light background poll of
 * the audit repository (cross-device + ring-overflow coverage).
 *
 * There is no SSE endpoint in this Tauri app, so the polling lane is the
 * transport; it is the same shape TanStack Query would drive, and the merge
 * logic below is the "optimistic prepend" cache update.
 *
 * The hook is read-only with respect to the store: it never writes
 * `securityAuditLog` back, so opening the journal cannot mutate the books.
 */
export function useAuditLiveFeed(options: UseAuditLiveFeedOptions): AuditLiveFeed {
  const { enabled, intervalMs = DEFAULT_INTERVAL, maxEntries = DEFAULT_MAX, range } = options;

  const storeEntries = usePosStore((s) => s.securityAuditLog);

  const [pollRows, setPollRows] = useState<SecurityAuditLogEntry[]>([]);
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());

  // Baseline of everything known when the feed was switched on. Anything past
  // this set is an arrival and gets the live pulse.
  const baselineRef = useRef<Set<string> | null>(null);
  const inflightRef = useRef(false);
  const seenRef = useRef<Set<string>>(new Set());
  // Aborts the in-flight poll on unmount / disable. Without this, a poll that
  // resolves after the modal closes still calls setState, and under StrictMode
  // the double-mount would leave two overlapping pollers racing each other.
  const abortRef = useRef<AbortController | null>(null);
  // Distinguishes a "closed while polling" abort from a genuine DB failure, so
  // unmounting never flips the badge to `degraded`.
  const disposedRef = useRef(false);

  // Identity of the active window. A caller passing a fresh object literal
  // every render must not be mistaken for a new window, so the hook pins the
  // last-seen range to this key. This is React's "adjust state while
  // rendering" pattern: the update is scheduled on the same render it detects,
  // and React discards the output before re-running, so no extra paint occurs.
  //
  // The indirection exists so `refresh` can depend on a *stable* range. Without
  // it, a caller that builds the bounds inline would give `refresh` a new
  // identity every render, and the polling effect below would tear down and
  // rebuild its 7s interval on every render — the poller would never fire.
  const rangeKey = range
    ? `${range.start?.toISOString() ?? ''}|${range.end?.toISOString() ?? ''}|${range.limit ?? ''}`
    : '';
  const [activeRange, setActiveRange] = useState<AuditQueryBounds | undefined>(range);
  const [activeRangeKey, setActiveRangeKey] = useState(rangeKey);
  if (activeRangeKey !== rangeKey) {
    setActiveRangeKey(rangeKey);
    setActiveRange(range);
  }

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus((s) => (s === 'live' ? 'live' : 'connecting'));

    try {
      // Dynamic import: the sqlite adapter chain is the heaviest static edge in
      // the app and only this panel needs it.
      const { sqliteAdapter } = await import('../db/sqliteAdapter');
      if (controller.signal.aborted) return;
      const rows = await sqliteAdapter.getAuditLogs(activeRange);
      if (controller.signal.aborted || disposedRef.current) return;

      if (Array.isArray(rows)) {
        setPollRows(rows);
        setLastSyncAt(new Date());
        setStatus('live');
      } else {
        setStatus('degraded');
      }
    } catch (err) {
      if (controller.signal.aborted || disposedRef.current) return;
      // A failed poll degrades the live badge but must never break the panel:
      // the store subscription still feeds it.
      console.warn('[audit] live poll failed:', err);
      setStatus('degraded');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      inflightRef.current = false;
    }
  }, [activeRange]);

  // A new window is a different question, so the previous answer is dropped
  // rather than merged: leaving last week's rows on screen while next week's
  // load is in flight is exactly the stale-register failure this feature
  // exists to prevent.
  useEffect(() => {
    if (!enabled) return;
    setPollRows([]);
    seenRef.current = new Set();
    void refresh();
  }, [enabled, rangeKey, refresh]);

  // ── merge ──────────────────────────────────────────────────────────────────
  const entries = useMemo(() => {
    const merged = new Map<string, SecurityAuditLogEntry>();

    // Polled rows first: they are the persisted truth (device + IP backfilled
    // by the adapter), so a row present in both surfaces keeps that version.
    for (const row of pollRows) {
      if (row?.id) merged.set(row.id, row);
    }
    for (const row of storeEntries) {
      if (!row?.id) continue;
      const existing = merged.get(row.id);
      if (!existing) {
        merged.set(row.id, row);
        continue;
      }
      // The adapter backfills deviceId/ipAddress on persist, so prefer the
      // store copy only when it actually adds attribution.
      merged.set(row.id, {
        ...existing,
        deviceId: existing.deviceId || row.deviceId,
        ipAddress: isUsableIp(existing.ipAddress) ? existing.ipAddress : row.ipAddress,
      });
    }

    const list = Array.from(merged.values())
      .sort((a, b) => byNewest(a, b) || String(a.id).localeCompare(String(b.id)))
      .slice(0, maxEntries);

    return list;
  }, [pollRows, storeEntries, maxEntries]);

  // ── arrival detection ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      baselineRef.current = null;
      return;
    }

    const ids = new Set(entries.map((e) => e.id));

    if (baselineRef.current === null) {
      // First pass after (re)enabling: adopt everything currently visible as
      // the baseline so a re-mount does not mark the whole register "new".
      baselineRef.current = ids;
      seenRef.current = new Set(ids);
      return;
    }

    const arrived = new Set<string>();
    for (const id of ids) {
      if (!seenRef.current.has(id)) arrived.add(id);
    }
    seenRef.current = ids;

    if (arrived.size > 0) {
      // Prepend semantics: the list is newest-first, so a new arrival is
      // already at index 0 — no splice needed, just the highlight.
      setFreshIds(arrived);
    }
  }, [entries, enabled]);

  // ── polling ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      // Closing the modal must stop the poller *now*, not on the next tick:
      // abort whatever is in flight and drop the pending interval.
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }

    // The first load is driven by the range effect above; this effect only
    // owns the cadence from here on.

    const timer = window.setInterval(() => {
      if (document.hidden) return; // don't burn CPU on a hidden window
      void refresh();
    }, intervalMs);

    // Returning to a visible tab is the one moment a stale register is most
    // dangerous (the operator is about to act on what they can see), so poll
    // immediately rather than waiting out the remainder of the interval.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [enabled, intervalMs, refresh]);

  // Leaving live mode should not strand a "degraded" badge on screen.
  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      setFreshIds(new Set());
    }
  }, [enabled]);

  const markSeen = useCallback(() => setFreshIds(new Set()), []);

  const unreadCount = useMemo(() => freshIds.size, [freshIds]);

  return { entries, freshIds, unreadCount, status, lastSyncAt, refresh, markSeen };
}

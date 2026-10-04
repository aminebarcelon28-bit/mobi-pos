import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, ShieldAlert, Lock, UserCheck, Search,
  RefreshCcw, FileSpreadsheet, FileText,
  ExternalLink, Wifi, Monitor,
  Filter, ListFilter, Radio, Play, Pause, Eye,
  Activity,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import { DateRangePicker } from '../ui/DateRangePicker';
import { runGatedAuditExport } from '../../utils/auditExport';
import type { AuditExportOptions } from '../../utils/auditExport';
import { ensureDeviceInfoLoaded, getDeviceId } from '../../utils/deviceInfo';
import { useAuditLiveFeed } from '../../hooks/useAuditLiveFeed';
import { useVirtualRows } from '../../hooks/useVirtualRows';
import { useSharedClock } from '../../hooks/useSharedClock';
import {
  AUDIT_CATEGORIES,
  QUICK_RANGES,
  SEVERITY_META,
  classifySeverity,
  extractEntityRefs,
  foldAccents,
  foldedSearchFields,
  getActionCategory,
  matchesFoldedQuery,
  parseAuditPayload,
  parseAuditTimestamp,
  readDeviceFingerprint,
  resolveActorMeta,
  resolveAuditRange,
  summarizeDenialBursts,
  type AuditSeverity,
  type QuickRangeId,
} from '../../utils/auditIntel';
import { AuditSeverityChip } from '../audit/AuditSeverityChip';
import { AuditRelativeTime } from '../audit/AuditRelativeTime';
import { DenialSummaryStrip } from '../audit/DenialSummaryStrip';
import { CommandFilter, type CommandOption } from '../audit/CommandFilter';
import { AuditInspectionDrawer } from '../audit/AuditInspectionDrawer';
import { AuditVerificationBanner } from '../audit/AuditVerificationBanner';
import type { AuditVerificationReport, AuditVerificationVerdict } from '../../utils/auditIntegrity';
import type { LiveStatus } from '../../hooks/useAuditLiveFeed';
import {
  HONEST_GATE_LABEL,
  WEAK_FALLBACK_LABEL,
  clearJournalUnlock,
  isDevBuild,
  isJournalUnlocked,
  isPinLengthValidForRole,
  isTauriRuntime,
  markJournalUnlocked,
  notifyBackground,
  notifyForeground,
  notifyLocked,
  touchJournalGate,
  verifyManagerStepUp,
} from '../../utils/auditGate';
import { storeLocalVerifyManager } from '../../utils/pinGate';
function openAuditTargetModal(modal: Parameters<ReturnType<typeof usePosStore.getState>['openModal']>[0]) {
  // FT-01: pivots out of the journal inherit the modal gate. A pivot clicked
  // after the window expired must not open — the caller re-checks below.
  if (!isJournalUnlocked()) {
    try {
      window.dispatchEvent(new CustomEvent('mobi:toast', {
        detail: { message: 'Verrouillé — ressaisissez le PIN manager.', type: 'warning' },
      }));
    } catch {
      // No toast bus — silent.
    }
    return;
  }
  usePosStore.getState().openModal(modal);
}

const persistDeepLink = (target: string, entityId: string, entityType: string) => {
  try {
    sessionStorage.setItem('mobi:deep-link', JSON.stringify({ target, entityId, entityType, at: new Date().toISOString() }));
  } catch {
    // sessionStorage unavailable — the mobi:navigate event below is the channel.
  }
  window.dispatchEvent(new CustomEvent('mobi:navigate', {
    detail: { target, entityId, entityType }
  }));
};

const handleEntityClick = (entityId: string, entityType: string) => {
  const typeLower = entityType.toLowerCase();

  if (typeLower.includes('bon') || typeLower.includes('purchase') || typeLower.includes('commande') || entityId.startsWith('po_')) {
    openAuditTargetModal('purchase_order');
    setTimeout(() => persistDeepLink('purchase_order', entityId, 'purchase_order'), 100);
  } else if (typeLower.includes('ticket') || typeLower.includes('sav') || typeLower.includes('repair') || entityId.startsWith('tik_')) {
    openAuditTargetModal('repair_work_order');
    setTimeout(() => persistDeepLink('repair_work_order', entityId, 'repair_order'), 100);
  } else if (typeLower.includes('shift') || typeLower.includes('caisse') || entityId.startsWith('shf_')) {
    openAuditTargetModal('shift_close');
    setTimeout(() => persistDeepLink('shift_close', entityId, 'shift'), 100);
  } else if (typeLower.includes('vente') || typeLower.includes('sale') || entityId.startsWith('ord_')) {
    openAuditTargetModal('reports');
    setTimeout(() => persistDeepLink('reports', entityId, 'sale'), 100);
  } else if (typeLower.includes('client') || typeLower.includes('customer')) {
    openAuditTargetModal('customers');
    setTimeout(() => persistDeepLink('customers', entityId, 'customer'), 100);
  } else if (typeLower.includes('produit') || typeLower.includes('product')) {
    openAuditTargetModal('inventory_manager');
    setTimeout(() => persistDeepLink('inventory_manager', entityId, 'product'), 100);
  } else {
    try {
      window.dispatchEvent(new CustomEvent('mobi:toast', {
        detail: { message: `Entité audit ${entityId} (${entityType}) — aucun visualiseur dédié`, type: 'info' },
      }));
    } catch {
      // No toast bus — silent.
    }
  }
};

/** Tokenized `details` renderer: entity references stay clickable, the rest wraps. */
function makeDetailsClickable(
  details: string,
  refs: { id: string; type: string; index: number; length: number }[],
): React.ReactNode {
  if (!details || details === '—') return <span className="text-pos-muted">—</span>;
  if (refs.length === 0) return <span className="leading-relaxed break-words">{details}</span>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  refs.forEach((ref, idx) => {
    if (ref.index < cursor) return;
    if (ref.index > cursor) parts.push(details.slice(cursor, ref.index));
    parts.push(
      <button
        key={`${ref.id}-${idx}`}
        type="button"
        onClick={(e) => { e.stopPropagation(); handleEntityClick(ref.id, ref.type); }}
        className="text-pos-ok hover:brightness-110 underline font-mono cursor-pointer transition break-all text-left"
        title={`Ouvrir ${ref.type} #${ref.id}`}
      >
        {details.slice(ref.index, ref.index + ref.length)}
        <ExternalLink className="w-2.5 h-2.5 inline-block ml-0.5 -mt-0.5" />
      </button>
    );
    cursor = ref.index + ref.length;
  });
  if (cursor < details.length) parts.push(details.slice(cursor));

  return <span className="leading-relaxed break-words">{parts}</span>;
}

/**
 * Live-feed state presentation.
 *
 * `connecting` and `degraded` were both amber, so a stalled poller and a
 * poller still spinning up looked identical. They now differ: blue means
 * "waiting for the first response", amber means "we got a response we could
 * not trust". All five are semantic tokens so the badge keeps its contrast in
 * light mode, where the raw rose/emerald 400 steps were too light.
 */
const LIVE_STATUS_META: Record<LiveStatus, { label: string; dot: string; text: string }> = {
  idle: { label: 'Flux inactif', dot: 'bg-pos-neutral', text: 'text-pos-muted' },
  connecting: { label: 'Connexion…', dot: 'bg-pos-info', text: 'text-pos-info' },
  live: { label: 'Flux actif', dot: 'bg-pos-ok', text: 'text-pos-ok' },
  degraded: { label: 'Flux dégradé', dot: 'bg-pos-warn', text: 'text-pos-warn' },
  offline: { label: 'Hors-ligne', dot: 'bg-pos-danger', text: 'text-pos-danger' },
};

/**
 * Shared column model for the header and every windowed row. Declared once so
 * the two can never drift; the payload column is the only flexible one, which
 * is what lets long actions wrap instead of being clipped.
 */
const GRID_TEMPLATE =
  'minmax(0,7.5rem) minmax(0,8.5rem) minmax(0,12rem) minmax(0,14rem) minmax(0,1fr) minmax(0,7rem) minmax(0,6.5rem) minmax(0,2.5rem)';

export const SecurityAuditModal: React.FC = () => {
  const { activeModal, closeModal } = usePosStore();
  const { showToast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<string>('all');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedSeverities, setSelectedSeverities] = useState<AuditSeverity[]>([]);
  const [quickRange, setQuickRange] = useState<QuickRangeId>('live');
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [dateRange, setDateRange] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<{ deviceId: string; ipAddress: string }>({ deviceId: '', ipAddress: '' });
  const [isExporting, setIsExporting] = useState<'pdf' | 'xlsx' | null>(null);
  // FT-04: export requires a FRESH native manager PIN per file (no window).
  // exportPinFor selects which file the PIN bar below is authorizing.
  const [exportPinFor, setExportPinFor] = useState<'pdf' | 'xlsx' | null>(null);
  const [exportPin, setExportPin] = useState('');
  const [exportPinError, setExportPinError] = useState<string | null>(null);
  // Verdict for the document produced by the last export, if any.
  const [exportResult, setExportResult] = useState<{
    report: AuditVerificationReport;
    verdict: AuditVerificationVerdict;
  } | null>(null);

  // ── FT-01 modal gate (authoritative; launchers are UX only) ──────────────
  // In-memory window only — never localStorage. Content, feed, and exports
  // render only while unlocked. FT-05 will emit JOURNAL_ACCESS here.
  const [gateUnlocked, setGateUnlocked] = useState(() => isJournalUnlocked());
  const [gatePin, setGatePin] = useState('');
  const [gateError, setGateError] = useState<string | null>(null);
  const [gateVerifying, setGateVerifying] = useState(false);
  const [gateLockedMs, setGateLockedMs] = useState(0);
  const [gateWeaker, setGateWeaker] = useState(false);
  const isScreenLocked = usePosStore((s) => s.isScreenLocked);

  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedToTopRef = useRef(true);

  const isOpen = activeModal === 'security_audit';

  // ── effective window (pushed down to the repository) ───────────────────────
  // Resolved in one place so the SQL range scan and the in-memory narrowing can
  // never disagree about which rows are in scope.
  const effectiveRange = useMemo(
    () => resolveAuditRange(quickRange, { start: dateRange.start, end: dateRange.end }),
    [quickRange, dateRange.start, dateRange.end],
  );

  const feed = useAuditLiveFeed({
    enabled: isOpen && liveEnabled && gateUnlocked,
    range: effectiveRange,
  });

  // Re-evaluated once a second so the « il y a X min » labels in the filter
  // strip and the live counter stay coherent with the row timestamps.
  useSharedClock(isOpen && gateUnlocked);

  // FT-01: re-evaluate the in-memory window whenever the journal opens;
  // clear it when the till locks; relock after mobile background delay.
  useEffect(() => {
    if (!isOpen) return;
    setGateUnlocked(isJournalUnlocked());
  }, [isOpen]);
  useEffect(() => {
    if (isScreenLocked) {
      notifyLocked();
      setGateUnlocked(false);
      setGatePin('');
    }
  }, [isScreenLocked]);
  useEffect(() => {
    if (!isOpen) return;
    const onVis = () => {
      if (document.hidden) {
        notifyBackground();
      } else if (notifyForeground()) {
        setGateUnlocked(false);
        setGatePin('');
      } else {
        setGateUnlocked(isJournalUnlocked());
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [isOpen]);

  const handleGateSubmit = useCallback(async () => {
    const clean = gatePin.trim();
    if (!isPinLengthValidForRole(clean, 'manager')) {
      setGateError('PIN manager : 6 chiffres minimum.');
      return;
    }
    setGateVerifying(true);
    setGateError(null);
    try {
      // Weaker local fallback ONLY for journal view on non-Tauri DEV builds
      // (vite dev / tests). Production browser builds fail closed: the
      // journal is available only in the installed app. The fallback itself
      // lives in utils/pinGate (single sanctioned call site).
      const useWeakFallback = !isTauriRuntime() && isDevBuild();
      const res = await verifyManagerStepUp(clean, {
        allowWeakFallback: useWeakFallback,
        localVerifyFn: storeLocalVerifyManager,
        gateName: 'journal',
      });
      if (res.locked) {
        const secs = Math.max(1, Math.ceil(res.lockedRemainingMs / 1000));
        setGateLockedMs(res.lockedRemainingMs);
        setGateError(`Verrouillé — réessayez dans ${secs}s.`);
        return;
      }
      if (!res.ok) {
        if (res.reason === 'unavailable' && !isTauriRuntime() && !isDevBuild()) {
          setGateError('Journal disponible uniquement dans l\u2019application installée.');
        } else if (res.reason === 'unavailable') {
          setGateError('Vérification indisponible — réessayez.');
        } else {
          setGateError('PIN manager incorrect.');
        }
        return;
      }
      setGateWeaker(res.weaker);
      markJournalUnlocked();
      setGateUnlocked(true);
      setGatePin('');
      setGateError(null);
    } finally {
      setGateVerifying(false);
    }
  }, [gatePin]);

  const handleGateLock = useCallback(() => {
    clearJournalUnlock();
    setGateUnlocked(false);
    setGatePin('');
    setGateError(null);
  }, []);

  // FT-01 idle window: user activity inside the journal extends the window.
  // Background polls never call this — only pointer/keyboard interaction.
  const handleGateActivity = useCallback(() => {
    if (!gateUnlocked) return;
    if (!touchJournalGate()) {
      setGateUnlocked(false);
      setGatePin('');
    }
  }, [gateUnlocked]);

  useEffect(() => {
    ensureDeviceInfoLoaded().then(setDeviceInfo);
  }, []);

  // ── data ───────────────────────────────────────────────────────────────────
  const allEntries = feed.entries;
  const fingerprint = useMemo(() => readDeviceFingerprint(), []);

  // Newest-first already; parse timestamps once per identity change so the
  // filters below compare numbers instead of re-parsing per render.
  const parsed = useMemo(
    () =>
      allEntries.map((entry) => {
        const when = parseAuditTimestamp(entry.timestamp);
        const refs = extractEntityRefs(entry.details);
        const payload = parseAuditPayload(entry.details, entry.action);
        const severity = classifySeverity(entry.action, entry.details, entry.requiresPin);
        return {
          entry,
          when,
          refs,
          payload,
          severity,
          category: getActionCategory(entry.action),
          /** Lazily built on first search, then reused for the life of the row. */
          folded: null as string[] | null,
        };
      }),
    [allEntries],
  );

  const uniqueUsers = useMemo(() => {
    const set = new Set<string>();
    allEntries.forEach((l) => {
      if (l.user) set.add(l.user);
    });
    return Array.from(set).sort();
  }, [allEntries]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    allEntries.forEach((log) => {
      const cat = getActionCategory(log.action).label;
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }, [allEntries]);

  const categoryOptionsWithCounts = useMemo<CommandOption[]>(
    () =>
      AUDIT_CATEGORIES.map((cat) => ({
        value: cat.label,
        label: cat.label,
        count: categoryCounts[cat.label] ?? 0,
        dot: SEVERITY_META[cat.severity].dot,
        keywords: [cat.severity, cat.label.replace(/\//g, ' ')],
      })),
    [categoryCounts],
  );

  const severityCounts = useMemo(() => {
    const counts: Record<AuditSeverity, number> = { critical: 0, warning: 0, info: 0, audit: 0 };
    allEntries.forEach((log) => {
      counts[classifySeverity(log.action, log.details, log.requiresPin)] += 1;
    });
    return counts;
  }, [allEntries]);

  const severityOptions = useMemo<CommandOption[]>(
    () =>
      (Object.keys(SEVERITY_META) as AuditSeverity[]).map((sev) => ({
        value: sev,
        label: SEVERITY_META[sev].label,
        count: severityCounts[sev],
        dot: SEVERITY_META[sev].dot,
        keywords: [sev],
      })),
    [severityCounts],
  );

  // ── filtering ──────────────────────────────────────────────────────────────
  const filteredLogs = useMemo(() => {
    const { start: rangeStartMs, end: rangeEndMs } = effectiveRange;
    const query = foldAccents(searchQuery);

    const kept = parsed.filter((row) => {
      // SQL already narrowed the register to this window. This stays as the
      // exact-precision authority for three reasons: it is what narrows the
      // legacy wall-clock lane (which no ISO range can express), it pins the
      // local-day boundaries the SQL bounds are widened to, and it still
      // covers store rows that never came back from the query.
      if (rangeStartMs !== null && row.when.getTime() < rangeStartMs.getTime()) return false;
      if (rangeEndMs !== null && row.when.getTime() > rangeEndMs.getTime()) return false;

      if (selectedUser !== 'all' && row.entry.user !== selectedUser) return false;

      if (selectedCategories.length > 0 && !selectedCategories.includes(row.category.label)) {
        return false;
      }

      if (selectedSeverities.length > 0 && !selectedSeverities.includes(row.severity)) {
        return false;
      }

      if (query) {
        // Folded once per row and cached on the parsed record: the same row is
        // re-tested on every keystroke, and re-normalising NFD for each of the
        // five fields per render is the expensive part of accent-insensitive
        // search.
        const haystack =
          row.folded ??
          (row.folded = foldedSearchFields({
            action: row.entry.action,
            user: row.entry.user,
            details: row.entry.details,
            category: row.category.label,
            entityIds: row.refs.map((r) => r.id),
          }));
        if (!matchesFoldedQuery(haystack, query)) return false;
      }

      return true;
    });

    kept.sort((a, b) => b.when.getTime() - a.when.getTime());
    return kept;
  }, [parsed, effectiveRange, selectedUser, selectedCategories, selectedSeverities, searchQuery]);

  // ── Phase F denial dashboard ─────────────────────────────────────────────
  // Summary over the CURRENTLY FILTERED window (respects range + filters).
  // Clicking a gate chip narrows the search box to that gate's burst rows.
  const denialSummary = useMemo(
    () => summarizeDenialBursts(filteredLogs.map((r) => r.entry)),
    [filteredLogs],
  );
  const filterToDenialGate = useCallback((gate: string) => {
    setSearchQuery(`GATE_DENIED_BURST ${gate}`);
  }, []);

  // ── virtualisation ─────────────────────────────────────────────────────────
  const virtual = useVirtualRows(filteredLogs.length, {
    estimateSize: 52,
    overscan: 10,
    scrollRef: bodyRef,
  });

  // ── live-stream viewport anchoring ─────────────────────────────────────────
  // Prepending rows must not yank the view out from under someone who has
  // scrolled down to read an older entry. The list stays pinned to the top
  // only while the user is at (or near) the top.
  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    pinnedToTopRef.current = el.scrollTop <= 24;
  }, []);

  const lastCountRef = useRef(filteredLogs.length);
  useEffect(() => {
    const grew = filteredLogs.length > lastCountRef.current;
    lastCountRef.current = filteredLogs.length;
    if (grew && !pinnedToTopRef.current) return;
    if (grew) {
      // Newest row lands at index 0; keep it under the cursor rather than
      // letting the browser preserve the old pixel offset.
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
    }
  }, [filteredLogs.length]);

  // ── inspection drawer ──────────────────────────────────────────────────────
  const inspectedEntry = useMemo(
    () => (inspectedId ? (allEntries.find((e) => e.id === inspectedId) ?? null) : null),
    [inspectedId, allEntries],
  );

  const openInspection = useCallback(
    (id: string) => {
      if (!isJournalUnlocked()) return;
      setInspectedId(id);
    },
    []
  );
  const closeInspection = useCallback(() => setInspectedId(null), []);

  // ── exports ────────────────────────────────────────────────────────────────
  const exportOptions = useMemo<AuditExportOptions>(
    () => ({
      storeName: 'MobiPOS',
      exportedBy: "Admin (Journal d'Audit)",
      deviceId: deviceInfo.deviceId || getDeviceId(),
      ipAddress: deviceInfo.ipAddress,
    }),
    [deviceInfo],
  );

  /**
   * Report the verdict the exporter returned for the document it just wrote.
   *
   * A failure here is not a failed download: the file is on disk either way.
   * What it means is that the manifest could not be re-derived from the source
   * rows, which is a defect in the canonical form and must be surfaced loudly
   * rather than reported as a successful export.
   */
  const reportExportVerdict = useCallback(
    (result: { report: AuditVerificationReport; verdict: AuditVerificationVerdict }, format: 'PDF' | 'Excel') => {
      setExportResult(result);
      const verdict = result.verdict;
      if (verdict.state === 'TAMPER') {
        showToast(`Export ${format} : le manifeste ne se revalide pas.`, 'error');
      } else if (verdict.state === 'DRIFT') {
        showToast(`Export ${format} : document conforme, format hérité.`, 'warning');
      } else if (verdict.state === 'UNVERIFIABLE') {
        showToast(`Export ${format} : manifeste incomplet.`, 'warning');
      } else {
        showToast(`Export ${format} réussi, manifeste conforme.`, 'success');
      }
    },
    [showToast],
  );

  const handleExportPDF = () => {
    if (filteredLogs.length === 0) {
      showToast("Aucune entrée d'audit à exporter.", 'warning');
      return;
    }
    // FT-04: fresh native PIN first (no window) — the pipeline below fails
    // closed at every step and downloads only last.
    setExportPinFor('pdf');
    setExportPin('');
    setExportPinError(null);
  };

  const handleExportExcel = () => {
    if (filteredLogs.length === 0) {
      showToast("Aucune entrée d'audit à exporter.", 'warning');
      return;
    }
    setExportPinFor('xlsx');
    setExportPin('');
    setExportPinError(null);
  };

  // FT-04 pipeline: verify (fresh PIN) → generate in memory → verify manifest
  // → append EXPORT_JOURNAL → deliver. Any failure = no download.
  const handleExportPinSubmit = async () => {
    if (!exportPinFor || isExporting !== null) return;
    const format = exportPinFor;
    const formatLabel = format === 'pdf' ? 'PDF' : 'Excel';
    setIsExporting(format);
    setExportPinError(null);
    try {
      const res = await runGatedAuditExport(
        {
          pin: exportPin,
          format,
          logs: filteredLogs.map((r) => r.entry),
          options: exportOptions,
          filterDescriptor: {
            quickRange,
            dateRange: { start: dateRange.start?.toISOString() ?? null, end: dateRange.end?.toISOString() ?? null },
            user: selectedUser,
            categories: [...selectedCategories].sort(),
            severities: [...selectedSeverities].sort(),
            search: searchQuery,
          },
        }
      );
      if (res.ok) {
        setExportPinFor(null);
        setExportPin('');
        reportExportVerdict({ report: res.report, verdict: res.verdict }, formatLabel);
      } else if (res.reason === 'blocked-tamper' && res.verdict && res.report) {
        setExportResult({ report: res.report, verdict: res.verdict });
        showToast(`Export ${formatLabel} bloqué : le manifeste ne se revalide pas.${res.auditLogged === false ? ' (traçabilité du blocage impossible)' : ''}`, 'error');
      } else if (res.reason === 'locked') {
        setExportPinError(res.message);
      } else {
        setExportPinError(res.message);
        showToast(`Export ${formatLabel} refusé : ${res.message}`, 'error');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Erreur export ${formatLabel} : ${msg}`, 'error');
    } finally {
      setIsExporting(null);
    }
  };

  const handleRefresh = async () => {
    showToast('Actualisation du journal…', 'info');
    await feed.refresh();
  };

  const resetFilters = () => {
    setSearchQuery('');
    setSelectedUser('all');
    setSelectedCategories([]);
    setSelectedSeverities([]);
    setQuickRange('live');
    setDateRange({ start: null, end: null });
  };

  const hasActiveFilters =
    searchQuery !== '' ||
    selectedUser !== 'all' ||
    selectedCategories.length > 0 ||
    selectedSeverities.length > 0 ||
    dateRange.start !== null ||
    dateRange.end !== null;

  const liveMeta = LIVE_STATUS_META[feed.status];
  const activeRange = QUICK_RANGES.find((r) => r.id === quickRange) ?? QUICK_RANGES[0];

  useEffect(() => { if (activeModal !== 'security_audit') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none"
      onPointerDown={handleGateActivity}
      onKeyDown={handleGateActivity}
    >
      <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-2xl sm:rounded-2xl w-full max-w-7xl overflow-hidden shadow-2xl max-h-[94dvh] sm:h-[88dvh] flex flex-col pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:py-0">
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2.5 text-pos-warn min-w-0">
            <div className="w-8 h-8 rounded-xl bg-pos-warn/15 flex items-center justify-center border border-pos-warn/30 shrink-0">
              <ShieldAlert className="w-4 h-4 sm:w-5 sm:h-5 text-pos-warn" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-sm font-bold text-pos-text flex items-center gap-2 flex-wrap">
                <span>Journal d'Audit de Sécurité &amp; Traçabilité (RBAC)</span>
                {gateUnlocked && (
                  <span className="pos-micro-badge pos-micro-badge--warn tabular-nums shrink-0">
                    {allEntries.length} entrées
                  </span>
                )}
                {gateUnlocked && liveEnabled && feed.unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={feed.markSeen}
                    className="pos-micro-badge pos-micro-badge--ok tabular-nums hover:brightness-110 transition cursor-pointer"
                    title="Marquer comme vues"
                  >
                    +{feed.unreadCount} nouveau(x)
                  </button>
                )}
              </h2>
              <p className="text-[10px] text-pos-muted flex items-center gap-1.5 flex-wrap">
                <span className="truncate">Registre inaltérable • Horodatage cryptographique</span>
                {liveEnabled && (
                  <span className={`inline-flex items-center gap-1 font-bold ${liveMeta.text}`}>
                    <span
                      className={`pos-status-dot ${liveMeta.dot} ${feed.status === 'live' ? 'audit-live-dot' : ''}`}
                      aria-hidden="true"
                    />
                    {liveMeta.label}
                    {feed.lastSyncAt && (
                      <span className="font-mono font-normal text-pos-muted">
                        · {feed.lastSyncAt.toLocaleTimeString('fr-DZ')}
                      </span>
                    )}
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {gateUnlocked && (
              <button
                type="button"
                onClick={handleGateLock}
                className="px-2.5 py-2 rounded-xl min-h-[40px] flex items-center gap-1.5 text-[10px] font-bold border bg-pos-hover text-pos-muted border-pos-border hover:text-pos-text transition cursor-pointer shrink-0"
                title="Reverrouiller le journal"
              >
                <Lock className="w-4 h-4" />
                <span className="hidden sm:inline">Verrouiller</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setLiveEnabled((v) => !v)}
              aria-pressed={liveEnabled}
              title={liveEnabled ? 'Suspendre le flux temps réel' : 'Activer le flux temps réel'}
              className={`px-2.5 py-2 rounded-xl min-h-[40px] flex items-center gap-1.5 text-[10px] font-bold border transition cursor-pointer shrink-0 ${
                liveEnabled
                  ? 'pos-micro-badge--ok border-pos-ok/40 hover:brightness-110'
                  : 'bg-pos-hover text-pos-muted border-pos-border hover:text-pos-text'
              }}`}
              disabled={!gateUnlocked}
            >
              {liveEnabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              <span className="hidden sm:inline">{liveEnabled ? 'Live ON' : 'Live OFF'}</span>
            </button>
            <button
              onClick={handleRefresh}
              className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl min-h-[40px] min-w-[40px] flex items-center justify-center shrink-0 cursor-pointer transition"
              title="Actualiser le journal"
              aria-label="Actualiser le journal"
              disabled={!gateUnlocked}
            >
              <RefreshCcw className={`w-5 h-5 ${feed.status === 'connecting' ? 'audit-spin' : ''}`} />
            </button>
            <button
              onClick={closeModal}
              className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0 cursor-pointer"
              aria-label="Fermer le journal d'audit"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {!gateUnlocked ? (
          /* ── FT-01 gate screen (authoritative) ─────────────────────────── */
          <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center gap-4 text-center">
            <div className="w-12 h-12 rounded-full bg-amber-500/15 flex items-center justify-center border border-amber-500/30">
              <Lock className="w-6 h-6 text-amber-400" aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-pos-text">Accès réservé — PIN manager requis</h3>
              <p className="text-[11px] text-pos-muted mt-1 max-w-sm">
                {HONEST_GATE_LABEL}
              </p>
              {gateWeaker && (
                <p className="text-[11px] text-pos-warn mt-1 max-w-sm">{WEAK_FALLBACK_LABEL}</p>
              )}
            </div>
            <form
              className="w-full max-w-xs space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!gateVerifying) void handleGateSubmit();
              }}
            >
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="current-password"
                enterKeyHint="done"
                aria-label="PIN manager, 6 chiffres minimum"
                maxLength={12}
                value={gatePin}
                onChange={(e) => setGatePin(e.target.value.replace(/[^0-9]/g, '').slice(0, 12))}
                placeholder="PIN manager"
                className="w-full min-h-[52px] bg-pos-card border border-pos-border rounded-xl px-4 text-center text-2xl font-mono font-black tracking-[0.5em] text-pos-text focus:outline-none focus:border-amber-500 transition"
              />
              {gateLockedMs > 0 && (
                <p className="text-[11px] text-pos-danger" role="status">
                  Verrouillé — réessayez dans {Math.max(1, Math.ceil(gateLockedMs / 1000))}s.
                </p>
              )}
              {gateError && (
                <p className="text-[11px] text-pos-danger" role="alert">
                  {gateError}
                </p>
              )}
              <button
                type="submit"
                disabled={gateVerifying || gatePin.trim().length < 6}
                className="w-full min-h-[48px] rounded-xl font-bold bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition cursor-pointer"
              >
                {gateVerifying ? 'Vérification…' : 'Déverrouiller le journal'}
              </button>
            </form>
          </div>
        ) : (
        <>
        {/* ── Filter toolbar ─────────────────────────────────────────────── */}
        <div className="p-3 border-b border-pos-border bg-pos-panel/60 shrink-0 space-y-3">
          {/* Quick relative ranges + calendar */}
          <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-2.5">
            <div className="flex items-center gap-1.5 shrink-0">
              <Activity className="w-4 h-4 text-pos-warn shrink-0" aria-hidden="true" />
              <span className="text-[10px] font-bold uppercase text-pos-muted tracking-wider hidden sm:inline">
                Activité :
              </span>
            </div>
            <div
              role="group"
              aria-label="Filtres rapides de période"
              className="flex items-center gap-1 overflow-x-auto overscroll-contain pb-0.5 min-w-0"
            >
              {QUICK_RANGES.map((range) => {
                const isActive = quickRange === range.id;
                return (
                  <button
                    key={range.id}
                    type="button"
                    onClick={() => setQuickRange(range.id)}
                    aria-pressed={isActive}
                    title={range.description}
                    className={`pos-micro-badge px-2.5 py-1.5 whitespace-nowrap transition cursor-pointer shrink-0 ${
                      isActive
                        ? range.id === 'live'
                          ? 'pos-micro-badge--ok'
                          : 'pos-micro-badge--warn'
                        : 'bg-pos-bg text-pos-muted border-pos-border hover:text-pos-text hover:bg-pos-hover'
                    }`}
                  >
                    {range.id === 'live' && (
                      <Radio
                        className={`w-3 h-3 inline-block mr-1 align-[-2px] ${isActive ? 'audit-live-dot text-pos-ok' : ''}`}
                        aria-hidden="true"
                      />
                    )}
                    <span className="hidden sm:inline">{range.label}</span>
                    <span className="sm:hidden">{range.short}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex-1 min-w-0">
              <DateRangePicker
                startDate={dateRange.start}
                endDate={dateRange.end}
                onChange={(start, end) => setDateRange({ start, end })}
                placeholder="Dates personnalisées…"
                disabled={false}
              />
            </div>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="px-2.5 py-1.5 rounded-lg text-[10px] font-bold text-pos-muted hover:text-pos-danger bg-pos-bg border border-pos-border hover:bg-pos-hover transition cursor-pointer shrink-0"
              >
                <X className="w-3 h-3 mr-1 inline-block align-[-2px]" />
                Réinitialiser
              </button>
            )}
          </div>

          {/* Facets */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            <div className="flex items-center gap-2 min-w-0">
              <UserCheck className="w-4 h-4 text-pos-ok shrink-0" aria-hidden="true" />
              <select
                value={selectedUser}
                onChange={(e) => setSelectedUser(e.target.value)}
                aria-label="Filtrer par caissier"
                className="flex-1 min-w-0 bg-pos-bg border border-pos-border rounded-xl px-2.5 py-2 text-xs text-pos-text focus:outline-none focus:border-pos-warn cursor-pointer min-h-[42px]"
              >
                <option value="all">Tous les opérateurs ({allEntries.length})</option>
                {uniqueUsers.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>

            <CommandFilter
              options={categoryOptionsWithCounts}
              selected={selectedCategories}
              onChange={setSelectedCategories}
              placeholder="Catégories"
              icon={<Filter className="w-3.5 h-3.5 text-pos-info shrink-0" />}
              emptyLabel="Aucune catégorie ne correspond"
            />

            <CommandFilter
              options={severityOptions}
              selected={selectedSeverities}
              onChange={setSelectedSeverities as (next: string[]) => void}
              placeholder="Sévérité"
              icon={<ListFilter className="w-3.5 h-3.5 text-pos-danger shrink-0" />}
              emptyLabel="Aucune sévérité ne correspond"
            />

            <div className="relative min-w-0">
              <Search className="w-3.5 h-3.5 text-pos-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Rechercher action, motif, entité…"
                aria-label="Rechercher dans le journal d'audit"
                className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-8 py-2 text-xs text-pos-text placeholder-pos-muted focus:outline-none focus:border-pos-warn min-h-[42px]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Effacer la recherche"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-[10px] px-1 rounded cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Phase F denial dashboard: latest-per-window burst totals for the
              current filter set; gate chips drill down via the search box. */}
          <DenialSummaryStrip summary={denialSummary} onFilterGate={filterToDenialGate} />

          {/* Terminal context + exports */}
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-pos-border/50">
            <div className="flex items-center gap-1.5 text-[10px] text-pos-muted shrink-0">
              <span className="flex items-center gap-1">
                <Monitor className="w-3 h-3" aria-hidden="true" /> Terminal:{' '}
                <span className="font-mono text-pos-text truncate max-w-[160px]">{deviceInfo.deviceId || '…'}</span>
              </span>
              <span className="flex items-center gap-1 ml-3">
                <Wifi className="w-3 h-3" aria-hidden="true" /> IP:{' '}
                <span className="font-mono text-pos-text truncate max-w-[140px]">
                  {deviceInfo.ipAddress || '…'}
                </span>
              </span>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <button
                onClick={handleExportPDF}
                disabled={isExporting !== null || filteredLogs.length === 0}
                className="px-3 py-1.5 rounded-xl bg-pos-danger/15 hover:bg-pos-danger/25 border border-pos-danger/40 text-pos-danger font-bold text-xs flex items-center gap-1.5 transition cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Export PDF/A-3 signé (Conformité PAdES) - Preuve légale non-répudiation"
              >
                <FileText className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Export PDF/A-3</span>
              </button>
              <button
                onClick={handleExportExcel}
                disabled={isExporting !== null || filteredLogs.length === 0}
                className="px-3 py-1.5 rounded-xl bg-pos-ok/15 hover:bg-pos-ok/25 border border-pos-ok/40 text-pos-ok font-bold text-xs flex items-center gap-1.5 transition cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Export Excel avancé (ExcelJS) - Feuille protégée, filtres, types natifs"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Export Excel</span>
              </button>
            </div>
          </div>

          {/* Verdict on the last exported document. A drift notice is
              informational and does not block; a tamper verdict is stated
              explicitly and is never collapsed into the export success toast. */}
          {exportResult && (
            <div className="pt-2">
              <AuditVerificationBanner
                verdict={exportResult.verdict}
                report={exportResult.report}
                onInspect={openInspection}
              />
            </div>
          )}

          {/* FT-04: fresh-PIN bar per export (no window, no weak fallback).
              The file is generated in memory, verified, audited — then handed
              over. Any failure means no download. */}
          {exportPinFor && (
            <form
              className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 border-t border-pos-border/50"
              onSubmit={(e) => {
                e.preventDefault();
                if (isExporting === null) void handleExportPinSubmit();
              }}
            >
              <span className="text-[11px] font-bold text-pos-text flex items-center gap-1.5 shrink-0">
                <Lock className="w-3.5 h-3.5 text-pos-warn" aria-hidden="true" />
                Export {exportPinFor === 'pdf' ? 'PDF' : 'Excel'} — PIN manager requis (vérification native)
              </span>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="current-password"
                enterKeyHint="done"
                aria-label="PIN manager, 6 chiffres minimum"
                maxLength={12}
                value={exportPin}
                onChange={(e) => {
                  setExportPinError(null);
                  setExportPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 12));
                }}
                placeholder="PIN manager"
                className="flex-1 min-w-0 min-h-[42px] bg-pos-bg border border-pos-border rounded-xl px-3 text-center font-mono font-bold tracking-[0.4em] text-pos-text placeholder-pos-muted focus:outline-none focus:border-pos-warn"
              />
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="submit"
                  disabled={isExporting !== null || exportPin.trim().length < 6}
                  className="px-4 min-h-[42px] rounded-xl font-bold bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs transition cursor-pointer"
                >
                  {isExporting !== null ? 'Export…' : 'Valider'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExportPinFor(null);
                    setExportPin('');
                    setExportPinError(null);
                  }}
                  disabled={isExporting !== null}
                  className="px-4 min-h-[42px] rounded-xl font-bold bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted text-xs transition cursor-pointer disabled:opacity-40"
                >
                  Annuler
                </button>
              </div>
              {exportPinError && (
                <p className="text-[11px] text-pos-danger sm:basis-full" role="alert">
                  {exportPinError}
                </p>
              )}
            </form>
          )}
        </div>

        {/* ── Log body ──────────────────────────────────────────────────── */}
        <div
          ref={bodyRef}
          onScroll={onBodyScroll}
          className="flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4"
        >
          {filteredLogs.length === 0 ? (
            <div className="p-10 text-center text-pos-muted text-xs bg-pos-card border border-pos-border rounded-2xl flex flex-col items-center justify-center gap-2">
              <ShieldAlert className="w-8 h-8 text-pos-muted/50" aria-hidden="true" />
              <span>
                {allEntries.length === 0
                  ? 'Aucune action sensible enregistrée pour le moment.'
                  : quickRange === 'live'
                    ? "Aucune activité dans le flux temps réel. Élargissez la période (bouton « 1 h » ou « TOUT ») pour consulter l'historique."
                    : 'Aucun enregistrement ne correspond aux critères de recherche actuels.'}
              </span>
              {hasActiveFilters && (
                <button
                  onClick={resetFilters}
                  className="mt-2 text-pos-warn hover:underline text-xs flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCcw className="w-3 h-3" /> Réinitialiser tous les filtres
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Mobile card list */}
              <div className="md:hidden space-y-2.5">
                {filteredLogs.map((row) => {
                  const { entry, refs, severity, category } = row;
                  const isFresh = feed.freshIds.has(entry.id);
                  const actor = resolveActorMeta(entry, deviceInfo, fingerprint, row.when);
                  return (
                    /* A div, not a <button>: the card embeds real buttons (the
                       entity deep-links and the inspect action), and nesting
                       interactive controls inside one is invalid HTML and
                       strands them for keyboard users. */
                    <div
                      key={entry.id}
                      onClick={() => openInspection(entry.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openInspection(entry.id);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      className={`w-full text-left bg-pos-card border rounded-xl p-3 space-y-2 transition cursor-pointer focus:outline-none focus:border-pos-warn ${
                        isFresh ? 'border-pos-ok/50 audit-fresh-row' : 'border-pos-border'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <AuditRelativeTime
                          timestamp={entry.timestamp}
                          className="text-pos-muted font-mono"
                        />
                        <div className="flex items-center gap-1.5 shrink-0">
                          {entry.requiresPin && (
                            <span className="pos-micro-badge pos-micro-badge--warn">
                              <Lock className="w-2.5 h-2.5" aria-hidden="true" /> PIN
                            </span>
                          )}
                          {/* FT-06/C + F4: imported/peer history markers (unverified). */}
                          {(entry.source ?? 'local') === 'imported' && (
                            <span
                              className="pos-micro-badge pos-micro-badge--info"
                              title="Ligne importée d'une sauvegarde — historique non vérifié"
                            >
                              import
                            </span>
                          )}
                          {(entry.source ?? 'local') === 'peer' && (
                            <span
                              className="pos-micro-badge pos-micro-badge--info"
                              title="Ligne reçue d'un autre terminal — historique non vérifié"
                            >
                              pair
                            </span>
                          )}
                          <AuditSeverityChip severity={severity} category={category.label} size="xs" />
                        </div>
                      </div>

                      {/* No truncation: the action wraps to its natural length. */}
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-bold text-xs text-pos-text break-words min-w-0">
                          {entry.action}
                        </span>
                        <span className="text-[10px] font-semibold text-pos-text flex items-center gap-1 shrink-0 max-w-[45%]">
                          <UserCheck className="w-3 h-3 text-pos-ok shrink-0" aria-hidden="true" />
                          <span className="truncate">{entry.user}</span>
                        </span>
                      </div>

                      {entry.details && (
                        <p className="text-[11px] text-pos-muted bg-pos-bg/80 p-2 rounded-lg border border-pos-border/50">
                          {makeDetailsClickable(entry.details, refs)}
                        </p>
                      )}

                      <div className="flex items-center justify-between gap-2 text-[9px] text-pos-muted font-mono">
                        <span className="truncate">{actor.deviceId}</span>
                        <span className="truncate">{actor.ipAddress}</span>
                        <Eye className="w-3 h-3 shrink-0" aria-hidden="true" />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Virtualized desktop grid.
                  A real <table> cannot be windowed: absolutely-positioned rows
                  collapse under `display: table`, so the header and the body
                  stop sharing a column model. A CSS grid with an explicit
                  template keeps both aligned while rows are offset by
                  translateY. */}
              <div className="hidden md:block rounded-xl border border-pos-border overflow-hidden shadow-sm">
                <div
                  role="row"
                  className="grid gap-2 px-2.5 py-2 bg-pos-card text-pos-muted text-[10px] uppercase font-bold border-b border-pos-border"
                  style={{ gridTemplateColumns: GRID_TEMPLATE }}
                >
                  <span role="columnheader" className="pl-3">Horodatage</span>
                  <span role="columnheader">Opérateur</span>
                  <span role="columnheader">Sévérité</span>
                  <span role="columnheader">Action</span>
                  <span role="columnheader">Charge utile</span>
                  <span role="columnheader">Terminal</span>
                  <span role="columnheader">IP</span>
                  <span role="columnheader" className="text-center">
                    <span className="sr-only">Inspection</span>
                  </span>
                </div>

                <div
                  className="relative bg-pos-panel/30"
                  style={{ height: virtual.totalSize }}
                >
                  {virtual.rows.map((row) => {
                    const item = filteredLogs[row.index];
                    if (!item) return null;
                    const { entry, refs, severity, category } = item;
                    const isFresh = feed.freshIds.has(entry.id);
                    const actor = resolveActorMeta(entry, deviceInfo, fingerprint, item.when);
                    return (
                      <div
                        key={entry.id}
                        role="row"
                        ref={virtual.measureRef(row.index)}
                        onClick={() => openInspection(entry.id)}
                        style={{
                          transform: `translateY(${row.start}px)`,
                          gridTemplateColumns: GRID_TEMPLATE,
                        }}
                        className={`absolute inset-x-0 top-0 grid gap-2 px-2.5 py-2 border-b border-pos-border/40 cursor-pointer transition ${
                          isFresh ? 'audit-fresh-row' : 'hover:bg-pos-hover/50'
                        }`}
                      >
                        <div className="flex items-start gap-1.5 min-w-0">
                          <span
                            className={`w-0.5 h-7 rounded-full shrink-0 ${SEVERITY_META[severity].rail}`}
                            aria-hidden="true"
                          />
                          <span className="text-pos-muted font-mono text-[10px] whitespace-nowrap">
                            <AuditRelativeTime timestamp={entry.timestamp} showIcon={false} />
                          </span>
                        </div>

                        <div className="font-semibold text-pos-text text-[11px] min-w-0">
                          <span className="flex items-start gap-1.5 break-words">
                            <UserCheck className="w-3.5 h-3.5 text-pos-ok shrink-0 mt-px" aria-hidden="true" />
                            <span className="break-words">{entry.user}</span>
                          </span>
                        </div>

                        <div className="min-w-0">
                          <AuditSeverityChip severity={severity} category={category.label} />
                        </div>

                        {/* Wrapping replaces the old truncate + ellipsis. */}
                        <div className="min-w-0">
                          <span className="font-bold text-pos-text leading-snug break-words whitespace-normal">
                            {entry.action}
                          </span>
                          {entry.requiresPin && (
                            <span className="mt-1 inline-flex items-center gap-1 pos-micro-badge pos-micro-badge--warn">
                              <Lock className="w-2.5 h-2.5" aria-hidden="true" /> PIN validé
                            </span>
                          )}
                          {/* FT-06/C + F4: imported/peer history markers (unverified). */}
                          {(entry.source ?? 'local') === 'imported' && (
                            <span
                              className="mt-1 ml-1 inline-flex items-center gap-1 pos-micro-badge pos-micro-badge--info"
                              title="Ligne importée d'une sauvegarde — historique non vérifié"
                            >
                              import
                            </span>
                          )}
                          {(entry.source ?? 'local') === 'peer' && (
                            <span
                              className="mt-1 ml-1 inline-flex items-center gap-1 pos-micro-badge pos-micro-badge--info"
                              title="Ligne reçue d'un autre terminal — historique non vérifié"
                            >
                              pair
                            </span>
                          )}
                        </div>

                        <div className="text-pos-muted text-[11px] leading-relaxed min-w-0">
                          {makeDetailsClickable(entry.details, refs)}
                        </div>

                        <div className="text-center font-mono text-[9px] min-w-0">
                          <span className="text-pos-text break-all">{actor.deviceId}</span>
                          {actor.deviceOrigin !== 'recorded' && (
                            <span className="block text-pos-warn/80 mt-0.5" title={actor.sessionTag}>
                              (session)
                            </span>
                          )}
                        </div>

                        <div className="text-center font-mono text-[9px] min-w-0">
                          <span className="text-pos-text break-all">{actor.ipAddress}</span>
                          {actor.ipOrigin !== 'recorded' && (
                            <span className="block text-pos-warn/80 mt-0.5">(session)</span>
                          )}
                        </div>

                        <div className="text-center">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openInspection(entry.id); }}
                            aria-label={`Inspecter : ${entry.action}`}
                            className="p-1.5 rounded-lg text-pos-muted hover:text-pos-text hover:bg-pos-hover transition cursor-pointer inline-flex"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {virtual.measuring && (
                <div className="hidden md:flex items-center gap-1.5 mt-2 text-[10px] text-pos-muted justify-center">
                  <RefreshCcw className="w-3 h-3 audit-spin" aria-hidden="true" />
                  Recalcul des hauteurs de lignes…
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Footer ────────────────────────────────────────────────────── */}
        <div className="p-3 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-2 text-xs text-pos-muted shrink-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="flex items-center gap-2">
              <span className="pos-status-dot bg-pos-ok" aria-hidden="true" />
              <span>
                Journal cryptographiquement horodaté • {filteredLogs.length} sur {allEntries.length}{' '}
                enregistrements affichés
              </span>
            </span>
            <span className="pos-micro-badge pos-micro-badge--warn">
              {activeRange.label}
            </span>
            {selectedCategories.length > 0 && (
              <span className="pos-micro-badge pos-micro-badge--info">
                {selectedCategories.length} catégorie(s)
              </span>
            )}
            {selectedSeverities.length > 0 && (
              <span className="pos-micro-badge pos-micro-badge--danger">
                {selectedSeverities.length} sévérité(s)
              </span>
            )}
            {liveEnabled && feed.status === 'degraded' && (
              <span className="pos-micro-badge pos-micro-badge--warn">
                Flux temps réel dégradé
              </span>
            )}
          </div>
          <button
            onClick={closeModal}
            className="px-5 py-2 rounded-xl bg-pos-hover hover:bg-pos-border text-pos-text font-bold text-xs min-h-[40px] flex items-center justify-center transition cursor-pointer"
          >
            Fermer
          </button>
        </div>
        </>
        )}
      </div>

      {/* ── Deep inspection slide-over (gated) ───────────────────────────── */}
      {gateUnlocked && inspectedEntry && (
        <AuditInspectionDrawer
          entry={inspectedEntry}
          onClose={closeInspection}
          session={deviceInfo}
          onEntityNavigate={handleEntityClick}
        />
      )}
    </div>
  );
};

import React, { useState, useMemo, useEffect } from 'react';
import {
  X, ShieldAlert, Lock, Clock, UserCheck, Search,
  RefreshCcw, FileSpreadsheet, FileText,
  ExternalLink, Wifi, Monitor,
  Filter, Calendar, Database, Hash, Link2,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import { formatDateTime } from '../../types/pos';
import { DateRangePicker, MultiSelect } from '../ui/DateRangePicker';
import { triggerAuditExport } from '../../utils/auditExport';
import type { AuditExportOptions } from '../../utils/auditExport';
import { ensureDeviceInfoLoaded, getDeviceId } from '../../utils/deviceInfo';
import type { SecurityAuditLogEntry } from '../../types/pos';

function openAuditTargetModal(modal: Parameters<ReturnType<typeof usePosStore.getState>['openModal']>[0]) {
  usePosStore.getState().openModal(modal);
}

interface ParsedLogEntry extends SecurityAuditLogEntry {
  parsedTimestamp: Date;
  entityIds: string[];
  entityTypes: string[];
}

function parseLogDetails(details: string): { entityIds: string[]; entityTypes: string[] } {
  const entityIds: string[] = [];
  const entityTypes: string[] = [];
  
  const patterns = [
    { regex: /Bon\s*#?([A-Z0-9\-]+)/gi, type: 'Bon de Commande' },
    { regex: /Commande\s*#?([A-Z0-9\-]+)/gi, type: 'Commande' },
    { regex: /Ticket\s*#?([A-Z0-9\-]+)/gi, type: 'Ticket SAV' },
    { regex: /Shift\s*#?([A-Z0-9\-]+)/gi, type: 'Shift / Caisse' },
    { regex: /PO\s*#?([A-Z0-9\-]+)/gi, type: 'Bon de Commande' },
    { regex: /Vente\s*#?([A-Z0-9\-]+)/gi, type: 'Vente' },
    { regex: /Client\s*#?([A-Z0-9\-]+)/gi, type: 'Client' },
    { regex: /Produit\s*#?([A-Z0-9\-]+)/gi, type: 'Produit' },
    { regex: /([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/gi, type: 'UUID' },
    { regex: /(shf_[a-z0-9]+)/gi, type: 'Shift' },
    { regex: /(po_[a-z0-9]+)/gi, type: 'Bon de Commande' },
    { regex: /(ord_[a-z0-9]+)/gi, type: 'Commande' },
    { regex: /(tik_[a-z0-9]+)/gi, type: 'Ticket SAV' },
  ];

  patterns.forEach(({ regex, type }) => {
    const matches = details.matchAll(regex);
    for (const match of matches) {
      if (match[1] && !entityIds.includes(match[1])) {
        entityIds.push(match[1]);
        entityTypes.push(type);
      }
    }
  });

  return { entityIds, entityTypes };
}

function parseTimestampRobust(raw: string | undefined): Date {
  if (!raw) return new Date();
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;
  // Legacy entries stored only "HH:MM" (toLocaleTimeString) — interpret as
  // today at that time so they remain sortable + range-filterable.
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw.trim());
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0), 0);
    return d;
  }
  return new Date();
}

function parseLogsForDisplay(logs: SecurityAuditLogEntry[]): ParsedLogEntry[] {
  return logs.map((log) => ({
    ...log,
    parsedTimestamp: parseTimestampRobust(log.timestamp),
    ...parseLogDetails(log.details || ''),
  }));
}

function getActionCategory(action: string): { label: string; color: string; icon: React.ReactNode } {
  const act = (action || '').toLowerCase();
  if (act.includes('tiroir') || act.includes('no sale')) {
    return { label: 'Ouverture Tiroir', color: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30', icon: <Database className="w-3 h-3" /> };
  }
  if (act.includes('remise') || act.includes('prix') || act.includes('perte')) {
    return { label: 'Remise / Dérogation', color: 'bg-amber-500/15 text-amber-400 border-amber-500/30', icon: <Hash className="w-3 h-3" /> };
  }
  if (act.includes('annulation') || act.includes('suppression')) {
    return { label: 'Annulation / Suppression', color: 'bg-rose-500/15 text-rose-400 border-rose-500/30', icon: <X className="w-3 h-3" /> };
  }
  if (act.includes('pin') || act.includes('sécurité') || act.includes('responsable') || act.includes('manager')) {
    return { label: 'Autorisation PIN', color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', icon: <Lock className="w-3 h-3" /> };
  }
  if (act.includes('recomptage') || act.includes('clôture') || act.includes('caisse') || act.includes('shift')) {
    return { label: 'Gestion Caisse', color: 'bg-blue-500/15 text-blue-400 border-blue-500/30', icon: <Monitor className="w-3 h-3" /> };
  }
  if (act.includes('création') || act.includes('modification') || act.includes('ajout')) {
    return { label: 'Création / Modification', color: 'bg-violet-500/15 text-violet-400 border-violet-500/30', icon: <Database className="w-3 h-3" /> };
  }
  if (act.includes('connexion') || act.includes('déconnexion') || act.includes('login')) {
    return { label: 'Session', color: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30', icon: <Wifi className="w-3 h-3" /> };
  }
  return { label: 'Autre', color: 'bg-pos-muted/15 text-pos-muted border-pos-muted/30', icon: <ShieldAlert className="w-3 h-3" /> };
}

function makeDetailsClickable(details: string, entityIds: string[], entityTypes: string[]): React.ReactNode {
  if (!details || details === '—') return <span className="text-pos-muted">—</span>;
  if (entityIds.length === 0) return <span className="leading-relaxed">{details}</span>;

  const entityMap = new Map(entityIds.map((id, i) => [id, entityTypes[i]]));
  // Single-pass tokenization in document order: collect every occurrence,
  // sort by offset, drop overlaps (longest match wins at same offset).
  const hits: { start: number; end: number; id: string; text: string }[] = [];
  entityIds.forEach((entityId) => {
    if (!entityId) return;
    const regex = new RegExp(entityId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(details)) !== null) {
      hits.push({ start: match.index, end: match.index + match[0].length, id: entityId, text: match[0] });
      if (match[0].length === 0) regex.lastIndex++;
    }
  });
  hits.sort((a, b) => a.start - b.start || b.end - a.end);

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  hits.forEach((hit, idx) => {
    if (hit.start < cursor) return; // overlapped by a longer earlier match
    if (hit.start > cursor) parts.push(details.slice(cursor, hit.start));
    const type = entityMap.get(hit.id) || 'Entité';
    parts.push(
      <button
        key={`${hit.id}-${hit.start}-${idx}`}
        type="button"
        onClick={(e) => { e.stopPropagation(); handleEntityClick(hit.id, type); }}
        className="text-amber-400 hover:text-amber-300 underline font-mono cursor-pointer transition"
        title={`Ouvrir ${type} #${hit.id}`}
      >
        {hit.text}
        <ExternalLink className="w-2.5 h-2.5 inline-block ml-0.5 -mt-0.5" />
      </button>
    );
    cursor = hit.end;
  });
  if (cursor < details.length) parts.push(details.slice(cursor));

  return <span className="leading-relaxed">{parts}</span>;
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
    // UUID / unknown entity: still traceable — surface the id for copy/paste.
    try {
      window.dispatchEvent(new CustomEvent('mobi:toast', {
        detail: { message: `Entité audit ${entityId} (${entityType}) — aucun visualiseur dédié`, type: 'info' },
      }));
    } catch {
      // No toast bus — silent.
    }
  }
};

export const SecurityAuditModal: React.FC = () => {
  const { activeModal, closeModal, securityAuditLog } = usePosStore();
  const { showToast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<string>('all');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<{ deviceId: string; ipAddress: string }>({ deviceId: '', ipAddress: '' });
  const [isExporting, setIsExporting] = useState<'pdf' | 'xlsx' | null>(null);

  // Canonical categories — values MUST equal getActionCategory().label or the
  // multi-select filter silently matches nothing (legacy bug: code values
  // like 'drawer' were compared against French labels).
  const categoryOptions = useMemo(() => [
    { value: 'Ouverture Tiroir', label: 'Ouverture Tiroir' },
    { value: 'Remise / Dérogation', label: 'Remise / Dérogation' },
    { value: 'Annulation / Suppression', label: 'Annulation / Suppression' },
    { value: 'Autorisation PIN', label: 'Autorisation PIN' },
    { value: 'Gestion Caisse', label: 'Gestion Caisse' },
    { value: 'Création / Modification', label: 'Création / Modification' },
    { value: 'Session', label: 'Session' },
    { value: 'Autre', label: 'Autre' },
  ], []);

  useEffect(() => {
    ensureDeviceInfoLoaded().then(setDeviceInfo);
  }, []);

  const uniqueUsers = useMemo(() => {
    const set = new Set<string>();
    securityAuditLog.forEach((l) => {
      if (l.user) set.add(l.user);
    });
    return Array.from(set).sort();
  }, [securityAuditLog]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    securityAuditLog.forEach((log) => {
      const cat = getActionCategory(log.action).label;
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }, [securityAuditLog]);

  const categoryOptionsWithCounts = useMemo(() =>
    categoryOptions.map((opt) => ({
      ...opt,
      count: categoryCounts[opt.value] ?? 0,
    })),
  [categoryOptions, categoryCounts]);

  const filteredLogs = useMemo(() => {
    const parsed = parseLogsForDisplay(securityAuditLog);

    const kept = parsed.filter((log) => {
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matchesUser = log.user?.toLowerCase().includes(query);
        const matchesAction = log.action?.toLowerCase().includes(query);
        const matchesDetails = log.details?.toLowerCase().includes(query);
        const matchesTime = log.timestamp?.toLowerCase().includes(query);
        const matchesEntity = log.entityIds.some((id) => id.toLowerCase().includes(query));
        if (!matchesUser && !matchesAction && !matchesDetails && !matchesTime && !matchesEntity) {
          return false;
        }
      }

      if (selectedUser !== 'all' && log.user !== selectedUser) {
        return false;
      }

      if (selectedCategories.length > 0) {
        const cat = getActionCategory(log.action).label;
        if (!selectedCategories.includes(cat)) {
          return false;
        }
      }

      if (dateRange.start) {
        const start = new Date(dateRange.start);
        start.setHours(0, 0, 0, 0);
        if (log.parsedTimestamp < start) return false;
      }

      if (dateRange.end) {
        const end = new Date(dateRange.end);
        end.setHours(23, 59, 59, 999);
        if (log.parsedTimestamp > end) return false;
      }

      return true;
    });

    // Newest-first chronological order (creation timestamp DESC).
    kept.sort((a, b) => b.parsedTimestamp.getTime() - a.parsedTimestamp.getTime());
    return kept;
  }, [securityAuditLog, searchQuery, selectedUser, selectedCategories, dateRange]);

  const handleExportPDF = async () => {
    if (filteredLogs.length === 0) {
      showToast("Aucune entrée d'audit à exporter.", 'warning');
      return;
    }
    setIsExporting('pdf');
    try {
      const options: AuditExportOptions = {
        storeName: 'MobiPOS',
        exportedBy: 'Admin (Journal d\'Audit)',
        deviceId: deviceInfo.deviceId || getDeviceId(),
        ipAddress: deviceInfo.ipAddress,
      };
      await triggerAuditExport(filteredLogs, 'pdf', options);
      showToast(`Export PDF/A-3 réussi (${filteredLogs.length} entrées).`, 'success');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Erreur export PDF : ${msg}`, 'error');
    } finally {
      setIsExporting(null);
    }
  };

  const handleExportExcel = async () => {
    if (filteredLogs.length === 0) {
      showToast("Aucune entrée d'audit à exporter.", 'warning');
      return;
    }
    setIsExporting('xlsx');
    try {
      const options: AuditExportOptions = {
        storeName: 'MobiPOS',
        exportedBy: 'Admin (Journal d\'Audit)',
        deviceId: deviceInfo.deviceId || getDeviceId(),
        ipAddress: deviceInfo.ipAddress,
      };
      await triggerAuditExport(filteredLogs, 'xlsx', options);
      showToast(`Export Excel avancé réussi (${filteredLogs.length} entrées).`, 'success');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Erreur export Excel : ${msg}`, 'error');
    } finally {
      setIsExporting(null);
    }
  };

  const handleRefresh = () => {
    showToast('Actualisation du journal...', 'info');
  };

  if (activeModal !== 'security_audit') return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none">
      <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-7xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 max-h-[94vh] sm:h-[88vh] flex flex-col pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:py-0">
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2.5 text-amber-400 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-amber-500/15 flex items-center justify-center border border-amber-500/30 shrink-0">
              <ShieldAlert className="w-4 h-4 sm:w-5 sm:h-5 text-amber-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-sm font-bold text-pos-text truncate flex items-center gap-2">
                <span>Journal d'Audit de Sécurité & Traçabilité (RBAC)</span>
                <span className="bg-amber-500/20 text-amber-300 text-[10px] font-mono px-2 py-0.5 rounded-full border border-amber-500/30 shrink-0">
                  {securityAuditLog.length} entrées
                </span>
              </h2>
              <p className="text-[10px] text-pos-muted truncate">
                Registre inaltérable • Horodatage cryptographique • Traçabilité complète terminal/IP
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleRefresh}
              className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl min-h-[40px] min-w-[40px] flex items-center justify-center shrink-0 cursor-pointer transition"
              title="Actualiser le journal"
            >
              <RefreshCcw className="w-5 h-5" />
            </button>
            <button
              onClick={closeModal}
              className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl min-h-[40px] min-w-[40px] flex items-center justify-center shrink-0 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Advanced Filter Toolbar */}
        <div className="p-3 border-b border-pos-border bg-pos-panel/60 shrink-0 space-y-3">
          {/* Primary Filter: Date Range */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="flex items-center gap-2 shrink-0">
              <Calendar className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="text-[10px] font-bold uppercase text-pos-muted tracking-wider hidden sm:inline">Période :</span>
            </div>
            <DateRangePicker
              startDate={dateRange.start}
              endDate={dateRange.end}
              onChange={(start, end) => setDateRange({ start, end })}
              placeholder="Toute la période..."
              disabled={false}
            />
            {(dateRange.start || dateRange.end) && (
              <button
                type="button"
                onClick={() => setDateRange({ start: null, end: null })}
                className="px-2.5 py-1.5 rounded-lg text-[10px] font-bold text-pos-muted hover:text-rose-400 bg-pos-bg border border-pos-border hover:bg-pos-hover transition cursor-pointer shrink-0"
              >
                <X className="w-3 h-3 mr-1" /> Effacer
              </button>
            )}
          </div>

          {/* Secondary Filters Row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* User Filter */}
            <div className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <select
                value={selectedUser}
                onChange={(e) => setSelectedUser(e.target.value)}
                aria-label="Filtrer par caissier"
                className="flex-1 bg-pos-bg border border-pos-border rounded-xl px-2.5 py-1.5 text-xs text-pos-text focus:outline-none focus:border-amber-400 cursor-pointer"
              >
                <option value="all">Tous les Caissiers ({securityAuditLog.length})</option>
                {uniqueUsers.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>

            {/* Multi-select Category Filter */}
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-blue-400 shrink-0" />
              <MultiSelect
                options={categoryOptionsWithCounts}
                selected={selectedCategories}
                onChange={setSelectedCategories}
                placeholder={`Catégories (${categoryOptionsWithCounts.length})`}
                disabled={false}
              />
            </div>

            {/* Search */}
            <div className="relative flex-1 min-w-0">
              <Search className="w-3.5 h-3.5 text-pos-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Rechercher utilisateur, action, motif, ID entité..."
                className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-8 py-1.5 text-xs text-pos-text placeholder-pos-muted focus:outline-none focus:border-amber-400"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-[10px] px-1 rounded cursor-pointer"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Export Actions Row */}
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-pos-border/50">
            <div className="flex items-center gap-1.5 text-[10px] text-pos-muted shrink-0">
              <span className="flex items-center gap-1">
                <Monitor className="w-3 h-3" /> Terminal: <span className="font-mono text-pos-text">{deviceInfo.deviceId}</span>
              </span>
              <span className="flex items-center gap-1 ml-4">
                <Wifi className="w-3 h-3" /> IP: <span className="font-mono text-pos-text">{deviceInfo.ipAddress}</span>
              </span>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <button
                onClick={handleExportPDF}
                disabled={isExporting !== null || filteredLogs.length === 0}
                className="px-3 py-1.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Export PDF/A-3 signé (Conformité PAdES) - Preuve légale non-répudiation"
              >
                <FileText className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Export PDF/A-3</span>
              </button>
              <button
                onClick={handleExportExcel}
                disabled={isExporting !== null || filteredLogs.length === 0}
                className="px-3 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Export Excel avancé (ExcelJS) - Feuille protégée, filtres, types natifs"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Export Excel</span>
              </button>
            </div>
          </div>
        </div>

        {/* Audit Log Body */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3">
          {filteredLogs.length === 0 ? (
            <div className="p-10 text-center text-pos-muted text-xs bg-pos-card border border-pos-border rounded-2xl flex flex-col items-center justify-center gap-2">
              <ShieldAlert className="w-8 h-8 text-pos-muted/50" />
              <span>
                {securityAuditLog.length === 0
                  ? 'Aucune action sensible enregistrée pour le moment.'
                  : 'Aucun enregistrement ne correspond aux critères de recherche actuels.'}
              </span>
              {(searchQuery || selectedUser !== 'all' || selectedCategories.length > 0 || dateRange.start || dateRange.end) && (
                <button
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedUser('all');
                    setSelectedCategories([]);
                    setDateRange({ start: null, end: null });
                  }}
                  className="mt-2 text-amber-400 hover:underline text-xs flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCcw className="w-3 h-3" /> Réinitialiser tous les filtres
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Mobile Card List (md:hidden) */}
              <div className="md:hidden space-y-2.5">
                {filteredLogs.map((log) => {
                  const isExpanded = expandedLog === log.id;
                  const category = getActionCategory(log.action);
                  return (
                    <div
                      key={log.id}
                      className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-2"
                      onClick={() => setExpandedLog(isExpanded ? null : log.id)}
                    >
                      <div className="flex items-center justify-between text-[11px] cursor-pointer">
                        <span className="text-pos-muted flex items-center gap-1 font-mono">
                          <Clock className="w-3 h-3 text-amber-400" /> {formatDateTime(log.timestamp)}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {log.requiresPin && (
                            <span className="bg-amber-950/80 text-amber-300 border border-amber-800 px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1">
                              <Lock className="w-3 h-3" /> PIN Validé
                            </span>
                          )}
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 border ${category.color}`}>
                            {category.icon} {category.label}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-xs text-amber-400 truncate pr-2">{log.action}</span>
                        <span className="text-xs font-semibold text-pos-text flex items-center gap-1 shrink-0">
                          <UserCheck className="w-3 h-3 text-emerald-400" /> {log.user}
                        </span>
                      </div>
                      {log.details && (
                        <p className="text-xs text-pos-muted bg-pos-bg/80 p-2 rounded-lg border border-pos-border/50">
                          {makeDetailsClickable(log.details, log.entityIds, log.entityTypes)}
                        </p>
                      )}

                      {isExpanded && (
                        <div className="pt-2 border-t border-pos-border space-y-2 animate-in fade-in">
                          <div className="grid grid-cols-2 gap-2 text-[10px]">
                            <div className="bg-pos-bg p-2 rounded-lg border border-pos-border/50">
                              <span className="text-pos-muted block">Terminal / Device ID</span>
                              <span className="font-mono text-pos-text break-all">{log.deviceId || 'Non enregistré'}</span>
                            </div>
                            <div className="bg-pos-bg p-2 rounded-lg border border-pos-border/50">
                              <span className="text-pos-muted block">Adresse IP</span>
                              <span className="font-mono text-pos-text">{log.ipAddress || 'Non enregistrée'}</span>
                            </div>
                          </div>
                          {log.entityIds.length > 0 && (
                            <div className="bg-emerald-500/10 border border-emerald-500/30 p-2 rounded-lg">
                              <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-1">
                                <Link2 className="w-3 h-3" /> Entités liées détectées :
                              </span>
                              <div className="flex flex-wrap gap-1.5 mt-1">
                                {log.entityIds.map((id, idx) => (
                                  <button
                                    key={`${id}-${idx}`}
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); handleEntityClick(id, log.entityTypes[idx]); }}
                                    className="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded text-[10px] font-mono cursor-pointer hover:bg-emerald-500/30 transition"
                                  >
                                    {id} ({log.entityTypes[idx]})
                                    <ExternalLink className="w-2.5 h-2.5 inline-block ml-0.5" />
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Desktop Table (hidden on mobile) */}
              <div className="hidden md:block rounded-xl border border-pos-border overflow-hidden shadow-sm">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-pos-card text-pos-muted text-[10px] uppercase font-bold border-b border-pos-border sticky top-0 z-10">
                    <tr>
                      <th className="p-3 w-32">Horodatage</th>
                      <th className="p-3 w-40">Utilisateur</th>
                      <th className="p-3 w-36">Catégorie</th>
                      <th className="p-3 w-44">Action</th>
                      <th className="p-3">Détails / Entités</th>
                      <th className="p-3 text-center w-24">PIN</th>
                      <th className="p-3 text-center w-32">Terminal</th>
                      <th className="p-3 text-center w-32">IP</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-pos-border/40 bg-pos-panel/30">
                    {filteredLogs.map((log) => {
                      const category = getActionCategory(log.action);
                      const isExpanded = expandedLog === log.id;
                      return (
                        <>
                          <tr
                            key={log.id}
                            className={`hover:bg-pos-hover/50 transition cursor-pointer ${isExpanded ? 'bg-amber-500/5' : ''}`}
                            onClick={() => setExpandedLog(isExpanded ? null : log.id)}
                          >
                            <td className="p-3 text-pos-muted font-mono whitespace-nowrap">
                              <span className="flex items-center gap-1.5">
                                <Clock className="w-3 h-3 text-amber-400 shrink-0" />
                                {formatDateTime(log.timestamp)}
                              </span>
                            </td>
                            <td className="p-3 font-semibold text-pos-text whitespace-nowrap">
                              <span className="flex items-center gap-1.5">
                                <UserCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                {log.user}
                              </span>
                            </td>
                            <td className="p-3">
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${category.color}`}>
                                {category.icon} {category.label}
                              </span>
                            </td>
                            <td className="p-3 font-bold text-amber-400 truncate max-w-[160px]">{log.action}</td>
                            <td className="p-3 text-pos-muted leading-relaxed max-w-[280px]">
                              {makeDetailsClickable(log.details, log.entityIds, log.entityTypes)}
                            </td>
                            <td className="p-3 text-center">
                              {log.requiresPin ? (
                                <span className="bg-amber-950/70 text-amber-300 border border-amber-800/80 px-2 py-0.5 rounded text-[10px] font-bold inline-flex items-center justify-center gap-1">
                                  <Lock className="w-3 h-3" /> PIN Validé
                                </span>
                              ) : (
                                <span className="text-pos-muted text-[10px]">Standard</span>
                              )}
                            </td>
                            <td className="p-3 text-center font-mono text-[10px] text-pos-muted">
                              {log.deviceId || <span className="text-pos-muted/50">—</span>}
                            </td>
                            <td className="p-3 text-center font-mono text-[10px] text-pos-muted">
                              {log.ipAddress || <span className="text-pos-muted/50">—</span>}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-amber-500/5 animate-in fade-in">
                              <td colSpan={8} className="p-4 bg-pos-bg/50 border-t border-pos-border">
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-[11px]">
                                  <div className="bg-pos-bg p-3 rounded-lg border border-pos-border/50">
                                    <span className="text-pos-muted block mb-1 flex items-center gap-1">
                                      <Monitor className="w-3.5 h-3.5" /> Terminal / Device ID
                                    </span>
                                    <span className="font-mono text-pos-text break-all text-sm">{log.deviceId || 'Non enregistré'}</span>
                                  </div>
                                  <div className="bg-pos-bg p-3 rounded-lg border border-pos-border/50">
                                    <span className="text-pos-muted block mb-1 flex items-center gap-1">
                                      <Wifi className="w-3.5 h-3.5" /> Adresse IP
                                    </span>
                                    <span className="font-mono text-pos-text text-sm">{log.ipAddress || 'Non enregistrée'}</span>
                                  </div>
                                  <div className="bg-pos-bg p-3 rounded-lg border border-pos-border/50">
                                    <span className="text-pos-muted block mb-1">ID d'Audit</span>
                                    <span className="font-mono text-pos-text break-all text-sm">{log.id}</span>
                                  </div>
                                  <div className="bg-pos-bg p-3 rounded-lg border border-pos-border/50">
                                    <span className="text-pos-muted block mb-1">Horodatage ISO</span>
                                    <span className="font-mono text-pos-text text-sm">{log.timestamp}</span>
                                  </div>
                                </div>
                                {log.entityIds.length > 0 && (
                                  <div className="mt-3 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                                    <div className="flex items-center gap-2 mb-2">
                                      <Link2 className="w-4 h-4 text-emerald-400" />
                                      <span className="text-sm font-bold text-emerald-400">Entités liées détectées (cliquables pour navigation) :</span>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      {log.entityIds.map((id, idx) => (
                                        <button
                                          key={`${id}-${idx}`}
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); handleEntityClick(id, log.entityTypes[idx]); }}
                                          className="px-3 py-1.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded-lg text-[11px] font-mono cursor-pointer hover:bg-emerald-500/30 transition flex items-center gap-1.5"
                                        >
                                          {id}
                                          <span className="text-[10px] text-emerald-400/80">({log.entityTypes[idx]})</span>
                                          <ExternalLink className="w-3 h-3" />
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-2 text-xs text-pos-muted shrink-0">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="truncate max-w-[320px] sm:max-w-none">
                Journal Cryptographiquement Horodaté • {filteredLogs.length} sur {securityAuditLog.length} enregistrements affichés
              </span>
            </span>
            {selectedCategories.length > 0 && (
              <span className="bg-blue-500/15 text-blue-300 px-2 py-0.5 rounded text-[10px] font-bold border border-blue-500/30">
                {selectedCategories.length} catégorie(s) active(s)
              </span>
            )}
            {(dateRange.start || dateRange.end) && (
              <span className="bg-amber-500/15 text-amber-300 px-2 py-0.5 rounded text-[10px] font-bold border border-amber-500/30">
                Filtré par période
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
      </div>
    </div>
  );
};
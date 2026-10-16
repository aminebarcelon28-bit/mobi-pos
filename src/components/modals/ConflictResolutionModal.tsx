import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  X,
  CheckCircle2,
  GitCompare,
  RefreshCw,
  Server,
  Layers,
  Check,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { isTauriEnv } from '../../utils/platform';
import { getLocalDb } from '../../db/sqlPluginAdapter';
import {
  listSyncConflicts,
  resolveSyncConflict,
  resolveAllSyncConflicts,
  type SyncConflictRecord,
} from '../../sync/conflictWatch';
import { useToast } from '../ui/Toast';
import { formatDateTime } from '../../types/pos';
import { Kbd } from '../../design-system/desktop/Kbd';

export const ConflictResolutionModal: React.FC = () => {
  const { activeModal, closeModal } = usePosStore();
  const { showToast } = useToast();

  const [conflicts, setConflicts] = useState<SyncConflictRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [includeResolved, setIncludeResolved] = useState<boolean>(false);
  const [tableFilter, setTableFilter] = useState<string>('all');
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const fetchConflicts = useCallback(async () => {
    try {
      if (isTauriEnv()) {
        const db = await getLocalDb();
        const list = await listSyncConflicts(db, includeResolved);
        setConflicts(list);
      } else {
        setConflicts([]);
      }
    } catch (err) {
      console.warn('[ConflictResolutionModal] fetch failed:', err);
      showToast('Erreur lors du chargement des conflits de synchronisation.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [includeResolved, showToast]);

  useEffect(() => {
    let cancelled = false;
    if (activeModal === 'conflict_resolution') {
      (async () => {
        try {
          if (isTauriEnv()) {
            const db = await getLocalDb();
            const list = await listSyncConflicts(db, includeResolved);
            if (!cancelled) setConflicts(list);
          } else {
            if (!cancelled) setConflicts([]);
          }
        } catch (err) {
          console.warn('[ConflictResolutionModal] fetch failed:', err);
          if (!cancelled) showToast('Erreur lors du chargement des conflits de synchronisation.', 'error');
        } finally {
          if (!cancelled) setIsLoading(false);
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [activeModal, includeResolved, showToast]);

  // Stacked Escape dismissal
  useEffect(() => {
    if (activeModal !== 'conflict_resolution') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, closeModal]);

  const availableTables = useMemo(() => {
    const set = new Set(conflicts.map((c) => c.table_name));
    return ['all', ...Array.from(set)];
  }, [conflicts]);

  const filteredConflicts = useMemo(() => {
    if (tableFilter === 'all') return conflicts;
    return conflicts.filter((c) => c.table_name === tableFilter);
  }, [conflicts, tableFilter]);

  const unresolvedCount = useMemo(
    () => conflicts.filter((c) => c.resolved === 0).length,
    [conflicts]
  );

  const handleResolveSingle = async (
    conflictId: string,
    choice: 'local' | 'incoming' | 'manual'
  ) => {
    setResolvingId(conflictId);
    try {
      if (isTauriEnv()) {
        const db = await getLocalDb();
        const ok = await resolveSyncConflict(db, conflictId, choice);
        if (ok) {
          showToast(`Conflit résolu (version ${choice} validée).`, 'success');
          await fetchConflicts();
        } else {
          showToast('Échec de la résolution du conflit.', 'error');
        }
      }
    } catch (err) {
      console.error('[ConflictResolutionModal] resolve failed:', err);
      showToast('Erreur lors de la résolution du conflit.', 'error');
    } finally {
      setResolvingId(null);
    }
  };

  const handleResolveAll = async () => {
    setIsLoading(true);
    try {
      if (isTauriEnv()) {
        const db = await getLocalDb();
        await resolveAllSyncConflicts(db);
        showToast('Tous les conflits ont été résolus avec les gagnants A3 déterministes.', 'success');
        await fetchConflicts();
      }
    } catch (err) {
      console.error('[ConflictResolutionModal] resolveAll failed:', err);
      showToast('Erreur lors de la résolution globale.', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  if (activeModal !== 'conflict_resolution') return null;

  return (
    <div
      onClick={closeModal}
      role="dialog"
      data-testid="conflict-resolution-dialog"
      aria-modal="true"
      aria-label="Résolution des conflits de synchronisation"
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:zoom-in-95 h-[92dvh] sm:h-[85dvh] flex flex-col cursor-default"
      >
        {/* Mobile drag handle */}
        <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" aria-hidden="true" />

        {/* ═══ Header ═══ */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30 shadow-sm shrink-0">
              <GitCompare className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm sm:text-base font-extrabold text-pos-text">
                  CONFLITS DE SYNCHRONISATION
                </h2>
                {unresolvedCount > 0 ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse">
                    {unresolvedCount} actif{unresolvedCount > 1 ? 's' : ''}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                    <Check className="w-3 h-3" /> Zéro conflit
                  </span>
                )}
              </div>
              <p className="text-[10px] text-pos-muted">
                Arbitrage des divergences d'édition simultanée multi-postes (Protocole Causal A3)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { setIsLoading(true); void fetchConflicts(); }}
              disabled={isLoading}
              aria-label="Actualiser la liste des conflits"
              className="min-h-[44px] px-3 py-2 rounded-lg bg-pos-hover hover:bg-pos-border text-pos-text font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Actualiser</span>
            </button>
            <span className="hidden sm:inline-flex">
              <Kbd size="sm">Esc</Kbd>
            </span>
            <button
              onClick={closeModal}
              aria-label="Fermer"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ═══ Toolbar & Filters ═══ */}
        <div className="p-3 bg-pos-card/50 border-b border-pos-border flex items-center justify-between gap-3 flex-wrap text-xs shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold text-pos-muted uppercase">Filtrer par table :</span>
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              {availableTables.map((t) => (
                <button
                  key={t}
                  onClick={() => setTableFilter(t)}
                  className={`px-2.5 py-1 min-h-[36px] rounded-lg text-xs font-bold transition cursor-pointer ${
                    tableFilter === t
                      ? 'bg-amber-500 text-slate-950 shadow-sm'
                      : 'bg-pos-card text-pos-muted hover:text-pos-text border border-pos-border'
                  }`}
                >
                  {t === 'all' ? 'Toutes' : t}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-[11px] text-pos-muted cursor-pointer">
              <input
                type="checkbox"
                checked={includeResolved}
                onChange={(e) => setIncludeResolved(e.target.checked)}
                className="rounded border-pos-border text-amber-500 focus:ring-amber-400"
              />
              Afficher les conflits résolus
            </label>

            {unresolvedCount > 1 && (
              <button
                onClick={() => void handleResolveAll()}
                disabled={isLoading}
                className="px-3 py-1.5 min-h-[36px] bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold rounded-lg shadow-sm transition flex items-center gap-1.5 cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" /> Tout Valider (Gagnants A3)
              </button>
            )}
          </div>
        </div>

        {/* ═══ Content List ═══ */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 overscroll-contain">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-48 space-y-2 text-pos-muted">
              <RefreshCw className="w-6 h-6 animate-spin text-amber-400" />
              <p className="text-xs">Chargement des divergences de synchronisation...</p>
            </div>
          ) : filteredConflicts.length === 0 ? (
            <div className="bg-pos-card border border-pos-border rounded-xl p-10 text-center space-y-3 max-w-md mx-auto my-12 shadow-sm">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto border border-emerald-500/30">
                <CheckCircle2 className="w-6 h-6 stroke-[2.5]" />
              </div>
              <h3 className="text-sm font-bold text-pos-text">Aucun Conflit Détecté</h3>
              <p className="text-xs text-pos-muted">
                Vos bases de données locale et distante sont synchronisées sans divergence d'édition non résolue.
              </p>
            </div>
          ) : (
            filteredConflicts.map((c) => {
              const isResolved = c.resolved === 1;
              const isBusy = resolvingId === c.id;

              return (
                <div
                  key={c.id}
                  className={`bg-pos-card border rounded-xl p-4 shadow-sm transition space-y-3 ${
                    isResolved
                      ? 'border-pos-border/60 opacity-60'
                      : 'border-amber-500/40 hover:border-amber-500'
                  }`}
                >
                  {/* Top Bar: Table, ID, Status, Timestamp */}
                  <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[11px]">
                        {c.table_name}
                      </span>
                      <span className="font-mono text-pos-text font-bold">
                        #{c.row_id}
                      </span>
                      {isResolved ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                          Résolu
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                          En attente d'arbitrage
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-pos-muted">
                      Détecté le : {formatDateTime(c.detected_at)}
                    </span>
                  </div>

                  {/* Diff Cards: Local vs Incoming */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Local Card */}
                    <div
                      className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                        c.winner === 'local'
                          ? 'bg-emerald-500/5 border-emerald-500/40'
                          : 'bg-pos-bg border-pos-border'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase text-pos-muted flex items-center gap-1">
                          <Layers className="w-3 h-3 text-sky-400" /> Version Locale
                        </span>
                        {c.winner === 'local' && (
                          <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                            Gagnant Tiebreak
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-[11px] font-mono">
                        <span className="text-pos-muted">Version : v{c.local_version}</span>
                        <span className="text-pos-muted truncate max-w-[140px]" title={c.local_device}>
                          Appareil : {c.local_device || 'local'}
                        </span>
                      </div>
                      <p className="text-[10px] text-pos-muted font-mono truncate" title={c.local_fp}>
                        Empreinte : {c.local_fp.slice(0, 16)}...
                      </p>
                    </div>

                    {/* Incoming Card */}
                    <div
                      className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                        c.winner === 'incoming'
                          ? 'bg-emerald-500/5 border-emerald-500/40'
                          : 'bg-pos-bg border-pos-border'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase text-pos-muted flex items-center gap-1">
                          <Server className="w-3 h-3 text-amber-400" /> Version Distante (Cloud)
                        </span>
                        {c.winner === 'incoming' && (
                          <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                            Gagnant Tiebreak
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-[11px] font-mono">
                        <span className="text-pos-muted">Version : v{c.incoming_version}</span>
                        <span className="text-pos-muted truncate max-w-[140px]" title={c.incoming_device}>
                          Appareil : {c.incoming_device || 'distant'}
                        </span>
                      </div>
                      <p className="text-[10px] text-pos-muted font-mono truncate" title={c.incoming_fp}>
                        Empreinte : {c.incoming_fp.slice(0, 16)}...
                      </p>
                    </div>
                  </div>

                  {/* Note / Explanation */}
                  {c.note && (
                    <div className="text-[11px] text-pos-muted bg-pos-bg p-2 rounded-lg border border-pos-border/60">
                      <strong>Note d'arbitrage :</strong> {c.note}
                    </div>
                  )}

                  {/* Action Buttons (when unresolved) */}
                  {!isResolved && (
                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-pos-border/60 flex-wrap">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleResolveSingle(c.id, 'local')}
                        className="px-3 py-1.5 min-h-[36px] bg-pos-hover hover:bg-pos-border text-pos-text text-xs font-bold rounded-lg border border-pos-border transition cursor-pointer"
                      >
                        Conserver Version Locale
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleResolveSingle(c.id, 'incoming')}
                        className="px-3 py-1.5 min-h-[36px] bg-pos-hover hover:bg-pos-border text-pos-text text-xs font-bold rounded-lg border border-pos-border transition cursor-pointer"
                      >
                        Appliquer Version Distante
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleResolveSingle(c.id, 'manual')}
                        className="px-4 py-1.5 min-h-[36px] bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black rounded-lg shadow-sm transition flex items-center gap-1 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" /> Valider Gagnant ({c.winner})
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* ═══ Footer ═══ */}
        <div className="p-3 sm:p-4 border-t border-pos-border bg-pos-card flex items-center justify-between text-xs text-pos-muted shrink-0">
          <span>
            {unresolvedCount > 0 ? (
              <strong className="text-amber-400">{unresolvedCount} divergence(s) active(s)</strong>
            ) : (
              'Synchronisation stable • Toutes les versions sont harmonisées'
            )}
          </span>
          <button
            onClick={closeModal}
            className="px-5 py-2.5 rounded-lg bg-pos-hover hover:bg-pos-border text-pos-text font-bold min-h-[44px] flex items-center justify-center active-press cursor-pointer"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};


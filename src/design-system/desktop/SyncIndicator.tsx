import React from 'react';
import { Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { useSyncStatus } from '../../hooks/useSyncStatus';
import { usePosStore } from '../../store/usePosStore';

export interface SyncIndicatorProps {
  onOpenDiagnostics?: () => void;
  className?: string;
}

/**
 * Enterprise sync indicator adhering to fail-closed policy (AGENTS.md).
 * Calm, transparent state feedback benchmarked against Linear and Stripe.
 */
export const SyncIndicator: React.FC<SyncIndicatorProps> = ({
  onOpenDiagnostics,
  className = '',
}) => {
  const sync = useSyncStatus();
  const failedCount = sync.failedCount ?? 0;
  const outboxPendingCount = usePosStore((s) => s.outboxPendingCount);

  const isSyncing = sync.pushing || sync.pulling;
  const isOffline = !sync.online;
  const hasError = failedCount > 0;
  const hasPending = sync.pendingCount > 0 || outboxPendingCount > 0;

  // Visible text for WCAG 2.5.3 Label-in-Name compliance
  const visibleLabel = isOffline
    ? 'Hors ligne'
    : isSyncing
    ? 'Synchronisation'
    : hasError
    ? `${failedCount} en échec`
    : hasPending
    ? `${sync.pendingCount || outboxPendingCount} en attente`
    : sync.relayConnected
    ? 'En ligne (Relay)'
    : 'En ligne';

  const dotColor = isOffline
    ? 'bg-fg-muted'
    : hasError
    ? 'bg-status-danger-fg animate-pulse'
    : hasPending
    ? 'bg-status-warn-fg animate-pulse'
    : isSyncing
    ? 'bg-pos-accent animate-pulse'
    : 'bg-status-ok-fg';

  const containerBorder = hasError
    ? 'border-status-danger-border/40 hover:border-status-danger-border'
    : hasPending
    ? 'border-status-warn-border/40 hover:border-status-warn-border'
    : 'border-line-subtle hover:border-line';

  return (
    <button
      type="button"
      onClick={onOpenDiagnostics}
      aria-label={`${visibleLabel} — État de la synchronisation cloud`}
      title={
        isOffline
          ? 'Hors ligne — Ventes et encaissements enregistrés en sécurité sur le disque local.'
          : hasError
          ? `${failedCount} transaction(s) en quarantaine. Cliquez pour inspecter.`
          : hasPending
          ? `${sync.pendingCount || outboxPendingCount} transaction(s) en file d'attente locale.`
          : 'Système connecté et synchronisé en temps réel.'
      }
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-ui-sm bg-surface-card border ${containerBorder} text-ui-xs font-medium text-fg-secondary transition-all cursor-pointer select-none active:scale-[0.98] ${className}`}
    >
      {isOffline ? (
        <CloudOff className="w-3.5 h-3.5 text-fg-muted shrink-0" aria-hidden="true" />
      ) : isSyncing ? (
        <RefreshCw className="w-3.5 h-3.5 text-pos-accent animate-spin shrink-0" aria-hidden="true" />
      ) : (
        <Cloud className="w-3.5 h-3.5 text-fg-muted shrink-0" aria-hidden="true" />
      )}
      <span className="font-mono text-ui-2xs num">{visibleLabel}</span>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} aria-hidden="true" />
    </button>
  );
};


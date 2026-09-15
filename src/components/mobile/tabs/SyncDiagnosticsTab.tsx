import React, { useState, useEffect } from 'react';
import {
  RefreshCw,
  Wifi,
  WifiOff,
  Database,
  Cloud,
  ShieldCheck,
  Layers,
  Radio,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';
import { syncManager } from '../../../sync/SyncManager';
import type { SyncStatus } from '../../../sync/types';
import { usePosStore } from '../../../store/usePosStore';
import { soundEngine } from '../../../utils/audioFeedback';

export const SyncDiagnosticsTab: React.FC = () => {
  const { products, transactions, customers } = usePosStore();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    pushing: false,
    pulling: false,
    pendingCount: 0,
    failedCount: 0,
    relayConnected: false,
    lastPushAt: null,
    lastPullAt: null,
    lastError: null,
    quotaExceeded: false,
  });

  const [isManualSyncing, setIsManualSyncing] = useState(false);
  const [isRetryingQuarantined, setIsRetryingQuarantined] = useState(false);
  const [manualSyncMsg, setManualSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    const unsub = syncManager.subscribe((s) => {
      setSyncStatus(s);
    });
    return unsub;
  }, []);

  const handleRetryQuarantined = async () => {
    soundEngine.playKeyBeep?.();
    setIsRetryingQuarantined(true);
    try {
      const count = await syncManager.retryQuarantinedOutbox();
      soundEngine.playSuccess?.();
      setManualSyncMsg(`${count} mutation(s) réactivée(s) et en cours d'envoi.`);
      setTimeout(() => setManualSyncMsg(null), 4000);
    } catch {
      soundEngine.playError?.();
      setManualSyncMsg('Erreur lors de la réactivation des éléments.');
      setTimeout(() => setManualSyncMsg(null), 4000);
    } finally {
      setIsRetryingQuarantined(false);
    }
  };

  const handleManualSync = async () => {
    soundEngine.playKeyBeep?.();
    setIsManualSyncing(true);
    setManualSyncMsg('Synchronisation en cours...');

    try {
      await syncManager.pushOnce();
      const pullRes = await syncManager.pullOnce();
      soundEngine.playSuccess?.();
      setManualSyncMsg(`Synchro réussie (${pullRes} éléments reçus).`);
      setTimeout(() => setManualSyncMsg(null), 4000);
    } catch (err: unknown) {
      console.warn('Manual sync failed:', err);
      soundEngine.playError?.();
      setManualSyncMsg('Erreur de synchronisation. Vérifiez la connexion Internet.');
      setTimeout(() => setManualSyncMsg(null), 4000);
    } finally {
      setIsManualSyncing(false);
    }
  };

  const isSyncing = syncStatus.pushing || syncStatus.pulling || isManualSyncing;

  return (
    <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5 pb-24 select-none">
      {/* Cloud Status Card */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                syncStatus.online
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                  : 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
              }`}
            >
              {syncStatus.online ? <Wifi className="w-5 h-5" /> : <WifiOff className="w-5 h-5" />}
            </div>
            <div>
              <h3 className="text-xs font-black text-pos-text">
                {syncStatus.online ? 'Connecté au Cloud Turso' : 'Mode Hors-Ligne Actif'}
              </h3>
              <p className="text-[10px] text-pos-muted">
                {syncStatus.online
                  ? 'Réplication temps réel & outbox active'
                  : 'Les ventes sont enregistrées localement (Contrat C2)'}
              </p>
            </div>
          </div>

          <span
            className={`w-3 h-3 rounded-full ${
              syncStatus.online ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'
            }`}
          />
        </div>

        {/* Sync Action Button */}
        <button
          type="button"
          disabled={isSyncing}
          onClick={handleManualSync}
          className="w-full py-2.5 px-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 active:scale-95 text-slate-950 font-black text-xs flex items-center justify-center gap-2 shadow-md transition cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
          <span>{isSyncing ? 'Synchronisation en cours...' : 'Forcer la Synchronisation'}</span>
        </button>

        {manualSyncMsg && (
          <p className="text-[11px] font-bold text-center text-cyan-300 animate-in fade-in">
            {manualSyncMsg}
          </p>
        )}
      </div>

      {/* Sync Metrics Details */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs">
        <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider">
          Métriques de Synchronisation
        </h4>

        <div className="space-y-2">
          <div className="flex justify-between items-center py-1 border-b border-pos-border/40">
            <span className="text-pos-muted flex items-center gap-1.5">
              <Cloud className="w-3.5 h-3.5 text-cyan-400" /> Mutations en attente (Outbox) :
            </span>
            <span className="font-mono font-black text-pos-text">
              {syncStatus.pendingCount}
            </span>
          </div>

          <div className="flex justify-between items-center py-1 border-b border-pos-border/40">
            <span className="text-pos-muted flex items-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5 text-emerald-400" /> Dernier Envoi (Push) :
            </span>
            <span className="font-mono text-pos-text font-medium">
              {syncStatus.lastPushAt
                ? new Date(syncStatus.lastPushAt).toLocaleTimeString('fr-FR')
                : 'Aucun'}
            </span>
          </div>

          <div className="flex justify-between items-center py-1 border-b border-pos-border/40">
            <span className="text-pos-muted flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-purple-400" /> Dernière Réception (Pull) :
            </span>
            <span className="font-mono text-pos-text font-medium">
              {syncStatus.lastPullAt
                ? new Date(syncStatus.lastPullAt).toLocaleTimeString('fr-FR')
                : 'Initial'}
            </span>
          </div>

          <div className="flex justify-between items-center py-1 border-b border-pos-border/40">
            <span className="text-pos-muted flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-cyan-400" /> Relais Temps Réel (Relay DO) :
            </span>
            <span className={`font-mono text-xs font-bold ${syncStatus.relayConnected ? 'text-emerald-400' : 'text-amber-400'}`}>
              {syncStatus.relayConnected ? 'Connecté (WebSocket)' : 'Mode Polling Adaptatif'}
            </span>
          </div>

          <div className="flex justify-between items-center py-1 border-b border-pos-border/40">
            <span className="text-pos-muted flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Contrat C1 Latence :
            </span>
            <span className="font-mono font-bold text-emerald-400">
              ≤ 1.5s p95
            </span>
          </div>
        </div>
      </div>

      {/* Quarantined Outbox Mutations Card (Edge Case 6) */}
      {(syncStatus.failedCount ?? 0) > 0 && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 space-y-3 text-xs">
          <div className="flex items-center gap-2 text-rose-400 font-bold">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{syncStatus.failedCount} mutation(s) en quarantaine (Échecs répétés)</span>
          </div>
          <p className="text-[11px] text-pos-muted">
            Ces opérations ont échoué après 10 tentatives et ont été isolées pour ne pas bloquer les ventes en cours (Protection anti-blocage).
          </p>
          {syncStatus.lastError && (
            <p className="text-[10px] font-mono bg-pos-panel/60 p-2 rounded-lg text-rose-300 break-all border border-rose-500/20">
              {syncStatus.lastError}
            </p>
          )}
          <button
            type="button"
            disabled={isRetryingQuarantined || isSyncing}
            onClick={handleRetryQuarantined}
            className="w-full py-2 px-3 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 active:scale-95 border border-rose-500/40 text-rose-300 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${isRetryingQuarantined ? 'animate-spin' : ''}`} />
            <span>{isRetryingQuarantined ? 'Réactivation en cours...' : 'Réessayer les éléments en quarantaine'}</span>
          </button>
        </div>
      )}

      {/* Local Storage Records Count */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs">
        <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-cyan-400" />
          Base de Données Locale (SQLite)
        </h4>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-pos-panel p-2 rounded-xl border border-pos-border">
            <span className="text-[10px] text-pos-muted font-bold block">Articles</span>
            <span className="font-mono text-sm font-black text-pos-text mt-0.5 block">
              {products?.length || 0}
            </span>
          </div>

          <div className="bg-pos-panel p-2 rounded-xl border border-pos-border">
            <span className="text-[10px] text-pos-muted font-bold block">Ventes</span>
            <span className="font-mono text-sm font-black text-pos-text mt-0.5 block">
              {transactions?.length || 0}
            </span>
          </div>

          <div className="bg-pos-panel p-2 rounded-xl border border-pos-border">
            <span className="text-[10px] text-pos-muted font-bold block">Clients</span>
            <span className="font-mono text-sm font-black text-pos-text mt-0.5 block">
              {customers?.length || 0}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

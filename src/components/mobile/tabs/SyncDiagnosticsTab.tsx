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
import type { SyncStatus, MerchantDevice } from '../../../sync/types';
import { QuotaManager } from '../../../sync/quotaManager';
import { formatBytes, type StorageUsageReport } from '../../../sync/storageReport';
import { usePosStore } from '../../../store/usePosStore';
import { AppTabContent } from '../AppScreenLayout';
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

  // Merchant device registry (ad.md §15): which devices share this store,
  // revoke a lost device, re-admit it. The relay is the registry host.
  const [merchantDevices, setMerchantDevices] = useState<MerchantDevice[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [deviceActionId, setDeviceActionId] = useState<string | null>(null);

  const loadMerchantDevices = async () => {
    setIsLoadingDevices(true);
    try {
      setMerchantDevices(await syncManager.listMerchantDevices());
    } catch {
      setMerchantDevices([]);
    } finally {
      setIsLoadingDevices(false);
    }
  };

  const handleDeviceRevocation = async (deviceId: string, revoked: boolean) => {
    const ok = window.confirm(
      revoked
        ? 'Révoquer cet appareil ? Il ne recevra plus les ventes et ne pourra plus envoyer les siennes, jusqu’à réadmission.'
        : 'Réadmettre cet appareil ? Il reprendra la synchronisation.'
    );
    if (!ok) return;
    setDeviceActionId(deviceId);
    try {
      const done = await syncManager.setDeviceRevoked(deviceId, revoked);
      if (done) {
        soundEngine.playSuccess?.();
        await loadMerchantDevices();
      } else {
        soundEngine.playError?.();
      }
    } finally {
      setDeviceActionId(null);
    }
  };

  // Cloud storage meter (same QuotaManager as desktop settings; read-only).
  const [storageReport, setStorageReport] = useState<StorageUsageReport | null>(null);
  const [isLoadingStorage, setIsLoadingStorage] = useState(false);

  const loadStorageReport = async () => {
    setIsLoadingStorage(true);
    try {
      const rep = await QuotaManager.getStorageUsage();
      setStorageReport(rep);
    } catch {
      setStorageReport(null);
    } finally {
      setIsLoadingStorage(false);
    }
  };

  // P2 crash telemetry: ring buffer written by main.tsx global handlers
  // (window.onerror / unhandledrejection). Read-only here; clearing is
  // explicit and local-only.
  interface CrashReport {
    kind: 'error' | 'unhandledrejection';
    message: string;
    stack: string;
    at: string;
  }

  const readCrashReports = (): CrashReport[] => {
    try {
      const w = window as unknown as Record<string, unknown>;
      const getter = w.__mobipos_getCrashReports as unknown as (() => CrashReport[]) | undefined;
      const reports = typeof getter === 'function' ? getter() : [];
      return Array.isArray(reports) ? reports : [];
    } catch {
      return [];
    }
  };

  const [crashReports, setCrashReports] = useState<CrashReport[]>([]);
  const [crashMsg, setCrashMsg] = useState<string | null>(null);

  // Both-offline double-payout exceptions (payoutWatch): synced audit rows
  // with the shared exception action — one entry per ticket, both devices.
  interface PayoutException {
    id: string;
    details: string;
    timestamp: string;
  }
  const [payoutExceptions, setPayoutExceptions] = useState<PayoutException[]>([]);

  const loadPayoutExceptions = async () => {
    try {
      const { db } = await import('../../../db/database');
      const rows = await db.securityAuditLogs
        .filter((r) => r.action === 'Double Encaissement Suspecté')
        .toArray()
        .catch(() => []);
      setPayoutExceptions(
        (rows ?? []).map((r) => ({ id: String(r.id), details: String(r.details ?? ''), timestamp: String(r.timestamp ?? '') }))
      );
    } catch {
      setPayoutExceptions([]);
    }
  };

  useEffect(() => {
    const unsub = syncManager.subscribe((s) => {
      setSyncStatus(s);
    });
    setCrashReports(readCrashReports());
    void loadStorageReport();
    void loadMerchantDevices();
    void loadPayoutExceptions();
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Full repair synchronization (re-enqueue all + reset cursors + verify).
  const [isFullSyncing, setIsFullSyncing] = useState(false);
  const [fullSyncStep, setFullSyncStep] = useState('');
  const [fullSyncReport, setFullSyncReport] = useState<string | null>(null);

  const handleFullResync = async () => {
    soundEngine.playKeyBeep?.();
    setIsFullSyncing(true);
    setFullSyncReport(null);
    setFullSyncStep('Démarrage…');
    try {
      const { fullResync } = await import('../../../sync/repairResync');
      const { usePosStore } = await import('../../../store/usePosStore');
      const report = await fullResync((p) => {
        setFullSyncStep(p.detail);
      });
      setFullSyncReport(`${report.message} Base cloud : ${report.cloudHost || '—'}.`);
      if (report.ok) soundEngine.playSuccess?.();
      else soundEngine.playError?.();
      await usePosStore.getState().refreshAfterPull().catch(() => {});
      setTimeout(() => setFullSyncReport(null), 12000);
    } catch {
      soundEngine.playError?.();
      setFullSyncReport('Échec de la synchronisation complète.');
      setTimeout(() => setFullSyncReport(null), 8000);
    } finally {
      setIsFullSyncing(false);
      setFullSyncStep('');
    }
  };

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

  const handleCopyCrashReports = async () => {
    soundEngine.playKeyBeep?.();
    try {
      const payload = JSON.stringify(crashReports, null, 2);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const ta = document.createElement('textarea');
        ta.value = payload;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      soundEngine.playSuccess?.();
      setCrashMsg('Rapports copiés — collez-les dans votre message de support.');
      setTimeout(() => setCrashMsg(null), 4000);
    } catch {
      soundEngine.playError?.();
      setCrashMsg('Copie impossible sur cet appareil.');
      setTimeout(() => setCrashMsg(null), 4000);
    }
  };

  const handleClearCrashReports = () => {
    soundEngine.playKeyBeep?.();
    try {
      const w = window as unknown as Record<string, unknown>;
      (w.__mobipos_clearCrashReports as unknown as (() => void) | undefined)?.();
      setCrashReports([]);
      setCrashMsg('Journal des incidents vidé.');
      setTimeout(() => setCrashMsg(null), 4000);
    } catch {
      setCrashMsg('Effacement impossible.');
      setTimeout(() => setCrashMsg(null), 4000);
    }
  };

  const isSyncing = syncStatus.pushing || syncStatus.pulling || isManualSyncing;

  return (
    <AppTabContent contentClassName="p-3.5 select-none">
      <div className="space-y-3.5 pb-2">
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
          className="w-full min-h-[44px] py-2.5 px-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 active:scale-95 text-slate-950 font-black text-xs flex items-center justify-center gap-2 shadow-md transition cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
          <span>{isSyncing ? 'Synchronisation en cours...' : 'Forcer la Synchronisation'}</span>
        </button>

        {/* Full repair: re-enqueue all + reset cursors + verify (missing data). */}
        <button
          type="button"
          disabled={isSyncing || isFullSyncing}
          onClick={() => void handleFullResync()}
          title="Renvoie tout vers le cloud, relit tout et vérifie — quand des informations manquent sur un appareil"
          className="w-full min-h-[44px] py-2.5 px-3 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 active:scale-95 border border-cyan-500/40 text-cyan-200 font-black text-xs flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isFullSyncing ? 'animate-spin' : ''}`} />
          <span>{isFullSyncing ? (fullSyncStep || 'Synchronisation complète…') : 'Synchronisation complète (réparer)'}</span>
        </button>

        {manualSyncMsg && (
          <p className="text-[11px] font-bold text-center text-cyan-300 animate-in fade-in">
            {manualSyncMsg}
          </p>
        )}

        {fullSyncReport && (
          <p className="text-[11px] font-bold text-center text-cyan-200 bg-cyan-500/10 border border-cyan-500/30 rounded-xl p-2 animate-in fade-in">
            {fullSyncReport}
          </p>
        )}
      </div>

      {/* Sync Metrics Details */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs">
        <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider">
          Métriques de Synchronisation
        </h4>

        <div className="space-y-3">
          <div className="py-1 border-b border-pos-border/40">
            <div className="flex justify-between items-center">
              <span className="text-pos-muted flex items-center gap-1.5">
                <Cloud className="w-3.5 h-3.5 text-cyan-400" /> Mutations en attente (Outbox) :
              </span>
              <span className="font-mono font-black text-pos-text">
                {syncStatus.pendingCount}
              </span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
              {syncStatus.pendingCount === 0
                ? 'Tout est envoyé : vos ventes sont à jour dans le cloud. Rien à faire.'
                : 'Ce sont vos ventes conservées sur l’appareil. Elles partiront seules à la prochaine connexion — vous pouvez continuer à vendre.'}
            </p>
          </div>

          <div className="py-1 border-b border-pos-border/40">
            <div className="flex justify-between items-center">
              <span className="text-pos-muted flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 text-emerald-400" /> Dernier Envoi (Push) :
              </span>
              <span className="font-mono text-pos-text font-medium">
                {syncStatus.lastPushAt
                  ? new Date(syncStatus.lastPushAt).toLocaleTimeString('fr-FR')
                  : 'Aucun'}
              </span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
              Heure du dernier envoi de vos ventes vers le cloud.
              {' « Aucun » après une installation est normal — touchez « Forcer la Synchronisation » une fois en ligne.'}
            </p>
          </div>

          <div className="py-1 border-b border-pos-border/40">
            <div className="flex justify-between items-center">
              <span className="text-pos-muted flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-purple-400" /> Dernière Réception (Pull) :
              </span>
              <span className="font-mono text-pos-text font-medium">
                {syncStatus.lastPullAt
                  ? new Date(syncStatus.lastPullAt).toLocaleTimeString('fr-FR')
                  : 'Initial'}
              </span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
              Heure de la dernière réception (catalogue, prix, clients) depuis le cloud vers ce téléphone.
            </p>
          </div>

          <div className="py-1 border-b border-pos-border/40">
            <div className="flex justify-between items-center">
              <span className="text-pos-muted flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5 text-cyan-400" /> Relais Temps Réel (Relay DO) :
              </span>
              <span className={`font-mono text-xs font-bold ${syncStatus.relayConnected ? 'text-emerald-400' : 'text-amber-400'}`}>
                {syncStatus.relayConnected ? 'Connecté (WebSocket)' : 'Mode Polling Adaptatif'}
              </span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
              {syncStatus.relayConnected
                ? 'Les nouveautés de la caisse arrivent ici en direct. Rien à faire.'
                : (syncStatus as { relayLastError?: string }).relayLastError
                  ? `Relay inaccessible (${(syncStatus as { relayLastError?: string }).relayLastError}) — polling adaptatif actif (5 s si activité, 15 s au repos). Déployer le Worker relay (workers/relay) ou définir VITE_RELAY_WS_URL rétablit le temps réel.`
                  : 'Vérification périodique : tout arrive quand même, avec un léger délai. Si cela dure, vérifiez votre connexion.'}
            </p>
          </div>

          <div className="py-1 border-b border-pos-border/40">
            <div className="flex justify-between items-center">
              <span className="text-pos-muted flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Contrat C1 Latence :
              </span>
              <span className="font-mono font-bold text-emerald-400">
                ≤ 1.5s p95 (objectif)
              </span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
              Objectif de conception : une vente saisie sur la caisse apparaît sur ce téléphone en moins de 1,5 seconde (non mesuré en continu).
            </p>
          </div>
        </div>
      </div>

      {/* Cloud Storage Meter (Turso quota — read-only, same source as desktop) */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs">
        <div className="flex items-center justify-between">
          <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-indigo-400" />
            Stockage Cloud Turso
          </h4>
          <button
            type="button"
            onClick={() => void loadStorageReport()}
            disabled={isLoadingStorage}
            className="min-h-[44px] min-w-[44px] py-1 px-2 rounded-lg bg-pos-panel border border-pos-border text-pos-muted font-bold text-[11px] flex items-center gap-1 active:scale-95 transition cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isLoadingStorage ? 'animate-spin' : ''}`} />
            Actualiser
          </button>
        </div>

        {!storageReport || (storageReport.totalBytes === 0 && storageReport.isEstimated) ? (
          <p className="text-[11px] text-pos-muted leading-relaxed">
            {isLoadingStorage
              ? 'Mesure en cours…'
              : 'Non disponible hors-ligne — actualisez après connexion. Votre espace cloud restant s’affiche ici.'}
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex justify-between font-bold text-pos-text">
              <span>
                {formatBytes(storageReport.totalBytes)} utilisés{' '}
                {storageReport.isEstimated && '(estimé)'}
              </span>
              <span className="text-pos-muted font-mono">
                {storageReport.usedPercentage}% / {formatBytes(storageReport.quotaBytes)}
              </span>
            </div>
            <div className="w-full bg-pos-bg rounded-full h-2.5 overflow-hidden border border-pos-border">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  storageReport.usedPercentage > 90
                    ? 'bg-red-500'
                    : storageReport.usedPercentage > 70
                      ? 'bg-amber-500'
                      : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.max(2, storageReport.usedPercentage)}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-pos-muted font-mono">
              <span>Fichier : <span className="text-pos-text font-bold">{formatBytes(storageReport.fileBytes)}</span></span>
              <span>Données : <span className="text-pos-text font-bold">{formatBytes(storageReport.liveBytes)}</span></span>
              <span>Réutilisable : <span className="text-emerald-400 font-bold">{formatBytes(storageReport.freelistBytes)}</span></span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed">
              En clair : « Réutilisable » sera récupéré automatiquement par le cloud.
              Tant que la barre reste verte, rien à faire — au-delà de 70 %, pensez à archiver les anciennes données.
            </p>
            {(storageReport.thresholdLevel === 'WARNING' ||
              storageReport.thresholdLevel === 'CRITICAL' ||
              storageReport.thresholdLevel === 'EXCEEDED') && (
              <p className="text-[11px] font-bold text-amber-300">
                {storageReport.alertMessage} {storageReport.actionRequired}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Quarantined Outbox Mutations Card (Edge Case 6) */}
      {(syncStatus.failedCount ?? 0) > 0 && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 space-y-3 text-xs">
          <div className="flex items-center gap-2 text-rose-400 font-bold">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{syncStatus.failedCount} mutation(s) en quarantaine (Échecs répétés)</span>
          </div>
          <p className="text-[11px] text-pos-muted leading-relaxed">
            Ces opérations ont échoué après 10 tentatives et ont été isolées pour ne pas bloquer les ventes en cours (Protection anti-blocage).
            {' Que faire : touchez « Réessayer » une fois en ligne. Si l’erreur persiste, copiez le message ci-dessous pour le support.'}
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
            className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 active:scale-95 border border-rose-500/40 text-rose-300 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${isRetryingQuarantined ? 'animate-spin' : ''}`} />
            <span>{isRetryingQuarantined ? 'Réactivation en cours...' : 'Réessayer les éléments en quarantaine'}</span>
          </button>
        </div>
      )}

      {/* Merchant Devices (ad.md §15 — registry + revocation) */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs">
        <div className="flex items-center justify-between">
          <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            Appareils du Magasin ({merchantDevices.length})
          </h4>
          <button
            type="button"
            onClick={() => void loadMerchantDevices()}
            disabled={isLoadingDevices}
            className="min-h-[44px] min-w-[44px] py-1.5 px-2.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-bold text-[11px] active:scale-95 transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDevices ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {syncStatus.deviceRevoked && (
          <p className="text-[11px] font-bold text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2">
            Cet appareil a été révoqué — synchronisation suspendue. Les ventes locales restent disponibles.
          </p>
        )}
        {merchantDevices.length === 0 ? (
          <p className="text-[11px] text-pos-muted">
            {isLoadingDevices ? 'Chargement des appareils…' : 'Aucun appareil enregistré (relais injoignable ou aucun appareil connecté).'}
          </p>
        ) : (
          <div className="space-y-2">
            {merchantDevices.map((d) => (
              <div key={d.deviceId} className="bg-pos-panel/60 p-2 rounded-lg border border-pos-border/60 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-bold text-pos-text truncate">
                    {d.deviceName} <span className="font-mono text-pos-muted">· {d.platform}</span>
                  </p>
                  <p className="text-[10px] font-mono text-pos-muted truncate">
                    {d.deviceId.slice(0, 18)}… · vu {new Date(d.lastSeen).toLocaleString('fr-FR')}
                    {d.revoked && <span className="text-rose-300 font-bold"> · RÉVOQUÉ</span>}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={deviceActionId === d.deviceId}
                  onClick={() => void handleDeviceRevocation(d.deviceId, !d.revoked)}
                  className={`min-h-[44px] px-2.5 rounded-lg font-bold text-[11px] active:scale-95 transition cursor-pointer border ${
                    d.revoked
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                      : 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                  }`}
                >
                  {deviceActionId === d.deviceId ? '…' : d.revoked ? 'Réadmettre' : 'Révoquer'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Both-offline double-payout exceptions (payoutWatch convergence) */}
      {payoutExceptions.length > 0 && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 space-y-3 text-xs">
          <div className="flex items-center gap-2 text-rose-400 font-bold">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{payoutExceptions.length} double-paiement(s) suspecté(s) — caisse à contrôler</span>
          </div>
          <p className="text-[11px] text-pos-muted leading-relaxed">
            Le même ticket a été payé en espèces sur deux appareils (souvent pendant une coupure internet).
            Les écritures sont fusionnées, mais la monnaie a pu être rendue deux fois.
          </p>
          <div className="space-y-2">
            {payoutExceptions.slice(0, 5).map((ex) => (
              <div key={ex.id} className="bg-pos-panel/60 p-2 rounded-lg border border-rose-500/20">
                <p className="text-[11px] text-pos-text leading-relaxed">{ex.details}</p>
                <span className="font-mono text-[10px] text-pos-muted">
                  {ex.timestamp ? new Date(ex.timestamp).toLocaleString('fr-FR') : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Crash & Freeze Reports (P2 telemetry — global error/unhandledrejection ring buffer) */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs">
        <div className="flex items-center justify-between">
          <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
            <AlertTriangle className={`w-3.5 h-3.5 ${crashReports.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`} />
            Incidents Appareil ({crashReports.length})
          </h4>
          {crashReports.length > 0 && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCopyCrashReports}
                className="min-h-[44px] min-w-[44px] py-1.5 px-2.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-bold text-[11px] active:scale-95 transition cursor-pointer"
              >
                Copier
              </button>
              <button
                type="button"
                onClick={handleClearCrashReports}
                className="min-h-[44px] min-w-[44px] py-1.5 px-2.5 rounded-lg bg-pos-panel border border-pos-border text-pos-muted font-bold text-[11px] active:scale-95 transition cursor-pointer"
              >
                Effacer
              </button>
            </div>
          )}
        </div>
        {crashReports.length === 0 ? (
          <p className="text-[11px] text-pos-muted">
            Aucun incident capturé sur cet appareil. Les gels et plantages futurs seront enregistrés ici automatiquement.
          </p>
        ) : (
          <div className="space-y-2">
            {crashReports.slice(0, 5).map((report, idx) => (
              <div key={`${report.at}-${idx}`} className="bg-pos-panel/60 p-2 rounded-lg border border-pos-border/60">
                <div className="flex justify-between items-center gap-2">
                  <span className={`font-mono text-[10px] font-bold ${report.kind === 'unhandledrejection' ? 'text-amber-300' : 'text-rose-300'}`}>
                    {report.kind === 'unhandledrejection' ? 'Promesse rejetée' : 'Erreur'}
                  </span>
                  <span className="font-mono text-[10px] text-pos-muted">
                    {new Date(report.at).toLocaleString('fr-FR')}
                  </span>
                </div>
                <p className="text-[10px] font-mono text-pos-text break-all mt-1">{report.message}</p>
              </div>
            ))}
            {crashMsg && (
              <p className="text-[11px] font-bold text-center text-cyan-300">{crashMsg}</p>
            )}
          </div>
        )}
      </div>

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
    </AppTabContent>
  );
};

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
  Activity,
  CheckCircle2,
  Key,
} from 'lucide-react';
import { syncManager } from '../../../sync/SyncManager';
import type { SyncStatus, MerchantDevice } from '../../../sync/types';
import { QuotaManager } from '../../../sync/quotaManager';
import { formatBytes, type StorageUsageReport } from '../../../sync/storageReport';
import { usePosStore } from '../../../store/usePosStore';
import { AppTabContent } from '../AppScreenLayout';
import { soundEngine } from '../../../utils/audioFeedback';
import { testTursoConnection, type ConnectionTestResult } from '../../../sync/tursoClient';
import { getCloudCredentials } from '../../../sync/keychain';
import {
  getCachedDeviceIdentity,
  verifyDeviceIdentityConsistency,
  type NativeDeviceCredentials,
} from '../../../api/device';
import { getStableDeviceId } from '../../../sync/device';

export const SyncDiagnosticsTab: React.FC = () => {
  const {
    products,
    transactions,
    customers,
    outboxPendingCount,
    outboxInFlightCount,
    isSyncing: isDrainSyncing,
    lastDrainAt,
    lastDrainError,
    drainArmed,
    refreshSyncHealth,
  } = usePosStore();

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

  // Turso Cloud Live Ping & latency telemetry
  const [cloudPing, setCloudPing] = useState<ConnectionTestResult | null>(null);
  const [isPingingCloud, setIsPingingCloud] = useState(false);
  const [cloudHost, setCloudHost] = useState<string>('');
  const [lastPingAt, setLastPingAt] = useState<string | null>(null);

  const handleCloudPing = async () => {
    soundEngine.playKeyBeep?.();
    setIsPingingCloud(true);
    try {
      const creds = await getCloudCredentials();
      if (!creds?.url || !creds?.token) {
        setCloudPing({
          ok: false,
          latencyMs: 0,
          isSchemaReady: false,
          appliedVersion: 0,
          missingTables: [],
          error: 'Aucun identifiant cloud configuré sur cet appareil.',
        });
        setCloudHost('');
        soundEngine.playError?.();
        return;
      }
      try {
        const parsed = new URL(creds.url.replace(/^libsql:\/\//, 'https://'));
        setCloudHost(parsed.host);
      } catch {
        setCloudHost(creds.url);
      }
      const res = await testTursoConnection(creds.url, creds.token);
      setCloudPing(res);
      setLastPingAt(new Date().toLocaleTimeString('fr-FR'));
      if (res.ok) soundEngine.playSuccess?.();
      else soundEngine.playError?.();
    } catch (e) {
      soundEngine.playError?.();
      setCloudPing({
        ok: false,
        latencyMs: 0,
        isSchemaReady: false,
        appliedVersion: 0,
        missingTables: [],
        error: e instanceof Error ? e.message : 'Erreur de communication',
      });
    } finally {
      setIsPingingCloud(false);
    }
  };

  // Device identity certificate status (TIER-B cryptographic identity)
  const [nativeIdentity, setNativeIdentity] = useState<NativeDeviceCredentials | null>(null);
  const [isIdentityConsistent, setIsIdentityConsistent] = useState<boolean | null>(null);
  const [authorshipId, setAuthorshipId] = useState<string>('');
  const [isLoadingIdentity, setIsLoadingIdentity] = useState(false);

  const loadDeviceIdentity = async () => {
    setIsLoadingIdentity(true);
    try {
      const [creds, consistent, stableId] = await Promise.all([
        getCachedDeviceIdentity().catch(() => null),
        verifyDeviceIdentityConsistency().catch(() => null),
        getStableDeviceId().catch(() => ''),
      ]);
      setNativeIdentity(creds);
      setIsIdentityConsistent(consistent);
      setAuthorshipId(stableId);
    } catch {
      // Graceful fallback for web/non-Tauri
    } finally {
      setIsLoadingIdentity(false);
    }
  };

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
    void loadDeviceIdentity();
    void handleCloudPing();
    void refreshSyncHealth();
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
                {syncStatus.online ? (
                  <Wifi className="w-5 h-5" aria-hidden="true" />
                ) : (
                  <WifiOff className="w-5 h-5" aria-hidden="true" />
                )}
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

          {/* Sync Action Buttons */}
          <button
            type="button"
            disabled={isSyncing}
            onClick={handleManualSync}
            className="w-full min-h-[44px] py-2.5 px-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 active:scale-95 text-slate-950 font-black text-xs flex items-center justify-center gap-2 shadow-md transition cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} aria-hidden="true" />
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
            <RefreshCw className={`w-4 h-4 ${isFullSyncing ? 'animate-spin' : ''}`} aria-hidden="true" />
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

        {/* Turso Cloud Live Ping Card */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 shadow-sm text-xs">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
              Latence & Ping Cloud Turso
            </h4>
            <button
              type="button"
              disabled={isPingingCloud}
              onClick={() => void handleCloudPing()}
              className="min-h-[44px] min-w-[44px] py-1.5 px-2.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-bold text-[11px] flex items-center gap-1.5 active:scale-95 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isPingingCloud ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>Tester le Ping Cloud</span>
            </button>
          </div>

          {isPingingCloud ? (
            <div className="p-3 bg-pos-panel/60 rounded-xl border border-pos-border flex items-center gap-2 text-cyan-300">
              <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
              <span>Mesure de la latence réseau en cours...</span>
            </div>
          ) : cloudPing ? (
            <div className="space-y-2">
              <div
                className={`p-3 rounded-xl border flex items-center justify-between ${
                  cloudPing.ok
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                }`}
              >
                <div className="flex items-center gap-2">
                  {cloudPing.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
                  )}
                  <div>
                    <span className="font-bold block">
                      {cloudPing.ok ? 'Base Cloud Accessible' : 'Erreur de Connexion'}
                    </span>
                    <span className="text-[10px] opacity-80 block font-mono">
                      {cloudHost ? cloudHost : 'Hôte Turso'}
                    </span>
                  </div>
                </div>

                {cloudPing.ok && (
                  <div className="text-right">
                    <span className="font-mono font-black text-sm px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 inline-block">
                      {cloudPing.latencyMs} ms
                    </span>
                    <span className="block text-[9px] text-pos-muted font-bold mt-0.5">
                      {cloudPing.latencyMs < 150
                        ? 'Excellente'
                        : cloudPing.latencyMs < 400
                          ? 'Normale'
                          : 'Élevée'}
                    </span>
                  </div>
                )}
              </div>

              {cloudPing.ok ? (
                <div className="flex justify-between items-center text-[10px] text-pos-muted px-1 font-mono">
                  <span>Schéma base : v{cloudPing.appliedVersion} (Prêt)</span>
                  {lastPingAt && <span>Dernier test à {lastPingAt}</span>}
                </div>
              ) : (
                <p className="text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg p-2 leading-relaxed">
                  {cloudPing.error}
                </p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-pos-muted leading-relaxed">
              Touchez « Tester le Ping Cloud » pour vérifier la connectivité et la latence en millisecondes.
            </p>
          )}
        </div>

        {/* Device Identity Certificate Status (TIER-B Cryptographic Identity) */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 shadow-sm text-xs">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              Certificat & Identité Numérique (Tier B)
            </h4>
            <button
              type="button"
              disabled={isLoadingIdentity}
              onClick={() => void loadDeviceIdentity()}
              className="min-h-[44px] min-w-[44px] py-1 px-2.5 rounded-lg bg-pos-panel border border-pos-border text-pos-muted font-bold text-[11px] flex items-center gap-1 active:scale-95 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${isLoadingIdentity ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>Vérifier l'identité</span>
            </button>
          </div>

          <div className="space-y-2.5">
            {/* Enrollment Status */}
            <div className="bg-pos-panel/60 p-2.5 rounded-xl border border-pos-border flex items-center justify-between">
              <div>
                <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
                  Statut d'Enrôlement
                </span>
                <span className="font-bold text-pos-text text-xs mt-0.5 block">
                  {nativeIdentity?.publicKeyHex ? 'Certifié Ed25519 (Tier B)' : 'Identité Standard (Compagnon)'}
                </span>
              </div>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                  nativeIdentity?.publicKeyHex
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                    : 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                }`}
              >
                {nativeIdentity?.publicKeyHex ? 'Natif Enrôlé' : 'Web / App'}
              </span>
            </div>

            {/* Device ID & Key Fingerprint */}
            <div className="space-y-1.5 bg-pos-bg p-2.5 rounded-xl border border-pos-border text-[11px] font-mono">
              <div className="flex justify-between items-center">
                <span className="text-pos-muted text-[10px]">ID Appareil :</span>
                <span className="text-pos-text font-bold truncate max-w-[200px]" title={authorshipId || nativeIdentity?.deviceId || ''}>
                  {authorshipId || nativeIdentity?.deviceId || 'Non assigné'}
                </span>
              </div>
              {nativeIdentity?.publicKeyHex && (
                <div className="flex justify-between items-center border-t border-pos-border/40 pt-1.5">
                  <span className="text-pos-muted text-[10px]">Clé Publique :</span>
                  <span className="text-emerald-400 font-bold truncate max-w-[200px]" title={nativeIdentity.publicKeyHex}>
                    ed25519:{nativeIdentity.publicKeyHex.slice(0, 16)}…
                  </span>
                </div>
              )}
            </div>

            {/* Consistency verification */}
            {isIdentityConsistent !== null && (
              <div
                className={`p-2 rounded-xl border text-[11px] flex items-center gap-2 ${
                  isIdentityConsistent
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                }`}
              >
                {isIdentityConsistent ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {isIdentityConsistent
                    ? 'Cohérence cryptographique validée (Authorship = Enrôlement natif).'
                    : 'Attention : Mismatch d\'identité détecté (possible clone ou restauration).'}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Sync Metrics Details & Signed Drain Status */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs shadow-sm">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider">
              Métriques de Synchronisation & Drain
            </h4>
            <button
              type="button"
              onClick={() => void refreshSyncHealth()}
              className="min-h-[44px] min-w-[44px] py-1 px-2.5 rounded-lg bg-pos-panel border border-pos-border text-pos-muted font-bold text-[11px] flex items-center gap-1 active:scale-95 transition cursor-pointer"
            >
              <RefreshCw className="w-3 h-3 text-cyan-400" aria-hidden="true" />
              <span>Rafraîchir les métriques</span>
            </button>
          </div>

          <div className="space-y-3">
            {/* Global Outbox */}
            <div className="py-1 border-b border-pos-border/40">
              <div className="flex justify-between items-center">
                <span className="text-pos-muted flex items-center gap-1.5">
                  <Cloud className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" /> Mutations en attente (Outbox) :
                </span>
                <span className="font-mono font-black text-pos-text">
                  {syncStatus.pendingCount}
                </span>
              </div>
              <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
                {syncStatus.pendingCount === 0
                  ? 'Tout est envoyé : vos ventes sont à jour dans le cloud. Rien à faire.'
                  : 'Ce sont vos ventes conservées sur l’appareil. Elles partiront seules à la prochaine connexion.'}
              </p>
            </div>

            {/* Signed Lane Drain Worker Metrics */}
            <div className="py-1 border-b border-pos-border/40 bg-pos-panel/30 p-2.5 rounded-xl border border-pos-border/40 space-y-2">
              <div className="flex justify-between items-center">
                <span className="font-bold text-pos-text flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" /> File Signée (Drain TIER-B) :
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                    drainArmed
                      ? isDrainSyncing
                        ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                        : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : 'bg-pos-panel text-pos-muted border-pos-border'
                  }`}
                >
                  {drainArmed
                    ? isDrainSyncing
                      ? 'En transfert...'
                      : outboxInFlightCount > 0
                        ? 'En vol (Dispatch)'
                        : 'Armé & Au repos'
                    : 'Non armé'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-center pt-1 font-mono text-[11px]">
                <div className="bg-pos-bg p-1.5 rounded-lg border border-pos-border">
                  <span className="text-[10px] text-pos-muted block font-sans">En attente (signé)</span>
                  <span className="font-black text-pos-text">{outboxPendingCount}</span>
                </div>
                <div className="bg-pos-bg p-1.5 rounded-lg border border-pos-border">
                  <span className="text-[10px] text-pos-muted block font-sans">En cours d'envoi</span>
                  <span className="font-black text-cyan-400">{outboxInFlightCount}</span>
                </div>
              </div>

              {lastDrainAt && (
                <div className="flex justify-between text-[10px] text-pos-muted font-mono pt-1">
                  <span>Dernier envoi drainé :</span>
                  <span>{new Date(lastDrainAt).toLocaleTimeString('fr-FR')}</span>
                </div>
              )}

              {lastDrainError && (
                <p className="text-[10px] font-mono text-rose-300 bg-rose-500/10 p-1.5 rounded-lg border border-rose-500/20">
                  {lastDrainError}
                </p>
              )}
            </div>

            {/* Last Push */}
            <div className="py-1 border-b border-pos-border/40">
              <div className="flex justify-between items-center">
                <span className="text-pos-muted flex items-center gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> Dernier Envoi (Push) :
                </span>
                <span className="font-mono text-pos-text font-medium">
                  {syncStatus.lastPushAt
                    ? new Date(syncStatus.lastPushAt).toLocaleTimeString('fr-FR')
                    : 'Aucun'}
                </span>
              </div>
              <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
                Heure du dernier envoi de vos ventes vers le cloud.
              </p>
            </div>

            {/* Last Pull */}
            <div className="py-1 border-b border-pos-border/40">
              <div className="flex justify-between items-center">
                <span className="text-pos-muted flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-purple-400" aria-hidden="true" /> Dernière Réception (Pull) :
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

            {/* Real-time Relay */}
            <div className="py-1 border-b border-pos-border/40">
              <div className="flex justify-between items-center">
                <span className="text-pos-muted flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" /> Relais Temps Réel (Relay DO) :
                </span>
                <span className={`font-mono text-xs font-bold ${syncStatus.relayConnected ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {syncStatus.relayConnected ? 'Connecté (WebSocket)' : 'Mode Polling Adaptatif'}
                </span>
              </div>
              <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
                {syncStatus.relayConnected
                  ? 'Les nouveautés de la caisse arrivent ici en direct. Rien à faire.'
                  : (syncStatus as { relayLastError?: string }).relayLastError
                    ? `Relay inaccessible (${(syncStatus as { relayLastError?: string }).relayLastError}) — polling adaptatif actif.`
                    : 'Vérification périodique : tout arrive quand même, avec un léger délai.'}
              </p>
            </div>

            {/* Latency Objective */}
            <div className="py-1 border-b border-pos-border/40">
              <div className="flex justify-between items-center">
                <span className="text-pos-muted flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> Contrat C1 Latence :
                </span>
                <span className="font-mono font-bold text-emerald-400">
                  ≤ 1.5s p95 (objectif)
                </span>
              </div>
              <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
                Objectif de conception : une vente saisie sur la caisse apparaît sur ce téléphone en moins de 1,5 seconde.
              </p>
            </div>
          </div>
        </div>

        {/* Cloud Storage Meter (Turso quota — read-only) */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs shadow-sm">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
              Stockage Cloud Turso
            </h4>
            <button
              type="button"
              onClick={() => void loadStorageReport()}
              disabled={isLoadingStorage}
              className="min-h-[44px] min-w-[44px] py-1 px-2 rounded-lg bg-pos-panel border border-pos-border text-pos-muted font-bold text-[11px] flex items-center gap-1 active:scale-95 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${isLoadingStorage ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>Actualiser</span>
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
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{syncStatus.failedCount} mutation(s) en quarantaine (Échecs répétés)</span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed">
              Ces opérations ont échoué après 10 tentatives et ont été isolées pour ne pas bloquer les ventes en cours (Protection anti-blocage).
              {' Que faire : touchez « Réessayer » une fois en ligne.'}
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
              <RotateCcw className={`w-3.5 h-3.5 ${isRetryingQuarantined ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{isRetryingQuarantined ? 'Réactivation en cours...' : 'Réessayer les éléments en quarantaine'}</span>
            </button>
          </div>
        )}

        {/* Merchant Devices (ad.md §15 — registry + revocation) */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs shadow-sm">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              Appareils du Magasin ({merchantDevices.length})
            </h4>
            <button
              type="button"
              onClick={() => void loadMerchantDevices()}
              disabled={isLoadingDevices}
              aria-label="Actualiser la liste des appareils"
              className="min-h-[44px] min-w-[44px] py-1.5 px-2.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-bold text-[11px] active:scale-95 transition cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDevices ? 'animate-spin' : ''}`} aria-hidden="true" />
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
                    <span>{deviceActionId === d.deviceId ? '…' : d.revoked ? 'Réadmettre' : 'Révoquer'}</span>
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
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
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

        {/* Crash & Freeze Reports (P2 telemetry) */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs shadow-sm">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
              <AlertTriangle className={`w-3.5 h-3.5 ${crashReports.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`} aria-hidden="true" />
              Incidents Appareil ({crashReports.length})
            </h4>
            {crashReports.length > 0 && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCopyCrashReports}
                  className="min-h-[44px] min-w-[44px] py-1.5 px-2.5 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-bold text-[11px] active:scale-95 transition cursor-pointer"
                >
                  <span>Copier</span>
                </button>
                <button
                  type="button"
                  onClick={handleClearCrashReports}
                  className="min-h-[44px] min-w-[44px] py-1.5 px-2.5 rounded-lg bg-pos-panel border border-pos-border text-pos-muted font-bold text-[11px] active:scale-95 transition cursor-pointer"
                >
                  <span>Effacer</span>
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
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs shadow-sm">
          <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
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

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
  ArrowLeft,
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
import { useTranslation, Bdi } from '../../../i18n';

export interface SyncDiagnosticsTabProps {
  onBack?: () => void;
}

export const SyncDiagnosticsTab: React.FC<SyncDiagnosticsTabProps> = ({ onBack }) => {
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
  const { t, locale } = useTranslation();

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
      const creds = await getCachedDeviceIdentity().catch(() => null);
      const [consistent, stableId] = await Promise.all([
        creds?.publicKeyHex ? verifyDeviceIdentityConsistency().catch(() => null) : Promise.resolve(null),
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
  const [confirmingRevoke, setConfirmingRevoke] = useState<{
    deviceId: string;
    revoked: boolean;
  } | null>(null);

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

  const executeDeviceRevocation = async (deviceId: string, revoked: boolean) => {
    setConfirmingRevoke(null);
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

  // UPGRADE-01: honest transaction total for the summary card — the store
  // carries a bounded 200-row window, so a length display would lie on a
  // mature install.
  const [txnCount, setTxnCount] = useState<number | null>(null);
  const loadTxnCount = async () => {
    try {
      const { sqliteAdapter } = await import('../../../db/sqliteAdapter');
      setTxnCount(await sqliteAdapter.getTransactionsCount());
    } catch (e) {
      console.warn('[diagnostics] transaction count read failed:', e);
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
    void loadTxnCount();
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Full repair synchronization (re-enqueue all + reset cursors + verify).
  const [isFullSyncing, setIsFullSyncing] = useState(false);
  const [confirmingRepair, setConfirmingRepair] = useState(false);
  const [fullSyncStep, setFullSyncStep] = useState('');
  const [fullSyncReport, setFullSyncReport] = useState<string | null>(null);

  const handleFullResync = async () => {
    soundEngine.playKeyBeep?.();
    setConfirmingRepair(false);
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

  const handleBackToManagement = () => {
    soundEngine.playKeyBeep?.();
    onBack?.();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mobi:navigate-tab', { detail: 'management' }));
    }
  };

  return (
    <AppTabContent
      pinnedTop={
        <div className="px-3.5 pt-2.5 pb-2 bg-pos-bg border-b border-pos-border/60 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleBackToManagement}
            className="min-h-[48px] px-3.5 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border text-pos-text font-bold text-xs flex items-center gap-2 active-press transition cursor-pointer shadow-xs"
          >
            <ArrowLeft className="w-4 h-4 text-cyan-700 dark:text-cyan-400 shrink-0 rtl:rotate-180" aria-hidden="true" />
            <span>{locale === 'ar' ? `${t.common.back} — ${t.nav.management}` : 'Retour à Gestion'}</span>
          </button>
          <span className="text-[11px] font-black uppercase tracking-wider text-pos-muted truncate">
            {t.management.systemDiagnosticsCardTitle}
          </span>
        </div>
      }
      contentClassName="p-3.5 select-none"
    >
      <div className="space-y-3.5 pb-2">
        {/* Cloud Status Card */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div
                className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                  syncStatus.online
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                    : 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/30'
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
                  {syncStatus.online ? t.diagnostics.cloudConnectedTitle : t.diagnostics.offlineActiveTitle}
                </h3>
                <p className="text-[10px] text-pos-muted">
                  {syncStatus.online
                    ? t.diagnostics.cloudConnectedSubtitle
                    : t.diagnostics.offlineActiveSubtitle}
                </p>
              </div>
            </div>

            <span
              className={`w-3 h-3 rounded-full shrink-0 ${
                syncStatus.online ? 'bg-emerald-500 dark:bg-emerald-400 animate-pulse' : 'bg-rose-500 dark:bg-rose-400'
              }`}
            />
          </div>

          {/* Sync Action Buttons */}
          <button
            type="button"
            disabled={isSyncing}
            onClick={handleManualSync}
            className="w-full min-h-[48px] py-2.5 px-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 active:scale-95 text-slate-950 font-black text-xs flex items-center justify-center gap-2 shadow-md transition cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 shrink-0 ${isSyncing ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{isSyncing ? t.diagnostics.syncingInProgress : t.diagnostics.forceSyncButton}</span>
          </button>

          {/* Full repair: re-enqueue all + reset cursors + verify (missing data) with inline confirmation */}
          {!confirmingRepair ? (
            <button
              type="button"
              disabled={isSyncing || isFullSyncing}
              onClick={() => {
                soundEngine.playKeyBeep?.();
                setConfirmingRepair(true);
              }}
              title="Renvoie tout vers le cloud, relit tout et vérifie — quand des informations manquent sur un appareil"
              className="w-full min-h-[48px] py-2.5 px-3 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 active:scale-95 border border-cyan-500/40 text-cyan-800 dark:text-cyan-200 font-black text-xs flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 shrink-0 ${isFullSyncing ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{isFullSyncing ? (fullSyncStep || t.diagnostics.syncingInProgress) : t.diagnostics.fullRepairSyncButton}</span>
            </button>
          ) : (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/35 space-y-2.5 animate-in fade-in">
              <p className="text-[11px] font-bold text-amber-800 dark:text-amber-300 leading-relaxed">
                Confirmer la synchronisation complète ? Toutes les écritures locales seront renvoyées et les curseurs de lecture réinitialisés.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingRepair(false)}
                  className="min-h-[48px] px-3 rounded-xl bg-pos-panel border border-pos-border text-pos-text font-bold text-xs cursor-pointer active-press transition"
                >
                  {t.common.cancel}
                </button>
                <button
                  type="button"
                  onClick={() => void handleFullResync()}
                  className="min-h-[48px] px-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs cursor-pointer active-press transition"
                >
                  {locale === 'ar' ? t.common.confirm : 'Confirmer la réparation'}
                </button>
              </div>
            </div>
          )}

          {manualSyncMsg && (
            <p className="text-[11px] font-bold text-center text-cyan-800 dark:text-cyan-300 animate-in fade-in">
              {manualSyncMsg}
            </p>
          )}

          {fullSyncReport && (
            <p className="text-[11px] font-bold text-center text-cyan-900 dark:text-cyan-200 bg-cyan-500/10 border border-cyan-500/30 rounded-xl p-2 animate-in fade-in">
              {fullSyncReport}
            </p>
          )}
        </div>

        {/* Turso Cloud Live Ping Card */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 shadow-sm text-xs">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
              {t.diagnostics.pingCardTitle}
            </h4>
            <button
              type="button"
              disabled={isPingingCloud}
              onClick={() => void handleCloudPing()}
              className="min-h-[48px] min-w-[48px] py-1.5 px-3 rounded-xl bg-cyan-500/15 border border-cyan-500/40 text-cyan-800 dark:text-cyan-300 font-bold text-[11px] flex items-center gap-1.5 active:scale-95 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isPingingCloud ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{t.diagnostics.testPingButton}</span>
            </button>
          </div>

          {isPingingCloud ? (
            <div className="p-3 bg-pos-panel/60 rounded-xl border border-pos-border flex items-center gap-2 text-cyan-800 dark:text-cyan-300">
              <RefreshCw className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
              <span>{t.diagnostics.measuringLatency}</span>
            </div>
          ) : cloudPing ? (
            <div className="space-y-2">
              <div
                className={`p-3 rounded-xl border flex items-center justify-between gap-2 ${
                  cloudPing.ok
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-800 dark:text-rose-300'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {cloudPing.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-rose-700 dark:text-rose-400 shrink-0" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <span className="font-bold block truncate">
                      {cloudPing.ok ? t.diagnostics.cloudReachable : t.diagnostics.connectionError}
                    </span>
                    <Bdi mono className="text-[10px] opacity-80 block truncate">
                      {cloudHost ? cloudHost : 'Hôte Turso'}
                    </Bdi>
                  </div>
                </div>

                {cloudPing.ok && (
                  <div className="text-end shrink-0">
                    <Bdi mono className="font-black text-sm px-2 py-0.5 rounded-md pos-status-ok border inline-block">
                      {cloudPing.latencyMs} ms
                    </Bdi>
                    <span className="block text-[9px] text-pos-muted font-bold mt-0.5">
                      {cloudPing.latencyMs < 150
                        ? t.diagnostics.latencyExcellent
                        : cloudPing.latencyMs < 400
                          ? t.diagnostics.latencyNormal
                          : t.diagnostics.latencyHigh}
                    </span>
                  </div>
                )}
              </div>

              {cloudPing.ok ? (
                <div className="flex justify-between items-center text-[10px] text-pos-muted px-1 font-mono">
                  <span>Schéma base : <Bdi mono>v{cloudPing.appliedVersion}</Bdi> (Prêt)</span>
                  {lastPingAt && <span>Dernier test à <Bdi mono>{lastPingAt}</Bdi></span>}
                </div>
              ) : (
                <p className="text-[11px] text-rose-800 dark:text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg p-2 leading-relaxed">
                  {cloudPing.error}
                </p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-pos-muted leading-relaxed">
              Touchez « {t.diagnostics.testPingButton} » pour vérifier la connectivité et la latence en millisecondes.
            </p>
          )}
        </div>

        {/* Device Identity Certificate Status (TIER-B Cryptographic Identity) */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 shadow-sm text-xs">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
              {t.diagnostics.tierBCertTitle}
            </h4>
            <button
              type="button"
              disabled={isLoadingIdentity}
              onClick={() => void loadDeviceIdentity()}
              className="min-h-[48px] min-w-[48px] py-1.5 px-3 rounded-xl bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text font-bold text-[11px] flex items-center gap-1.5 active:scale-95 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isLoadingIdentity ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{t.diagnostics.verifyIdentityButton}</span>
            </button>
          </div>

          <div className="space-y-2.5">
            {/* Enrollment Status */}
            <div className="bg-pos-panel/60 p-2.5 rounded-xl border border-pos-border flex items-center justify-between">
              <div>
                <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
                  {t.diagnostics.enrollmentStatusLabel}
                </span>
                <span className="font-bold text-pos-text text-xs mt-0.5 block">
                  {nativeIdentity?.publicKeyHex ? t.diagnostics.ed25519Enrolled : t.diagnostics.standardCompanionIdentity}
                </span>
              </div>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                  nativeIdentity?.publicKeyHex
                    ? 'pos-status-ok'
                    : 'pos-status-info'
                }`}
              >
                {nativeIdentity?.publicKeyHex ? t.diagnostics.nativeEnrolledBadge : 'Web / App'}
              </span>
            </div>

            {/* Device ID & Key Fingerprint */}
            <div className="space-y-1.5 bg-pos-bg p-2.5 rounded-xl border border-pos-border text-[11px] font-mono">
              <div className="flex justify-between items-center gap-2">
                <span className="text-pos-muted text-[10px] shrink-0">{t.diagnostics.deviceIdLabel}</span>
                <Bdi mono className="text-pos-text font-bold truncate max-w-[200px]" title={authorshipId || nativeIdentity?.deviceId || ''}>
                  {authorshipId || nativeIdentity?.deviceId || 'Non assigné'}
                </Bdi>
              </div>
              {nativeIdentity?.publicKeyHex && (
                <div className="flex justify-between items-center gap-2 border-t border-pos-border/40 pt-1.5">
                  <span className="text-pos-muted text-[10px] shrink-0">{t.diagnostics.publicKeyLabel}</span>
                  <Bdi mono className="text-emerald-700 dark:text-emerald-400 font-bold truncate max-w-[200px]" title={nativeIdentity.publicKeyHex}>
                    ed25519:{nativeIdentity.publicKeyHex.slice(0, 16)}…
                  </Bdi>
                </div>
              )}
            </div>

            {/* Consistency verification */}
            {isIdentityConsistent !== null && (
              <div
                className={`p-2 rounded-xl border text-[11px] flex items-center gap-2 ${
                  isIdentityConsistent
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
                    : 'bg-amber-500/10 border-amber-500/30 text-amber-800 dark:text-amber-300'
                }`}
              >
                {isIdentityConsistent ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {isIdentityConsistent
                    ? t.diagnostics.cryptoConsistencyOk
                    : t.diagnostics.cryptoConsistencyMismatch}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Sync Metrics Details & Signed Drain Status */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs shadow-sm">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider">
              {t.diagnostics.syncMetricsTitle}
            </h4>
            <button
              type="button"
              onClick={() => void refreshSyncHealth()}
              className="min-h-[48px] min-w-[48px] py-1.5 px-3 rounded-xl bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text font-bold text-[11px] flex items-center gap-1.5 active:scale-95 transition cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5 text-cyan-700 dark:text-cyan-400 shrink-0" aria-hidden="true" />
              <span>{t.diagnostics.refreshMetricsButton}</span>
            </button>
          </div>

          <div className="space-y-3">
            {/* Global Outbox */}
            <div className="py-1 border-b border-pos-border/40">
              <div className="flex justify-between items-center">
                <span className="text-pos-muted flex items-center gap-1.5">
                  <Cloud className="w-3.5 h-3.5 text-cyan-700 dark:text-cyan-400" aria-hidden="true" /> {t.diagnostics.pendingOutboxLabel}
                </span>
                <Bdi mono className="font-black text-pos-text">
                  {syncStatus.pendingCount}
                </Bdi>
              </div>
              <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
                {syncStatus.pendingCount === 0
                  ? 'Tout est envoyé : vos ventes sont à jour dans le cloud. Rien à faire.'
                  : 'Ce sont vos ventes conservées sur l’appareil. Elles partiront seules à la prochaine connexion.'}
              </p>
            </div>

            {/* Signed Lane Drain Worker Metrics */}
            <div className="py-1 border-b border-pos-border/40 bg-pos-panel/30 p-2.5 rounded-xl border border-pos-border/40 space-y-2">
              <div className="flex justify-between items-center gap-2">
                <span className="font-bold text-pos-text flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400" aria-hidden="true" /> {t.diagnostics.signedLaneDrainLabel}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                    drainArmed
                      ? isDrainSyncing
                        ? 'pos-status-info'
                        : 'pos-status-ok'
                      : 'bg-pos-panel text-pos-muted border-pos-border'
                  }`}
                >
                  {drainArmed
                    ? isDrainSyncing
                      ? t.diagnostics.drainTransferring
                      : outboxInFlightCount > 0
                        ? t.diagnostics.drainInFlight
                        : t.diagnostics.drainArmedIdle
                    : t.diagnostics.drainUnarmed}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-center pt-1 font-mono text-[11px]">
                <div className="bg-pos-bg p-1.5 rounded-lg border border-pos-border">
                  <span className="text-[10px] text-pos-muted block font-sans">En attente (signé)</span>
                  <Bdi mono className="font-black text-pos-text">{outboxPendingCount}</Bdi>
                </div>
                <div className="bg-pos-bg p-1.5 rounded-lg border border-pos-border">
                  <span className="text-[10px] text-pos-muted block font-sans">En cours d'envoi</span>
                  <Bdi mono className="font-black text-cyan-700 dark:text-cyan-400">{outboxInFlightCount}</Bdi>
                </div>
              </div>

              {lastDrainAt && (
                <div className="flex justify-between text-[10px] text-pos-muted font-mono pt-1">
                  <span>Dernier envoi drainé :</span>
                  <Bdi mono>{new Date(lastDrainAt).toLocaleTimeString('fr-FR')}</Bdi>
                </div>
              )}

              {lastDrainError && (
                <p className="text-[10px] font-mono text-rose-800 dark:text-rose-300 bg-rose-500/10 p-1.5 rounded-lg border border-rose-500/20">
                  {lastDrainError}
                </p>
              )}
            </div>

            {/* Last Push */}
            <div className="py-1 border-b border-pos-border/40">
              <div className="flex justify-between items-center">
                <span className="text-pos-muted flex items-center gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" /> {t.diagnostics.lastPushLabel}
                </span>
                <Bdi mono className="text-pos-text font-medium">
                  {syncStatus.lastPushAt
                    ? new Date(syncStatus.lastPushAt).toLocaleTimeString('fr-FR')
                    : 'Aucun'}
                </Bdi>
              </div>
              <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
                Heure du dernier envoi de vos ventes vers le cloud.
              </p>
            </div>

            {/* Last Pull */}
            <div className="py-1 border-b border-pos-border/40">
              <div className="flex justify-between items-center">
                <span className="text-pos-muted flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-purple-700 dark:text-purple-400" aria-hidden="true" /> {t.diagnostics.lastPullLabel}
                </span>
                <Bdi mono className="text-pos-text font-medium">
                  {syncStatus.lastPullAt
                    ? new Date(syncStatus.lastPullAt).toLocaleTimeString('fr-FR')
                    : 'Initial'}
                </Bdi>
              </div>
              <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
                Heure de la dernière réception (catalogue, prix, clients) depuis le cloud vers ce téléphone.
              </p>
            </div>

            {/* Real-time Relay */}
            <div className="py-1 border-b border-pos-border/40">
              <div className="flex justify-between items-center">
                <span className="text-pos-muted flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5 text-cyan-700 dark:text-cyan-400" aria-hidden="true" /> {t.diagnostics.realtimeRelayLabel}
                </span>
                <span className={`font-mono text-xs font-bold ${syncStatus.relayConnected ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
                  {syncStatus.relayConnected ? t.diagnostics.relayConnectedWs : t.diagnostics.relayAdaptivePolling}
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
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" /> Contrat C1 Latence :
                </span>
                <Bdi mono className="font-bold text-emerald-700 dark:text-emerald-400">
                  ≤ 1.5s p95 (objectif)
                </Bdi>
              </div>
              <p className="text-[11px] text-pos-muted leading-relaxed mt-1">
                Objectif de conception : une vente saisie sur la caisse apparaît sur ce téléphone en moins de 1,5 seconde.
              </p>
            </div>
          </div>
        </div>

        {/* Cloud Storage Meter (Turso quota — read-only) */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs shadow-sm">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-indigo-700 dark:text-indigo-400" aria-hidden="true" />
              {t.diagnostics.storageCardTitle}
            </h4>
            <button
              type="button"
              onClick={() => void loadStorageReport()}
              disabled={isLoadingStorage}
              className="min-h-[48px] min-w-[48px] py-1.5 px-3 rounded-xl bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text font-bold text-[11px] flex items-center gap-1.5 active:scale-95 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isLoadingStorage ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{t.common.refresh}</span>
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
                  <Bdi mono>{formatBytes(storageReport.totalBytes)}</Bdi> utilisés{' '}
                  {storageReport.isEstimated && '(estimé)'}
                </span>
                <Bdi mono className="text-pos-muted">
                  {storageReport.usedPercentage}% / {formatBytes(storageReport.quotaBytes)}
                </Bdi>
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
                <span>Fichier : <Bdi mono className="text-pos-text font-bold">{formatBytes(storageReport.fileBytes)}</Bdi></span>
                <span>Données : <Bdi mono className="text-pos-text font-bold">{formatBytes(storageReport.liveBytes)}</Bdi></span>
                <span>Réutilisable : <Bdi mono className="text-emerald-700 dark:text-emerald-400 font-bold">{formatBytes(storageReport.freelistBytes)}</Bdi></span>
              </div>
              <p className="text-[11px] text-pos-muted leading-relaxed">
                En clair : « Réutilisable » sera récupéré automatiquement par le cloud.
                Tant que la barre reste verte, rien à faire — au-delà de 70 %, pensez à archiver les anciennes données.
              </p>
              {(storageReport.thresholdLevel === 'WARNING' ||
                storageReport.thresholdLevel === 'CRITICAL' ||
                storageReport.thresholdLevel === 'EXCEEDED') && (
                <p className="text-[11px] font-bold text-amber-800 dark:text-amber-300">
                  {storageReport.alertMessage} {storageReport.actionRequired}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Quarantined Outbox Mutations Card (Edge Case 6) */}
        {(syncStatus.failedCount ?? 0) > 0 && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 space-y-3 text-xs">
            <div className="flex items-center gap-2 text-rose-700 dark:text-rose-400 font-bold">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span><Bdi>{t('diagnostics.quarantinedCardTitle', { count: syncStatus.failedCount ?? 0 })}</Bdi></span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed">
              Ces opérations ont échoué après 10 tentatives et ont été isolées pour ne pas bloquer les ventes en cours (Protection anti-blocage).
              {' Que faire : touchez « Réessayer » une fois en ligne.'}
            </p>
            {syncStatus.lastError && (
              <p className="text-[10px] font-mono bg-pos-panel/60 p-2 rounded-lg text-rose-800 dark:text-rose-300 break-all border border-rose-500/20">
                {syncStatus.lastError}
              </p>
            )}
            <button
              type="button"
              disabled={isRetryingQuarantined || isSyncing}
              onClick={handleRetryQuarantined}
              className="w-full min-h-[48px] py-2 px-3 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 active:scale-95 border border-rose-500/40 text-rose-800 dark:text-rose-300 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
            >
              <RotateCcw className={`w-3.5 h-3.5 shrink-0 ${isRetryingQuarantined ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{isRetryingQuarantined ? 'Réactivation en cours...' : t.diagnostics.retryQuarantinedButton}</span>
            </button>
          </div>
        )}

        {/* Merchant Devices (ad.md §15 — registry + revocation with inline confirmation) */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
              <Bdi>{t('diagnostics.merchantDevicesTitle', { count: merchantDevices.length })}</Bdi>
            </h4>
            <button
              type="button"
              onClick={() => void loadMerchantDevices()}
              disabled={isLoadingDevices}
              aria-label={t.diagnostics.refreshDevicesAria}
              className="min-h-[48px] min-w-[48px] py-1.5 px-3 rounded-xl bg-cyan-500/15 border border-cyan-500/40 text-cyan-800 dark:text-cyan-300 font-bold text-[11px] flex items-center justify-center active:scale-95 transition cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDevices ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
          </div>
          {syncStatus.deviceRevoked && (
            <p className="text-[11px] font-bold text-rose-800 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2">
              {t.diagnostics.thisDeviceRevokedBanner}
            </p>
          )}
          {merchantDevices.length === 0 ? (
            <p className="text-[11px] text-pos-muted">
              {isLoadingDevices ? 'Chargement des appareils…' : 'Aucun appareil enregistré (relais injoignable ou aucun appareil connecté).'}
            </p>
          ) : (
            <div className="space-y-2">
              {merchantDevices.map((d) => {
                const isConfirmingThis = confirmingRevoke?.deviceId === d.deviceId;
                return (
                  <div key={d.deviceId} className="bg-pos-panel/60 p-2.5 rounded-xl border border-pos-border/60 space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-bold text-pos-text truncate">
                          {d.deviceName} <span className="font-mono text-pos-muted">· {d.platform}</span>
                        </p>
                        <p className="text-[10px] font-mono text-pos-muted truncate">
                          <Bdi mono>{d.deviceId.slice(0, 18)}…</Bdi> · vu <Bdi mono>{new Date(d.lastSeen).toLocaleString('fr-FR')}</Bdi>
                          {d.revoked && <span className="text-rose-700 dark:text-rose-300 font-bold"> · RÉVOQUÉ</span>}
                        </p>
                      </div>
                      {!isConfirmingThis && (
                        <button
                          type="button"
                          disabled={deviceActionId === d.deviceId}
                          onClick={() => {
                            soundEngine.playKeyBeep?.();
                            setConfirmingRevoke({ deviceId: d.deviceId, revoked: !d.revoked });
                          }}
                          className={`min-h-[48px] px-3 rounded-xl font-bold text-[11px] active:scale-95 transition cursor-pointer border ${
                            d.revoked
                              ? 'pos-status-ok'
                              : 'pos-status-danger'
                          }`}
                        >
                          <span>{deviceActionId === d.deviceId ? '…' : d.revoked ? t.diagnostics.reinstateButton : t.diagnostics.revokeButton}</span>
                        </button>
                      )}
                    </div>

                    {isConfirmingThis && confirmingRevoke && (
                      <div className="pt-2 border-t border-pos-border/50 space-y-2 animate-in fade-in">
                        <p className="text-[11px] font-bold text-pos-text leading-snug">
                          {confirmingRevoke.revoked
                            ? t.diagnostics.revokeConfirmDescription
                            : 'Réadmettre cet appareil ? Il reprendra la synchronisation.'}
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setConfirmingRevoke(null)}
                            className="min-h-[48px] px-3 rounded-xl bg-pos-card border border-pos-border text-pos-text font-bold text-xs cursor-pointer active-press transition"
                          >
                            {t.common.cancel}
                          </button>
                          <button
                            type="button"
                            onClick={() => void executeDeviceRevocation(d.deviceId, confirmingRevoke.revoked)}
                            className={`min-h-[48px] px-3 rounded-xl font-black text-xs cursor-pointer active-press transition ${
                              confirmingRevoke.revoked
                                ? 'bg-rose-600 hover:bg-rose-500 text-white'
                                : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
                            }`}
                          >
                            {t.common.confirm}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Both-offline double-payout exceptions (payoutWatch convergence) */}
        {payoutExceptions.length > 0 && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 space-y-3 text-xs">
            <div className="flex items-center gap-2 text-rose-700 dark:text-rose-400 font-bold">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span><Bdi>{t('diagnostics.doublePayoutCardTitle', { count: payoutExceptions.length })}</Bdi></span>
            </div>
            <p className="text-[11px] text-pos-muted leading-relaxed">
              Le même ticket a été payé en espèces sur deux appareils (souvent pendant une coupure internet).
              Les écritures sont fusionnées, mais la monnaie a pu être rendue deux fois.
            </p>
            <div className="space-y-2">
              {payoutExceptions.slice(0, 5).map((ex) => (
                <div key={ex.id} className="bg-pos-panel/60 p-2 rounded-lg border border-rose-500/20">
                  <p className="text-[11px] text-pos-text leading-relaxed">{ex.details}</p>
                  <Bdi mono className="text-[10px] text-pos-muted">
                    {ex.timestamp ? new Date(ex.timestamp).toLocaleString('fr-FR') : ''}
                  </Bdi>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Crash & Freeze Reports (P2 telemetry) */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs shadow-sm">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
              <AlertTriangle className={`w-3.5 h-3.5 ${crashReports.length > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}`} aria-hidden="true" />
              <Bdi>{t('diagnostics.crashReportsTitle', { count: crashReports.length })}</Bdi>
            </h4>
            {crashReports.length > 0 && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCopyCrashReports}
                  className="min-h-[48px] min-w-[48px] py-1.5 px-3 rounded-xl bg-cyan-500/15 border border-cyan-500/40 text-cyan-800 dark:text-cyan-300 font-bold text-[11px] active:scale-95 transition cursor-pointer"
                >
                  <span>{t.diagnostics.copyButton}</span>
                </button>
                <button
                  type="button"
                  onClick={handleClearCrashReports}
                  className="min-h-[48px] min-w-[48px] py-1.5 px-3 rounded-xl bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text font-bold text-[11px] active:scale-95 transition cursor-pointer"
                >
                  <span>{t.diagnostics.clearButton}</span>
                </button>
              </div>
            )}
          </div>
          {crashReports.length === 0 ? (
            <p className="text-[11px] text-pos-muted">
              {t.diagnostics.noCrashReports}
            </p>
          ) : (
            <div className="space-y-2">
              {crashReports.slice(0, 5).map((report, idx) => (
                <div key={`${report.at}-${idx}`} className="bg-pos-panel/60 p-2 rounded-lg border border-pos-border/60">
                  <div className="flex justify-between items-center gap-2">
                    <span className={`font-mono text-[10px] font-bold ${report.kind === 'unhandledrejection' ? 'text-amber-800 dark:text-amber-300' : 'text-rose-800 dark:text-rose-300'}`}>
                      {report.kind === 'unhandledrejection' ? 'Promesse rejetée' : 'Erreur'}
                    </span>
                    <Bdi mono className="text-[10px] text-pos-muted">
                      {new Date(report.at).toLocaleString('fr-FR')}
                    </Bdi>
                  </div>
                  <p className="text-[10px] font-mono text-pos-text break-all mt-1">{report.message}</p>
                </div>
              ))}
              {crashMsg && (
                <p className="text-[11px] font-bold text-center text-cyan-800 dark:text-cyan-300">{crashMsg}</p>
              )}
            </div>
          )}
        </div>

        {/* Local Storage Records Count */}
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 text-xs shadow-sm">
          <h4 className="text-[11px] font-black uppercase text-pos-muted tracking-wider flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
            Base de Données Locale (SQLite)
          </h4>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-pos-panel p-2 rounded-xl border border-pos-border">
              <span className="text-[10px] text-pos-muted font-bold block">{t.nav.catalog}</span>
              <Bdi mono className="text-sm font-black text-pos-text mt-0.5 block">
                {products?.length || 0}
              </Bdi>
            </div>

            <div className="bg-pos-panel p-2 rounded-xl border border-pos-border">
              <span className="text-[10px] text-pos-muted font-bold block">
                {locale === 'ar' ? t.activity.validatedSalesKpiLabel : 'Ventes'}
              </span>
              <Bdi mono className="text-sm font-black text-pos-text mt-0.5 block">
                {txnCount ?? (transactions?.length || 0)}
              </Bdi>
            </div>

            <div className="bg-pos-panel p-2 rounded-xl border border-pos-border">
              <span className="text-[10px] text-pos-muted font-bold block">
                {locale === 'ar' ? t.kredy.debtorsLabel : 'Clients'}
              </span>
              <Bdi mono className="text-sm font-black text-pos-text mt-0.5 block">
                {customers?.length || 0}
              </Bdi>
            </div>
          </div>
        </div>
      </div>
    </AppTabContent>
  );
};

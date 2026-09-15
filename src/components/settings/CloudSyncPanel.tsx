// CloudSyncPanel — Settings tab for per-customer Turso cloud sync & migration.
// Handles setup, credentials stored in OS Keychain, storage metering, quota alerts,
// manual sync, integrity verification, log export, and account switching.

import React, { useState, useEffect, useCallback } from 'react';
import {
  Cloud,
  CloudOff,
  RefreshCw,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Eye,
  EyeOff,
  HardDrive,
  Download,
  Key,
  Unplug,
  Activity,
  Smartphone,
} from 'lucide-react';
import { getCloudCredentials, setCloudCredentials, deleteCloudCredentials } from '../../sync/keychain';
import { testTursoConnection, type ConnectionTestResult } from '../../sync/tursoClient';
import { MigrationManager, type MigrationSummary } from '../../sync/migrationManager';
import { RestoreManager, type RestoreProgress } from '../../sync/restoreManager';
import { QuotaManager, type StorageUsageReport } from '../../sync/quotaManager';
import { syncManager } from '../../sync/SyncManager';
import { useSyncStatus } from '../../hooks/useSyncStatus';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';

export const CloudSyncPanel: React.FC = () => {
  const sync = useSyncStatus();
  const { showToast } = useToast();
  const openModal = usePosStore((s) => s.openModal);

  const [dbUrl, setDbUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [hasStoredCreds, setHasStoredCreds] = useState(false);

  // Testing & Migration State
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationStep, setMigrationStep] = useState('');
  const [migrationProgress, setMigrationProgress] = useState(0);
  const [migrationSummary, setMigrationSummary] = useState<MigrationSummary | null>(null);

  // Disaster Recovery / Cloud Restore
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgress | null>(null);

  // Storage & Quota
  const [storageReport, setStorageReport] = useState<StorageUsageReport | null>(null);
  const [isLoadingStorage, setIsLoadingStorage] = useState(false);

  // Integrity Check
  const [isVerifying, setIsVerifying] = useState(false);
  const [integrityReport, setIntegrityReport] = useState<string | null>(null);

  const loadStorageReport = useCallback(async () => {
    setIsLoadingStorage(true);
    try {
      const rep = await QuotaManager.getStorageUsage();
      setStorageReport(rep);
    } catch (err) {
      console.warn('[CloudSyncPanel] Failed loading storage report:', err);
    } finally {
      setIsLoadingStorage(false);
    }
  }, []);

  // Load existing credentials on mount
  useEffect(() => {
    (async () => {
      const creds = await getCloudCredentials();
      if (creds && creds.url && creds.token) {
        setDbUrl(creds.url);
        setAuthToken(creds.token);
        setHasStoredCreds(true);
        void loadStorageReport();
      }
    })();
  }, [loadStorageReport]);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const connectionResult = await testTursoConnection(dbUrl, authToken);
      setTestResult(connectionResult);
      if (connectionResult.ok) {
        showToast(`Connexion établie avec succès (${connectionResult.latencyMs} ms).`, 'success');
      } else {
        showToast(connectionResult.error ?? 'Erreur de connexion', 'error');
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erreur inconnue', 'error');
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveAndMigrate = async () => {
    if (!dbUrl || !authToken) {
      showToast('Veuillez renseigner l\'URL et le jeton d\'authentification.', 'warning');
      return;
    }

    setIsMigrating(true);
    setMigrationProgress(0);
    setMigrationStep('Sauvegarde locale de précaution...');
    try {
      // 1. Save credentials securely to OS Keychain
      await setCloudCredentials(dbUrl, authToken);
      setHasStoredCreds(true);

      // 2. Run first-sync migration with progress
      const summary = await MigrationManager.runFirstSyncMigration((step, current, total) => {
        setMigrationStep(step);
        setMigrationProgress(Math.round((current / total) * 100));
      });

      setMigrationSummary(summary);
      showToast('Migration vers le cloud réussie avec intégrité validée !', 'success');

      // 3. Start sync engine
      await syncManager.start('pos-main');
      await loadStorageReport();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Erreur lors de la migration: ${msg}`, 'error');
    } finally {
      setIsMigrating(false);
    }
  };

  const handleRestoreFromCloud = async () => {
    if (!dbUrl || !authToken) {
      showToast('Veuillez renseigner l\'URL et le jeton d\'authentification pour restaurer.', 'warning');
      return;
    }
    const ok = window.confirm(
      'Restaurer depuis le cloud Turso ?\n\n' +
      'Cette opération va synchroniser l\'ensemble de votre catalogue, clients, dettes, réparations et ventes depuis votre base Turso dédiée.\n' +
      'Une sauvegarde locale automatique sera créée avant toute modification.'
    );
    if (!ok) return;

    setIsRestoring(true);
    setRestoreProgress({ phase: 'Démarrage', table: 'initialisation', processed: 0, total: 10 });
    try {
      await setCloudCredentials(dbUrl, authToken);
      setHasStoredCreds(true);
      const restoreResult = await RestoreManager.restoreFromCloud((p) => {
        setRestoreProgress(p);
      });
      showToast(restoreResult.userSummary, 'success');
      await usePosStore.getState().refreshAfterPull();
      await syncManager.start('pos-main');
      await loadStorageReport();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Erreur de restauration: ${msg}`, 'error');
    } finally {
      setIsRestoring(false);
      setRestoreProgress(null);
    }
  };

  const handleManualSync = async () => {
    if (!sync.online) {
      showToast('Vous êtes hors ligne. Les données seront synchronisées dès la reconnexion.', 'warning');
      return;
    }
    showToast('Synchronisation forcée en cours...', 'info');
    await syncManager.kick();
    await loadStorageReport();
    showToast('Synchronisation terminée.', 'success');
  };

  const handleVerifyIntegrity = async () => {
    setIsVerifying(true);
    setIntegrityReport(null);
    try {
      const integrityResult = await syncManager.verifyCloudIntegrity();
      setIntegrityReport(integrityResult.report);
      if (integrityResult.verified) {
        showToast(integrityResult.report, 'success');
      } else {
        showToast(integrityResult.report, 'warning');
      }
    } catch (e) {
      showToast(`Erreur de vérification: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleExportLogs = () => {
    const logs = syncManager.exportLogs();
    const blob = new Blob([logs], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mobi_pos_sync_logs_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Journal d\'événements exporté avec succès.', 'success');
  };

  const handleDisconnect = async () => {
    const ok = window.confirm(
      'Voulez-vous vraiment déconnecter la synchronisation Cloud ?\n\nToutes vos données locales restent strictement intactes. Vos identifiants seront effacés du trousseau sécurisé de l\'ordinateur.'
    );
    if (!ok) return;

    await deleteCloudCredentials();
    syncManager.stop();
    setHasStoredCreds(false);
    setDbUrl('');
    setAuthToken('');
    setStorageReport(null);
    showToast('Compte Cloud déconnecté. L\'application fonctionne en mode local-seul.', 'info');
  };

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes === 0) return '0 Mo';
    const mb = bytes / (1024 * 1024);
    if (mb < 1) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${mb.toFixed(1)} Mo`;
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto py-2">
      {/* ══════════════════════════════════════════════════════════════ */}
      {/* HEADER BANNER */}
      {/* ══════════════════════════════════════════════════════════════ */}
      <div className="bg-gradient-to-br from-sky-950/40 via-pos-card to-indigo-950/40 border border-sky-500/30 rounded-2xl p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-sky-500/20">
              <Cloud className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-black text-pos-text uppercase tracking-wider">
                  Synchronisation Cloud Turso (libSQL)
                </h3>
                {hasStoredCreds ? (
                  <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold text-xs flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Actif & Sécurisé (Trousseau OS)
                  </span>
                ) : (
                  <span className="px-2.5 py-0.5 rounded-full bg-slate-500/15 border border-slate-500/30 text-slate-300 font-bold text-xs flex items-center gap-1">
                    <CloudOff className="w-3 h-3" />
                    Mode Local Uniquement
                  </span>
                )}
              </div>
              <p className="text-xs text-pos-muted mt-0.5">
                Architecture dédiée par client : zéro serveur partagé, données chiffrées et fonctionnement 100% autonome hors-ligne.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => openModal('cloud_pairing')}
              className="px-3.5 py-1.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-xs font-bold text-cyan-300 flex items-center gap-1.5 transition cursor-pointer shadow-sm"
              title="Télécharger l'application mobile Android / iOS ou appairer un smartphone"
            >
              <Smartphone className="w-3.5 h-3.5 text-cyan-400" />
              App Mobile & Appairage
            </button>
            {hasStoredCreds && (
              <button
                type="button"
                onClick={handleDisconnect}
                className="px-3 py-1.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-xs font-bold text-red-400 flex items-center gap-1.5 transition cursor-pointer"
              >
                <Unplug className="w-3.5 h-3.5" />
                Déconnecter
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* QUOTA WARNING BANNERS */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {storageReport && storageReport.thresholdLevel !== 'OK' && (
        <div
          className={`border rounded-xl p-4 flex items-start gap-3 shadow-md ${
            storageReport.thresholdLevel === 'EXCEEDED' || storageReport.thresholdLevel === 'CRITICAL'
              ? 'bg-red-500/10 border-red-500/40 text-red-300'
              : storageReport.thresholdLevel === 'WARNING'
                ? 'bg-amber-500/10 border-amber-500/40 text-amber-300'
                : 'bg-blue-500/10 border-blue-500/40 text-blue-300'
          }`}
        >
          {storageReport.thresholdLevel === 'EXCEEDED' || storageReport.thresholdLevel === 'CRITICAL' ? (
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          )}
          <div>
            <h4 className="font-bold text-sm">{storageReport.alertMessage}</h4>
            <p className="text-xs mt-1 text-slate-300 leading-relaxed">
              {storageReport.actionRequired}
            </p>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* CREDENTIALS & CONNECTION SETUP */}
      {/* ══════════════════════════════════════════════════════════════ */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-5 space-y-4 shadow-sm">
        <div className="flex items-center justify-between border-b border-pos-border pb-3">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-sky-400" />
            <h4 className="text-sm font-bold text-pos-text uppercase tracking-wider">
              Identifiants de Connexion Turso
            </h4>
          </div>
          <span className="text-[11px] text-pos-muted flex items-center gap-1 font-medium">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            Stockage sécurisé dans le Gestionnaire d'identifiants Windows
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-pos-muted uppercase mb-1.5">
              URL de la Base de Données (Database URL)
            </label>
            <input
              type="text"
              value={dbUrl}
              onChange={(e) => setDbUrl(e.target.value)}
              placeholder="libsql://ma-boutique-db.turso.io"
              className="w-full px-3.5 py-2.5 bg-pos-bg border border-pos-border rounded-xl text-xs text-pos-text font-mono focus:border-sky-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-pos-muted uppercase mb-1.5">
              Jeton d'Authentification (Auth Token)
            </label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="eyJhbGciOiJFZERT..."
                className="w-full px-3.5 py-2.5 bg-pos-bg border border-pos-border rounded-xl text-xs text-pos-text font-mono pr-10 focus:border-sky-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-2.5 text-pos-muted hover:text-pos-text transition cursor-pointer"
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <button
            onClick={handleTestConnection}
            disabled={isTesting || !dbUrl || !authToken}
            className="px-4 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center gap-2 transition cursor-pointer disabled:opacity-50"
          >
            {isTesting ? <RefreshCw className="w-3.5 h-3.5 animate-spin text-sky-400" /> : <Activity className="w-3.5 h-3.5 text-sky-400" />}
            Tester la connexion
          </button>

          <div className="flex items-center gap-2.5">
            <button
              onClick={handleRestoreFromCloud}
              disabled={isRestoring || isMigrating || !dbUrl || !authToken}
              className="px-4 py-2.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 font-bold text-xs flex items-center gap-2 transition cursor-pointer disabled:opacity-50"
              title="Télécharge l'intégralité des données cloud sur ce poste (nouvel ordinateur / remplacement)"
            >
              {isRestoring ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Restaurer depuis le cloud
            </button>

            <button
              onClick={handleSaveAndMigrate}
              disabled={isMigrating || isRestoring || !dbUrl || !authToken}
              className="px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs shadow-lg shadow-sky-600/30 flex items-center gap-2 transition cursor-pointer disabled:opacity-50"
            >
              {isMigrating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {hasStoredCreds ? 'Mettre à jour & Synchroniser' : 'Enregistrer & Activer Cloud Sync'}
            </button>
          </div>
        </div>

        {/* Test Result Feedback */}
        {testResult && (
          <div className={`p-3 rounded-xl border text-xs font-medium flex items-center gap-2 ${
            testResult.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'
          }`}>
            {testResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
            <span>
              {testResult.ok
                ? `Connexion validée en ${testResult.latencyMs} ms. ${testResult.isSchemaReady ? 'Schéma cloud prêt (v' + testResult.appliedVersion + ').' : 'Schéma cloud vierge — la migration appliquera les tables.'}`
                : testResult.error}
            </span>
          </div>
        )}

        {/* Migration in progress bar */}
        {isMigrating && (
          <div className="p-4 bg-sky-950/30 border border-sky-500/30 rounded-xl space-y-2">
            <div className="flex justify-between text-xs font-bold text-sky-300">
              <span>{migrationStep}</span>
              <span>{migrationProgress}%</span>
            </div>
            <div className="w-full bg-pos-bg rounded-full h-2 overflow-hidden">
              <div
                className="bg-sky-500 h-full rounded-full transition-all duration-300"
                style={{ width: `${migrationProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Restore in progress bar */}
        {isRestoring && restoreProgress && (
          <div className="p-4 bg-amber-950/30 border border-amber-500/30 rounded-xl space-y-2">
            <div className="flex justify-between text-xs font-bold text-amber-300">
              <span>{restoreProgress.phase}: {restoreProgress.table}</span>
              <span>Table {restoreProgress.processed} / {restoreProgress.total}</span>
            </div>
            <div className="w-full bg-pos-bg rounded-full h-2 overflow-hidden">
              <div
                className="bg-amber-500 h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.round((restoreProgress.processed / Math.max(1, restoreProgress.total)) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Migration Success Summary */}
        {migrationSummary && (
          <div className="p-3.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 space-y-1">
            <div className="flex items-center gap-1.5 font-bold">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>{migrationSummary.userMessage}</span>
            </div>
            {migrationSummary.backupPath && (
              <p className="text-[11px] text-pos-muted font-mono">
                Sauvegarde de sécurité créée: {migrationSummary.backupPath}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* STORAGE USAGE METER */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {hasStoredCreds && storageReport && (
        <div className="bg-pos-card border border-pos-border rounded-2xl p-5 space-y-4 shadow-sm">
          <div className="flex items-center justify-between border-b border-pos-border pb-3">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-indigo-400" />
              <h4 className="text-sm font-bold text-pos-text uppercase tracking-wider">
                Espace Cloud Utilisé & Quota
              </h4>
            </div>
            <button
              onClick={loadStorageReport}
              disabled={isLoadingStorage}
              className="text-xs text-pos-muted hover:text-pos-text flex items-center gap-1 transition cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${isLoadingStorage ? 'animate-spin' : ''}`} />
              Actualiser
            </button>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs font-bold text-pos-text">
              <span>{formatBytes(storageReport.totalBytes)} utilisés {storageReport.isEstimated && '(estimé)'}</span>
              <span className="text-pos-muted font-mono">{storageReport.usedPercentage}% / {formatBytes(storageReport.quotaBytes)}</span>
            </div>
            <div className="w-full bg-pos-bg rounded-full h-3 overflow-hidden border border-pos-border">
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
          </div>

          {/* Per-table details */}
          {(storageReport.tableBreakdown?.length || 0) > 0 && (
            <div className="mt-3 pt-3 border-t border-pos-border">
              <details className="text-xs text-pos-muted cursor-pointer group">
                <summary className="font-bold hover:text-pos-text select-none">
                  Afficher la répartition détaillée par table ({storageReport.tableBreakdown?.length || 0} tables)
                </summary>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3 pt-2">
                  {(storageReport.tableBreakdown || []).map((t) => (
                    <div key={t.tableName} className="bg-pos-bg p-2 rounded-lg border border-pos-border">
                      <p className="font-mono font-bold text-pos-text truncate">{t.tableName}</p>
                      <p className="text-[11px] text-pos-muted">{formatBytes(t.bytes)}</p>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════ */}
      {/* LIVE SYNC STATUS & AUDIT CONTROLS */}
      {/* ══════════════════════════════════════════════════════════════ */}
      {hasStoredCreds && (
        <div className="bg-pos-card border border-pos-border rounded-2xl p-5 space-y-4 shadow-sm">
          <div className="flex items-center justify-between border-b border-pos-border pb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              <h4 className="text-sm font-bold text-pos-text uppercase tracking-wider">
                État du Moteur & Contrôles
              </h4>
            </div>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${sync.online ? 'bg-emerald-400 animate-pulse' : 'bg-slate-400'}`} />
              <span className="text-xs font-bold font-mono text-pos-text">
                {sync.online ? 'En Ligne' : 'Hors Ligne'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-pos-bg p-3 rounded-xl border border-pos-border">
              <p className="text-[11px] text-pos-muted uppercase font-bold">Dernier Envoi (Push)</p>
              <p className="text-xs font-bold text-pos-text mt-1 font-mono">
                {sync.lastPushAt ? new Date(sync.lastPushAt).toLocaleTimeString('fr-FR') : '—'}
              </p>
            </div>

            <div className="bg-pos-bg p-3 rounded-xl border border-pos-border">
              <p className="text-[11px] text-pos-muted uppercase font-bold">Dernière Réception (Pull)</p>
              <p className="text-xs font-bold text-pos-text mt-1 font-mono">
                {sync.lastPullAt ? new Date(sync.lastPullAt).toLocaleTimeString('fr-FR') : '—'}
              </p>
            </div>

            <div className="bg-pos-bg p-3 rounded-xl border border-pos-border">
              <p className="text-[11px] text-pos-muted uppercase font-bold">Modifications en Attente</p>
              <p className="text-xs font-bold text-amber-400 mt-1 font-mono">
                {sync.pendingCount} enregistrement(s)
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2.5 pt-2">
            <button
              onClick={handleManualSync}
              disabled={sync.pushing || sync.pulling}
              className="px-4 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center gap-2 transition cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-sky-400 ${sync.pushing || sync.pulling ? 'animate-spin' : ''}`} />
              Synchroniser maintenant
            </button>

            <button
              onClick={handleVerifyIntegrity}
              disabled={isVerifying}
              className="px-4 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center gap-2 transition cursor-pointer"
            >
              <ShieldCheck className={`w-3.5 h-3.5 text-emerald-400 ${isVerifying ? 'animate-spin' : ''}`} />
              Vérifier l'intégrité du cloud
            </button>

            <button
              onClick={handleExportLogs}
              className="px-4 py-2 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs font-bold text-pos-text flex items-center gap-2 transition cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-purple-400" />
              Exporter le journal de synchronisation
            </button>
          </div>

          {integrityReport && (
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{integrityReport}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

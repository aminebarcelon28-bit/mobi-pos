import React, { useState, useEffect, useRef } from 'react';
import {
  Database,
  ShieldCheck,
  Zap,
  Shield,
  CheckCircle2,
  HardDrive,
  Cpu,
  RefreshCcw,
  Activity,
  AlertTriangle,
  Download,
  Upload,
  Lock,
  Layers,
  FileCheck,
  Trash2,
  KeyRound,
  FileKey,
} from 'lucide-react';
import {
  maintenanceService,
  type DbStats,
  type IntegrityReport,
} from '../../../services/maintenanceService';
import {
  createDatabaseBackup,
  listDatabaseBackups,
  pruneSnapshots,
  decryptSnapshotForRecovery,
  type DatabaseBackupMeta,
} from '../../../api/backup';
import { verifyManagerGate } from '../../../utils/pinGate';
import { usePosStore } from '../../../store/usePosStore';
import { PinDialog } from '../../PinDialog';

interface BackupSettingsTabProps {
  showToast: (msg: string, type?: 'success' | 'error' | 'info' | 'warning', duration?: number) => void;
  openSecurityTab: () => void;
}

export const BackupSettingsTab: React.FC<BackupSettingsTabProps> = ({
  showToast,
  openSecurityTab,
}) => {
  const { exportDatabase, importDatabase, logSecurityAction, activeCashier } = usePosStore();

  const [dbStats, setDbStats] = useState<DbStats | null>(null);
  const [integrityReport, setIntegrityReport] = useState<IntegrityReport | null>(null);
  const [isCheckingIntegrity, setIsCheckingIntegrity] = useState(false);
  const [isCheckpointing, setIsCheckpointing] = useState(false);
  const [isVacuuming, setIsVacuuming] = useState(false);

  // JSON Export / Import state
  const [showExportPin, setShowExportPin] = useState(false);
  const [restorePinInput, setRestorePinInput] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const [stagedRestore, setStagedRestore] = useState<{
    file: File;
    text: string;
    sha256: string;
    version?: number;
    counts?: Record<string, number>;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Encrypted Snapshots state
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(false);
  const [isCreatingSnapshot, setIsCreatingSnapshot] = useState(false);
  const [snapshotPin, setSnapshotPin] = useState('');
  const [selectedSnapshotForAction, setSelectedSnapshotForAction] = useState<string | null>(null);
  const [showActionPinModal, setShowActionPinModal] = useState<'prune' | 'decrypt' | null>(null);

  const loadDbStats = async () => {
    try {
      const stats = await maintenanceService.getDatabaseStats();
      setDbStats(stats);
    } catch (e) {
      console.error('Failed to load DB stats:', e);
    }
  };

  const loadSnapshotsList = async () => {
    setIsLoadingSnapshots(true);
    try {
      const list = await listDatabaseBackups();
      setSnapshots(list || []);
    } catch {
      // In web browser or mock, might return empty
      setSnapshots([]);
    } finally {
      setIsLoadingSnapshots(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const [stats, list] = await Promise.all([
          maintenanceService.getDatabaseStats().catch(() => null),
          listDatabaseBackups().catch(() => []),
        ]);
        if (!cancelled) {
          if (stats) setDbStats(stats);
          setSnapshots(list || []);
        }
      } catch (err) {
        console.error('Failed to init backup tab:', err);
      }
    };
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRunIntegrityCheck = async () => {
    setIsCheckingIntegrity(true);
    try {
      const rep = await maintenanceService.runDatabaseIntegrityCheck();
      setIntegrityReport(rep);
      if (rep.is_healthy) {
        showToast('Intégrité physique validée : Base 100% saine.', 'success');
      } else {
        showToast('Anomalie d\'intégrité détectée dans les pages SQLite.', 'error');
      }
    } catch {
      showToast('Erreur lors du contrôle d\'intégrité.', 'error');
    } finally {
      setIsCheckingIntegrity(false);
    }
  };

  const handleCheckpointWal = async () => {
    setIsCheckpointing(true);
    try {
      const msg = await maintenanceService.checkpointDatabaseWal();
      showToast(msg || 'Checkpoint WAL (TRUNCATE) exécuté avec succès.', 'success');
      await loadDbStats();
    } catch {
      showToast('Erreur lors du checkpoint WAL.', 'error');
    } finally {
      setIsCheckpointing(false);
    }
  };

  const handleVacuum = async () => {
    setIsVacuuming(true);
    try {
      const msg = await maintenanceService.vacuumDatabase();
      showToast(msg || 'VACUUM exécuté : tables défragmentées et pages optimisées.', 'success');
      await loadDbStats();
    } catch {
      showToast('Erreur lors du VACUUM.', 'error');
    } finally {
      setIsVacuuming(false);
    }
  };

  // ── JSON Import Handlers ──
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const text = evt.target?.result as string;
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') {
          showToast('Fichier JSON invalide.', 'error');
          return;
        }
        // Basic sha256 preview
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuf = await crypto.subtle.digest('SHA-256', data);
        const hashArr = Array.from(new Uint8Array(hashBuf));
        const sha256 = hashArr.map((b) => b.toString(16).padStart(2, '0')).join('');

        const counts: Record<string, number> = {};
        if (Array.isArray(parsed.products)) counts.products = parsed.products.length;
        if (Array.isArray(parsed.transactions)) counts.transactions = parsed.transactions.length;
        if (Array.isArray(parsed.customers)) counts.customers = parsed.customers.length;

        setStagedRestore({
          file,
          text,
          sha256,
          version: parsed.version || 1,
          counts,
        });
        showToast('Fichier de sauvegarde prêt pour vérification PIN.', 'info');
      } catch {
        showToast('Erreur de lecture du fichier JSON.', 'error');
      }
    };
    reader.readAsText(file);
  };

  const handleExecuteRestore = async () => {
    if (!stagedRestore) return;
    const pin = restorePinInput.trim();
    if (!pin) {
      showToast('Saisissez le code PIN Manager pour confirmer la restauration.', 'warning');
      return;
    }
    const gate = await verifyManagerGate(pin);
    if (!gate.ok) {
      showToast('PIN Manager invalide. Restauration annulée.', 'error');
      return;
    }
    setIsRestoring(true);
    try {
      await importDatabase(stagedRestore.text);
      showToast('Restauration des données terminée avec succès.', 'success');
      setStagedRestore(null);
      setRestorePinInput('');
      await loadDbStats();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erreur lors de la restauration.', 'error');
    } finally {
      setIsRestoring(false);
    }
  };

  // ── Native Encrypted Snapshots ──
  const handleCreateEncryptedSnapshot = async () => {
    setIsCreatingSnapshot(true);
    try {
      const meta = await createDatabaseBackup('manual');
      showToast(`Instantané chiffré créé avec succès (${(meta.bytes / 1024).toFixed(1)} Ko).`, 'success');
      await loadSnapshotsList();
      logSecurityAction(
        'Sauvegarde Chiffrée',
        `Création snapshot chiffré ${meta.id} (${(meta.bytes / 1024).toFixed(1)} Ko)`,
        activeCashier?.name || 'Admin',
        true
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Échec de création du snapshot natif.', 'error');
    } finally {
      setIsCreatingSnapshot(false);
    }
  };

  const handleExecutePrune = async () => {
    const pin = snapshotPin.trim();
    if (!pin) {
      showToast('PIN Manager requis pour purger les instantanés.', 'warning');
      return;
    }
    try {
      const rep = await pruneSnapshots(pin, { keepLast: 5 });
      showToast(`Puration terminée : ${rep.deleted.length} instantané(s) purgé(s), ${rep.kept} conservé(s).`, 'success');
      setShowActionPinModal(null);
      setSnapshotPin('');
      await loadSnapshotsList();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Erreur lors de la purge.', 'error');
    }
  };

  const handleExecuteDecrypt = async () => {
    if (!selectedSnapshotForAction) return;
    const pin = snapshotPin.trim();
    if (!pin) {
      showToast('PIN Manager requis pour déchiffrer l\'instantané.', 'warning');
      return;
    }
    try {
      const result = await decryptSnapshotForRecovery(selectedSnapshotForAction, pin);
      showToast(`Instantané déchiffré dans : ${result.decryptedFile}`, 'success', 8000);
      setShowActionPinModal(null);
      setSnapshotPin('');
      setSelectedSnapshotForAction(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Échec de déchiffrement de l\'instantané.', 'error');
    }
  };

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      {/* SQLite Engine Banner */}
      <div className="bg-gradient-to-r from-cyan-950/40 via-pos-card to-blue-950/40 border border-cyan-500/30 rounded-2xl p-4 shadow-xl">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-cyan-500/20 text-cyan-400 flex items-center justify-center border border-cyan-500/40 shadow-lg shadow-cyan-500/10 shrink-0">
              <Database className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-extrabold text-pos-text tracking-wide">
                  Moteur SQLite Haute Performance
                </h3>
                <span className="bg-emerald-500/20 text-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" /> Zéro Perte de Données (WAL)
                </span>
              </div>
              <p className="text-[11px] text-pos-muted">
                Architecture ACID native • Journal WAL non-bloquant • Transactions immédiates garanties
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={loadDbStats}
            className="px-3 py-1.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text text-xs font-bold flex items-center gap-1.5 transition cursor-pointer shrink-0"
          >
            <RefreshCcw className="w-3.5 h-3.5" />
            <span>Actualiser Métriques</span>
          </button>
        </div>

        {/* SQLite Badges */}
        <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-pos-border/50 text-[10px]">
          <span className="bg-pos-bg/80 px-2.5 py-1 rounded-lg border border-pos-border text-slate-300 font-mono flex items-center gap-1">
            <Zap className="w-3 h-3 text-amber-400" /> Mode:{' '}
            <strong className="text-pos-text">{dbStats?.journal_mode?.toUpperCase() || 'WAL'}</strong>
          </span>
          <span className="bg-pos-bg/80 px-2.5 py-1 rounded-lg border border-pos-border text-slate-300 font-mono flex items-center gap-1">
            <Shield className="w-3 h-3 text-purple-400" /> Sync:{' '}
            <strong className="text-pos-text">{dbStats?.synchronous || 'NORMAL'}</strong>
          </span>
          <span className="bg-pos-bg/80 px-2.5 py-1 rounded-lg border border-pos-border text-slate-300 font-mono flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3 text-emerald-400" /> Clés Étrangères:{' '}
            <strong className="text-emerald-400">Actives (ON)</strong>
          </span>
          <span className="bg-pos-bg/80 px-2.5 py-1 rounded-lg border border-pos-border text-slate-300 font-mono flex items-center gap-1">
            <HardDrive className="w-3 h-3 text-cyan-400" /> MMAP:{' '}
            <strong className="text-cyan-400">256 Mo</strong>
          </span>
          <span className="bg-pos-bg/80 px-2.5 py-1 rounded-lg border border-pos-border text-slate-300 font-mono flex items-center gap-1">
            <Cpu className="w-3 h-3 text-blue-400" /> Cache RAM:{' '}
            <strong className="text-blue-400">64 Mo</strong>
          </span>
        </div>
      </div>

      {/* Database Live KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <div className="bg-pos-card border border-pos-border rounded-xl p-3.5 shadow-sm">
          <span className="text-[10px] text-pos-muted uppercase font-bold block mb-1">
            Taille Base de Données
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-black text-pos-text">
              {dbStats
                ? dbStats.db_size_bytes > 1048576
                  ? `${(dbStats.db_size_bytes / 1048576).toFixed(2)} Mo`
                  : `${(dbStats.db_size_bytes / 1024).toFixed(1)} Ko`
                : '...'}
            </span>
          </div>
          <span className="text-[9px] text-pos-muted block mt-0.5 truncate" title={dbStats?.db_path}>
            {dbStats?.db_path ? dbStats.db_path.split(/[\\/]/).pop() : 'mobi_pos.db'}
          </span>
        </div>

        <div className="bg-pos-card border border-pos-border rounded-xl p-3.5 shadow-sm">
          <span className="text-[10px] text-pos-muted uppercase font-bold block mb-1">
            Journal WAL Actif
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-black text-cyan-400">
              {dbStats ? `${(dbStats.wal_size_bytes / 1024).toFixed(1)} Ko` : '0.0 Ko'}
            </span>
          </div>
          <span className="text-[9px] text-emerald-400 font-semibold block mt-0.5">
            Écritures non-bloquantes
          </span>
        </div>

        <div className="bg-pos-card border border-pos-border rounded-xl p-3.5 shadow-sm">
          <span className="text-[10px] text-pos-muted uppercase font-bold block mb-1">
            Total Transactions
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-black text-emerald-400">
              {dbStats?.total_transactions ?? 0}
            </span>
            <span className="text-[10px] text-pos-muted">tickets</span>
          </div>
          <span className="text-[9px] text-pos-muted block mt-0.5">
            {dbStats?.total_products ?? 0} articles en stock
          </span>
        </div>

        <div className="bg-pos-card border border-pos-border rounded-xl p-3.5 shadow-sm">
          <span className="text-[10px] text-pos-muted uppercase font-bold block mb-1">
            Pages Allouées
          </span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-black text-purple-400">{dbStats?.page_count ?? 0}</span>
            <span className="text-[10px] text-pos-muted">pages</span>
          </div>
          <span className="text-[9px] text-pos-muted block mt-0.5">
            Page : {dbStats?.page_size ?? 4096} octets
          </span>
        </div>
      </div>

      {/* Diagnostics & Maintenance Panel */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
        <div className="flex items-center justify-between border-b border-pos-border/60 pb-2.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider">
              Diagnostics d'Intégrité & Maintenance SQLite
            </h4>
          </div>
          <span className="text-[10px] text-pos-muted font-mono">
            PRAGMA integrity_check & VACUUM
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
          <button
            type="button"
            onClick={handleRunIntegrityCheck}
            disabled={isCheckingIntegrity}
            className="min-h-[44px] py-2.5 px-3 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50 active:scale-95"
          >
            <Activity className={`w-4 h-4 ${isCheckingIntegrity ? 'animate-spin' : ''}`} />
            <span>{isCheckingIntegrity ? 'Vérification...' : 'Vérifier Intégrité Complète'}</span>
          </button>

          <button
            type="button"
            onClick={handleCheckpointWal}
            disabled={isCheckpointing}
            className="min-h-[44px] py-2.5 px-3 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50 active:scale-95"
          >
            <Zap className={`w-4 h-4 ${isCheckpointing ? 'animate-spin' : ''}`} />
            <span>{isCheckpointing ? 'Checkpoint...' : 'Checkpoint WAL (TRUNCATE)'}</span>
          </button>

          <button
            type="button"
            onClick={handleVacuum}
            disabled={isVacuuming}
            className="min-h-[44px] py-2.5 px-3 rounded-xl bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/40 text-purple-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50 active:scale-95"
          >
            <RefreshCcw className={`w-4 h-4 ${isVacuuming ? 'animate-spin' : ''}`} />
            <span>{isVacuuming ? 'Défragmentation...' : 'Optimiser Pages (VACUUM)'}</span>
          </button>
        </div>

        {/* Integrity Report Box */}
        {integrityReport && (
          <div
            className={`p-3 rounded-xl border text-xs space-y-1 animate-in fade-in ${
              integrityReport.is_healthy
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-red-500/10 border-red-500/30 text-red-300'
            }`}
          >
            <div className="flex items-center gap-2 font-bold">
              {integrityReport.is_healthy ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>Rapport d'Intégrité : 100% Conforme et Sain</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                  <span>Alerte d'Intégrité : Anomalie détectée</span>
                </>
              )}
            </div>
            <div className="text-[11px] font-mono opacity-90 pl-6">
              {(integrityReport.integrity_messages || []).map((m, idx) => (
                <div key={idx}>➔ {m}</div>
              ))}
              {(integrityReport.foreign_key_violations || []).map((f, idx) => (
                <div key={`fk-${idx}`} className="text-red-400">
                  ➔ Violation FK : {f}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Native Encrypted Snapshots (.db.enc) Section ── */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
        <div className="flex items-center justify-between border-b border-pos-border/60 pb-2.5">
          <div className="flex items-center gap-2">
            <FileKey className="w-4 h-4 text-purple-400" />
            <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider">
              Instantanés Chiffrés Natifs (.db.enc)
            </h4>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCreateEncryptedSnapshot}
              disabled={isCreatingSnapshot}
              className="py-1.5 px-3 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs flex items-center gap-1.5 transition cursor-pointer shadow-md disabled:opacity-50"
            >
              <FileKey className="w-3.5 h-3.5" />
              <span>{isCreatingSnapshot ? 'Création...' : 'Créer Snapshot Chiffré'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowActionPinModal('prune');
                setSnapshotPin('');
              }}
              className="py-1.5 px-2.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-rose-400 font-bold text-xs flex items-center gap-1 transition cursor-pointer"
              title="Purger les anciens instantanés"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Purger</span>
            </button>
          </div>
        </div>

        <p className="text-[11px] text-pos-muted">
          Snapshots physiques chiffrés par clé matérielle OS (ChaCha20-Poly1305 / AES).
          Résistants aux altérations et conformes aux protocoles de reprise d'activité.
        </p>

        {/* Snapshots List */}
        <div className="space-y-1.5 max-h-48 overflow-y-auto pt-1">
          {isLoadingSnapshots ? (
            <p className="text-xs text-pos-muted italic">Chargement des instantanés...</p>
          ) : snapshots.length === 0 ? (
            <p className="text-xs text-pos-muted italic">
              Aucun instantané chiffré stocké sur cet appareil.
            </p>
          ) : (
            snapshots.map((snap) => (
              <div
                key={snap}
                className="bg-pos-bg border border-pos-border rounded-lg p-2.5 flex items-center justify-between text-xs font-mono"
              >
                <div className="flex items-center gap-2 truncate min-w-0">
                  <FileCheck className="w-4 h-4 text-purple-400 shrink-0" />
                  <span className="text-pos-text truncate font-bold">{snap}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSnapshotForAction(snap);
                      setShowActionPinModal('decrypt');
                      setSnapshotPin('');
                    }}
                    className="px-2 py-1 rounded bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 border border-purple-500/40 text-[10px] font-bold cursor-pointer"
                  >
                    Déchiffrer Secours
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Snapshot Action Pin Modal (Prune / Decrypt) */}
      {showActionPinModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-pos-card border border-pos-border rounded-2xl p-5 max-w-sm w-full space-y-3 shadow-2xl animate-in zoom-in-95">
            <div className="flex items-center gap-2.5">
              <KeyRound className="w-5 h-5 text-purple-400" />
              <h4 className="text-sm font-bold text-pos-text">
                {showActionPinModal === 'prune'
                  ? 'Purger les Instantanés'
                  : 'Déchiffrer l\'Instantané'}
              </h4>
            </div>
            <p className="text-xs text-pos-muted">
              {showActionPinModal === 'prune'
                ? 'Saisissez le code PIN Manager pour purger les sauvegardes chiffrées antérieures.'
                : `Saisissez le code PIN Manager pour déchiffrer une copie claire de « ${selectedSnapshotForAction} » pour secours.`}
            </p>
            <input
              type="password"
              inputMode="numeric"
              maxLength={8}
              value={snapshotPin}
              onChange={(e) => setSnapshotPin(e.target.value)}
              placeholder="PIN Manager (6-8 chiffres)"
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:outline-none focus:border-purple-400"
              autoFocus
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setShowActionPinModal(null);
                  setSnapshotPin('');
                  setSelectedSnapshotForAction(null);
                }}
                className="px-3 py-1.5 rounded-lg bg-pos-bg text-pos-muted text-xs font-bold cursor-pointer hover:bg-pos-hover"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={showActionPinModal === 'prune' ? handleExecutePrune : handleExecuteDecrypt}
                className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold cursor-pointer shadow-md"
              >
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* JSON Backup & Restore Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Export Card */}
        <div className="bg-pos-card border border-pos-border rounded-xl p-4 flex flex-col justify-between">
          <div className="space-y-2 mb-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                <Download className="w-4 h-4 stroke-[2.5]" />
              </div>
              <h4 className="text-xs font-bold text-pos-text">Export Complet de Sauvegarde JSON</h4>
            </div>
            <p className="text-[10px] text-pos-muted">
              Exporte les articles, clients, tickets, réparations et paramètres au format JSON standard.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowExportPin(true)}
            className="w-full py-2 px-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition shadow-lg shadow-emerald-500/20 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>Télécharger Sauvegarde JSON</span>
          </button>
        </div>

        {/* Import Card */}
        <div className="bg-pos-card border border-pos-border rounded-xl p-4 flex flex-col justify-between">
          <div className="space-y-2 mb-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center border border-blue-500/30">
                <Upload className="w-4 h-4 stroke-[2.5]" />
              </div>
              <h4 className="text-xs font-bold text-pos-text">Restauration depuis JSON</h4>
            </div>
            <p className="text-[10px] text-pos-muted">
              Importe et synchronise un fichier JSON dans la base SQLite locale. PIN Manager requis.
            </p>
            {stagedRestore && (
              <input
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                value={restorePinInput}
                onChange={(e) => setRestorePinInput(e.target.value)}
                placeholder="Code PIN Manager requis"
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-blue-400 focus:outline-none"
              />
            )}
            {stagedRestore && (
              <p className="text-[10px] text-emerald-300 font-mono break-all">
                Prêt : v{stagedRestore.version ?? '?'} — {Object.keys(stagedRestore.counts ?? {}).length}{' '}
                table(s) — sha {stagedRestore.sha256.slice(0, 16)}…
              </p>
            )}
          </div>
          {!stagedRestore ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-2 px-3 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/50 text-blue-400 font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              <span>Sélectionner un Fichier JSON</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleExecuteRestore}
              disabled={isRestoring}
              className="w-full py-2 px-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 transition cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              <span>{isRestoring ? 'Restauration…' : 'Restaurer (PIN Manager requis)'}</span>
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileUpload}
            className="hidden"
          />
        </div>
      </div>

      {/* Export PIN Dialog */}
      <PinDialog
        isOpen={showExportPin}
        title="Export de sauvegarde"
        description="Saisissez le code PIN Manager pour télécharger la sauvegarde JSON complète."
        onSuccess={() => {
          setShowExportPin(false);
          void exportDatabase();
        }}
        onCancel={() => setShowExportPin(false)}
      />
    </div>
  );
};

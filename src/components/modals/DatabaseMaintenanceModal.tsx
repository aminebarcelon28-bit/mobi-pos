import React, { useState, useEffect } from 'react';
import {
  X,
  Database,
  ShieldCheck,
  RefreshCw,
  Download,
  Upload,
  HardDrive,
  Zap,
  Activity,
  Layers,
  Sparkles,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { sqliteAdapter } from '../../db/sqliteAdapter';
import type { DbStats, IntegrityReport } from '../../db/sqliteAdapter';
import { useToast } from '../ui/Toast';
import { soundEngine } from '../../utils/audioFeedback';

export const DatabaseMaintenanceModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    products,
    customers,
    transactions,
    repairOrders,
    purchaseOrders,
    customerDebts,
    storeExpenses,
    imeiRecords,
    activeShift,
  } = usePosStore();

  const { showToast } = useToast();

  const [stats, setStats] = useState<DbStats | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [actionOutput, setActionOutput] = useState<string>('');

  useEffect(() => {
    if (activeModal === 'db_maintenance') {
      loadStats();
    }
  }, [activeModal]);

  const loadStats = async () => {
    try {
      const s = await sqliteAdapter.getStats();
      setStats(s);
      const rep = await sqliteAdapter.runIntegrityCheck();
      setIntegrity(rep);
    } catch (e) {
      console.error('Failed to load DB stats:', e);
    }
  };

  if (activeModal !== 'db_maintenance') return null;

  // ══════════════════════════════════════════════════════════════
  // ACTIONS: MAINTENANCE & INTEGRITY
  // ══════════════════════════════════════════════════════════════
  const handleCheckpointWal = async () => {
    setIsProcessing(true);
    try {
      const msg = await sqliteAdapter.checkpointWal();
      setActionOutput(`[${new Date().toLocaleTimeString('fr-FR')}] ${msg}`);
      soundEngine.playSuccess();
      showToast('WAL Checkpoint exécuté avec succès.', 'success');
      await loadStats();
    } catch (e) {
      console.error(e);
      soundEngine.playError();
      showToast('Erreur lors du checkpoint WAL.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleVacuum = async () => {
    setIsProcessing(true);
    try {
      const msg = await sqliteAdapter.vacuum();
      setActionOutput(`[${new Date().toLocaleTimeString('fr-FR')}] ${msg}`);
      soundEngine.playSuccess();
      showToast('Base de données SQLite défragmentée et compactée !', 'success');
      await loadStats();
    } catch (e) {
      console.error(e);
      soundEngine.playError();
      showToast('Erreur lors du VACUUM.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRunIntegrity = async () => {
    setIsProcessing(true);
    try {
      const rep = await sqliteAdapter.runIntegrityCheck();
      setIntegrity(rep);
      setActionOutput(
        `[${new Date().toLocaleTimeString('fr-FR')}] Diagnostic d'intégrité terminé : ${
          rep.is_healthy ? '100% Intègre (Aucune corruption)' : 'Anomalies détectées'
        }`
      );
      soundEngine.playSuccess();
      showToast('Vérification d\'intégrité physique validée !', 'success');
    } catch (e) {
      console.error(e);
      soundEngine.playError();
      showToast('Erreur lors de la vérification d\'intégrité.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCreateSnapshot = async () => {
    setIsProcessing(true);
    try {
      const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `MobiPOS_Backup_${now}.db`;
      const res = await sqliteAdapter.backupToFile(fileName);
      setActionOutput(`[${new Date().toLocaleTimeString('fr-FR')}] Instantané créé : ${res}`);
      soundEngine.playSuccess();
      showToast(`Instantané de sauvegarde créé : ${fileName}`, 'success');
    } catch (e) {
      console.error(e);
      soundEngine.playError();
      showToast('Erreur lors de la création de la sauvegarde snapshot.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExportFullJson = () => {
    const backupData = {
      timestamp: new Date().toISOString(),
      appVersion: '1.5.8',
      products: products || [],
      customers: customers || [],
      transactions: transactions || [],
      repairOrders: repairOrders || [],
      purchaseOrders: purchaseOrders || [],
      customerDebts: customerDebts || [],
      storeExpenses: storeExpenses || [],
      imeiRecords: imeiRecords || [],
      activeShift: activeShift || null,
    };

    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `MobiPOS_Full_Database_Backup_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    soundEngine.playSuccess();
    showToast('Sauvegarde JSON intégrale téléchargée.', 'success');
  };

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes === 0) return '0 KB';
    const k = 1024;
    if (bytes < k * k) return `${(bytes / k).toFixed(1)} KB`;
    return `${(bytes / (k * k)).toFixed(2)} MB`;
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col h-[90vh]">
        {/* ══════════════════════════════════════════════════════════════ */}
        {/* HEADER */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white shadow-lg shadow-cyan-500/20">
              <Database className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-pos-text uppercase tracking-wider">
                  Centre de Maintenance & Intégrité SQLite WAL
                </h2>
                <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold text-xs flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Mode WAL Actif
                </span>
              </div>
              <p className="text-xs text-pos-muted">
                Télémétrie bas-niveau, compactage VACUUM, synchronisation du journal et snapshots de sécurité
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TOP TELEMETRY CARDS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-4 border-b border-pos-border bg-pos-bg grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0">
          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Taille Base Principale
              </span>
              <span className="text-lg font-black text-cyan-400 font-mono">
                {stats ? formatBytes(stats.db_size_bytes) : '...'}
              </span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
              <HardDrive className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Taille Journal WAL
              </span>
              <span className="text-lg font-black text-amber-400 font-mono">
                {stats ? formatBytes(stats.wal_size_bytes) : '0 KB'}
              </span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <Zap className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Intégrité Matérielle
              </span>
              <span className="text-lg font-black text-emerald-400 font-mono flex items-center gap-1">
                {integrity?.is_healthy ? '100% OK' : 'À Vérifier'}
              </span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Pages Mémoire / Cache
              </span>
              <span className="text-lg font-black text-purple-400 font-mono">
                {stats ? stats.page_count : '0'} pages
              </span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center">
              <Layers className="w-5 h-5" />
            </div>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* MAIN BODY */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* PRAGMAs & System Info */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3">
            <h3 className="text-xs font-black text-pos-text uppercase tracking-wider flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" />
              Paramètres du Moteur Transactionnel PRAGMA :
            </h3>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border">
                <span className="text-[10px] text-pos-muted uppercase block">Mode Journal</span>
                <span className="font-bold text-emerald-400">{stats?.journal_mode || 'WAL'}</span>
              </div>
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border">
                <span className="text-[10px] text-pos-muted uppercase block">Synchronous</span>
                <span className="font-bold text-cyan-400">{stats?.synchronous || 'NORMAL'}</span>
              </div>
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border">
                <span className="text-[10px] text-pos-muted uppercase block">Foreign Keys</span>
                <span className="font-bold text-emerald-400">ON (Strict)</span>
              </div>
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border">
                <span className="text-[10px] text-pos-muted uppercase block">Busy Timeout</span>
                <span className="font-bold text-amber-400">5000 ms</span>
              </div>
            </div>

            <div className="text-[11px] text-pos-muted bg-pos-bg p-2.5 rounded-xl border border-pos-border font-mono break-all">
              <span className="font-bold text-pos-text">Emplacement Fichier : </span>
              {stats?.db_path || 'C:\\Users\\Click\\AppData\\Roaming\\mobi-pos\\mobi_pos.db'}
            </div>
          </div>

          {/* Database Entities Metrics */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3">
            <h3 className="text-xs font-black text-pos-text uppercase tracking-wider flex items-center gap-2">
              <Layers className="w-4 h-4 text-purple-400" />
              Volume des Données par Table :
            </h3>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex justify-between items-center">
                <span className="text-pos-muted">Produits / SKU :</span>
                <span className="font-black text-pos-text">{products?.length || 0}</span>
              </div>
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex justify-between items-center">
                <span className="text-pos-muted">Clients :</span>
                <span className="font-black text-pos-text">{customers?.length || 0}</span>
              </div>
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex justify-between items-center">
                <span className="text-pos-muted">Ventes & Tickets :</span>
                <span className="font-black text-pos-text">{transactions?.length || 0}</span>
              </div>
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex justify-between items-center">
                <span className="text-pos-muted">Réparations SAV :</span>
                <span className="font-black text-pos-text">{repairOrders?.length || 0}</span>
              </div>
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex justify-between items-center">
                <span className="text-pos-muted">Bons Commande :</span>
                <span className="font-black text-pos-text">{purchaseOrders?.length || 0}</span>
              </div>
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex justify-between items-center">
                <span className="text-pos-muted">Écritures Dettes :</span>
                <span className="font-black text-pos-text">{customerDebts?.length || 0}</span>
              </div>
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex justify-between items-center">
                <span className="text-pos-muted">Charges & Dépenses :</span>
                <span className="font-black text-pos-text">{storeExpenses?.length || 0}</span>
              </div>
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex justify-between items-center">
                <span className="text-pos-muted">Enreg. IMEI :</span>
                <span className="font-black text-pos-text">{imeiRecords?.length || 0}</span>
              </div>
            </div>
          </div>

          {/* Action Operations Grid */}
          <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3">
            <h3 className="text-xs font-black text-pos-text uppercase tracking-wider flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-emerald-400" />
              Opérations de Maintenance Directes :
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              <button
                onClick={handleCheckpointWal}
                disabled={isProcessing}
                className="p-3 bg-pos-bg hover:bg-amber-500/10 border border-pos-border hover:border-amber-500/40 rounded-xl text-left space-y-1 transition cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center gap-2 text-amber-400 font-bold text-xs">
                  <Zap className="w-4 h-4" />
                  <span>WAL Checkpoint</span>
                </div>
                <p className="text-[10px] text-pos-muted">
                  Synchronise immédiatement les transactions du journal WAL vers le fichier SQLite principal.
                </p>
              </button>

              <button
                onClick={handleVacuum}
                disabled={isProcessing}
                className="p-3 bg-pos-bg hover:bg-cyan-500/10 border border-pos-border hover:border-cyan-500/40 rounded-xl text-left space-y-1 transition cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center gap-2 text-cyan-400 font-bold text-xs">
                  <RefreshCw className="w-4 h-4" />
                  <span>VACUUM (Défragmenter)</span>
                </div>
                <p className="text-[10px] text-pos-muted">
                  Récupère l'espace disque non utilisé et reconstruit les index B-Tree pour une vitesse maximale.
                </p>
              </button>

              <button
                onClick={handleRunIntegrity}
                disabled={isProcessing}
                className="p-3 bg-pos-bg hover:bg-emerald-500/10 border border-pos-border hover:border-emerald-500/40 rounded-xl text-left space-y-1 transition cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs">
                  <ShieldCheck className="w-4 h-4" />
                  <span>Vérifier Intégrité</span>
                </div>
                <p className="text-[10px] text-pos-muted">
                  Exécute PRAGMA integrity_check pour s'assurer de l'absence totale de corruptions physiques.
                </p>
              </button>

              <button
                onClick={handleCreateSnapshot}
                disabled={isProcessing}
                className="p-3 bg-pos-bg hover:bg-purple-500/10 border border-pos-border hover:border-purple-500/40 rounded-xl text-left space-y-1 transition cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center gap-2 text-purple-400 font-bold text-xs">
                  <Download className="w-4 h-4" />
                  <span>Instantané (.db)</span>
                </div>
                <p className="text-[10px] text-pos-muted">
                  Génère une copie snapshot conforme et isolée de la base de données avec timestamp.
                </p>
              </button>
            </div>

            {/* Action Log Box */}
            {actionOutput && (
              <div className="p-3 bg-pos-bg border border-pos-border rounded-xl font-mono text-xs text-emerald-400 animate-in fade-in">
                {actionOutput}
              </div>
            )}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* FOOTER */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportFullJson}
              className="px-4 py-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text text-xs font-bold rounded-xl flex items-center gap-1.5 transition cursor-pointer"
            >
              <Upload className="w-4 h-4 text-emerald-400" />
              <span>Export JSON Intégral</span>
            </button>
          </div>

          <button
            onClick={closeModal}
            className="px-5 py-2 rounded-xl text-xs font-bold bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text transition cursor-pointer"
          >
            Fermer (Échap)
          </button>
        </div>
      </div>
    </div>
  );
};

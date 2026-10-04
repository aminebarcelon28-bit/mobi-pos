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
import { maintenanceService, type DbStats, type IntegrityReport } from '../../services/maintenanceService';
import { useToast } from '../ui/Toast';
import { audioBus } from '../../utils/audioEvents';
import { verifyManagerGate } from '../../utils/pinGate';
import { Lock, ShieldAlert } from 'lucide-react';

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
    logSecurityAction,
  } = usePosStore();

  const { showToast } = useToast();

  const [stats, setStats] = useState<DbStats | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [actionOutput, setActionOutput] = useState<string>('');
  const [repairTicketId, setRepairTicketId] = useState<string>('');

  // Decision 2: the maintenance center exposes the full-JSON export and
  // snapshot creation — fresh manager PIN per open (native gate,
  // fail-closed), same bar as the journal. Covers every launcher
  // (Header/BottomBar/ManagementTab) authoritatively at the modal.
  const [maintUnlocked, setMaintUnlocked] = useState(false);
  const [maintPin, setMaintPin] = useState('');
  const [maintError, setMaintError] = useState<string | null>(null);
  const [maintVerifying, setMaintVerifying] = useState(false);

  const loadStats = async () => {
    try {
      const s = await maintenanceService.getDatabaseStats();
      setStats(s);
      const rep = await maintenanceService.runDatabaseIntegrityCheck();
      setIntegrity(rep);
    } catch (e) {
      console.error('Failed to load DB stats:', e);
    }
  };

  useEffect(() => {
    if (activeModal === 'db_maintenance') {
      setMaintUnlocked(false);
      setMaintPin('');
      setMaintError(null);
    }
  }, [activeModal]);

  const handleMaintUnlock = async () => {
    const clean = maintPin.trim();
    if (!/^\d+$/.test(clean) || clean.length < 4 || clean.length > 32) {
      setMaintError('PIN manager : 4 chiffres minimum.');
      return;
    }
    setMaintVerifying(true);
    setMaintError(null);
    try {
      const gate = await verifyManagerGate(clean);
      if (gate.locked) {
        const secs = Math.max(1, Math.ceil(gate.remainingMs / 1000));
        setMaintError(`Verrouillé — réessayez dans ${secs}s.`);
        return;
      }
      if (!gate.ok) {
        setMaintError('PIN manager incorrect.');
        return;
      }
      setMaintUnlocked(true);
      setMaintPin('');
      setMaintError(null);
      void loadStats();
    } finally {
      setMaintVerifying(false);
    }
  };

  useEffect(() => {
    if (activeModal === 'db_maintenance') {
      loadStats();
    }
  }, [activeModal]);

  useEffect(() => { if (activeModal !== 'db_maintenance') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  if (activeModal !== 'db_maintenance') return null;

  // ══════════════════════════════════════════════════════════════
  // ACTIONS: MAINTENANCE & INTEGRITY
  // ══════════════════════════════════════════════════════════════
  const handleCheckpointWal = async () => {
    setIsProcessing(true);
    try {
      const msg = await maintenanceService.checkpointDatabaseWal();
      setActionOutput(`[${new Date().toLocaleTimeString('fr-FR')}] ${msg}`);
      audioBus.emit('success');
      showToast('WAL Checkpoint exécuté avec succès.', 'success');
      await loadStats();
    } catch (e) {
      console.error(e);
      audioBus.emit('error');
      showToast('Erreur lors du checkpoint WAL.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleVacuum = async () => {
    setIsProcessing(true);
    try {
      const msg = await maintenanceService.vacuumDatabase();
      setActionOutput(`[${new Date().toLocaleTimeString('fr-FR')}] ${msg}`);
      audioBus.emit('success');
      showToast('Base de données SQLite défragmentée et compactée !', 'success');
      await loadStats();
    } catch (e) {
      console.error(e);
      audioBus.emit('error');
      showToast('Erreur lors du VACUUM.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRunIntegrity = async () => {
    setIsProcessing(true);
    try {
      const rep = await maintenanceService.runDatabaseIntegrityCheck();
      setIntegrity(rep);
      setActionOutput(
        `[${new Date().toLocaleTimeString('fr-FR')}] Diagnostic d'intégrité terminé : ${
          rep.is_healthy ? '100% Intègre (Aucune corruption)' : 'Anomalies détectées'
        }`
      );
      audioBus.emit('success');
      showToast('Vérification d\'intégrité physique validée !', 'success');
    } catch (e) {
      console.error(e);
      audioBus.emit('error');
      showToast('Erreur lors de la vérification d\'intégrité.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // Ticket COGS repair (audit class #REC-20260926-1408ML-02-DJB64): rebuilds
  // one sale's row + lines + receipt envelope from its frozen allocation
  // rows. Targeted by ticket id — never a sweep — and refuses voided /
  // already-exact tickets inside the job. The rewrite is audited like any
  // manager-grade mutation.
  const handleRepairTicketCogs = async () => {
    const ticketId = repairTicketId.trim();
    if (!ticketId) {
      showToast('Saisissez un identifiant de ticket à réparer.', 'warning');
      return;
    }
    setIsProcessing(true);
    try {
      const { repairSaleCogsFromLedger } = await import('../../db/sqlPluginAdapter');
      const res = await repairSaleCogsFromLedger(ticketId);
      if (res.repaired && res.after) {
        const msg = `Ticket ${ticketId} réparé : coût ${res.before?.costTotal} → ${res.after.costTotal}, profit ${res.before?.profit} → ${res.after.profit}, ledger ${res.after.ledger}.`;
        setActionOutput(`[${new Date().toLocaleTimeString('fr-FR')}] ${msg}`);
        audioBus.emit('success');
        showToast(msg, 'success');
        logSecurityAction(
          'Réparation Coûts Ticket (Audit)',
          `${msg} Motif: ${res.before ? `lignes au prix catalogue au lieu du FIFO gelé` : 'écart détecté'}.`,
          'Yacine (Admin)',
          true
        );
      } else {
        const msg = `Ticket ${ticketId} : aucune réparation (${res.reason}).`;
        setActionOutput(`[${new Date().toLocaleTimeString('fr-FR')}] ${msg}`);
        audioBus.emit('success');
        showToast(msg, 'info');
      }
      setRepairTicketId('');
      await loadStats();
    } catch (e) {
      console.error(e);
      audioBus.emit('error');
      showToast("Erreur lors de la réparation des coûts du ticket.", 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // Negative-stock diagnostic (offline double-sell detector): read-only scan
  // of ledger sums below zero. Files nothing and changes nothing — the
  // operator decides (recount via stocktake, which books ADJUST deltas, or
  // restricted sale). Surfaced here, not auto-remediated: silently
  // "fixing" stock would destroy the evidence of which till oversold.
  const handleDetectNegativeStock = async () => {
    setIsProcessing(true);
    try {
      const { findNegativeStockProducts } = await import('../../db/sqlPluginAdapter');
      const rows = await findNegativeStockProducts();
      if (rows.length === 0) {
        const msg = 'Stocks négatifs : aucun — tous les soldes comptables sont >= 0.';
        setActionOutput(`[${new Date().toLocaleTimeString('fr-FR')}] ${msg}`);
        audioBus.emit('success');
        showToast(msg, 'success');
      } else {
        const msg = `Stocks négatifs détectés (${rows.length}) : ${rows
          .slice(0, 12)
          .map((r) => `${r.productId} (${r.stock})`)
          .join(', ')}${rows.length > 12 ? ` … +${rows.length - 12} autre(s)` : ''} — recomptez ces références (l'inventaire régularise).`;
        setActionOutput(`[${new Date().toLocaleTimeString('fr-FR')}] ${msg}`);
        audioBus.emit('error');
        showToast(msg, 'warning', 8000);
      }
      await loadStats();
    } catch (e) {
      console.error(e);
      audioBus.emit('error');
      showToast('Erreur lors de la détection des stocks négatifs.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCreateSnapshot = async () => {
    setIsProcessing(true);
    try {
      const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `MobiPOS_Backup_${now}.db`;
      const backupResult = await maintenanceService.backupDatabaseToFile(fileName);
      setActionOutput(`[${new Date().toLocaleTimeString('fr-FR')}] Instantané créé : ${backupResult}`);
      audioBus.emit('success');
      showToast(`Instantané de sauvegarde créé : ${fileName}`, 'success');
    } catch (e) {
      console.error(e);
      audioBus.emit('error');
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
    URL.revokeObjectURL(url);
    audioBus.emit('success');
    showToast('Sauvegarde JSON intégrale téléchargée.', 'success');
  };

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes === 0) return '0 KB';
    const k = 1024;
    if (bytes < k * k) return `${(bytes / k).toFixed(1)} KB`;
    return `${(bytes / (k * k)).toFixed(2)} MB`;
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none">
      <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-2xl sm:rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col h-[94dvh] sm:h-[90dvh] pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:py-0">
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* HEADER */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white shadow-lg shadow-cyan-500/20 shrink-0">
              <Database className="w-5 h-5 sm:w-6 sm:h-6 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xs sm:text-base font-black text-pos-text uppercase tracking-wider truncate">
                  Maintenance SQLite WAL
                </h2>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold text-[10px] sm:text-xs flex items-center gap-1 shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Mode WAL
                </span>
              </div>
              <p className="text-[11px] text-pos-muted hidden sm:block truncate">
                Télémétrie bas-niveau, compactage VACUUM, synchronisation du journal et snapshots
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {!maintUnlocked ? (
          /* ── Decision 2 gate screen (authoritative for all launchers) ── */
          <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center gap-4 text-center">
            <div className="w-12 h-12 rounded-full bg-cyan-500/15 flex items-center justify-center border border-cyan-500/30">
              <Lock className="w-6 h-6 text-cyan-400" aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-pos-text">Accès réservé — PIN manager requis</h3>
              <p className="text-[11px] text-pos-muted mt-1 max-w-sm">
                Le centre de maintenance expose l'export JSON intégral et les instantanés. Contrôle d'accès
                occasionnel — ne résiste pas à un WebView modifié.
              </p>
            </div>
            <form
              className="w-full max-w-xs space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!maintVerifying) void handleMaintUnlock();
              }}
            >
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="current-password"
                enterKeyHint="done"
                aria-label="PIN manager"
                maxLength={12}
                value={maintPin}
                onChange={(e) => {
                  setMaintError(null);
                  setMaintPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 12));
                }}
                placeholder="PIN manager"
                className="w-full min-h-[52px] bg-pos-card border border-pos-border rounded-xl px-4 text-center text-2xl font-mono font-black tracking-[0.5em] text-pos-text focus:outline-none focus:border-cyan-500 transition"
              />
              {maintError && (
                <p className="text-[11px] text-pos-danger" role="alert">
                  {maintError}
                </p>
              )}
              <button
                type="submit"
                disabled={maintVerifying || maintPin.trim().length < 4}
                className="w-full min-h-[48px] rounded-xl font-bold bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition cursor-pointer"
              >
                {maintVerifying ? 'Vérification…' : 'Déverrouiller la maintenance'}
              </button>
            </form>
            <p className="text-[10px] text-pos-muted max-w-xs flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              Chaque ouverture demande le PIN — aucune session prolongée.
            </p>
          </div>
        ) : (
        <>
        {/* ── TOP TELEMETRY CARDS ── */}
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
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
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
              {stats?.db_path || 'mobi_pos.db (Base de Données Locale)'}
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

              <button
                onClick={handleDetectNegativeStock}
                disabled={isProcessing}
                className="p-3 bg-pos-bg hover:bg-rose-500/10 border border-pos-border hover:border-rose-500/40 rounded-xl text-left space-y-1 transition cursor-pointer disabled:opacity-50"
              >
                <div className="flex items-center gap-2 text-rose-400 font-bold text-xs">
                  <Activity className="w-4 h-4" />
                  <span>Stocks Négatifs</span>
                </div>
                <p className="text-[10px] text-pos-muted">
                  Détecte les soldes comptables négatifs (double-vente hors-ligne). Lecture seule.
                </p>
              </button>
            </div>

            {/* Targeted ticket COGS repair */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-pos-bg border border-pos-border rounded-xl p-3">
              <div className="flex items-center gap-2 text-rose-400 font-bold text-xs shrink-0">
                <Activity className="w-4 h-4" />
                <span>Réparer Coûts Ticket :</span>
              </div>
              <input
                type="text"
                value={repairTicketId}
                onChange={(e) => setRepairTicketId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleRepairTicketCogs();
                }}
                placeholder="N° ticket ou ID (ex. REC-…)"
                aria-label="Identifiant du ticket à réparer"
                disabled={isProcessing}
                className="flex-1 min-w-0 bg-pos-panel border border-pos-border rounded-lg px-3 py-1.5 text-xs font-mono text-pos-text placeholder-pos-muted focus:outline-none focus:border-rose-400 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleRepairTicketCogs}
                disabled={isProcessing || !repairTicketId.trim()}
                className="px-4 py-1.5 rounded-lg text-xs font-bold bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 transition cursor-pointer disabled:opacity-50 shrink-0 min-h-[36px]"
              >
                Réparer
              </button>
              <p className="text-[10px] text-pos-muted sm:max-w-[220px]">
                Reconstruit la ligne + reçu depuis les lots gelés. Refuse les tickets annulés ou déjà exacts.
              </p>
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
        <div className="p-3 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-2 shrink-0">
          <button
            onClick={handleExportFullJson}
            className="px-4 py-2.5 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text text-xs font-bold rounded-xl flex items-center justify-center gap-1.5 transition cursor-pointer min-h-[44px] active-press"
          >
            <Upload className="w-4 h-4 text-emerald-400" />
            <span>Export JSON Intégral</span>
          </button>

          <button
            onClick={closeModal}
            className="px-5 py-2.5 rounded-xl text-xs font-bold bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text transition cursor-pointer min-h-[44px] active-press flex items-center justify-center"
          >
            Fermer (Échap)
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
};

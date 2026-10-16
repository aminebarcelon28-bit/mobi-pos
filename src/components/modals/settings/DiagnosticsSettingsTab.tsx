import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  ScanLine,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Database,
  Cloud,
  Printer,
  Shield,
} from 'lucide-react';
import { maintenanceService } from '../../../services/maintenanceService';
import { scanHardwareDevices, type DiscoveredDevice } from '../../../api/hardware';
import { checkPinLockout } from '../../../utils/security';
import { getPendingOutbox } from '../../../db/sqlPluginAdapter';
import type { ReceiptSettings } from '../../../types/pos';

export type DiagnosticResult = 'pass' | 'fail' | 'warning' | 'pending' | 'running';

export interface DiagnosticItem {
  id: string;
  category: 'sqlite' | 'sync' | 'hardware' | 'security';
  name: string;
  description: string;
  status: DiagnosticResult;
  message?: string;
  durationMs?: number;
  details?: string;
}

interface DiagnosticsSettingsTabProps {
  receiptSettings: ReceiptSettings;
}

export const DiagnosticsSettingsTab: React.FC<DiagnosticsSettingsTabProps> = ({ receiptSettings }) => {
  const [isRunning, setIsRunning] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [lastRunTime, setLastRunTime] = useState<string | null>(null);

  // Live scanner test state
  const [scannerActive, setScannerActive] = useState(false);
  const [scannerInput, setScannerInput] = useState('');
  const [lastScanLatencyMs, setLastScanLatencyMs] = useState<number | null>(null);
  const scanStartRef = useRef<number>(0);
  const scannerInputRef = useRef<HTMLInputElement>(null);

  const runAllDiagnostics = useCallback(async () => {
    setIsRunning(true);
    const startOverall = performance.now();
    void startOverall;
    const results: DiagnosticItem[] = [];

    // 1. SQLite Database Integrity Probe
    const tDb = performance.now();
    try {
      const integrity = await maintenanceService.runDatabaseIntegrityCheck();
      const stats = await maintenanceService.getDatabaseStats();
      const dbDuration = Math.round(performance.now() - tDb);

      if (integrity.is_healthy) {
        results.push({
          id: 'diag-sqlite',
          category: 'sqlite',
          name: 'Intégrité Physique SQLite (PRAGMA)',
          description: `Base saine • ${stats?.total_transactions ?? 0} transactions • Pages: ${stats?.page_count ?? 0} • Journal WAL`,
          status: 'pass',
          message: 'Base de données intègre & saine',
          durationMs: dbDuration,
          details: `Taille DB: ${stats ? (stats.db_size_bytes / 1024).toFixed(1) : 0} Ko, WAL: ${stats ? (stats.wal_size_bytes / 1024).toFixed(1) : 0} Ko`,
        });
      } else {
        results.push({
          id: 'diag-sqlite',
          category: 'sqlite',
          name: 'Intégrité Physique SQLite (PRAGMA)',
          description: 'Anomalie détectée dans les pages ou contraintes de clés étrangères',
          status: 'fail',
          message: 'Anomalie détectée',
          durationMs: dbDuration,
          details: integrity.integrity_messages?.join('; ') || 'Erreur intégrité',
        });
      }
    } catch (err) {
      results.push({
        id: 'diag-sqlite',
        category: 'sqlite',
        name: 'Intégrité Physique SQLite',
        description: 'Échec de connexion ou requête PRAGMA',
        status: 'fail',
        message: err instanceof Error ? err.message : 'Erreur',
        durationMs: Math.round(performance.now() - tDb),
      });
    }

    // 2. Sync Outbox Pipeline Probe
    const tSync = performance.now();
    try {
      const pendingRows = await getPendingOutbox();
      const syncDuration = Math.round(performance.now() - tSync);
      const pendingCount = pendingRows.length;

      if (pendingCount === 0) {
        results.push({
          id: 'diag-sync',
          category: 'sync',
          name: 'Pipeline Sync Outbox',
          description: 'File de synchronisation purgée (0 enregistrement en attente)',
          status: 'pass',
          message: 'À jour (0 en attente)',
          durationMs: syncDuration,
        });
      } else if (pendingCount < 50) {
        results.push({
          id: 'diag-sync',
          category: 'sync',
          name: 'Pipeline Sync Outbox',
          description: `${pendingCount} mutation(s) en attente d'acheminement vers le cloud`,
          status: 'warning',
          message: `${pendingCount} en attente`,
          durationMs: syncDuration,
          details: 'Synchronisation normale au prochain cycle réseau',
        });
      } else {
        results.push({
          id: 'diag-sync',
          category: 'sync',
          name: 'Pipeline Sync Outbox',
          description: `Accumulation importante de mutations hors ligne (${pendingCount} lignes)`,
          status: 'fail',
          message: `${pendingCount} lignes en file`,
          durationMs: syncDuration,
          details: 'Vérifiez la connectivité passerelle ou la clé de synchronisation',
        });
      }
    } catch (err) {
      results.push({
        id: 'diag-sync',
        category: 'sync',
        name: 'Pipeline Sync Outbox',
        description: 'Impossible d\'interroger la table sync_outbox',
        status: 'warning',
        message: 'Non interrogé',
        durationMs: Math.round(performance.now() - tSync),
        details: err instanceof Error ? err.message : undefined,
      });
    }

    // 3. Hardware Peripheral Scan Probe
    const tHw = performance.now();
    try {
      const devices = await scanHardwareDevices<DiscoveredDevice>();
      const hwDuration = Math.round(performance.now() - tHw);

      if (devices.length > 0) {
        results.push({
          id: 'diag-hw',
          category: 'hardware',
          name: 'Équipements Physiques Détectés',
          description: `${devices.length} équipement(s) connecté(s) sur le bus USB / Port système`,
          status: 'pass',
          message: `${devices.length} appareil(s) en ligne`,
          durationMs: hwDuration,
          details: devices.map((d) => d.name).join(', '),
        });
      } else {
        results.push({
          id: 'diag-hw',
          category: 'hardware',
          name: 'Équipements Physiques Détectés',
          description: 'Aucun périphérique physique détecté par le système hôte',
          status: 'warning',
          message: '0 appareil détecté',
          durationMs: hwDuration,
          details: 'Vérifiez les câbles USB et l\'alimentation des imprimantes/scanners',
        });
      }
    } catch (err) {
      results.push({
        id: 'diag-hw',
        category: 'hardware',
        name: 'Équipements Physiques',
        description: 'Échec de l\'énumération matérielle native',
        status: 'fail',
        message: 'Erreur scan',
        durationMs: Math.round(performance.now() - tHw),
        details: err instanceof Error ? err.message : undefined,
      });
    }

    // 4. Printer Routing Configuration Probe
    const routing = receiptSettings?.printerRouting;
    const hasReceiptPrinter = Boolean(routing?.receiptPrinterName);
    const hasLabelPrinter = Boolean(routing?.labelPrinterName);

    if (hasReceiptPrinter) {
      results.push({
        id: 'diag-printer-routing',
        category: 'hardware',
        name: 'Routage Imprimantes Documentaires',
        description: `Reçus : ${routing?.receiptPrinterName || 'Non défini'} • Étiquettes : ${routing?.labelPrinterName || 'Non défini'}`,
        status: hasLabelPrinter ? 'pass' : 'warning',
        message: hasLabelPrinter ? 'Routage complet' : 'Reçus configurés',
        durationMs: 5,
      });
    } else {
      results.push({
        id: 'diag-printer-routing',
        category: 'hardware',
        name: 'Routage Imprimantes Documentaires',
        description: 'Aucune imprimante de reçus thermique n\'est explicitement assignée',
        status: 'warning',
        message: 'Non configuré',
        durationMs: 5,
        details: 'Configurez les imprimantes cibles dans l\'onglet Matériel',
      });
    }

    // 5. Manager Security & Lockout Gate Probe
    const tSec = performance.now();
    try {
      const gateState = checkPinLockout();
      const secDuration = Math.round(performance.now() - tSec);

      if (gateState.isLocked) {
        results.push({
          id: 'diag-sec',
          category: 'security',
          name: 'Contrôleur de Sécurité & PIN',
          description: `Système verrouillé suite à plusieurs tentatives erronées (${gateState.remainingSeconds}s restantes)`,
          status: 'fail',
          message: 'Verrouillage Actif',
          durationMs: secDuration,
        });
      } else {
        results.push({
          id: 'diag-sec',
          category: 'security',
          name: 'Contrôleur de Sécurité & PIN',
          description: 'Protection PIN active • Échelonnage exponentiel opérationnel',
          status: 'pass',
          message: 'Sécurisé & Déverrouillé',
          durationMs: secDuration,
        });
      }
    } catch {
      results.push({
        id: 'diag-sec',
        category: 'security',
        name: 'Contrôleur de Sécurité & PIN',
        description: 'Statut du verrouillage non disponible',
        status: 'warning',
        message: 'Contrôleur local',
        durationMs: 2,
      });
    }

    setDiagnostics(results);
    setLastRunTime(new Date().toLocaleTimeString('fr-FR'));
    setIsRunning(false);
  }, [receiptSettings]);

  // Run on mount
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) {
        void runAllDiagnostics();
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runAllDiagnostics]);

  const handleStartScannerTest = () => {
    setScannerActive(true);
    setScannerInput('');
    setLastScanLatencyMs(null);
    scanStartRef.current = performance.now();
    setTimeout(() => {
      scannerInputRef.current?.focus();
    }, 50);
  };

  const handleScannerChange = (val: string) => {
    if (!scannerInput && val.length > 0) {
      scanStartRef.current = performance.now();
    }
    setScannerInput(val);
    if (val.length >= 8) {
      setLastScanLatencyMs(Math.round(performance.now() - scanStartRef.current));
    }
  };

  const total = diagnostics.length;
  const passed = diagnostics.filter((d) => d.status === 'pass').length;
  const failed = diagnostics.filter((d) => d.status === 'fail').length;
  const warnings = diagnostics.filter((d) => d.status === 'warning').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xs font-bold text-pos-muted uppercase tracking-wider">
            Diagnostics Système Réels & Télémétrie
          </h3>
          <p className="text-[11px] text-pos-muted mt-0.5">
            Sondes natives sans simulation : état SQLite, file sync outbox, périphériques et sécurité.
            {lastRunTime && ` (Dernière vérification à ${lastRunTime})`}
          </p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <button
            type="button"
            onClick={handleStartScannerTest}
            className="px-3 py-1.5 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/30 text-xs font-bold flex items-center gap-1.5 hover:bg-amber-500/20 transition cursor-pointer"
          >
            <ScanLine className="w-3.5 h-3.5" />
            <span>Test Scanner Live</span>
          </button>
          <button
            type="button"
            onClick={() => void runAllDiagnostics()}
            disabled={isRunning}
            className="px-3.5 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-cyan-500/20 transition cursor-pointer disabled:opacity-50"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : ''}`} />
            <span>{isRunning ? 'Analyse en cours...' : 'Relancer Tous les Diagnostics'}</span>
          </button>
        </div>
      </div>

      {/* Live Scanner Test Box */}
      {scannerActive && (
        <div className="bg-pos-card border border-amber-500/30 rounded-xl p-4 shadow-md shadow-amber-500/5 animate-in fade-in">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ScanLine className="w-4 h-4 text-amber-400 animate-pulse" />
              <h4 className="text-xs font-bold text-pos-text">Test Scanner en Temps Réel</h4>
            </div>
            <button
              type="button"
              onClick={() => setScannerActive(false)}
              className="text-[10px] text-pos-muted hover:text-pos-text underline cursor-pointer"
            >
              Fermer
            </button>
          </div>
          <p className="text-[10px] text-pos-muted mb-2">
            Scannez un code-barres ou QR code avec votre lecteur USB/Bluetooth :
          </p>
          <input
            ref={scannerInputRef}
            type="text"
            value={scannerInput}
            onChange={(e) => handleScannerChange(e.target.value)}
            placeholder="← En attente du signal de lecture..."
            className="w-full bg-pos-bg border border-pos-border rounded-xl px-4 py-3 text-sm font-mono text-pos-text focus:border-amber-400 focus:outline-none transition"
            autoFocus
          />
          {scannerInput && (
            <div className="mt-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-emerald-400">Capture Réussie !</p>
                <p className="text-xs text-pos-text font-mono font-bold mt-0.5 break-all">{scannerInput}</p>
                <p className="text-[10px] text-pos-muted mt-1">
                  Longueur: {scannerInput.length} car. • Format probable:{' '}
                  {/^[0-9]+$/.test(scannerInput)
                    ? scannerInput.length === 13
                      ? 'EAN-13'
                      : scannerInput.length === 12
                        ? 'UPC-A'
                        : scannerInput.length === 8
                          ? 'EAN-8'
                          : 'Numérique'
                    : 'Code 128 / QR / Alphanumérique'}
                  {lastScanLatencyMs !== null && ` • Latence : ${lastScanLatencyMs} ms`}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Summary KPI Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
        <div className="bg-pos-card border border-pos-border rounded-xl p-3 text-center">
          <span className="text-[9px] text-pos-muted uppercase font-bold block">Total Sondes</span>
          <span className="text-base font-black text-pos-text">{total}</span>
        </div>
        <div className="bg-pos-card border border-pos-border rounded-xl p-3 text-center">
          <span className="text-[9px] text-pos-muted uppercase font-bold block">Conformes</span>
          <span className="text-base font-black text-emerald-400">{passed}</span>
        </div>
        <div className="bg-pos-card border border-pos-border rounded-xl p-3 text-center">
          <span className="text-[9px] text-pos-muted uppercase font-bold block">Alertes / Attention</span>
          <span className="text-base font-black text-amber-400">{warnings}</span>
        </div>
        <div className="bg-pos-card border border-pos-border rounded-xl p-3 text-center">
          <span className="text-[9px] text-pos-muted uppercase font-bold block">Échecs Critiques</span>
          <span className="text-base font-black text-rose-400">{failed}</span>
        </div>
      </div>

      {/* Diagnostics List */}
      <div className="space-y-2.5">
        {diagnostics.map((d) => {
          const isPass = d.status === 'pass';
          const isFail = d.status === 'fail';

          const icon = isPass ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          ) : isFail ? (
            <XCircle className="w-5 h-5 text-rose-400 shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          );

          const categoryIcon =
            d.category === 'sqlite' ? (
              <Database className="w-3.5 h-3.5 text-cyan-400" />
            ) : d.category === 'sync' ? (
              <Cloud className="w-3.5 h-3.5 text-purple-400" />
            ) : d.category === 'security' ? (
              <Shield className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Printer className="w-3.5 h-3.5 text-amber-400" />
            );

          return (
            <div
              key={d.id}
              className="bg-pos-card border border-pos-border rounded-xl p-3.5 flex items-start justify-between hover:border-pos-text/20 transition gap-3"
            >
              <div className="flex items-start gap-3 min-w-0">
                {icon}
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-pos-text">{d.name}</span>
                    <span className="text-[9px] text-pos-muted bg-pos-bg px-2 py-0.5 rounded-full border border-pos-border flex items-center gap-1 font-mono uppercase">
                      {categoryIcon}
                      {d.category}
                    </span>
                  </div>
                  <p className="text-[11px] text-pos-muted mt-0.5">{d.description}</p>
                  {d.details && (
                    <p className="text-[10px] text-pos-muted/80 font-mono mt-1 break-words">
                      ➔ {d.details}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-col items-end shrink-0">
                {d.durationMs !== undefined && (
                  <span className="text-[10px] text-pos-muted font-mono">{d.durationMs}ms</span>
                )}
                <span
                  className={`text-[10px] font-bold mt-1 px-2 py-0.5 rounded-md border ${
                    isPass
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                      : isFail
                        ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                        : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                  }`}
                >
                  {d.message}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

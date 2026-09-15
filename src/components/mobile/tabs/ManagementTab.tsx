import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  TrendingUp,
  DollarSign,
  Receipt,
  Settings,
  RefreshCw,
  Wifi,
  WifiOff,
  Sun,
  Moon,
  Volume2,
  VolumeX,
  Store,
  ChevronRight,
  Monitor,
  Calendar,
  Layers,
  Key,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { useDeviceMode } from '../../../hooks/useDeviceMode';
import { syncManager } from '../../../sync/SyncManager';
import type { SyncStatus } from '../../../sync/types';
import { soundEngine } from '../../../utils/audioFeedback';
import { formatDZD } from '../../../types/pos';
import { useToast } from '../../ui/Toast';

interface ManagementTabProps {
  onOpenPairingWizard?: () => void;
}

export const ManagementTab: React.FC<ManagementTabProps> = ({ onOpenPairingWizard }) => {
  const {
    openModal,
    transactions,
    activeShift,
    receiptSettings,
    themeMode,
    toggleTheme,
    products,
  } = usePosStore();
  const { setRoleMode } = useDeviceMode();
  const { showToast } = useToast();

  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(() => soundEngine.getProfile().isMuted);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    pushing: false,
    pulling: false,
    pendingCount: 0,
    lastPushAt: null,
    lastPullAt: null,
    lastError: null,
    quotaExceeded: false,
  });
  const [isManualSyncing, setIsManualSyncing] = useState(false);

  useEffect(() => {
    const unsub = syncManager.subscribe((s) => {
      setSyncStatus(s);
    });
    return unsub;
  }, []);

  // Today's summary calculation
  const todayTransactions = React.useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    return (transactions || []).filter((tx) => (tx.createdAt || '').startsWith(today));
  }, [transactions]);

  const todayRevenue = React.useMemo(() => {
    return todayTransactions.reduce((acc, tx) => acc + (tx.total || 0), 0);
  }, [todayTransactions]);

  const handleToggleSound = () => {
    const muted = soundEngine.toggleMute();
    setIsAudioMuted(muted);
    if (!muted) soundEngine.playKeyBeep?.();
    showToast(muted ? 'Sons désactivés' : 'Effets sonores activés', 'info');
  };

  const handleForceSync = async () => {
    soundEngine.playKeyBeep?.();
    setIsManualSyncing(true);
    try {
      await syncManager.pushOnce();
      const pullRes = await syncManager.pullOnce();
      soundEngine.playSuccess?.();
      showToast(`Synchro réussie (${pullRes} éléments reçus).`, 'success');
    } catch {
      soundEngine.playError?.();
      showToast('Échec de synchronisation. Vérifiez la connexion.', 'error');
    } finally {
      setIsManualSyncing(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-28 select-none font-sans text-xs">
      {/* 1. Store Header & Cashier Shift Card */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center text-slate-950 font-black shadow-md shadow-emerald-500/20">
              <Store className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-black text-pos-text leading-tight">
                {receiptSettings.storeName || 'ACCESSOIRES MOBI'}
              </h2>
              <span className="text-[10px] text-pos-muted">
                {activeShift ? `Caisse ouverte par ${activeShift.cashierName}` : 'Caisse fermée'}
              </span>
            </div>
          </div>

          {activeShift ? (
            <button
              onClick={() => openModal('shift_close')}
              className="px-2.5 py-1 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-bold text-[10px] flex items-center gap-1 cursor-pointer"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>Clôturer</span>
            </button>
          ) : (
            <button
              onClick={() => openModal('shift_open')}
              className="px-2.5 py-1 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 font-bold text-[10px] flex items-center gap-1 cursor-pointer"
            >
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <span>Ouvrir</span>
            </button>
          )}
        </div>

        {/* Shift Cash Reconciliation & Z-Report Quick Buttons */}
        <div className="grid grid-cols-2 gap-2 pt-1 border-t border-pos-border/50">
          <button
            onClick={() => openModal('shift_zreport')}
            className="py-2 px-3 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-center gap-1.5 font-bold text-[11px] text-pos-text cursor-pointer transition"
          >
            <Receipt className="w-3.5 h-3.5 text-cyan-400" />
            <span>Rapport Z (Clôture)</span>
          </button>
          <button
            onClick={() => openModal('shift_movement')}
            className="py-2 px-3 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-center gap-1.5 font-bold text-[11px] text-pos-text cursor-pointer transition"
          >
            <DollarSign className="w-3.5 h-3.5 text-amber-400" />
            <span>Sortie de Caisse</span>
          </button>
        </div>
      </div>

      {/* 2. Today's Financial Overview */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-pos-text font-black text-xs">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <span>Aperçu du Jour</span>
          </div>
          <span className="text-[10px] text-pos-muted font-medium flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            Aujourd'hui
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="bg-pos-panel border border-pos-border rounded-xl p-2.5">
            <span className="text-[10px] text-pos-muted font-bold block">Chiffre d'Affaires</span>
            <span className="text-base font-black text-emerald-400 font-mono mt-0.5 block">
              {formatDZD(todayRevenue)}
            </span>
          </div>
          <div className="bg-pos-panel border border-pos-border rounded-xl p-2.5">
            <span className="text-[10px] text-pos-muted font-bold block">Ventes Validées</span>
            <span className="text-base font-black text-pos-text font-mono mt-0.5 block">
              {todayTransactions.length}
            </span>
          </div>
        </div>

        {/* Big Reports Modal Button */}
        <button
          type="button"
          onClick={() => openModal('reports')}
          className="w-full py-2.5 px-3 rounded-xl bg-gradient-to-r from-cyan-500/15 to-emerald-500/15 border border-cyan-500/30 hover:border-cyan-400 text-cyan-300 font-bold text-xs flex items-center justify-between transition cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-cyan-400" />
            <span>Rapports Financiers & Statistiques Complets</span>
          </div>
          <ChevronRight className="w-4 h-4 text-cyan-400" />
        </button>
      </div>

      {/* 3. Operational Modules Quick Access */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-2">
        <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider mb-1">
          Gestion Opérationnelle
        </h3>

        <button
          type="button"
          onClick={() => openModal('expense_manager')}
          className="w-full p-2.5 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer transition"
        >
          <div className="flex items-center gap-2.5">
            <DollarSign className="w-4 h-4 text-amber-400" />
            <span className="font-bold text-xs">Gestionnaire des Dépenses & Frais</span>
          </div>
          <ChevronRight className="w-4 h-4 text-pos-muted" />
        </button>

        <button
          type="button"
          onClick={() => openModal('inventory_manager')}
          className="w-full p-2.5 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer transition"
        >
          <div className="flex items-center gap-2.5">
            <Layers className="w-4 h-4 text-emerald-400" />
            <span className="font-bold text-xs">Inventaire & Stock ({products?.length || 0} articles)</span>
          </div>
          <ChevronRight className="w-4 h-4 text-pos-muted" />
        </button>

        <button
          type="button"
          onClick={() => openModal('settings')}
          className="w-full p-2.5 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer transition"
        >
          <div className="flex items-center gap-2.5">
            <Settings className="w-4 h-4 text-purple-400" />
            <span className="font-bold text-xs">Paramètres Généraux du Logiciel</span>
          </div>
          <ChevronRight className="w-4 h-4 text-pos-muted" />
        </button>
      </div>

      {/* 4. App Preferences (Theme, Sound, Multi-Tenant Cloud) */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-3">
        <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider">
          Préférences & Apparence
        </h3>

        {/* Theme Changer */}
        <div className="flex items-center justify-between py-1 border-b border-pos-border/40">
          <span className="font-medium text-pos-text flex items-center gap-2">
            {themeMode === 'dark' ? <Moon className="w-4 h-4 text-indigo-400" /> : <Sun className="w-4 h-4 text-amber-400" />}
            Thème de l'application
          </span>
          <button
            type="button"
            onClick={toggleTheme}
            className="px-3 py-1.5 rounded-xl bg-pos-panel border border-pos-border font-bold text-xs text-pos-text hover:border-cyan-400 transition cursor-pointer flex items-center gap-1.5"
          >
            <span>{themeMode === 'dark' ? 'Sombre' : 'Clair'}</span>
            <span className="text-[10px] text-pos-muted">(Basculer)</span>
          </button>
        </div>

        {/* Audio Sound FX */}
        <div className="flex items-center justify-between py-1 border-b border-pos-border/40">
          <span className="font-medium text-pos-text flex items-center gap-2">
            {isAudioMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4 text-emerald-400" />}
            Bips sonores de caisse
          </span>
          <button
            type="button"
            onClick={handleToggleSound}
            className="px-3 py-1.5 rounded-xl bg-pos-panel border border-pos-border font-bold text-xs text-pos-text hover:border-cyan-400 transition cursor-pointer"
          >
            {isAudioMuted ? 'Désactivés' : 'Activés'}
          </button>
        </div>

        {/* Cloud Credentials Reconfigure */}
        {onOpenPairingWizard && (
          <div className="flex items-center justify-between py-1">
            <span className="font-medium text-pos-text flex items-center gap-2">
              <Key className="w-4 h-4 text-cyan-400" />
              Identifiants Cloud Turso
            </span>
            <button
              type="button"
              onClick={onOpenPairingWizard}
              className="px-3 py-1.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 font-bold text-xs hover:bg-cyan-500/20 transition cursor-pointer"
            >
              Modifier
            </button>
          </div>
        )}
      </div>

      {/* 5. Cloud Sync Telemetry & Force Sync Card */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {syncStatus.online ? <Wifi className="w-4 h-4 text-emerald-400" /> : <WifiOff className="w-4 h-4 text-rose-400" />}
            <span className="font-bold text-pos-text text-xs">
              {syncStatus.online ? 'Synchronisation Cloud Active' : 'Mode Hors-Ligne'}
            </span>
          </div>
          <span className="text-[10px] text-pos-muted font-mono">
            {syncStatus.pendingCount > 0 ? `${syncStatus.pendingCount} en attente` : 'À jour'}
          </span>
        </div>

        <button
          type="button"
          disabled={isManualSyncing || syncStatus.pushing || syncStatus.pulling}
          onClick={handleForceSync}
          className="w-full py-2.5 px-3 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border active:scale-98 font-bold text-xs text-pos-text flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 ${isManualSyncing || syncStatus.pushing || syncStatus.pulling ? 'animate-spin' : ''}`} />
          <span>{isManualSyncing ? 'Synchronisation en cours...' : 'Forcer la Synchronisation'}</span>
        </button>
      </div>

      {/* 6. Switch to Desktop Full Mode */}
      <div className="pt-2 text-center">
        <button
          type="button"
          onClick={() => setRoleMode('pos_primary')}
          className="text-xs text-pos-muted hover:text-cyan-400 font-medium inline-flex items-center gap-1.5 transition cursor-pointer"
        >
          <Monitor className="w-3.5 h-3.5" />
          <span>Basculer vers le Mode Caisse Bureau (PC / Tablette)</span>
        </button>
      </div>
    </div>
  );
};

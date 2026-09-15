import React, { useState, useEffect, useMemo } from 'react';
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
  Layers,
  ShoppingBag,
  Clock,
  Sparkles,
  Camera,
  QrCode,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { useDeviceMode } from '../../../hooks/useDeviceMode';
import { syncManager } from '../../../sync/SyncManager';
import type { SyncStatus } from '../../../sync/types';
import { soundEngine } from '../../../utils/audioFeedback';
import { useToast } from '../../ui/Toast';
import { MoneyDisplay } from '../../ui/MoneyDisplay';

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
  const todayTransactions = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    return (transactions || []).filter((tx) => (tx.createdAt || '').startsWith(today));
  }, [transactions]);

  const todayRevenue = useMemo(() => {
    return todayTransactions.reduce((acc, tx) => acc + (tx.total || 0), 0);
  }, [todayTransactions]);

  const averageBasket = useMemo(() => {
    if (todayTransactions.length === 0) return 0;
    return Math.round(todayRevenue / todayTransactions.length);
  }, [todayRevenue, todayTransactions.length]);

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
      showToast(`Synchronisation réussie (${pullRes} éléments reçus).`, 'success');
    } catch {
      soundEngine.playError?.();
      showToast('Échec de synchronisation. Vérifiez votre connexion.', 'error');
    } finally {
      setIsManualSyncing(false);
    }
  };

  const handleSwitchToDesktop = () => {
    setRoleMode('pos_primary');
    showToast('Mode Bureau activé. Pivotez votre téléphone pour afficher la caisse.', 'info');
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3.5 pb-28 select-none font-sans text-xs">
      {/* 1. Store Header & Shift Banner */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center text-slate-950 font-black shadow-md shadow-emerald-500/20 shrink-0">
              <Store className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-black text-pos-text leading-tight truncate">
                {receiptSettings.storeName || 'ACCESSOIRES MOBI'}
              </h2>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    activeShift ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                  }`}
                />
                <span className="text-[11px] text-pos-muted truncate">
                  {activeShift ? `Caisse ouverte (${activeShift.cashierName})` : 'Caisse fermée'}
                </span>
              </div>
            </div>
          </div>

          {activeShift ? (
            <button
              type="button"
              onClick={() => openModal('shift_close')}
              className="px-3.5 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 font-bold text-xs shrink-0 cursor-pointer active:scale-95 transition"
            >
              Clôturer
            </button>
          ) : (
            <button
              type="button"
              onClick={() => openModal('shift_open')}
              className="px-3.5 py-2 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 font-bold text-xs shrink-0 cursor-pointer active:scale-95 transition"
            >
              Ouvrir Caisse
            </button>
          )}
        </div>

        {/* Quick Shift Reconciliation Buttons */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-pos-border/60">
          <button
            type="button"
            onClick={() => openModal('shift_zreport')}
            className="h-11 px-3 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-center gap-2 font-bold text-xs text-pos-text cursor-pointer active:scale-98 transition"
          >
            <Receipt className="w-4 h-4 text-cyan-400 shrink-0" />
            <span className="truncate">Rapport Z</span>
          </button>
          <button
            type="button"
            onClick={() => openModal('shift_movement')}
            className="h-11 px-3 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-center gap-2 font-bold text-xs text-pos-text cursor-pointer active:scale-98 transition"
          >
            <DollarSign className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="truncate">Sortie Caisse</span>
          </button>
        </div>
      </div>

      {/* 2. Today's Financial Overview (Anti-Overflow Money Boxes) */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-pos-text font-black text-xs">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <span>Aperçu d'Activité</span>
          </div>
          <span className="text-[10px] text-pos-muted font-semibold flex items-center gap-1 bg-pos-panel px-2 py-0.5 rounded-full border border-pos-border/50">
            <Clock className="w-3 h-3" />
            Aujourd'hui
          </span>
        </div>

        {/* KPI Metrics Grid with Anti-Overflow formatting */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="bg-pos-panel border border-pos-border rounded-xl p-3 flex flex-col justify-between min-w-0">
            <span className="text-[10px] text-pos-muted font-bold block uppercase tracking-wide truncate">
              Chiffre d'Affaires
            </span>
            <div className="mt-1 min-w-0 overflow-hidden">
              <MoneyDisplay
                amount={todayRevenue}
                size="lg"
                color="emerald"
                className="block"
              />
            </div>
            <span className="text-[10px] text-pos-muted/80 mt-1 truncate">
              Panier moy. : {averageBasket.toLocaleString('fr-DZ')} DA
            </span>
          </div>

          <div className="bg-pos-panel border border-pos-border rounded-xl p-3 flex flex-col justify-between min-w-0">
            <span className="text-[10px] text-pos-muted font-bold block uppercase tracking-wide truncate">
              Ventes Validées
            </span>
            <div className="mt-1 flex items-baseline gap-1.5 min-w-0">
              <span className="text-xl font-black text-pos-text font-mono tracking-tight">
                {todayTransactions.length}
              </span>
              <span className="text-xs text-pos-muted font-bold">tickets</span>
            </div>
            <span className="text-[10px] text-cyan-400/90 font-medium mt-1 truncate flex items-center gap-1">
              <ShoppingBag className="w-3 h-3" />
              Activité en direct
            </span>
          </div>
        </div>

        {/* Full Reports CTA Button */}
        <button
          type="button"
          onClick={() => openModal('reports')}
          className="w-full h-11 px-3.5 rounded-xl bg-gradient-to-r from-cyan-500/15 via-emerald-500/10 to-cyan-500/15 border border-cyan-500/30 hover:border-cyan-400 text-cyan-300 font-bold text-xs flex items-center justify-between transition cursor-pointer active:scale-98"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <BarChart3 className="w-4 h-4 text-cyan-400 shrink-0" />
            <span className="truncate">Rapports Financiers & Statistiques</span>
          </div>
          <ChevronRight className="w-4 h-4 text-cyan-400 shrink-0" />
        </button>
      </div>

      {/* 3. Operational Modules (Touch-friendly 48px targets) */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-2">
        <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider mb-1">
          Gestion & Modules
        </h3>

        <button
          type="button"
          onClick={() => openModal('inventory_manager')}
          className="w-full h-12 px-3.5 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
              <Layers className="w-4 h-4" />
            </div>
            <div className="text-left min-w-0">
              <span className="font-bold text-xs block text-pos-text truncate">Articles & Inventaire</span>
              <span className="text-[10px] text-pos-muted block truncate">{products?.length || 0} références en stock</span>
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => openModal('expense_manager')}
          className="w-full h-12 px-3.5 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center shrink-0">
              <DollarSign className="w-4 h-4" />
            </div>
            <div className="text-left min-w-0">
              <span className="font-bold text-xs block text-pos-text truncate">Dépenses & Frais Magasin</span>
              <span className="text-[10px] text-pos-muted block truncate">Suivi des charges & sorties</span>
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => openModal('settings')}
          className="w-full h-12 px-3.5 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-purple-500/15 text-purple-400 flex items-center justify-center shrink-0">
              <Settings className="w-4 h-4" />
            </div>
            <div className="text-left min-w-0">
              <span className="font-bold text-xs block text-pos-text truncate">Paramètres Généraux</span>
              <span className="text-[10px] text-pos-muted block truncate">Périphériques, tickets & sauvegarde</span>
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
        </button>
      </div>

      {/* 4. Quick Preferences (Theme, Sound, Cloud Pairing) */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-3">
        <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider">
          Préférences Rapides
        </h3>

        {/* Theme Changer */}
        <div className="flex items-center justify-between py-1 border-b border-pos-border/40">
          <span className="font-medium text-pos-text flex items-center gap-2.5">
            {themeMode === 'dark' ? (
              <Moon className="w-4 h-4 text-indigo-400" />
            ) : (
              <Sun className="w-4 h-4 text-amber-400" />
            )}
            <span>Thème visuel</span>
          </span>
          <button
            type="button"
            onClick={toggleTheme}
            className="h-8 px-3 rounded-xl bg-pos-panel border border-pos-border font-bold text-xs text-pos-text hover:border-cyan-400 active:scale-95 transition cursor-pointer flex items-center gap-1.5"
          >
            <span>{themeMode === 'dark' ? 'Sombre' : 'Clair'}</span>
          </button>
        </div>

        {/* Audio Sound FX */}
        <div className="flex items-center justify-between py-1 border-b border-pos-border/40">
          <span className="font-medium text-pos-text flex items-center gap-2.5">
            {isAudioMuted ? (
              <VolumeX className="w-4 h-4 text-rose-400" />
            ) : (
              <Volume2 className="w-4 h-4 text-emerald-400" />
            )}
            <span>Bips sonores</span>
          </span>
          <button
            type="button"
            onClick={handleToggleSound}
            className="h-8 px-3 rounded-xl bg-pos-panel border border-pos-border font-bold text-xs text-pos-text hover:border-cyan-400 active:scale-95 transition cursor-pointer"
          >
            {isAudioMuted ? 'Désactivés' : 'Activés'}
          </button>
        </div>

        {/* Cloud Credentials / QR Scan Shortcut */}
        {onOpenPairingWizard && (
          <div className="flex items-center justify-between py-1">
            <span className="font-medium text-pos-text flex items-center gap-2.5">
              <QrCode className="w-4 h-4 text-cyan-400" />
              <span>Lier une Caisse (Scanner QR)</span>
            </span>
            <button
              type="button"
              onClick={onOpenPairingWizard}
              className="h-8 px-3 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 text-slate-950 font-bold text-xs active:scale-95 transition cursor-pointer flex items-center gap-1.5 shadow-sm shadow-emerald-500/20"
            >
              <Camera className="w-3.5 h-3.5" />
              <span>Scanner</span>
            </button>
          </div>
        )}
      </div>

      {/* 5. Cloud Sync Telemetry */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {syncStatus.online ? (
              <Wifi className="w-4 h-4 text-emerald-400" />
            ) : (
              <WifiOff className="w-4 h-4 text-rose-400" />
            )}
            <span className="font-bold text-pos-text text-xs">
              {syncStatus.online ? 'Synchronisation Cloud Active' : 'Mode Hors-Ligne'}
            </span>
          </div>
          <span className="text-[10px] text-pos-muted font-mono bg-pos-panel px-2 py-0.5 rounded-md border border-pos-border/40">
            {syncStatus.pendingCount > 0 ? `${syncStatus.pendingCount} en attente` : 'À jour'}
          </span>
        </div>

        <button
          type="button"
          disabled={isManualSyncing || syncStatus.pushing || syncStatus.pulling}
          onClick={handleForceSync}
          className="w-full h-11 px-3 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border active:scale-98 font-bold text-xs text-pos-text flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
        >
          <RefreshCw
            className={`w-4 h-4 text-cyan-400 ${
              isManualSyncing || syncStatus.pushing || syncStatus.pulling ? 'animate-spin' : ''
            }`}
          />
          <span>{isManualSyncing ? 'Synchronisation en cours...' : 'Forcer la Synchronisation'}</span>
        </button>
      </div>

      {/* 6. Switch to PC View Banner (Smart Dynamic Orientation Guidance) */}
      <div className="bg-gradient-to-br from-indigo-500/10 via-purple-500/10 to-cyan-500/10 border border-indigo-500/20 rounded-2xl p-4 text-center space-y-2">
        <div className="flex items-center justify-center gap-1.5 text-indigo-300 font-black text-xs">
          <Sparkles className="w-4 h-4 text-cyan-400" />
          <span>Transformation en Caisse Complète</span>
        </div>
        <p className="text-[11px] text-pos-muted leading-relaxed">
          Basculez vers le mode caisse complet puis <strong className="text-pos-text">pivotez votre téléphone à l'horizontale</strong> pour scanner et encaisser comme sur un PC.
        </p>
        <button
          type="button"
          onClick={handleSwitchToDesktop}
          className="w-full h-11 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white font-black text-xs flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 active:scale-98 transition cursor-pointer"
        >
          <Monitor className="w-4 h-4" />
          <span>Basculer vers le Mode Bureau (PC)</span>
        </button>
      </div>
    </div>
  );
};

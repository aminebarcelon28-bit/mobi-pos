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
  Download,
  Truck,
  Wrench,
  Package,
  Smartphone,
  Sliders,
  ShieldAlert,
  Database,
  Key,
  Users,
  CreditCard,
  Barcode,
  FileText,
  RotateCcw,
  Unlock,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { AppTabContent } from '../AppScreenLayout';
import { useDeviceMode } from '../../../hooks/useDeviceMode';
import { PinDialog } from '../../ui/PinDialog';
// P11.3: sync engine loads on demand (static import pulls ~267 kB into entry).
import type { SyncStatus } from '../../../sync/types';
import { soundEngine } from '../../../utils/audioFeedback';
import { useToast } from '../../ui/Toast';
import { MoneyDisplay } from '../../ui/MoneyDisplay';
import { useAppUpdater } from '../../../hooks/useAppUpdater';
import { APP_VERSION } from '../../../types/pos';

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
    logSecurityAction,
  } = usePosStore();
  const { setRoleMode } = useDeviceMode();
  const { showToast } = useToast();
  const updater = useAppUpdater();

  const [isPinOpen, setIsPinOpen] = useState(false);

  const handleNoSaleDrawerOpen = () => {
    soundEngine.playKeyBeep?.();
    setIsPinOpen(true);
  };

  const handlePinSuccess = () => {
    soundEngine.playCashDrawer?.();
    if (logSecurityAction) {
      logSecurityAction(
        'Ouverture Manuelle Tiroir ("No Sale")',
        'Tiroir-caisse ouvert sans vente depuis mobile',
        'Caissier (Mobile)',
        true
      );
    }
    showToast('Ouverture manuelle du tiroir-caisse autorisée.', 'success');
    setIsPinOpen(false);
  };

  const handleCheckUpdatesMobile = async () => {
    soundEngine.playKeyBeep?.();
    showToast('Recherche des mises à jour...', 'info', 2000);
    const res = await updater.checkForUpdates(true);
    if (res.hasUpdate) {
      soundEngine.playSuccess?.();
      showToast(`🚀 Mise à jour v${res.version} disponible !`, 'info', 5000);
    } else if (res.success) {
      soundEngine.playSuccess?.();
      showToast(`✅ Votre application est à jour (Version v${APP_VERSION}).`, 'success', 4000);
    } else {
      soundEngine.playError?.();
      showToast(`Vérification : ${res.message}`, 'warning', 5000);
    }
  };

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
    let unsub: (() => void) | undefined;
    import('../../../sync/SyncManager')
      .then(({ syncManager }) => {
        unsub = syncManager.subscribe((s) => {
          setSyncStatus(s);
        });
      })
      .catch((err: unknown) => console.warn('[mgmt] sync engine unavailable:', err));
    return () => unsub?.();
  }, []);

  // Today's summary calculation
  const todayTransactions = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    return (transactions || []).filter(
      (tx) => (tx.createdAt || '').startsWith(today) && tx.status !== 'VOIDED' && !tx.isRefund,
    );
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
      const { syncManager } = await import('../../../sync/SyncManager');
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
    <AppTabContent contentClassName="px-3.5 py-3 select-none font-sans text-xs">
      <div className="space-y-3.5 pb-4">
        {/* 1. Store Header & Shift Banner */}
        <div className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center text-slate-950 font-black shadow-md shadow-emerald-500/20 shrink-0">
                <Store className="w-5 h-5 stroke-[2.5]" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-black text-pos-text leading-tight truncate">
                  {receiptSettings.storeName || 'ACCESSOIRES MOBI'}
                </h2>
                <div className="flex items-center gap-1.5 mt-1">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      activeShift ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                    }`}
                  />
                  <span className="text-[11px] text-pos-muted truncate font-medium">
                    {activeShift ? `Caisse ouverte (${activeShift.cashierName})` : 'Caisse fermée'}
                  </span>
                </div>
              </div>
            </div>

            {activeShift ? (
              <button
                type="button"
                onClick={() => openModal('shift_close')}
                className="min-h-[40px] px-3.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 font-bold text-xs shrink-0 cursor-pointer active:scale-95 transition"
              >
                Clôturer
              </button>
            ) : (
              <button
                type="button"
                onClick={() => openModal('shift_open')}
                className="min-h-[40px] px-3.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 font-bold text-xs shrink-0 cursor-pointer active:scale-95 transition"
              >
                Ouvrir Caisse
              </button>
            )}
          </div>

          {/* Quick Shift Actions — 3 Ergonomic Buttons */}
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-pos-border/60">
            <button
              type="button"
              onClick={() => openModal('shift_zreport')}
              className="min-h-[44px] px-2 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex flex-col items-center justify-center gap-1 font-bold text-[11px] text-pos-text cursor-pointer active:scale-98 transition shadow-xs"
            >
              <Receipt className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span className="truncate">Rapport Z</span>
            </button>
            <button
              type="button"
              onClick={() => openModal('shift_movement')}
              className="min-h-[44px] px-2 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex flex-col items-center justify-center gap-1 font-bold text-[11px] text-pos-text cursor-pointer active:scale-98 transition shadow-xs"
            >
              <DollarSign className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="truncate">Sortie Caisse</span>
            </button>
            <button
              type="button"
              onClick={handleNoSaleDrawerOpen}
              className="min-h-[44px] px-2 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex flex-col items-center justify-center gap-1 font-bold text-[11px] text-pos-text cursor-pointer active:scale-98 transition shadow-xs"
              title="Ouvrir le tiroir-caisse sans vente (Code PIN requis)"
            >
              <Unlock className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate">Ouvrir Tiroir</span>
            </button>
          </div>
        </div>

        {/* 2. Today's Financial Overview */}
        <div className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-pos-text font-black text-xs">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <span>Aperçu d'Activité</span>
            </div>
            <span className="text-[10px] text-pos-muted font-bold flex items-center gap-1 bg-pos-panel px-2.5 py-0.5 rounded-full border border-pos-border/50">
              <Clock className="w-3 h-3 text-cyan-400" />
              Aujourd'hui
            </span>
          </div>

          {/* KPI Metrics Grid with Anti-Overflow formatting */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="bg-pos-panel border border-pos-border rounded-2xl p-3 flex flex-col justify-between min-w-0">
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

            <div className="bg-pos-panel border border-pos-border rounded-2xl p-3 flex flex-col justify-between min-w-0">
              <span className="text-[10px] text-pos-muted font-bold block uppercase tracking-wide truncate">
                Ventes Validées
              </span>
              <div className="mt-1 flex items-baseline gap-1.5 min-w-0">
                <span className="text-xl font-black text-pos-text font-mono tracking-tight">
                  {todayTransactions.length}
                </span>
                <span className="text-xs text-pos-muted font-bold">tickets</span>
              </div>
              <span className="text-[10px] text-cyan-400 font-medium mt-1 truncate flex items-center gap-1">
                <ShoppingBag className="w-3 h-3" />
                Activité en direct
              </span>
            </div>
          </div>

          {/* Full Reports CTA Button */}
          <button
            type="button"
            onClick={() => openModal('reports')}
            className="w-full min-h-[46px] px-3.5 rounded-2xl bg-gradient-to-r from-cyan-500/15 via-emerald-500/10 to-cyan-500/15 border border-cyan-500/30 hover:border-cyan-400 text-cyan-300 font-bold text-xs flex items-center justify-between transition cursor-pointer active:scale-98 shadow-xs"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <BarChart3 className="w-4 h-4 text-cyan-400 shrink-0" />
              <span className="truncate font-black">Rapports Financiers & Statistiques (F9)</span>
            </div>
            <ChevronRight className="w-4 h-4 text-cyan-400 shrink-0" />
          </button>
        </div>

        {/* 3. Services Atelier, SAV & Reprises (100% Desktop Parity) */}
        <div className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-2">
          <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider mb-1 px-1 flex items-center justify-between">
            <span>Atelier, SAV & Reprises</span>
            <span className="text-[9px] bg-cyan-500/10 text-cyan-400 font-bold px-2 py-0.5 rounded border border-cyan-500/20">
              SERVICES
            </span>
          </h3>

          <button
            type="button"
            onClick={() => openModal('repair_work_order')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center shrink-0">
                <Wrench className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Réparations & SAV Atelier</span>
                <span className="text-[10px] text-pos-muted block truncate">Fiches de réparation, diagnostics & devis</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('trade_in_buyback')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-cyan-500/15 text-cyan-400 flex items-center justify-center shrink-0">
                <RefreshCw className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Reprise Occasion (Trade-In)</span>
                <span className="text-[10px] text-pos-muted block truncate">Évaluation d'état, rachat cash & bon d'achat</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('kitting_bundle')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-purple-500/15 text-purple-400 flex items-center justify-center shrink-0">
                <Package className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Packs & Bundles d'Articles</span>
                <span className="text-[10px] text-pos-muted block truncate">Composition d'offres groupées (Téléphone + Accessoires)</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('imei_inspector')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center shrink-0">
                <Smartphone className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Traçabilité IMEI & Garantie</span>
                <span className="text-[10px] text-pos-muted block truncate">Recherche d'historique de garantie par IMEI</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('compatibility')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Compatibilité Accessoires</span>
                <span className="text-[10px] text-pos-muted block truncate">Trouver verres trempés & coques par modèle</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('refund')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-rose-500/15 text-rose-400 flex items-center justify-center shrink-0">
                <RotateCcw className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Retours & Remboursements (F11)</span>
                <span className="text-[10px] text-pos-muted block truncate">Restitution d'articles et annulations de ventes</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('command_tickets')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center shrink-0">
                <Clock className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Commandes & Ventes Suspendues</span>
                <span className="text-[10px] text-pos-muted block truncate">File d'attente clients et tickets en pause</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>
        </div>

        {/* 4. Gestion des Stocks & Fournisseurs */}
        <div className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-2">
          <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider mb-1 px-1">
            Stocks & Fournisseurs
          </h3>

          <button
            type="button"
            onClick={() => openModal('inventory_manager')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                <Layers className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Articles & Inventaire (F10)</span>
                <span className="text-[10px] text-pos-muted block truncate font-mono">{products?.length || 0} références en stock</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('vendor_procurement')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-teal-500/15 text-teal-400 flex items-center justify-center shrink-0">
                <Truck className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Fournisseurs & Réapprovisionnement</span>
                <span className="text-[10px] text-pos-muted block truncate">Commandes grossistes & alertes stock</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('invoice_ingestion')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                <FileText className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Ingestion Facture Fournisseur</span>
                <span className="text-[10px] text-pos-muted block truncate">Import automatique de factures d'achat</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('label_printer')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                <Barcode className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Étiquettes Codes-barres</span>
                <span className="text-[10px] text-pos-muted block truncate">Impression thermique de prix & références</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>
        </div>

        {/* 5. Finances & CRM Clients */}
        <div className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-2">
          <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider mb-1 px-1">
            Finances & Clients
          </h3>

          <button
            type="button"
            onClick={() => openModal('customers')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-blue-500/15 text-blue-400 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">CRM & Fichier Clients (F3)</span>
                <span className="text-[10px] text-pos-muted block truncate">Gestion des comptes, plafonds & fidélité</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('debt_ledger')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-rose-500/15 text-rose-400 flex items-center justify-center shrink-0">
                <CreditCard className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Grand Livre des Dettes (Kredy)</span>
                <span className="text-[10px] text-pos-muted block truncate">Registre des créances & encaissement remboursements</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('expense_manager')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center shrink-0">
                <DollarSign className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Dépenses & Frais Magasin</span>
                <span className="text-[10px] text-pos-muted block truncate">Charges, loyer, salaires & sorties de caisse</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>
        </div>

        {/* 6. Configuration & Système */}
        <div className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-2">
          <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider mb-1 px-1">
            Configuration, Caisse & Sécurité
          </h3>

          <button
            type="button"
            onClick={() => openModal('settings')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-purple-500/15 text-purple-400 flex items-center justify-center shrink-0">
                <Settings className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Paramètres Généraux (F12)</span>
                <span className="text-[10px] text-pos-muted block truncate">Périphériques, tickets, base & synchronisation</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('receipt_template')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-pos-bg text-pos-muted flex items-center justify-center shrink-0">
                <Sliders className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Modèle de Ticket de Caisse</span>
                <span className="text-[10px] text-pos-muted block truncate">Entête, logo, mentions légales & pied de ticket</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('security_audit')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Journal d'Audit Sécurité</span>
                <span className="text-[10px] text-pos-muted block truncate">Traçabilité des dérogations et codes PIN</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('db_maintenance')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-cyan-500/15 text-cyan-400 flex items-center justify-center shrink-0">
                <Database className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Maintenance Base SQLite WAL</span>
                <span className="text-[10px] text-pos-muted block truncate">Nettoyage, vacuum, checkpoint et intégrité</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => openModal('licensing')}
            className="w-full min-h-[50px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-purple-500/15 text-purple-400 flex items-center justify-center shrink-0">
                <Key className="w-4 h-4" />
              </div>
              <div className="text-left min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">Licence & Activation</span>
                <span className="text-[10px] text-pos-muted block truncate">Clé de licence et statut d'enregistrement</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0" />
          </button>

          {/* Cloud Pairing / QR Scan Shortcut */}
          {onOpenPairingWizard && (
            <div className="flex items-center justify-between p-3 rounded-2xl bg-pos-panel border border-pos-border">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-cyan-500/15 text-cyan-400 flex items-center justify-center shrink-0">
                  <QrCode className="w-4 h-4" />
                </div>
                <div className="text-left min-w-0">
                  <span className="font-bold text-xs block text-pos-text truncate">Lier une Caisse</span>
                  <span className="text-[10px] text-pos-muted block truncate">Scanner QR code de synchronisation</span>
                </div>
              </div>
              <button
                type="button"
                onClick={onOpenPairingWizard}
                className="min-h-[38px] px-3 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 text-slate-950 font-bold text-xs active:scale-95 transition cursor-pointer flex items-center gap-1.5 shadow-sm shadow-emerald-500/20 shrink-0"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>Scanner</span>
              </button>
            </div>
          )}
        </div>

        {/* 5. Preferences & Settings */}
        <div className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-3">
          <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider px-1">
            Préférences Rapides
          </h3>

          {/* Theme Changer */}
          <div className="flex items-center justify-between py-1 border-b border-pos-border/40">
            <span className="font-bold text-pos-text flex items-center gap-2.5">
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
              className="min-h-[36px] px-3 rounded-xl bg-pos-panel border border-pos-border font-bold text-xs text-pos-text hover:border-cyan-400 active:scale-95 transition cursor-pointer flex items-center gap-1.5"
            >
              <span>{themeMode === 'dark' ? 'Sombre' : 'Clair'}</span>
            </button>
          </div>

          {/* Audio Sound FX */}
          <div className="flex items-center justify-between py-1 border-b border-pos-border/40">
            <span className="font-bold text-pos-text flex items-center gap-2.5">
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
              className="min-h-[36px] px-3 rounded-xl bg-pos-panel border border-pos-border font-bold text-xs text-pos-text hover:border-cyan-400 active:scale-95 transition cursor-pointer"
            >
              {isAudioMuted ? 'Désactivés' : 'Activés'}
            </button>
          </div>

          {/* Cloud Sync Telemetry */}
          <div className="space-y-2 pt-1">
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
              <span className="text-[10px] text-pos-muted font-mono bg-pos-panel px-2.5 py-0.5 rounded-full border border-pos-border/40">
                {syncStatus.pendingCount > 0 ? `${syncStatus.pendingCount} en attente` : 'À jour'}
              </span>
            </div>

            <button
              type="button"
              disabled={isManualSyncing || syncStatus.pushing || syncStatus.pulling}
              onClick={handleForceSync}
              className="w-full min-h-[44px] px-3 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border active:scale-98 font-bold text-xs text-pos-text flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-4 h-4 text-cyan-400 ${
                  isManualSyncing || syncStatus.pushing || syncStatus.pulling ? 'animate-spin' : ''
                }`}
              />
              <span>{isManualSyncing ? 'Synchronisation en cours...' : 'Forcer la Synchronisation'}</span>
            </button>
          </div>
        </div>

        {/* 6. Software Updates */}
        <div className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-purple-500/15 text-purple-400 flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <span className="font-bold text-pos-text text-xs block">Mise à Jour MobiPOS</span>
                <span className="text-[10px] text-pos-muted block font-mono">Version installée : v{APP_VERSION}</span>
              </div>
            </div>
            <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              Canal Stable
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={updater.isChecking}
              onClick={handleCheckUpdatesMobile}
              className="flex-1 min-h-[42px] px-3 rounded-xl bg-purple-600 hover:bg-purple-500 active:scale-98 font-bold text-xs text-white flex items-center justify-center gap-2 transition cursor-pointer shadow-md shadow-purple-600/20 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-white ${updater.isChecking ? 'animate-spin' : ''}`} />
              <span>{updater.isChecking ? 'Vérification...' : 'Vérifier Mises à Jour'}</span>
            </button>

            <a
              href="https://github.com/aminebarcelon28-bit/mobi-pos/releases/latest/download/MobiPOS-Android.apk"
              download="MobiPOS-Android.apk"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                soundEngine.playKeyBeep?.();
                showToast("Téléchargement de l'APK Android démarré...", 'info');
              }}
              className="min-h-[42px] px-3 rounded-xl bg-emerald-500/15 border border-emerald-500/40 hover:bg-emerald-500/25 text-emerald-300 font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 no-underline shrink-0 cursor-pointer"
              title="Télécharger directement le fichier APK"
            >
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              <span>APK Direct</span>
            </a>
          </div>

          {updater.checkStatusMessage && (
            <p className="text-[10px] text-pos-muted font-medium bg-pos-panel/60 p-2.5 rounded-xl border border-pos-border/40 text-center">
              {updater.checkStatusMessage}
            </p>
          )}
        </div>

        {/* 7. Switch to PC View Banner */}
        <div className="bg-gradient-to-br from-indigo-500/15 via-purple-500/10 to-cyan-500/10 border border-indigo-500/30 rounded-3xl p-4 text-center space-y-2.5">
          <div className="flex items-center justify-center gap-1.5 text-indigo-300 font-black text-xs">
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <span>Transformation en Caisse Complète</span>
          </div>
          <p className="text-[11px] text-pos-muted leading-relaxed max-w-sm mx-auto">
            Basculez vers le mode caisse complet puis <strong className="text-pos-text">pivotez votre téléphone à l'horizontale</strong> pour scanner et encaisser comme sur un PC.
          </p>
          <button
            type="button"
            onClick={handleSwitchToDesktop}
            className="w-full min-h-[46px] rounded-2xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white font-black text-xs flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 active:scale-98 transition cursor-pointer"
          >
            <Monitor className="w-4 h-4" />
            <span>Basculer vers le Mode Bureau (PC)</span>
          </button>
        </div>

        {/* PIN Verification Modal for No-Sale Drawer Open */}
        <PinDialog
          isOpen={isPinOpen}
          title="Autorisation Tiroir 'No Sale'"
          description="Saisissez le code PIN Manager pour ouvrir le tiroir-caisse sans vente."
          onSuccess={handlePinSuccess}
          onCancel={() => setIsPinOpen(false)}
        />
      </div>
    </AppTabContent>
  );
};

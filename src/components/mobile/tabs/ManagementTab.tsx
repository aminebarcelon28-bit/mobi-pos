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
  Printer,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { AppTabContent } from '../AppScreenLayout';
import { useDeviceMode } from '../../../hooks/useDeviceMode';
import { PinDialog } from '../../ui/PinDialog';
import { canSeeJournalLauncher } from '../../../utils/auditGate';
import { MobilePrinterModal } from '../MobilePrinterModal';
import { loadMobilePrinter } from '../../../utils/mobilePrinter';
// P11.3: sync engine loads on demand (static import pulls ~267 kB into entry).
import type { SyncStatus } from '../../../sync/types';
import { soundEngine } from '../../../utils/audioFeedback';
import { useToast } from '../../ui/Toast';
import { MoneyDisplay } from '../../ui/MoneyDisplay';
import { useAppUpdater } from '../../../hooks/useAppUpdater';
import type { SaleTransaction } from '../../../types/pos';
import { APP_VERSION } from '../../../types/pos';
import { todayLocalKey, toLocalDayKey } from '../../../utils/dateUtils';
import { computeSalesMetrics } from '../../../utils/receiptMath';
import { useAllocationCogs } from '../../../hooks/useAllocationCogs';
import { useTranslation, Bdi } from '../../../i18n';
import { resolvePrinterForDocument } from '../../../utils/printerRoutingEngine';
import { openCashDrawerViaSpooler } from '../../../utils/escpos';

export interface ManagementTabProps {
  onOpenPairingWizard?: () => void;
  onOpenDiagnostics?: () => void;
}

export const ManagementTab: React.FC<ManagementTabProps> = ({
  onOpenPairingWizard,
  onOpenDiagnostics,
}) => {
  const {
    openModal,
    transactions,
    activeShift,
    receiptSettings,
    themeMode,
    toggleTheme,
    products,
    logSecurityAction,
    repairOrders,
    activeCashier,
  } = usePosStore();
  const { t, locale, toggleLocale } = useTranslation();

  const mgmtSections = useMemo(
    () => [
      { id: 'mgmt-diagnostic', label: t.management.sectionDiagnostics },
      { id: 'mgmt-caisse', label: t.management.sectionRegister },
      { id: 'mgmt-facture-hero', label: `📸 ${t.management.sectionAiInvoice}` },
      { id: 'mgmt-activite', label: t.management.sectionActivity },
      { id: 'mgmt-atelier', label: t.management.sectionWorkshop },
      { id: 'mgmt-stocks', label: t.management.sectionStock },
      { id: 'mgmt-finances', label: t.management.sectionFinances },
      { id: 'mgmt-config', label: t.management.sectionConfig },
      { id: 'mgmt-prefs', label: t.management.sectionPreferences },
      { id: 'mgmt-maj', label: locale === 'fr' ? 'MàJ' : t.management.sectionUpdates },
    ],
    [t, locale],
  );
  const pendingRepairsCount = useMemo(
    () =>
      (repairOrders || []).filter(
        (r) => r.status === 'Diagnostic' || r.status === 'En attente de pièces' || r.status === 'En cours'
      ).length,
    [repairOrders]
  );
  const { setRoleMode } = useDeviceMode();
  const { showToast } = useToast();
  const updater = useAppUpdater();
  // Label printing rides the desktop ESC/POS path; on mobile the modal
  // renders labels to PNG and opens the Android print sheet instead.

  const [isPinOpen, setIsPinOpen] = useState(false);
  const [isPrinterModalOpen, setIsPrinterModalOpen] = useState(false);
  const mobilePrinter = useMemo(() => {
    void isPrinterModalOpen;
    return loadMobilePrinter();
  }, [isPrinterModalOpen]);

  const handleNoSaleDrawerOpen = () => {
    soundEngine.playKeyBeep?.();
    setIsPinOpen(true);
  };

  const handlePinSuccess = () => {
    soundEngine.playCashDrawer?.();
    const actor = activeCashier?.name?.trim() || 'Caissier (Mobile)';
    if (logSecurityAction) {
      logSecurityAction(
        'Ouverture Manuelle Tiroir ("No Sale")',
        'Tiroir-caisse ouvert sans vente depuis mobile',
        actor,
        true
      );
    }
    try {
      const targetPrinter = resolvePrinterForDocument('receipt', receiptSettings?.printerRouting);
      void openCashDrawerViaSpooler(targetPrinter.printerName);
    } catch (drawerErr) {
      console.warn('[ManagementTab] Cash drawer pulse error:', drawerErr);
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
    let cancelled = false;
    let unsub: (() => void) | undefined;
    import('../../../sync/SyncManager')
      .then(({ syncManager }) => {
        if (cancelled) return;
        unsub = syncManager.subscribe((s) => {
          setSyncStatus(s);
        });
      })
      .catch((err: unknown) => console.warn('[mgmt] sync engine unavailable:', err));
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  // UPGRADE-01: today's till metrics must count the COMPLETE day, not the
  // newest 200 tickets — read today's range from SQLite (display authority for
  // the window stays the store). Refetches when the window identity changes
  // (new sale, pull) so the morning read can't go stale.
  const [todayTxns, setTodayTxns] = useState<SaleTransaction[] | null>(null);
  useEffect(() => {
    let alive = true;
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    (async () => {
      try {
        const { sqliteAdapter } = await import('../../../db/sqliteAdapter');
        const list = await sqliteAdapter.getTransactionsByDateRange({
          from: new Date(from.getTime() - 12 * 3600 * 1000).toISOString(),
        });
        if (alive) setTodayTxns(list);
      } catch (e) {
        console.warn('[management] today range read failed, using window:', e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [transactions]);

  // Today's summary — canonical unified metrics (same formula as Desktop
  // ReportsModal + LiveActivityTab): CA Net = Σ net(valid) − Σ refunds.
  // The previous code summed Σ total(valid) without subtracting refund
  // vouchers, overstating today's CA whenever a refund exists.
  const todayTransactions = useMemo(() => {
    const today = todayLocalKey();
    return (todayTxns ?? transactions ?? []).filter(
      (tx) => toLocalDayKey(tx.createdAt || '') === today && tx.status !== 'VOIDED',
    );
  }, [todayTxns, transactions]);

  // STRICT FIFO LEDGER (v104): frozen allocation COGS wins per sale.
  const { allocCogsBySaleId } = useAllocationCogs();
  const todayMetrics = useMemo(
    () => computeSalesMetrics(todayTransactions, { allocCogsBySaleId }),
    [todayTransactions, allocCogsBySaleId]
  );

  const todayRevenue = todayMetrics.netRevenue;

  const averageBasket = todayMetrics.averageBasket;

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

  // Sticky mini-nav: scrolls the tab's scroll region to the section (display only).
  const scrollToSection = (id: string) => {
    soundEngine.playKeyBeep?.();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Display-only "last successful sync" (the freshest of push/pull, existing values).
  const lastSyncAt = syncStatus.lastPushAt ?? syncStatus.lastPullAt;
  const lastSyncLabel = lastSyncAt
    ? new Date(lastSyncAt).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  const handleOpenDiagnosticsView = () => {
    soundEngine.playKeyBeep?.();
    onOpenDiagnostics?.();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mobi:navigate-tab', { detail: 'diagnostics' }));
    }
  };

  return (
    <AppTabContent
      contentClassName="px-3.5 py-3 select-none font-sans text-xs"
      pinnedTop={
        <nav
          aria-label={t.management.sectionsNavAria}
          className="px-3.5 pt-2.5 pb-2 bg-pos-bg border-b border-pos-border/60"
        >
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
            {mgmtSections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => scrollToSection(s.id)}
                className="min-h-[48px] px-3.5 rounded-xl bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text hover:border-cyan-400/50 font-bold text-[11px] whitespace-nowrap shrink-0 transition cursor-pointer active:scale-95"
              >
                {s.label}
              </button>
            ))}
          </div>
        </nav>
      }
    >
      <div className="space-y-3.5 pb-4">
        {/* 0. Primary Entry Point to SyncDiagnosticsTab (ADR-001) */}
        <div
          id="mgmt-diagnostic"
          className="bg-gradient-to-br from-cyan-500/15 via-pos-card to-pos-panel border border-cyan-500/35 rounded-3xl p-4 shadow-sm space-y-2.5 scroll-mt-2"
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-9 h-9 rounded-2xl bg-cyan-500/20 border border-cyan-500/30 text-cyan-700 dark:text-cyan-400 flex items-center justify-center shrink-0">
                <Database className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="text-xs font-black text-pos-text leading-tight truncate">
                  {t.management.systemDiagnosticsCardTitle}
                </h2>
                <p className="text-[10px] text-pos-muted truncate">
                  {t.management.systemDiagnosticsCardSubtitle}
                </p>
              </div>
            </div>
            <span
              className={`text-[10px] font-black px-2.5 py-0.5 rounded-full border shrink-0 ${
                !syncStatus.online
                  ? 'pos-status-danger'
                  : syncStatus.pendingCount > 0
                  ? 'pos-status-warn'
                  : 'pos-status-ok'
              }`}
            >
              <Bdi>
                {!syncStatus.online
                  ? t.header.offline
                  : syncStatus.pendingCount > 0
                  ? t('header.pendingCount', { count: syncStatus.pendingCount })
                  : t.header.online}
              </Bdi>
            </span>
          </div>

          <button
            type="button"
            onClick={handleOpenDiagnosticsView}
            aria-label={`${t.management.systemDiagnosticsCardTitle} — ${t.management.systemDiagnosticsCardSubtitle}`}
            className="w-full min-h-[48px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-cyan-500/40 text-cyan-800 dark:text-cyan-300 font-black text-xs flex items-center justify-between transition cursor-pointer active:scale-98 shadow-xs"
          >
            <span className="flex items-center gap-2 min-w-0">
              <RefreshCw
                className={`w-4 h-4 text-cyan-700 dark:text-cyan-400 shrink-0 ${
                  syncStatus.pushing || syncStatus.pulling ? 'animate-spin' : ''
                }`}
                aria-hidden="true"
              />
              <span className="truncate">{t.management.systemDiagnosticsCardTitle}</span>
            </span>
            <ChevronRight className="w-4 h-4 text-cyan-700 dark:text-cyan-400 shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>
        </div>

        {/* 1. Store Header & Shift Banner */}
        <div id="mgmt-caisse" className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-3 scroll-mt-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center text-slate-950 font-black shadow-md shadow-emerald-500/20 shrink-0">
                <Store className="w-5 h-5 stroke-[2.5]" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-black text-pos-text leading-tight truncate">
                  {receiptSettings.storeName || 'ACCESSOIRES MOBI'}
                </h2>
                <div className="flex items-center gap-1.5 mt-1">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      activeShift ? 'bg-emerald-500 dark:bg-emerald-400 animate-pulse' : 'bg-amber-500 dark:bg-amber-400'
                    }`}
                  />
                  <span className="text-[11px] text-pos-muted truncate font-medium">
                    {activeShift
                      ? t('management.registerOpenStatus', { name: activeShift.cashierName })
                      : t.management.registerClosedStatus}
                  </span>
                </div>
              </div>
            </div>

            {activeShift ? (
              <button
                type="button"
                onClick={() => openModal('shift_close')}
                className="min-h-[48px] px-3.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-800 dark:text-emerald-300 font-bold text-xs shrink-0 cursor-pointer active:scale-95 transition"
                title="Ouvrir le récapitulatif de clôture (confirmation demandée avant validation)"
              >
                {t.management.closeRegisterButton}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => openModal('shift_open')}
                className="min-h-[48px] px-3.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-800 dark:text-amber-300 font-bold text-xs shrink-0 cursor-pointer active:scale-95 transition"
              >
                {t.management.openRegisterButton}
              </button>
            )}
          </div>

          {/* Quick Shift Actions — 3 Ergonomic Buttons */}
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-pos-border/60">
            <button
              type="button"
              onClick={() => openModal('shift_zreport')}
              className="min-h-[48px] px-2 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex flex-col items-center justify-center gap-1 font-bold text-[11px] text-pos-text cursor-pointer active:scale-98 transition shadow-xs"
            >
              <Receipt className="w-3.5 h-3.5 text-cyan-700 dark:text-cyan-400 shrink-0" aria-hidden="true" />
              <span className="truncate">{t.management.zReportButton}</span>
            </button>
            <button
              type="button"
              onClick={() => openModal('shift_movement')}
              className="min-h-[48px] px-2 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex flex-col items-center justify-center gap-1 font-bold text-[11px] text-pos-text cursor-pointer active:scale-98 transition shadow-xs"
            >
              <DollarSign className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400 shrink-0" aria-hidden="true" />
              <span className="truncate">{t.management.cashOutButton}</span>
            </button>
            <button
              type="button"
              onClick={handleNoSaleDrawerOpen}
              className="min-h-[48px] px-2 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex flex-col items-center justify-center gap-1 font-bold text-[11px] text-pos-text cursor-pointer active:scale-98 transition shadow-xs"
              title="Ouvrir le tiroir-caisse sans vente (Code PIN requis)"
            >
              <Unlock className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
              <span className="truncate">{t.management.openDrawerButton}</span>
            </button>
          </div>
        </div>

        {/* HERO QUICK ACTION: Direct 1-Tap Invoice & BL Scanner */}
        <div id="mgmt-facture-hero" className="bg-gradient-to-r from-emerald-500/15 via-teal-500/10 to-cyan-500/15 border-2 border-emerald-500/40 rounded-3xl p-4 shadow-sm space-y-3 scroll-mt-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative w-11 h-11 rounded-2xl bg-emerald-500 text-slate-950 flex items-center justify-center font-black shadow-md shadow-emerald-500/25 shrink-0">
                <Camera className="w-5 h-5" aria-hidden="true" />
                <span className="absolute -top-1 -end-1 w-3 h-3 rounded-full bg-cyan-400 ring-2 ring-pos-panel animate-ping" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <h3 className="text-xs font-black text-pos-text leading-tight truncate">
                    {t.management.aiInvoiceHeroTitle}
                  </h3>
                  <span className="text-[9px] font-black uppercase tracking-wider bg-emerald-500 text-slate-950 px-1.5 py-0.5 rounded-full shrink-0">
                    {t.management.newBadge}
                  </span>
                </div>
                <p className="text-[10px] text-pos-muted line-clamp-2 mt-0.5 font-medium">
                  {t.management.aiInvoiceHeroSubtitle}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                soundEngine.playKeyBeep?.();
                openModal('invoice_ingestion');
              }}
              className="min-h-[48px] px-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs shrink-0 cursor-pointer active:scale-95 transition shadow-sm shadow-emerald-500/20 flex items-center gap-1.5"
              title="Ouvrir le scanner de documents et factures"
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>{t.management.scanButton}</span>
            </button>
          </div>
        </div>

        {/* 2. Today's Financial Overview */}
        <div id="mgmt-activite" className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-3 scroll-mt-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-pos-text font-black text-xs">
              <TrendingUp className="w-4 h-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
              <span>{t.management.activityOverviewTitle}</span>
            </div>
            <span className="text-[10px] text-pos-muted font-bold flex items-center gap-1 bg-pos-panel px-2.5 py-0.5 rounded-full border border-pos-border/50">
              <Clock className="w-3 h-3 text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
              {t.activity.periodToday}
            </span>
          </div>

          {/* KPI Metrics Grid with Anti-Overflow formatting */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="bg-pos-panel border border-pos-border rounded-2xl p-3 flex flex-col justify-between min-w-0">
              <span className="text-[10px] text-pos-muted font-bold block uppercase tracking-wide truncate">
                {t.management.revenueLabel}
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
                {todayMetrics.validCount === 0 ? (
                  t.management.noSaleTodayHint
                ) : (
                  <Bdi mono>{t('management.avgBasketPrefix', { amount: `${averageBasket.toLocaleString('fr-DZ')} DA` })}</Bdi>
                )}
              </span>
            </div>

            <div className="bg-pos-panel border border-pos-border rounded-2xl p-3 flex flex-col justify-between min-w-0">
              <span className="text-[10px] text-pos-muted font-bold block uppercase tracking-wide truncate">
                {t.management.validatedSalesLabel}
              </span>
              <div className="mt-1 flex items-baseline gap-1.5 min-w-0">
                <Bdi mono className="text-xl font-black text-pos-text tracking-tight">
                  {todayMetrics.validCount}
                </Bdi>
                <span className="text-xs text-pos-muted font-bold">{t.activity.ticketsCountSuffix}</span>
              </div>
              <span className="text-[10px] text-cyan-700 dark:text-cyan-400 font-medium mt-1 truncate flex items-center gap-1">
                <ShoppingBag className="w-3 h-3 shrink-0" aria-hidden="true" />
                {todayMetrics.validCount === 0 ? t.management.waitingFirstTicket : t.management.liveActivityStatus}
              </span>
            </div>
          </div>

          {/* Full Reports CTA Button */}
          <button
            type="button"
            onClick={() => openModal('reports')}
            className="w-full min-h-[48px] px-3.5 rounded-2xl bg-gradient-to-r from-cyan-500/15 via-emerald-500/10 to-cyan-500/15 border border-cyan-500/30 hover:border-cyan-400 text-cyan-800 dark:text-cyan-300 font-bold text-xs flex items-center justify-between transition cursor-pointer active:scale-98 shadow-xs"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <BarChart3 className="w-4 h-4 text-cyan-700 dark:text-cyan-400 shrink-0" aria-hidden="true" />
              <span className="truncate font-black">
                {t.management.fullReportsButton} <span className="hidden sm:inline font-mono font-medium">(F9)</span>
              </span>
            </div>
            <ChevronRight className="w-4 h-4 text-cyan-700 dark:text-cyan-400 shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>
        </div>

        {/* 3. Services Atelier, SAV & Reprises (100% Desktop Parity) */}
        <div id="mgmt-atelier" className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-2 scroll-mt-2">
          <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider mb-1 px-1 flex items-center justify-between">
            <span>{t.management.workshopSectionTitle}</span>
            <span className="text-[9px] pos-status-info font-bold px-2 py-0.5 rounded border">
              SERVICES
            </span>
          </h3>

          <button
            type="button"
            onClick={() => openModal('repair_work_order')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-400 flex items-center justify-center shrink-0">
                <Wrench className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs flex items-center gap-1.5 text-pos-text truncate">
                  {t.management.repairsItemTitle}
                  {pendingRepairsCount > 0 && (
                    <span className="text-[10px] font-black pos-status-warn border rounded-full px-2 py-0.5">
                      <Bdi>{pendingRepairsCount > 9 ? '9+' : pendingRepairsCount}</Bdi>
                    </span>
                  )}
                </span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.repairsItemSubtitle}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="hidden xs:inline-flex px-2 py-1 rounded-xl pos-status-ok border text-[10px] font-black">
                + {t.common.new}
              </span>
              <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
            </div>
          </button>

          <button
            type="button"
            onClick={() => openModal('trade_in_buyback')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 flex items-center justify-center shrink-0">
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.tradeInItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.tradeInItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('kitting_bundle')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-purple-500/15 text-purple-700 dark:text-purple-400 flex items-center justify-center shrink-0">
                <Package className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.bundlesItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.bundlesItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('imei_inspector')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 flex items-center justify-center shrink-0">
                <Smartphone className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.imeiWarrantyItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.imeiWarrantyItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('compatibility')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.compatibilityItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.compatibilityItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('refund')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-rose-500/15 text-rose-700 dark:text-rose-400 flex items-center justify-center shrink-0">
                <RotateCcw className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">
                  {t.management.refundsItemTitle} <span className="hidden sm:inline font-mono font-medium">(F11)</span>
                </span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.refundsItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('command_tickets')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-400 flex items-center justify-center shrink-0">
                <Clock className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.commandTicketsItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.commandTicketsItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>
        </div>

        {/* 4. Gestion des Stocks & Fournisseurs */}
        <div id="mgmt-stocks" className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-2 scroll-mt-2">
          <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider mb-1 px-1">
            {t.management.stockSectionTitle}
          </h3>

          <button
            type="button"
            onClick={() => openModal('inventory_manager')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <Layers className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">
                  {t.management.inventoryItemTitle} <span className="hidden sm:inline font-mono font-medium">(F10)</span>
                </span>
                <span className="text-[10px] text-pos-muted block truncate font-mono">
                  <Bdi mono>{t('management.inventoryItemSubtitle', { count: products?.length || 0 })}</Bdi>
                </span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('vendor_procurement')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-teal-500/15 text-teal-700 dark:text-teal-400 flex items-center justify-center shrink-0">
                <Truck className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.suppliersItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.suppliersItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('invoice_ingestion')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <FileText className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-xs block text-pos-text truncate">{t.management.invoiceIngestionItemTitle}</span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded pos-status-ok border">{t.management.newBadge}</span>
                </div>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.invoiceIngestionItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('label_printer')}
            title="Étiquettes code-barres : feuille d'impression Android sur mobile"
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <Barcode className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.barcodeLabelsItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">
                  {t.management.barcodeLabelsItemSubtitle}
                </span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>
        </div>

        {/* 5. Finances & CRM Clients */}
        <div id="mgmt-finances" className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-2 scroll-mt-2">
          <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider mb-1 px-1">
            {t.management.financesSectionTitle}
          </h3>

          <button
            type="button"
            onClick={() => openModal('customers')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-blue-500/15 text-blue-700 dark:text-blue-400 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">
                  {t.management.crmCustomersItemTitle} <span className="hidden sm:inline font-mono font-medium">(F3)</span>
                </span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.crmCustomersItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('debt_ledger')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-rose-500/15 text-rose-700 dark:text-rose-400 flex items-center justify-center shrink-0">
                <CreditCard className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.debtLedgerItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.debtLedgerItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('expense_manager')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-400 flex items-center justify-center shrink-0">
                <DollarSign className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.expensesItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.expensesItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>
        </div>

        {/* 6. Configuration & Système */}
        <div id="mgmt-config" className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-2 scroll-mt-2">
          <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider mb-1 px-1">
            {t.management.configSectionTitle}
          </h3>

          <button
            type="button"
            onClick={() => openModal('settings')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-purple-500/15 text-purple-700 dark:text-purple-400 flex items-center justify-center shrink-0">
                <Settings className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">
                  {t.management.generalSettingsItemTitle} <span className="hidden sm:inline font-mono font-medium">(F12)</span>
                </span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.generalSettingsItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('receipt_template')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-pos-bg text-pos-muted flex items-center justify-center shrink-0">
                <Sliders className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.receiptTemplateItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.receiptTemplateItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          {/* FT-01: hidden for cashiers (UX only — modal gate is authoritative). */}
          {canSeeJournalLauncher(activeCashier?.role) && (
          <button
            type="button"
            onClick={() => openModal('security_audit')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-500 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.securityAuditItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.securityAuditItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>
          )}

          <button
            type="button"
            onClick={() => openModal('db_maintenance')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 flex items-center justify-center shrink-0">
                <Database className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.sqliteMaintenanceItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.sqliteMaintenanceItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => openModal('licensing')}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-purple-500/15 text-purple-700 dark:text-purple-400 flex items-center justify-center shrink-0">
                <Key className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.licensingItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">{t.management.licensingItemSubtitle}</span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => setIsPrinterModalOpen(true)}
            className="w-full min-h-[52px] px-3.5 rounded-2xl bg-pos-panel hover:bg-pos-hover border border-pos-border flex items-center justify-between text-pos-text cursor-pointer active:scale-98 transition"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 flex items-center justify-center shrink-0">
                <Printer className="w-4 h-4" aria-hidden="true" />
              </div>
              <div className="text-start min-w-0">
                <span className="font-bold text-xs block text-pos-text truncate">{t.management.mobilePrinterItemTitle}</span>
                <span className="text-[10px] text-pos-muted block truncate">
                  {mobilePrinter.enabled
                    ? `${mobilePrinter.connection.toUpperCase()} • ${mobilePrinter.connection === 'wifi' ? mobilePrinter.wifiHost : mobilePrinter.bluetoothName || 'Associé'}`
                    : t.management.mobilePrinterDisabledSubtitle}
                </span>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180" aria-hidden="true" />
          </button>

          {/* Cloud Pairing / QR Scan Shortcut */}
          {onOpenPairingWizard && (
            <div className="flex items-center justify-between p-3 rounded-2xl bg-pos-panel border border-pos-border">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 flex items-center justify-center shrink-0">
                  <QrCode className="w-4 h-4" aria-hidden="true" />
                </div>
                <div className="text-start min-w-0">
                  <span className="font-bold text-xs block text-pos-text truncate">{t.management.pairRegisterTitle}</span>
                  <span className="text-[10px] text-pos-muted block truncate">{t.management.pairRegisterSubtitle}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={onOpenPairingWizard}
                className="min-h-[48px] px-3.5 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 text-slate-950 font-bold text-xs active:scale-95 transition cursor-pointer flex items-center gap-1.5 shadow-sm shadow-emerald-500/20 shrink-0"
              >
                <Camera className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>{t.management.scanButton}</span>
              </button>
            </div>
          )}
        </div>

        {/* 5. Preferences & Settings */}
        <div id="mgmt-prefs" className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-3 scroll-mt-2">
          <h3 className="text-[10px] font-black uppercase text-pos-muted tracking-wider px-1">
            {t.management.quickPreferencesTitle}
          </h3>

          {/* Theme Changer */}
          <div className="flex items-center justify-between py-1 border-b border-pos-border/40">
            <span className="font-bold text-pos-text flex items-center gap-2.5">
              {themeMode === 'dark' ? (
                <Moon className="w-4 h-4 text-indigo-700 dark:text-indigo-400" aria-hidden="true" />
              ) : (
                <Sun className="w-4 h-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
              )}
              <span>{t.management.visualThemeLabel}</span>
            </span>
            <button
              type="button"
              onClick={toggleTheme}
              className="min-h-[48px] px-3.5 rounded-xl bg-pos-panel border border-pos-border font-bold text-xs text-pos-text hover:border-cyan-400 active:scale-95 transition cursor-pointer flex items-center gap-1.5"
            >
              <span>{themeMode === 'dark' ? t.management.themeDark : t.management.themeLight}</span>
            </button>
          </div>

          {/* Language Switcher (FR / AR) */}
          <div className="flex items-center justify-between py-1 border-b border-pos-border/40">
            <span className="font-bold text-pos-text flex items-center gap-2.5">
              <span>{t.management.languageLabel}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                soundEngine.playKeyBeep?.();
                toggleLocale();
              }}
              className="min-h-[48px] px-3.5 rounded-xl bg-pos-panel border border-pos-border font-bold text-xs text-pos-text hover:border-cyan-400 active:scale-95 transition cursor-pointer flex items-center gap-1.5"
            >
              <span>{locale === 'ar' ? 'العربية (AR)' : 'Français (FR)'}</span>
            </button>
          </div>

          {/* Audio Sound FX */}
          <div className="flex items-center justify-between py-1 border-b border-pos-border/40">
            <span className="font-bold text-pos-text flex items-center gap-2.5">
              {isAudioMuted ? (
                <VolumeX className="w-4 h-4 text-rose-700 dark:text-rose-400" aria-hidden="true" />
              ) : (
                <Volume2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
              )}
              <span>{t.management.soundBeepsLabel}</span>
            </span>
            <button
              type="button"
              onClick={handleToggleSound}
              className="min-h-[48px] px-3.5 rounded-xl bg-pos-panel border border-pos-border font-bold text-xs text-pos-text hover:border-cyan-400 active:scale-95 transition cursor-pointer"
            >
              {isAudioMuted ? t.management.soundDisabled : t.management.soundEnabled}
            </button>
          </div>

          {/* Cloud Sync Telemetry */}
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {syncStatus.online ? (
                  <Wifi className="w-4 h-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
                ) : (
                  <WifiOff className="w-4 h-4 text-rose-700 dark:text-rose-400" aria-hidden="true" />
                )}
                <span className="font-bold text-pos-text text-xs">
                  {syncStatus.online ? t.management.cloudSyncActive : t.management.offlineMode}
                </span>
              </div>
              <span className="text-[10px] text-pos-muted font-mono bg-pos-panel px-2.5 py-0.5 rounded-full border border-pos-border/40">
                <Bdi mono>
                  {syncStatus.pendingCount > 0
                    ? t('header.pendingCount', { count: syncStatus.pendingCount })
                    : t.management.upToDateBadge}
                </Bdi>
              </span>
            </div>

            <button
              type="button"
              disabled={isManualSyncing || syncStatus.pushing || syncStatus.pulling}
              onClick={handleForceSync}
              className="w-full min-h-[48px] px-3 rounded-xl bg-pos-panel hover:bg-pos-hover border border-pos-border active:scale-98 font-bold text-xs text-pos-text flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                aria-hidden="true"
                className={`w-4 h-4 text-cyan-700 dark:text-cyan-400 ${
                  isManualSyncing || syncStatus.pushing || syncStatus.pulling ? 'animate-spin' : ''
                }`}
              />
              <span>{isManualSyncing ? t.diagnostics.syncingInProgress : t.management.forceSyncButton}</span>
            </button>

            {/* Dernière synchro réussie — affichage seul (réutilise lastPushAt/lastPullAt). */}
            <p className="text-[11px] text-pos-muted leading-relaxed bg-pos-panel/60 border border-pos-border/40 rounded-xl px-2.5 py-2">
              {lastSyncLabel ? (
                <>
                  {t('management.lastSyncSuccessPrefix', { time: lastSyncLabel })}
                </>
              ) : (
                t.management.noSyncYetHint
              )}
            </p>
          </div>
        </div>

        {/* 6. Software Updates */}
        <div id="mgmt-maj" className="bg-pos-card border border-pos-border rounded-3xl p-4 shadow-sm space-y-3 scroll-mt-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-purple-500/15 text-purple-700 dark:text-purple-400 flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4" aria-hidden="true" />
              </div>
              <div>
                <span className="font-bold text-pos-text text-xs block">{t.management.softwareUpdateTitle}</span>
                <span className="text-[10px] text-pos-muted block font-mono">
                  <Bdi mono>{t('management.installedVersionPrefix', { version: APP_VERSION })}</Bdi>
                </span>
              </div>
            </div>
            <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full pos-status-ok border">
              {t.management.stableChannelBadge}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={updater.isChecking}
              onClick={handleCheckUpdatesMobile}
              className="flex-1 min-h-[48px] px-3 rounded-xl bg-purple-600 hover:bg-purple-500 active:scale-98 font-bold text-xs text-white flex items-center justify-center gap-2 transition cursor-pointer shadow-md shadow-purple-600/20 disabled:opacity-50"
            >
              <RefreshCw aria-hidden="true" className={`w-3.5 h-3.5 text-white shrink-0 ${updater.isChecking ? 'animate-spin' : ''}`} />
              <span>{updater.isChecking ? t.management.checkingUpdates : t.management.checkUpdatesButton}</span>
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
              className="min-h-[48px] px-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/40 hover:bg-emerald-500/25 text-emerald-800 dark:text-emerald-300 font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 no-underline shrink-0 cursor-pointer"
              title="Télécharger directement le fichier APK"
            >
              <Download className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
              <span>{t.management.directApkButton}</span>
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
          <div className="flex items-center justify-center gap-1.5 text-indigo-800 dark:text-indigo-300 font-black text-xs">
            <Sparkles className="w-4 h-4 text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
            <span>{t.management.fullRegisterBannerTitle}</span>
          </div>
          <p className="text-[11px] text-pos-muted leading-relaxed max-w-sm mx-auto">
            {t.management.fullRegisterBannerDescription}
          </p>
          <button
            type="button"
            onClick={handleSwitchToDesktop}
            className="w-full min-h-[48px] rounded-2xl bg-gradient-to-r from-indigo-600 to-cyan-600 hover:from-indigo-500 hover:to-cyan-500 text-white font-black text-xs flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 active:scale-98 transition cursor-pointer"
          >
            <Monitor className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{t.management.switchToDesktopButton}</span>
          </button>
        </div>

        {/* PIN Verification Modal for No-Sale Drawer Open */}
        <PinDialog
          isOpen={isPinOpen}
          title={t.management.noSalePinDialogTitle}
          description={t.management.noSalePinDialogDescription}
          onSuccess={handlePinSuccess}
          onCancel={() => setIsPinOpen(false)}
        />

        {/* Mobile ESC/POS Thermal Printer Settings Modal */}
        <MobilePrinterModal
          isOpen={isPrinterModalOpen}
          onClose={() => setIsPrinterModalOpen(false)}
        />
      </div>
    </AppTabContent>
  );
};

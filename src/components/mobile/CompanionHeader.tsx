import React, { useEffect, useState } from 'react';
import { Smartphone, RefreshCw, WifiOff, Truck, Monitor, Camera, Languages } from 'lucide-react';
// P11.3: sync engine is loaded on demand — importing it statically here would
// drag ~267 kB (turso client + sql adapter) into the entry chunk.
import type { SyncStatus } from '../../sync/types';
import { usePosStore } from '../../store/usePosStore';
import { useDeviceMode } from '../../hooks/useDeviceMode';
import { ThemeToggle } from '../ThemeToggle';
import { useTranslation, Bdi } from '../../i18n';

export interface CompanionHeaderProps {
  activeTab?: string;
  onOpenDiagnostics?: () => void;
}

export const CompanionHeader: React.FC<CompanionHeaderProps> = ({
  onOpenDiagnostics,
}) => {
  const { openModal } = usePosStore();
  const { setRoleMode } = useDeviceMode();
  const { t, locale, toggleLocale } = useTranslation();
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

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    import('../../sync/SyncManager')
      .then(({ syncManager }) => {
        if (cancelled) return;
        unsubscribe = syncManager.subscribe((s) => {
          setSyncStatus(s);
        });
      })
      .catch((err: unknown) => console.warn('[header] sync engine unavailable:', err));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const isSyncing = syncStatus.pushing || syncStatus.pulling;

  const syncVisibleText = isSyncing
    ? t.header.syncing
    : syncStatus.pendingCount > 0
    ? t('header.pendingCount', { count: syncStatus.pendingCount })
    : syncStatus.online
    ? t.header.syncOnline
    : t.header.syncOffline;

  const handleSyncClick = () => {
    if (syncStatus.online) {
      import('../../sync/SyncManager')
        .then(({ syncManager }) => void syncManager.kick())
        .catch((err: unknown) => console.warn('[header] sync kick failed:', err));
    }
    onOpenDiagnostics?.();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mobi:navigate-tab', { detail: 'diagnostics' }));
    }
  };

  const syncPillTone = !syncStatus.online
    ? 'pos-status-danger hover:opacity-90'
    : syncStatus.pendingCount > 0 || isSyncing
    ? 'pos-status-warn hover:opacity-90'
    : 'pos-status-ok hover:opacity-90';

  return (
    <header className="platform-chrome-top min-h-[56px] h-14 landscape:min-h-[48px] landscape:h-12 px-2.5 sm:px-4 landscape:px-3 flex items-center justify-between gap-1.5 select-none shrink-0">
      {/* Brand & Companion Mode Badge */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-500/25 to-teal-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0 shadow-xs">
          <Smartphone className="w-4 h-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-black text-pos-text tracking-tight block leading-tight truncate">
              {t.header.brandTitle}
            </span>
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                syncStatus.online
                  ? 'bg-emerald-500 dark:bg-emerald-400 animate-pulse'
                  : 'bg-amber-500 dark:bg-amber-400'
              }`}
              aria-hidden="true"
              title={syncStatus.online ? t.header.inServiceTitle : t.header.syncOffline}
            />
          </div>
          <span className="text-[9px] font-extrabold text-emerald-700 dark:text-emerald-400 uppercase tracking-widest block leading-none truncate">
            {t.header.brandSubtitle}
          </span>
        </div>
      </div>

      {/* Right side: sync status pill, quick procurement, scanner, locale switcher, PC mode & theme toggle */}
      <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
        {/* Sync Status Interactive Pill -> Diagnostics drill-down */}
        <button
          type="button"
          onClick={handleSyncClick}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11px] font-bold transition active-press min-h-[48px] min-w-[48px] cursor-pointer shadow-xs touch-manipulation focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none ${syncPillTone}`}
          title="Diagnostic et état de synchronisation Turso Cloud"
          aria-label={`${syncVisibleText} — ${t.header.syncStatusAriaSuffix}`}
        >
          {isSyncing ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
          ) : syncStatus.online ? (
            <span className="w-2 h-2 rounded-full bg-emerald-500 dark:bg-emerald-400 shadow-[0_0_6px_#34d399] shrink-0" aria-hidden="true" />
          ) : (
            <WifiOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          )}

          <Bdi mono className="text-[10px] font-bold tracking-tight whitespace-nowrap">
            {syncVisibleText}
          </Bdi>
        </button>

        {/* Quick Supplier Procurement Button (accessible on sm+ viewports to preserve header space on narrow phones) */}
        <button
          type="button"
          onClick={() => openModal('vendor_procurement')}
          className="relative hidden sm:flex items-center justify-center min-h-[48px] min-w-[48px] rounded-xl bg-pos-card border border-pos-border text-pos-muted hover:text-emerald-700 dark:hover:text-emerald-400 hover:border-emerald-500/30 active-press transition cursor-pointer touch-manipulation focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none"
          title="Réapprovisionnement Fournisseurs JIT"
          aria-label="Réapprovisionnement Fournisseurs JIT"
        >
          <Truck className="w-4 h-4" aria-hidden="true" />
          <span className="absolute top-1.5 end-1.5 w-2 h-2 rounded-full bg-emerald-500 dark:bg-emerald-400 ring-2 ring-pos-panel" aria-hidden="true" />
        </button>

        {/* Dedicated Invoice/BL Document Scanner Button (accessible on sm+ viewports) */}
        <button
          type="button"
          onClick={() => openModal('invoice_ingestion')}
          className="relative hidden sm:flex items-center justify-center min-h-[48px] min-w-[48px] rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/25 active-press transition cursor-pointer shadow-xs touch-manipulation focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none"
          title="Scanner Bon de Livraison / Facture (IA Recon)"
          aria-label="Scanner Bon de Livraison ou Facture Fournisseur"
        >
          <Camera className="w-4 h-4" aria-hidden="true" />
          <span className="absolute top-1 end-1 w-2.5 h-2.5 rounded-full bg-emerald-500 dark:bg-emerald-400 ring-2 ring-pos-panel animate-pulse" aria-hidden="true" />
        </button>

        {/* Language / RTL Switcher Button (48x48dp) */}
        <button
          type="button"
          onClick={toggleLocale}
          className="flex items-center justify-center gap-1 min-h-[48px] min-w-[48px] px-2 rounded-xl bg-pos-card border border-pos-border text-pos-text hover:border-cyan-500/40 active-press transition cursor-pointer touch-manipulation focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:outline-none"
          title={locale === 'ar' ? 'FR — Basculer en français' : 'عربي — التبديل إلى العربية'}
          aria-label={locale === 'ar' ? 'FR — Basculer en français' : 'عربي — التبديل إلى العربية'}
        >
          <Languages className="w-3.5 h-3.5 text-cyan-700 dark:text-cyan-400 shrink-0" aria-hidden="true" />
          <span className="text-[11px] font-black tracking-tight">
            {locale === 'ar' ? 'FR' : 'عربي'}
          </span>
        </button>

        {/* PC Mode Switcher button (discreet on mobile, accessible on desktop/tablet) */}
        <button
          type="button"
          onClick={() => setRoleMode('pos_primary')}
          className="hidden sm:flex items-center justify-center min-h-[48px] min-w-[48px] rounded-xl bg-pos-card border border-pos-border text-pos-muted hover:text-cyan-700 dark:hover:text-cyan-400 hover:border-cyan-500/30 active-press transition cursor-pointer touch-manipulation focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:outline-none"
          title="Passer en Mode Caisse PC"
          aria-label="Passer en Mode Caisse PC"
        >
          <Monitor className="w-4 h-4" aria-hidden="true" />
        </button>

        {/* Instant Theme Toggle (full 48x48dp touch target) */}
        <div className="shrink-0 flex items-center">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
};

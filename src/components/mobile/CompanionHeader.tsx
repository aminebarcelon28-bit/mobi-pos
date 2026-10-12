import React, { useEffect, useState } from 'react';
import { Smartphone, RefreshCw, WifiOff, Truck, Monitor, Camera } from 'lucide-react';
// P11.3: sync engine is loaded on demand — importing it statically here would
// drag ~267 kB (turso client + sql adapter) into the entry chunk.
import type { SyncStatus } from '../../sync/types';
import { usePosStore } from '../../store/usePosStore';
import { useDeviceMode } from '../../hooks/useDeviceMode';
import { ThemeToggle } from '../ThemeToggle';

export const CompanionHeader: React.FC = () => {
  const { openModal } = usePosStore();
  const { setRoleMode } = useDeviceMode();
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
    ? 'Sync…'
    : syncStatus.pendingCount > 0
    ? `${syncStatus.pendingCount} attente`
    : syncStatus.online
    ? 'En ligne'
    : 'Hors ligne';

  const handleSyncClick = () => {
    if (!syncStatus.online) {
      openModal('settings');
      return;
    }
    import('../../sync/SyncManager')
      .then(({ syncManager }) => void syncManager.kick())
      .catch((err: unknown) => console.warn('[header] sync kick failed:', err));
  };

  return (
    <header className="min-h-[56px] h-14 landscape:min-h-[48px] landscape:h-12 px-3 sm:px-4 landscape:px-3 flex items-center justify-between select-none shrink-0">
      {/* Brand & Companion Mode Badge */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-500/25 to-teal-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center shrink-0 shadow-xs">
          <Smartphone className="w-4 h-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-black text-pos-text tracking-tight block leading-tight">
              MobiPOS
            </span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" aria-hidden="true" title="En service" />
          </div>
          <span className="text-[9px] font-extrabold text-emerald-400 uppercase tracking-widest block leading-none truncate">
            Companion
          </span>
        </div>
      </div>

      {/* Right side: sync status pill, quick procurement, scanner, PC mode & theme toggle */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {/* Sync Status Interactive Pill */}
        <button
          type="button"
          onClick={handleSyncClick}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-bold transition active-press min-h-[48px] min-w-[48px] cursor-pointer shadow-xs touch-manipulation focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none ${
            syncStatus.online
              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-400 hover:bg-rose-500/20'
          }`}
          title={syncStatus.online ? "Synchronisation Turso Cloud — toucher pour forcer" : "Hors ligne — toucher pour les paramètres"}
          aria-label={`${syncVisibleText} — statut de synchronisation`}
        >
          {isSyncing ? (
            <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin" aria-hidden="true" />
          ) : syncStatus.online ? (
            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" aria-hidden="true" />
          ) : (
            <WifiOff className="w-3.5 h-3.5 text-rose-400" aria-hidden="true" />
          )}

          <span className="text-[10px] font-mono font-bold tracking-tight">
            {syncVisibleText}
          </span>
        </button>

        {/* Quick Supplier Procurement Button */}
        <button
          type="button"
          onClick={() => openModal('vendor_procurement')}
          className="relative flex items-center justify-center min-h-[48px] min-w-[48px] rounded-xl bg-pos-card border border-pos-border text-pos-muted hover:text-emerald-400 hover:border-emerald-500/30 active-press transition cursor-pointer touch-manipulation focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none"
          title="Réapprovisionnement Fournisseurs JIT"
          aria-label="Réapprovisionnement Fournisseurs JIT"
        >
          <Truck className="w-4 h-4" aria-hidden="true" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-pos-panel" aria-hidden="true" />
        </button>

        {/* Dedicated Invoice/BL Document Scanner Button */}
        <button
          type="button"
          onClick={() => openModal('invoice_ingestion')}
          className="relative flex items-center justify-center min-h-[48px] min-w-[48px] rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 active-press transition cursor-pointer shadow-xs touch-manipulation focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none"
          title="Scanner Bon de Livraison / Facture (IA Recon)"
          aria-label="Scanner Bon de Livraison ou Facture Fournisseur"
        >
          <Camera className="w-4 h-4" aria-hidden="true" />
          <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-pos-panel animate-pulse" aria-hidden="true" />
        </button>

        {/* PC Mode Switcher button (discreet on mobile, accessible on desktop/tablet) */}
        <button
          type="button"
          onClick={() => setRoleMode('pos_primary')}
          className="hidden sm:flex items-center justify-center min-h-[48px] min-w-[48px] rounded-xl bg-pos-card border border-pos-border text-pos-muted hover:text-cyan-400 hover:border-cyan-500/30 active-press transition cursor-pointer touch-manipulation focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:outline-none"
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

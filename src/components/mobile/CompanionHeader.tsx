import React, { useEffect, useState } from 'react';
import { Smartphone, RefreshCw, WifiOff, Truck, Monitor } from 'lucide-react';
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
    let unsubscribe: (() => void) | undefined;
    import('../../sync/SyncManager')
      .then(({ syncManager }) => {
        unsubscribe = syncManager.subscribe((s) => {
          setSyncStatus(s);
        });
      })
      .catch((err: unknown) => console.warn('[header] sync engine unavailable:', err));
    return () => unsubscribe?.();
  }, []);

  const isSyncing = syncStatus.pushing || syncStatus.pulling;

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
    <header className="min-h-[52px] h-[52px] px-3.5 flex items-center justify-between select-none shrink-0">
      {/* Brand & Companion Mode Badge */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-500/25 to-teal-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center shrink-0 shadow-xs">
          <Smartphone className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-black text-pos-text tracking-tight block leading-tight">
              MobiPOS
            </span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" title="En service" />
          </div>
          <span className="text-[9px] font-extrabold text-emerald-400 uppercase tracking-widest block leading-none truncate">
            Companion
          </span>
        </div>
      </div>

      {/* Right side: sync status pill, quick procurement, theme toggle & desktop switcher */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Sync Status Interactive Pill */}
        <button
          type="button"
          onClick={handleSyncClick}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-bold transition active-press min-h-[40px] cursor-pointer shadow-xs ${
            syncStatus.online
              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-400 hover:bg-rose-500/20'
          }`}
          title={syncStatus.online ? "Synchronisation Turso Cloud — toucher pour forcer" : "Hors ligne — toucher pour les paramètres"}
          aria-label="Statut de synchronisation"
        >
          {isSyncing ? (
            <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin" />
          ) : syncStatus.online ? (
            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
          ) : (
            <WifiOff className="w-3.5 h-3.5 text-rose-400" />
          )}

          <span className="text-[10px] font-mono font-bold tracking-tight">
            {isSyncing
              ? 'Sync…'
              : syncStatus.pendingCount > 0
              ? `${syncStatus.pendingCount} attente`
              : syncStatus.online
              ? 'En ligne'
              : 'Hors ligne'}
          </span>
        </button>

        {/* Quick Supplier Procurement Button */}
        <button
          type="button"
          onClick={() => openModal('vendor_procurement')}
          className="relative flex items-center justify-center min-h-[40px] min-w-[40px] rounded-xl bg-pos-card border border-pos-border text-pos-muted hover:text-emerald-400 hover:border-emerald-500/30 active-press transition cursor-pointer"
          title="Réapprovisionnement Fournisseurs JIT"
          aria-label="Réapprovisionnement Fournisseurs JIT"
        >
          <Truck className="w-4 h-4" />
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-pos-panel" />
        </button>

        {/* PC Mode Switcher button (discreet, accessible) */}
        <button
          type="button"
          onClick={() => setRoleMode('pos_primary')}
          className="hidden sm:flex items-center justify-center min-h-[40px] min-w-[40px] rounded-xl bg-pos-card border border-pos-border text-pos-muted hover:text-cyan-400 hover:border-cyan-500/30 active-press transition cursor-pointer"
          title="Passer en Mode Caisse PC"
          aria-label="Passer en Mode Caisse PC"
        >
          <Monitor className="w-4 h-4" />
        </button>

        {/* Instant Theme Toggle */}
        <div className="shrink-0 scale-90 origin-right">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
};

import React, { useEffect, useState } from 'react';
import { Smartphone, RefreshCw, Wifi, WifiOff, ShieldCheck } from 'lucide-react';
import { syncManager } from '../../sync/SyncManager';
import type { SyncStatus } from '../../sync/types';
import { usePosStore } from '../../store/usePosStore';

import { ThemeToggle } from '../ThemeToggle';

export const CompanionHeader: React.FC = () => {
  const { openModal } = usePosStore();
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
    const unsubscribe = syncManager.subscribe((s) => {
      setSyncStatus(s);
    });
    return unsubscribe;
  }, []);

  const isSyncing = syncStatus.pushing || syncStatus.pulling;

  return (
    <header className="min-h-12 h-[calc(3rem+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)] bg-pos-panel border-b border-pos-border px-3 flex items-center justify-between select-none shrink-0 z-20">
      {/* Brand & Companion Mode Badge */}
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
          <Smartphone className="w-4 h-4" />
        </div>
        <div>
          <span className="text-xs font-black text-pos-text tracking-wide block leading-tight">
            MobiPOS
          </span>
          <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-wider block leading-none">
            Mobile Companion
          </span>
        </div>
      </div>

      {/* Right side: Honest Sync Badge, ThemeToggle & Shield */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => openModal('settings')}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-pos-card border border-pos-border text-pos-text text-[10px] font-bold cursor-pointer hover:border-emerald-500/40 transition"
          title="Paramètres de synchronisation Cloud"
        >
          {isSyncing ? (
            <RefreshCw className="w-3 h-3 text-amber-400 animate-spin" />
          ) : syncStatus.online ? (
            <Wifi className="w-3 h-3 text-emerald-400" />
          ) : (
            <WifiOff className="w-3 h-3 text-rose-400" />
          )}

          <span>
            {isSyncing
              ? 'Sync...'
              : syncStatus.online
              ? syncStatus.pendingCount > 0
                ? `${syncStatus.pendingCount}`
                : 'En ligne'
              : 'Hors ligne'}
          </span>
        </button>

        {/* Instant Theme Toggle (Dark / Light) */}
        <div className="shrink-0 scale-90 origin-right">
          <ThemeToggle />
        </div>

        <div
          className="w-7 h-7 rounded-lg bg-pos-card border border-pos-border flex items-center justify-center text-emerald-400"
          title="Sécurité SQLite WAL & Signature Active"
        >
          <ShieldCheck className="w-4 h-4" />
        </div>
      </div>
    </header>
  );
};

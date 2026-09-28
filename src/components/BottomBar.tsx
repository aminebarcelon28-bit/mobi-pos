import React, { useState, useEffect, useRef } from 'react';
import {
  Users,
  Percent,
  PauseCircle,
  BarChart3,
  Settings,
  Database,
  Boxes,
  RotateCcw,
  Cloud,
  CloudOff,
  RefreshCw,
  Banknote,
  Printer,
  Keyboard,
} from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { useToast } from './ui/Toast';
import { useSyncStatus } from '../hooks/useSyncStatus';
// P11.3: sync engine loads on demand (static import pulls ~267 kB into entry).

// 1-second clock isolated so its tick does not re-render the whole bottom bar.
const BottomBarClock: React.FC = React.memo(() => {
  const [timeStr, setTimeStr] = useState('');
  const [dateStr, setDateStr] = useState('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString('fr-DZ', { hour: '2-digit', minute: '2-digit' }));
      setDateStr(
        now.toLocaleDateString('fr-DZ', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="text-right whitespace-nowrap leading-tight">
      <span className="font-black text-pos-text text-xs tracking-wide font-mono">{timeStr || '19:30'}</span>
      <p className="text-[10px] text-pos-muted capitalize font-medium">{dateStr || '1 Septembre 2026'}</p>
    </div>
  );
});
BottomBarClock.displayName = 'BottomBarClock';

export const BottomBar: React.FC = () => {
  // Selective subscriptions: whole-store spread re-rendered this footer on
  // every unrelated slice change (cart keystroke, sync tick) — visible lag.
  const openModal = usePosStore((s) => s.openModal);
  const holdSale = usePosStore((s) => s.holdSale);
  const heldSales = usePosStore((s) => s.heldSales);
  const cart = usePosStore((s) => s.cart);
  const reprintReceipt = usePosStore((s) => s.reprintReceipt);
  const lastTransaction = usePosStore((s) => s.lastTransaction);
  const { showToast } = useToast();
  const sync = useSyncStatus();
  // SyncStatus exposes failedCount (quarantined outbox rows); no separate
  // quarantined field exists — failedCount IS the quarantine count.
  const failedCount = sync.failedCount ?? 0;
  // Horizontal action strip: translate a vertical mouse wheel into a
  // horizontal scroll so the buttons are reachable without Shift+wheel
  // or a trackpad gesture. Attached non-passively so preventDefault works.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleSyncClick = async () => {
    if (!sync.online) {
      showToast('Hors ligne — les ventes restent en file locale et partiront à la reconnexion.', 'warning');
      return;
    }
    if (sync.pendingCount === 0 && failedCount === 0 && !sync.pushing && !sync.pulling) {
      showToast(
        sync.lastPullAt
          ? `Synchronisé avec Turso. Dernier pull: ${new Date(sync.lastPullAt).toLocaleTimeString('fr-DZ')}.`
          : 'Synchronisé avec Turso.',
        'success',
      );
      return;
    }
    try {
      const { syncManager } = await import('../sync/SyncManager');
      if (failedCount > 0) {
        const requeued = await syncManager.retryQuarantinedOutbox();
        showToast(
          requeued > 0
            ? `${requeued} élément(s) en quarantaine remis en file d'attente…`
            : 'Synchronisation Turso forcée…',
          'info',
        );
      } else {
        showToast('Synchronisation Turso forcée…', 'info');
      }
      void syncManager.kick();
    } catch (err: unknown) {
      console.warn('[bottombar] sync kick failed:', err);
      showToast('Erreur lors du forçage de la synchronisation', 'error');
    }
  };

  const handleHoldSaleClick = () => {
    const holdResult = holdSale();
    if (holdResult && holdResult.success) {
      showToast('Vente mise en attente avec succès ! (Ticket sauvegardé)', 'success');
    } else {
      showToast('Le panier est vide. Aucun article à mettre en attente.', 'warning');
    }
  };

  return (
    <footer aria-label="Barre d'actions caisse" className="bg-pos-panel border-t border-pos-border px-3 py-1.5 select-none shrink-0 relative z-20 w-full max-w-full overflow-hidden">
      <div className="flex items-center gap-3 w-full max-w-full min-w-0">
        {/* Left Side: Shortcut Function Keys — défilement horizontal + fondus de bord */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
        <div ref={stripRef} className="flex flex-nowrap items-center gap-1.5 overflow-x-auto overflow-y-hidden max-w-full min-w-0 no-scrollbar py-0.5 px-0.5 [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-emerald-500 [&_button]:active:scale-95" role="toolbar" aria-label="Encaissement et modules">
          {/* Quick Cash Tender (F2) */}
          <button
            onClick={() => cart.length > 0 && openModal('payment')}
            disabled={cart.length === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition whitespace-nowrap shrink-0 shadow-sm ${
              cart.length > 0
                ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20 cursor-pointer'
                : 'bg-pos-card text-pos-muted border border-pos-border opacity-60 cursor-not-allowed'
            }`}
            title="Valider la Vente / Encaisser (F2 ou Espace)"
          >
            <Banknote className="w-3.5 h-3.5 shrink-0" />
            <span>Encaisser</span>
            <span className="bg-black/20 text-current px-1 py-0.2 rounded text-[10px] font-mono">F2</span>
          </button>

          {/* Customer Directory (F3) */}
          <button
            onClick={() => openModal('customers')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Fichier Clients & Dettes Kredy (F3)"
          >
            <Users className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>Clients</span>
            <span className="hotkey-badge">F3</span>
          </button>

          {/* Discount (F4) */}
          <button
            onClick={() => openModal('discount')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Appliquer une Remise Panier (F4)"
          >
            <Percent className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span>Remise</span>
            <span className="hotkey-badge">F4</span>
          </button>

          {/* Hold / Recall (F6) */}
          <button
            onClick={handleHoldSaleClick}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium relative cursor-pointer whitespace-nowrap shrink-0"
            title="Mettre en Attente ou Reprendre (F6)"
          >
            <PauseCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>Attente</span>
            {heldSales.length > 0 && (
              <span className="w-4 h-4 rounded-full bg-amber-500 text-slate-950 text-[10px] font-black flex items-center justify-center">
                {heldSales.length}
              </span>
            )}
            <span className="hotkey-badge">F6</span>
          </button>

          {/* Instant Reprint (F7) */}
          <button
            onClick={() => {
              if (lastTransaction) {
                reprintReceipt(lastTransaction);
                showToast(`Réimpression du ticket #${lastTransaction.receiptNumber} envoyée.`, 'info');
              } else {
                showToast('Aucun ticket récent à réimprimer.', 'warning');
              }
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Réimprimer le Dernier Ticket (F7)"
          >
            <Printer className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>Réimprimer</span>
            <span className="hotkey-badge">F7</span>
          </button>

          {/* Hotkey Guide (F8) */}
          <button
            onClick={() => openModal('hotkey_guide')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Guide des Raccourcis Clavier (F8)"
          >
            <Keyboard className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>Guide</span>
            <span className="hotkey-badge">F8</span>
          </button>

          {/* Reports (no hotkey — F9 opens custom items) */}
          <button
            onClick={() => openModal('reports')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Rapports Financiers & Synthèse"
          >
            <BarChart3 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span>Rapports</span>
          </button>

          {/* Stock (F10) */}
          <button
            onClick={() => openModal('inventory_manager')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Gestion de Stock & Inventaire (F10)"
          >
            <Boxes className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>Stock</span>
            <span className="hotkey-badge">F10</span>
          </button>

          {/* Refund (F11) */}
          <button
            onClick={() => openModal('refund')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Retours Marchandise & Remboursements (F11)"
          >
            <RotateCcw className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span>Remboursement</span>
            <span className="hotkey-badge">F11</span>
          </button>

          {/* Settings (F12) */}
          <button
            onClick={() => openModal('settings')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs text-pos-text transition font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Paramètres & Diagnostic (F12)"
          >
            <Settings className="w-3.5 h-3.5 text-pos-muted shrink-0" />
            <span>Paramètres</span>
            <span className="hotkey-badge">F12</span>
          </button>
          </div>
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-6" style={{ background: 'linear-gradient(to right, var(--pos-panel), transparent)' }} />
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-6" style={{ background: 'linear-gradient(to left, var(--pos-panel), transparent)' }} />
        </div>

        {/* Right Corner: Telemetry & System Clock */}
        <div className="flex items-center gap-3 pl-3 border-l border-pos-border shrink-0 text-xs">
          <button
            onClick={handleSyncClick}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-bold transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 cursor-pointer shadow-sm shrink-0 ${
              !sync.online
                ? 'bg-slate-500/10 hover:bg-slate-500/20 border-slate-500/30 text-slate-300'
                : sync.pushing || sync.pulling
                  ? 'bg-sky-500/10 hover:bg-sky-500/20 border-sky-500/30 text-sky-300'
                  : failedCount > 0
                    ? 'bg-rose-500/10 hover:bg-rose-500/20 border-rose-500/30 text-rose-300'
                    : sync.pendingCount > 0
                      ? 'bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/30 text-amber-300'
                      : 'bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/30 text-emerald-300'
            }`}
            title={
              !sync.online
                ? `Hors ligne — file locale active, sync auto à la reconnexion${sync.pendingCount > 0 ? ` (${sync.pendingCount} en attente` : ''}${failedCount > 0 ? `${sync.pendingCount > 0 ? ', ' : ' ('}${failedCount} en échec/quarantaine` : ''}${sync.pendingCount > 0 || failedCount > 0 ? ')' : ''}`
                : sync.lastError ?? `Turso Sync (${sync.relayConnected ? 'Relay Temps Réel Actif' : `Polling Rapide 1.5s${(sync as { relayLastError?: string }).relayLastError ? ` — relay: ${(sync as { relayLastError?: string }).relayLastError}` : ''}`}). Dernier push : ${sync.lastPushAt ? new Date(sync.lastPushAt).toLocaleTimeString('fr-DZ') : '—'} • Dernier pull : ${sync.lastPullAt ? new Date(sync.lastPullAt).toLocaleTimeString('fr-DZ') : '—'}${sync.pendingCount > 0 ? ` • ${sync.pendingCount} en attente` : ''}${failedCount > 0 ? ` • ${failedCount} en échec/quarantaine` : ''}. Cliquez pour forcer.`
            }
          >
            {!sync.online ? (
              <CloudOff className="w-3.5 h-3.5 shrink-0" />
            ) : sync.pushing || sync.pulling ? (
              <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" />
            ) : (
              <Cloud className="w-3.5 h-3.5 shrink-0" />
            )}
            <span className="font-mono">
              {!sync.online
                ? 'Hors ligne'
                : sync.pushing || sync.pulling
                  ? 'Sync…'
                  : failedCount > 0 && sync.pendingCount > 0
                    ? `${sync.pendingCount} en attente • ${failedCount} échec`
                    : failedCount > 0
                      ? `${failedCount} échec`
                      : sync.pendingCount > 0
                        ? `${sync.pendingCount} en attente`
                        : sync.relayConnected
                          ? 'Relay Actif'
                          : 'Sync Turso'}
            </span>
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                !sync.online
                  ? 'bg-slate-400'
                  : failedCount > 0
                    ? 'bg-rose-400 animate-pulse'
                    : sync.pendingCount > 0
                      ? 'bg-amber-400 animate-pulse'
                      : sync.relayConnected
                        ? 'bg-emerald-400 animate-pulse'
                        : 'bg-emerald-400'
              }`}
            />
          </button>

          <button
            onClick={() => openModal('db_maintenance')}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-[11px] font-bold text-cyan-300 transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 cursor-pointer shadow-sm shrink-0"
            title="Moteur SQLite WAL Actif • Cliquez pour ouvrir le Centre de Maintenance"
          >
            <Database className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="font-mono">SQLite WAL</span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          </button>

          <BottomBarClock />

          <div
            className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-md shadow-emerald-500/50 animate-pulse shrink-0"
            title="Système En Ligne & Synchronisé"
          />
        </div>
      </div>
    </footer>
  );
};

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
import { Kbd } from '../design-system/desktop/Kbd';
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
    <div className="text-right whitespace-nowrap leading-tight select-none">
      <span className="font-bold text-fg text-ui-xs tracking-wide font-mono num">{timeStr || '19:30'}</span>
      <p className="text-ui-2xs text-fg-muted capitalize font-medium">{dateStr || '1 Septembre 2026'}</p>
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
  // Signed-lane backlog (drain worker telemetry): non-intrusive drawer
  // warning past the threshold; transactions stay buffered locally.
  const outboxPendingCount = usePosStore((s) => s.outboxPendingCount);
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
    if (cart.length === 0 && heldSales.length > 0) {
      openModal('hold');
      return;
    }
    const holdResult = holdSale();
    if (holdResult && holdResult.success) {
      showToast('Vente mise en attente avec succès ! (Ticket sauvegardé)', 'success');
    } else {
      showToast('Le panier est vide. Aucun article à mettre en attente.', 'warning');
    }
  };

  return (
    <footer aria-label="Barre d'actions caisse" className="bg-surface-panel border-t border-line px-3 py-1.5 select-none shrink-0 relative z-20 w-full max-w-full overflow-hidden">
      <div className="flex items-center gap-3 w-full max-w-full min-w-0">
        {/* Left Side: Shortcut Function Keys — défilement horizontal + fondus de bord */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
        <div ref={stripRef} className="flex flex-nowrap items-center gap-1.5 overflow-x-auto overflow-y-hidden max-w-full min-w-0 no-scrollbar py-0.5 px-0.5 [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-pos-accent [&_button]:active:scale-95" role="toolbar" aria-label="Encaissement et modules">
          {/* Quick Cash Tender (F2) */}
          <button
            onClick={() => cart.length > 0 && openModal('payment')}
            disabled={cart.length === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-ui-sm text-ui-xs font-bold transition whitespace-nowrap shrink-0 shadow-xs h-ctl-md ${
              cart.length > 0
                ? 'bg-pos-accent hover:bg-pos-accent/90 text-slate-950 cursor-pointer'
                : 'bg-surface-card text-fg-muted border border-line-subtle opacity-60 cursor-not-allowed'
            }`}
            title="Valider la Vente / Encaisser (F2 ou Espace)"
          >
            <Banknote className="w-3.5 h-3.5 shrink-0" />
            <span>Encaisser</span>
            <Kbd size="sm" variant={cart.length > 0 ? 'accent' : 'subtle'}>F2</Kbd>
          </button>

          {/* Customer Directory (F3) */}
          <button
            data-testid="clients-button"
            onClick={() => openModal('customers')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle hover:border-line text-ui-xs text-fg transition font-medium cursor-pointer whitespace-nowrap shrink-0 h-ctl-md"
            title="Fichier Clients & Dettes Kredy (F3)"
          >
            <Users className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>Clients</span>
            <Kbd size="sm">F3</Kbd>
          </button>

          {/* Discount (F4) */}
          <button
            data-testid="discount-button"
            onClick={() => openModal('discount')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle hover:border-line text-ui-xs text-fg transition font-medium cursor-pointer whitespace-nowrap shrink-0 h-ctl-md"
            title="Appliquer une Remise Panier (F4)"
          >
            <Percent className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span>Remise</span>
            <Kbd size="sm">F4</Kbd>
          </button>

          {/* Hold / Recall (F6) */}
          <button
            onClick={handleHoldSaleClick}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle hover:border-line text-ui-xs text-fg transition font-medium relative cursor-pointer whitespace-nowrap shrink-0 h-ctl-md"
            title="Mettre en Attente ou Reprendre (F6)"
          >
            <PauseCircle className="w-3.5 h-3.5 text-status-warn-fg shrink-0" />
            <span>Attente</span>
            {heldSales.length > 0 && (
              <span className="w-4 h-4 rounded-full bg-status-warn-fg text-slate-950 text-[10px] font-black flex items-center justify-center num">
                {heldSales.length}
              </span>
            )}
            <Kbd size="sm">F6</Kbd>
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
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle hover:border-line text-ui-xs text-fg transition font-medium cursor-pointer whitespace-nowrap shrink-0 h-ctl-md"
            title="Réimprimer le Dernier Ticket (F7)"
          >
            <Printer className="w-3.5 h-3.5 text-status-ok-fg shrink-0" />
            <span>Réimprimer</span>
            <Kbd size="sm">F7</Kbd>
          </button>

          {/* Hotkey Guide (F8) */}
          <button
            onClick={() => openModal('hotkey_guide')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle hover:border-line text-ui-xs text-fg transition font-medium cursor-pointer whitespace-nowrap shrink-0 h-ctl-md"
            title="Guide des Raccourcis Clavier (F8)"
          >
            <Keyboard className="w-3.5 h-3.5 text-status-warn-fg shrink-0" />
            <span>Guide</span>
            <Kbd size="sm">F8</Kbd>
          </button>

          {/* Reports (no hotkey — F9 opens custom items) */}
          <button
            onClick={() => openModal('reports')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle hover:border-line text-ui-xs text-fg transition font-medium cursor-pointer whitespace-nowrap shrink-0 h-ctl-md"
            title="Rapports Financiers & Synthèse"
          >
            <BarChart3 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span>Rapports</span>
          </button>

          {/* Stock (F10) */}
          <button
            onClick={() => openModal('inventory_manager')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle hover:border-line text-ui-xs text-fg transition font-medium cursor-pointer whitespace-nowrap shrink-0 h-ctl-md"
            title="Gestion de Stock & Inventaire (F10)"
          >
            <Boxes className="w-3.5 h-3.5 text-status-ok-fg shrink-0" />
            <span>Stock</span>
            <Kbd size="sm">F10</Kbd>
          </button>

          {/* Refund (F11) */}
          <button
            data-testid="refund-button"
            onClick={() => openModal('refund')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle hover:border-line text-ui-xs text-fg transition font-medium cursor-pointer whitespace-nowrap shrink-0 h-ctl-md"
            title="Retours Marchandise & Remboursements (F11)"
          >
            <RotateCcw className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span>Remboursement</span>
            <Kbd size="sm">F11</Kbd>
          </button>

          {/* Settings (F12) */}
          <button
            onClick={() => openModal('settings')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle hover:border-line text-ui-xs text-fg transition font-medium cursor-pointer whitespace-nowrap shrink-0 h-ctl-md"
            title="Paramètres & Diagnostic (F12)"
          >
            <Settings className="w-3.5 h-3.5 text-fg-muted shrink-0" />
            <span>Paramètres</span>
            <Kbd size="sm">F12</Kbd>
          </button>
          </div>
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-6" style={{ background: 'linear-gradient(to right, var(--surface-panel), transparent)' }} />
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-6" style={{ background: 'linear-gradient(to left, var(--surface-panel), transparent)' }} />
        </div>

        {/* Right Corner: Telemetry & System Clock */}
        <div className="flex items-center gap-2.5 pl-2.5 border-l border-line shrink-0 text-ui-xs">
          <button
            onClick={handleSyncClick}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-ui-sm border text-ui-2xs font-semibold transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pos-accent cursor-pointer shadow-xs shrink-0 ${
              !sync.online
                ? 'bg-surface-card text-fg-muted border-line-subtle'
                : sync.pushing || sync.pulling
                ? 'bg-pos-accent/10 border-pos-accent/30 text-pos-accent'
                : failedCount > 0
                ? 'bg-status-danger-bg border-status-danger-border text-status-danger-fg'
                : sync.pendingCount > 0
                ? 'bg-status-warn-bg border-status-warn-border text-status-warn-fg'
                : 'bg-status-ok-bg border-status-ok-border text-status-ok-fg'
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
            <span className="font-mono num">
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
                  ? 'bg-fg-muted'
                  : failedCount > 0
                  ? 'bg-status-danger-fg animate-pulse'
                  : sync.pendingCount > 0
                  ? 'bg-status-warn-fg animate-pulse'
                  : sync.relayConnected
                  ? 'bg-status-ok-fg animate-pulse'
                  : 'bg-status-ok-fg'
              }`}
            />
          </button>
          {outboxPendingCount > 500 && (
            <span
              className="text-ui-2xs font-bold text-status-warn-fg whitespace-nowrap num"
              title={`File d’envoi signée : ${outboxPendingCount} mutations en attente de passerelle`}
            >
              Backlog sync ({outboxPendingCount}). Mutations sécurisées localement.
            </span>
          )}

          <button
            onClick={() => openModal('db_maintenance')}
            className="flex items-center gap-1.5 px-2 py-1 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle text-ui-2xs font-semibold text-fg-secondary transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pos-accent cursor-pointer shadow-xs shrink-0"
            title="Moteur SQLite WAL Actif • Cliquez pour ouvrir le Centre de Maintenance"
          >
            <Database className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="font-mono">SQLite WAL</span>
            <span className="w-1.5 h-1.5 rounded-full bg-status-ok-fg animate-pulse" />
          </button>

          <BottomBarClock />

          <div
            className="w-2 h-2 rounded-full bg-status-ok-fg shadow-xs shadow-status-ok-fg/50 animate-pulse shrink-0"
            title="Système En Ligne & Synchronisé"
          />
        </div>
      </div>
    </footer>
  );
};

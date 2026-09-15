import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { CartPanel } from './components/CartPanel';
import { ProductCatalog } from './components/ProductCatalog';
import { BottomBar } from './components/BottomBar';
import { ToastProvider, useToast } from './components/ui/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SilentReceiptPrinter } from './components/SilentReceiptPrinter';
import { useKeyboardHotkeys } from './hooks/useKeyboardHotkeys';
import { useBarcodeScanner } from './hooks/useBarcodeScanner';
import { GlobalModalHost } from './components/GlobalModalHost';
import { usePosStore } from './store/usePosStore';
import { useDeviceMode } from './hooks/useDeviceMode';
import { CompanionShell } from './components/mobile/CompanionShell';
import { MobilePairingWizard } from './components/mobile/MobilePairingWizard';
import { getCloudCredentials } from './sync/keychain';
import { soundEngine } from './utils/audioFeedback';

import { isMobileDevice } from './utils/platform';
import { Smartphone, RotateCw } from 'lucide-react';

const SyncNotificationListener: React.FC = () => {
  const { showToast } = useToast();

  useEffect(() => {
    let unsub: (() => void) | undefined;
    import('./sync/SyncManager').then(({ syncManager }) => {
      unsub = syncManager.onRemoteSaleReceived((sale) => {
        try {
          soundEngine.playSuccess();
        } catch {
          // ignore sound error
        }
        const total = typeof sale.total === 'number' ? sale.total : 0;
        const receipt = (sale.receiptNumber as string) || (sale.id as string) || '';
        showToast(
          `Vente synchronisée du mobile : #${receipt} (${Math.round(total).toLocaleString('fr-DZ')} DZD)`,
          'success',
          5000
        );
      });
    }).catch(console.warn);
    return () => unsub?.();
  }, [showToast]);

  return null;
};

export const App: React.FC = () => {
  const { isMobile, setRoleMode } = useDeviceMode();
  useKeyboardHotkeys();
  const { scannerActive } = useBarcodeScanner();
  const initDatabase = usePosStore((state) => state.initDatabase);
  const cart = usePosStore((state) => state.cart);

  const [isLandscape, setIsLandscape] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.innerWidth > window.innerHeight;
  });

  useEffect(() => {
    const handleOrientation = () => {
      setIsLandscape(window.innerWidth > window.innerHeight);
    };
    window.addEventListener('resize', handleOrientation);
    window.addEventListener('orientationchange', handleOrientation);
    return () => {
      window.removeEventListener('resize', handleOrientation);
      window.removeEventListener('orientationchange', handleOrientation);
    };
  }, []);

  const [showPairingWizard, setShowPairingWizard] = useState(false);
  const [checkedCredentials, setCheckedCredentials] = useState(false);

  // Check if credentials are present for mobile companion onboarding
  useEffect(() => {
    (async () => {
      try {
        const creds = await getCloudCredentials();
        if (isMobile && (!creds || !creds.url || !creds.token)) {
          setShowPairingWizard(true);
        }
      } catch (err) {
        console.warn('Check cloud credentials error:', err);
      } finally {
        setCheckedCredentials(true);
      }
    })();
  }, [isMobile]);

  // Background two-way sync (Turso).
  React.useEffect(() => {
    let cancelled = false;
    let unsubPull: (() => void) | undefined;
    let refreshTimer: number | undefined;
    // 1. Instant Local Boot (Contract C3: <= 900ms desktop, local-first interactive)
    (async () => {
      try {
        await initDatabase();
        if (!cancelled) {
          await usePosStore.getState().refreshAfterPull();
        }
      } catch (dbErr) {
        console.warn('[boot] Local DB init error:', dbErr);
      }

      // 2. Non-blocking Background Sync & Cloud Replicas
      try {
        const { getDeviceId } = await import('./sync/device');
        const { syncManager } = await import('./sync/SyncManager');
        if (cancelled) return;
        unsubPull = syncManager.onPullApplied(() => {
          if (cancelled) return;
          if (refreshTimer) window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => {
            usePosStore.getState().refreshAfterPull().catch((err: unknown) => {
              console.warn('[sync] Instant UI refresh error:', err);
            });
          }, 50);
        });
        await syncManager.start(getDeviceId());
        if (!cancelled) await syncManager.initialPull();
      } catch (e) {
        console.warn('[boot] SyncManager background start skipped:', e);
      }

      if (!cancelled) {
        try {
          const { remirrorToDexie } = await import('./db/backfill');
          const mirrorResult = await remirrorToDexie();
          if (mirrorResult.mirrored > 0 && !cancelled) {
            usePosStore.getState().refreshAfterPull().catch(console.warn);
          }
        } catch (e) {
          console.warn('[boot] Remirror skipped:', e);
        }
      }

      if (!cancelled) {
        try {
          const { backfillAllToOutbox } = await import('./db/backfill');
          const { syncManager } = await import('./sync/SyncManager');
          const backfillResult = await backfillAllToOutbox();
          if (backfillResult.enqueued > 0 && !cancelled) {
            syncManager.notifyLocalWrite();
          }
        } catch (e) {
          console.warn('[boot] Backfill skipped:', e);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      unsubPull?.();
      import('./sync/SyncManager').then((m) => m.syncManager.stop()).catch((err: unknown) => {
        console.warn('[sync] Error stopping sync manager:', err);
      });
    };
  }, [initDatabase]);

  React.useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (cart.length > 0) {
        e.preventDefault();
        e.returnValue = 'Un encaissement est en cours. Quitter cette page fermera la session de vente.';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [cart]);

  if (isMobile) {
    if (showPairingWizard && checkedCredentials) {
      return (
        <ErrorBoundary fallbackTitle="Configuration Mobile Interceptée">
          <ToastProvider>
            <MobilePairingWizard
              onPaired={() => setShowPairingWizard(false)}
              onSkipDemo={() => setShowPairingWizard(false)}
            />
          </ToastProvider>
        </ErrorBoundary>
      );
    }

    return (
      <ErrorBoundary fallbackTitle="Erreur Mobile POS Interceptée">
        <ToastProvider>
          <SyncNotificationListener />
          <div className="h-[100dvh] w-full flex flex-col bg-pos-bg text-pos-text overflow-hidden font-sans">
            <CompanionShell onOpenPairingWizard={() => setShowPairingWizard(true)} />
            <GlobalModalHost />
          </div>
        </ToastProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary fallbackTitle="Erreur Système POS Interceptée">
      <ToastProvider>
        <SyncNotificationListener />
        <div className={`h-screen w-screen flex flex-col bg-pos-bg text-pos-text overflow-hidden font-sans transition-all duration-200 ${scannerActive ? 'ring-4 ring-inset ring-emerald-500' : ''}`}>
          {/* Orientation Guidance on Mobile PC View */}
          {isMobileDevice() && !isLandscape && (
            <div className="bg-gradient-to-r from-indigo-950 via-purple-950 to-slate-900 border-b border-indigo-500/30 px-3 py-1.5 flex items-center justify-between text-[11px] text-indigo-200 shrink-0 select-none z-40">
              <div className="flex items-center gap-2 min-w-0">
                <RotateCw className="w-3.5 h-3.5 text-cyan-400 shrink-0 animate-spin" />
                <span className="truncate font-medium">Pivotez l'écran en paysage pour une vue caisse optimale</span>
              </div>
              <button
                type="button"
                onClick={() => setRoleMode('companion_mobile')}
                className="px-2 py-0.5 rounded-lg bg-indigo-500/30 hover:bg-indigo-500/40 text-cyan-300 font-bold text-[10px] shrink-0 ml-2 cursor-pointer transition active:scale-95"
              >
                Retour Mobile
              </button>
            </div>
          )}

          {/* Top Header */}
          <Header />

          {/* Main POS Workspace */}
          <div className="flex-1 flex overflow-hidden">
            {/* Left: Cart & Payment Sidebar */}
            <CartPanel />

            {/* Right: Product Catalog Grid */}
            <ProductCatalog />
          </div>

          {/* Bottom Bar with Hotkeys & Status */}
          <BottomBar />

          {/* Floating Mobile Return Button on Touch Devices in PC view */}
          {isMobileDevice() && (
            <button
              type="button"
              onClick={() => setRoleMode('companion_mobile')}
              className="fixed bottom-12 right-3 z-50 px-3 py-1.5 rounded-xl bg-cyan-600/95 hover:bg-cyan-500 text-white font-bold text-xs shadow-xl shadow-cyan-950/60 border border-cyan-400/40 flex items-center gap-1.5 active:scale-95 transition cursor-pointer"
              title="Revenir au mode compagnon mobile"
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>Mode Mobile</span>
            </button>
          )}

          {/* Hidden Silent Thermal Receipt Printer (Direct window.print) */}
          <SilentReceiptPrinter />

          {/* Dialog Modals with Isolated Error Boundaries */}
          <GlobalModalHost />
        </div>
      </ToastProvider>
    </ErrorBoundary>
  );
};

export default App;

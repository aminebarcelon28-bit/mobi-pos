import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { CartPanel } from './components/CartPanel';
import { ProductCatalog } from './components/ProductCatalog';
import { BottomBar } from './components/BottomBar';
import { ToastProvider } from './components/ui/Toast';
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

export const App: React.FC = () => {
  const { isMobile } = useDeviceMode();
  useKeyboardHotkeys();
  const { scannerActive } = useBarcodeScanner();
  const initDatabase = usePosStore((state) => state.initDatabase);
  const cart = usePosStore((state) => state.cart);

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
    (async () => {
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
        console.warn('SyncManager start skipped:', e);
      } finally {
        if (!cancelled) {
          await initDatabase();
          if (!cancelled) {
            usePosStore.getState().refreshAfterPull().catch((err: unknown) => {
              console.warn('[sync] Post-boot UI refresh error:', err);
            });
          }
          if (!cancelled) {
            try {
              const { remirrorToDexie } = await import('./db/backfill');
              const mirrorResult = await remirrorToDexie();
              if (mirrorResult.mirrored > 0) {
                usePosStore.getState().refreshAfterPull().catch((err: unknown) => {
                  console.warn('[sync] Post-remirror UI refresh error:', err);
                });
              }
            } catch (e) {
              console.warn('Remirror skipped:', e);
            }
          }
          if (!cancelled) {
            try {
              const { backfillAllToOutbox } = await import('./db/backfill');
              const { syncManager } = await import('./sync/SyncManager');
              const backfillResult = await backfillAllToOutbox();
              if (backfillResult.enqueued > 0) {
                syncManager.notifyLocalWrite();
              }
            } catch (e) {
              console.warn('Backfill skipped:', e);
            }
          }
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
          <CompanionShell onOpenPairingWizard={() => setShowPairingWizard(true)} />
          <GlobalModalHost />
        </ToastProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary fallbackTitle="Erreur Système POS Interceptée">
      <ToastProvider>
        <div className={`h-screen w-screen flex flex-col bg-pos-bg text-pos-text overflow-hidden font-sans transition-all duration-200 ${scannerActive ? 'ring-4 ring-inset ring-emerald-500' : ''}`}>
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

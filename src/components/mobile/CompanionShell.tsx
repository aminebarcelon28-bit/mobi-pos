import React, { useState, useEffect } from 'react';
import { CompanionHeader } from './CompanionHeader';
import { AppScreenLayout } from './AppScreenLayout';
import { MobileBottomNav, type MobileTab } from './MobileBottomNav';
import { LiveActivityTab } from './tabs/LiveActivityTab';
import { CatalogSearchTab } from './tabs/CatalogSearchTab';
import { MobileCheckoutTab } from './tabs/MobileCheckoutTab';
import { KredyTab } from './tabs/KredyTab';
import { ManagementTab } from './tabs/ManagementTab';
// P11.3: diagnostics pulls in the sync engine (~267 kB) — load on first open.
const SyncDiagnosticsTab = React.lazy(() =>
  import('./tabs/SyncDiagnosticsTab').then((m) => ({ default: m.SyncDiagnosticsTab })),
);
import { usePosStore } from '../../store/usePosStore';
// P11.3: sync engine loads on demand (static import pulls ~267 kB into entry).
import { useMobileBackNavigation } from '../../hooks/useMobileBackNavigation';
import type { SaleTransaction } from '../../types/pos';
import { M3CartProtectionModal } from './M3CartProtectionModal';
import { useToast } from '../ui/Toast';

interface CompanionShellProps {
  onOpenPairingWizard?: () => void;
  /** 'parent' when embedded in a fixed-height parent container. */
  fill?: 'viewport' | 'parent';
}

export const CompanionShell: React.FC<CompanionShellProps> = ({ onOpenPairingWizard, fill = 'viewport' }) => {
  const [activeTab, setActiveTab] = useState<MobileTab>('activity');
  const cart = usePosStore((state) => state.cart);
  const holdSale = usePosStore((state) => state.holdSale);
  const clearCart = usePosStore((state) => state.clearCart);
  const logSecurityAction = usePosStore((state) => state.logSecurityAction);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [isCartProtectionOpen, setIsCartProtectionOpen] = useState(false);
  // Tab requested while the protection modal is up (tab taps are the
  // highest-traffic cart-abandon vector — previously unguarded).
  const [pendingTab, setPendingTab] = useState<MobileTab | null>(null);
  const { showToast } = useToast();

  // Android hardware back button and escape listener with cart protection
  useMobileBackNavigation({
    activeTab,
    setActiveTab,
    isMobile: true,
    onRequestCartProtection: () => {
      setIsCartProtectionOpen(true);
      return true;
    },
  });

  const handleHoldAndExit = () => {
    const res = holdSale();
    if (res && res.success) {
      showToast('Vente mise en attente avec succès !', 'success');
    }
    setIsCartProtectionOpen(false);
    setActiveTab(pendingTab ?? 'activity');
    setPendingTab(null);
  };

  const handleDiscardAndExit = () => {
    // Explicit cart abandon on tab switch: previously silent, now audited
    // like every other cart wipe.
    const units = cart.reduce((a, i) => a + i.quantity, 0);
    if (units > 0) {
      void logSecurityAction(
        'Annulation Complète Panier (Mobile)',
        `Panier abandonné au changement d'onglet (${units} unités)`,
        usePosStore.getState().activeCashier?.name?.trim() || 'Caissier',
        false,
      );
    }
    clearCart();
    showToast('Panier vidé', 'info');
    setIsCartProtectionOpen(false);
    setActiveTab(pendingTab ?? 'activity');
    setPendingTab(null);
  };

  const handleTabChange = (tab: MobileTab) => {
    if (tab !== 'checkout' && activeTab === 'checkout' && cart.length > 0) {
      setPendingTab(tab);
      setIsCartProtectionOpen(true);
      return;
    }
    setActiveTab(tab);
  };

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    import('../../sync/SyncManager')
      .then(({ syncManager }) => {
        if (cancelled) return;
        unsub = syncManager.subscribe((s) => {
          setPendingSyncCount(s.pendingCount);
        });
      })
      .catch((err: unknown) => console.warn('[shell] sync engine unavailable:', err));
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  const handleSelectSale = (sale: SaleTransaction) => {
    // Guard the receipt-modal precondition: opening 'receipt' with no current
    // transaction renders an empty modal with no feedback. Toast instead.
    if (!sale) {
      showToast('Aucune transaction à afficher.', 'warning');
      return;
    }
    usePosStore.getState().setSelectedTransactionForRefund(sale);
    usePosStore.getState().openModal('receipt');
  };

  return (
    <AppScreenLayout
      fill={fill}
      header={<CompanionHeader />}
      footer={
        <MobileBottomNav
          activeTab={activeTab}
          onTabChange={handleTabChange}
          cartCount={cart.reduce((acc, i) => acc + i.quantity, 0)}
          pendingSyncCount={pendingSyncCount}
        />
      }
    >
      {/* Main Tab Content View — tabs own their pinned/scroll regions via AppTabContent */}
      {activeTab === 'activity' && <LiveActivityTab onSelectSale={handleSelectSale} />}
      {activeTab === 'catalog' && (
        <CatalogSearchTab onAddToCart={() => setActiveTab('checkout')} />
      )}
      {activeTab === 'checkout' && (
        <MobileCheckoutTab onNavigateToCatalog={() => setActiveTab('catalog')} />
      )}
      {activeTab === 'kredy' && <KredyTab />}
      {activeTab === 'management' && <ManagementTab onOpenPairingWizard={onOpenPairingWizard} />}
      {activeTab === 'diagnostics' && (
        <React.Suspense fallback={<div className="flex-1 flex items-center justify-center text-pos-muted text-sm">Chargement…</div>}>
          <SyncDiagnosticsTab />
        </React.Suspense>
      )}

      {/* Cart Back Navigation Protection Modal */}
      <M3CartProtectionModal
        isOpen={isCartProtectionOpen}
        onContinueSale={() => {
          setIsCartProtectionOpen(false);
          setPendingTab(null);
        }}
        onHoldAndExit={handleHoldAndExit}
        onDiscardAndExit={handleDiscardAndExit}
      />
    </AppScreenLayout>
  );
};

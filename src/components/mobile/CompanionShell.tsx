import React, { useState, useEffect, useCallback } from 'react';
import { CompanionHeader } from './CompanionHeader';
import { AppScreenLayout } from './AppScreenLayout';
import { MobileBottomNav, MobileNavigationRail, type MobileTab } from './MobileBottomNav';
import { LiveActivityTab } from './tabs/LiveActivityTab';
import { CatalogSearchTab } from './tabs/CatalogSearchTab';
import { MobileCheckoutTab } from './tabs/MobileCheckoutTab';
import { KredyTab } from './tabs/KredyTab';
import { ManagementTab } from './tabs/ManagementTab';
import { SyncDiagnosticsTab } from './tabs/SyncDiagnosticsTab';
import { usePosStore } from '../../store/usePosStore';
// P11.3: sync engine loads on demand (static import pulls ~267 kB into entry).
import { useMobileBackNavigation } from '../../hooks/useMobileBackNavigation';
import { useVirtualKeyboard } from '../../hooks/useVirtualKeyboard';
import type { SaleTransaction } from '../../types/pos';
import { M3CartProtectionModal } from './M3CartProtectionModal';
import { useToast } from '../ui/Toast';
import { runViewTransition } from '../../utils/viewTransitions';

interface CompanionShellProps {
  onOpenPairingWizard?: () => void;
  /** 'parent' when embedded in a fixed-height parent container. */
  fill?: 'viewport' | 'parent';
  initialTab?: MobileTab;
}

const VALID_TABS: ReadonlySet<MobileTab> = new Set([
  'activity',
  'catalog',
  'checkout',
  'kredy',
  'management',
  'diagnostics',
]);

export const CompanionShell: React.FC<CompanionShellProps> = ({
  onOpenPairingWizard,
  fill = 'viewport',
  initialTab = 'activity',
}) => {
  const [activeTab, setActiveTabState] = useState<MobileTab>(() =>
    VALID_TABS.has(initialTab) ? initialTab : 'activity'
  );
  const { isKeyboardVisible } = useVirtualKeyboard();
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

  // Track Expanded viewport (>= 840px) for 2-pane Catalog + Checkout split (R-NAV-02, R-POS-16)
  const [isExpandedViewport, setIsExpandedViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 840px)').matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(min-width: 840px)');
    const onChange = (e: MediaQueryListEvent) => setIsExpandedViewport(e.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  const setActiveTab = useCallback((tab: MobileTab) => {
    runViewTransition(() => {
      setActiveTabState(tab);
    });
  }, []);

  // Android hardware back button and escape listener with cart protection
  useMobileBackNavigation({
    activeTab,
    setActiveTab,
    isMobile: true,
    isCartProtectionOpen,
    onDismissCartProtection: () => {
      setIsCartProtectionOpen(false);
      setPendingTab(null);
    },
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

  const handleTabChange = useCallback(
    (tab: MobileTab) => {
      if (tab !== 'checkout' && activeTab === 'checkout' && cart.length > 0) {
        setPendingTab(tab);
        setIsCartProtectionOpen(true);
        return;
      }
      setActiveTab(tab);
    },
    [activeTab, cart.length, setActiveTab],
  );

  // Listen for custom 'mobi:navigate-tab' events dispatched from CompanionHeader,
  // ManagementTab, or SyncDiagnosticsTab (ADR-001 Pillar B).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onNavigateEvent = (e: Event) => {
      const detail = (e as CustomEvent<MobileTab | { tab?: MobileTab }>).detail;
      const targetTab = typeof detail === 'string' ? detail : detail?.tab;
      if (targetTab && VALID_TABS.has(targetTab)) {
        handleTabChange(targetTab);
      }
    };
    window.addEventListener('mobi:navigate-tab', onNavigateEvent);
    return () => window.removeEventListener('mobi:navigate-tab', onNavigateEvent);
  }, [handleTabChange]);

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

  const totalCartUnits = cart.reduce((acc, i) => acc + i.quantity, 0);

  return (
    <AppScreenLayout
      fill={fill}
      header={
        <CompanionHeader
          activeTab={activeTab}
          onOpenDiagnostics={() => handleTabChange('diagnostics')}
        />
      }
      navigationRail={
        !isKeyboardVisible ? (
          <MobileNavigationRail
            activeTab={activeTab}
            onTabChange={handleTabChange}
            cartCount={totalCartUnits}
            pendingSyncCount={pendingSyncCount}
          />
        ) : undefined
      }
      footer={
        !isKeyboardVisible ? (
          <MobileBottomNav
            activeTab={activeTab}
            onTabChange={handleTabChange}
            cartCount={totalCartUnits}
            pendingSyncCount={pendingSyncCount}
          />
        ) : undefined
      }
    >
      {/* Main Tab Content View — tabs own their pinned/scroll regions via AppTabContent */}
      {activeTab === 'activity' && <LiveActivityTab onSelectSale={handleSelectSale} />}

      {activeTab === 'catalog' && (
        <CatalogSearchTab onAddToCart={() => setActiveTab('checkout')} />
      )}

      {activeTab === 'checkout' && (
        isExpandedViewport ? (
          <div className="flex-1 min-h-0 flex flex-row overflow-hidden">
            <div className="hidden lg:flex min-[840px]:flex lg:w-[52%] min-[840px]:w-[52%] border-e border-pos-border flex-col overflow-hidden">
              <CatalogSearchTab onAddToCart={() => {}} />
            </div>
            <div className="flex-1 lg:w-[48%] min-[840px]:w-[48%] min-w-[380px] flex flex-col overflow-hidden">
              <MobileCheckoutTab onNavigateToCatalog={() => setActiveTab('catalog')} />
            </div>
          </div>
        ) : (
          <MobileCheckoutTab onNavigateToCatalog={() => setActiveTab('catalog')} />
        )
      )}

      {activeTab === 'kredy' && <KredyTab />}

      {activeTab === 'management' && (
        <ManagementTab onOpenPairingWizard={onOpenPairingWizard} />
      )}

      {activeTab === 'diagnostics' && <SyncDiagnosticsTab />}

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


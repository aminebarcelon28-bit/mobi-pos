import React, { useState, useEffect } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { CompanionHeader } from './CompanionHeader';
import { AppScreenLayout } from './AppScreenLayout';
import { MobileBottomNav, type MobileTab } from './MobileBottomNav';
import { LiveActivityTab } from './tabs/LiveActivityTab';
import { CatalogSearchTab } from './tabs/CatalogSearchTab';
import { MobileCheckoutTab } from './tabs/MobileCheckoutTab';
import { KredyTab } from './tabs/KredyTab';
import { ManagementTab } from './tabs/ManagementTab';
import { SyncDiagnosticsTab } from './tabs/SyncDiagnosticsTab';
import { usePosStore } from '../../store/usePosStore';
import { syncManager } from '../../sync/SyncManager';
import { useDeviceMode } from '../../hooks/useDeviceMode';
import { useMobileBackNavigation } from '../../hooks/useMobileBackNavigation';
import type { SaleTransaction } from '../../types/pos';

interface CompanionShellProps {
  onOpenPairingWizard?: () => void;
  /** 'parent' when embedded in a fixed-height frame (device simulator). */
  fill?: 'viewport' | 'parent';
}

export const CompanionShell: React.FC<CompanionShellProps> = ({ onOpenPairingWizard, fill = 'viewport' }) => {
  const [activeTab, setActiveTab] = useState<MobileTab>('activity');
  const cart = usePosStore((state) => state.cart);
  const { setRoleMode } = useDeviceMode();
  const [pendingSyncCount, setPendingSyncCount] = useState(0);

  // Android hardware back button and escape listener
  useMobileBackNavigation({
    activeTab,
    setActiveTab,
    isMobile: true,
  });

  useEffect(() => {
    const unsub = syncManager.subscribe((s) => {
      setPendingSyncCount(s.pendingCount);
    });
    return unsub;
  }, []);

  const handleSelectSale = (sale: SaleTransaction) => {
    usePosStore.getState().setSelectedTransactionForRefund(sale);
    usePosStore.getState().openModal('receipt');
  };

  return (
    <AppScreenLayout
      fill={fill}
      header={
        <>
          {/* Top Mobile Header */}
          <CompanionHeader />

          {/* Switch to Desktop Button bar (helpful for desktop preview and store owner testing) */}
          <div className="bg-pos-panel/80 border-b border-pos-border px-3 py-1 flex items-center justify-between text-[11px] shrink-0">
            <span className="text-pos-muted flex items-center gap-1 min-w-0">
              <Smartphone className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span className="truncate">Mode Mobile Actif</span>
            </span>

            <button
              type="button"
              onClick={() => setRoleMode('pos_primary')}
              className="text-cyan-400 hover:text-cyan-300 font-bold flex items-center gap-1 px-2 py-0.5 rounded bg-pos-card border border-pos-border hover:border-cyan-400 transition cursor-pointer min-h-[44px] shrink-0"
            >
              <Monitor className="w-3 h-3" />
              <span>Passer en Mode Caisse PC</span>
            </button>
          </div>
        </>
      }
      footer={
        <MobileBottomNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
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
      {activeTab === 'checkout' && <MobileCheckoutTab />}
      {activeTab === 'kredy' && <KredyTab />}
      {activeTab === 'management' && <ManagementTab onOpenPairingWizard={onOpenPairingWizard} />}
      {activeTab === 'diagnostics' && <SyncDiagnosticsTab />}
    </AppScreenLayout>
  );
};

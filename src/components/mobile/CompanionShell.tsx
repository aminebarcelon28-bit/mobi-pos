import React, { useState, useEffect } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { CompanionHeader } from './CompanionHeader';
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
}

export const CompanionShell: React.FC<CompanionShellProps> = ({ onOpenPairingWizard }) => {
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
    <div className="h-full w-full flex flex-col bg-pos-bg text-pos-text overflow-hidden font-sans">
      {/* Top Mobile Header */}
      <CompanionHeader />

      {/* Switch to Desktop Button bar (helpful for desktop preview and store owner testing) */}
      <div className="bg-pos-panel/80 border-b border-pos-border px-3 py-1 flex items-center justify-between text-[11px] shrink-0">
        <span className="text-pos-muted flex items-center gap-1">
          <Smartphone className="w-3.5 h-3.5 text-cyan-400" />
          <span>Mode Mobile Actif</span>
        </span>

        <button
          type="button"
          onClick={() => setRoleMode('pos_primary')}
          className="text-cyan-400 hover:text-cyan-300 font-bold flex items-center gap-1 px-2 py-0.5 rounded bg-pos-card border border-pos-border hover:border-cyan-400 transition cursor-pointer"
        >
          <Monitor className="w-3 h-3" />
          <span>Passer en Mode Caisse PC</span>
        </button>
      </div>

      {/* Main Tab Content View */}
      <main className="flex-1 overflow-hidden flex flex-col relative">
        {activeTab === 'activity' && <LiveActivityTab onSelectSale={handleSelectSale} />}
        {activeTab === 'catalog' && (
          <CatalogSearchTab onAddToCart={() => setActiveTab('checkout')} />
        )}
        {activeTab === 'checkout' && <MobileCheckoutTab />}
        {activeTab === 'kredy' && <KredyTab />}
        {activeTab === 'management' && <ManagementTab onOpenPairingWizard={onOpenPairingWizard} />}
        {activeTab === 'diagnostics' && <SyncDiagnosticsTab />}
      </main>

      {/* Bottom Navigation */}
      <MobileBottomNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        cartCount={cart.reduce((acc, i) => acc + i.quantity, 0)}
        pendingSyncCount={pendingSyncCount}
      />
    </div>
  );
};

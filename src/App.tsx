import React, { Suspense } from 'react';
import { Header } from './components/Header';
import { CartPanel } from './components/CartPanel';
import { ProductCatalog } from './components/ProductCatalog';
import { BottomBar } from './components/BottomBar';
import { ToastProvider } from './components/ui/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SilentReceiptPrinter } from './components/SilentReceiptPrinter';
import { useKeyboardHotkeys } from './hooks/useKeyboardHotkeys';
import { useBarcodeScanner } from './hooks/useBarcodeScanner';

const PaymentModal = React.lazy(() => import('./components/modals/PaymentModal').then(m => ({ default: m.PaymentModal })));
const ReceiptModal = React.lazy(() => import('./components/modals/ReceiptModal').then(m => ({ default: m.ReceiptModal })));
const HoldSalesModal = React.lazy(() => import('./components/modals/HoldSalesModal').then(m => ({ default: m.HoldSalesModal })));
const DiscountModal = React.lazy(() => import('./components/modals/DiscountModal').then(m => ({ default: m.DiscountModal })));
const CustomersModal = React.lazy(() => import('./components/modals/CustomersModal').then(m => ({ default: m.CustomersModal })));
const SettingsModal = React.lazy(() => import('./components/modals/SettingsModal').then(m => ({ default: m.SettingsModal })));
const CompatibilityModal = React.lazy(() => import('./components/modals/CompatibilityModal').then(m => ({ default: m.CompatibilityModal })));
const ProductEditorModal = React.lazy(() => import('./components/modals/ProductEditorModal').then(m => ({ default: m.ProductEditorModal })));
const InventoryManagerModal = React.lazy(() => import('./components/modals/InventoryManagerModal').then(m => ({ default: m.InventoryManagerModal })));
const ReportsModal = React.lazy(() => import('./components/modals/ReportsModal').then(m => ({ default: m.ReportsModal })));
const LabelPrinterModal = React.lazy(() => import('./components/modals/LabelPrinterModal').then(m => ({ default: m.LabelPrinterModal })));
const InvoiceIngestionModal = React.lazy(() => import('./components/modals/InvoiceIngestionModal').then(m => ({ default: m.InvoiceIngestionModal })));
const ReceiptTemplateModal = React.lazy(() => import('./components/modals/ReceiptTemplateModal').then(m => ({ default: m.ReceiptTemplateModal })));
const LicensingModal = React.lazy(() => import('./components/modals/LicensingModal').then(m => ({ default: m.LicensingModal })));
const SecurityAuditModal = React.lazy(() => import('./components/modals/SecurityAuditModal').then(m => ({ default: m.SecurityAuditModal })));
const ShiftZReportModal = React.lazy(() => import('./components/modals/ShiftZReportModal').then(m => ({ default: m.ShiftZReportModal })));
const VendorProcurementModal = React.lazy(() => import('./components/modals/VendorProcurementModal').then(m => ({ default: m.VendorProcurementModal })));
const PurchaseOrderModal = React.lazy(() => import('./components/modals/PurchaseOrderModal').then(m => ({ default: m.PurchaseOrderModal })));
const RepairWorkOrderModal = React.lazy(() => import('./components/modals/RepairWorkOrderModal').then(m => ({ default: m.RepairWorkOrderModal })));
const TradeInBuybackModal = React.lazy(() => import('./components/modals/TradeInBuybackModal').then(m => ({ default: m.TradeInBuybackModal })));
const KittingBundleModal = React.lazy(() => import('./components/modals/KittingBundleModal').then(m => ({ default: m.KittingBundleModal })));
const HotkeyGuideModal = React.lazy(() => import('./components/modals/HotkeyGuideModal').then(m => ({ default: m.HotkeyGuideModal })));
const CustomerDisplayModal = React.lazy(() => import('./components/modals/CustomerDisplayModal').then(m => ({ default: m.CustomerDisplayModal })));
const PinPromptModal = React.lazy(() => import('./components/modals/PinPromptModal').then(m => ({ default: m.PinPromptModal })));
const LoyaltyCardModal = React.lazy(() => import('./components/modals/LoyaltyCardModal').then(m => ({ default: m.LoyaltyCardModal })));
const UpdateModal = React.lazy(() => import('./components/modals/UpdateModal').then(m => ({ default: m.UpdateModal })));
const RefundModal = React.lazy(() => import('./components/modals/RefundModal').then(m => ({ default: m.RefundModal })));

import { usePosStore } from './store/usePosStore';

export const App: React.FC = () => {
  useKeyboardHotkeys();
  const { scannerActive } = useBarcodeScanner();
  const initDatabase = usePosStore((state) => state.initDatabase);
  const cart = usePosStore((state) => state.cart);

  React.useEffect(() => {
    initDatabase();
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
          <Suspense fallback={null}>
            <ErrorBoundary fallbackTitle="Erreur d'Affichage du Modal">
              <PaymentModal />
              <ReceiptModal />
              <HoldSalesModal />
              <DiscountModal />
              <CustomersModal />
              <SettingsModal />
              <CompatibilityModal />
              <ProductEditorModal />
              <InventoryManagerModal />
              <ReportsModal />
              <LabelPrinterModal />
              <InvoiceIngestionModal />
              <ReceiptTemplateModal />
              <LicensingModal />
              <SecurityAuditModal />
              <ShiftZReportModal />
              <VendorProcurementModal />
              <PurchaseOrderModal />
              <RepairWorkOrderModal />
              <TradeInBuybackModal />
              <KittingBundleModal />
              <HotkeyGuideModal />
              <CustomerDisplayModal />
              <PinPromptModal />
              <LoyaltyCardModal />
              <UpdateModal />
              <RefundModal />
            </ErrorBoundary>
          </Suspense>
        </div>
      </ToastProvider>
    </ErrorBoundary>
  );
};

export default App;

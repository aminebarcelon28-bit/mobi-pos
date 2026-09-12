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
const ShiftOpenModal = React.lazy(() => import('./components/modals/ShiftOpenModal').then(m => ({ default: m.ShiftOpenModal })));
const ShiftMovementModal = React.lazy(() => import('./components/modals/ShiftMovementModal').then(m => ({ default: m.ShiftMovementModal })));
const ShiftCloseModal = React.lazy(() => import('./components/modals/ShiftCloseModal').then(m => ({ default: m.ShiftCloseModal })));
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
const WhatsAppDispatchModal = React.lazy(() => import('./components/modals/WhatsAppDispatchModal').then(m => ({ default: m.WhatsAppDispatchModal })));
const ImeiWarrantyInspectorModal = React.lazy(() => import('./components/modals/ImeiWarrantyInspectorModal').then(m => ({ default: m.ImeiWarrantyInspectorModal })));
const CommandTicketDashboardModal = React.lazy(() => import('./components/modals/CommandTicketDashboardModal').then(m => ({ default: m.CommandTicketDashboardModal })));
const DebtLedgerModal = React.lazy(() => import('./components/modals/DebtLedgerModal').then(m => ({ default: m.DebtLedgerModal })));
const ExpenseManagerModal = React.lazy(() => import('./components/modals/ExpenseManagerModal').then(m => ({ default: m.ExpenseManagerModal })));
const DatabaseMaintenanceModal = React.lazy(() => import('./components/modals/DatabaseMaintenanceModal').then(m => ({ default: m.DatabaseMaintenanceModal })));

import { usePosStore } from './store/usePosStore';

export const App: React.FC = () => {
  useKeyboardHotkeys();
  const { scannerActive } = useBarcodeScanner();
  const initDatabase = usePosStore((state) => state.initDatabase);
  const cart = usePosStore((state) => state.cart);
  const activeModal = usePosStore((state) => state.activeModal);

  // Background two-way sync (Turso). On a fresh laptop the first pull runs
  // BEFORE initDatabase, so cloud data lands in Dexie first and the demo
  // seed guard (empty-catalog check) does not fire. Failures are silent
  // (offline-first) and surfaced via useSyncStatus() where needed.
  // NOTE: initDatabase runs ONLY here (in finally) — no separate effect.
  // Later pulls that land rows refresh the UI store via onPullApplied.
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
              console.warn('[sync] Debounced UI refresh error:', err);
            });
          }, 1500);
        });
        await syncManager.start(getDeviceId());
        if (!cancelled) await syncManager.initialPull();
      } catch (e) {
        console.warn('SyncManager start skipped:', e);
      } finally {
        if (!cancelled) {
          await initDatabase();
          // Pulls that landed during boot need one refresh too.
          if (!cancelled) {
            usePosStore.getState().refreshAfterPull().catch((err: unknown) => {
              console.warn('[sync] Post-boot UI refresh error:', err);
            });
          }
          // One-time catch-up for rows pulled before the Dexie mirrors
          // existed (cursor has moved past them): mirror plugin-sql into
          // Dexie, then refresh the UI once more if anything moved.
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
          // One-time orphan backfill: anything Dexie holds that predates the
          // outbox gets enqueued now (idempotent). Then the live loops own it.
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
              {activeModal === 'payment' && <PaymentModal />}
              {activeModal === 'receipt' && <ReceiptModal />}
              {activeModal === 'hold' && <HoldSalesModal />}
              {activeModal === 'discount' && <DiscountModal />}
              {activeModal === 'customers' && <CustomersModal />}
              {activeModal === 'settings' && <SettingsModal />}
              {activeModal === 'compatibility' && <CompatibilityModal />}
              {activeModal === 'product_editor' && <ProductEditorModal />}
              {activeModal === 'inventory_manager' && <InventoryManagerModal />}
              {activeModal === 'reports' && <ReportsModal />}
              {activeModal === 'label_printer' && <LabelPrinterModal />}
              {activeModal === 'invoice_ingestion' && <InvoiceIngestionModal />}
              {activeModal === 'receipt_template' && <ReceiptTemplateModal />}
              {activeModal === 'licensing' && <LicensingModal />}
              {activeModal === 'security_audit' && <SecurityAuditModal />}
              {activeModal === 'shift_zreport' && <ShiftZReportModal />}
              {activeModal === 'shift_open' && <ShiftOpenModal />}
              {activeModal === 'shift_movement' && <ShiftMovementModal />}
              {activeModal === 'shift_close' && <ShiftCloseModal />}
              {activeModal === 'vendor_procurement' && <VendorProcurementModal />}
              {activeModal === 'purchase_order' && <PurchaseOrderModal />}
              {activeModal === 'repair_work_order' && <RepairWorkOrderModal />}
              {activeModal === 'trade_in_buyback' && <TradeInBuybackModal />}
              {activeModal === 'kitting_bundle' && <KittingBundleModal />}
              {activeModal === 'hotkey_guide' && <HotkeyGuideModal />}
              {activeModal === 'customer_display' && <CustomerDisplayModal />}
              {activeModal === 'pin_prompt' && <PinPromptModal />}
              {activeModal === 'loyalty_card' && <LoyaltyCardModal />}
              <UpdateModal />
              {activeModal === 'refund' && <RefundModal />}
              {activeModal === 'whatsapp_dispatch' && <WhatsAppDispatchModal />}
              {activeModal === 'imei_inspector' && <ImeiWarrantyInspectorModal />}
              {activeModal === 'command_tickets' && <CommandTicketDashboardModal />}
              {activeModal === 'debt_ledger' && <DebtLedgerModal />}
              {activeModal === 'expense_manager' && <ExpenseManagerModal />}
              {activeModal === 'db_maintenance' && <DatabaseMaintenanceModal />}
            </ErrorBoundary>
          </Suspense>
        </div>
      </ToastProvider>
    </ErrorBoundary>
  );
};

export default App;

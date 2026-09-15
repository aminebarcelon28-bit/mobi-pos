import React, { Suspense } from 'react';
import { usePosStore } from '../store/usePosStore';
import { ErrorBoundary } from './ErrorBoundary';

const PaymentModal = React.lazy(() => import('./modals/PaymentModal').then(m => ({ default: m.PaymentModal })));
const ReceiptModal = React.lazy(() => import('./modals/ReceiptModal').then(m => ({ default: m.ReceiptModal })));
const HoldSalesModal = React.lazy(() => import('./modals/HoldSalesModal').then(m => ({ default: m.HoldSalesModal })));
const DiscountModal = React.lazy(() => import('./modals/DiscountModal').then(m => ({ default: m.DiscountModal })));
const CustomersModal = React.lazy(() => import('./modals/CustomersModal').then(m => ({ default: m.CustomersModal })));
const SettingsModal = React.lazy(() => import('./modals/SettingsModal').then(m => ({ default: m.SettingsModal })));
const CompatibilityModal = React.lazy(() => import('./modals/CompatibilityModal').then(m => ({ default: m.CompatibilityModal })));
const ProductEditorModal = React.lazy(() => import('./modals/ProductEditorModal').then(m => ({ default: m.ProductEditorModal })));
const InventoryManagerModal = React.lazy(() => import('./modals/InventoryManagerModal').then(m => ({ default: m.InventoryManagerModal })));
const ReportsModal = React.lazy(() => import('./modals/ReportsModal').then(m => ({ default: m.ReportsModal })));
const LabelPrinterModal = React.lazy(() => import('./modals/LabelPrinterModal').then(m => ({ default: m.LabelPrinterModal })));
const InvoiceIngestionModal = React.lazy(() => import('./modals/InvoiceIngestionModal').then(m => ({ default: m.InvoiceIngestionModal })));
const ReceiptTemplateModal = React.lazy(() => import('./modals/ReceiptTemplateModal').then(m => ({ default: m.ReceiptTemplateModal })));
const LicensingModal = React.lazy(() => import('./modals/LicensingModal').then(m => ({ default: m.LicensingModal })));
const SecurityAuditModal = React.lazy(() => import('./modals/SecurityAuditModal').then(m => ({ default: m.SecurityAuditModal })));
const ShiftZReportModal = React.lazy(() => import('./modals/ShiftZReportModal').then(m => ({ default: m.ShiftZReportModal })));
const ShiftOpenModal = React.lazy(() => import('./modals/ShiftOpenModal').then(m => ({ default: m.ShiftOpenModal })));
const ShiftMovementModal = React.lazy(() => import('./modals/ShiftMovementModal').then(m => ({ default: m.ShiftMovementModal })));
const ShiftCloseModal = React.lazy(() => import('./modals/ShiftCloseModal').then(m => ({ default: m.ShiftCloseModal })));
const VendorProcurementModal = React.lazy(() => import('./modals/VendorProcurementModal').then(m => ({ default: m.VendorProcurementModal })));
const PurchaseOrderModal = React.lazy(() => import('./modals/PurchaseOrderModal').then(m => ({ default: m.PurchaseOrderModal })));
const RepairWorkOrderModal = React.lazy(() => import('./modals/RepairWorkOrderModal').then(m => ({ default: m.RepairWorkOrderModal })));
const TradeInBuybackModal = React.lazy(() => import('./modals/TradeInBuybackModal').then(m => ({ default: m.TradeInBuybackModal })));
const KittingBundleModal = React.lazy(() => import('./modals/KittingBundleModal').then(m => ({ default: m.KittingBundleModal })));
const HotkeyGuideModal = React.lazy(() => import('./modals/HotkeyGuideModal').then(m => ({ default: m.HotkeyGuideModal })));
const CustomerDisplayModal = React.lazy(() => import('./modals/CustomerDisplayModal').then(m => ({ default: m.CustomerDisplayModal })));
const PinPromptModal = React.lazy(() => import('./modals/PinPromptModal').then(m => ({ default: m.PinPromptModal })));
const LoyaltyCardModal = React.lazy(() => import('./modals/LoyaltyCardModal').then(m => ({ default: m.LoyaltyCardModal })));
const UpdateModal = React.lazy(() => import('./modals/UpdateModal').then(m => ({ default: m.UpdateModal })));
const RefundModal = React.lazy(() => import('./modals/RefundModal').then(m => ({ default: m.RefundModal })));
const WhatsAppDispatchModal = React.lazy(() => import('./modals/WhatsAppDispatchModal').then(m => ({ default: m.WhatsAppDispatchModal })));
const ImeiWarrantyInspectorModal = React.lazy(() => import('./modals/ImeiWarrantyInspectorModal').then(m => ({ default: m.ImeiWarrantyInspectorModal })));
const CommandTicketDashboardModal = React.lazy(() => import('./modals/CommandTicketDashboardModal').then(m => ({ default: m.CommandTicketDashboardModal })));
const DebtLedgerModal = React.lazy(() => import('./modals/DebtLedgerModal').then(m => ({ default: m.DebtLedgerModal })));
const ExpenseManagerModal = React.lazy(() => import('./modals/ExpenseManagerModal').then(m => ({ default: m.ExpenseManagerModal })));
const DatabaseMaintenanceModal = React.lazy(() => import('./modals/DatabaseMaintenanceModal').then(m => ({ default: m.DatabaseMaintenanceModal })));
const MobileSimulatorModal = React.lazy(() => import('./mobile/MobileSimulatorModal').then(m => ({ default: m.MobileSimulatorModal })));
const CloudPairingModal = React.lazy(() => import('./modals/CloudPairingModal').then(m => ({ default: m.CloudPairingModal })));

export const GlobalModalHost: React.FC = () => {
  const activeModal = usePosStore((state) => state.activeModal);

  return (
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
        {activeModal === 'mobile_simulator' && <MobileSimulatorModal />}
        {activeModal === 'cloud_pairing' && <CloudPairingModal />}
      </ErrorBoundary>
    </Suspense>
  );
};

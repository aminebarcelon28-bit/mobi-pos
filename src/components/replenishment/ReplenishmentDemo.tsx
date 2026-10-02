import React, { useState, useCallback } from 'react';
import { ReplenishmentModal, mockSuppliers, mockKPIs, type FilterCategory, type SupplierItem, type SupplierActionState, type ContactDetails } from '.';
import { usePosStore } from '../../store/usePosStore';
import { calculateStockAlerts } from '../../utils/alertEngine';
import { openDialer, openWhatsApp } from '../../utils/phoneUtils';

interface ReplenishmentDemoProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Fixture-backed demo of the replenishment UI (superseded on the
 * Header mount by ReplenishmentContainer, which derives live data
 * from the POS store). Retained as an isolated UI harness; contact
 * edits still commit through the real setVendorContact so the demo
 * never diverges from the native persistence contract.
 */
export const ReplenishmentDemo: React.FC<ReplenishmentDemoProps> = ({ isOpen, onClose }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterCategory>('ALL');
  const [suppliers] = useState<SupplierItem[]>(mockSuppliers);
  const [actionStates, setActionStates] = useState<Record<string, SupplierActionState>>({});

  // Production stack: the global POS store owns the procurement slice
  // (SQLite WAL persistence + sync outbox) and the modal router.
  const { createDraftPOForVendor, openModal, products, setVendorContact } = usePosStore();

  const handleCreatePO = useCallback(
    async (supplierId: string) => {
      const supplier = suppliers.find((s) => s.id === supplierId);
      if (!supplier) return;

      setActionStates((prev) => ({
        ...prev,
        [supplierId]: { ...prev[supplierId], isCreatingPO: true, isLoadingContact: false },
      }));

      try {
        // Integrity guard: never persist an empty PO. Mock suppliers map onto
        // real vendors by name; the default "Fournisseur Général" carries the
        // unassigned stock alerts (same matching rule as createDraftPOForVendor).
        const alerts = calculateStockAlerts(products).filter(
          (a) => (a.vendorName || 'Fournisseur Général') === supplier.name
        );
        if (alerts.length === 0) {
          console.warn(`[replenishment] no stock alerts for vendor "${supplier.name}" — PO draft discarded`);
          return;
        }

        // Production path: createDraftPOForVendor persists the draft to SQLite
        // (WAL) FIRST via savePurchaseOrder, then opens the purchase_order
        // modal with the live draft. Failure returns { success: false, reason }
        // and the draft is discarded — no phantom order, no dangling state.
        const result = await createDraftPOForVendor(supplier.name);
        if (!result.success) {
          console.error('[replenishment] draft PO persistence failed:', result.reason);
        }
      } catch (error) {
        console.error('Failed to initialize purchase order:', error);
      } finally {
        setActionStates((prev) => ({
          ...prev,
          [supplierId]: { ...prev[supplierId], isCreatingPO: false, isLoadingContact: false },
        }));
      }
    },
    [suppliers, createDraftPOForVendor, products]
  );

  const handleViewOrder = useCallback(
    (_supplierId: string, _orderReference: string) => {
      // Demo order references are illustrative fixtures; the honest action is
      // the real purchase-order dashboard, which lists every persisted PO.
      openModal('purchase_order');
    },
    [openModal]
  );

  const handleContactAction = useCallback(
    async (supplierId: string, action: 'call' | 'whatsapp' | 'email') => {
      const supplier = suppliers.find((s) => s.id === supplierId);
      if (!supplier) return;
      const contact = supplier.contact;

      setActionStates((prev) => ({
        ...prev,
        [supplierId]: { ...prev[supplierId], isCreatingPO: false, isLoadingContact: true },
      }));

      try {
        switch (action) {
          case 'call':
            if (contact.phone) {
              await openDialer(contact.phone);
            }
            break;
          case 'whatsapp': {
            const phone = contact.whatsapp || contact.phone;
            if (phone) {
              await openWhatsApp(phone, `Bonjour, commande de réapprovisionnement (${supplier.name})`);
            }
            break;
          }
          case 'email':
            if (contact.email) {
              window.location.href = `mailto:${contact.email}`;
            }
            break;
        }
      } catch (error) {
        console.error('Contact action failed:', error);
      } finally {
        setActionStates((prev) => ({
          ...prev,
          [supplierId]: { ...prev[supplierId], isCreatingPO: false, isLoadingContact: false },
        }));
      }
    },
    [suppliers]
  );

  // Native persistence contract: contact edits commit through the real
  // vendor directory (localStorage write-through in the procurement slice).
  const handleSaveContact = useCallback(
    (supplierId: string, contact: ContactDetails) => {
      setVendorContact(supplierId, {
        phone: contact.phone,
        whatsapp: contact.whatsapp,
        email: contact.email,
      });
    },
    [setVendorContact]
  );

  const handleResetFilters = useCallback(() => {
    setSearchQuery('');
    setActiveFilter('ALL');
  }, []);

  return (
    <ReplenishmentModal
      isOpen={isOpen}
      onClose={onClose}
      kpis={mockKPIs}
      suppliers={suppliers}
      activeFilter={activeFilter}
      onFilterChange={setActiveFilter}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      onCreatePO={handleCreatePO}
      onViewOrder={handleViewOrder}
      onContactAction={handleContactAction}
      onSaveContact={handleSaveContact}
      onResetFilters={handleResetFilters}
      actionStates={actionStates}
    />
  );
};

export default ReplenishmentDemo;

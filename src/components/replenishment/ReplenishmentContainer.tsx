import React, { useCallback, useMemo, useState } from 'react';
import {
  ReplenishmentModal,
  type FilterCategory,
  type SupplierItem,
  type ContactDetails,
  type SupplierActionState,
} from '.';
import { usePosStore } from '../../store/usePosStore';
import { calculateStockAlerts } from '../../utils/alertEngine';
import { getEffectiveCostPrice } from '../../utils/pricingEngine';
import { formatDZD } from '../../types/pos';
import type { PurchaseOrder, StockAlert } from '../../types/pos';
import { openDialer, openWhatsApp } from '../../utils/phoneUtils';

interface ReplenishmentContainerProps {
  isOpen: boolean;
  onClose: () => void;
}

const OPEN_PO_STATUSES: PurchaseOrder['status'][] = [
  'Waiting List',
  'Partially Received',
  'Draft',
];

const byCreatedDesc = (a: PurchaseOrder, b: PurchaseOrder): number => {
  const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return tb - ta;
};

/** Default JIT reorder quantity: double the threshold minus current stock. */
const suggestedQtyFor = (alert: StockAlert): number =>
  Math.max(1, alert.reorderPoint * 2 - alert.currentStock);

/**
 * Store-layer toast bridge: slices and containers that may render outside
 * the ToastProvider tree dispatch this event instead of calling useToast
 * (which throws without a provider). The provider subscribes when mounted.
 */
const notifyToast = (message: string, type: 'success' | 'error' | 'warning' | 'info') => {
  try {
    window.dispatchEvent(new CustomEvent('mobi:toast', { detail: { message, type } }));
  } catch {
    // No event bus — the underlying action remains the source of truth.
  }
};

/**
 * Stage 2 live container: replaces the mock-fixture demo as the mounted
 * orchestrator (Header bell). Derives suppliers, KPIs, line items and
 * contacts from the real POS store (calculateStockAlerts over `products`,
 * open POs from `purchaseOrders`, contacts from `vendorDirectory`) and
 * commits through the native procurement slice (setVendorContact →
 * localStorage vendor directory; createDraftPOForVendor → SQLite WAL +
 * Dexie purchaseOrders + sync_outbox event).
 */
export const ReplenishmentContainer: React.FC<ReplenishmentContainerProps> = ({
  isOpen,
  onClose,
}) => {
  const products = usePosStore((s) => s.products);
  const purchaseOrders = usePosStore((s) => s.purchaseOrders);
  const vendorDirectory = usePosStore((s) => s.vendorDirectory);
  const selectedItemsMap = usePosStore((s) => s.selectedItemsMap);
  const customQtyMap = usePosStore((s) => s.customQtyMap);
  const toggleProcurementItem = usePosStore((s) => s.toggleProcurementItem);
  const setCustomQty = usePosStore((s) => s.setCustomQty);
  const setProcurementItemsSelected = usePosStore((s) => s.setProcurementItemsSelected);
  const setVendorContact = usePosStore((s) => s.setVendorContact);
  const createDraftPOForVendor = usePosStore((s) => s.createDraftPOForVendor);
  const setActiveDraftPO = usePosStore((s) => s.setActiveDraftPO);
  const requestPoDraftBuilder = usePosStore((s) => s.requestPoDraftBuilder);
  const openModal = usePosStore((s) => s.openModal);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterCategory>('ALL');
  const [actionStates, setActionStates] = useState<Record<string, SupplierActionState>>({});

  /**
   * Registry-mounted instances (GlobalModalHost) are unmounted by
   * the activeModal switch to 'purchase_order' itself — calling
   * closeModal() there would reset activeModal and immediately
   * kill the PO modal. Only locally-mounted instances (Header
   * bell) need the explicit close. Captured once at mount.
   */
  const [registryMounted] = useState(
    () => usePosStore.getState().activeModal === 'vendor_procurement',
  );

  // ── 2.1 Live data derivation ──────────────────────────────────────────
  const alerts = useMemo(() => calculateStockAlerts(products), [products]);
  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const suppliers = useMemo<SupplierItem[]>(() => {
    const byVendor = new Map<string, StockAlert[]>();
    for (const alert of alerts) {
      const vendor = alert.vendorName || 'Fournisseur Général';
      const list = byVendor.get(vendor);
      if (list) {
        list.push(alert);
      } else {
        byVendor.set(vendor, [alert]);
      }
    }

    return [...byVendor.entries()].map(([name, vendorAlerts]) => {
      const directory = vendorDirectory[name];
      const orders = purchaseOrders
        .filter((po) => po.vendorName === name && OPEN_PO_STATUSES.includes(po.status))
        .sort(byCreatedDesc)
        .map((po) => ({
          reference: po.poNumber,
          status: po.status === 'Partially Received' ? ('PARTIELLE' as const) : ('EN_COURS' as const),
          date: po.createdAt ? po.createdAt.slice(0, 10) : '',
          totalFormatted: formatDZD(po.totalAmount),
        }));

      return {
        id: name,
        name,
        totalReferences: vendorAlerts.length,
        outOfStockCount: vendorAlerts.filter((a) => a.currentStock <= 0).length,
        contact: {
          phone: directory?.phone,
          whatsapp: directory?.whatsapp ?? directory?.phone,
          email: directory?.email,
        },
        activeOrders: orders,
        items: vendorAlerts.map((alert) => {
          const prod = productsById.get(alert.productId);
          return {
            productId: alert.productId,
            title: alert.title,
            sku: alert.sku,
            barcode: prod?.barcode,
            currentStock: alert.currentStock,
            reorderPoint: alert.reorderPoint,
            suggestedQty: suggestedQtyFor(alert),
            unitCost: prod ? getEffectiveCostPrice(prod) : 0,
            severity: alert.severity,
          };
        }),
      };
    });
  }, [alerts, productsById, purchaseOrders, vendorDirectory]);

  const kpis = useMemo(() => {
    // Wholesalers = unique vendors with at least one active alert OR a
    // catalog reference (directive §2.1).
    const alertVendors = new Set(alerts.map((a) => a.vendorName || 'Fournisseur Général'));
    const catalogVendors = new Set(products.map((p) => p.vendorName || 'Fournisseur Général'));
    const wholesalersCount = new Set([...alertVendors, ...catalogVendors]).size;
    // Strict split: ruptures are stock<=0, sous-seuil is stock>0 under threshold.
    const underThresholdCount = alerts.filter((a) => a.currentStock > 0).length;
    const outOfStockCount = alerts.filter((a) => a.currentStock <= 0).length;
    const totalBudget = alerts.reduce((sum, alert) => {
      const prod = productsById.get(alert.productId);
      const unitCost = prod ? getEffectiveCostPrice(prod) : 0;
      return sum + suggestedQtyFor(alert) * unitCost;
    }, 0);
    return {
      wholesalersCount,
      underThresholdCount,
      outOfStockCount,
      totalBudgetFormatted: formatDZD(totalBudget),
    };
  }, [alerts, products, productsById]);

  // ── 2.2 Native contact persistence (zero circular delegation) ─────────
  const handleSaveContact = useCallback(
    (supplierId: string, contact: ContactDetails) => {
      // Supplier id IS the vendor name (grouping key).
      setVendorContact(supplierId, {
        phone: contact.phone,
        whatsapp: contact.whatsapp,
        email: contact.email,
      });
      notifyToast(`Coordonnées enregistrées pour ${supplierId}.`, 'success');
    },
    [setVendorContact],
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
              await openWhatsApp(phone, `Bonjour ${supplier.name}, commande de réapprovisionnement JIT.`);
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
          [supplierId]: { ...prev[supplierId], isLoadingContact: false },
        }));
      }
    },
    [suppliers],
  );

  // ── 2.4 Production PO generation + sync pipeline ──────────────────────
  const handleCreatePO = useCallback(
    async (supplierId: string) => {
      const supplier = suppliers.find((s) => s.id === supplierId);
      if (!supplier) return;

      setActionStates((prev) => ({
        ...prev,
        [supplierId]: { ...prev[supplierId], isCreatingPO: true, isLoadingContact: false },
      }));

      try {
        // Integrity guard: never persist an empty PO.
        if (!supplier.items || supplier.items.length === 0) {
          console.warn(`[replenishment] no stock alerts for vendor "${supplier.name}" — PO draft discarded`);
          return;
        }

        // Assemble line items from the live selection (all items selected
        // by default, matching the store's undefined === selected semantics).
        const selected = supplier.items.filter((it) => selectedItemsMap[it.productId] !== false);
        const lineItems = selected.map((it) => ({
          productId: it.productId,
          qty: customQtyMap[it.productId] !== undefined ? customQtyMap[it.productId] : it.suggestedQty,
          unitCost: it.unitCost,
        }));

        // Persist-first: createDraftPOForVendor commits to SQLite WAL +
        // Dexie purchaseOrders and enqueues the sync_outbox event BEFORE
        // any state transition. A failed save returns { success: false }
        // and no draft is opened.
        const result = await createDraftPOForVendor(
          supplier.name,
          lineItems.length > 0 ? lineItems : undefined,
        );
        if (!result.success) {
          notifyToast(
            `Échec de l'enregistrement du brouillon (${result.reason || 'inconnu'})`,
            'error',
          );
          return;
        }

        // The slice set activeModal='purchase_order' — the PO modal
        // (review + physical verification) takes over. Registry-mounted
        // instances unmount on the switch; only the Header-mounted
        // instance needs the explicit close.
        if (!registryMounted) {
          onClose();
        }
      } catch (error) {
        console.error('Failed to initialize purchase order:', error);
        notifyToast('Erreur lors de la création du bon de commande.', 'error');
      } finally {
        setActionStates((prev) => ({
          ...prev,
          [supplierId]: { ...prev[supplierId], isCreatingPO: false },
        }));
      }
    },
    [suppliers, selectedItemsMap, customQtyMap, createDraftPOForVendor, onClose, registryMounted],
  );

  /** Opens the PO review and closes this view — unless we are
   *  registry-mounted, in which case the activeModal switch to
   *  'purchase_order' performs the unmount. */
  const routeToPurchaseOrder = useCallback(() => {
    openModal('purchase_order');
    if (!registryMounted) {
      onClose();
    }
  }, [openModal, onClose, registryMounted]);

  const handleViewOrder = useCallback(
    (_supplierId: string, orderReference: string) => {
      // Deep-link: load the specific order into the active draft
      // slot so PurchaseOrderModal opens directly on its
      // contrôle/réception view — not the generic waiting list.
      const targetPO = purchaseOrders.find(
        (po) => po.poNumber === orderReference || po.id === orderReference,
      );
      if (targetPO) {
        setActiveDraftPO(targetPO);
      } else {
        console.warn(`[Replenishment] Purchase order ${orderReference} not found in store.`);
      }
      routeToPurchaseOrder();
    },
    [purchaseOrders, setActiveDraftPO, routeToPurchaseOrder],
  );

  /** 5th toolbar action: 1-click manual PO creation — clear any
   *  active draft and request the draft-builder tab directly. */
  const handleGenerateNewPO = useCallback(() => {
    setActiveDraftPO(null);
    requestPoDraftBuilder();
    routeToPurchaseOrder();
  }, [setActiveDraftPO, requestPoDraftBuilder, routeToPurchaseOrder]);

  const handleToggleItem = useCallback(
    (productId: string) => {
      toggleProcurementItem(productId);
    },
    [toggleProcurementItem],
  );

  const handleQtyChange = useCallback(
    (productId: string, qty: number) => {
      setCustomQty(productId, Math.max(1, Math.floor(qty)));
    },
    [setCustomQty],
  );

  const handleToggleSelectAll = useCallback(
    (productIds: string[], selected: boolean) => {
      setProcurementItemsSelected(productIds, selected);
    },
    [setProcurementItemsSelected],
  );

  const handleResetFilters = useCallback(() => {
    setSearchQuery('');
    setActiveFilter('ALL');
  }, []);

  if (!isOpen) return null;

  return (
    <ReplenishmentModal
      isOpen={isOpen}
      onClose={onClose}
      kpis={kpis}
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
      onGenerateNewPO={handleGenerateNewPO}
      actionStates={actionStates}
      selectedItems={selectedItemsMap}
      customQty={customQtyMap}
      onToggleItem={handleToggleItem}
      onQtyChange={handleQtyChange}
      onToggleSelectAll={handleToggleSelectAll}
    />
  );
};

export default ReplenishmentContainer;

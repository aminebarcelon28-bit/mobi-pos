import type { StockAlertSeverity } from '../../types/pos';

export interface ContactDetails {
  phone?: string;
  whatsapp?: string;
  email?: string;
}

export type ActiveOrderStatus = 'EN_COURS' | 'PARTIELLE' | 'EXPEDIEE';

export interface ActiveOrderSummary {
  reference: string;
  status: ActiveOrderStatus;
  date: string;
  totalFormatted: string;
}

/**
 * Live line item derived from a real stock alert (Stage 2).
 * `suggestedQty` is the default JIT reorder quantity:
 * max(1, 2×reorderPoint − currentStock).
 */
export interface ReplenishmentLineItem {
  productId: string;
  title: string;
  sku: string;
  /** Product barcode (search vector C); populated by the container from the product record. */
  barcode?: string;
  currentStock: number;
  reorderPoint: number;
  suggestedQty: number;
  unitCost: number;
  severity: StockAlertSeverity;
}

export interface SupplierItem {
  id: string;
  name: string;
  totalReferences: number;
  outOfStockCount: number;
  contact: ContactDetails;
  isOfficial?: boolean;
  activeOrders?: ActiveOrderSummary[];
  /** Live alert-derived line items (Stage 2); absent on fixtures. */
  items?: ReplenishmentLineItem[];
}

export interface ReplenishmentKPIs {
  wholesalersCount: number;
  underThresholdCount: number;
  outOfStockCount: number;
  totalBudgetFormatted: string;
}

export type FilterCategory = 'ALL' | 'RUPTURES' | 'PENDING' | 'ORDERS';

export interface SupplierActionState {
  isCreatingPO: boolean;
  isLoadingContact: boolean;
}

export interface ReplenishmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  kpis: ReplenishmentKPIs;
  suppliers: SupplierItem[];
  activeFilter: FilterCategory;
  onFilterChange: (filter: FilterCategory) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onCreatePO: (supplierId: string) => void | Promise<void>;
  onViewOrder?: (supplierId: string, orderReference: string) => void;
  onContactAction: (supplierId: string, action: 'call' | 'whatsapp' | 'email') => void;
  /** Commits an inline contact edit straight to the vendor directory. */
  onSaveContact: (supplierId: string, contact: ContactDetails) => void;
  onResetFilters?: () => void;
  /** 5th toolbar action: 1-click manual PO creation. */
  onGenerateNewPO?: () => void;
  actionStates?: Record<string, SupplierActionState>;
  isSubmitting?: boolean;
  /** Live selection + quantity maps (store-owned, shared with the PO flow). */
  selectedItems?: Record<string, boolean>;
  customQty?: Record<string, number>;
  onToggleItem?: (productId: string) => void;
  onQtyChange?: (productId: string, qty: number) => void;
  onToggleSelectAll?: (productIds: string[], selected: boolean) => void;
}

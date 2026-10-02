export interface ContactDetails {
  phone?: string;
  whatsapp?: string;
  email?: string;
}

export interface SupplierItem {
  id: string;
  name: string;
  totalReferences: number;
  outOfStockCount: number;
  contact: ContactDetails;
  isOfficial?: boolean;
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
  onViewDetails: (supplierId: string) => void;
  onContactAction: (supplierId: string, action: 'call' | 'whatsapp' | 'email') => void;
  onAddContact: (supplierId: string) => void;
  onResetFilters?: () => void;
  actionStates?: Record<string, SupplierActionState>;
  isSubmitting?: boolean;
}
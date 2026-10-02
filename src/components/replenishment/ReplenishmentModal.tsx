import React, { useCallback, useMemo, useDeferredValue } from 'react';
import { createPortal } from 'react-dom';
import type { ReplenishmentModalProps, FilterCategory } from './types';
import { ReplenishmentHeader } from './ReplenishmentHeader';
import { KPISummaryBar } from './KPISummaryBar';
import { FilterToolbar } from './FilterToolbar';
import { SupplierCard } from './SupplierCard';
import { ReplenishmentEmptyState } from './ReplenishmentEmptyState';
import { useBodyScrollLock } from './useBodyScrollLock';
import { useFocusTrap } from './useFocusTrap';

export const ReplenishmentModal: React.FC<ReplenishmentModalProps> = ({
  isOpen,
  onClose,
  kpis,
  suppliers = [],
  activeFilter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  onCreatePO,
  onViewDetails,
  onContactAction,
  onAddContact,
  onResetFilters,
  actionStates,
  isSubmitting = false,
}) => {
  const focusTrapRef = useFocusTrap({ isActive: isOpen, onEscape: onClose });

  useBodyScrollLock(isOpen);

  const deferredSearchQuery = useDeferredValue(searchQuery);

  const filterCounts = useMemo<Partial<Record<FilterCategory, number>>>(() => {
    let ruptures = 0;
    let pending = 0;
    for (const supplier of suppliers) {
      if (supplier.outOfStockCount > 0) {
        ruptures += 1;
      } else if (supplier.totalReferences > 0) {
        pending += 1;
      }
    }
    return {
      ALL: suppliers.length,
      RUPTURES: ruptures,
      PENDING: pending,
      ORDERS: suppliers.length,
    };
  }, [suppliers]);

  const filteredSuppliers = useMemo(() => {
    const needle = deferredSearchQuery.trim().toLowerCase();
    return suppliers.filter((supplier) => {
      const name = supplier.name?.toLowerCase() ?? '';
      const matchesSearch = !needle || name.includes(needle);
      const matchesFilter =
        activeFilter === 'ALL' ||
        (activeFilter === 'RUPTURES' && supplier.outOfStockCount > 0) ||
        (activeFilter === 'PENDING' && supplier.outOfStockCount === 0 && supplier.totalReferences > 0) ||
        (activeFilter === 'ORDERS');
      return matchesSearch && matchesFilter;
    });
  }, [suppliers, deferredSearchQuery, activeFilter]);

  const handleResetFilters = useCallback(() => {
    onSearchChange('');
    onFilterChange('ALL');
    onResetFilters?.();
  }, [onSearchChange, onFilterChange, onResetFilters]);

  if (!isOpen) return null;

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none bg-slate-900/60 dark:bg-slate-950/75 backdrop-blur-sm animate-in fade-in isolate"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={focusTrapRef}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="replenishment-modal-title"
        aria-describedby="replenishment-modal-subtitle"
        className="w-full sm:max-w-5xl mx-auto max-h-[100dvh] sm:max-h-[90dvh] flex flex-col bg-white dark:bg-slate-950 border border-gray-200 dark:border-slate-800 rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl will-change-transform animate-in slide-in-from-bottom-5 sm:zoom-in-95"
      >
        <ReplenishmentHeader
          title="Réapprovisionnement Fournisseurs"
          subtitle="Gestion des commandes fournisseurs et réapprovisionnement JIT"
          algorithmLabel="JIT • Vélocité ventes • Seuils • Franco/MOQ"
          badge="ENTERPRISE V2"
          onClose={onClose}
          closeLabel="Fermer le réapprovisionnement"
          isLoading={isSubmitting}
        />

        <KPISummaryBar kpis={kpis} />

        <FilterToolbar
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          activeFilter={activeFilter}
          onFilterChange={onFilterChange}
          counts={filterCounts}
        />

        <main
          id="replenishment-modal-content"
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain p-3 sm:p-5 space-y-3 bg-gray-50 dark:bg-slate-900"
          aria-label="Liste des fournisseurs"
        >
          <div id="supplier-count-announcer" className="sr-only" aria-live="polite" aria-atomic="true">
            {filteredSuppliers.length} fournisseur{filteredSuppliers.length > 1 ? 's' : ''} trouvé{filteredSuppliers.length > 1 ? 's' : ''}
          </div>

          {filteredSuppliers.length === 0 ? (
            <ReplenishmentEmptyState
              searchQuery={searchQuery}
              activeFilter={activeFilter}
              hasSuppliers={suppliers.length > 0}
              onResetFilters={handleResetFilters}
            />
          ) : (
            filteredSuppliers.map((supplier) => (
              <SupplierCard
                key={supplier.id}
                supplier={supplier}
                onCreatePO={() => onCreatePO(supplier.id)}
                onViewDetails={() => onViewDetails(supplier.id)}
                onContactAction={(action) => onContactAction(supplier.id, action)}
                onAddContact={() => onAddContact(supplier.id)}
                actionState={actionStates?.[supplier.id]}
              />
            ))
          )}
        </main>
      </div>
    </div>
  );

  if (typeof document !== 'undefined') {
    return createPortal(modalContent, document.body);
  }

  return null;
};

export default ReplenishmentModal;
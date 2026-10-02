import React from 'react';
import { Truck, RotateCcw, Search, Filter } from 'lucide-react';

interface ReplenishmentEmptyStateProps {
  searchQuery: string;
  activeFilter: string;
  hasSuppliers: boolean;
  onResetFilters: () => void;
  onAddSupplier?: () => void;
}

export const ReplenishmentEmptyState: React.FC<ReplenishmentEmptyStateProps> = ({
  searchQuery,
  activeFilter,
  hasSuppliers,
  onResetFilters,
  onAddSupplier,
}) => {
  const hasActiveFilters = searchQuery.trim().length > 0 || activeFilter !== 'ALL';

  if (!hasSuppliers) {
    return (
      <div className="text-center py-16 px-4 text-gray-500 bg-white border border-gray-200 rounded-xl shadow-sm max-w-lg mx-auto space-y-4" role="status" aria-live="polite">
        <Truck className="w-16 h-16 mx-auto mb-4 opacity-40 text-emerald-400" aria-hidden="true" />
        <p className="text-lg font-bold text-gray-900">Aucun fournisseur configuré</p>
        <p className="text-sm text-gray-500">
          Commencez par ajouter un fournisseur pour gérer vos réapprovisionnements.
        </p>
        {onAddSupplier && (
          <button
            type="button"
            onClick={onAddSupplier}
            className="mx-auto px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm rounded-lg transition-colors inline-flex items-center justify-center gap-2 min-h-[44px] shadow-sm"
          >
            <Truck className="w-4 h-4" />
            Ajouter un fournisseur
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="text-center py-16 px-4 text-gray-500 bg-white border border-gray-200 rounded-xl shadow-sm max-w-lg mx-auto space-y-4" role="status" aria-live="polite">
      <div className="w-16 h-16 mx-auto mb-4 opacity-40 bg-gray-100 rounded-full flex items-center justify-center">
        {searchQuery ? (
          <Search className="w-8 h-8 text-gray-400" aria-hidden="true" />
        ) : (
          <Filter className="w-8 h-8 text-gray-400" aria-hidden="true" />
        )}
      </div>
      <p className="text-lg font-bold text-gray-900">
        {searchQuery
          ? `Aucun résultat pour « ${searchQuery} »`
          : 'Aucun fournisseur ne correspond au filtre'}
      </p>
      <p className="text-sm text-gray-500">
        {hasActiveFilters
          ? 'Essayez de modifier votre recherche ou réinitialisez les filtres.'
          : 'Aucun fournisseur ne correspond aux critères actuels.'}
      </p>
      {hasActiveFilters && (
        <button
          type="button"
          onClick={onResetFilters}
          className="mx-auto px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm rounded-lg transition-colors inline-flex items-center justify-center gap-2 min-h-[44px] shadow-sm"
        >
          <RotateCcw className="w-4 h-4" />
          Réinitialiser les filtres
        </button>
      )}
    </div>
  );
};

export default ReplenishmentEmptyState;
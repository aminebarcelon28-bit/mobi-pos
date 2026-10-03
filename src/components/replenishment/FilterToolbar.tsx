import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, X, ChevronDown, Store, AlertTriangle, Clock, PackageCheck, FilePlus } from 'lucide-react';
import type { FilterCategory } from './types';

export interface FilterToolbarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  activeFilter: FilterCategory;
  onFilterChange: (filter: FilterCategory) => void;
  debounceMs?: number;
  wholesalers?: { id: string; name: string }[];
  selectedWholesalerId?: string | null;
  onWholesalerChange?: (id: string | null) => void;
  counts?: Partial<Record<FilterCategory, number>>;
  /** 5th ribbon item: 1-click manual PO creation shortcut. */
  onGenerateNewPO?: () => void;
}

interface FilterOptionConfig {
  value: FilterCategory;
  label: string;
  icon?: React.ReactNode;
}

const filterOptions: FilterOptionConfig[] = [
  { value: 'ALL', label: 'Toutes' },
  { value: 'RUPTURES', label: 'Ruptures', icon: <AlertTriangle className="w-3.5 h-3.5 shrink-0"/> },
  { value: 'PENDING', label: 'En attente', icon: <Clock className="w-3.5 h-3.5 shrink-0"/> },
  { value: 'ORDERS', label: 'Commandes', icon: <PackageCheck className="w-3.5 h-3.5 shrink-0"/> },
];

export const FilterToolbar: React.FC<FilterToolbarProps> = ({
  searchQuery,
  onSearchChange,
  activeFilter,
  onFilterChange,
  debounceMs = 300,
  wholesalers = [],
  selectedWholesalerId = null,
  onWholesalerChange,
  counts = {},
  onGenerateNewPO,
}) => {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const [lastPropQuery, setLastPropQuery] = useState(searchQuery);

  // Sync internal input state when the parent modifies or clears searchQuery externally.
  // Adjusted during render (React's documented pattern) rather than in an effect to
  // avoid the extra commit pass and a stale keystroke window.
  if (searchQuery !== lastPropQuery) {
    setLastPropQuery(searchQuery);
    setLocalQuery(searchQuery);
  }

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const debouncedDispatch = useCallback(
    (value: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        onSearchChange(value);
      }, debounceMs);
    },
    [onSearchChange, debounceMs]
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setLocalQuery(next);
    debouncedDispatch(next);
  };

  const handleClearSearch = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    setLocalQuery('');
    onSearchChange('');
    searchInputRef.current?.focus({ preventScroll: true });
  }, [onSearchChange]);

  const selectedWholesaler = useMemo(
    () => wholesalers.find((w) => w.id === selectedWholesalerId) ?? null,
    [wholesalers, selectedWholesalerId]
  );

  return (
    <div
      className="bg-white dark:bg-slate-950 border-b border-gray-200 dark:border-slate-800 p-3 sm:px-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shrink-0"
      role="search"
      aria-label="Filtres de réapprovisionnement"
    >
      {/* Left Group: Search Input + Wholesaler Combobox Trigger */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto shrink-0">
        {/* Search Input Container */}
        <div className="relative w-full sm:w-56 md:w-64 lg:w-72 shrink-0">
          <Search aria-hidden="true" className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500 pointer-events-none"/>
          <input
            ref={searchInputRef}
            type="search"
            value={localQuery}
            onChange={handleInputChange}
            placeholder="Filtrer par Grossiste, Produit, SKU..."
            className="w-full bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg pl-9 pr-9 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-slate-500 focus:border-emerald-500 dark:focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:focus:ring-emerald-500/30 min-h-[44px] transition-colors"
            aria-label="Filtrer par Grossiste, Produit, SKU"
            aria-describedby="search-hint"
            autoComplete="off"
            spellCheck="false"
          />
          <span id="search-hint" className="sr-only">
            Tapez pour filtrer les fournisseurs par nom, référence ou SKU.
          </span>
          {localQuery.length > 0 && (
            <button
              type="button"
              onClick={handleClearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 focus:text-gray-900 dark:focus:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 rounded-full p-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer transition-colors"
              aria-label="Effacer la recherche"
            >
              <X aria-hidden="true" className="w-4 h-4"/>
            </button>
          )}
        </div>

        {/* Wholesaler Trigger Button */}
        {wholesalers.length > 0 && (
          <div
            className="relative shrink-0"
            role="combobox"
            aria-label="Sélectionner un grossiste"
            aria-expanded="false"
            aria-haspopup="listbox"
          >
            <button
              type="button"
              onClick={() => onWholesalerChange?.(null)}
              className="w-full sm:w-40 md:w-44 min-h-[44px] bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 dark:text-slate-200 flex items-center justify-between gap-1.5 focus:border-emerald-500 dark:focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer hover:border-gray-300 dark:hover:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
              aria-label={selectedWholesaler ? `${selectedWholesaler.name} — Grossiste sélectionné` : '+ Choisir Grossiste'}
            >
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <Store aria-hidden="true" className="w-4 h-4 text-gray-400 dark:text-slate-500 shrink-0"/>
                <span className="truncate block text-left">
                  {selectedWholesaler ? selectedWholesaler.name : '+ Choisir Grossiste'}
                </span>
              </div>
              <ChevronDown aria-hidden="true" className="w-4 h-4 text-gray-400 dark:text-slate-500 shrink-0"/>
            </button>
          </div>
        )}
      </div>

      {/* Right Group: Status Filter Ribbon */}
      <div
        className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto whitespace-nowrap py-0.5 no-scrollbar"
        role="tablist"
        aria-label="Filtres de statut et actions"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {filterOptions.map(({ value, label, icon }) => {
          const count = counts[value];
          const hasCount = typeof count === 'number';
          const isSelected = activeFilter === value;

          return (
            <button
              key={value}
              type="button"
              onClick={() => onFilterChange(value)}
              role="tab"
              aria-selected={isSelected}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs sm:text-sm transition-all duration-150 cursor-pointer shrink-0 min-h-[44px] active:scale-[0.98] border ${
                isSelected
                  ? 'font-semibold bg-emerald-600 text-white border-emerald-600 dark:bg-emerald-500 dark:text-slate-950 dark:border-emerald-500 ring-2 ring-emerald-600/30 dark:ring-emerald-500/20 shadow-sm'
                  : 'font-medium bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200 hover:border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700 dark:hover:border-slate-600'
              }`}
            >
              {icon}
              <span>{label}</span>
              {hasCount && (
                <span
                  className={`text-[11px] font-semibold tabular-nums ml-0.5 px-1.5 py-0.2 rounded-full ${
                    isSelected
                      ? 'bg-white/20 text-white dark:bg-slate-950/20 dark:text-slate-950'
                      : 'bg-slate-200/80 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}

        </div>

        {/* 5th action: 1-click manual PO creation — a shrink-0 sibling of
            the scrollable ribbon (never a tablist child, so ARIA tablist
            semantics stay valid and the ribbon's overflow-x-auto can never
            clip this action). */}
        {onGenerateNewPO && (
          <button
            type="button"
            onClick={onGenerateNewPO}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs sm:text-sm font-semibold transition-all duration-150 cursor-pointer shrink-0 min-h-[44px] active:scale-[0.98] border border-emerald-600 bg-emerald-600/10 hover:bg-emerald-600 hover:text-white text-emerald-700 dark:text-emerald-300 dark:border-emerald-500/50 dark:hover:bg-emerald-600 shadow-sm"
            title="Créer un nouveau bon de commande manuel"
            aria-label="+ Nouveau Bon de commande"
          >
            <FilePlus aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
            <span className="whitespace-nowrap">+ Nouveau Bon</span>
          </button>
        )}
      </div>
    );
  };

export default FilterToolbar;
import React from 'react';
import { X, Truck, Cpu } from 'lucide-react';
import type { ReactNode } from 'react';

export interface ReplenishmentHeaderProps {
  title: string;
  subtitle?: string;
  algorithmLabel?: string;
  badge?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  isLoading?: boolean;
}

export const ReplenishmentHeader: React.FC<ReplenishmentHeaderProps> = ({
  title,
  subtitle = 'Réapprovisionnement Fournisseurs',
  algorithmLabel = 'JIT • Vélocité ventes • Seuils • Franco/MOQ',
  badge,
  onClose,
  closeLabel = 'Fermer',
  isLoading = false,
}) => {
  return (
    <header className="flex-none isolate bg-white dark:bg-slate-950 border-b border-gray-200 dark:border-slate-800" role="banner">
      {/* Drag Handle — Mobile Bottom Sheet Visual Affordance Only */}
      <div
        className="w-10 h-1 rounded-full bg-slate-300 dark:bg-slate-700 mx-auto mt-2.5 mb-1 block sm:hidden"
        aria-hidden="true"
      />

      <div className="p-3 sm:px-5 sm:py-3.5 flex items-center justify-between gap-3">
        {/* Left Identity Zone: Icon + Title/Subtitle Stack */}
        <div className="flex items-center gap-3 min-w-0 flex-1 mr-2">
          {/* Main Module Icon */}
          <div
            className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/60 dark:border-emerald-800/50 flex items-center justify-center text-emerald-700 dark:text-emerald-400 shrink-0"
            aria-hidden="true"
          >
            <Truck className="w-4 h-4 sm:w-5 sm:h-5"/>
          </div>

          {/* Fluid Typography Container */}
          <div className="min-w-0 flex-1">
            {/* Row 1: Modal Heading + Enterprise Badge */}
            <div className="flex items-center gap-2 min-w-0">
              <h2
                id="replenishment-modal-title"
                className="text-base sm:text-lg font-bold text-gray-900 dark:text-white tracking-tight truncate block"
              >
                {isLoading ? (
                  <span className="inline-block h-5 w-48 animate-pulse bg-slate-200 dark:bg-slate-800 rounded" aria-hidden="true" />
                ) : (
                  title
                )}
              </h2>

              {badge && (
                <div
                  className="inline-flex shrink-0 text-[10px] sm:text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 px-2 py-0.5 rounded-full whitespace-nowrap"
                  aria-label={typeof badge === 'string' ? `Statut: ${badge}` : undefined}
                >
                  {badge}
                </div>
              )}
            </div>

            {/* Row 2: Subtitle + Algorithm Indicator */}
            <div className="mt-0.5 flex items-center gap-2 flex-wrap min-w-0" id="replenishment-modal-subtitle">
              <span className="text-xs text-slate-500 dark:text-slate-400 truncate block">
                {isLoading ? (
                  <span className="inline-block h-3.5 w-32 animate-pulse bg-slate-200 dark:bg-slate-800 rounded" aria-hidden="true" />
                ) : (
                  subtitle
                )}
              </span>

              {algorithmLabel && !isLoading && (
                <>
                  <span className="text-slate-300 dark:text-slate-700 hidden sm:inline" aria-hidden="true">•</span>
                  <span
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 px-2 py-0.5 rounded-md shrink-0 truncate max-w-full"
                    title={algorithmLabel}
                  >
                    <Cpu aria-hidden="true" className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0"/>
                    <span className="truncate">{algorithmLabel}</span>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right Zone: Accessible Dismiss Trigger */}
        <button
          type="button"
          onClick={onClose}
          disabled={isLoading}
          aria-busy={isLoading}
          className="p-2 hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 dark:focus:ring-offset-slate-950"
          aria-label={closeLabel}
        >
          <X aria-hidden="true" className="w-5 h-5"/>
        </button>
      </div>
    </header>
  );
};

export default ReplenishmentHeader;
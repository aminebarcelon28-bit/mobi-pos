import React from 'react';
import { Truck, AlertTriangle, PackageCheck, Coins } from 'lucide-react';
import type { ReplenishmentKPIs } from './types';

interface KPISummaryBarProps {
  kpis: ReplenishmentKPIs;
}

const KPIItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  valueColor: string;
  iconColor: string;
  bgColor: string;
  ariaLabel: string;
}> = ({ icon, label, value, valueColor, iconColor, bgColor, ariaLabel }) => (
  <article
    className="flex flex-col items-center gap-1 min-w-0 overflow-hidden"
    aria-label={ariaLabel}
  >
    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${bgColor} shrink-0`} aria-hidden="true">
      <span className={`w-4 h-4 ${iconColor}`}>{icon}</span>
    </div>
    <span
      className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 truncate block w-full text-center"
      title={label}
    >
      {label}
    </span>
    <span
      className={`text-lg sm:text-xl font-bold tabular-nums ${valueColor} truncate block w-full text-center`}
      title={value}
    >
      {value}
    </span>
  </article>
);

export const KPISummaryBar: React.FC<KPISummaryBarProps> = ({ kpis }) => {
  const kpiAnnouncement = `${kpis.wholesalersCount} grossistes, ${kpis.underThresholdCount} articles sous seuil, ${kpis.outOfStockCount} ruptures, budget estimé ${kpis.totalBudgetFormatted}`;

  return (
    <section
      className="bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-800 rounded-xl p-3 sm:p-4"
      role="region"
      aria-label="Indicateurs clés de performance"
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <KPIItem
          icon={<Truck className="w-4 h-4" />}
          label="GROSSISTES"
          value={String(kpis.wholesalersCount)}
          valueColor="text-slate-900 dark:text-white"
          iconColor="text-emerald-600 dark:text-emerald-400"
          bgColor="bg-emerald-50 dark:bg-emerald-950/40"
          ariaLabel={`Nombre de grossistes: ${kpis.wholesalersCount}`}
        />
        <KPIItem
          icon={<PackageCheck className="w-4 h-4" />}
          label="SOUS SEUIL"
          value={String(kpis.underThresholdCount)}
          valueColor="text-amber-700 dark:text-amber-400"
          iconColor="text-amber-600 dark:text-amber-400"
          bgColor="bg-amber-50 dark:bg-amber-950/40"
          ariaLabel={`Articles sous seuil de réapprovisionnement: ${kpis.underThresholdCount}`}
        />
        <KPIItem
          icon={<AlertTriangle className="w-4 h-4" />}
          label="RUPTURES"
          value={String(kpis.outOfStockCount)}
          valueColor="text-rose-700 dark:text-rose-400"
          iconColor="text-rose-600 dark:text-rose-400"
          bgColor="bg-rose-50 dark:bg-rose-950/40"
          ariaLabel={`Articles en rupture de stock: ${kpis.outOfStockCount}`}
        />
        <KPIItem
          icon={<Coins className="w-4 h-4" />}
          label="BUDGET ESTIMÉ"
          value={kpis.totalBudgetFormatted}
          valueColor="text-emerald-700 dark:text-emerald-400"
          iconColor="text-emerald-600 dark:text-emerald-400"
          bgColor="bg-emerald-50 dark:bg-emerald-950/40"
          ariaLabel={`Budget estimé pour le réapprovisionnement: ${kpis.totalBudgetFormatted}`}
        />
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {kpiAnnouncement}
      </div>
    </section>
  );
};

export default KPISummaryBar;

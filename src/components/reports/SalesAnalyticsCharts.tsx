import React, { useState, useMemo } from 'react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { TrendingUp, Activity, PieChart } from 'lucide-react';

export const SalesAnalyticsCharts: React.FC = () => {
  const { transactions } = usePosStore();
  const [hoveredHour, setHoveredHour] = useState<number | null>(null);

  // --- Derived Data Calculations ---
  const safeTransactions = useMemo(() => transactions || [], [transactions]);

  // KPI Metrics (Calculated in a single pass)
  const { avgTicket, avgItemVelocity, grossMarginPct } = useMemo(() => {
    const totalOrders = safeTransactions.length;
    let revenueSum = 0;
    let profitSum = 0;
    let itemsSum = 0;

    for (const txn of safeTransactions) {
      revenueSum += (txn.total || 0);
      profitSum += (txn.profit || 0);
      if (txn.items) {
        for (const item of txn.items) {
          itemsSum += (item.quantity || 0);
        }
      }
    }

    const avgTicketCalc = totalOrders > 0 ? revenueSum / totalOrders : 0;
    const velocityCalc = totalOrders > 0 ? (itemsSum / totalOrders).toFixed(1) : '0';
    const marginCalc = revenueSum > 0 ? ((profitSum / revenueSum) * 100).toFixed(1) : '0';

    return {
      totalRevenue: revenueSum,
      totalProfit: profitSum,
      avgTicket: avgTicketCalc,
      avgItemVelocity: velocityCalc,
      grossMarginPct: marginCalc,
    };
  }, [safeTransactions]);

  // Bar Chart: Hourly Traffic (08:00 - 20:00) in a single pass
  const hourlyData = useMemo(() => {
    const counts = new Array<number>(13).fill(0);
    for (const txn of safeTransactions) {
      const createdDate = new Date(txn.createdAt);
      if (!isNaN(createdDate.getTime())) {
        const hour = createdDate.getHours();
        if (hour >= 8 && hour <= 20) {
          counts[hour - 8]++;
        }
      }
    }
    return Array.from({ length: 13 }, (_, i) => ({
      hour: i + 8,
      volume: counts[i],
    }));
  }, [safeTransactions]);

  const maxVolume = useMemo(() => Math.max(...hourlyData.map(d => d.volume), 1), [hourlyData]);

  // Area Chart: Weekly Trend (7 Days) in a single pass
  const trendData = useMemo(() => {
    const dayBuckets = new Map<string, { day: string; revenue: number; profit: number }>();
    const orderedDays: string[] = [];

    for (let i = 0; i < 7; i++) {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - (6 - i));
      const key = targetDate.toDateString();
      const dayStr = targetDate.toLocaleDateString('fr-DZ', { weekday: 'short' });
      dayBuckets.set(key, { day: dayStr, revenue: 0, profit: 0 });
      orderedDays.push(key);
    }

    for (const txn of safeTransactions) {
      const createdDate = new Date(txn.createdAt);
      if (!isNaN(createdDate.getTime())) {
        const key = createdDate.toDateString();
        const bucket = dayBuckets.get(key);
        if (bucket) {
          bucket.revenue += (txn.total || 0);
          bucket.profit += (txn.profit || 0);
        }
      }
    }

    return orderedDays.map((key) => dayBuckets.get(key)!);
  }, [safeTransactions]);

  const maxRev = useMemo(() => Math.max(...trendData.map(d => d.revenue), 1), [trendData]);

  // Donut Chart: Categories
  const categories = [
    { name: 'Smartphones', value: 45, color: '#10b981' }, // emerald-500
    { name: 'Accessoires', value: 30, color: '#3b82f6' }, // blue-500
    { name: 'Réparations', value: 15, color: '#f59e0b' }, // amber-500
    { name: 'Services', value: 10, color: '#a855f7' }     // purple-500
  ];
  
  // SVG Donut Calculations
  let cumulativePercent = 0;
  const getCoordinatesForPercent = (percent: number) => {
    const x = Math.cos(2 * Math.PI * percent);
    const y = Math.sin(2 * Math.PI * percent);
    return [x, y];
  };

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-pos-card border border-pos-border p-4 rounded-xl flex items-center justify-between">
          <div>
            <span className="text-[10px] text-pos-muted uppercase font-bold">Panier Moyen</span>
            <p className="text-lg font-black text-emerald-400 mt-1">{formatDZD(avgTicket)}</p>
          </div>
          <div className="w-8 h-8 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
            <TrendingUp className="w-4 h-4" />
          </div>
        </div>

        <div className="bg-pos-card border border-pos-border p-4 rounded-xl flex items-center justify-between">
          <div>
            <span className="text-[10px] text-pos-muted uppercase font-bold">Vélocité Articles / Cmd</span>
            <p className="text-lg font-black text-blue-400 mt-1">{avgItemVelocity} art.</p>
          </div>
          <div className="w-8 h-8 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center">
            <Activity className="w-4 h-4" />
          </div>
        </div>

        <div className="bg-pos-card border border-pos-border p-4 rounded-xl flex items-center justify-between">
          <div>
            <span className="text-[10px] text-pos-muted uppercase font-bold">Marge Brute % Globale</span>
            <p className="text-lg font-black text-amber-400 mt-1">{grossMarginPct}%</p>
          </div>
          <div className="w-8 h-8 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center">
            <PieChart className="w-4 h-4" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Sales & Revenue Trend Area Chart */}
        <div className="bg-pos-card border border-pos-border p-4 rounded-xl">
          <h3 className="text-xs font-bold text-pos-text mb-4">Tendance Revenus & Profits (7J)</h3>
          <div className="relative h-40 w-full">
            <svg viewBox="0 0 100 100" className="w-full h-full overflow-visible preserve-3d" preserveAspectRatio="none">
              {/* Grid Lines */}
              {[0, 25, 50, 75, 100].map(y => (
                <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="currentColor" className="text-pos-border opacity-50" strokeWidth="0.5" />
              ))}
              
              {/* Trend Lines/Areas */}
              <path 
                d={`M 0,100 ${trendData.map((d, i) => `L ${(i / 6) * 100},${100 - (d.revenue / maxRev) * 100}`).join(' ')} L 100,100 Z`}
                fill="url(#revGradient)"
                opacity="0.3"
              />
              <path 
                d={`M 0,${100 - (trendData[0].revenue / maxRev) * 100} ${trendData.map((d, i) => `L ${(i / 6) * 100},${100 - (d.revenue / maxRev) * 100}`).join(' ')}`}
                fill="none"
                stroke="#10b981"
                strokeWidth="2"
              />
              
              <path 
                d={`M 0,${100 - (trendData[0].profit / maxRev) * 100} ${trendData.map((d, i) => `L ${(i / 6) * 100},${100 - (d.profit / maxRev) * 100}`).join(' ')}`}
                fill="none"
                stroke="#06b6d4"
                strokeWidth="1.5"
                strokeDasharray="2,2"
              />
              
              <defs>
                <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                </linearGradient>
              </defs>
            </svg>
            <div className="absolute inset-0 flex justify-between items-end pb-0 px-0">
               {trendData.map((d, i) => (
                 <div key={i} className="flex flex-col items-center group relative w-full h-full justify-end">
                    <div className="opacity-0 group-hover:opacity-100 absolute bottom-full mb-1 bg-pos-panel text-[10px] text-pos-text p-1.5 rounded border border-pos-border whitespace-nowrap z-10 transition-opacity">
                      Revenu: {formatDZD(d.revenue)}<br/>
                      Profit: {formatDZD(d.profit)}
                    </div>
                    <span className="text-[8px] text-pos-muted mt-2 translate-y-4">{d.day}</span>
                 </div>
               ))}
            </div>
          </div>
        </div>

        {/* Hourly Peak Traffic Bar Chart */}
        <div className="bg-pos-card border border-pos-border p-4 rounded-xl">
          <h3 className="text-xs font-bold text-pos-text mb-4">Volume Horaire (08:00 - 20:00)</h3>
          <div className="h-40 w-full flex items-end justify-between gap-1 relative">
            {hourlyData.map(d => {
              const heightPct = (d.volume / maxVolume) * 100;
              const isPeak = d.hour >= 14 && d.hour <= 18;
              return (
                <div 
                  key={d.hour} 
                  className="w-full flex flex-col items-center group relative h-full justify-end"
                  onMouseEnter={() => setHoveredHour(d.hour)}
                  onMouseLeave={() => setHoveredHour(null)}
                >
                  {hoveredHour === d.hour && (
                    <div className="absolute bottom-full mb-1 bg-pos-panel text-[10px] text-pos-text p-1 rounded border border-pos-border whitespace-nowrap z-10">
                      {d.hour}h: {d.volume} ventes
                    </div>
                  )}
                  <div 
                    className={`w-full rounded-t-sm transition-all duration-300 ${isPeak ? 'bg-amber-500' : 'bg-emerald-500/60 hover:bg-emerald-400'}`}
                    style={{ height: `${heightPct}%`, minHeight: '4px' }}
                  />
                  <span className="text-[8px] text-pos-muted mt-1">{d.hour}h</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Category Margin Donut Chart */}
        <div className="bg-pos-card border border-pos-border p-4 rounded-xl col-span-2 flex items-center justify-around">
          <div className="flex-1">
            <h3 className="text-xs font-bold text-pos-text mb-1">Marge par Catégorie</h3>
            <p className="text-[10px] text-pos-muted mb-4">Répartition des marges nettes par familles de produits</p>
            <div className="flex flex-col gap-2">
              {categories.map(c => (
                <div key={c.name} className="flex items-center gap-2 text-[10px] font-semibold text-pos-text">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c.color }} />
                  <span className="flex-1">{c.name}</span>
                  <span>{c.value}%</span>
                </div>
              ))}
            </div>
          </div>
          <div className="w-32 h-32 relative flex-shrink-0">
            <svg viewBox="-1 -1 2 2" style={{ transform: 'rotate(-90deg)' }} className="w-full h-full">
              {categories.map((slice) => {
                const [startX, startY] = getCoordinatesForPercent(cumulativePercent / 100);
                cumulativePercent += slice.value;
                const [endX, endY] = getCoordinatesForPercent(cumulativePercent / 100);
                const largeArcFlag = slice.value > 50 ? 1 : 0;
                const pathData = [
                  `M ${startX} ${startY}`, // Move
                  `A 1 1 0 ${largeArcFlag} 1 ${endX} ${endY}`, // Arc
                  'L 0 0', // Line
                ].join(' ');
                
                return (
                  <path
                    key={slice.name}
                    d={pathData}
                    fill={slice.color}
                    className="hover:opacity-80 transition-opacity stroke-pos-card stroke-[0.02]"
                  />
                );
              })}
            </svg>
            <div className="absolute inset-0 flex items-center justify-center rounded-full m-8 bg-pos-card pointer-events-none">
              <span className="text-[10px] font-bold text-pos-text">Mix</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

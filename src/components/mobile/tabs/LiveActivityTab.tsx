import React, { useMemo } from 'react';
import {
  TrendingUp,
  Receipt,
  DollarSign,
  Coins,
  Clock,
  User,
  ShieldCheck,
  RefreshCw,
  RotateCcw,
  FileSpreadsheet,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { AppTabContent } from '../AppScreenLayout';
import type { SaleTransaction } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';

interface LiveActivityTabProps {
  onSelectSale?: (sale: SaleTransaction) => void;
}

export const LiveActivityTab: React.FC<LiveActivityTabProps> = ({ onSelectSale }) => {
  const { transactions, activeShift, openModal } = usePosStore();
  const [isSyncing, setIsSyncing] = React.useState(false);

  const handleManualRefresh = async () => {
    setIsSyncing(true);
    try {
      const { syncManager } = await import('../../../sync/SyncManager');
      await syncManager.kick();
      // Targeted refresh: reload only slices the pull touched instead of all
      // 16 tables (falls back to full reload for unmapped tables internally).
      await usePosStore.getState().refreshPullTargets(syncManager.getLastPullTouched());
    } catch (err) {
      console.warn('Manual pull failed:', err);
    } finally {
      setIsSyncing(false);
    }
  };

  // Filter today's sales
  const todayDateStr = new Date().toISOString().slice(0, 10);
  const todaySales = useMemo(() => {
    return (transactions || []).filter(
      (t) => t.createdAt.slice(0, 10) === todayDateStr && t.status !== 'VOIDED' && !t.isRefund
    );
  }, [transactions, todayDateStr]);

  const todayRefunds = useMemo(() => {
    return (transactions || []).filter(
      (t) => t.createdAt.slice(0, 10) === todayDateStr && (t.isRefund || t.status === 'REFUNDED')
    );
  }, [transactions, todayDateStr]);

  // Financial calculations
  const totalRevenue = todaySales.reduce((acc, t) => acc + (t.total || 0), 0);
  const totalProfit = todaySales.reduce((acc, t) => acc + (t.profit || 0), 0);
  const refundTotal = todayRefunds.reduce((acc, t) => acc + (t.total || 0), 0);
  const netRevenue = Math.max(0, totalRevenue - refundTotal);

  // Cash in drawer estimation from active shift or transactions
  const openingFloat = activeShift?.openingFloat || 0;
  const cashSales = todaySales
    .filter((t) => t.paymentMethod === 'Espèces')
    .reduce((acc, t) => acc + Math.max(0, (t.cashTendered || t.total) - (t.changeDue || 0)), 0);
  const cashRefunds = todayRefunds
    .filter((t) => t.paymentMethod === 'Espèces')
    .reduce((acc, t) => acc + (t.total || 0), 0);
  const estimatedCashInDrawer = openingFloat + cashSales - cashRefunds;

  const averageBasket = todaySales.length > 0 ? Math.round(totalRevenue / todaySales.length) : 0;

  // Recent transactions list (last 30 sales)
  const recentFeed = useMemo(() => {
    return [...(transactions || [])]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 30);
  }, [transactions]);

  return (
    <AppTabContent
      pinnedTop={
        <div className="px-3.5 pt-3 pb-2 bg-pos-bg">
          {/* Shift Snapshot Header Banner */}
          <div className="bg-gradient-to-br from-pos-card via-pos-panel to-pos-card border border-pos-border rounded-3xl p-4 shadow-md relative overflow-hidden">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399]" />
                <span className="text-[11px] font-black uppercase tracking-wider text-emerald-400 truncate max-w-[200px]">
                  {activeShift ? `Session : ${activeShift.cashierName}` : 'Caisse Principale (En Ligne)'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleManualRefresh}
                  disabled={isSyncing}
                  className="px-2.5 py-1 rounded-xl bg-pos-panel hover:bg-pos-hover text-pos-muted hover:text-cyan-400 border border-pos-border transition cursor-pointer flex items-center gap-1.5 text-[10px] font-bold active-press shadow-xs min-h-[38px]"
                  title="Synchroniser immédiatement avec la caisse"
                  aria-label="Actualiser les données"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 ${isSyncing ? 'animate-spin' : ''}`} />
                  <span className="text-[10px] font-mono text-cyan-300">Sync</span>
                </button>
                <span className="text-[10px] font-mono font-bold text-pos-muted bg-pos-panel/80 px-2 py-1 rounded-xl border border-pos-border">
                  {todayDateStr}
                </span>
              </div>
            </div>

            {/* Big Today Revenue Hero */}
            <div className="mt-3.5">
              <span className="text-xs font-bold text-pos-muted uppercase tracking-wider block">
                Chiffre d'Affaires Net (Aujourd'hui)
              </span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-3xl sm:text-4xl font-black text-pos-text tracking-tight font-mono tabular-nums">
                  {formatDZD(netRevenue)}
                </span>
              </div>
            </div>

            {/* Key Metrics Grid */}
            <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-pos-border/60">
              <div className="bg-pos-panel/70 p-2.5 rounded-2xl border border-pos-border/50 text-center shadow-xs">
                <div className="flex items-center justify-center gap-1 text-pos-muted text-[10px] font-bold uppercase">
                  <Receipt className="w-3 h-3 text-cyan-400" />
                  <span>Tickets</span>
                </div>
                <span className="text-base font-black text-pos-text block mt-1 font-mono tabular-nums">
                  {todaySales.length}
                </span>
              </div>

              <div className="bg-pos-panel/70 p-2.5 rounded-2xl border border-pos-border/50 text-center shadow-xs">
                <div className="flex items-center justify-center gap-1 text-pos-muted text-[10px] font-bold uppercase">
                  <TrendingUp className="w-3 h-3 text-emerald-400" />
                  <span>Bénéfice</span>
                </div>
                <span className="text-base font-black text-emerald-400 block mt-1 font-mono tabular-nums">
                  {formatDZD(totalProfit)}
                </span>
              </div>

              <div className="bg-pos-panel/70 p-2.5 rounded-2xl border border-pos-border/50 text-center shadow-xs">
                <div className="flex items-center justify-center gap-1 text-pos-muted text-[10px] font-bold uppercase">
                  <Coins className="w-3 h-3 text-amber-400" />
                  <span>Panier</span>
                </div>
                <span className="text-base font-black text-pos-text block mt-1 font-mono tabular-nums">
                  {formatDZD(averageBasket)}
                </span>
              </div>
            </div>

            {/* Drawer Cash Indicator */}
            <div className="mt-3 bg-pos-panel/80 p-2.5 rounded-2xl border border-pos-border flex items-center justify-between text-xs shadow-xs">
              <span className="text-pos-muted flex items-center gap-1.5 font-bold min-w-0">
                <DollarSign className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="truncate">Espèces Estimées en Tiroir :</span>
              </span>
              <span className="font-mono font-black text-amber-400 shrink-0 text-sm tabular-nums">
                {formatDZD(estimatedCashInDrawer)}
              </span>
            </div>

            {/* Quick Operational Actions: Remboursement & Rapport Z */}
            <div className="grid grid-cols-2 gap-2 mt-3">
              <button
                type="button"
                onClick={() => openModal('refund')}
                className="min-h-[42px] px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-rose-500/40 text-rose-400 font-bold text-xs flex items-center justify-center gap-1.5 transition active-press cursor-pointer shadow-xs"
                title="Effectuer un retour d'article ou un remboursement client (F11)"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Remboursement</span>
              </button>

              <button
                type="button"
                onClick={() => openModal('shift_zreport')}
                className="min-h-[42px] px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-cyan-400/50 text-cyan-400 font-bold text-xs flex items-center justify-center gap-1.5 transition active-press cursor-pointer shadow-xs"
                title="Clôture de caisse et Rapport Z de session"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>Rapport Z</span>
              </button>
            </div>
          </div>
        </div>
      }
      contentClassName="px-3.5 pb-4"
    >
      {/* Live Sales Stream Header */}
      <div className="flex items-center justify-between py-2 sticky top-0 z-10 bg-pos-bg">
        <h3 className="text-xs font-black uppercase tracking-wider text-pos-muted flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-cyan-400" />
          Flux des Ventes en Direct ({recentFeed.length})
        </h3>
        <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-bold bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
          <ShieldCheck className="w-3 h-3" /> Sync ≤ 1.5s
        </span>
      </div>

      {/* Transaction Cards Feed */}
      <div className="space-y-2 pt-1">
        {recentFeed.length === 0 ? (
          <div className="p-8 text-center bg-pos-panel/60 border border-dashed border-pos-border rounded-2xl my-2">
            <Receipt className="w-8 h-8 text-pos-muted mx-auto mb-2 opacity-50" />
            <p className="text-xs font-bold text-pos-muted">Aucune vente enregistrée pour le moment.</p>
          </div>
        ) : (
          recentFeed.map((tx) => {
            const isRefund = tx.isRefund || tx.status === 'REFUNDED';
            const isVoided = tx.status === 'VOIDED';
            const timeStr = new Date(tx.createdAt).toLocaleTimeString('fr-FR', {
              hour: '2-digit',
              minute: '2-digit',
            });

            return (
              <div
                key={tx.id}
                onClick={() => onSelectSale?.(tx)}
                className="bg-pos-card border border-pos-border rounded-2xl p-3 flex items-center justify-between hover:border-cyan-500/40 transition active:scale-[0.99] cursor-pointer shadow-xs"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-10 h-10 rounded-2xl flex items-center justify-center font-bold text-xs shrink-0 ${
                      isVoided
                        ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                        : isRefund
                        ? 'bg-purple-500/15 text-purple-400 border border-purple-500/30'
                        : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                    }`}
                  >
                    <Receipt className="w-4 h-4" />
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-black text-pos-text truncate">
                        #{tx.receiptNumber || tx.id.slice(0, 8)}
                      </span>
                      <span
                        className={`text-[9px] font-black px-1.5 py-0.5 rounded-md uppercase shrink-0 ${
                          isVoided
                            ? 'bg-rose-500/20 text-rose-300'
                            : isRefund
                            ? 'bg-purple-500/20 text-purple-300'
                            : 'bg-pos-panel text-pos-muted border border-pos-border'
                        }`}
                      >
                        {isVoided ? 'ANNULÉ' : isRefund ? 'AVOIR' : tx.paymentMethod}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-[10px] text-pos-muted mt-0.5 truncate">
                      <span className="flex items-center gap-1 font-medium truncate">
                        <User className="w-3 h-3 shrink-0" />
                        <span className="truncate">{tx.customer?.name || 'Client Comptoir'}</span>
                      </span>
                      <span>•</span>
                      <span className="shrink-0">{tx.items?.length || 1} art.</span>
                      <span>•</span>
                      <span className="shrink-0 font-mono">{timeStr}</span>
                    </div>
                  </div>
                </div>

                <div className="text-right shrink-0 pl-2">
                  <span
                    className={`font-mono text-sm font-black block ${
                      isVoided
                        ? 'line-through text-pos-muted'
                        : isRefund
                        ? 'text-purple-400'
                        : 'text-emerald-400'
                    }`}
                  >
                    {isRefund ? `-${formatDZD(tx.total)}` : formatDZD(tx.total)}
                  </span>
                  {!isVoided && !isRefund && tx.profit > 0 && (
                    <span className="text-[10px] font-bold text-pos-muted/80 font-mono">
                      +{formatDZD(tx.profit)} net
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </AppTabContent>
  );
};

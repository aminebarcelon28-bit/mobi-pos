import React, { useEffect, useMemo, useRef, useState } from 'react';
import { todayLocalKey, toLocalDayKey, sortTransactionsNewestFirst } from '../../../utils/dateUtils';
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
  CalendarDays,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { AppTabContent } from '../AppScreenLayout';
import type { SaleTransaction } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { computeSalesMetrics, isExchangeSaleTx } from '../../../utils/receiptMath';
import { useAllocationCogs } from '../../../hooks/useAllocationCogs';

interface LiveActivityTabProps {
  onSelectSale?: (sale: SaleTransaction) => void;
}

// Seuil de déclenchement du geste tirer-pour-actualiser (px).
const PTR_THRESHOLD_PX = 72;
const PTR_MAX_PX = 96;

// Horodatage relatif en français ("il y a 3 min"). Présentation uniquement :
// la valeur absolue reste affichée à côté et en infobulle.
const relativeTimeFr = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

const formatRelativeFr = (createdAt: string | number | Date): string => {
  const then = new Date(createdAt).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.round((then - Date.now()) / 1000);
  const absSec = Math.abs(diffSec);
  if (absSec < 10) return "à l'instant";
  if (absSec < 60) return relativeTimeFr.format(diffSec, 'second');
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return relativeTimeFr.format(diffMin, 'minute');
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) return relativeTimeFr.format(diffHour, 'hour');
  const diffDay = Math.round(diffHour / 24);
  if (Math.abs(diffDay) < 7) return relativeTimeFr.format(diffDay, 'day');
  return '';
};

// Squelette du flux : mêmes dimensions que les cartes de vente (p-3, avatar
// 10x10, deux lignes de texte, montant) pour éviter tout saut de mise en page
// quand les données arrivent.
const FeedSkeletonRow: React.FC = () => (
  <div
    aria-hidden="true"
    className="bg-pos-card border border-pos-border rounded-2xl p-3 flex items-center justify-between animate-pulse"
  >
    <div className="flex items-center gap-3 min-w-0">
      <div className="w-10 h-10 rounded-2xl bg-pos-panel border border-pos-border shrink-0" />
      <div className="space-y-1.5">
        <div className="h-3 w-24 rounded-md bg-pos-panel border border-pos-border" />
        <div className="h-2.5 w-36 rounded-md bg-pos-panel border border-pos-border" />
      </div>
    </div>
    <div className="h-4 w-16 rounded-md bg-pos-panel border border-pos-border shrink-0" />
  </div>
);

// Périodes du filtre d'activité (mobile-first : libellés courts pour les
// pastilles, libellé complet pour le héros et l'état vide).
type ActivityRangeKey = 'today' | '7d' | '30d' | '90d' | 'all';

const ACTIVITY_RANGES: ReadonlyArray<{
  key: ActivityRangeKey;
  label: string;
  short: string;
  /** Nombre de jours glissants inclus (aujourd'hui compris), null = tout. */
  days: number | null;
  /** Nombre max de cartes affichées dans le flux pour cette période. */
  feedLimit: number;
}> = [
  { key: 'today', label: "Aujourd'hui", short: "Aujourd'hui", days: 1, feedLimit: 30 },
  { key: '7d', label: '7 derniers jours', short: '7J', days: 7, feedLimit: 50 },
  { key: '30d', label: '30 derniers jours', short: '30J', days: 30, feedLimit: 100 },
  { key: '90d', label: '90 derniers jours', short: '90J', days: 90, feedLimit: 100 },
  { key: 'all', label: 'Toute la période', short: 'Tout', days: null, feedLimit: 100 },
];

/**
 * Prédicat de période pur sur clés-jour YYYY-MM-DD (comparaison
 * lexicographique valide). `minDayKey == null` = toute la période.
 * Les dates invalides (clé '') sont toujours exclues.
 */
const isDayKeyInRange = (
  dayKey: string,
  minDayKey: string | null,
  todayKey: string,
  todayOnly: boolean,
): boolean => {
  if (dayKey === '') return false;
  if (minDayKey == null) return true;
  if (todayOnly) return dayKey === todayKey;
  return dayKey >= minDayKey && dayKey <= todayKey;
};

export const LiveActivityTab: React.FC<LiveActivityTabProps> = ({ onSelectSale }) => {
  const { transactions, activeShift, openModal } = usePosStore();
  const [isSyncing, setIsSyncing] = useState(false);
  const [rangeKey, setRangeKey] = useState<ActivityRangeKey>('today');
  // Premier rendu : affiche le squelette (mêmes dimensions que le flux) le
  // temps que le store hydraté par SQLite peigne les premières données.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setHydrated(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Tirer-pour-actualiser tactile (aucune dépendance) : actif uniquement quand
  // le défilement est en haut. Écouteurs nettoyés au démontage.
  const feedWrapRef = useRef<HTMLDivElement | null>(null);
  const ptrStartYRef = useRef<number | null>(null);
  const ptrDistRef = useRef(0);
  const [ptrDistance, setPtrDistance] = useState(0);
  const [ptrLiveRefreshing, setPtrLiveRefreshing] = useState(false);

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

  // Business-day "today" in shop timezone on BOTH sides of the comparison.
  // The previous UTC slice moved midnight sales to the wrong day.
  const todayDateStr = todayLocalKey();
  const activeRange = ACTIVITY_RANGES.find((r) => r.key === rangeKey) ?? ACTIVITY_RANGES[0];

  // Clé-jour minimale incluse (comparaison lexicographique YYYY-MM-DD valide).
  // "today" garde l'égalité stricte ; les plages glissantes incluent les N
  // derniers jours calendaires (fuseau boutique), aujourd'hui compris ;
  // "all" ne filtre pas. Calcul pur dérivé de todayDateStr (pas d'horloge
  // dans le mémo).
  const minDayKey = useMemo(() => {
    if (activeRange.days == null) return null;
    if (activeRange.days <= 1) return todayDateStr;
    const parts = todayDateStr.split('-').map(Number);
    const y = parts[0] ?? 0;
    const m = parts[1] ?? 0;
    const d = parts[2] ?? 0;
    if (!y || !m || !d) return todayDateStr;
    const shifted = new Date(Date.UTC(y, m - 1, d) - (activeRange.days - 1) * 86400000);
    const yy = shifted.getUTCFullYear();
    const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(shifted.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }, [activeRange.days, todayDateStr]);

  // Prédicat pur (niveau module : voir isDayKeyInRange) appliqué ici via les
  // clés mémoïsées — pas de fonction mémoïsée, le compilateur React reste
  // capable de prouver la mémoïsation des filtres ci-dessous.
  const todayOnly = rangeKey === 'today';

  const periodSales = useMemo(() => {
    return (transactions || []).filter(
      (t) =>
        isDayKeyInRange(toLocalDayKey(t.createdAt), minDayKey, todayDateStr, todayOnly) &&
        t.status !== 'VOIDED' &&
        !t.isRefund
    );
  }, [transactions, minDayKey, todayDateStr, todayOnly]);

  const periodRefunds = useMemo(() => {
    // Unified refund definition (shared with Desktop ReportsModal + Excel):
    // isRefund vouchers only — a REFUNDED status on the ORIGINAL sale must
    // NOT count, the voucher already subtracts it (double-count overstated
    // refunds and understated net).
    return (transactions || []).filter(
      (t) =>
        isDayKeyInRange(toLocalDayKey(t.createdAt), minDayKey, todayDateStr, todayOnly) &&
        Boolean(t.isRefund) &&
        t.status !== 'VOIDED'
    );
  }, [transactions, minDayKey, todayDateStr, todayOnly]);

  // Financial calculations — canonical unified metrics (same formula as
  // Desktop ReportsModal): CA Net = Σ net(valid) − Σ refunds, profit =
  // CA Net − Σ cost, basket = round(Σ net(valid) / validCount).
  // STRICT FIFO LEDGER (v104): frozen allocation COGS wins per sale.
  const { allocCogsBySaleId } = useAllocationCogs();
  const {
    totalProfit,
    netRevenue,
    estimatedCashInDrawer,
    averageBasket,
  } = useMemo(() => {
    // STRICT FIFO LEDGER (v104): frozen allocation COGS wins per sale.
    const metrics = computeSalesMetrics([...periodSales, ...periodRefunds], { allocCogsBySaleId });
    const net = metrics.netRevenue;
    const profit = metrics.profitTotal;
    const basket = metrics.averageBasket;

    const openingFloat = activeShift?.openingFloat || 0;
    // B-046: sum cash TENDERS (split payments), not paymentMethod first-tender
    // + cashTendered sum-all — mirrors ReportsModal cashSales.
    // (Espèces tiroir : pertinente pour "Aujourd'hui" uniquement ; le bloc est
    // masqué pour les autres périodes.)
    const cashSales = periodSales
      .filter((t) => t.status !== 'VOIDED' && !t.isRefund)
      .reduce((acc, t) => {
        if (t.tenders && Array.isArray(t.tenders) && t.tenders.length > 0) {
          const cashTenderTotal = t.tenders
            .filter((tender) => tender.method === 'Espèces')
            .reduce((sum, tender) => sum + (tender.amount || 0), 0);
          return acc + Math.max(0, cashTenderTotal - (t.changeDue || 0));
        }
        if (t.paymentMethod !== 'Espèces') return acc;
        return acc + Math.max(0, (t.cashTendered || t.total || 0) - (t.changeDue || 0));
      }, 0);
    const cashRefunds = periodRefunds
      .filter((t) => {
        if (t.tenders && Array.isArray(t.tenders) && t.tenders.length > 0) {
          return t.tenders.some((tender) => tender.method === 'Espèces');
        }
        return t.paymentMethod === 'Espèces';
      })
      .reduce((acc, t) => {
        if (t.tenders && Array.isArray(t.tenders) && t.tenders.length > 0) {
          return (
            acc +
            t.tenders
              .filter((tender) => tender.method === 'Espèces')
              .reduce((sum, tender) => sum + (tender.amount || 0), 0)
          );
        }
        return acc + (t.total || 0);
      }, 0);
    const drawer = openingFloat + cashSales - cashRefunds;

    return {
      totalRevenue: metrics.netSalesRevenue,
      totalProfit: profit,
      refundTotal: metrics.refundsTotal,
      netRevenue: net,
      estimatedCashInDrawer: drawer,
      averageBasket: basket,
    };
  }, [periodSales, periodRefunds, activeShift, allocCogsBySaleId]);

  // Transactions de la période, plus récentes d'abord (plafond par période
  // pour rester fluide sur mobile même à 90 jours / toute la période).
  // Tri canonique (NaN-safe) : mêmes plus-récents-d'abord sur lignes saines.
  const recentFeed = useMemo(() => {
    return sortTransactionsNewestFirst(
      (transactions || []).filter((t) =>
        isDayKeyInRange(toLocalDayKey(t.createdAt), minDayKey, todayDateStr, todayOnly)
      )
    ).slice(0, activeRange.feedLimit);
  }, [transactions, minDayKey, todayDateStr, todayOnly, activeRange.feedLimit]);

  const refreshRef = useRef(handleManualRefresh);
  useEffect(() => {
    refreshRef.current = handleManualRefresh;
  });

  useEffect(() => {
    const el = feedWrapRef.current;
    if (!el) return;
    const findScrollParent = (): HTMLElement | null => {
      let node: HTMLElement | null = el.parentElement;
      while (node) {
        if (node.classList.contains('overflow-y-auto')) return node;
        node = node.parentElement;
      }
      return null;
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        ptrStartYRef.current = null;
        return;
      }
      const sp = findScrollParent();
      // Ne capte le geste qu'en haut du défilement : sinon le scroll natif gagne.
      if (sp && sp.scrollTop > 4) {
        ptrStartYRef.current = null;
        return;
      }
      ptrStartYRef.current = e.touches[0]?.clientY ?? null;
      ptrDistRef.current = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (ptrStartYRef.current == null || ptrLiveRefreshing) return;
      const y = e.touches[0]?.clientY ?? ptrStartYRef.current;
      const dy = y - ptrStartYRef.current;
      if (dy <= 0) {
        ptrDistRef.current = 0;
        setPtrDistance(0);
        return;
      }
      ptrDistRef.current = Math.min(dy, PTR_MAX_PX);
      setPtrDistance(ptrDistRef.current);
    };
    const onTouchEnd = () => {
      if (ptrStartYRef.current == null) return;
      const pulled = ptrDistRef.current;
      ptrStartYRef.current = null;
      ptrDistRef.current = 0;
      if (pulled >= PTR_THRESHOLD_PX && !ptrLiveRefreshing) {
        setPtrLiveRefreshing(true);
        setPtrDistance(0);
        void refreshRef.current().finally(() => setPtrLiveRefreshing(false));
      } else {
        setPtrDistance(0);
      }
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [ptrLiveRefreshing]);

  const showFeedSkeleton = !hydrated || (isSyncing && recentFeed.length === 0);

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
                  aria-label="Sync — Actualiser les données"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 ${isSyncing ? 'animate-spin' : ''}`} />
                  <span className="text-[10px] font-mono text-cyan-300">Sync</span>
                </button>
                <span
                  className="text-[10px] font-mono font-bold text-pos-muted bg-pos-panel/80 px-2 py-1 rounded-xl border border-pos-border shrink-0"
                  title={rangeKey === 'today' ? todayDateStr : `${activeRange.label} • ${todayDateStr}`}
                >
                  {rangeKey === 'today' ? todayDateStr : activeRange.label}
                </span>
              </div>
            </div>

            {/* Filtre de période — pastilles tactiles 44px, défilement horizontal */}
            <div
              className="flex gap-1.5 mt-3 overflow-x-auto pb-1 -mx-1 px-1"
              role="group"
              aria-label="Filtrer l'activité par période"
            >
              <CalendarDays className="w-4 h-4 text-pos-muted self-center shrink-0 ml-1" aria-hidden="true" />
              {ACTIVITY_RANGES.map((r) => {
                const isActive = rangeKey === r.key;
                return (
                  <button
                    key={r.key}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => setRangeKey(r.key)}
                    className={`shrink-0 min-h-[44px] px-3.5 rounded-full text-[11px] font-black border transition active-press cursor-pointer ${
                      isActive
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-pos-panel border-pos-border text-pos-muted hover:text-pos-text'
                    }`}
                  >
                    {r.short}
                  </button>
                );
              })}
            </div>

            {/* Big Revenue Hero — suit la période sélectionnée */}
            <div className="mt-3 min-w-0 overflow-hidden">
              <span className="text-xs font-bold text-pos-muted uppercase tracking-wider block">
                Chiffre d'Affaires Net ({activeRange.label})
              </span>
              <div className="flex items-baseline gap-2 mt-1 min-w-0">
                <span className="text-3xl sm:text-4xl font-black text-pos-text tracking-tight font-mono tabular-nums max-w-full leading-tight break-words [overflow-wrap:anywhere] whitespace-normal">
                  {formatDZD(netRevenue)}
                </span>
              </div>
            </div>

            {/* Key Metrics Grid */}
            <div className="grid grid-cols-3 gap-1.5 sm:gap-2 mt-4 pt-3 border-t border-pos-border/60 min-w-0">
              <div className="bg-pos-panel/70 p-2 sm:p-2.5 rounded-2xl border border-pos-border/50 text-center shadow-xs min-w-0 overflow-hidden flex flex-col items-center justify-start">
                <div className="flex items-center justify-center gap-1 text-pos-muted text-[10px] font-bold uppercase max-w-full min-w-0">
                  <Receipt className="w-3 h-3 text-cyan-400 shrink-0" />
                  <span className="truncate">Tickets</span>
                </div>
                <span className="text-[13px] sm:text-base font-black text-pos-text block mt-1 font-mono tabular-nums max-w-full leading-tight break-words [overflow-wrap:anywhere] whitespace-normal">
                  {periodSales.length}
                </span>
              </div>

              <div className="bg-pos-panel/70 p-2 sm:p-2.5 rounded-2xl border border-pos-border/50 text-center shadow-xs min-w-0 overflow-hidden flex flex-col items-center justify-start">
                <div className="flex items-center justify-center gap-1 text-pos-muted text-[10px] font-bold uppercase max-w-full min-w-0">
                  <TrendingUp className="w-3 h-3 text-emerald-400 shrink-0" />
                  <span className="truncate">Bénéfice</span>
                </div>
                <span
                  title={formatDZD(totalProfit)}
                  className="text-[13px] sm:text-base font-black text-emerald-400 block mt-1 font-mono tabular-nums max-w-full leading-tight break-words [overflow-wrap:anywhere] whitespace-normal"
                >
                  {formatDZD(totalProfit)}
                </span>
              </div>

              <div className="bg-pos-panel/70 p-2 sm:p-2.5 rounded-2xl border border-pos-border/50 text-center shadow-xs min-w-0 overflow-hidden flex flex-col items-center justify-start">
                <div className="flex items-center justify-center gap-1 text-pos-muted text-[10px] font-bold uppercase max-w-full min-w-0">
                  <Coins className="w-3 h-3 text-amber-400 shrink-0" />
                  <span className="truncate">Panier</span>
                </div>
                <span
                  title={formatDZD(averageBasket)}
                  className="text-[13px] sm:text-base font-black text-pos-text block mt-1 font-mono tabular-nums max-w-full leading-tight break-words [overflow-wrap:anywhere] whitespace-normal"
                >
                  {formatDZD(averageBasket)}
                </span>
              </div>
            </div>

            {/* Drawer Cash Indicator — instantané du tiroir : "Aujourd'hui" uniquement */}
            {rangeKey === 'today' && (
            <div className="mt-3 bg-pos-panel/80 p-2.5 rounded-2xl border border-pos-border flex items-center justify-between gap-2 text-xs shadow-xs min-w-0 overflow-hidden">
              <span className="text-pos-muted flex items-center gap-1.5 font-bold min-w-0 flex-1">
                <DollarSign className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="truncate">Espèces Estimées en Tiroir :</span>
              </span>
              <span
                title={formatDZD(estimatedCashInDrawer)}
                className="font-mono font-black text-amber-400 text-sm tabular-nums min-w-0 max-w-[55%] text-right leading-tight break-words [overflow-wrap:anywhere] whitespace-normal shrink-0"
              >
                {formatDZD(estimatedCashInDrawer)}
              </span>
            </div>
            )}

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
      {/* Sales Stream Header — suit la période sélectionnée */}
      <div className="flex items-center justify-between py-2 sticky top-0 z-10 bg-pos-bg">
        <h3 className="text-xs font-black uppercase tracking-wider text-pos-muted flex items-center gap-1.5 min-w-0">
          <Clock className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="truncate">
            {rangeKey === 'today' ? `Flux des Ventes en Direct (${recentFeed.length})` : `Ventes • ${activeRange.label} (${recentFeed.length})`}
          </span>
        </h3>
        <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-bold bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
          <ShieldCheck className="w-3 h-3" /> Sync ≤ 1.5s
        </span>
      </div>

      {/* Transaction Cards Feed — le geste tirer-pour-actualiser est capté ici */}
      <div ref={feedWrapRef} className="space-y-2 pt-1">
        {/* Indicateur tirer-pour-actualiser : hauteur 0 au repos, aucun saut */}
        <div
          aria-live="polite"
          className="overflow-hidden transition-all duration-150"
          style={{ height: ptrLiveRefreshing ? 44 : ptrDistance }}
        >
          <div className="h-11 flex items-center justify-center gap-2 text-[11px] font-bold text-cyan-400">
            <RefreshCw
              className={`w-4 h-4 ${ptrLiveRefreshing || ptrDistance > 0 ? 'animate-spin' : ''}`}
            />
            <span>
              {ptrLiveRefreshing || isSyncing
                ? 'Actualisation…'
                : ptrDistance >= PTR_THRESHOLD_PX
                  ? 'Relâchez pour actualiser'
                  : 'Tirez pour actualiser'}
            </span>
          </div>
        </div>

        {showFeedSkeleton ? (
          <div role="status" aria-label="Chargement de l'activité…" className="space-y-2">
            <FeedSkeletonRow />
            <FeedSkeletonRow />
            <FeedSkeletonRow />
          </div>
        ) : recentFeed.length === 0 ? (
          <div className="p-6 text-center bg-pos-panel/60 border border-dashed border-pos-border rounded-2xl my-2 flex flex-col items-center gap-3">
            <Receipt className="w-8 h-8 text-pos-muted opacity-50" />
            <p className="text-xs font-bold text-pos-muted">
              {rangeKey === 'today'
                ? "Aucune vente aujourd'hui — la première vente apparaîtra ici."
                : `Aucune vente sur ${activeRange.label.toLowerCase()} — essayez une autre période.`}
            </p>
            <button
              type="button"
              onClick={() => void handleManualRefresh()}
              disabled={isSyncing}
              className="min-h-[44px] px-4 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400 font-bold text-xs flex items-center gap-1.5 active-press transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Actualisation…' : 'Actualiser'}</span>
            </button>
          </div>
        ) : (
          recentFeed.map((tx) => {
            const isRefund = tx.isRefund || tx.status === 'REFUNDED';
            const isVoided = tx.status === 'VOIDED';
            const timeStr = new Date(tx.createdAt).toLocaleTimeString('fr-FR', {
              hour: '2-digit',
              minute: '2-digit',
            });
            const fullStr = new Date(tx.createdAt).toLocaleString('fr-FR', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            });
            const relativeFr = formatRelativeFr(tx.createdAt);

            return (
              <div
                key={tx.id}
                onClick={() => onSelectSale?.(tx)}
                className={`bg-pos-card border border-pos-border border-l-4 rounded-2xl p-3 flex items-center justify-between hover:border-cyan-500/40 transition active-press cursor-pointer shadow-xs ${
                  isVoided
                    ? 'border-l-rose-500/70'
                    : isRefund
                      ? 'border-l-purple-500/70'
                      : 'border-l-emerald-500/70'
                }`}
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
                      <span className="shrink-0 font-mono" title={fullStr}>
                        {relativeFr ? `${relativeFr} • ${timeStr}` : timeStr}
                      </span>
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
                  {!isVoided && !isRefund && (() => {
                    // Same unified basis as the hero KPIs above (alloc →
                    // materialized row → stored) so the badge can never
                    // contradict them; exchanges use signed row cost.
                    // Legacy rows without any frozen basis keep stored profit.
                    let basis: number | undefined;
                    if (isExchangeSaleTx(tx)) {
                      const row = Number(tx.costTotal);
                      if (Number.isFinite(row)) basis = Math.round(row);
                    }
                    if (basis === undefined) {
                      const raw = allocCogsBySaleId[tx.id];
                      const alloc = Number(raw);
                      if (Number.isFinite(alloc) && alloc >= 0) basis = Math.round(alloc);
                    }
                    if (basis === undefined) {
                      const ledger = Number(tx.ledgerCogsTotal);
                      if (Number.isFinite(ledger) && ledger >= 0) basis = Math.round(ledger);
                    }
                    const badge = basis !== undefined ? Number(tx.total ?? 0) - basis : tx.profit;
                    return badge > 0 ? (
                      <span className="text-[10px] font-bold text-pos-muted/80 font-mono">
                        +{formatDZD(badge)} net
                      </span>
                    ) : null;
                  })()}
                </div>
              </div>
            );
          })
        )}
      </div>
    </AppTabContent>
  );
};

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { todayLocalKey, toLocalDayKey } from '../../../utils/dateUtils';
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
  CreditCard,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { AppTabContent } from '../AppScreenLayout';
import type { SaleTransaction } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { computeSalesMetrics, isExchangeSaleTx } from '../../../utils/receiptMath';
import { useAllocationCogs } from '../../../hooks/useAllocationCogs';
import { soundEngine } from '../../../utils/audioFeedback';
import { useTranslation, Bdi, type Translator } from '../../../i18n';

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

// Configuration tonale des badges et icônes par mode de paiement et statut
interface TransactionPresentation {
  label: string;
  badgeClass: string;
  borderStartClass: string;
  iconBgClass: string;
  iconColorClass: string;
  Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
}

const getTransactionPresentation = (
  tx: SaleTransaction,
  t: Translator,
): TransactionPresentation => {
  const isVoided = tx.status === 'VOIDED';
  if (isVoided) {
    return {
      label: t.liveActivity.badgeVoided || 'ANNULÉ',
      badgeClass: 'pos-status-danger border',
      borderStartClass: 'border-s-rose-500/80',
      iconBgClass: 'bg-rose-500/15 border-rose-500/30',
      iconColorClass: 'text-rose-700 dark:text-rose-400',
      Icon: RotateCcw,
    };
  }

  const isRefund = Boolean(tx.isRefund || tx.status === 'REFUNDED');
  if (isRefund) {
    return {
      label: t.liveActivity.badgeRefunded || 'AVOIR',
      badgeClass: 'bg-purple-500/15 text-purple-800 dark:text-purple-300 border border-purple-500/30',
      borderStartClass: 'border-s-purple-500/80',
      iconBgClass: 'bg-purple-500/15 border-purple-500/30',
      iconColorClass: 'text-purple-700 dark:text-purple-400',
      Icon: RotateCcw,
    };
  }

  // Règlement mixte / multi-lignes
  if (tx.tenders && Array.isArray(tx.tenders) && tx.tenders.length > 1) {
    return {
      label: t.liveActivity.badgeSplit || 'SPLIT',
      badgeClass: 'bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 border border-indigo-500/30',
      borderStartClass: 'border-s-indigo-500/80',
      iconBgClass: 'bg-indigo-500/15 border-indigo-500/30',
      iconColorClass: 'text-indigo-700 dark:text-indigo-400',
      Icon: Receipt,
    };
  }

  const method = tx.paymentMethod || 'Espèces';
  if (method === 'Crédit Client') {
    return {
      label: t.liveActivity.badgeCredit || 'CRÉDIT',
      badgeClass: 'pos-status-warn border',
      borderStartClass: 'border-s-amber-500/80',
      iconBgClass: 'bg-amber-500/15 border-amber-500/30',
      iconColorClass: 'text-amber-700 dark:text-amber-400',
      Icon: Coins,
    };
  }

  if (method === 'BaridiMob') {
    return {
      label: 'BARIDIMOB',
      badgeClass: 'bg-sky-500/15 text-sky-800 dark:text-sky-300 border border-sky-500/30',
      borderStartClass: 'border-s-sky-500/80',
      iconBgClass: 'bg-sky-500/15 border-sky-500/30',
      iconColorClass: 'text-sky-700 dark:text-sky-400',
      Icon: CreditCard,
    };
  }

  if (method === 'Chèque') {
    return {
      label: 'CHÈQUE',
      badgeClass: 'bg-blue-500/15 text-blue-800 dark:text-blue-300 border border-blue-500/30',
      borderStartClass: 'border-s-blue-500/80',
      iconBgClass: 'bg-blue-500/15 border-blue-500/30',
      iconColorClass: 'text-blue-700 dark:text-blue-400',
      Icon: CreditCard,
    };
  }

  if (method === 'Reprise') {
    return {
      label: t.liveActivity.badgeTradeIn || 'REPRISE',
      badgeClass: 'bg-teal-500/15 text-teal-800 dark:text-teal-300 border border-teal-500/30',
      borderStartClass: 'border-s-teal-500/80',
      iconBgClass: 'bg-teal-500/15 border-teal-500/30',
      iconColorClass: 'text-teal-700 dark:text-teal-400',
      Icon: Coins,
    };
  }

  if (method === 'Autre') {
    return {
      label: 'TPE / CARTE',
      badgeClass: 'pos-status-info border',
      borderStartClass: 'border-s-cyan-500/80',
      iconBgClass: 'bg-cyan-500/15 border-cyan-500/30',
      iconColorClass: 'text-cyan-700 dark:text-cyan-400',
      Icon: CreditCard,
    };
  }

  // Règlement espèces standard
  return {
    label: t.liveActivity.badgeCash || 'ESPÈCES',
    badgeClass: 'pos-status-ok border',
    borderStartClass: 'border-s-emerald-500/80',
    iconBgClass: 'bg-emerald-500/15 border-emerald-500/30',
    iconColorClass: 'text-emerald-700 dark:text-emerald-400',
    Icon: Receipt,
  };
};

// Squelette du flux : mêmes dimensions que les cartes de vente (p-3 sm:p-3.5,
// border-s-4, avatar 10x10, deux lignes de texte, montant) pour éviter tout
// saut de mise en page quand les données arrivent.
const FeedSkeletonRow: React.FC = () => (
  <div
    aria-hidden="true"
    className="bg-pos-card border border-pos-border border-s-4 border-s-pos-border rounded-2xl p-3 sm:p-3.5 flex items-center justify-between animate-pulse shadow-xs"
  >
    <div className="flex items-center gap-3 min-w-0">
      <div className="w-10 h-10 rounded-2xl bg-pos-panel border border-pos-border shrink-0" />
      <div className="space-y-1.5">
        <div className="h-3 w-24 rounded-md bg-pos-panel border border-pos-border" />
        <div className="h-2.5 w-36 rounded-md bg-pos-panel border border-pos-border" />
      </div>
    </div>
    <div className="flex items-center gap-2">
      <div className="h-4 w-16 rounded-md bg-pos-panel border border-pos-border shrink-0" />
      <div className="w-4 h-4 rounded bg-pos-panel shrink-0" />
    </div>
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
  const { t } = useTranslation();
  const [isSyncing, setIsSyncing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [rangeKey, setRangeKey] = useState<ActivityRangeKey>('today');
  // Premier rendu : affiche le squelette (mêmes dimensions que le flux) le
  // temps que le store hydraté par SQLite peigne les premières données.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setHydrated(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Tirer-pour-actualiser tactile avec courbe élastique & haptique
  const feedWrapRef = useRef<HTMLDivElement | null>(null);
  const ptrStartYRef = useRef<number | null>(null);
  const ptrDistRef = useRef(0);
  const [ptrDistance, setPtrDistance] = useState(0);
  const [ptrLiveRefreshing, setPtrLiveRefreshing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const handleManualRefresh = async () => {
    setIsSyncing(true);
    setFetchError(null);
    try {
      const { syncManager } = await import('../../../sync/SyncManager');
      await syncManager.kick();
      // Targeted refresh: reload only slices the pull touched instead of all
      // 16 tables (falls back to full reload for unmapped tables internally).
      await usePosStore.getState().refreshPullTargets(syncManager.getLastPullTouched());
    } catch (err) {
      console.warn('Manual pull failed:', err);
      setFetchError(t.liveActivity.syncFailedBanner);
    } finally {
      setIsSyncing(false);
    }
  };

  // Business-day "today" in shop timezone on BOTH sides of the comparison.
  // The previous UTC slice moved midnight sales to the wrong day.
  const todayDateStr = todayLocalKey();
  const localizedRanges = useMemo(
    () => [
      { key: 'today' as const, label: t.liveActivity.rangeToday, short: t.liveActivity.rangeToday, days: 1, feedLimit: 30 },
      { key: '7d' as const, label: t.liveActivity.range7d, short: t.liveActivity.range7dShort, days: 7, feedLimit: 50 },
      { key: '30d' as const, label: t.liveActivity.range30d, short: t.liveActivity.range30dShort, days: 30, feedLimit: 100 },
      { key: '90d' as const, label: t.liveActivity.range90d, short: t.liveActivity.range90dShort, days: 90, feedLimit: 100 },
      { key: 'all' as const, label: t.liveActivity.rangeAll, short: t.liveActivity.rangeAllShort, days: null, feedLimit: 100 },
    ],
    [t]
  );
  const activeRange = localizedRanges.find((r) => r.key === rangeKey) ?? localizedRanges[0] ?? ACTIVITY_RANGES[0];

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

  // UPGRADE-01: the feed and its period totals must cover the COMPLETE selected
  // range (SQLite by created_at index), not the bounded 200-row store window.
  // Refetches when the window changes so a new sale lands in the live feed.
  const [rangeTxns, setRangeTxns] = useState<SaleTransaction[] | null>(null);
  useEffect(() => {
    let alive = true;
    const fromISO = (() => {
      if (!minDayKey) return null;
      const parts = minDayKey.split('-').map(Number);
      const y = parts[0] ?? 0;
      const m = parts[1] ?? 0;
      const d = parts[2] ?? 0;
      if (!y || !m || !d) return null;
      // Local midnight of the first day in range, minus a 12 h grace for
      // wall-clock/ISO skew (the day-key filter trims the surplus).
      return new Date(new Date(y, m - 1, d).getTime() - 12 * 3600 * 1000).toISOString();
    })();
    (async () => {
      try {
        const { sqliteAdapter } = await import('../../../db/sqliteAdapter');
        const list = await sqliteAdapter.getTransactionsByDateRange({ from: fromISO });
        if (alive) setRangeTxns(list);
      } catch (e) {
        console.warn('[live-activity] range read failed, using window:', e);
      }
    })();
    return () => {
      alive = false;
    };
    // transactions: refresh the range right after a sale / sync pull lands.
  }, [minDayKey, transactions]);

  // Prédicat pur (niveau module : voir isDayKeyInRange) appliqué ici via les
  // clés mémoïsées — pas de fonction mémoïsée, le compilateur React reste
  // capable de prouver la mémoïsation des filtres ci-dessous.
  const todayOnly = rangeKey === 'today';

  const periodSales = useMemo(() => {
    return (rangeTxns ?? transactions ?? []).filter(
      (t) =>
        isDayKeyInRange(toLocalDayKey(t.createdAt), minDayKey, todayDateStr, todayOnly) &&
        t.status !== 'VOIDED' &&
        !t.isRefund
    );
  }, [rangeTxns, transactions, minDayKey, todayDateStr, todayOnly]);

  const periodRefunds = useMemo(() => {
    // Unified refund definition (shared with Desktop ReportsModal + Excel):
    // isRefund vouchers only — a REFUNDED status on the ORIGINAL sale must
    // NOT count, the voucher already subtracts it (double-count overstated
    // refunds and understated net).
    return (rangeTxns ?? transactions ?? []).filter(
      (t) =>
        isDayKeyInRange(toLocalDayKey(t.createdAt), minDayKey, todayDateStr, todayOnly) &&
        Boolean(t.isRefund) &&
        t.status !== 'VOIDED'
    );
  }, [rangeTxns, transactions, minDayKey, todayDateStr, todayOnly]);

  // Financial calculations — canonical unified metrics (same formula as
  // Desktop ReportsModal): CA Net = Σ net(valid) − Σ refunds, profit =
  // CA Net − Σ cost, basket = round(Σ net(valid) / validCount).
  // STRICT FIFO LEDGER (v104): frozen allocation COGS wins per sale.
  const { allocCogsBySaleId } = useAllocationCogs();
  const {
    totalProfit,
    netRevenue,
    refundTotal,
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
  const recentFeed = useMemo(() => {
    return (rangeTxns ?? transactions ?? [])
      .filter((t) => isDayKeyInRange(toLocalDayKey(t.createdAt), minDayKey, todayDateStr, todayOnly))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, activeRange.feedLimit);
  }, [rangeTxns, transactions, minDayKey, todayDateStr, todayOnly, activeRange.feedLimit]);

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
    let thresholdCrossed = false;
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
      thresholdCrossed = false;
      ptrStartYRef.current = e.touches[0]?.clientY ?? null;
      ptrDistRef.current = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (ptrStartYRef.current == null || ptrLiveRefreshing) return;
      const y = e.touches[0]?.clientY ?? ptrStartYRef.current;
      const dy = y - ptrStartYRef.current;
      if (dy <= 0) {
        if (ptrDistRef.current !== 0) {
          ptrDistRef.current = 0;
          setPtrDistance(0);
          setIsDragging(false);
        }
        return;
      }

      // Amortissement élastique progressif (sensations natives iOS / Android) :
      // Réponse linéaire sensible (ratio 0.5x) jusqu'au seuil, puis amortissement
      // asymptotique sans à-coup jusqu'au plafond maximal.
      let currentDist: number;
      if (dy * 0.5 <= PTR_THRESHOLD_PX) {
        currentDist = Math.round(dy * 0.5);
      } else {
        const excess = dy - PTR_THRESHOLD_PX / 0.5;
        currentDist = Math.round(
          PTR_THRESHOLD_PX + (PTR_MAX_PX - PTR_THRESHOLD_PX) * (1 - Math.exp(-excess / 70))
        );
      }

      if (currentDist >= PTR_THRESHOLD_PX && !thresholdCrossed) {
        soundEngine.triggerHaptic('medium');
        thresholdCrossed = true;
      } else if (currentDist < PTR_THRESHOLD_PX && thresholdCrossed) {
        soundEngine.triggerHaptic('light');
        thresholdCrossed = false;
      }

      setIsDragging(true);
      ptrDistRef.current = currentDist;
      setPtrDistance(currentDist);
    };
    const onTouchEnd = () => {
      if (ptrStartYRef.current == null) return;
      const pulled = ptrDistRef.current;
      ptrStartYRef.current = null;
      ptrDistRef.current = 0;
      setIsDragging(false);

      if (pulled >= PTR_THRESHOLD_PX && !ptrLiveRefreshing) {
        soundEngine.triggerHaptic('medium');
        setPtrLiveRefreshing(true);
        setPtrDistance(0);
        void refreshRef
          .current()
          .then(() => {
            soundEngine.triggerHaptic('success');
          })
          .catch(() => {
            soundEngine.triggerHaptic('warning');
          })
          .finally(() => setPtrLiveRefreshing(false));
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
  const pullProgress = Math.min(ptrDistance / PTR_THRESHOLD_PX, 1);
  const isThresholdMet = ptrDistance >= PTR_THRESHOLD_PX;

  return (
    <AppTabContent
      pinnedTop={
        <div className="px-3.5 pt-3 pb-2 bg-pos-bg">
          {/* Shift Snapshot Header Banner */}
          <div className="bg-gradient-to-br from-pos-card via-pos-panel to-pos-card border border-pos-border/90 rounded-3xl p-4 shadow-md relative overflow-hidden">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2.5 h-2.5 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399] shrink-0"
                  aria-hidden="true"
                />
                <span className="text-[11px] font-black uppercase tracking-wider text-emerald-700 dark:text-emerald-400 truncate max-w-[200px]">
                  {activeShift ? t('liveActivity.activeSessionPrefix', { name: activeShift.cashierName }) : t.liveActivity.mainRegisterOnline}
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleManualRefresh}
                  disabled={isSyncing}
                  className="px-3 py-1.5 rounded-xl bg-pos-panel hover:bg-pos-hover text-pos-muted hover:text-cyan-700 dark:hover:text-cyan-400 border border-pos-border transition cursor-pointer flex items-center gap-1.5 text-[10px] font-bold active-press shadow-xs min-h-[48px] min-w-[48px]"
                  title={t.liveActivity.syncButtonTitle}
                  aria-label={t.liveActivity.syncButtonAria}
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-cyan-700 dark:text-cyan-400 ${isSyncing ? 'animate-spin' : ''}`} aria-hidden="true" />
                  <span className="text-[10px] font-mono font-bold text-cyan-800 dark:text-cyan-300">{t.liveActivity.syncButton}</span>
                </button>
                <span
                  className="text-[10px] font-mono font-bold text-pos-muted bg-pos-panel/80 px-2.5 py-1.5 rounded-xl border border-pos-border shrink-0 min-h-[48px] flex items-center justify-center tabular-nums"
                  title={rangeKey === 'today' ? todayDateStr : `${activeRange.label} • ${todayDateStr}`}
                >
                  <Bdi mono>{rangeKey === 'today' ? todayDateStr : activeRange.label}</Bdi>
                </span>
              </div>
            </div>

            {/* Filtre de période — pastilles tactiles 48px, défilement horizontal */}
            <div
              className="flex gap-1.5 mt-3 overflow-x-auto pb-1 -mx-1 px-1"
              role="group"
              aria-label={t.liveActivity.filterByPeriodAria}
            >
              <CalendarDays className="w-4 h-4 text-pos-muted self-center shrink-0 ms-1 me-0.5" aria-hidden="true" />
              {localizedRanges.map((r) => {
                const isActive = rangeKey === r.key;
                return (
                  <button
                    key={r.key}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => {
                      soundEngine.playKeyBeep?.();
                      setRangeKey(r.key);
                    }}
                    className={`shrink-0 min-h-[48px] px-3.5 rounded-full text-[11px] font-black border transition active-press cursor-pointer ${
                      isActive
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-800 dark:text-emerald-300 shadow-xs'
                        : 'bg-pos-panel border-pos-border text-pos-muted hover:text-pos-text'
                    }`}
                  >
                    {r.short}
                  </button>
                );
              })}
            </div>

            {/* Big Revenue Hero — suit la période sélectionnée */}
            <div className="mt-3.5 min-w-0 overflow-hidden">
              <span className="text-xs font-bold text-pos-muted uppercase tracking-wider block">
                {t('liveActivity.netRevenueTitle', { period: activeRange.label })}
              </span>
              <div className="flex items-baseline gap-2 mt-1 min-w-0 flex-wrap">
                <Bdi mono className="text-3xl sm:text-4xl font-black text-pos-text tracking-tight leading-tight break-words [overflow-wrap:anywhere] whitespace-normal">
                  {formatDZD(netRevenue)}
                </Bdi>
                {refundTotal > 0 && (
                  <span
                    className="text-[11px] font-bold text-purple-800 dark:text-purple-300 bg-purple-500/15 border border-purple-500/30 px-2.5 py-0.5 rounded-full inline-flex items-center gap-1 font-mono tabular-nums shrink-0"
                    title={`Avoirs déduits : ${formatDZD(refundTotal)} (${periodRefunds.length} retour${periodRefunds.length > 1 ? 's' : ''})`}
                  >
                    <RotateCcw className="w-3 h-3" aria-hidden="true" />
                    <Bdi mono>-{formatDZD(refundTotal)} ({periodRefunds.length} avoir{periodRefunds.length > 1 ? 's' : ''})</Bdi>
                  </span>
                )}
              </div>
            </div>

            {/* Key Metrics Grid — cartes contrastées avec chiffres tabulaires */}
            <div className="grid grid-cols-3 gap-1.5 sm:gap-2 mt-4 pt-3 border-t border-pos-border/60 min-w-0">
              <div className="bg-pos-panel/85 p-2 sm:p-2.5 rounded-2xl border border-pos-border/70 hover:border-cyan-500/30 transition-colors text-center shadow-xs min-w-0 overflow-hidden flex flex-col items-center justify-between min-h-[66px]">
                <div className="flex items-center justify-center gap-1 text-pos-muted text-[10px] font-bold uppercase max-w-full min-w-0">
                  <div className="w-4 h-4 rounded bg-cyan-500/10 flex items-center justify-center shrink-0">
                    <Receipt className="w-3 h-3 text-cyan-700 dark:text-cyan-400 shrink-0" aria-hidden="true" />
                  </div>
                  <span className="truncate">{t.liveActivity.ticketsMetric}</span>
                </div>
                <Bdi mono className="text-sm sm:text-base font-black text-pos-text block mt-1 max-w-full leading-tight break-words [overflow-wrap:anywhere] whitespace-normal">
                  {periodSales.length}
                </Bdi>
              </div>

              <div className="bg-pos-panel/85 p-2 sm:p-2.5 rounded-2xl border border-pos-border/70 hover:border-emerald-500/30 transition-colors text-center shadow-xs min-w-0 overflow-hidden flex flex-col items-center justify-between min-h-[66px]">
                <div className="flex items-center justify-center gap-1 text-pos-muted text-[10px] font-bold uppercase max-w-full min-w-0">
                  <div className="w-4 h-4 rounded bg-emerald-500/10 flex items-center justify-center shrink-0">
                    <TrendingUp className="w-3 h-3 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                  </div>
                  <span className="truncate">{t.liveActivity.profitMetric}</span>
                </div>
                <Bdi
                  mono
                  title={formatDZD(totalProfit)}
                  className="text-sm sm:text-base font-black text-emerald-700 dark:text-emerald-400 block mt-1 max-w-full leading-tight break-words [overflow-wrap:anywhere] whitespace-normal"
                >
                  {formatDZD(totalProfit)}
                </Bdi>
              </div>

              <div className="bg-pos-panel/85 p-2 sm:p-2.5 rounded-2xl border border-pos-border/70 hover:border-amber-500/30 transition-colors text-center shadow-xs min-w-0 overflow-hidden flex flex-col items-center justify-between min-h-[66px]">
                <div className="flex items-center justify-center gap-1 text-pos-muted text-[10px] font-bold uppercase max-w-full min-w-0">
                  <div className="w-4 h-4 rounded bg-amber-500/10 flex items-center justify-center shrink-0">
                    <Coins className="w-3 h-3 text-amber-700 dark:text-amber-400 shrink-0" aria-hidden="true" />
                  </div>
                  <span className="truncate">{t.liveActivity.basketMetric}</span>
                </div>
                <Bdi
                  mono
                  title={formatDZD(averageBasket)}
                  className="text-sm sm:text-base font-black text-amber-800 dark:text-amber-300 block mt-1 max-w-full leading-tight break-words [overflow-wrap:anywhere] whitespace-normal"
                >
                  {formatDZD(averageBasket)}
                </Bdi>
              </div>
            </div>

            {/* Drawer Cash Indicator — instantané du tiroir : "Aujourd'hui" uniquement */}
            {rangeKey === 'today' && (
              <div className="mt-3 bg-pos-panel/90 p-2.5 sm:p-3 rounded-2xl border border-pos-border flex items-center justify-between gap-2 shadow-xs min-w-0 overflow-hidden">
                <span className="text-pos-muted flex items-center gap-2 font-bold min-w-0 flex-1 text-xs">
                  <div className="w-6 h-6 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                    <DollarSign className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400 shrink-0" aria-hidden="true" />
                  </div>
                  <span className="truncate">{t.liveActivity.estimatedDrawerCash}</span>
                </span>
                <Bdi
                  mono
                  title={formatDZD(estimatedCashInDrawer)}
                  className="font-black text-amber-700 dark:text-amber-400 text-sm sm:text-base min-w-0 max-w-[55%] text-end leading-tight break-words [overflow-wrap:anywhere] whitespace-normal shrink-0"
                >
                  {formatDZD(estimatedCashInDrawer)}
                </Bdi>
              </div>
            )}

            {/* Quick Operational Actions: Remboursement & Rapport Z */}
            <div className="grid grid-cols-2 gap-2 mt-3">
              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  openModal('refund');
                }}
                className="min-h-[48px] px-3.5 rounded-xl bg-pos-panel border border-pos-border hover:border-rose-500/40 hover:bg-rose-500/5 text-rose-700 dark:text-rose-400 font-bold text-xs flex items-center justify-center gap-2 transition active-press cursor-pointer shadow-xs"
                title={t.liveActivity.refundButtonTitle}
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t.liveActivity.refundButton}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  openModal('shift_zreport');
                }}
                className="min-h-[48px] px-3.5 rounded-xl bg-pos-panel border border-pos-border hover:border-cyan-400/50 hover:bg-cyan-500/5 text-cyan-700 dark:text-cyan-400 font-bold text-xs flex items-center justify-center gap-2 transition active-press cursor-pointer shadow-xs"
                title={t.liveActivity.zReportButtonTitle}
              >
                <FileSpreadsheet className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t.liveActivity.zReportButton}</span>
              </button>
            </div>
          </div>
        </div>
      }
      contentClassName="px-3.5 pb-4"
    >
      {/* Explicit Error Banner with >=48px Retry Button */}
      {fetchError && (
        <div
          role="alert"
          className="mb-2.5 p-3 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 text-rose-700 dark:text-rose-400 shrink-0" aria-hidden="true" />
            <p className="text-xs font-bold text-rose-800 dark:text-rose-300 leading-snug">
              {fetchError}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleManualRefresh()}
            disabled={isSyncing}
            className="min-h-[48px] px-3.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-800 dark:text-rose-200 font-bold text-xs shrink-0 active-press transition cursor-pointer"
          >
            {t.common.retry}
          </button>
        </div>
      )}

      {/* Sales Stream Header — suit la période sélectionnée */}
      <div className="flex items-center justify-between py-2 sticky top-0 z-10 bg-pos-bg">
        <h3 className="text-xs font-black uppercase tracking-wider text-pos-muted flex items-center gap-1.5 min-w-0">
          <Clock className="w-3.5 h-3.5 text-cyan-700 dark:text-cyan-400 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {rangeKey === 'today' ? t('liveActivity.liveSalesFeedTitle', { count: recentFeed.length }) : t('liveActivity.periodSalesFeedTitle', { period: activeRange.label, count: recentFeed.length })}
          </span>
        </h3>
        <span className="text-[10px] text-emerald-800 dark:text-emerald-300 flex items-center gap-1 font-bold bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 tabular-nums">
          <ShieldCheck className="w-3 h-3" aria-hidden="true" /> <Bdi mono>{t.liveActivity.syncLatencyBadge}</Bdi>
        </span>
      </div>

      {/* Transaction Cards Feed — le geste tirer-pour-actualiser est capté ici */}
      <div ref={feedWrapRef} className="space-y-2 pt-1">
        {/* Indicateur tirer-pour-actualiser élastique : sans lag de drag & animation fluide au relâchement */}
        <div
          aria-live="polite"
          className="overflow-hidden"
          style={{
            height: ptrLiveRefreshing ? 44 : ptrDistance,
            transition: isDragging ? 'none' : 'height 240ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div className="h-11 flex items-center justify-center gap-2 text-[11px] font-bold">
            <RefreshCw
              className={`w-4 h-4 text-cyan-700 dark:text-cyan-400 ${ptrLiveRefreshing || isSyncing ? 'animate-spin' : ''}`}
              style={
                !ptrLiveRefreshing && !isSyncing
                  ? {
                      transform: `rotate(${pullProgress * 180}deg) scale(${0.8 + pullProgress * 0.25})`,
                      opacity: 0.5 + pullProgress * 0.5,
                      transition: isDragging ? 'none' : 'transform 200ms ease-out',
                    }
                  : undefined
              }
              aria-hidden="true"
            />
            <span
              className={
                isThresholdMet || ptrLiveRefreshing || isSyncing
                  ? 'text-cyan-800 dark:text-cyan-300 font-extrabold'
                  : 'text-pos-muted'
              }
            >
              {ptrLiveRefreshing || isSyncing
                ? t.liveActivity.ptrRefreshing
                : isThresholdMet
                  ? t.liveActivity.ptrReleaseToRefresh
                  : t.liveActivity.ptrPullToRefresh}
            </span>
          </div>
        </div>

        {showFeedSkeleton ? (
          <div role="status" aria-label={t.liveActivity.loadingActivityAria} className="space-y-2">
            <FeedSkeletonRow />
            <FeedSkeletonRow />
            <FeedSkeletonRow />
          </div>
        ) : recentFeed.length === 0 ? (
          <div className="p-6 text-center bg-pos-panel/60 border border-dashed border-pos-border rounded-2xl my-2 flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-pos-card border border-pos-border flex items-center justify-center text-pos-muted">
              <Receipt className="w-6 h-6 opacity-60" aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-bold text-pos-text">
                {rangeKey === 'today'
                  ? t.liveActivity.noSalesTodayTitle
                  : t('liveActivity.noSalesPeriodTitle', { period: activeRange.label.toLowerCase() })}
              </p>
              <p className="text-[11px] text-pos-muted mt-0.5">
                {rangeKey === 'today'
                  ? t.liveActivity.noSalesTodaySubtitle
                  : t.liveActivity.noSalesPeriodSubtitle}
              </p>
            </div>
            <div className="flex items-center gap-2 pt-1 flex-wrap justify-center">
              {rangeKey !== 'today' && (
                <button
                  type="button"
                  onClick={() => {
                    soundEngine.playKeyBeep?.();
                    setRangeKey('today');
                  }}
                  className="min-h-[48px] px-4 rounded-xl bg-pos-card border border-pos-border hover:border-pos-text text-pos-text font-bold text-xs flex items-center gap-1.5 active-press transition cursor-pointer"
                >
                  <CalendarDays className="w-3.5 h-3.5 text-pos-muted" aria-hidden="true" />
                  <span>{t.liveActivity.viewTodayButton}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleManualRefresh()}
                disabled={isSyncing}
                className="min-h-[48px] px-4 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-800 dark:text-cyan-300 font-bold text-xs flex items-center gap-1.5 active-press transition cursor-pointer disabled:opacity-50 shadow-xs"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>{isSyncing ? t.common.refreshing : t.common.refresh}</span>
              </button>
            </div>
          </div>
        ) : (
          recentFeed.map((tx) => {
            const isRefund = Boolean(tx.isRefund || tx.status === 'REFUNDED');
            const isVoided = tx.status === 'VOIDED';
            const presentation = getTransactionPresentation(tx, t);
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

            // Same unified basis as the hero KPIs above (alloc →
            // materialized row → stored) so the badge can never
            // contradict them; exchanges use signed row cost.
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
            const badgeProfit = basis !== undefined ? Number(tx.total ?? 0) - basis : tx.profit;

            return (
              <button
                key={tx.id}
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  onSelectSale?.(tx);
                }}
                className={`w-full text-start bg-pos-card border border-pos-border border-s-4 rounded-2xl p-3 sm:p-3.5 flex items-center justify-between hover:border-cyan-500/40 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none transition active-press cursor-pointer shadow-xs group ${presentation.borderStartClass}`}
                title="Voir le ticket de caisse et les détails de la transaction"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div
                    className={`w-10 h-10 rounded-2xl flex items-center justify-center font-bold text-xs shrink-0 border ${presentation.iconBgClass}`}
                  >
                    <presentation.Icon className={`w-4 h-4 ${presentation.iconColorClass}`} aria-hidden="true" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Bdi mono className="text-xs font-black text-pos-text truncate">
                        #{tx.receiptNumber || tx.id.slice(0, 8)}
                      </Bdi>
                      <span
                        className={`text-[9px] font-black px-1.5 py-0.5 rounded-md uppercase shrink-0 ${presentation.badgeClass}`}
                      >
                        {presentation.label}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-[10px] text-pos-muted mt-0.5 truncate">
                      <span className="flex items-center gap-1 font-medium truncate min-w-[80px] max-w-[160px]">
                        <User className="w-3 h-3 shrink-0" aria-hidden="true" />
                        <span className="truncate">{tx.customer?.name || t.liveActivity.walkInCustomerShort}</span>
                      </span>
                      <span aria-hidden="true">•</span>
                      <Bdi mono className="shrink-0">{tx.items?.length || 1} {t.liveActivity.itemsAbbrev}</Bdi>
                      <span aria-hidden="true">•</span>
                      <Bdi mono className="shrink-0" title={fullStr}>
                        {relativeFr ? `${relativeFr} • ${timeStr}` : timeStr}
                      </Bdi>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 ps-2 shrink-0">
                  <div className="text-end">
                    <Bdi
                      mono
                      className={`text-sm font-black block ${
                        isVoided
                          ? 'line-through text-pos-muted'
                          : isRefund
                          ? 'text-purple-700 dark:text-purple-400'
                          : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {isRefund ? `-${formatDZD(tx.total)}` : formatDZD(tx.total)}
                    </Bdi>
                    {!isVoided && !isRefund && badgeProfit !== undefined && badgeProfit > 0 && (
                      <Bdi mono className="text-[10px] font-bold text-pos-muted/80 block">
                        +{formatDZD(badgeProfit)} {t.liveActivity.netProfitSuffix}
                      </Bdi>
                    )}
                  </div>

                  <ChevronRight
                    className="w-4 h-4 text-pos-muted/40 group-hover:text-cyan-700 dark:group-hover:text-cyan-400 group-hover:translate-x-0.5 transition-all shrink-0 ms-0.5 rtl:rotate-180"
                    aria-hidden="true"
                  />
                </div>
                <span className="sr-only">
                  {t('liveActivity.openReceiptSrOnly', { number: tx.receiptNumber || tx.id.slice(0, 8) })}
                </span>
              </button>
            );
          })
        )}
      </div>
    </AppTabContent>
  );
};

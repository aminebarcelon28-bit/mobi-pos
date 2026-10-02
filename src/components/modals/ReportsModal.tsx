import React, { useState, useMemo, useEffect } from 'react';
import {
  X,
  BarChart3,
  TrendingUp,
  Download,
  Lock,
  Key,
  Eye,
  Printer,
  Search,
  ShoppingBag,
  CheckCircle2,
  Copy,
  RotateCcw,
  Ban,
  AlertTriangle,
  FileSpreadsheet,
  Calendar,
  Layers,
  DollarSign,
  Plus,
  Trash2,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  Boxes,
  Coins,
  Scale,
  Landmark,
  Sparkles,
  Receipt,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import type { SaleTransaction, ExpenseCategory, PaymentMethodType } from '../../types/pos';
import { SalesAnalyticsCharts } from '../reports/SalesAnalyticsCharts';
import { useToast } from '../ui/Toast';
import { generateProfessionalExcelXml } from '../../utils/excelExporter';
import { useInventoryValuation } from '../../hooks/useInventoryValuation';
import { useAllocationCogs } from '../../hooks/useAllocationCogs';
import { useReceiptLedgerCogs } from '../../hooks/useReceiptLedgerCogs';
import { computeSalesMetrics, grossFromTransaction, isExchangeSaleTx } from '../../utils/receiptMath';
import { parseLocalizedAmount } from '../../utils/moneyInput';
import { todayLocalKey, toLocalDayKey } from '../../utils/dateUtils';
import { verifyManagerGate } from '../../utils/pinGate';

export const ReportsModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    openModal,
    transactions,
    // Phase 1: manager checks route through the native gate (no local
    // verifyManagerPin reads here — see utils/pinGate).
    logSecurityAction,
    reprintReceipt,
    voidTransaction,
    setSelectedTransactionForRefund,
    storeExpenses,
    addStoreExpense,
    deleteStoreExpense,
    products,
    customers,
    customerDebts,
    activeShift,
    allShifts,
    repairOrders,
    tradeIns,
    cashDrops,
  } = usePosStore();

  const { showToast } = useToast();

  const [pinVerified, setPinVerified] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [activeTab, setActiveTab] = useState<'summary' | 'history' | 'analytics' | 'expenses' | 'export'>('summary');

  // Expense State
  const [showNewExpenseModal, setShowNewExpenseModal] = useState(false);
  const [expenseCategory, setExpenseCategory] = useState<ExpenseCategory>('Loyer');
  const [expenseTitle, setExpenseTitle] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expensePaymentMethod, setExpensePaymentMethod] = useState<PaymentMethodType>('Espèces');
  const [expensePaidTo, setExpensePaidTo] = useState('');
  const [expenseNotes, setExpenseNotes] = useState('');
  const [expenseCategoryFilter, setExpenseCategoryFilter] = useState<string>('Tous');

  // Transaction Inspector State
  const [inspectingTransaction, setInspectingTransaction] = useState<SaleTransaction | null>(null);
  const [isVoiding, setIsVoiding] = useState(false);
  // Double-submit guard for the void confirm (isVoiding is the form's
  // visibility flag, not a submission flag).
  const [isVoidSubmitting, setIsVoidSubmitting] = useState(false);
  const [voidReason, setVoidReason] = useState('Erreur de caisse / Article erroné');
  const [voidPin, setVoidPin] = useState('');



  // v105 ATOMIC MATERIALIZATION: new sales carry the exact FIFO sum
  // hardcoded into the row (transactions.ledger_cogs_total) BEFORE commit —
  // the receipt reads that ONE number and never looks for
  // sale_batch_allocations. The ledger hook below runs ONLY for legacy rows
  // whose column is absent (undefined id skips it immediately).
  const inspectorMaterialized = (() => {
    const raw = inspectingTransaction as (SaleTransaction & { ledger_cogs_total?: unknown; cost_total?: unknown }) | null;
    const rawVal = raw?.ledgerCogsTotal ?? raw?.ledger_cogs_total;
    if (rawVal === undefined || rawVal === null) return undefined;
    const v = Number(rawVal);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  })();
  // Strict materialized path: a new sale MUST render exclusively from the
  // hardcoded row (ledger_cogs_total + per-line unit_cost_at_sale). Catalog
  // costPrice is legacy-only — consulting it for a materialized ticket is
  // exactly how the wrong-cost receipt class happened.
  const isMaterializedReceipt = inspectorMaterialized != null;
  const { ledgerCogs: inspectorHookCogs, ledgerLoaded: inspectorHookLoaded } = useReceiptLedgerCogs(
    inspectorMaterialized != null ? undefined : inspectingTransaction?.id
  );
  const inspectorLedgerCogs = inspectorMaterialized ?? inspectorHookCogs;
  // Materialized rows are synchronously known — no loading flash, no hook
  // wait. Legacy rows keep the pending discipline (never the stored flash).
  const inspectorLedgerLoaded = inspectorMaterialized != null ? true : inspectorHookLoaded;
  // Pro-rata frozen unit cost for receipt lines that carry no unitCostAtSale
  // (display fallback only — the ticket total below always uses the exact
  // ledger sum, so the split stays exact in aggregate).
  const inspectorLedgerAvgUnit: number | undefined =
    inspectorLedgerCogs != null
      ? (() => {
          const qty = (inspectingTransaction?.items || []).reduce(
            (a, it) => a + Math.abs(Number(it.quantity ?? 0)),
            0
          );
          return qty > 0 ? inspectorLedgerCogs / qty : undefined;
        })()
      : undefined;

  // Search & Filter State in History & Export Tabs
  const [historySearch, setHistorySearch] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('Tous');
  const [statusFilter, setStatusFilter] = useState('Tous');
  const [dateRangeFilter, setDateRangeFilter] = useState<'all' | 'today' | '7days' | '30days'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 50;

  // Export Tab State
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);

  const handleVerifyPin = async (e: React.FormEvent) => {
    e.preventDefault();
    // Phase 1: native gate (fail-closed); Locked shows the countdown.
    const gate = await verifyManagerGate(pinInput);
    if (gate.ok) {
      setPinVerified(true);
      logSecurityAction(
        'Accès Rapports Financiers Autorisé',
        'Consultation des rapports par PIN Administrateur',
        'Yacine (Admin)',
        true
      );
    } else {
      showToast(
        gate.locked
          ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
          : 'PIN Administrateur incorrect ! Accès refusé.',
        'error'
      );
      logSecurityAction('Tentative Accès Rapports Échouée', 'PIN incorrect saisi', 'Caissier', true);
    }
  };

  // Financial KPI Metrics (excludes voided transactions and accounts for refunds)
  const dateFilteredTransactions = useMemo(() => {
    const list = transactions || [];
    if (dateRangeFilter === 'all') return list;
    const now = new Date();

    return list.filter((t) => {
      const txDate = new Date(t.createdAt);
      if (isNaN(txDate.getTime())) return true;

      if (dateRangeFilter === 'today') {
        return toLocalDayKey(txDate) === todayLocalKey();
      }
      if (dateRangeFilter === '7days') {
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return txDate >= sevenDaysAgo;
      }
      if (dateRangeFilter === '30days') {
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return txDate >= thirtyDaysAgo;
      }
      return true;
    });
  }, [transactions, dateRangeFilter]);

  const validSales = (dateFilteredTransactions || []).filter((t) => t.status !== 'VOIDED' && !t.isRefund);
  // Canonical unified metrics (shared with Mobile LiveActivityTab /
  // ManagementTab): CA Net = Σ net(valid) − Σ refunds(isRefund), NOT gross.
  // The previous code summed gross(subtotal) here, overstating CA and profit
  // by exactly Σ discountTotal (reported 2 326 DA gap).
  // STRICT FIFO LEDGER (v104): COGS comes from the frozen allocation mirror
  // (Dexie saleBatchAllocations, backfilled on boot/pull). The alloc map
  // WINS per sale inside computeSalesMetrics, so a stale stored costTotal
  // (500×2=1000) can never render profit 6,000 instead of 6,100 again.
  const { allocCogsBySaleId } = useAllocationCogs();
  // Single display-cost rule shared by the inspector, the history lists and
  // the CSV/clipboard exports so all three can never disagree:
  // - pure sales read the frozen ledger (alloc mirror, else the materialized
  //   row column) — exact batch sum, immune to the ±1 DA blended rounding and
  //   to stale stored rows;
  // - exchange receipts (return leg present) read the SIGNED row cost: the
  //   ledger only freezes the sale leg while the ticket total is signed net,
  //   so margin must be net − net-cost, i.e. reversal of A's margin plus
  //   creation of B's.
  // Returns undefined when nothing exact is known (legacy rows) — callers
  // keep their previous fallback verbatim in that case.
  const displayCostBasisFor = (t: SaleTransaction): number | undefined => {
    const finiteCost = (v: unknown): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
    };
    if (isExchangeSaleTx(t)) {
      const rowCost = Number(t.costTotal);
      if (Number.isFinite(rowCost)) return Math.round(rowCost);
      return finiteCost(allocCogsBySaleId[t.id]);
    }
    return finiteCost(allocCogsBySaleId[t.id]) ?? finiteCost(t.ledgerCogsTotal);
  };
  // Local alias: the shared exchange rule lives in receiptMath so the
  // inspector, lists, exports, shift close and computeSalesMetrics agree.
  const isExchangeSale = isExchangeSaleTx;
  const salesMetrics = useMemo(
    () => computeSalesMetrics(dateFilteredTransactions || [], { allocCogsBySaleId }),
    [dateFilteredTransactions, allocCogsBySaleId]
  );
  const totalRefundsValue = salesMetrics.refundsTotal;
  const totalRevenue = salesMetrics.netRevenue;
  const totalCost = salesMetrics.costTotal;
  const totalNetProfit = salesMetrics.profitTotal;
  const netProfitMargin = salesMetrics.marginPct;
  const averageBasket = salesMetrics.averageBasket;

  // Operating Expenses & True Net Profit (EBITDA)
  const dateFilteredExpenses = useMemo(() => {
    const list = storeExpenses || [];
    if (dateRangeFilter === 'all') return list;
    const now = new Date();

    return list.filter((e) => {
      const eDate = new Date(e.createdAt);
      if (isNaN(eDate.getTime())) return true;

      if (dateRangeFilter === 'today') {
        return toLocalDayKey(eDate) === todayLocalKey();
      }
      if (dateRangeFilter === '7days') {
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return eDate >= sevenDaysAgo;
      }
      if (dateRangeFilter === '30days') {
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return eDate >= thirtyDaysAgo;
      }
      return true;
    });
  }, [storeExpenses, dateRangeFilter]);

  const totalOperatingExpenses = (dateFilteredExpenses || []).reduce((acc, e) => acc + (e.amount || 0), 0);
  const trueEbitdaNetProfit = totalNetProfit - totalOperatingExpenses;
  const ebitdaMargin = totalRevenue > 0 ? ((trueEbitdaNetProfit / totalRevenue) * 100).toFixed(1) : '0';

  // ── Inventory & Asset Valuation ──
  // Batch-based (useInventoryValuation): Σ(quantity_remaining × unit_cost)
  // over live batches — SQLite authority, Dexie offline mirror, legacy
  // stock×cost only as last resort. Units/retail share the same batch basis
  // so the latent margin (retail − cost) can never mix bases.
  const valuation = useInventoryValuation(products);
  const totalStockUnits = valuation.units;
  const totalStockCostValue = valuation.costValue;
  const totalStockRetailValue = valuation.retailValue;
  const potentialInventoryProfit = Math.max(0, totalStockRetailValue - totalStockCostValue);
  const potentialMarginPct = totalStockRetailValue > 0 ? ((potentialInventoryProfit / totalStockRetailValue) * 100).toFixed(1) : '0';
  const lowStockCount = useMemo(() => (products || []).filter((p) => p.stock <= (p.reorderPoint || 5)).length, [products]);
  const outOfStockCount = useMemo(() => (products || []).filter((p) => p.stock <= 0).length, [products]);

  // ── Cash Drawer Reconciliation (Expected vs Counted) ──
  // B-047: EVERY inflow and outflow uses the SAME dateRangeFilter window as
  // cashSales — mixing date-filtered inflows with all-time outflows made the
  // expected-cash figure wrong whenever a filter other than 'all' was active.
  const dateInRange = useMemo(() => {
    if (dateRangeFilter === 'all') return () => true;
    const now = new Date();
    return (iso: string | undefined) => {
      if (!iso) return true;
      const d = new Date(iso);
      if (isNaN(d.getTime())) return true;
      if (dateRangeFilter === 'today') return toLocalDayKey(d) === todayLocalKey();
      if (dateRangeFilter === '7days') return d >= new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      if (dateRangeFilter === '30days') return d >= new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return true;
    };
  }, [dateRangeFilter]);

  const openingFloat = activeShift?.openingFloat ?? (allShifts && allShifts.length > 0 ? allShifts[0].openingFloat : 20000);
  const cashSales = useMemo(() => {
    return (dateFilteredTransactions || [])
      .filter((t) => t.status !== 'VOIDED' && !t.isRefund)
      .reduce((acc, t) => {
        if (t.tenders && Array.isArray(t.tenders) && t.tenders.length > 0) {
          const cashTenderTotal = t.tenders.filter((tender) => tender.method === 'Espèces').reduce((sum, tender) => sum + (tender.amount || 0), 0);
          return acc + Math.max(0, cashTenderTotal - (t.changeDue || 0));
        }
        return t.paymentMethod === 'Espèces' ? acc + (t.total || 0) : acc;
      }, 0);
  }, [dateFilteredTransactions]);

  const debtCashCollected = useMemo(() => {
    return (customerDebts || [])
      .filter((d) => d.type === 'PAYMENT_SETTLED' && d.paymentMethod === 'Espèces' && dateInRange(d.createdAt))
      .reduce((acc, d) => acc + d.amount, 0);
  }, [customerDebts, dateInRange]);

  const savCashCollected = useMemo(() => {
    return (repairOrders || [])
      .filter((r) => dateInRange(r.createdAt))
      .reduce(
        (acc, r) =>
          acc +
          (r.depositAmount || 0) +
          (r.status === 'Prêt / Terminé' ? Math.max(0, r.totalCost - (r.depositAmount || 0)) : 0),
        0
      );
  }, [repairOrders, dateInRange]);

  const cashExpensesOut = useMemo(() => {
    return (dateFilteredExpenses || []).filter((e) => e.paymentMethod === 'Espèces').reduce((acc, e) => acc + (e.amount || 0), 0);
  }, [dateFilteredExpenses]);

  const tradeInPayoutsOut = useMemo(() => {
    // B-048: wallet-credit buybacks never leave the drawer — only cash payouts.
    return (tradeIns || [])
      .filter((t) => !t.creditToWallet && dateInRange(t.createdAt))
      .reduce((acc, t) => acc + (t.buybackValue || 0), 0);
  }, [tradeIns, dateInRange]);

  const cashDropsOut = useMemo(() => {
    return (cashDrops || []).filter((d) => dateInRange(d.timestamp)).reduce((acc, d) => acc + d.amount, 0);
  }, [cashDrops, dateInRange]);

  const expectedCashInDrawer = Math.max(
    0,
    openingFloat + cashSales + debtCashCollected + savCashCollected - cashExpensesOut - tradeInPayoutsOut - cashDropsOut
  );

  const actualCountedCash = useMemo(() => {
    if (activeShift?.actualCash !== undefined && activeShift?.actualCash !== null) {
      return activeShift.actualCash;
    }
    if (activeShift?.denominations) {
      const denomMultipliers: Record<string, number> = {
        qty2000: 2000,
        qty1000: 1000,
        qty500: 500,
        qty200: 200,
        qty100: 100,
        qty50: 50,
        qty20: 20,
        qty10: 10,
        coins: 1,
      };
      return Object.entries(activeShift.denominations).reduce(
        (acc, [denom, count]) => acc + (denomMultipliers[denom] || 0) * (typeof count === 'number' ? count : 0),
        0
      );
    }
    return null;
  }, [activeShift]);

  const cashDiscrepancy = actualCountedCash !== null ? actualCountedCash - expectedCashInDrawer : 0;

  // ── Customer Debts & Store Credit Liabilities ──
  const totalCustomerDebt = useMemo(() => (customers || []).reduce((acc, c) => acc + (c.currentDebt || 0), 0), [customers]);
  const debtCustomerCount = useMemo(() => (customers || []).filter((c) => (c.currentDebt || 0) > 0).length, [customers]);
  const totalStoreCreditLiability = useMemo(() => (customers || []).reduce((acc, c) => acc + (c.storeCredit || 0), 0), [customers]);

  // ── Waterfall P&L Breakdown Metrics ──
  const grossSalesRevenue = (validSales || []).reduce((acc, t) => acc + grossFromTransaction(t), 0);
  const totalDiscountsGiven = (validSales || []).reduce((acc, t) => acc + (t.discountTotal || 0), 0);
  const totalRefunds = totalRefundsValue;

  const handleAddExpenseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Math.round(parseLocalizedAmount(expenseAmount) || 0);
    if (!(amount > 0) || !expenseTitle.trim()) {
      showToast('Veuillez saisir un titre et un montant valide.', 'warning');
      return;
    }

    await addStoreExpense({
      category: expenseCategory,
      title: expenseTitle.trim(),
      amount,
      paymentMethod: expensePaymentMethod,
      paidTo: expensePaidTo.trim() || undefined,
      notes: expenseNotes.trim() || undefined,
      recordedBy: 'Yacine (Admin)',
    });

    showToast('Charge d\'exploitation enregistrée avec succès !', 'success');
    setShowNewExpenseModal(false);
    setExpenseTitle('');
    setExpenseAmount('');
    setExpensePaidTo('');
    setExpenseNotes('');
  };

  // Filtered Transactions for History List — sorted by date DESC (latest first)
  const filteredTransactions = useMemo(() => {
    const filtered = (dateFilteredTransactions || []).filter((t) => {
      const matchesPayment = paymentFilter === 'Tous' || t.paymentMethod === paymentFilter;

      let matchesStatus = true;
      if (statusFilter === 'COMPLETED') {
        matchesStatus = t.status !== 'VOIDED' && !t.isRefund;
      } else if (statusFilter === 'VOIDED') {
        matchesStatus = t.status === 'VOIDED';
      } else if (statusFilter === 'REFUNDED') {
        matchesStatus = t.status === 'REFUNDED' || t.status === 'PARTIALLY_REFUNDED';
      } else if (statusFilter === 'isRefund') {
        matchesStatus = Boolean(t.isRefund);
      }

      const q = historySearch.trim().toLowerCase();
      const matchesSearch =
        !q ||
        (t.receiptNumber && t.receiptNumber.toLowerCase().includes(q)) ||
        (t.customer?.name && t.customer.name.toLowerCase().includes(q)) ||
        (t.customer?.phone && t.customer.phone.toLowerCase().includes(q)) ||
        (t.items || []).some(
          (item) =>
            (item.product?.title || '').toLowerCase().includes(q) ||
            (item.product?.sku || '').toLowerCase().includes(q)
        );

      return matchesPayment && matchesStatus && matchesSearch;
    });

    // ORDER BY date DESC — latest receipts first
    return filtered.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [dateFilteredTransactions, paymentFilter, statusFilter, historySearch]);

  // Reset to first page whenever a history filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [historySearch, paymentFilter, statusFilter, dateRangeFilter]);

  const totalPages = Math.max(1, Math.ceil((filteredTransactions || []).length / PAGE_SIZE));
  const safeCurrentPage = Math.min(currentPage, totalPages);

  const paginatedTransactions = useMemo(() => {
    const start = (safeCurrentPage - 1) * PAGE_SIZE;
    return (filteredTransactions || []).slice(start, start + PAGE_SIZE);
  }, [filteredTransactions, safeCurrentPage]);

  const handleReprintFromInspector = (t: SaleTransaction) => {
    setInspectingTransaction(null);
    closeModal();
    reprintReceipt(t);
  };

  const handleLaunchRefundFromInspector = (t: SaleTransaction) => {
    setSelectedTransactionForRefund(t);
    setInspectingTransaction(null);
    closeModal();
    openModal('refund');
  };

  const handleConfirmVoid = async (t: SaleTransaction) => {
    if (isVoidSubmitting) return;
    // Phase 1: native gate (fail-closed); Locked shows the countdown.
    const gate = await verifyManagerGate(voidPin);
    if (!gate.ok) {
      showToast(
        gate.locked
          ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
          : 'PIN Manager incorrect ! Autorisation requise pour annuler une vente.',
        'error'
      );
      return;
    }

    setIsVoidSubmitting(true);
    try {
      const voidResult = await voidTransaction(t.id, voidReason, 'Manager');
      if (voidResult.success) {
        showToast(`Vente #${t.receiptNumber} annulée avec succès. Stocks et fidélité restaurés.`, 'success');
        setInspectingTransaction(null);
        setIsVoiding(false);
        setVoidPin('');
      } else if (voidResult.reason === 'VOID_ALREADY_IN_PROGRESS') {
        showToast(`Annulation déjà en cours sur un autre appareil — synchronisez puis vérifiez le ticket #${t.receiptNumber} avant de réessayer.`, 'warning');
      } else if (voidResult.reason === 'ALREADY_VOIDED') {
        showToast(`Vente #${t.receiptNumber} déjà annulée.`, 'warning');
      } else if (voidResult.reason === 'VOID_EXCHANGE_USE_REFUND') {
        showToast(`Ticket d’échange : annulation directe interdite (reprise liée) — passez par un remboursement, la valeur reprise sera restaurée en avoir.`, 'warning');
      } else {
        showToast(`Erreur lors de l'annulation: ${voidResult.reason}`, 'error');
      }
    } finally {
      setIsVoidSubmitting(false);
    }
  };

  // EXPORT 1: Formatted Color-Coded Multi-Sheet Microsoft Excel (.xls / SpreadsheetML XML)
  const handleExportExcelFormatted = () => {
    if (dateFilteredTransactions.length === 0) {
      showToast('Aucune transaction à exporter pour la période sélectionnée.', 'error');
      return;
    }

    const periodLabel =
      dateRangeFilter === 'today'
        ? "Aujourd'hui"
        : dateRangeFilter === '7days'
        ? '7 Derniers Jours'
        : dateRangeFilter === '30days'
        ? '30 Derniers Jours'
        : 'Tout l\'Historique';

    // The exporter throws { code: 'TOO_LARGE' } when the period exceeds its
    // row budget — surface that as guidance instead of a crash, and keep the
    // old behavior (propagate) for every other failure.
    let xmlContent: string;
    try {
      xmlContent = generateProfessionalExcelXml(dateFilteredTransactions, periodLabel, allocCogsBySaleId);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'TOO_LARGE') {
        showToast('Export trop volumineux pour Excel : réduisez la période (7/30 jours) puis réessayez.', 'error');
        return;
      }
      throw err;
    }
    const blob = new Blob([xmlContent], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute(
      'download',
      `MOBI_POS_RAPPORT_EXCEL_PRO_${todayLocalKey()}.xls`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setExportSuccess('Fichier Excel Professionnel (.XLS) généré et téléchargé avec succès !');
    showToast('Exportation Excel stylisée terminée avec succès !', 'success');
    setTimeout(() => setExportSuccess(null), 4500);
  };

  // EXPORT 2: Standard CSV with UTF-8 BOM
  const handleExportCSV = () => {
    if (dateFilteredTransactions.length === 0) {
      showToast('Aucune transaction à exporter.', 'error');
      return;
    }

    const BOM = '\uFEFF';
    const headers =
      'N° Reçu;Statut;Date & Heure;Client;Articles (Qté);Sous-Total (DA);Remise (DA);Total Net (DA);Coût Achat (DA);Bénéfice (DA);Marge (%);Mode Paiement\n';

    const rows = (dateFilteredTransactions || [])
      .map((t) => {
        const customerName = (t.customer?.name || 'Client de passage').replace(/;/g, ' ');
        const dateStr = (t.createdAt || '').replace(/;/g, ' ');
        const payment = (t.paymentMethod || 'Espèces').replace(/;/g, ' ');
        const itemCount = (t.items || []).reduce((acc, i) => acc + i.quantity, 0);
          const subtotal = grossFromTransaction(t);
        const discount = t.discountTotal || 0;
        // STRICT FIFO LEDGER (v104) + unified display basis: frozen
        // allocation sum wins per row so the CSV matches the Net Profit
        // card (900/6,100, not 1000/6,000); exchange receipts use the
        // signed row cost (both legs).
        const allocRow = (() => {
          const raw = allocCogsBySaleId[t.id];
          const v = Number(raw);
          return Number.isFinite(v) && v >= 0 ? v : undefined;
        })();
        const basisRow = displayCostBasisFor(t);
        const cost = t.status === 'VOIDED' ? 0 : basisRow ?? allocRow ?? t.costTotal ?? 0;
        const netTotal = t.status === 'VOIDED' ? 0 : t.isRefund ? -t.total : t.total;
        const profit = t.status === 'VOIDED' || t.isRefund ? 0 : netTotal - cost;
        const margin = netTotal > 0 ? ((profit / netTotal) * 100).toFixed(1) : '0';
        const statusLabel = t.status === 'VOIDED' ? 'ANNULÉ' : t.isRefund ? 'AVOIR' : 'VALIDÉ';

        return `"${t.receiptNumber}";"${statusLabel}";"${dateStr}";"${customerName}";${itemCount};${subtotal};${discount};${netTotal};${cost};${profit};${margin}%;"${payment}"`;
      })
      .join('\n');

    const csvContent = BOM + headers + rows;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute(
      'download',
      `MOBI_POS_EXPORT_CSV_${todayLocalKey()}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setExportSuccess('Fichier CSV UTF-8 téléchargé avec succès !');
    showToast('Exportation CSV terminée !', 'success');
    setTimeout(() => setExportSuccess(null), 4000);
  };

  const handleCopyToClipboard = () => {
    const headers = 'N° Reçu\tDate\tClient\tArticles\tTotal Net (DA)\tBénéfice (DA)\tMode Paiement\tStatut\n';
    const rows = (dateFilteredTransactions || [])
      .map((t) => {
        const customerName = t.customer?.name || 'Client de passage';
        const itemCount = (t.items || []).reduce((acc, i) => acc + i.quantity, 0);
        // STRICT FIFO LEDGER (v104) + unified display basis: recompute
        // from the frozen allocation instead of echoing the possibly-stale
        // stored profit; exchange receipts use the signed row cost.
        const allocCopy = (() => {
          const raw = allocCogsBySaleId[t.id];
          const v = Number(raw);
          return Number.isFinite(v) && v >= 0 ? v : undefined;
        })();
        const copyCost = t.status === 'VOIDED' ? 0 : displayCostBasisFor(t) ?? allocCopy ?? t.costTotal ?? 0;
        const copyNet = t.status === 'VOIDED' ? 0 : t.isRefund ? -t.total : t.total;
        const copyProfit = t.status === 'VOIDED' || t.isRefund ? 0 : copyNet - copyCost;
        return `${t.receiptNumber}\t${t.createdAt}\t${customerName}\t${itemCount}\t${t.total}\t${copyProfit}\t${t.paymentMethod}\t${t.status}`;
      })
      .join('\n');

    navigator.clipboard.writeText(headers + rows).then(() => {
      setCopySuccess(true);
      showToast('Données tabulaires copiées ! Vous pouvez les coller (Ctrl+V) dans Excel.', 'success');
      setTimeout(() => setCopySuccess(false), 3000);
    });
  };

  // Escape dismissal: topmost-first (void form → inspector → expense → modal)
  useEffect(() => {
    if (activeModal !== 'reports') return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isVoiding) {
        setIsVoiding(false);
        return;
      }
      if (inspectingTransaction) {
        setInspectingTransaction(null);
        setIsVoiding(false);
        return;
      }
      if (showNewExpenseModal) {
        setShowNewExpenseModal(false);
        return;
      }
      closeModal();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [activeModal, isVoiding, inspectingTransaction, showNewExpenseModal, closeModal]);

  if (activeModal !== 'reports') return null;

  return (
    <div
      onClick={closeModal}
      className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border border-pos-border rounded-t-2xl sm:rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:fade-in sm:zoom-in-95 h-[94dvh] sm:h-[90dvh] flex flex-col relative cursor-default"
      >
        {/* Mobile drag handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />
        
        {/* Modal Header */}
        <div className="p-3 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <button
              type="button"
              onClick={() => {
                setPinVerified(false);
                setPinInput('');
                closeModal();
              }}
              className="p-1.5 px-2.5 sm:px-3 bg-emerald-500/10 hover:bg-emerald-500/20 active:scale-95 border border-emerald-500/30 text-emerald-400 rounded-lg font-bold text-xs flex items-center gap-1.5 transition cursor-pointer min-h-[44px] shrink-0"
              title="Retour (Échap)"
            >
              <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
              <span>Retour</span>
            </button>
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20 shrink-0">
              <BarChart3 className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                <h2 className="text-sm sm:text-base font-black text-pos-text tracking-wide truncate min-w-0">
                  RAPPORTS FINANCIERS
                </h2>
                <span className="text-[9px] sm:text-[10px] bg-emerald-500/10 text-emerald-400 font-black px-1.5 py-0.5 rounded-full border border-emerald-500/30 uppercase shrink-0 whitespace-nowrap">
                  ENTERPRISE
                </span>
              </div>
              <p className="text-[10px] sm:text-[11px] text-pos-muted truncate">
                Analytics de performance, audit comptable & exports
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setPinVerified(false);
              setPinInput('');
              closeModal();
            }}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0 cursor-pointer"
            title="Fermer (Échap)"
            aria-label="Fermer les rapports"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Security PIN Gate */}
        {!pinVerified ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 sm:p-8 space-y-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shadow-xl">
              <Lock className="w-8 h-8 stroke-[2.5]" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-black text-pos-text">Accès Sécurisé par PIN Administrateur</h3>
              <p className="text-xs text-pos-muted mt-1 max-w-sm">
                Saisissez votre code PIN Manager pour consulter les chiffres financiers et exporter les données comptables.
              </p>
            </div>

            <form onSubmit={handleVerifyPin} className="flex gap-2 w-full max-w-xs pt-2">
              <div className="relative flex-1">
                <Key className="w-4 h-4 text-pos-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="current-password"
                  autoFocus
                  placeholder="Code PIN Administrateur"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  className="w-full bg-pos-bg border border-pos-border rounded-lg pl-9 pr-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none min-h-[44px]"
                />
              </div>
              <button
                type="submit"
                className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-lg transition shadow-md cursor-pointer min-h-[44px] active:scale-95"
              >
                Déverrouiller
              </button>
            </form>
          </div>
        ) : (
          /* Unlocked Reports View */
          <div className="flex-1 flex flex-col overflow-hidden">
            
            {/* Top Navigation Tabs */}
            <div className="flex border-b border-pos-border bg-pos-card px-2.5 sm:px-4 shrink-0 items-center gap-2 overflow-x-auto no-scrollbar">
              <div className="flex shrink-0">
                <button
                  onClick={() => setActiveTab('summary')}
                  className={`py-2.5 sm:py-3 px-3 sm:px-4 text-xs font-black border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer shrink-0 min-h-[44px] ${
                    activeTab === 'summary'
                      ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5'
                      : 'border-transparent text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <LayoutDashboard className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Synthèse<span className="hidden sm:inline"> Financière & Bilan</span></span>
                </button>

                <button
                  onClick={() => setActiveTab('history')}
                  className={`py-2.5 sm:py-3 px-3 sm:px-4 text-xs font-black border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer shrink-0 min-h-[44px] ${
                    activeTab === 'history'
                      ? 'border-emerald-500 text-emerald-400'
                      : 'border-transparent text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <ShoppingBag className="w-3.5 h-3.5 shrink-0" />
                  <span>Historique<span className="hidden sm:inline"> Transactions</span> ({(transactions || []).length})</span>
                </button>

                <button
                  onClick={() => setActiveTab('analytics')}
                  className={`py-2.5 sm:py-3 px-3 sm:px-4 text-xs font-black border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer shrink-0 min-h-[44px] ${
                    activeTab === 'analytics'
                      ? 'border-emerald-500 text-emerald-400'
                      : 'border-transparent text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <BarChart3 className="w-3.5 h-3.5 shrink-0" />
                  <span>Graphiques<span className="hidden sm:inline"> & Performance</span></span>
                </button>

                <button
                  onClick={() => setActiveTab('expenses')}
                  className={`py-2.5 sm:py-3 px-3 sm:px-4 text-xs font-black border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer shrink-0 min-h-[44px] ${
                    activeTab === 'expenses'
                      ? 'border-emerald-500 text-emerald-400'
                      : 'border-transparent text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <DollarSign className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Dépenses<span className="hidden sm:inline"> & EBITDA</span></span>
                </button>

                <button
                  onClick={() => setActiveTab('export')}
                  className={`py-2.5 sm:py-3 px-3 sm:px-4 text-xs font-black border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer shrink-0 min-h-[44px] ${
                    activeTab === 'export'
                      ? 'border-emerald-500 text-emerald-400'
                      : 'border-transparent text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Exports<span className="hidden sm:inline"> Excel (PRO)</span></span>
                </button>
              </div>

              {/* Quick Date Range Filter */}
              <div className="flex items-center gap-1.5 py-1 shrink-0 pl-2 ml-auto">
                <Calendar className="w-3.5 h-3.5 text-pos-muted shrink-0" />
                <span className="text-[10px] font-bold text-pos-muted uppercase mr-1 shrink-0 whitespace-nowrap">Période :</span>
                {(['all', 'today', '7days', '30days'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setDateRangeFilter(r)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition cursor-pointer shrink-0 whitespace-nowrap min-h-[44px] inline-flex items-center ${
                      dateRangeFilter === r
                        ? 'bg-emerald-500 text-slate-950 shadow-sm'
                        : 'bg-pos-bg border border-pos-border text-pos-muted hover:text-pos-text'
                    }`}
                  >
                    {r === 'all'
                      ? 'Tout'
                      : r === 'today'
                      ? "Aujourd'hui"
                      : r === '7days'
                      ? '7 Jours'
                      : '30 Jours'}
                  </button>
                ))}

                <button
                  type="button"
                  onClick={() => openModal('shift_zreport')}
                  className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 transition cursor-pointer flex items-center gap-1 ml-1 shrink-0 whitespace-nowrap min-h-[44px]"
                  title="Aperçu et Contrôle du Rapport Z de Caisse"
                >
                  <Receipt className="w-3 h-3 text-emerald-400" />
                  <span>Rapport Z</span>
                </button>
              </div>
            </div>

            {/* Scrollable Tab Content Body */}
            <div className="p-5 overflow-y-auto overscroll-contain space-y-5 flex-1 bg-pos-bg">
              
              {/* ── 1. Financial Summary & Executive Balance Sheet ── */}
              {activeTab === 'summary' && (
                <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-200">
                  {/* Top Executive KPI Cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                    {/* Net Revenue */}
                    <div className="bg-pos-card border border-pos-border p-4 rounded-xl relative overflow-hidden shadow-sm">
                      <div className="flex justify-between items-start">
                        <span className="text-[10px] text-pos-muted uppercase font-black tracking-wider">Chiffre d'Affaires Net</span>
                        <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400">
                          <ShoppingBag className="w-4 h-4" />
                        </div>
                      </div>
                      <p className="text-2xl font-black font-mono text-emerald-400 mt-2">{formatDZD(totalRevenue)}</p>
                      <div className="flex items-center justify-between text-[11px] text-pos-muted mt-2 pt-2 border-t border-pos-border/40 font-medium">
                        <span>{validSales.length} ventes validées</span>
                        <span className="font-mono font-bold">Panier: {formatDZD(averageBasket)}</span>
                      </div>
                    </div>

                    {/* Gross Commercial Margin */}
                    <div className="bg-pos-card border border-pos-border p-4 rounded-xl relative overflow-hidden shadow-sm">
                      <div className="flex justify-between items-start">
                        <span className="text-[10px] text-pos-muted uppercase font-black tracking-wider">Marge Commerciale Brute</span>
                        <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400">
                          <TrendingUp className="w-4 h-4" />
                        </div>
                      </div>
                      <p className="text-2xl font-black font-mono text-emerald-400 mt-2">{formatDZD(totalNetProfit)}</p>
                      <div className="flex items-center justify-between text-[11px] text-pos-muted mt-2 pt-2 border-t border-pos-border/40 font-medium">
                        <span>Taux de Marge Brute</span>
                        <span className="font-mono font-bold text-emerald-400">{netProfitMargin}%</span>
                      </div>
                    </div>

                    {/* Operating Expenses (OPEX) */}
                    <div className="bg-pos-card border border-pos-border p-4 rounded-xl relative overflow-hidden shadow-sm">
                      <div className="flex justify-between items-start">
                        <span className="text-[10px] text-pos-muted uppercase font-black tracking-wider">Frais & Charges (OPEX)</span>
                        <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400">
                          <DollarSign className="w-4 h-4" />
                        </div>
                      </div>
                      <p className="text-2xl font-black font-mono text-emerald-400 mt-2">{formatDZD(totalOperatingExpenses)}</p>
                      <div className="flex items-center justify-between text-[11px] text-pos-muted mt-2 pt-2 border-t border-pos-border/40 font-medium">
                        <span>{dateFilteredExpenses.length} charges enregistrées</span>
                        <span className="text-emerald-300 font-bold">Déduit du bénéfice</span>
                      </div>
                    </div>

                    {/* True Net Profit (EBITDA) */}
                    <div className="bg-pos-card border border-emerald-500/30 p-4 rounded-xl relative overflow-hidden shadow-sm shadow-emerald-500/5">
                      <div className="flex justify-between items-start">
                        <span className="text-[10px] text-emerald-400 uppercase font-black tracking-wider">Résultat Net (EBITDA)</span>
                        <div className="p-2 rounded-xl bg-emerald-500/20 text-emerald-300">
                          <Sparkles className="w-4 h-4" />
                        </div>
                      </div>
                      <p className={`text-2xl font-black font-mono mt-2 ${trueEbitdaNetProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {formatDZD(trueEbitdaNetProfit)}
                      </p>
                      <div className="flex items-center justify-between text-[11px] text-pos-muted mt-2 pt-2 border-t border-pos-border/40 font-medium">
                        <span>Rentabilité Nette</span>
                        <span className={`font-mono font-bold ${Number(ebitdaMargin) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {ebitdaMargin}%
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Grid: Inventory Valuation vs Cash Drawer Reconciliation */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Inventory & Stock Valuation Card */}
                    <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3.5 shadow-sm">
                      <div className="flex items-center justify-between pb-2 border-b border-pos-border/60">
                        <div className="flex items-center gap-2">
                          <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400">
                            <Boxes className="w-4 h-4" />
                          </div>
                          <div>
                            <h3 className="text-xs font-black text-pos-text uppercase tracking-wider">Valorisation de l'Inventaire & Stock</h3>
                            <p className="text-[10px] text-pos-muted">Capital immobilisé et valorisation marchande en temps réel</p>
                          </div>
                        </div>
                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                          {totalStockUnits} pièces ({(products || []).length} réf.)
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="bg-pos-bg border border-pos-border/80 p-3 rounded-xl">
                          <div className="flex items-center justify-between">
                            <span className="text-[9.5px] font-bold text-pos-muted uppercase block">Valeur au Coût d'Achat (Actif)</span>
                            {valuation.source === 'sqlite' && (
                              <span className="text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-mono">
                                FIFO Actif
                              </span>
                            )}
                            {valuation.source === 'dexie' && (
                              <span className="text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 font-mono">
                                FIFO · Hors-ligne
                              </span>
                            )}
                            {valuation.source === 'legacy' && (
                              <span className="text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-pos-muted/10 text-pos-muted border border-pos-border font-mono">
                                Estimé
                              </span>
                            )}
                          </div>
                          <span className="text-base font-black font-mono text-pos-text mt-1 block">
                            {formatDZD(totalStockCostValue)}
                          </span>
                          <span className="text-[9px] text-pos-muted">
                            {valuation.source === 'legacy'
                              ? 'Estimation (lots indisponibles)'
                              : "Valorisation FIFO exacte sur les lots restants"}
                          </span>
                        </div>
                        <div className="bg-pos-bg border border-pos-border/80 p-3 rounded-xl">
                          <span className="text-[9.5px] font-bold text-pos-muted uppercase block">Valeur Marchande (Prix Vente)</span>
                          <span className="text-base font-black font-mono text-emerald-400 mt-1 block">{formatDZD(totalStockRetailValue)}</span>
                          <span className="text-[9px] text-pos-muted">Chiffre d'affaires potentiel</span>
                        </div>
                      </div>

                      <div className="bg-gradient-to-r from-emerald-950/30 to-teal-950/30 border border-emerald-500/30 rounded-xl p-3 flex items-center justify-between">
                        <div>
                          <span className="text-[10px] font-bold text-emerald-300 uppercase block">Marge Brute Potentielle en Rayon</span>
                          <span className="text-xs text-pos-muted">Bénéfice latent après écoulement du stock</span>
                        </div>
                        <div className="text-right">
                          <span className="text-base font-black font-mono text-emerald-400 block">+{formatDZD(potentialInventoryProfit)}</span>
                          <span className="text-[10px] font-bold text-emerald-300 font-mono">Taux : {potentialMarginPct}%</span>
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-xs pt-1 px-1">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-amber-400" />
                          <span className="text-[11px] text-pos-muted">Articles en seuil critique (&le; stock min) :</span>
                          <span className="font-bold font-mono text-amber-400">{lowStockCount}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-red-400" />
                          <span className="text-[11px] text-pos-muted">Ruptures de stock (0 un.) :</span>
                          <span className="font-bold font-mono text-red-400">{outOfStockCount}</span>
                        </div>
                      </div>
                    </div>

                    {/* Cash Drawer Reconciliation (Expected vs Actual) Card */}
                    <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3.5 shadow-sm">
                      <div className="flex items-center justify-between pb-2 border-b border-pos-border/60">
                        <div className="flex items-center gap-2">
                          <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400">
                            <Coins className="w-4 h-4" />
                          </div>
                          <div>
                            <h3 className="text-xs font-black text-pos-text uppercase tracking-wider">Réconciliation du Tiroir-Caisse</h3>
                            <p className="text-[10px] text-pos-muted">Flux de trésorerie espèces et vérification des écarts</p>
                          </div>
                        </div>
                        <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded-full border ${
                          cashDiscrepancy === 0
                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                            : cashDiscrepancy > 0
                            ? 'bg-blue-500/10 border-blue-500/30 text-blue-400'
                            : 'bg-red-500/10 border-red-500/30 text-red-400'
                        }`}>
                          {actualCountedCash !== null ? (cashDiscrepancy === 0 ? '✓ Caisse Équilibrée' : `Écart : ${formatDZD(cashDiscrepancy)}`) : 'Session Active'}
                        </span>
                      </div>

                      {/* Detailed Cash Movement Breakdown */}
                      <div className="space-y-1.5 text-xs bg-pos-bg p-3 rounded-xl border border-pos-border/80">
                        <div className="flex justify-between items-center text-pos-muted">
                          <span>Fond de Caisse Initial :</span>
                          <span className="font-mono font-bold text-pos-text">{formatDZD(openingFloat)}</span>
                        </div>
                        <div className="flex justify-between items-center text-emerald-400">
                          <span>(+) Ventes encaissées en Espèces :</span>
                          <span className="font-mono font-bold">+{formatDZD(cashSales)}</span>
                        </div>
                        {debtCashCollected > 0 && (
                          <div className="flex justify-between items-center text-emerald-400">
                            <span>(+) Versements Dettes Clients (Kredy) :</span>
                            <span className="font-mono font-bold">+{formatDZD(debtCashCollected)}</span>
                          </div>
                        )}
                        {savCashCollected > 0 && (
                          <div className="flex justify-between items-center text-emerald-400">
                            <span>(+) Acomptes SAV / Réparations :</span>
                            <span className="font-mono font-bold">+{formatDZD(savCashCollected)}</span>
                          </div>
                        )}
                        {cashExpensesOut > 0 && (
                          <div className="flex justify-between items-center text-amber-400">
                            <span>(-) Dépenses sorties de caisse :</span>
                            <span className="font-mono font-bold">-{formatDZD(cashExpensesOut)}</span>
                          </div>
                        )}
                        {tradeInPayoutsOut > 0 && (
                          <div className="flex justify-between items-center text-amber-400">
                            <span>(-) Rachats Téléphones (Trade-In) :</span>
                            <span className="font-mono font-bold">-{formatDZD(tradeInPayoutsOut)}</span>
                          </div>
                        )}
                        {cashDropsOut > 0 && (
                          <div className="flex justify-between items-center text-purple-400">
                            <span>(-) Écrémages / Dépôts au Coffre :</span>
                            <span className="font-mono font-bold">-{formatDZD(cashDropsOut)}</span>
                          </div>
                        )}
                      </div>

                      {/* Expected vs Actual Totals Banner */}
                      <div className="bg-gradient-to-r from-emerald-950/40 to-teal-950/40 border border-emerald-500/40 rounded-xl p-3 flex items-center justify-between">
                        <div>
                          <span className="text-[10px] font-bold text-emerald-300 uppercase block">Espèces Théoriques Attendues</span>
                          <span className="text-xs text-pos-muted">Total calculé en temps réel</span>
                        </div>
                        <div className="text-right">
                          <span className="text-lg font-black font-mono text-emerald-400 block">{formatDZD(expectedCashInDrawer)}</span>
                          {actualCountedCash !== null && (
                            <span className="text-[10px] font-mono text-pos-muted">Compté : {formatDZD(actualCountedCash)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Financial Waterfall Table (Compte de Résultat Simplifié) & Customer Credit Liabilities */}
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    {/* Waterfall Accounting Table (2 Cols) */}
                    <div className="lg:col-span-2 bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-sm">
                      <div className="flex items-center justify-between pb-2 border-b border-pos-border/60">
                        <div className="flex items-center gap-2">
                          <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400">
                            <Scale className="w-4 h-4" />
                          </div>
                          <div>
                            <h3 className="text-xs font-black text-pos-text uppercase tracking-wider">Compte de Résultat d'Exploitation (P&L)</h3>
                            <p className="text-[10px] text-pos-muted">Décomposition analytique du chiffre d'affaires jusqu'au résultat net</p>
                          </div>
                        </div>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-pos-border/80 text-pos-muted text-[10px] uppercase">
                              <th className="text-left py-2 px-2">Ligne Comptable</th>
                              <th className="text-right py-2 px-2">Montant (DA)</th>
                              <th className="text-right py-2 px-2">% CA Net</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-pos-border/40 font-mono">
                            <tr>
                              <td className="py-2 px-2 text-pos-text font-sans font-semibold">Chiffre d'Affaires Brut (Articles)</td>
                              <td className="text-right py-2 px-2 font-bold">{formatDZD(grossSalesRevenue)}</td>
                              <td className="text-right py-2 px-2 text-pos-muted">-</td>
                            </tr>
                            {totalDiscountsGiven > 0 && (
                              <tr className="text-purple-400">
                                <td className="py-2 px-2 font-sans">(-) Remises & Rabais Accordés</td>
                                <td className="text-right py-2 px-2">-{formatDZD(totalDiscountsGiven)}</td>
                                <td className="text-right py-2 px-2">
                                  {totalRevenue > 0 ? ((totalDiscountsGiven / totalRevenue) * 100).toFixed(1) : 0}%
                                </td>
                              </tr>
                            )}
                            {totalRefunds > 0 && (
                              <tr className="text-red-400">
                                <td className="py-2 px-2 font-sans">(-) Retours & Remboursements Clients</td>
                                <td className="text-right py-2 px-2">-{formatDZD(totalRefunds)}</td>
                                <td className="text-right py-2 px-2">
                                  {totalRevenue > 0 ? ((totalRefunds / totalRevenue) * 100).toFixed(1) : 0}%
                                </td>
                              </tr>
                            )}
                            <tr className="bg-pos-bg/80 font-bold text-emerald-400 border-y border-pos-border">
                              <td className="py-2.5 px-2 font-sans uppercase text-[11px] font-black">(=) Chiffre d'Affaires Net Réalisé</td>
                              <td className="text-right py-2.5 px-2 text-sm">{formatDZD(totalRevenue)}</td>
                              <td className="text-right py-2.5 px-2">100.0%</td>
                            </tr>
                            <tr className="text-amber-400/90">
                              <td className="py-2 px-2 font-sans">(-) Coût d'Achat des Marchandises Vendues (COGS)</td>
                              <td className="text-right py-2 px-2">-{formatDZD(totalCost)}</td>
                              <td className="text-right py-2 px-2">
                                {totalRevenue > 0 ? ((totalCost / totalRevenue) * 100).toFixed(1) : 0}%
                              </td>
                            </tr>
                            <tr className="bg-emerald-950/20 font-bold text-emerald-400 border-y border-emerald-500/20">
                              <td className="py-2 px-2 font-sans uppercase text-[11px] font-black">(=) Marge Commerciale Brute</td>
                              <td className="text-right py-2 px-2 text-sm">{formatDZD(totalNetProfit)}</td>
                              <td className="text-right py-2 px-2">{netProfitMargin}%</td>
                            </tr>
                            <tr className="text-amber-400">
                              <td className="py-2 px-2 font-sans">(-) Frais & Charges d'Exploitation (Loyer, Factures, Salaires)</td>
                              <td className="text-right py-2 px-2">-{formatDZD(totalOperatingExpenses)}</td>
                              <td className="text-right py-2 px-2">
                                {totalRevenue > 0 ? ((totalOperatingExpenses / totalRevenue) * 100).toFixed(1) : 0}%
                              </td>
                            </tr>
                            <tr className="bg-emerald-950/40 border-2 border-emerald-500/40 text-emerald-300 font-black">
                              <td className="py-3 px-3 font-sans uppercase text-xs">(=) BÉNÉFICE NET D'EXPLOITATION (EBITDA)</td>
                              <td className="text-right py-3 px-3 text-base">{formatDZD(trueEbitdaNetProfit)}</td>
                              <td className="text-right py-3 px-3 text-sm">{ebitdaMargin}%</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Customer Receivables & Liabilities (1 Col) */}
                    <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-4 flex flex-col justify-between shadow-sm">
                      <div>
                        <div className="flex items-center gap-2 pb-2 border-b border-pos-border/60">
                          <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400">
                            <Landmark className="w-4 h-4" />
                          </div>
                          <div>
                            <h3 className="text-xs font-black text-pos-text uppercase tracking-wider">Créances & Engagements</h3>
                            <p className="text-[10px] text-pos-muted">Carnet de dettes et avoirs clients</p>
                          </div>
                        </div>

                        <div className="space-y-3 mt-3.5">
                          {/* Total Customer Debt (Kredy) */}
                          <div className="bg-pos-bg border border-pos-border p-3.5 rounded-xl space-y-1">
                            <div className="flex justify-between items-center text-xs">
                              <span className="font-bold text-orange-400">Crédits Clients en Cours (Kredy)</span>
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300 font-mono font-bold">
                                {debtCustomerCount} clients
                              </span>
                            </div>
                            <p className="text-xl font-black font-mono text-orange-400">{formatDZD(totalCustomerDebt)}</p>
                            <p className="text-[10px] text-pos-muted">Sommes dues par les clients réguliers</p>
                          </div>

                          {/* Total Store Credit Liabilities */}
                          <div className="bg-pos-bg border border-pos-border p-3.5 rounded-xl space-y-1">
                            <div className="flex justify-between items-center text-xs">
                              <span className="font-bold text-purple-400">Avoirs & Crédits Magasin Émis</span>
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-mono font-bold">
                                Passif
                              </span>
                            </div>
                            <p className="text-xl font-black font-mono text-purple-400">{formatDZD(totalStoreCreditLiability)}</p>
                            <p className="text-[10px] text-pos-muted">Bons d'achat et soldes de retour non réclamés</p>
                          </div>
                        </div>
                      </div>

                      {/* Quick Action Buttons */}
                      <div className="pt-3 border-t border-pos-border/60 space-y-2">
                        <button
                          onClick={() => setActiveTab('export')}
                          className="w-full py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black flex items-center justify-center gap-2 transition cursor-pointer shadow-md shadow-emerald-600/20"
                        >
                          <FileSpreadsheet className="w-4 h-4" />
                          Exporter Bilan Complet vers Excel
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'analytics' && <SalesAnalyticsCharts />}

              {activeTab === 'history' && (
                <div className="space-y-4">
                  
                  {/* Executive KPI Summary Bar */}
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    <div className="bg-pos-card border border-pos-border p-3 rounded-xl shadow-sm">
                      <span className="text-[9px] text-pos-muted uppercase font-bold">Total Transactions</span>
                      <p className="text-base font-black text-pos-text mt-0.5">{(dateFilteredTransactions || []).length}</p>
                    </div>

                    <div className="bg-pos-card border border-pos-border p-3 rounded-xl shadow-sm">
                      <span className="text-[9px] text-pos-muted uppercase font-bold">CA Net Total</span>
                      <p className="text-base font-black text-emerald-400 mt-0.5">{formatDZD(totalRevenue)}</p>
                    </div>

                    <div className="bg-pos-card border border-pos-border p-3 rounded-xl shadow-sm">
                      <span className="text-[9px] text-pos-muted uppercase font-bold flex items-center gap-1">
                        <TrendingUp className="w-3 h-3 text-emerald-400" /> Bénéfice Net
                      </span>
                      <p className="text-base font-black text-emerald-400 mt-0.5">{formatDZD(totalNetProfit)}</p>
                    </div>

                    <div className="bg-pos-card border border-pos-border p-3 rounded-xl shadow-sm">
                      <span className="text-[9px] text-pos-muted uppercase font-bold">Panier Moyen</span>
                      <p className="text-base font-black text-emerald-400 mt-0.5">{formatDZD(averageBasket)}</p>
                    </div>

                    <div className="bg-pos-card border border-pos-border p-3 rounded-xl shadow-sm">
                      <span className="text-[9px] text-pos-muted uppercase font-bold">Marge Nette %</span>
                      <p className="text-base font-black text-pos-text mt-0.5">{netProfitMargin}%</p>
                    </div>
                  </div>

                  {/* Search & Filter Toolbar — sticky top filter bar (inside scroll container) */}
                  <div className="sticky top-0 z-10 bg-pos-card/95 backdrop-blur-md border border-pos-border p-3 rounded-xl flex flex-wrap items-center justify-between gap-3 shadow-sm">
                    <div className="relative flex-1 min-w-[280px]">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                      <input
                        type="text"
                        value={historySearch}
                        onChange={(e) => setHistorySearch(e.target.value)}
                        placeholder="Rechercher N° Ticket, Client, Nom Produit, SKU..."
                        className="w-full bg-pos-bg border border-pos-border rounded-lg pl-9 pr-12 py-2 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none font-medium min-h-[44px]"
                      />
                      {historySearch && (
                        <button
                          type="button"
                          onClick={() => setHistorySearch('')}
                          aria-label="Effacer la recherche"
                          className="absolute right-1 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    {/* Filters: Date range, Status & Payment */}
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-pos-muted font-bold">Période:</span>
                        <select
                          value={dateRangeFilter}
                          onChange={(e) => setDateRangeFilter(e.target.value as 'all' | 'today' | '7days' | '30days')}
                          className="bg-pos-bg border border-pos-border text-pos-text text-xs font-bold rounded-lg px-3 py-2 focus:border-emerald-400 focus:outline-none cursor-pointer min-h-[44px]"
                        >
                          <option value="all">Tout l&apos;historique</option>
                          <option value="today">Aujourd&apos;hui</option>
                          <option value="7days">7 derniers jours</option>
                          <option value="30days">30 derniers jours</option>
                        </select>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-xs text-pos-muted font-bold">Statut:</span>
                        <select
                          value={statusFilter}
                          onChange={(e) => setStatusFilter(e.target.value)}
                          className="bg-pos-bg border border-pos-border text-pos-text text-xs font-bold rounded-lg px-3 py-2 focus:border-emerald-400 focus:outline-none cursor-pointer min-h-[44px]"
                        >
                          <option value="Tous">Tous les statuts</option>
                          <option value="COMPLETED">Ventes Validées</option>
                          <option value="VOIDED">Annulées (Erreurs)</option>
                          <option value="REFUNDED">Remboursées (Total / Partiel)</option>
                          <option value="isRefund">Avoirs Émis</option>
                        </select>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-xs text-pos-muted font-bold">Paiement:</span>
                        <select
                          value={paymentFilter}
                          onChange={(e) => setPaymentFilter(e.target.value)}
                          className="bg-pos-bg border border-pos-border text-pos-text text-xs font-bold rounded-lg px-3 py-2 focus:border-emerald-400 focus:outline-none cursor-pointer min-h-[44px]"
                        >
                          <option value="Tous">Tous les règlements</option>
                          <option value="Espèces">Espèces (Cash)</option>
                          <option value="Crédit Client">Crédit Client (Kredy)</option>
                          <option value="Avoir Client">Avoir Client</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Transactions History Table */}
                  <div className="bg-pos-card border border-pos-border rounded-xl overflow-hidden shadow-sm">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="bg-pos-bg text-pos-muted text-[10px] uppercase font-bold border-b border-pos-border">
                        <tr>
                          <th className="p-3">N° Ticket / Reçu</th>
                          <th className="p-3">Statut</th>
                          <th className="p-3">Client</th>
                          <th className="p-3">Articles</th>
                          <th className="p-3 text-right">Total Net</th>
                          <th className="p-3 text-right">Bénéfice</th>
                          <th className="p-3 text-center">Paiement</th>
                          <th className="p-3 text-right">Date</th>
                          <th className="p-3 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pos-border/40">
                        {(!paginatedTransactions || paginatedTransactions.length === 0) ? (
                          <tr>
                            <td colSpan={9} className="p-8 text-center text-pos-muted font-medium">
                              Aucune transaction ne correspond à vos critères de recherche.
                            </td>
                          </tr>
                        ) : (
                          (paginatedTransactions || []).map((t) => {
                            const isVoided = t.status === 'VOIDED';
                            const isRefund = Boolean(t.isRefund);
                            const isRefunded = t.status === 'REFUNDED';
                            const isPartiallyRefunded = t.status === 'PARTIALLY_REFUNDED';
                            // Ledger-first list profit: matches the inspector,
                            // KPI cards and exports (never the ±1 DA blended
                            // rounding or a stale stored row). Legacy rows
                            // without any frozen basis keep stored profit.
                            const basisList = displayCostBasisFor(t);
                            const listProfit =
                              basisList !== undefined ? Number(t.total ?? 0) - basisList : t.profit;

                            return (
                              <tr
                                key={t.id}
                                className={`transition group ${
                                  isVoided
                                    ? 'bg-red-500/5 opacity-70 line-through'
                                    : isRefund
                                    ? 'bg-purple-500/5'
                                    : 'hover:bg-pos-hover/60'
                                }`}
                              >
                                <td className="p-3 font-mono font-black">
                                  <span
                                    className={
                                      isVoided
                                        ? 'text-red-400'
                                        : isRefund
                                        ? 'text-purple-400'
                                        : 'text-emerald-400'
                                    }
                                  >
                                    {t.receiptNumber}
                                  </span>
                                </td>
                                <td className="p-3 no-underline">
                                  {isVoided ? (
                                    <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
                                      ANNULÉ (VOID)
                                    </span>
                                  ) : isRefund ? (
                                    <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30">
                                      AVOIR ÉMIS
                                    </span>
                                  ) : isRefunded ? (
                                    <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                      REMBOURSÉ
                                    </span>
                                  ) : isPartiallyRefunded ? (
                                    <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
                                      PARTIEL REMB.
                                    </span>
                                  ) : (
                                    <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                      VALIDÉ
                                    </span>
                                  )}
                                </td>
                                <td className="p-3 font-semibold text-pos-text">
                                  {t.customer?.name || 'Client de passage'}
                                </td>
                                <td className="p-3 text-pos-muted font-medium">
                                  <span className="bg-pos-bg border border-pos-border px-2 py-0.5 rounded text-[10px] font-bold text-pos-text">
                                    {(t.items || []).reduce((acc, i) => acc + i.quantity, 0)} articles
                                  </span>
                                </td>
                                <td
                                  className={`p-3 text-right font-black ${
                                    isVoided
                                      ? 'text-red-400'
                                      : isRefund
                                      ? 'text-purple-400'
                                      : 'text-emerald-400'
                                  }`}
                                >
                                  {isRefund ? `-${formatDZD(t.total)}` : formatDZD(t.total)}
                                </td>
                                <td className="p-3 text-right font-bold text-emerald-400">
                                  {isVoided || isRefund ? '0 DA' : formatDZD(listProfit)}
                                </td>
                                <td className="p-3 text-center">
                                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-pos-bg text-pos-text border border-pos-border">
                                    {t.paymentMethod}
                                  </span>
                                </td>
                                <td className="p-3 text-right text-pos-muted text-[11px] font-mono">{formatDateTime(t.createdAt)}</td>
                                <td className="p-3 text-center">
                                  <div className="flex items-center justify-center gap-1.5">
                                    <button
                                      onClick={() => setInspectingTransaction(t)}
                                      className="min-h-[44px] min-w-[44px] p-1.5 rounded-lg bg-pos-bg hover:bg-emerald-500/20 text-pos-muted hover:text-emerald-400 border border-pos-border transition cursor-pointer flex items-center justify-center"
                                      title="Inspecter le ticket, rembourser ou annuler"
                                      aria-label={`Inspecter le ticket ${t.receiptNumber}`}
                                    >
                                      <Eye className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination Controls — pinned shrink-0 footer */}
                  {filteredTransactions.length > PAGE_SIZE && (
                    <div className="sticky bottom-0 z-10 shrink-0 flex items-center justify-between px-4 py-2.5 bg-pos-card/95 backdrop-blur-md border border-pos-border rounded-lg text-xs font-bold text-pos-text shadow-sm">
                      <span className="text-pos-muted text-[11px]">
                        Affichage {((safeCurrentPage - 1) * PAGE_SIZE) + 1} à {Math.min(safeCurrentPage * PAGE_SIZE, filteredTransactions.length)} sur {filteredTransactions.length} transactions
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={safeCurrentPage <= 1}
                          onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                          className="px-2.5 py-1.5 min-h-[44px] rounded-lg bg-pos-bg hover:bg-pos-hover disabled:opacity-40 disabled:cursor-not-allowed border border-pos-border text-pos-text transition flex items-center gap-1 cursor-pointer"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                          <span>Précédent</span>
                        </button>
                        <span className="px-2 font-mono text-[11px] text-pos-muted">
                          Page <strong className="text-pos-text">{safeCurrentPage}</strong> / {totalPages}
                        </span>
                        <button
                          type="button"
                          disabled={safeCurrentPage >= totalPages}
                          onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                          className="px-2.5 py-1.5 min-h-[44px] rounded-lg bg-pos-bg hover:bg-pos-hover disabled:opacity-40 disabled:cursor-not-allowed border border-pos-border text-pos-text transition flex items-center gap-1 cursor-pointer"
                        >
                          <span>Suivant</span>
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ═══════════════════════════════════════════════════ */}
              {/* TAB: STORE OPERATING EXPENSES & TRUE EBITDA PROFIT */}
              {/* ═══════════════════════════════════════════════════ */}
              {activeTab === 'expenses' && (
                <div className="space-y-5 animate-in fade-in">
                  {/* Executive EBITDA Summary Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-pos-card border border-pos-border p-3.5 rounded-xl">
                      <span className="text-[9px] text-pos-muted uppercase font-bold block">CA Net Réalisé</span>
                      <p className="text-lg font-black text-pos-text font-mono mt-1">{formatDZD(totalRevenue)}</p>
                      <span className="text-[9.5px] text-pos-muted">Après remises & retours</span>
                    </div>

                    <div className="bg-pos-card border border-pos-border p-3.5 rounded-xl">
                      <span className="text-[9px] text-pos-muted uppercase font-bold block">Marge Commerciale Brute</span>
                      <p className="text-lg font-black text-cyan-400 font-mono mt-1">{formatDZD(totalNetProfit)}</p>
                      <span className="text-[9.5px] text-pos-muted">CA Net − Coût Marchandises</span>
                    </div>

                    <div className="bg-gradient-to-br from-red-950/40 to-amber-950/40 border border-red-500/40 p-3.5 rounded-xl">
                      <span className="text-[9px] text-red-300 uppercase font-bold block">Total Dépenses d'Exploitation</span>
                      <p className="text-lg font-black text-red-400 font-mono mt-1">−{formatDZD(totalOperatingExpenses)}</p>
                      <span className="text-[9.5px] text-red-200/70">{dateFilteredExpenses.length} charge{dateFilteredExpenses.length > 1 ? 's' : ''} enregistrée{dateFilteredExpenses.length > 1 ? 's' : ''}</span>
                    </div>

                    <div className="bg-gradient-to-br from-emerald-950/60 to-teal-950/60 border-2 border-emerald-500 p-3.5 rounded-xl shadow-lg shadow-emerald-950/50">
                      <div className="flex justify-between items-start">
                        <div>
                          <span className="text-[9px] text-emerald-300 uppercase font-extrabold block">Bénéfice Net Réel (EBITDA)</span>
                          <p className="text-xl font-black text-emerald-400 font-mono mt-0.5">{formatDZD(trueEbitdaNetProfit)}</p>
                        </div>
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono text-[10px] font-black border border-emerald-500/30">
                          {ebitdaMargin}%
                        </span>
                      </div>
                      <span className="text-[9.5px] text-emerald-200/80 mt-1 block">Gain net réel en poche de la boutique</span>
                    </div>
                  </div>

                  {/* Actions & Filters Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 bg-pos-card border border-pos-border p-3 rounded-xl">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-bold uppercase text-pos-muted mr-1">Catégorie :</span>
                      {['Tous', 'Loyer', 'Salaires / Avances', 'Électricité / Eau', 'Repas / Pause', 'Emballages / Sachets', 'Transport / Livraison', 'Internet / Téléphonie', 'Maintenance / Travaux', 'Perte Stock / SAV', 'Autre Charge'].map((cat) => (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => setExpenseCategoryFilter(cat)}
                          className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition cursor-pointer ${
                            expenseCategoryFilter === cat
                              ? 'bg-amber-500 text-slate-950 font-black shadow-sm'
                              : 'bg-pos-bg text-pos-muted hover:text-pos-text border border-pos-border'
                          }`}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => setShowNewExpenseModal(true)}
                      className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-xs font-black flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition cursor-pointer"
                    >
                      <Plus className="w-4 h-4" /> Enregistrer une Dépense
                    </button>
                  </div>

                  {/* Expenses List Table */}
                  <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-pos-text flex items-center justify-between">
                      <span>Détail des Frais & Dépenses ({dateFilteredExpenses.length})</span>
                      <span className="text-amber-400 font-mono">Total : {formatDZD(totalOperatingExpenses)}</span>
                    </h3>

                    {dateFilteredExpenses.length === 0 ? (
                      <div className="text-center py-8 space-y-1.5">
                        <DollarSign className="w-10 h-10 text-pos-muted/40 mx-auto" />
                        <p className="text-xs font-bold text-pos-muted">Aucune charge d'exploitation enregistrée sur cette période.</p>
                        <p className="text-[11px] text-pos-muted/60">Cliquez sur "+ Enregistrer une Dépense" pour saisir un loyer, repas, emballage, etc.</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto max-h-72 overflow-y-auto">
                        <table className="w-full text-left text-xs border-collapse">
                          <thead>
                            <tr className="border-b border-pos-border text-[10px] text-pos-muted uppercase font-bold">
                              <th className="py-2.5 px-3">Date</th>
                              <th className="py-2.5 px-3">Catégorie</th>
                              <th className="py-2.5 px-3">Motif / Titre</th>
                              <th className="py-2.5 px-3">Bénéficiaire</th>
                              <th className="py-2.5 px-3">Mode</th>
                              <th className="py-2.5 px-3">Enregistré Par</th>
                              <th className="py-2.5 px-3 text-right">Montant</th>
                              <th className="py-2.5 px-3 text-center">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-pos-border/40 font-mono">
                            {(dateFilteredExpenses || [])
                              .filter((e) => expenseCategoryFilter === 'Tous' || e.category === expenseCategoryFilter)
                              .map((exp) => (
                                <tr key={exp.id} className="hover:bg-pos-bg/50 transition">
                                  <td className="py-2.5 px-3 text-pos-muted text-[11px] font-sans">
                                    {new Date(exp.createdAt).toLocaleDateString('fr-DZ', {
                                      day: '2-digit',
                                      month: '2-digit',
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })}
                                  </td>
                                  <td className="py-2.5 px-3 font-sans">
                                    <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold">
                                      {exp.category}
                                    </span>
                                  </td>
                                  <td className="py-2.5 px-3 font-bold font-sans text-pos-text">{exp.title}</td>
                                  <td className="py-2.5 px-3 text-pos-muted font-sans">{exp.paidTo || '—'}</td>
                                  <td className="py-2.5 px-3 text-pos-muted font-sans text-[11px]">{exp.paymentMethod}</td>
                                  <td className="py-2.5 px-3 text-pos-muted font-sans text-[11px]">{exp.recordedBy}</td>
                                  <td className="py-2.5 px-3 text-right font-black text-red-400 font-mono">
                                    −{formatDZD(exp.amount)}
                                  </td>
                                  <td className="py-2.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (window.confirm(`Supprimer cette dépense "${exp.title}" (${formatDZD(exp.amount)}) ?`)) {
                                          deleteStoreExpense(exp.id);
                                          showToast('Dépense supprimée', 'info');
                                        }
                                      }}
                                      className="p-1 hover:bg-red-500/20 text-pos-muted hover:text-red-400 rounded transition cursor-pointer"
                                      title="Supprimer la dépense"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ═══════════════════════════════════════════════════ */}
              {/* TAB 3: ENTERPRISE EXCEL & ACCOUNTING EXPORT SUITE   */}
              {/* ═══════════════════════════════════════════════════ */}
              {activeTab === 'export' && (
                <div className="space-y-5">
                  
                  {exportSuccess && (
                    <div className="bg-emerald-500 text-slate-950 px-5 py-3 rounded-2xl font-black text-xs shadow-xl animate-in fade-in flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-5 h-5" />
                        <span>{exportSuccess}</span>
                      </div>
                      <span className="text-[10px] uppercase font-mono bg-slate-950/20 px-2 py-0.5 rounded">
                        Téléchargement Déclenché
                      </span>
                    </div>
                  )}

                  {copySuccess && (
                    <div className="bg-cyan-500 text-slate-950 px-5 py-3 rounded-2xl font-black text-xs shadow-xl animate-in fade-in flex items-center gap-2">
                      <CheckCircle2 className="w-5 h-5" />
                      <span>Données tabulaires copiées dans le presse-papier ! Prêt pour Ctrl+V dans Excel.</span>
                    </div>
                  )}

                  {/* Main Export Hero Card */}
                  <div className="bg-gradient-to-br from-emerald-950/40 via-pos-card to-pos-card border border-emerald-500/30 rounded-2xl p-5 space-y-4 shadow-lg">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-lg">
                          <FileSpreadsheet className="w-6 h-6" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-base font-black text-pos-text">
                              Générateur de Fichiers Excel Professionnels Multi-Feuilles
                            </h3>
                            <span className="text-[9px] bg-emerald-500/20 text-emerald-300 font-bold px-2 py-0.5 rounded border border-emerald-500/40">
                              FORMAT MS EXCEL XML STYLISÉ
                            </span>
                          </div>
                          <p className="text-xs text-pos-muted mt-0.5">
                            Génère un classeur Excel complet avec colonnes ajustées, codes couleurs, marges, totaux généraux et détail article par article.
                          </p>
                        </div>
                      </div>

                      {/* Primary Excel Download Button */}
                      <button
                        type="button"
                        onClick={handleExportExcelFormatted}
                        className="px-6 py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs flex items-center gap-2.5 shadow-xl shadow-emerald-500/25 transition cursor-pointer"
                      >
                        <FileSpreadsheet className="w-5 h-5" />
                        <span>Télécharger Fichier Excel (.XLS Multi-Feuilles)</span>
                      </button>
                    </div>

                    {/* Features included in Excel */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-pos-border/60 text-xs">
                      <div className="flex items-center gap-2 text-pos-muted">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>Feuille 1 : Journal des Ventes & Totaux</span>
                      </div>
                      <div className="flex items-center gap-2 text-pos-muted">
                        <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                        <span>Feuille 2 : Détail des Lignes & Articles</span>
                      </div>
                      <div className="flex items-center gap-2 text-pos-muted">
                        <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                        <span>Feuille 3 : Synthèse Règlements & CA</span>
                      </div>
                    </div>
                  </div>

                  {/* Secondary Export Options Toolbar */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-4 bg-pos-card border border-pos-border rounded-xl flex items-center justify-between gap-3">
                      <div>
                        <span className="text-xs font-bold text-pos-text block">Export CSV Standard (UTF-8 avec BOM)</span>
                        <span className="text-[10px] text-pos-muted">Idéal pour les logiciels de comptabilité tiers</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleExportCSV}
                        className="px-4 py-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text font-bold text-xs rounded-xl flex items-center gap-1.5 transition cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5 text-emerald-400" /> Export CSV
                      </button>
                    </div>

                    <div className="p-4 bg-pos-card border border-pos-border rounded-xl flex items-center justify-between gap-3">
                      <div>
                        <span className="text-xs font-bold text-pos-text block">Copier le Tableau (Presse-Papier)</span>
                        <span className="text-[10px] text-pos-muted">Collez directement les colonnes dans un classeur ouvert</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleCopyToClipboard}
                        className="px-4 py-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text font-bold text-xs rounded-xl flex items-center gap-1.5 transition cursor-pointer"
                      >
                        <Copy className="w-3.5 h-3.5 text-cyan-400" /> Copier Données
                      </button>
                    </div>
                  </div>

                  {/* Live Excel Table Preview */}
                  <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <Layers className="w-4 h-4 text-emerald-400" />
                        <span className="text-xs font-black uppercase text-pos-text">
                          Aperçu en Direct du Classeur Excel ({dateFilteredTransactions.length} Transactions sélectionnées)
                        </span>
                      </div>
                      <span className="text-[10px] text-pos-muted font-mono">
                        Total Période : <span className="font-bold text-emerald-400">{formatDZD(totalRevenue)}</span>
                      </span>
                    </div>

                    <div className="border border-pos-border rounded-xl overflow-hidden max-h-64 overflow-y-auto">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="bg-emerald-950/60 text-emerald-200 text-[10px] uppercase font-bold border-b border-emerald-500/30 sticky top-0 backdrop-blur-sm">
                          <tr>
                            <th className="p-2.5">N° Reçu</th>
                            <th className="p-2.5">Date & Heure</th>
                            <th className="p-2.5">Client</th>
                            <th className="p-2.5 text-center">Qté</th>
                            <th className="p-2.5 text-right">Total Net (DA)</th>
                            <th className="p-2.5 text-right">Bénéfice (DA)</th>
                            <th className="p-2.5 text-center">Paiement</th>
                            <th className="p-2.5 text-center">Statut</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-pos-border/40 font-medium">
                          {(dateFilteredTransactions || []).slice(0, 15).map((t, idx) => {
                            const isVoided = t.status === 'VOIDED';
                            const isRefund = Boolean(t.isRefund);
                            const basisRecent = displayCostBasisFor(t);
                            const recentProfit =
                              basisRecent !== undefined ? Number(t.total ?? 0) - basisRecent : t.profit;
                            return (
                              <tr
                                key={t.id}
                                className={`text-[11px] ${
                                  isVoided
                                    ? 'bg-red-500/10 text-red-300 line-through'
                                    : isRefund
                                    ? 'bg-purple-500/10 text-purple-300'
                                    : idx % 2 === 1
                                    ? 'bg-pos-bg/60'
                                    : 'bg-pos-card'
                                }`}
                              >
                                <td className="p-2.5 font-mono font-bold">{t.receiptNumber}</td>
                                <td className="p-2.5 font-mono text-pos-muted">{formatDateTime(t.createdAt)}</td>
                                <td className="p-2.5">{t.customer?.name || 'Client de passage'}</td>
                                <td className="p-2.5 text-center">{(t.items || []).reduce((acc, i) => acc + i.quantity, 0)}</td>
                                <td className="p-2.5 text-right font-black text-pos-text">
                                  {isRefund ? `-${formatDZD(t.total)}` : formatDZD(t.total)}
                                </td>
                                <td className="p-2.5 text-right font-bold text-emerald-400">
                                  {isVoided || isRefund ? '0 DA' : formatDZD(recentProfit)}
                                </td>
                                <td className="p-2.5 text-center">{t.paymentMethod}</td>
                                <td className="p-2.5 text-center">
                                  <span
                                    className={`px-2 py-0.5 rounded text-[9px] font-black ${
                                      isVoided
                                        ? 'bg-red-500/20 text-red-400'
                                        : isRefund
                                        ? 'bg-purple-500/20 text-purple-300'
                                        : 'bg-emerald-500/20 text-emerald-400'
                                    }`}
                                  >
                                    {isVoided ? 'ANNULÉ' : isRefund ? 'AVOIR' : 'VALIDÉ'}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                </div>
              )}

            </div>
          </div>
        )}

        {/* Footer */}
        <div className="p-3.5 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
          <span>Rapports Financiers & Performance Commerciale • Mobi-POS Enterprise</span>
          <button
            onClick={() => {
              setPinVerified(false);
              setPinInput('');
              closeModal();
            }}
            className="px-5 py-2 min-h-[44px] rounded-lg bg-pos-hover text-pos-text font-bold hover:bg-pos-border transition cursor-pointer"
          >
            Fermer
          </button>
        </div>

        {/* Transaction Inspector Dialog Overlay */}
        {inspectingTransaction && (
          <div className="absolute inset-0 bg-black/85 backdrop-blur-md z-30 flex items-center justify-center p-6 animate-in fade-in">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
              
              {/* Inspector Header */}
              <div className="p-4 border-b border-pos-border bg-pos-card flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <ShoppingBag className="w-5 h-5 text-emerald-400" />
                  <div>
                    <h3 className="text-sm font-black text-pos-text">
                      Inspection Reçu #{inspectingTransaction.receiptNumber}
                    </h3>
                    <p className="text-[10px] text-pos-muted">
                      {formatDateTime(inspectingTransaction.createdAt)} • Caissier: {inspectingTransaction.cashierName || 'Yacine (Caisse 1)'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setInspectingTransaction(null);
                    setIsVoiding(false);
                  }}
                  className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Inspector Content */}
              <div className="p-5 overflow-y-auto space-y-4 text-xs flex-1 bg-pos-bg">
                
                {/* Status Alert Banner */}
                {inspectingTransaction.status === 'VOIDED' && (
                  <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 flex items-start gap-2">
                    <Ban className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold">Ce ticket a été annulé (Voided).</p>
                      <p className="text-[11px] text-red-300/80 mt-0.5">
                        Motif : {inspectingTransaction.voidReason || 'Erreur de saisie'}
                      </p>
                    </div>
                  </div>
                )}

                {/* Items List */}
                <div className="space-y-2">
                  <span className="text-[10px] uppercase font-bold text-pos-muted block">Articles du Ticket :</span>
                  <div className="bg-pos-card border border-pos-border rounded-xl overflow-hidden divide-y divide-pos-border">
                    {(inspectingTransaction?.items || []).map((item, idx) => {
                      const itemPrice = item.unitPriceCharged || item.appliedPrice || item.product?.price || 0;
                      const defaultPrice = item.defaultPrice || item.product?.price || 0;
                      // STRICT LEDGER: frozen line cost wins; when the line
                      // carries none but the ticket has ledger rows, split the
                      // frozen COGS pro-rata instead of pricing the live
                      // catalog cost (which printed 6,200 for a 6,100 ticket).
                      // Materialized receipts never touch costPrice at all —
                      // a missing line cost there falls back to the
                      // pro-rata share (exact in aggregate) or 0, never the
                      // catalog estimate. While the ledger is still
                      // resolving, lines without a frozen cost render pending
                      // — never the stale 6,200 flash from the stored row.
                      const lineCostPending =
                        item.unitCostAtSale === undefined &&
                        inspectorLedgerAvgUnit === undefined &&
                        !inspectorLedgerLoaded;
                      const unitCost =
                        item.unitCostAtSale ??
                        inspectorLedgerAvgUnit ??
                        (isMaterializedReceipt ? 0 : item.product?.costPrice ?? 0);
                      const lineProfit = lineCostPending
                        ? null
                        : (item.unitCostAtSale !== undefined || inspectorLedgerAvgUnit !== undefined)
                        ? (itemPrice - unitCost) * item.quantity
                        : item.lineProfit !== undefined
                        ? item.lineProfit
                        : (itemPrice - unitCost) * item.quantity;
                      const lineTotal = itemPrice * item.quantity;
                      const discountAmount = item.discountAmount ?? (defaultPrice > itemPrice ? defaultPrice - itemPrice : 0);
                      const marginText =
                        lineProfit === null
                          ? '…'
                          : `${formatDZD(lineProfit)} (${lineTotal > 0 ? ((lineProfit / lineTotal) * 100).toFixed(1) : '0'}%)`;

                      return (
                        <div key={idx} className="p-3 flex justify-between items-center text-xs hover:bg-pos-hover/30 transition">
                          <div className="space-y-1">
                            <p className="font-bold text-pos-text">{item.product?.title || 'Article'}</p>
                            <div className="flex flex-wrap items-center gap-2 text-[10px] text-pos-muted font-mono">
                              <span>SKU: {item.product?.sku || 'N/A'}</span>
                              <span>•</span>
                              <span>{item.quantity} x {formatDZD(itemPrice)}</span>
                              {defaultPrice !== itemPrice && (
                                <span className="line-through text-pos-muted/60">{formatDZD(defaultPrice)}</span>
                              )}
                              {unitCost > 0 && !lineCostPending && (
                                <>
                                  <span>•</span>
                                  <span className="text-pos-muted">Coût FIFO: {formatDZD(unitCost)}/u</span>
                                </>
                              )}
                              {lineCostPending && (
                                <>
                                  <span>•</span>
                                  <span className="text-pos-muted">Coût FIFO: …</span>
                                </>
                              )}
                              {discountAmount > 0 && (
                                <span className="text-amber-400 font-semibold">
                                  (Remise: -{formatDZD(discountAmount)}/u)
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <span className="font-black text-pos-text block">{formatDZD(lineTotal)}</span>
                            <span className={`text-[10px] font-bold font-mono ${lineProfit === null ? 'text-pos-muted' : lineProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                              Marge: {marginText}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Totals Breakdown */}
                <div className="bg-pos-card border border-pos-border p-3 rounded-xl space-y-1.5 text-xs">
                  <div className="flex justify-between text-pos-muted">
                    <span>Sous-Total Brut :</span>
                    <span className="font-bold text-pos-text">{formatDZD(inspectingTransaction.subtotal || inspectingTransaction.total)}</span>
                  </div>
                  {(inspectingTransaction.discountTotal || 0) > 0 && (
                    <div className="flex justify-between text-purple-400">
                      <span>Remise Appliquée :</span>
                      <span>-{formatDZD(inspectingTransaction.discountTotal || 0)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-black text-emerald-400 pt-1 border-t border-pos-border">
                    <span>Total Net Payé :</span>
                    <span>{formatDZD(inspectingTransaction.total)}</span>
                  </div>
                  {inspectingTransaction.status !== 'VOIDED' && !inspectingTransaction.isRefund && (
                    <div className="flex justify-between text-xs font-bold text-cyan-400 pt-1 border-t border-dashed border-pos-border">
                      <span>Marge Commerciale Nette (FIFO) :</span>
                      <span className="font-mono">
                        {!inspectorLedgerLoaded
                          ? '…'
                          : formatDZD(
                              inspectorLedgerCogs != null
                                ? Math.max(0, Number(inspectingTransaction.total ?? 0)) -
                                  (isExchangeSale(inspectingTransaction) &&
                                  Number.isFinite(Number(inspectingTransaction.costTotal))
                                    ? Math.round(Number(inspectingTransaction.costTotal))
                                    : inspectorLedgerCogs)
                                : inspectingTransaction.profit !== undefined
                                ? inspectingTransaction.profit
                                : (inspectingTransaction.items || []).reduce((acc, it) => {
                                    const uCost = it.unitCostAtSale ?? (isMaterializedReceipt ? 0 : it.product?.costPrice ?? 0);
                                    const uCharged = it.unitPriceCharged ?? it.appliedPrice ?? it.product?.price ?? 0;
                                    return acc + (it.lineProfit ?? ((uCharged - uCost) * it.quantity));
                                  }, 0)
                            )}
                      </span>
                    </div>
                  )}
                  {inspectingTransaction.status !== 'VOIDED' && !inspectingTransaction.isRefund && inspectorLedgerLoaded && inspectorLedgerCogs != null && (
                    <div className="flex justify-between text-[11px] text-pos-muted">
                      <span>
                        {isExchangeSale(inspectingTransaction) &&
                        Number.isFinite(Number(inspectingTransaction.costTotal))
                          ? "Coût d'Achat Net (Échange) :"
                          : "Coût d'Achat (Ledger FIFO) :"}
                      </span>
                      <span className="font-mono">
                        {formatDZD(
                          isExchangeSale(inspectingTransaction) &&
                            Number.isFinite(Number(inspectingTransaction.costTotal))
                            ? Math.round(Number(inspectingTransaction.costTotal))
                            : inspectorLedgerCogs
                        )}
                      </span>
                    </div>
                  )}
                </div>

                {/* Voiding Form */}
                {isVoiding && (
                  <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl space-y-3 animate-in fade-in">
                    <div className="flex items-center gap-2 text-red-400 font-bold text-xs">
                      <AlertTriangle className="w-4 h-4" />
                      <span>Confirmation d'Annulation de Ticket (Manager PIN requis)</span>
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-pos-muted block mb-1">Motif de l'annulation :</label>
                      <input
                        type="text"
                        value={voidReason}
                        onChange={(e) => setVoidReason(e.target.value)}
                        className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-1.5 text-xs text-pos-text focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-pos-muted block mb-1">PIN Manager :</label>
                      <input
                        type="password"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        autoComplete="current-password"
                        placeholder="Code PIN Manager"
                        value={voidPin}
                        onChange={(e) => setVoidPin(e.target.value)}
                        className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-1.5 text-xs text-pos-text focus:outline-none"
                      />
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => setIsVoiding(false)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold text-pos-muted hover:text-pos-text"
                      >
                        Annuler
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConfirmVoid(inspectingTransaction)}
                        disabled={isVoidSubmitting}
                        className="px-4 py-1.5 bg-red-500 hover:bg-red-400 text-slate-950 font-black text-xs rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isVoidSubmitting ? 'Annulation en cours…' : "Confirmer l'Annulation (Restaurer Stocks)"}
                      </button>
                    </div>
                  </div>
                )}

              </div>

              {/* Inspector Footer Actions */}
              <div className="p-4 border-t border-pos-border bg-pos-card flex justify-between items-center">
                <div className="flex gap-2">
                  {inspectingTransaction.status !== 'VOIDED' && !isVoiding && (
                    <>
                      <button
                        type="button"
                        onClick={() => setIsVoiding(true)}
                        className="px-3 py-1.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-bold flex items-center gap-1.5 border border-red-500/30 transition cursor-pointer"
                      >
                        <Ban className="w-3.5 h-3.5" /> Annuler Vente (Erreur)
                      </button>

                      <button
                        type="button"
                        onClick={() => handleLaunchRefundFromInspector(inspectingTransaction)}
                        className="px-3 py-1.5 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 text-xs font-bold flex items-center gap-1.5 border border-purple-500/30 transition cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> Rembourser / Bon d'Avoir
                      </button>
                    </>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setInspectingTransaction(null);
                      setIsVoiding(false);
                    }}
                    className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text"
                  >
                    Fermer
                  </button>
                  <button
                    type="button"
                    onClick={() => handleReprintFromInspector(inspectingTransaction)}
                    className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition cursor-pointer"
                  >
                    <Printer className="w-4 h-4" /> Réimprimer Reçu
                  </button>
                </div>
              </div>

            </div>
          </div>
        )}

        {/* ═══ New Expense Modal Dialog ═══ */}
        {showNewExpenseModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl animate-in zoom-in-95 max-h-[90dvh] overflow-y-auto overscroll-contain">
              <div className="flex items-center justify-between border-b border-pos-border pb-3">
                <div className="flex items-center gap-2 text-amber-400">
                  <DollarSign className="w-5 h-5" />
                  <h3 className="text-sm font-black text-pos-text">Enregistrer une Charge d'Exploitation</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowNewExpenseModal(false)}
                  className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleAddExpenseSubmit} className="space-y-3.5">
                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Catégorie de Dépense *
                  </label>
                  <select
                    value={expenseCategory}
                    onChange={(e) => setExpenseCategory(e.target.value as ExpenseCategory)}
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:outline-none focus:border-amber-400"
                  >
                    {[
                      'Loyer',
                      'Électricité / Eau',
                      'Salaires / Avances',
                      'Repas / Pause',
                      'Emballages / Sachets',
                      'Transport / Livraison',
                      'Internet / Téléphonie',
                      'Maintenance / Travaux',
                      'Perte Stock / SAV',
                      'Autre Charge',
                    ].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Motif / Description de la Charge *
                  </label>
                  <input
                    type="text"
                    required
                    value={expenseTitle}
                    onChange={(e) => setExpenseTitle(e.target.value)}
                    placeholder="Ex: Facture Sonelgaz 2ème Trimestre"
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:outline-none focus:border-amber-400"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                      Montant (DA) *
                    </label>
                    <input
                      type="number"
                      required
                      min="1"
                      value={expenseAmount}
                      onChange={(e) => setExpenseAmount(e.target.value)}
                      placeholder="4500"
                      className="w-full bg-pos-bg border-2 border-pos-border focus:border-amber-400 rounded-xl px-3 py-2 text-base font-black font-mono text-pos-text focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                      Mode de Paiement
                    </label>
                    <select
                      value={expensePaymentMethod}
                      onChange={(e) => setExpensePaymentMethod(e.target.value as PaymentMethodType)}
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:outline-none"
                    >
                      {['Espèces', 'Autre'].map((m) => (
                        <option key={m} value={m}>
                          {m === 'Espèces' ? 'Espèces (Tiroir-Caisse)' : m}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Payé à / Bénéficiaire (Facultatif)
                  </label>
                  <input
                    type="text"
                    value={expensePaidTo}
                    onChange={(e) => setExpensePaidTo(e.target.value)}
                    placeholder="Ex: Propriétaire local, Sonelgaz, etc."
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:outline-none focus:border-amber-400"
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Remarque (Facultatif)
                  </label>
                  <input
                    type="text"
                    value={expenseNotes}
                    onChange={(e) => setExpenseNotes(e.target.value)}
                    placeholder="Ex: Reçu N° 4589"
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:outline-none focus:border-amber-400"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-pos-border">
                  <button
                    type="button"
                    onClick={() => setShowNewExpenseModal(false)}
                    className="px-4 py-2 bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl text-xs font-bold"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-xl shadow-lg shadow-emerald-500/20 transition cursor-pointer flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="w-4 h-4" /> Enregistrer la Charge
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

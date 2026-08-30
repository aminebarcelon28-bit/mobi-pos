import React, { useState, useMemo } from 'react';
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
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { SaleTransaction } from '../../types/pos';
import { SalesAnalyticsCharts } from '../reports/SalesAnalyticsCharts';
import { useToast } from '../ui/Toast';
import { generateProfessionalExcelXml } from '../../utils/excelExporter';

export const ReportsModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    openModal,
    transactions,
    verifyManagerPin,
    logSecurityAction,
    reprintReceipt,
    voidTransaction,
    setSelectedTransactionForRefund,
  } = usePosStore();

  const { showToast } = useToast();

  const [pinVerified, setPinVerified] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [activeTab, setActiveTab] = useState<'analytics' | 'history' | 'export'>('history');

  // Transaction Inspector State
  const [inspectingTransaction, setInspectingTransaction] = useState<SaleTransaction | null>(null);
  const [isVoiding, setIsVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState('Erreur de caisse / Article erroné');
  const [voidPin, setVoidPin] = useState('');

  // Search & Filter State in History & Export Tabs
  const [historySearch, setHistorySearch] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('Tous');
  const [statusFilter, setStatusFilter] = useState('Tous');
  const [dateRangeFilter, setDateRangeFilter] = useState<'all' | 'today' | '7days' | '30days'>('all');

  // Export Tab State
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);

  if (activeModal !== 'reports') return null;

  const handleVerifyPin = (e: React.FormEvent) => {
    e.preventDefault();
    if (verifyManagerPin(pinInput)) {
      setPinVerified(true);
      logSecurityAction(
        'Accès Rapports Financiers Autorisé',
        'Consultation des rapports par PIN Administrateur',
        'Yacine (Admin)',
        true
      );
    } else {
      showToast('PIN Administrateur incorrect ! Accès refusé.', 'error');
      logSecurityAction('Tentative Accès Rapports Échouée', 'PIN incorrect saisi', 'Caissier', true);
    }
  };

  // Date Filtering Helper
  const filterByDateRange = (list: SaleTransaction[]) => {
    if (dateRangeFilter === 'all') return list;
    const now = new Date();

    return list.filter((t) => {
      const txDate = new Date(t.createdAt);
      if (isNaN(txDate.getTime())) return true; // Keep if date string format is non-ISO

      if (dateRangeFilter === 'today') {
        return txDate.toDateString() === now.toDateString();
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
  };

  // Financial KPI Metrics (excludes voided transactions and accounts for refunds)
  const safeTransactions = transactions || [];
  const dateFilteredTransactions = useMemo(() => filterByDateRange(safeTransactions), [safeTransactions, dateRangeFilter]);

  const validSales = dateFilteredTransactions.filter((t) => t.status !== 'VOIDED' && !t.isRefund);
  const totalGrossRevenue = validSales.reduce((acc, t) => acc + t.total, 0);
  const totalRefundsValue = dateFilteredTransactions.filter((t) => t.isRefund).reduce((acc, t) => acc + t.total, 0);
  const totalRevenue = Math.max(0, totalGrossRevenue - totalRefundsValue);
  const totalCost = validSales.reduce((acc, t) => acc + (t.costTotal || t.total * 0.5), 0);
  const totalNetProfit = totalRevenue - totalCost;
  const netProfitMargin = totalRevenue > 0 ? ((totalNetProfit / totalRevenue) * 100).toFixed(1) : '0';
  const averageBasket = validSales.length > 0 ? totalGrossRevenue / validSales.length : 0;

  // Filtered Transactions for History List
  const filteredTransactions = dateFilteredTransactions.filter((t) => {
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
    if (!verifyManagerPin(voidPin)) {
      showToast('PIN Manager incorrect ! Autorisation requise pour annuler une vente.', 'error');
      return;
    }

    const res = await voidTransaction(t.id, voidReason, 'Manager');
    if (res.success) {
      showToast(`Vente #${t.receiptNumber} annulée avec succès. Stocks et fidélité restaurés.`, 'success');
      setInspectingTransaction(null);
      setIsVoiding(false);
      setVoidPin('');
    } else {
      showToast(`Erreur lors de l'annulation: ${res.reason}`, 'error');
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

    const xmlContent = generateProfessionalExcelXml(dateFilteredTransactions, periodLabel);
    const blob = new Blob([xmlContent], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute(
      'download',
      `MOBI_POS_RAPPORT_EXCEL_PRO_${new Date().toISOString().slice(0, 10)}.xls`
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

    const rows = dateFilteredTransactions
      .map((t) => {
        const customerName = (t.customer?.name || 'Client de passage').replace(/;/g, ' ');
        const dateStr = (t.createdAt || '').replace(/;/g, ' ');
        const payment = (t.paymentMethod || 'Espèces').replace(/;/g, ' ');
        const itemCount = t.items.reduce((acc, i) => acc + i.quantity, 0);
        const subtotal = t.subtotal || t.total;
        const discount = t.discountTotal || 0;
        const cost = t.status === 'VOIDED' ? 0 : t.costTotal || 0;
        const netTotal = t.status === 'VOIDED' ? 0 : t.isRefund ? -t.total : t.total;
        const profit = t.status === 'VOIDED' || t.isRefund ? 0 : t.profit || netTotal - cost;
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
      `MOBI_POS_EXPORT_CSV_${new Date().toISOString().slice(0, 10)}.csv`
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
    const rows = dateFilteredTransactions
      .map((t) => {
        const customerName = t.customer?.name || 'Client de passage';
        const itemCount = t.items.reduce((acc, i) => acc + i.quantity, 0);
        return `${t.receiptNumber}\t${t.createdAt}\t${customerName}\t${itemCount}\t${t.total}\t${t.profit || 0}\t${t.paymentMethod}\t${t.status}`;
      })
      .join('\n');

    navigator.clipboard.writeText(headers + rows).then(() => {
      setCopySuccess(true);
      showToast('Données tabulaires copiées ! Vous pouvez les coller (Ctrl+V) dans Excel.', 'success');
      setTimeout(() => setCopySuccess(false), 3000);
    });
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[90vh] flex flex-col relative">
        
        {/* Modal Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-cyan-500/20">
              <BarChart3 className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-pos-text tracking-wide">
                  RAPPORTS FINANCIERS & INSPECTEUR DE VENTES
                </h2>
                <span className="text-[10px] bg-cyan-500/10 text-cyan-400 font-black px-2 py-0.5 rounded border border-cyan-500/30 uppercase">
                  ENTERPRISE
                </span>
              </div>
              <p className="text-[11px] text-pos-muted">
                Analytics de performance, audit comptable, export Excel formaté et réimpression de reçus
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setPinVerified(false);
              setPinInput('');
              closeModal();
            }}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Security PIN Gate */}
        {!pinVerified ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/15 text-amber-400 flex items-center justify-center border border-amber-500/30 shadow-xl">
              <Lock className="w-8 h-8 stroke-[2.5]" />
            </div>
            <div>
              <h3 className="text-lg font-black text-pos-text">Accès Sécurisé par PIN Administrateur</h3>
              <p className="text-xs text-pos-muted mt-1 max-w-sm">
                Saisissez votre code PIN Manager (Par défaut : <strong>1234</strong>) pour consulter les chiffres financiers et exporter les données comptables.
              </p>
            </div>

            <form onSubmit={handleVerifyPin} className="flex gap-2 w-full max-w-xs pt-2">
              <div className="relative flex-1">
                <Key className="w-4 h-4 text-pos-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  autoFocus
                  placeholder="PIN Administrateur (1234)"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-2 text-xs font-bold text-pos-text focus:border-amber-400 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                className="px-5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs rounded-xl transition shadow-md cursor-pointer"
              >
                Déverrouiller
              </button>
            </form>
          </div>
        ) : (
          /* Unlocked Reports View */
          <div className="flex-1 flex flex-col overflow-hidden">
            
            {/* Top Navigation Tabs */}
            <div className="flex border-b border-pos-border bg-pos-card px-4 shrink-0 justify-between items-center">
              <div className="flex">
                <button
                  onClick={() => setActiveTab('history')}
                  className={`py-3 px-4 text-xs font-black border-b-2 transition-colors flex items-center gap-2 cursor-pointer ${
                    activeTab === 'history'
                      ? 'border-emerald-500 text-emerald-400'
                      : 'border-transparent text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <ShoppingBag className="w-3.5 h-3.5" />
                  Historique Transactions & Inspection ({safeTransactions.length})
                </button>

                <button
                  onClick={() => setActiveTab('analytics')}
                  className={`py-3 px-4 text-xs font-black border-b-2 transition-colors flex items-center gap-2 cursor-pointer ${
                    activeTab === 'analytics'
                      ? 'border-emerald-500 text-emerald-400'
                      : 'border-transparent text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <BarChart3 className="w-3.5 h-3.5" />
                  Vue Graphique & Performance
                </button>

                <button
                  onClick={() => setActiveTab('export')}
                  className={`py-3 px-4 text-xs font-black border-b-2 transition-colors flex items-center gap-2 cursor-pointer ${
                    activeTab === 'export'
                      ? 'border-emerald-500 text-emerald-400'
                      : 'border-transparent text-pos-muted hover:text-pos-text'
                  }`}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
                  Export Comptable & Tableaux Excel (PRO)
                </button>
              </div>

              {/* Quick Date Range Filter */}
              <div className="flex items-center gap-1.5 py-1">
                <Calendar className="w-3.5 h-3.5 text-pos-muted" />
                <span className="text-[10px] font-bold text-pos-muted uppercase mr-1">Période :</span>
                {(['all', 'today', '7days', '30days'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setDateRangeFilter(r)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition cursor-pointer ${
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
              </div>
            </div>

            {/* Scrollable Tab Content Body */}
            <div className="p-5 overflow-y-auto space-y-5 flex-1 bg-pos-bg">
              
              {activeTab === 'analytics' && <SalesAnalyticsCharts />}

              {activeTab === 'history' && (
                <div className="space-y-4">
                  
                  {/* Executive KPI Summary Bar */}
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                      <span className="text-[9px] text-pos-muted uppercase font-bold">Total Transactions</span>
                      <p className="text-base font-black text-pos-text mt-0.5">{dateFilteredTransactions.length}</p>
                    </div>

                    <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                      <span className="text-[9px] text-pos-muted uppercase font-bold">CA Brut Total</span>
                      <p className="text-base font-black text-emerald-400 mt-0.5">{formatDZD(totalRevenue)}</p>
                    </div>

                    <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                      <span className="text-[9px] text-pos-muted uppercase font-bold flex items-center gap-1">
                        <TrendingUp className="w-3 h-3 text-cyan-400" /> Bénéfice Net
                      </span>
                      <p className="text-base font-black text-cyan-400 mt-0.5">{formatDZD(totalNetProfit)}</p>
                    </div>

                    <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                      <span className="text-[9px] text-pos-muted uppercase font-bold">Panier Moyen</span>
                      <p className="text-base font-black text-amber-400 mt-0.5">{formatDZD(averageBasket)}</p>
                    </div>

                    <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                      <span className="text-[9px] text-pos-muted uppercase font-bold">Marge Nette %</span>
                      <p className="text-base font-black text-pos-text mt-0.5">{netProfitMargin}%</p>
                    </div>
                  </div>

                  {/* Search & Filter Toolbar */}
                  <div className="bg-pos-card border border-pos-border p-3 rounded-2xl flex flex-wrap items-center justify-between gap-3">
                    <div className="relative flex-1 min-w-[280px]">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                      <input
                        type="text"
                        value={historySearch}
                        onChange={(e) => setHistorySearch(e.target.value)}
                        placeholder="Rechercher N° Ticket, Client, Nom Produit, SKU..."
                        className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-2 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none font-medium"
                      />
                      {historySearch && (
                        <button
                          onClick={() => setHistorySearch('')}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    {/* Filters: Status & Payment */}
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-pos-muted font-bold">Statut:</span>
                        <select
                          value={statusFilter}
                          onChange={(e) => setStatusFilter(e.target.value)}
                          className="bg-pos-bg border border-pos-border text-pos-text text-xs font-bold rounded-xl px-3 py-2 focus:border-emerald-400 focus:outline-none cursor-pointer"
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
                          className="bg-pos-bg border border-pos-border text-pos-text text-xs font-bold rounded-xl px-3 py-2 focus:border-emerald-400 focus:outline-none cursor-pointer"
                        >
                          <option value="Tous">Tous les modes</option>
                          <option value="Espèces">Espèces</option>
                          <option value="BaridiMob">BaridiMob</option>
                          <option value="Chèque">Chèque</option>
                          <option value="Avoir Client">Avoir Client</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Transactions History Table */}
                  <div className="bg-pos-card border border-pos-border rounded-2xl overflow-hidden shadow-sm">
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
                        {filteredTransactions.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="p-8 text-center text-pos-muted font-medium">
                              Aucune transaction ne correspond à vos critères de recherche.
                            </td>
                          </tr>
                        ) : (
                          filteredTransactions.map((t) => {
                            const isVoided = t.status === 'VOIDED';
                            const isRefund = Boolean(t.isRefund);
                            const isRefunded = t.status === 'REFUNDED';
                            const isPartiallyRefunded = t.status === 'PARTIALLY_REFUNDED';

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
                                    <span className="text-[9px] font-black px-2 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">
                                      ANNULÉ (VOID)
                                    </span>
                                  ) : isRefund ? (
                                    <span className="text-[9px] font-black px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30">
                                      AVOIR ÉMIS
                                    </span>
                                  ) : isRefunded ? (
                                    <span className="text-[9px] font-black px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                      REMBOURSÉ
                                    </span>
                                  ) : isPartiallyRefunded ? (
                                    <span className="text-[9px] font-black px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                                      PARTIEL REMB.
                                    </span>
                                  ) : (
                                    <span className="text-[9px] font-black px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                      VALIDÉ
                                    </span>
                                  )}
                                </td>
                                <td className="p-3 font-semibold text-pos-text">
                                  {t.customer?.name || 'Client de passage'}
                                </td>
                                <td className="p-3 text-pos-muted font-medium">
                                  <span className="bg-pos-bg border border-pos-border px-2 py-0.5 rounded text-[10px] font-bold text-pos-text">
                                    {t.items.reduce((acc, i) => acc + i.quantity, 0)} articles
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
                                <td className="p-3 text-right font-bold text-cyan-400">
                                  {isVoided || isRefund ? '0 DA' : formatDZD(t.profit)}
                                </td>
                                <td className="p-3 text-center">
                                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-pos-bg text-pos-text border border-pos-border">
                                    {t.paymentMethod}
                                  </span>
                                </td>
                                <td className="p-3 text-right text-pos-muted text-[11px] font-mono">{t.createdAt}</td>
                                <td className="p-3 text-center">
                                  <div className="flex items-center justify-center gap-1.5">
                                    <button
                                      onClick={() => setInspectingTransaction(t)}
                                      className="p-1.5 rounded-lg bg-pos-bg hover:bg-emerald-500/20 text-pos-muted hover:text-emerald-400 border border-pos-border transition cursor-pointer"
                                      title="Inspecter le ticket, rembourser ou annuler"
                                    >
                                      <Eye className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      onClick={() => handleReprintFromInspector(t)}
                                      className="p-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/30 transition cursor-pointer"
                                      title="Réimprimer le ticket"
                                    >
                                      <Printer className="w-3.5 h-3.5" />
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
                          {dateFilteredTransactions.slice(0, 15).map((t, idx) => {
                            const isVoided = t.status === 'VOIDED';
                            const isRefund = Boolean(t.isRefund);
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
                                <td className="p-2.5 font-mono text-pos-muted">{t.createdAt}</td>
                                <td className="p-2.5">{t.customer?.name || 'Client de passage'}</td>
                                <td className="p-2.5 text-center">{t.items.reduce((acc, i) => acc + i.quantity, 0)}</td>
                                <td className="p-2.5 text-right font-black text-pos-text">
                                  {isRefund ? `-${formatDZD(t.total)}` : formatDZD(t.total)}
                                </td>
                                <td className="p-2.5 text-right font-bold text-emerald-400">
                                  {isVoided || isRefund ? '0 DA' : formatDZD(t.profit)}
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
            className="px-5 py-2 rounded-xl bg-pos-hover text-pos-text font-bold hover:bg-pos-border transition cursor-pointer"
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
                      {inspectingTransaction.createdAt} • Caissier: {inspectingTransaction.cashierName || 'Yacine (Caisse 1)'}
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
                    {inspectingTransaction.items.map((item, idx) => {
                      const itemPrice = item.appliedPrice || item.product?.price || 0;
                      return (
                        <div key={idx} className="p-2.5 flex justify-between items-center text-xs">
                          <div>
                            <p className="font-bold text-pos-text">{item.product?.title || 'Article'}</p>
                            <span className="text-[10px] text-pos-muted font-mono">
                              SKU: {item.product?.sku} • {item.quantity} x {formatDZD(itemPrice)}
                            </span>
                          </div>
                          <span className="font-black text-pos-text">{formatDZD(itemPrice * item.quantity)}</span>
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
                        placeholder="PIN (1234)"
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
                        className="px-4 py-1.5 bg-red-500 hover:bg-red-400 text-slate-950 font-black text-xs rounded-lg transition"
                      >
                        Confirmer l'Annulation (Restaurer Stocks)
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

      </div>
    </div>
  );
};

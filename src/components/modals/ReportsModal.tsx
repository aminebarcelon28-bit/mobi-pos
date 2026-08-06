import React, { useState } from 'react';
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
  Tag,
  CheckCircle2,
  Copy,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { SaleTransaction } from '../../types/pos';
import { SalesAnalyticsCharts } from '../reports/SalesAnalyticsCharts';

export const ReportsModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    transactions,
    verifyManagerPin,
    logSecurityAction,
    reprintReceipt,
  } = usePosStore();

  const [pinVerified, setPinVerified] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [activeTab, setActiveTab] = useState<'analytics' | 'history' | 'export'>('analytics');

  // Transaction Inspector State
  const [inspectingTransaction, setInspectingTransaction] = useState<SaleTransaction | null>(null);

  // Search & Filter State in History Tab
  const [historySearch, setHistorySearch] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('Tous');

  // Export Tab State
  const [exportSuccess, setExportSuccess] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [csvPreview, setCsvPreview] = useState<string | null>(null);

  if (activeModal !== 'reports') return null;

  const handleVerifyPin = (e: React.FormEvent) => {
    e.preventDefault();
    if (verifyManagerPin(pinInput)) {
      setPinVerified(true);
      logSecurityAction('Accès Rapports Financiers Autorisé', 'Consultation des rapports par PIN Administrateur', 'Yacine (Admin)', true);
    } else {
      alert('PIN Administrateur incorrect ! Accès aux rapports refusé.');
      logSecurityAction('Tentative Accès Rapports Échouée', 'PIN incorrect saisi', 'Caissier', true);
    }
  };

  // Financial KPI Metrics
  const totalRevenue = transactions.reduce((acc, t) => acc + t.total, 0);
  const totalCost = transactions.reduce((acc, t) => acc + (t.costTotal || t.total * 0.5), 0);
  const totalNetProfit = totalRevenue - totalCost;
  const netProfitMargin = totalRevenue > 0 ? ((totalNetProfit / totalRevenue) * 100).toFixed(1) : '0';
  const averageBasket = transactions.length > 0 ? totalRevenue / transactions.length : 0;

  // Filtered Transactions
  const safeTransactions = transactions || [];
  const filteredTransactions = safeTransactions.filter((t) => {
    const matchesPayment = paymentFilter === 'Tous' || t.paymentMethod === paymentFilter;
    
    // Search query matching Receipt Number, Customer Name, or Product Title
    const q = historySearch.trim().toLowerCase();
    const matchesSearch =
      !q ||
      (t.receiptNumber && t.receiptNumber.toLowerCase().includes(q)) ||
      (t.customer?.name && t.customer.name.toLowerCase().includes(q)) ||
      (t.customer?.phone && t.customer.phone.toLowerCase().includes(q)) ||
      (t.items || []).some(item => (item.product?.title || '').toLowerCase().includes(q) || (item.product?.sku || '').toLowerCase().includes(q));

    return matchesPayment && matchesSearch;
  });

  const handleReprintFromInspector = (t: SaleTransaction) => {
    setInspectingTransaction(null);
    closeModal();
    reprintReceipt(t);
  };

  const generateCsvString = () => {
    const BOM = '\uFEFF';
    const headers = 'ID Ticket;N° Reçu;Date;Client;Sous-Total (DA);Remise (DA);Total Net (DA);Cout Achat (DA);Bénéfice Net (DA);Marge (%);Mode Paiement\n';
    
    const rows = transactions
      .map((t) => {
        const customerName = (t.customer?.name || 'Client de passage').replace(/;/g, ' ');
        const dateStr = (t.createdAt || '').replace(/;/g, ' ');
        const payment = (t.paymentMethod || 'Espèces').replace(/;/g, ' ');
        const subtotal = t.subtotal || t.total;
        const discount = t.discountTotal || 0;
        const cost = t.costTotal || 0;

        return `${t.id};${t.receiptNumber};"${dateStr}";"${customerName}";${subtotal};${discount};${t.total};${cost};${t.profit};${t.profitMargin}%;"${payment}"`;
      })
      .join('\n');

    return BOM + headers + rows;
  };

  const handleExportCSV = () => {
    if (transactions.length === 0) {
      alert('Aucune transaction à exporter.');
      return;
    }

    const csvContent = generateCsvString();
    setCsvPreview(csvContent);

    // Primary Method: Data URI Anchor Download (Supports Desktop WebViews)
    try {
      const fileName = `MOBI_POS_EXPORT_COMPTABLE_${new Date().toISOString().slice(0, 10)}.csv`;
      const encodedUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent);
      
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', fileName);
      link.style.display = 'none';
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (e) {
      console.warn('Anchor download failed, fallback to Data URI window open', e);
    }

    setExportSuccess(true);
    setTimeout(() => setExportSuccess(false), 4000);
  };

  const handleCopyToClipboard = () => {
    const csvContent = generateCsvString();
    navigator.clipboard.writeText(csvContent).then(() => {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 3000);
    });
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[88vh] flex flex-col relative">
        
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2.5 text-cyan-400">
            <BarChart3 className="w-5 h-5 stroke-[2.5]" />
            <div>
              <h2 className="text-base font-extrabold text-pos-text tracking-wide">
                RAPPORTS FINANCIERS & INSPECTEUR DE VENTES
              </h2>
              <p className="text-[10px] text-pos-muted">Analytics, journal des tickets et réimpression de reçus</p>
            </div>
          </div>
          <button
            onClick={() => { setPinVerified(false); setPinInput(''); closeModal(); }}
            className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Security PIN Gate Intercept */}
        {!pinVerified ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30 shadow-lg">
              <Lock className="w-7 h-7 stroke-[2.5]" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-pos-text">Accès Sécurisé par PIN Administrateur</h3>
              <p className="text-xs text-pos-muted mt-1 max-w-sm">
                Saisissez votre code PIN Manager (Par défaut : <strong>1234</strong>) pour accéder aux rapports financiers et réimprimer des reçus passés.
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
                className="px-5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-xl transition shadow-md cursor-pointer"
              >
                Déverrouiller
              </button>
            </form>
          </div>
        ) : (
          /* Unlocked Report View */
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex border-b border-pos-border bg-pos-card px-4 shrink-0">
              <button
                onClick={() => setActiveTab('analytics')}
                className={`py-3 px-4 text-xs font-bold border-b-2 transition-colors ${
                  activeTab === 'analytics'
                    ? 'border-emerald-500 text-emerald-400'
                    : 'border-transparent text-pos-muted hover:text-pos-text'
                }`}
              >
                Vue Graphique & Performance
              </button>
              <button
                onClick={() => setActiveTab('history')}
                className={`py-3 px-4 text-xs font-bold border-b-2 transition-colors ${
                  activeTab === 'history'
                    ? 'border-emerald-500 text-emerald-400'
                    : 'border-transparent text-pos-muted hover:text-pos-text'
                }`}
              >
                Historique Transactions & Inspection Reçus ({transactions.length})
              </button>
              <button
                onClick={() => setActiveTab('export')}
                className={`py-3 px-4 text-xs font-bold border-b-2 transition-colors ${
                  activeTab === 'export'
                    ? 'border-emerald-500 text-emerald-400'
                    : 'border-transparent text-pos-muted hover:text-pos-text'
                }`}
              >
                Export Comptable CSV
              </button>
            </div>
            
            <div className="p-5 overflow-y-auto space-y-5 flex-1 bg-pos-bg">
              {activeTab === 'analytics' && (
                <SalesAnalyticsCharts />
              )}
              
              {activeTab === 'history' && (
                <div className="space-y-4">
                  
                  {/* Executive KPI Summary Bar */}
                  <div className="grid grid-cols-5 gap-3">
                    <div className="bg-pos-card border border-pos-border p-3 rounded-xl">
                      <span className="text-[9px] text-pos-muted uppercase font-bold">Total Transactions</span>
                      <p className="text-base font-black text-pos-text mt-0.5">{transactions.length}</p>
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
                  <div className="bg-pos-card border border-pos-border p-3 rounded-2xl flex items-center justify-between gap-3">
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                      <input
                        type="text"
                        value={historySearch}
                        onChange={(e) => setHistorySearch(e.target.value)}
                        placeholder="Rechercher N° Ticket, Client, Nom Produit, SKU..."
                        className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-2 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none"
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

                    {/* Method Selector */}
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

                  {/* Transactions History Table */}
                  <div className="bg-pos-card border border-pos-border rounded-2xl overflow-hidden shadow-sm">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="bg-pos-bg text-pos-muted text-[10px] uppercase font-bold border-b border-pos-border">
                        <tr>
                          <th className="p-3">N° Ticket</th>
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
                            <td colSpan={8} className="p-8 text-center text-pos-muted">
                              Aucune transaction ne correspond à votre recherche.
                            </td>
                          </tr>
                        ) : (
                          filteredTransactions.map((t) => (
                            <tr key={t.id} className="hover:bg-pos-hover/60 transition group">
                              <td className="p-3 font-mono font-black text-emerald-400">{t.receiptNumber}</td>
                              <td className="p-3 font-semibold text-pos-text">
                                {t.customer?.name || 'Client de passage'}
                              </td>
                              <td className="p-3 text-pos-muted font-medium">
                                <span className="bg-pos-bg border border-pos-border px-2 py-0.5 rounded text-[10px] font-bold text-pos-text">
                                  {t.items.reduce((acc, i) => acc + i.quantity, 0)} articles
                                </span>
                              </td>
                              <td className="p-3 text-right font-black text-emerald-400">{formatDZD(t.total)}</td>
                              <td className="p-3 text-right font-bold text-cyan-400">{formatDZD(t.profit)}</td>
                              <td className="p-3 text-center">
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                                  {t.paymentMethod}
                                </span>
                              </td>
                              <td className="p-3 text-right text-pos-muted text-[11px] font-mono">{t.createdAt}</td>
                              <td className="p-3 text-center">
                                <div className="flex items-center justify-center gap-1.5">
                                  <button
                                    onClick={() => setInspectingTransaction(t)}
                                    className="p-1.5 rounded-lg bg-pos-bg hover:bg-emerald-500/20 text-pos-muted hover:text-emerald-400 border border-pos-border transition"
                                    title="Inspecter le ticket & les articles"
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleReprintFromInspector(t)}
                                    className="p-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/30 transition"
                                    title="Réimprimer le ticket"
                                  >
                                    <Printer className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === 'export' && (
                <div className="flex flex-col items-center justify-center p-8 space-y-4 relative overflow-y-auto">
                  {exportSuccess && (
                    <div className="bg-emerald-500 text-slate-950 px-4 py-2 rounded-full font-black text-xs shadow-xl animate-in fade-in slide-in-from-top-4 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" /> Fichier CSV déclenché avec succès !
                    </div>
                  )}

                  {copySuccess && (
                    <div className="bg-cyan-500 text-slate-950 px-4 py-2 rounded-full font-black text-xs shadow-xl animate-in fade-in slide-in-from-top-4 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" /> Texte CSV copié dans le presse-papier !
                    </div>
                  )}

                  <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shadow-lg">
                    <Download className="w-8 h-8 stroke-[2.5]" />
                  </div>

                  <div className="text-center">
                    <h3 className="text-sm font-extrabold text-pos-text">Exportation des Données Comptables (Format Excel UTF-8)</h3>
                    <p className="text-xs text-pos-muted max-w-md mt-1">
                      Téléchargez l'historique complet des <strong>{transactions.length} transactions</strong> au format CSV ou copiez les données directement pour Excel / Google Sheets.
                    </p>
                  </div>

                  {/* Dual Action Buttons */}
                  <div className="flex gap-3 pt-2">
                    <button
                      onClick={handleExportCSV}
                      className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold flex items-center gap-2 transition shadow-lg shadow-emerald-500/20 cursor-pointer text-xs"
                    >
                      <Download className="w-4 h-4" />
                      Générer & Télécharger Fichier CSV
                    </button>

                    <button
                      onClick={handleCopyToClipboard}
                      className="px-6 py-2.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-text font-bold flex items-center gap-2 transition cursor-pointer text-xs"
                    >
                      <Copy className="w-4 h-4 text-cyan-400" />
                      Copier Texte CSV (Presse-Papier)
                    </button>
                  </div>

                  {/* Optional Preview Area */}
                  {csvPreview && (
                    <div className="w-full max-w-2xl mt-4 bg-pos-card border border-pos-border rounded-xl p-3 text-left space-y-1.5">
                      <span className="text-[10px] uppercase font-bold text-pos-muted block">Aperçu du contenu CSV (Excel Ready) :</span>
                      <textarea
                        readOnly
                        rows={5}
                        value={csvPreview}
                        className="w-full bg-pos-bg border border-pos-border rounded-lg p-2 font-mono text-[10px] text-emerald-400 focus:outline-none select-all"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="p-3 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
          <span>Rapports Financiers - Tax-Free Gross Totals</span>
          <button onClick={() => { setPinVerified(false); setPinInput(''); closeModal(); }} className="px-4 py-1.5 rounded-xl bg-pos-hover text-pos-text font-semibold">
            Fermer
          </button>
        </div>

        {/* Transaction Inspector Dialog Overlay */}
        {inspectingTransaction && (
          <div className="absolute inset-0 bg-black/85 backdrop-blur-md z-30 flex items-center justify-center p-6 animate-in fade-in">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
              
              {/* Inspector Header */}
              <div className="p-4 border-b border-pos-border bg-pos-card flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShoppingBag className="w-5 h-5 text-emerald-400" />
                  <div>
                    <h3 className="text-sm font-bold text-pos-text">
                      Ticket #{inspectingTransaction.receiptNumber}
                    </h3>
                    <p className="text-[10px] text-pos-muted">{inspectingTransaction.createdAt}</p>
                  </div>
                </div>
                <button
                  onClick={() => setInspectingTransaction(null)}
                  className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Inspector Content */}
              <div className="p-5 overflow-y-auto space-y-4 text-xs">
                {/* Customer Details */}
                <div className="bg-pos-bg p-3 rounded-xl border border-pos-border flex justify-between items-center">
                  <div>
                    <span className="text-[10px] text-pos-muted block font-semibold">Client:</span>
                    <span className="font-bold text-pos-text">
                      {inspectingTransaction.customer ? inspectingTransaction.customer.name : 'Client de passage'}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-pos-muted block font-semibold">Mode de Paiement:</span>
                    <span className="font-bold text-emerald-400">{inspectingTransaction.paymentMethod}</span>
                  </div>
                </div>

                {/* Sold Products Table */}
                <div>
                  <h4 className="text-xs font-bold text-pos-text mb-2 flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-emerald-400" /> Articles Achetes ({inspectingTransaction.items.length})
                  </h4>
                  <div className="bg-pos-bg border border-pos-border rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-pos-card text-pos-muted border-b border-pos-border text-[10px] uppercase font-bold">
                        <tr>
                          <th className="p-2.5">Article</th>
                          <th className="p-2.5 text-center">Qté</th>
                          <th className="p-2.5 text-right">Prix Unitaire</th>
                          <th className="p-2.5 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pos-border">
                        {inspectingTransaction.items.map((item) => {
                          const unitPrice = item.appliedPrice || item.product.price;
                          const netLineTotal = Math.max(0, unitPrice * item.quantity - item.discount);
                          return (
                            <tr key={item.product.id} className="hover:bg-pos-hover/30">
                              <td className="p-2.5">
                                <p className="font-bold text-pos-text">{item.product.title}</p>
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-pos-muted">SKU: {item.product.sku}</span>
                                  {item.discount > 0 && (
                                    <span className="text-[9px] bg-purple-500/10 text-purple-400 font-bold px-1 rounded border border-purple-500/30">
                                      Remise: -{formatDZD(item.discount)}
                                    </span>
                                  )}
                                </div>
                                {item.imeiNumber && (
                                  <p className="text-[9px] text-emerald-400 font-mono">IMEI: {item.imeiNumber}</p>
                                )}
                              </td>
                              <td className="p-2.5 text-center font-bold text-pos-text">{item.quantity}</td>
                              <td className="p-2.5 text-right font-medium text-pos-muted">{formatDZD(unitPrice)}</td>
                              <td className="p-2.5 text-right font-bold text-emerald-400">
                                {formatDZD(netLineTotal)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Payment Breakdown */}
                <div className="bg-pos-card p-3 rounded-xl border border-pos-border space-y-1.5">
                  {inspectingTransaction.discountTotal > 0 && (
                    <>
                      <div className="flex justify-between text-pos-muted">
                        <span>Sous-total Brut:</span>
                        <span>{formatDZD(inspectingTransaction.subtotal + inspectingTransaction.discountTotal)}</span>
                      </div>
                      <div className="flex justify-between text-purple-400 font-bold">
                        <span>Remise Globale Accordée:</span>
                        <span>-{formatDZD(inspectingTransaction.discountTotal)}</span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between font-bold text-sm text-pos-text pb-1 border-b border-pos-border">
                    <span>Montant Total Net:</span>
                    <span className="text-emerald-400">{formatDZD(inspectingTransaction.total)}</span>
                  </div>
                  <div className="flex justify-between text-pos-muted">
                    <span>Montant Reçu (Cash):</span>
                    <span>{formatDZD(inspectingTransaction.cashTendered)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-pos-text">
                    <span>Rendu Monnaie:</span>
                    <span className="text-emerald-400">{formatDZD(inspectingTransaction.changeDue)}</span>
                  </div>
                </div>

              </div>

              {/* Inspector Actions */}
              <div className="p-4 border-t border-pos-border bg-pos-card flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setInspectingTransaction(null)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text"
                >
                  Fermer
                </button>
                <button
                  type="button"
                  onClick={() => handleReprintFromInspector(inspectingTransaction)}
                  className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/20 transition cursor-pointer"
                >
                  <Printer className="w-4 h-4" /> Réimprimer ce Ticket
                </button>
              </div>

            </div>
          </div>
        )}

      </div>
    </div>
  );
};


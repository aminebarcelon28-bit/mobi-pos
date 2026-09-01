import React, { useState, useMemo } from 'react';
import {
  X,
  Plus,
  Search,
  DollarSign,
  Download,
  Trash2,
  Calendar,
  Building,
  Zap,
  Users,
  Truck,
  Wrench,
  ShoppingBag,
  FileSpreadsheet,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import type { ExpenseCategory, PaymentMethodType, StoreExpense } from '../../types/pos';
import { useToast } from '../ui/Toast';
import { soundEngine } from '../../utils/audioFeedback';

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  'Loyer': <Building className="w-4 h-4 text-amber-400" />,
  'Électricité': <Zap className="w-4 h-4 text-yellow-400" />,
  'Internet / Téléphone': <Zap className="w-4 h-4 text-cyan-400" />,
  'Salaires': <Users className="w-4 h-4 text-emerald-400" />,
  'Achat Marchandises / Fournisseur': <ShoppingBag className="w-4 h-4 text-blue-400" />,
  'Transport / Livraison': <Truck className="w-4 h-4 text-purple-400" />,
  'Maintenance': <Wrench className="w-4 h-4 text-orange-400" />,
  'Autre': <DollarSign className="w-4 h-4 text-slate-400" />,
};

export const ExpenseManagerModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    storeExpenses,
    addStoreExpense,
    deleteStoreExpense,
    activeShift,
  } = usePosStore();

  const { showToast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('Tous');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'month'>('month');

  // New Expense Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [category, setCategory] = useState<ExpenseCategory>('Loyer');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('Espèces');
  const [paidTo, setPaidTo] = useState('');
  const [notes, setNotes] = useState('');

  // ══════════════════════════════════════════════════════════════
  // AGGREGATIONS & METRICS
  // ══════════════════════════════════════════════════════════════
  const allExpenses = useMemo(() => storeExpenses || [], [storeExpenses]);
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const currentMonthStr = now.toISOString().slice(0, 7);

  const todayExpenses = allExpenses.filter((e) => e.createdAt.startsWith(todayStr));
  const monthExpenses = allExpenses.filter((e) => e.createdAt.startsWith(currentMonthStr));

  const totalMonthAmount = monthExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  const totalTodayAmount = todayExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  const totalSupplierAmount = monthExpenses
    .filter((e) => e.category.includes('Fournisseur') || e.category.includes('Marchandise'))
    .reduce((sum, e) => sum + (e.amount || 0), 0);
  const totalOperatingAmount = totalMonthAmount - totalSupplierAmount;

  // Filtered List
  const filteredExpenses = useMemo(() => {
    let list = allExpenses;

    if (dateFilter === 'today') {
      list = list.filter((e) => e.createdAt.startsWith(todayStr));
    } else if (dateFilter === 'month') {
      list = list.filter((e) => e.createdAt.startsWith(currentMonthStr));
    }

    if (selectedCategoryFilter !== 'Tous') {
      list = list.filter((e) => e.category === selectedCategoryFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q) ||
          (e.paidTo || '').toLowerCase().includes(q) ||
          (e.notes || '').toLowerCase().includes(q)
      );
    }

    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [allExpenses, dateFilter, selectedCategoryFilter, searchQuery, todayStr, currentMonthStr]);

  if (activeModal !== 'expense_manager') return null;

  // ══════════════════════════════════════════════════════════════
  // ACTIONS: ADD, DELETE & EXPORT
  // ══════════════════════════════════════════════════════════════
  const handleSaveExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) {
      showToast('Veuillez saisir un montant de charge valide.', 'warning');
      return;
    }

    const newExpense: StoreExpense = {
      id: `EXP-${Date.now()}`,
      category,
      title: title.trim() || category,
      amount: val,
      paymentMethod,
      paidTo: paidTo.trim() || undefined,
      notes: notes.trim() || undefined,
      recordedBy: activeShift?.cashierName || 'Administrateur',
      createdAt: new Date().toISOString(),
    };

    await addStoreExpense(newExpense);
    soundEngine.playSuccess();
    showToast(`Dépense de ${formatDZD(val)} enregistrée et déduite de l'EBITDA !`, 'success');

    // Reset Form
    setTitle('');
    setAmount('');
    setPaidTo('');
    setNotes('');
    setShowAddForm(false);
  };

  const handleDelete = async (id: string, expTitle: string) => {
    if (confirm(`Confirmez-vous la suppression de la dépense "${expTitle}" ?`)) {
      await deleteStoreExpense(id);
      showToast('Dépense supprimée.', 'info');
    }
  };

  const handleExportCsv = () => {
    const BOM = '\uFEFF';
    let csv = `${BOM}JOURNAL DES DÉPENSES ET CHARGES D'EXPLOITATION\n`;
    csv += `Généré le: ${formatDateTime(new Date().toISOString())}\n\n`;
    csv += 'ID;Date;Catégorie;Libellé / Objet;Bénéficiaire;Mode Paiement;Montant (DA);Enregistré Par;Notes\n';

    let sum = 0;
    filteredExpenses.forEach((e) => {
      sum += e.amount;
      csv += `"${e.id}";"${formatDateTime(e.createdAt)}";"${e.category}";"${e.title}";"${e.paidTo || ''}";"${e.paymentMethod}";${e.amount};"${e.recordedBy}";"${e.notes || ''}"\n`;
    });

    csv += `\n;;;;;TOTAL DÉPENSES (DA);${sum};;\n`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Depenses_MobiPOS_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Export CSV des dépenses terminé avec succès.', 'success');
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-6xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col h-[90vh]">
        {/* ══════════════════════════════════════════════════════════════ */}
        {/* HEADER */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-yellow-600 flex items-center justify-center text-slate-950 font-black shadow-lg shadow-amber-500/20">
              <DollarSign className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-pos-text uppercase tracking-wider">
                  Gestionnaire des Dépenses & Charges (EBITDA)
                </h2>
                <span className="px-2.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold text-xs">
                  {filteredExpenses.length} Écritures
                </span>
              </div>
              <p className="text-xs text-pos-muted">
                Enregistrement des sorties de caisse, charges fixes, factures et suivi de la trésorerie nette
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TOP KPI SUMMARY CARDS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-4 border-b border-pos-border bg-pos-bg grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0">
          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Total Mois En Cours
              </span>
              <span className="text-xl font-black text-amber-400 font-mono">{formatDZD(totalMonthAmount)}</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <Calendar className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Dépenses Aujourd'hui
              </span>
              <span className="text-xl font-black text-rose-400 font-mono">{formatDZD(totalTodayAmount)}</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-rose-500/10 text-rose-400 flex items-center justify-center">
              <DollarSign className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Charges Fournisseurs
              </span>
              <span className="text-xl font-black text-blue-400 font-mono">{formatDZD(totalSupplierAmount)}</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-blue-500/10 text-blue-400 flex items-center justify-center">
              <ShoppingBag className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase font-bold text-pos-muted tracking-wider block">
                Charges d'Exploitation
              </span>
              <span className="text-xl font-black text-emerald-400 font-mono">{formatDZD(totalOperatingAmount)}</span>
            </div>
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
              <Building className="w-5 h-5" />
            </div>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* TOOLBAR CONTROLS */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-3 border-b border-pos-border bg-pos-panel flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs w-full sm:w-auto">
            {(['month', 'today', 'all'] as const).map((df) => (
              <button
                key={df}
                onClick={() => setDateFilter(df)}
                className={`px-3 py-1.5 rounded-xl font-bold border transition cursor-pointer ${
                  dateFilter === df
                    ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-sm'
                    : 'bg-pos-card text-pos-muted hover:text-pos-text border-pos-border'
                }`}
              >
                {df === 'month' ? '📅 Ce Mois' : df === 'today' ? 'Aujourd\'hui' : 'Toutes les Dates'}
              </button>
            ))}

            <select
              value={selectedCategoryFilter}
              onChange={(e) => setSelectedCategoryFilter(e.target.value)}
              className="bg-pos-card border border-pos-border text-pos-text font-bold text-xs rounded-xl px-3 py-1.5 focus:outline-none focus:border-amber-400 cursor-pointer"
            >
              <option value="Tous">Toutes Catégories</option>
              <option value="Loyer">Loyer</option>
              <option value="Électricité">Électricité</option>
              <option value="Internet / Téléphone">Internet / Téléphone</option>
              <option value="Salaires">Salaires & Primes</option>
              <option value="Achat Marchandises / Fournisseur">Fournisseurs & Marchandises</option>
              <option value="Transport / Livraison">Transport & Livraison</option>
              <option value="Maintenance">Maintenance & Réparations</option>
              <option value="Autre">Autre Charge</option>
            </select>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <div className="relative w-full sm:w-60">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Rechercher dépense, bénéficiaire..."
                className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-1.5 text-xs text-pos-text focus:outline-none focus:border-amber-400"
              />
            </div>

            <button
              onClick={handleExportCsv}
              className="p-2 bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
              title="Exporter en CSV"
            >
              <Download className="w-4 h-4" />
            </button>

            <button
              onClick={() => setShowAddForm(true)}
              className="px-3.5 py-1.5 bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-400 hover:to-yellow-500 text-slate-950 font-black text-xs rounded-xl flex items-center gap-1.5 shadow-md transition cursor-pointer shrink-0"
            >
              <Plus className="w-4 h-4" />
              <span>+ Nouvelle Dépense</span>
            </button>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* EXPENSES LIST TABLE */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {filteredExpenses.length === 0 ? (
            <div className="p-12 text-center bg-pos-card border border-pos-border rounded-2xl space-y-3">
              <FileSpreadsheet className="w-12 h-12 text-pos-muted mx-auto opacity-40" />
              <h3 className="font-bold text-sm text-pos-text">Aucune dépense enregistrée</h3>
              <p className="text-xs text-pos-muted max-w-sm mx-auto">
                Cliquez sur "+ Nouvelle Dépense" pour enregistrer un loyer, une facture ou une sortie de caisse.
              </p>
            </div>
          ) : (
            filteredExpenses.map((exp) => (
              <div
                key={exp.id}
                className="bg-pos-card border border-pos-border hover:border-amber-500/40 rounded-xl p-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm transition"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-pos-bg border border-pos-border flex items-center justify-center shrink-0">
                    {CATEGORY_ICONS[exp.category] || <DollarSign className="w-4 h-4 text-amber-400" />}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-bold text-sm text-pos-text">{exp.title}</h4>
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/15 border border-amber-500/30 text-amber-300">
                        {exp.category}
                      </span>
                    </div>
                    <p className="text-[11px] text-pos-muted font-mono">
                      {formatDateTime(exp.createdAt)} • Payé à : {exp.paidTo || 'Boutique'} • Mode : {exp.paymentMethod} • Saisi par : {exp.recordedBy}
                    </p>
                    {exp.notes && (
                      <p className="text-[10px] text-pos-muted italic mt-0.5">Note: {exp.notes}</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end border-t sm:border-t-0 pt-2 sm:pt-0 border-pos-border">
                  <span className="text-base font-black text-rose-400 font-mono">
                    -{formatDZD(exp.amount)}
                  </span>

                  <button
                    onClick={() => handleDelete(exp.id, exp.title)}
                    className="p-1.5 bg-pos-bg hover:bg-red-500/20 border border-pos-border hover:border-red-500/40 text-pos-muted hover:text-red-400 rounded-xl transition cursor-pointer"
                    title="Supprimer cette écriture"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* ADD EXPENSE SUB-MODAL */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {showAddForm && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-60 flex items-center justify-center p-4">
            <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col">
              <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold">
                    <Plus className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-black text-sm text-pos-text">Nouvelle Dépense / Sortie de Caisse</h3>
                    <p className="text-[10px] text-pos-muted">Imputation automatique dans le calcul de marge nette EBITDA</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowAddForm(false)}
                  className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleSaveExpense} className="p-4 space-y-3 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">Catégorie :</label>
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-2.5 py-2 text-xs font-bold text-pos-text focus:outline-none focus:border-amber-400 cursor-pointer"
                    >
                      <option value="Loyer">🏢 Loyer & Bail</option>
                      <option value="Électricité">⚡ Électricité & Gaz</option>
                      <option value="Internet / Téléphone">🌐 Internet & Téléphone</option>
                      <option value="Salaires">👥 Salaires & Primes</option>
                      <option value="Achat Marchandises / Fournisseur">📦 Marchandises / Fournisseur</option>
                      <option value="Transport / Livraison">🚚 Transport & Logistique</option>
                      <option value="Maintenance">🔧 Maintenance & Entretien</option>
                      <option value="Autre">💵 Autre Charge</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">Montant (DA) :</label>
                    <input
                      type="number"
                      min="1"
                      step="any"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0"
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-sm font-mono font-black text-amber-400 focus:outline-none focus:border-amber-400"
                      autoFocus
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">Libellé / Objet :</label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Ex: Loyer du mois d'Août, Facture Sonelgaz..."
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:outline-none focus:border-amber-400"
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">Bénéficiaire / Payé à :</label>
                    <input
                      type="text"
                      value={paidTo}
                      onChange={(e) => setPaidTo(e.target.value)}
                      placeholder="Ex: Propriétaire, Sonelgaz, Grossiste..."
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-1.5 text-xs text-pos-text focus:outline-none focus:border-amber-400"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">Mode de Paiement :</label>
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value as PaymentMethodType)}
                      className="w-full bg-pos-bg border border-pos-border rounded-xl px-2.5 py-1.5 text-xs font-bold text-pos-text focus:outline-none focus:border-amber-400 cursor-pointer"
                    >
                      <option value="Espèces">Espèces (Tiroir-Caisse)</option>
                      <option value="BaridiMob">BaridiMob</option>
                      <option value="Chèque">Chèque Bancaire</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-pos-muted block mb-1">Notes Complémentaires :</label>
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Détails du paiement, numéro de chèque, référence virement..."
                    className="w-full bg-pos-bg border border-pos-border rounded-xl p-2 text-xs text-pos-text focus:outline-none focus:border-amber-400 resize-none"
                  />
                </div>

                <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between -mx-4 -mb-4 mt-4">
                  <button
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    className="px-4 py-2 text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    className="px-6 py-2.5 bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-400 hover:to-yellow-500 text-slate-950 font-black text-xs rounded-xl shadow-lg transition cursor-pointer"
                  >
                    Enregistrer la Dépense
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* FOOTER */}
        {/* ══════════════════════════════════════════════════════════════ */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between shrink-0">
          <span className="text-xs text-pos-muted">
            • Toutes les dépenses sont synchronisées en temps réel avec la comptabilité générale SQLite WAL.
          </span>
          <button
            onClick={closeModal}
            className="px-5 py-2 rounded-xl text-xs font-bold bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-text transition cursor-pointer"
          >
            Fermer (Échap)
          </button>
        </div>
      </div>
    </div>
  );
};

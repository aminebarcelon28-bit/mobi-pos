import React, { useState, useEffect } from 'react';
import {
  X,
  RotateCcw,
  Search,
  CheckCircle2,
  AlertTriangle,
  Receipt,
  Wallet,
  Coins,
  ShieldCheck,
  PackageCheck,
  PackageX,
  Key,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { SaleTransaction, PaymentMethodType, RefundItem } from '../../types/pos';
import { useToast } from '../ui/Toast';

export const RefundModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    transactions,
    selectedTransactionForRefund,
    setSelectedTransactionForRefund,
    processRefund,
    verifyManagerPin,
  } = usePosStore();

  const { showToast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTxn, setSelectedTxn] = useState<SaleTransaction | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<Record<string, boolean>>({});
  const [refundQuantities, setRefundQuantities] = useState<Record<string, number>>({});
  const [restockMap, setRestockMap] = useState<Record<string, boolean>>({});
  const [refundMethod, setRefundMethod] = useState<PaymentMethodType>('Avoir Client');
  const [refundReason, setRefundReason] = useState('Erreur de choix client / Échange');
  const [customReason, setCustomReason] = useState('');
  const [managerPin, setManagerPin] = useState('');
  const [pinRequired, setPinRequired] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sync with selectedTransactionForRefund when opening from ReportsModal
  useEffect(() => {
    if (activeModal === 'refund') {
      if (selectedTransactionForRefund) {
        setSelectedTxn(selectedTransactionForRefund);
        initializeRefundState(selectedTransactionForRefund);
      } else {
        setSelectedTxn(null);
        setSelectedItemIds({});
        setRefundQuantities({});
        setRestockMap({});
      }
      setManagerPin('');
      setPinRequired(false);
    }
  }, [activeModal, selectedTransactionForRefund]);

  const initializeRefundState = (txn: SaleTransaction) => {
    const initialSelected: Record<string, boolean> = {};
    const initialQty: Record<string, number> = {};
    const initialRestock: Record<string, boolean> = {};

    txn.items.forEach((item) => {
      initialSelected[item.product.id] = true;
      initialQty[item.product.id] = item.quantity;
      initialRestock[item.product.id] = true;
    });

    setSelectedItemIds(initialSelected);
    setRefundQuantities(initialQty);
    setRestockMap(initialRestock);
  };

  if (activeModal !== 'refund') return null;

  // Eligible transactions (exclude already voided or fully refunded)
  const eligibleTransactions = transactions.filter(
    (t) => t.status !== 'VOIDED' && t.status !== 'REFUNDED' && !t.isRefund
  );

  const filteredTransactions = eligibleTransactions.filter((t) => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      t.receiptNumber.toLowerCase().includes(q) ||
      (t.customer?.name && t.customer.name.toLowerCase().includes(q)) ||
      (t.customer?.phone && t.customer.phone.toLowerCase().includes(q)) ||
      t.items.some((i) => i.product.title.toLowerCase().includes(q) || i.product.sku.toLowerCase().includes(q))
    );
  });

  const handleSelectTransaction = (txn: SaleTransaction) => {
    setSelectedTxn(txn);
    setSelectedTransactionForRefund(txn);
    initializeRefundState(txn);
  };

  // Calculate refund items
  const activeRefundItems: RefundItem[] = selectedTxn
    ? selectedTxn.items
        .filter((item) => selectedItemIds[item.product.id])
        .map((item) => {
          const qty = Math.min(item.quantity, refundQuantities[item.product.id] || item.quantity);
          const unitPrice = item.appliedPrice || item.product.price;
          // Apply proportion of line discount if any
          const discountPerUnit = item.discount > 0 && item.quantity > 0 ? item.discount / item.quantity : 0;
          const netUnitPrice = Math.max(0, unitPrice - discountPerUnit);
          const totalRefundAmount = netUnitPrice * qty;

          return {
            productId: item.product.id,
            title: item.product.title,
            sku: item.product.sku,
            unitPrice: netUnitPrice,
            quantity: qty,
            totalRefundAmount,
            restock: restockMap[item.product.id] ?? true,
            imeiNumber: item.imeiNumber,
          };
        })
    : [];

  const totalRefundAmount = activeRefundItems.reduce((acc, i) => acc + i.totalRefundAmount, 0);

  const handleQuantityChange = (productId: string, newQty: number, maxQty: number) => {
    const validQty = Math.max(1, Math.min(maxQty, newQty));
    setRefundQuantities((prev) => ({ ...prev, [productId]: validQty }));
  };

  const handleToggleItem = (productId: string) => {
    setSelectedItemIds((prev) => ({ ...prev, [productId]: !prev[productId] }));
  };

  const handleToggleRestock = (productId: string) => {
    setRestockMap((prev) => ({ ...prev, [productId]: !prev[productId] }));
  };

  const handleSubmitRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTxn) {
      showToast('Veuillez d\'abord sélectionner un ticket de caisse.', 'warning');
      return;
    }

    if (activeRefundItems.length === 0) {
      showToast('Veuillez sélectionner au moins un article à rembourser.', 'warning');
      return;
    }

    if (totalRefundAmount <= 0) {
      showToast('Le montant total à rembourser doit être supérieur à 0 DA.', 'warning');
      return;
    }

    // Check Manager PIN
    if (!managerPin || !verifyManagerPin(managerPin)) {
      setPinRequired(true);
      showToast('Code PIN Manager incorrect. Autorisation requise pour émettre un remboursement.', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      const finalReason = refundReason === 'Autre' && customReason.trim() ? customReason.trim() : refundReason;
      const res = await processRefund({
        originalTransaction: selectedTxn,
        refundItems: activeRefundItems,
        refundMethod,
        refundReason: finalReason,
        cashierName: 'Manager',
      });

      if (res.success) {
        showToast(
          `Remboursement de ${formatDZD(totalRefundAmount)} validé avec succès (${refundMethod}).`,
          'success'
        );
        setSelectedTxn(null);
        setSelectedTransactionForRefund(null);
      } else {
        showToast(`Erreur lors du remboursement: ${res.reason}`, 'error');
      }
    } catch (err) {
      console.error('Refund submission error:', err);
      showToast('Une erreur est survenue lors de l\'enregistrement du remboursement.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[90vh] flex flex-col relative">
        
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2.5 text-purple-400">
            <div className="w-9 h-9 rounded-xl bg-purple-500/20 flex items-center justify-center border border-purple-500/30 shadow-inner">
              <RotateCcw className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2">
                RETOURS MARCHANDISE & REMBOURSEMENTS
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30 uppercase font-black">
                  Module Avoirs
                </span>
              </h2>
              <p className="text-[10px] text-pos-muted">Gestion des retours articles, remise en stock et émission de tickets d'avoirs</p>
            </div>
          </div>
          <button
            onClick={() => {
              setSelectedTxn(null);
              setSelectedTransactionForRefund(null);
              closeModal();
            }}
            className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Main Content */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Left Column: Transaction Selector / Search */}
          <div className="w-80 border-r border-pos-border flex flex-col bg-pos-card shrink-0">
            <div className="p-3 border-b border-pos-border">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Rechercher N° Ticket, Client..."
                  className="w-full bg-pos-bg border border-pos-border rounded-xl pl-8 pr-3 py-1.5 text-xs text-pos-text placeholder-pos-muted focus:border-purple-400 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-pos-border/40 p-1">
              {filteredTransactions.length === 0 ? (
                <div className="p-6 text-center text-xs text-pos-muted">
                  <Receipt className="w-8 h-8 mx-auto mb-2 text-pos-muted/40" />
                  Aucun ticket éligible trouvé.
                </div>
              ) : (
                filteredTransactions.slice(0, 30).map((t) => {
                  const isSelected = selectedTxn?.id === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => handleSelectTransaction(t)}
                      className={`w-full text-left p-3 rounded-xl transition cursor-pointer flex flex-col gap-1 ${
                        isSelected
                          ? 'bg-purple-500/20 border border-purple-500/40 text-purple-300'
                          : 'hover:bg-pos-hover/50 text-pos-text'
                      }`}
                    >
                      <div className="flex justify-between items-center">
                        <span className="font-mono font-bold text-xs text-purple-400">{t.receiptNumber}</span>
                        <span className="font-black text-xs text-emerald-400">{formatDZD(t.total)}</span>
                      </div>
                      <div className="flex justify-between text-[11px] text-pos-muted">
                        <span>{t.customer?.name || 'Client de passage'}</span>
                        <span className="font-mono text-[10px]">{t.createdAt.slice(0, 11)}</span>
                      </div>
                      {t.status === 'PARTIALLY_REFUNDED' && (
                        <span className="text-[9px] text-amber-400 font-bold">Partiellement Remboursé</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Column: Refund Configuration & Form */}
          <div className="flex-1 flex flex-col overflow-y-auto p-5 bg-pos-bg space-y-4">
            {!selectedTxn ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-3">
                <div className="w-16 h-16 rounded-2xl bg-purple-500/10 text-purple-400 flex items-center justify-center border border-purple-500/20">
                  <RotateCcw className="w-8 h-8 stroke-[1.5]" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-pos-text">Sélectionnez un ticket pour initier un retour</h3>
                  <p className="text-xs text-pos-muted mt-1 max-w-sm">
                    Recherchez le ticket par son numéro de reçu ou sélectionnez-le dans la liste de gauche.
                  </p>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmitRefund} className="space-y-4 flex-1 flex flex-col justify-between">
                
                <div className="space-y-4">
                  {/* Selected Transaction Summary Banner */}
                  <div className="bg-pos-card border border-pos-border p-3.5 rounded-2xl flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-pos-muted uppercase font-bold block">Ticket Source Sélectionné</span>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="font-mono font-black text-sm text-purple-400">{selectedTxn.receiptNumber}</span>
                        <span className="text-xs text-pos-muted">•</span>
                        <span className="text-xs font-bold text-pos-text">{selectedTxn.customer?.name || 'Client de passage'}</span>
                        <span className="text-xs text-pos-muted">•</span>
                        <span className="text-[11px] font-mono text-pos-muted">{selectedTxn.createdAt}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] text-pos-muted uppercase font-bold block">Total Initial Payé</span>
                      <span className="text-sm font-black text-emerald-400">{formatDZD(selectedTxn.total)}</span>
                    </div>
                  </div>

                  {/* Item Selection Table */}
                  <div className="bg-pos-card border border-pos-border rounded-2xl overflow-hidden shadow-sm">
                    <div className="p-3 bg-pos-bg/80 border-b border-pos-border flex justify-between items-center">
                      <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider flex items-center gap-1.5">
                        <PackageCheck className="w-4 h-4 text-purple-400" /> Articles à Rembourser ({activeRefundItems.length}/{selectedTxn.items.length})
                      </h4>
                      <span className="text-[10px] text-pos-muted">Cochez les articles et ajustez les quantités</span>
                    </div>

                    <table className="w-full text-left text-xs">
                      <thead className="bg-pos-bg text-pos-muted text-[10px] uppercase font-bold border-b border-pos-border">
                        <tr>
                          <th className="p-3 w-10 text-center">Sélection</th>
                          <th className="p-3">Article / SKU</th>
                          <th className="p-3 text-center w-28">Qté Retournée</th>
                          <th className="p-3 text-center w-36">Remettre en Stock ?</th>
                          <th className="p-3 text-right">Prix Net Unit.</th>
                          <th className="p-3 text-right">Total Remboursement</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pos-border/40">
                        {selectedTxn.items.map((item) => {
                          const isChecked = Boolean(selectedItemIds[item.product.id]);
                          const isRestocked = Boolean(restockMap[item.product.id]);
                          const qty = refundQuantities[item.product.id] || item.quantity;
                          const unitPrice = item.appliedPrice || item.product.price;
                          const discountPerUnit = item.discount > 0 && item.quantity > 0 ? item.discount / item.quantity : 0;
                          const netUnitPrice = Math.max(0, unitPrice - discountPerUnit);
                          const lineRefundTotal = netUnitPrice * qty;

                          return (
                            <tr
                              key={item.product.id}
                              className={`transition ${
                                isChecked ? 'bg-purple-500/5' : 'opacity-50 bg-pos-bg/30'
                              }`}
                            >
                              <td className="p-3 text-center">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => handleToggleItem(item.product.id)}
                                  className="w-4 h-4 rounded border-pos-border text-purple-500 focus:ring-purple-400 cursor-pointer"
                                />
                              </td>
                              <td className="p-3">
                                <p className="font-bold text-pos-text">{item.product.title}</p>
                                <div className="flex items-center gap-2 text-[10px] text-pos-muted">
                                  <span>SKU: {item.product.sku}</span>
                                  {item.imeiNumber && (
                                    <span className="font-mono text-emerald-400">IMEI: {item.imeiNumber}</span>
                                  )}
                                </div>
                              </td>
                              <td className="p-3 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  <button
                                    type="button"
                                    disabled={!isChecked || qty <= 1}
                                    onClick={() => handleQuantityChange(item.product.id, qty - 1, item.quantity)}
                                    className="w-6 h-6 rounded-lg bg-pos-bg border border-pos-border text-pos-text font-bold disabled:opacity-30"
                                  >
                                    -
                                  </button>
                                  <span className="w-8 text-center font-bold text-pos-text">{qty}</span>
                                  <button
                                    type="button"
                                    disabled={!isChecked || qty >= item.quantity}
                                    onClick={() => handleQuantityChange(item.product.id, qty + 1, item.quantity)}
                                    className="w-6 h-6 rounded-lg bg-pos-bg border border-pos-border text-pos-text font-bold disabled:opacity-30"
                                  >
                                    +
                                  </button>
                                </div>
                                <span className="text-[9px] text-pos-muted block mt-0.5">(Max: {item.quantity})</span>
                              </td>
                              <td className="p-3 text-center">
                                <button
                                  type="button"
                                  disabled={!isChecked}
                                  onClick={() => handleToggleRestock(item.product.id)}
                                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5 mx-auto transition cursor-pointer ${
                                    isRestocked
                                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                      : 'bg-red-500/20 text-red-400 border border-red-500/30'
                                  }`}
                                >
                                  {isRestocked ? (
                                    <>
                                      <PackageCheck className="w-3 h-3" /> Remettre Stock (+{qty})
                                    </>
                                  ) : (
                                    <>
                                      <PackageX className="w-3 h-3" /> Rebut / Défectueux
                                    </>
                                  )}
                                </button>
                              </td>
                              <td className="p-3 text-right font-medium text-pos-muted">{formatDZD(netUnitPrice)}</td>
                              <td className="p-3 text-right font-black text-purple-400">{formatDZD(lineRefundTotal)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Refund Options & Reason */}
                  <div className="grid grid-cols-2 gap-4">
                    
                    {/* Method Selector */}
                    <div className="bg-pos-card border border-pos-border p-3.5 rounded-2xl space-y-2.5">
                      <span className="text-xs font-bold text-pos-text block flex items-center gap-1.5">
                        <Wallet className="w-4 h-4 text-purple-400" /> Mode de Remboursement
                      </span>
                      
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setRefundMethod('Avoir Client')}
                          className={`p-2.5 rounded-xl border text-left flex items-center gap-2 transition cursor-pointer ${
                            refundMethod === 'Avoir Client'
                              ? 'bg-purple-500/20 border-purple-500/50 text-purple-300 shadow-sm'
                              : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                          }`}
                        >
                          <Wallet className="w-4 h-4 text-purple-400" />
                          <div>
                            <p className="text-xs font-bold">Avoir Client</p>
                            <p className="text-[9px] text-pos-muted">Crédit magasin (Recommandé)</p>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => setRefundMethod('Espèces')}
                          className={`p-2.5 rounded-xl border text-left flex items-center gap-2 transition cursor-pointer ${
                            refundMethod === 'Espèces'
                              ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 shadow-sm'
                              : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                          }`}
                        >
                          <Coins className="w-4 h-4 text-emerald-400" />
                          <div>
                            <p className="text-xs font-bold">Espèces (Cash)</p>
                            <p className="text-[9px] text-pos-muted">Sortie tiroir-caisse</p>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => setRefundMethod('BaridiMob')}
                          className={`p-2.5 rounded-xl border text-left flex items-center gap-2 transition cursor-pointer ${
                            refundMethod === 'BaridiMob'
                              ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300 shadow-sm'
                              : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                          }`}
                        >
                          <Receipt className="w-4 h-4 text-cyan-400" />
                          <div>
                            <p className="text-xs font-bold">BaridiMob</p>
                            <p className="text-[9px] text-pos-muted">Virement électronique</p>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => setRefundMethod('Chèque')}
                          className={`p-2.5 rounded-xl border text-left flex items-center gap-2 transition cursor-pointer ${
                            refundMethod === 'Chèque'
                              ? 'bg-amber-500/20 border-amber-500/50 text-amber-300 shadow-sm'
                              : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                          }`}
                        >
                          <Receipt className="w-4 h-4 text-amber-400" />
                          <div>
                            <p className="text-xs font-bold">Chèque</p>
                            <p className="text-[9px] text-pos-muted">Remboursement différé</p>
                          </div>
                        </button>
                      </div>

                      {refundMethod === 'Avoir Client' && !selectedTxn.customer && (
                        <p className="text-[10px] text-amber-400 flex items-center gap-1 bg-amber-500/10 p-2 rounded-lg border border-amber-500/20">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          Note : Ticket sans client enregistré. L'avoir sera imprimé sous forme de Bon d'Avoir avec code-barres.
                        </p>
                      )}
                    </div>

                    {/* Reason & Security Gate */}
                    <div className="bg-pos-card border border-pos-border p-3.5 rounded-2xl space-y-2.5">
                      <span className="text-xs font-bold text-pos-text block flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-purple-400" /> Motif & Autorisation PIN
                      </span>

                      <div>
                        <label className="text-[10px] text-pos-muted font-bold block mb-1">Motif du Retour :</label>
                        <select
                          value={refundReason}
                          onChange={(e) => setRefundReason(e.target.value)}
                          className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text font-semibold focus:border-purple-400 focus:outline-none cursor-pointer"
                        >
                          <option value="Erreur de choix client / Échange">Erreur de choix client / Échange</option>
                          <option value="Article défectueux / Panne sous garantie">Article défectueux / Panne sous garantie</option>
                          <option value="Incompatible avec l'appareil">Incompatible avec l'appareil</option>
                          <option value="Insatisfaction produit">Insatisfaction produit</option>
                          <option value="Autre">Autre motif personnalisé...</option>
                        </select>
                      </div>

                      {refundReason === 'Autre' && (
                        <input
                          type="text"
                          value={customReason}
                          onChange={(e) => setCustomReason(e.target.value)}
                          placeholder="Précisez le motif exact..."
                          className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-1.5 text-xs text-pos-text focus:border-purple-400 focus:outline-none"
                        />
                      )}

                      <div className="pt-1">
                        <label className="text-[10px] text-pos-muted font-bold block mb-1">PIN Manager (Défaut : 1234) :</label>
                        <div className="relative">
                          <Key className="w-3.5 h-3.5 text-pos-muted absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="password"
                            value={managerPin}
                            onChange={(e) => {
                              setManagerPin(e.target.value);
                              setPinRequired(false);
                            }}
                            placeholder="Saisir PIN Manager"
                            className={`w-full bg-pos-bg border rounded-xl pl-8 pr-3 py-2 text-xs font-bold text-pos-text focus:outline-none ${
                              pinRequired ? 'border-red-500' : 'border-pos-border focus:border-purple-400'
                            }`}
                          />
                        </div>
                      </div>
                    </div>

                  </div>
                </div>

                {/* Footer Action Bar */}
                <div className="pt-3 border-t border-pos-border flex items-center justify-between bg-pos-card p-4 rounded-2xl shadow-xl">
                  <div>
                    <span className="text-[10px] text-pos-muted uppercase font-bold block">Montant Total à Rembourser</span>
                    <span className="text-xl font-black text-purple-400">{formatDZD(totalRefundAmount)}</span>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTxn(null);
                        setSelectedTransactionForRefund(null);
                        closeModal();
                      }}
                      className="px-4 py-2.5 rounded-xl border border-pos-border bg-pos-bg hover:bg-pos-hover text-pos-muted hover:text-pos-text text-xs font-bold transition cursor-pointer"
                    >
                      Annuler
                    </button>

                    <button
                      type="submit"
                      disabled={isSubmitting || activeRefundItems.length === 0 || totalRefundAmount <= 0}
                      className="px-6 py-2.5 rounded-xl bg-purple-500 hover:bg-purple-400 text-slate-950 font-black text-xs flex items-center gap-2 shadow-lg shadow-purple-500/20 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <CheckCircle2 className="w-4 h-4 stroke-[2.5]" />
                      Valider le Remboursement & Imprimer l'Avoir
                    </button>
                  </div>
                </div>

              </form>
            )}
          </div>

        </div>

      </div>
    </div>
  );
};

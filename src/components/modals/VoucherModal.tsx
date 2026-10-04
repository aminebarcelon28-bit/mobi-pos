import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, Ticket, Plus, Search, Printer, CheckCircle2, Copy } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import type { CreditVoucher } from '../../types/pos';
import { soundEngine } from '../../utils/audioFeedback';
import { printCoordinator } from '../../utils/printCoordinator';
import { useToast } from '../ui/Toast';
import { renderBarcodeToCanvas } from '../../utils/barcodeGenerator';
import { isMobileDevice } from '../../utils/platform';
import { MoneyInput } from '../ui/MoneyInput';
import { toLegacyReal, dinarsToMinor } from '../../utils/money';

export const VoucherModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    creditVouchers,
    createCreditVoucher,
    fetchCreditVouchers,
    receiptSettings,
    activeShift,
  } = usePosStore();
  // Part 1 seller rule for the voucher slip (shift opener, never fallback).
  const voucherSeller =
    (activeShift?.openedBy || '').trim() ||
    (activeShift?.cashierName || '').trim() ||
    'Caisse Principale';

  const [activeTab, setActiveTab] = useState<'create' | 'list'>('create');
  const [amountInput, setAmountInput] = useState<number>(0);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [validityDays, setValidityDays] = useState<number>(60);
  const [issuedVoucher, setIssuedVoucher] = useState<CreditVoucher | null>(null);

  // List search & filter
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED'>('ALL');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  // Thermal ticket print target (rendered, then printed via the channel).
  const [printingVoucher, setPrintingVoucher] = useState<CreditVoucher | null>(null);
  const voucherBarcodeRef = useRef<HTMLCanvasElement>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (activeModal === 'credit_voucher') {
      fetchCreditVouchers();
      setAmountInput(0);
      setCustomerName('');
      setCustomerPhone('');
      setNotes('');
      setIssuedVoucher(null);
      setSearchQuery('');
    }
  }, [activeModal, fetchCreditVouchers]);

  const filteredVouchers = useMemo(() => {
    return creditVouchers.filter((v) => {
      const matchSearch =
        v.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (v.customerName && v.customerName.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (v.customerPhone && v.customerPhone.includes(searchQuery));
      if (!matchSearch) return false;

      if (statusFilter === 'ALL') return true;
      return v.status === statusFilter;
    });
  }, [creditVouchers, searchQuery, statusFilter]);

  useEffect(() => {
    if (printingVoucher && voucherBarcodeRef.current) {
      renderBarcodeToCanvas(voucherBarcodeRef.current, printingVoucher.code, 'code128', {
        height: 48,
        showText: false,
      });
    }
  }, [printingVoucher]);

  useEffect(() => { if (activeModal !== 'credit_voucher') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  if (activeModal !== 'credit_voucher') return null;

  const handleCreateVoucher = async () => {
    const amount = amountInput;
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('Veuillez saisir un montant valide supérieur à 0 DA.');
      return;
    }

    try {
      const newVoucher = await createCreditVoucher({
        initialAmount: amount,
        customerName: customerName.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
        notes: notes.trim() || undefined,
        expiresInDays: validityDays > 0 ? validityDays : undefined,
      });

      setIssuedVoucher(newVoucher);
      soundEngine.playSuccess();
    } catch (err) {
      console.error('Failed to create credit voucher:', err);
      alert('Erreur lors de la génération du bon d\'avoir.');
    }
  };

  const handlePrintVoucher = async (voucher: CreditVoucher) => {
    // Mobile: no window.print dialog — text ticket via the Android sheet.
    if (isMobileDevice()) {
      const { openNativePrint } = await import('../../utils/phoneUtils');
      const { voucherText } = await import('../../utils/mobileDocPrint');
      const ok = await openNativePrint(`Avoir ${voucher.code}`, voucherText(voucher, receiptSettings, voucherSeller));
      showToast(
        ok ? '🖨️ Feuille d’impression Android ouverte.' : 'Impression indisponible sur cet appareil.',
        ok ? 'success' : 'error'
      );
      return;
    }
    setPrintingVoucher(voucher);
    printCoordinator.executePrint('credit_voucher', {
      delayMs: 150,
      onBeforePrint: () => {
        soundEngine.playKeyBeep();
      },
    });
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none"
      onClick={closeModal}
    >
      <div
        className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold">
              <Ticket className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-black text-pos-text">Bons d'Avoir & Crédits d'Échange</h2>
                <span className="text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded-full font-mono font-bold">
                  Code-Barres Scannable
                </span>
              </div>
              <p className="text-[11px] text-pos-muted">Émission de tickets d'avoir utilisables lors des prochains achats</p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer"
            title="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-pos-border bg-pos-bg px-4 pt-2 gap-2 text-xs font-bold">
          <button
            type="button"
            onClick={() => setActiveTab('create')}
            className={`pb-2.5 px-3 border-b-2 transition cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'create'
                ? 'border-purple-500 text-purple-400'
                : 'border-transparent text-pos-muted hover:text-pos-text'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Émettre un Avoir</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('list')}
            className={`pb-2.5 px-3 border-b-2 transition cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'list'
                ? 'border-purple-500 text-purple-400'
                : 'border-transparent text-pos-muted hover:text-pos-text'
            }`}
          >
            <Ticket className="w-3.5 h-3.5" />
            <span>Historique des Avoirs ({creditVouchers.length})</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="p-5 overflow-y-auto overscroll-contain flex-1">
          {activeTab === 'create' ? (
            !issuedVoucher ? (
              <div className="space-y-4 max-w-lg mx-auto">
                <div>
                  <label className="text-xs font-bold text-pos-text block mb-1">
                    Montant de l'Avoir (DA) *
                  </label>
                  <MoneyInput
                    label="Montant de l'Avoir (DA)"
                    valueMinor={dinarsToMinor(amountInput || 0)}
                    onChangeMinor={(minor) => setAmountInput(toLegacyReal(minor))}
                    placeholder="Ex: 1500"
                    className="w-full bg-pos-card border border-pos-border rounded-xl px-4 py-2.5 text-xl font-black font-mono text-purple-400 focus:outline-none focus:border-purple-500 transition"
                  />
                  {/* Quick Preset Amount Buttons */}
                  <div className="flex items-center gap-1.5 mt-2">
                    {[500, 1000, 1500, 2000, 3000].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => {
                          setAmountInput(preset);
                          soundEngine.playKeyBeep?.();
                        }}
                        className="px-2.5 py-1 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-xs font-mono font-bold text-pos-text transition cursor-pointer"
                      >
                        +{preset}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-bold text-pos-text block mb-1">
                      Nom du Client (Optionnel)
                    </label>
                    <input
                      type="text"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      placeholder="Ex: Mourad"
                      className="w-full bg-pos-card border border-pos-border rounded-xl px-3 py-2 text-sm text-pos-text focus:outline-none focus:border-purple-500 transition"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-bold text-pos-text block mb-1">
                      Téléphone (Optionnel)
                    </label>
                    <input
                      type="tel"
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                      placeholder="Ex: 0550123456"
                      className="w-full bg-pos-card border border-pos-border rounded-xl px-3 py-2 text-sm text-pos-text focus:outline-none focus:border-purple-500 transition"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-bold text-pos-text block mb-1">
                    Motif / Article Retourné
                  </label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Ex: Retour coque iPhone 14 Pro (erreur couleur)"
                    className="w-full bg-pos-card border border-pos-border rounded-xl px-3 py-2 text-sm text-pos-text focus:outline-none focus:border-purple-500 transition"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-pos-text block mb-1">
                    Durée de Validité
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { days: 30, label: '30 Jours' },
                      { days: 60, label: '60 Jours' },
                      { days: 90, label: '90 Jours' },
                      { days: 0, label: 'Sans Fin' },
                    ].map((item) => (
                      <button
                        key={item.days}
                        type="button"
                        onClick={() => setValidityDays(item.days)}
                        className={`min-h-[48px] py-2 rounded-xl text-xs font-bold border transition cursor-pointer active:scale-95 ${
                          validityDays === item.days
                            ? 'bg-purple-500/20 border-purple-500 text-purple-300'
                            : 'bg-pos-card border-pos-border text-pos-muted hover:text-pos-text'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    type="button"
                    onClick={handleCreateVoucher}
                    className="w-full py-3 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-purple-600/20 active:scale-98 transition cursor-pointer"
                  >
                    <Ticket className="w-4 h-4" />
                    <span>Générer le Bon d'Avoir (Code-Barres)</span>
                  </button>
                </div>
              </div>
            ) : (
              /* Success / Ticket View */
              <div className="max-w-md mx-auto space-y-4 text-center animate-in zoom-in-95">
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="w-7 h-7" />
                </div>
                <h3 className="text-base font-black text-pos-text">Bon d'Avoir Émis avec Succès !</h3>

                {/* Printable Voucher Ticket Card */}
                <div className="bg-white text-slate-900 rounded-2xl p-5 shadow-2xl text-left font-mono border border-dashed border-slate-300">
                  <div className="text-center pb-3 border-b border-slate-200">
                    <div className="text-xs font-black tracking-wider uppercase">
                      {receiptSettings.storeName || 'ACCESSOIRES MOBI'}
                    </div>
                    <div className="text-[10px] text-slate-500">BON D'AVOIR / CRÉDIT D'ÉCHANGE</div>
                  </div>

                  <div className="py-3 text-center">
                    <div className="text-[11px] text-slate-500 uppercase">Code Scannable à la Caisse</div>
                    <div className="text-2xl font-black tracking-widest text-purple-900 my-1">
                      {issuedVoucher.code}
                    </div>
                    <div className="text-xs text-slate-400 tracking-widest">||| | |||| | ||| || |||</div>
                  </div>

                  <div className="py-2 border-t border-b border-slate-200 space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Montant Crédité :</span>
                      <span className="font-black text-emerald-700">{formatDZD(issuedVoucher.initialAmount)}</span>
                    </div>
                    {issuedVoucher.customerName && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">Bénéficiaire :</span>
                        <span className="font-bold">{issuedVoucher.customerName}</span>
                      </div>
                    )}
                    {issuedVoucher.notes && (
                      <div className="text-[10px] text-slate-600 mt-1">
                        Motif : {issuedVoucher.notes}
                      </div>
                    )}
                    <div className="flex justify-between text-[10px] text-slate-500 pt-1">
                      <span>Date d'émission :</span>
                      <span>{formatDateTime(issuedVoucher.createdAt)}</span>
                    </div>
                    {issuedVoucher.expiresAt && (
                      <div className="flex justify-between text-[10px] text-rose-600 font-bold">
                        <span>Valable jusqu'au :</span>
                        <span>{formatDateTime(issuedVoucher.expiresAt)}</span>
                      </div>
                    )}
                  </div>

                  <div className="pt-3 text-center text-[10px] text-slate-500">
                    Présentez ce ticket en caisse pour déduire ce montant de votre prochain achat.
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => handlePrintVoucher(issuedVoucher)}
                    className="px-5 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-black text-xs flex items-center gap-1.5 shadow transition cursor-pointer"
                  >
                    <Printer className="w-4 h-4" />
                    <span>Imprimer Ticket Thermique</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIssuedVoucher(null);
                      setAmountInput(0);
                    }}
                    className="px-4 py-2.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-text font-bold text-xs transition cursor-pointer"
                  >
                    Nouvel Avoir
                  </button>
                </div>
              </div>
            )
          ) : (
            /* Tab: List of Vouchers */
            <div className="space-y-3">
              {/* Search & Filter Bar */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Rechercher par code (AV-...), client ou téléphone..."
                    className="w-full bg-pos-card border border-pos-border rounded-xl pl-9 pr-3 py-2 text-xs text-pos-text focus:outline-none focus:border-purple-500 transition"
                  />
                </div>

                <div className="flex items-center gap-1">
                  {(['ALL', 'ACTIVE', 'EXHAUSTED', 'EXPIRED'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setStatusFilter(st)}
                      className={`px-2.5 py-1.5 rounded-xl text-[11px] font-bold border transition cursor-pointer ${
                        statusFilter === st
                          ? 'bg-purple-500/20 border-purple-500 text-purple-300'
                          : 'bg-pos-card border-pos-border text-pos-muted hover:text-pos-text'
                      }`}
                    >
                      {st === 'ALL' ? 'Tous' : st === 'ACTIVE' ? 'Actifs' : st === 'EXHAUSTED' ? 'Épuisés' : 'Expirés'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Vouchers Table */}
              <div className="border border-pos-border rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-pos-border bg-pos-card text-pos-muted text-[10.5px] uppercase tracking-wider font-bold">
                      <th className="p-3">Code Scannable</th>
                      <th className="p-3">Solde Restant</th>
                      <th className="p-3">Montant Initial</th>
                      <th className="p-3">Client / Motif</th>
                      <th className="p-3">Date & Validité</th>
                      <th className="p-3 text-center">Statut</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-pos-border">
                    {filteredVouchers.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="p-8 text-center text-pos-muted">
                          Aucun bon d'avoir trouvé.
                        </td>
                      </tr>
                    ) : (
                      filteredVouchers.map((v) => (
                        <tr key={v.id} className="hover:bg-pos-hover/50 transition">
                          <td className="p-3 font-mono font-black text-purple-400">
                            <div className="flex items-center gap-1.5">
                              <span>{v.code}</span>
                              <button
                                type="button"
                                onClick={() => handleCopyCode(v.code)}
                                className="text-pos-muted hover:text-pos-text transition cursor-pointer"
                                title="Copier le code"
                              >
                                {copiedCode === v.code ? (
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                          <td className="p-3 font-mono font-black text-emerald-400">
                            {formatDZD(v.remainingAmount)}
                          </td>
                          <td className="p-3 font-mono text-pos-muted">
                            {formatDZD(v.initialAmount)}
                          </td>
                          <td className="p-3">
                            <div className="font-semibold text-pos-text">{v.customerName || 'Client Anonyme'}</div>
                            {v.notes && <div className="text-[10px] text-pos-muted truncate max-w-[150px]">{v.notes}</div>}
                          </td>
                          <td className="p-3 text-[11px] text-pos-muted font-mono">
                            <div>{formatDateTime(v.createdAt)}</div>
                            {v.expiresAt && (
                              <div className="text-[10px] text-amber-400/80">
                                Exp: {formatDateTime(v.expiresAt)}
                              </div>
                            )}
                          </td>
                          <td className="p-3 text-center">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                                v.status === 'ACTIVE'
                                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                  : v.status === 'EXHAUSTED'
                                  ? 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                                  : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                              }`}
                            >
                              {v.status === 'ACTIVE' ? 'Actif' : v.status === 'EXHAUSTED' ? 'Épuisé' : 'Expiré'}
                            </span>
                          </td>
                          <td className="p-3 text-right">
                            <button
                              type="button"
                              onClick={() => handlePrintVoucher(v)}
                              className="p-1.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-text transition cursor-pointer"
                              title="Réimprimer le ticket"
                            >
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Dedicated 80mm Voucher Ticket Print Template */}
        {printingVoucher && (
          <div className="print-credit-target hidden print:block bg-white text-black p-1 font-mono tabular-nums text-[11px] leading-snug">
            <div className="text-center pb-2 border-b border-dashed border-gray-500">
              <p className="font-extrabold text-sm uppercase tracking-wider">{receiptSettings?.storeName || 'MOBI ACCESSORIES'}</p>
              <p className="font-black text-xs uppercase mt-1">*** BON D'AVOIR ***</p>
              <p className="font-black text-base tracking-widest mt-1">{printingVoucher.code}</p>
              <p className="text-[10px]">{formatDateTime(printingVoucher.createdAt)}</p>
              <p className="text-[10px]">Caisse: {activeShift?.id ? `Caisse ${activeShift.id.slice(-8)}` : 'Caisse Principale'} • Vendeur: {voucherSeller}</p>
            </div>
            <div className="py-2 border-b border-dashed border-gray-500">
              <div className="flex justify-between font-extrabold text-[13px]">
                <span>MONTANT :</span>
                <span>{formatDZD(printingVoucher.initialAmount)}</span>
              </div>
              {printingVoucher.customerName && (
                <div className="flex justify-between mt-0.5">
                  <span>Bénéficiaire :</span>
                  <span className="font-bold">{printingVoucher.customerName}</span>
                </div>
              )}
              {printingVoucher.expiresAt && (
                <div className="flex justify-between mt-0.5">
                  <span>Valable jusqu'au :</span>
                  <span className="font-bold">{formatDateTime(printingVoucher.expiresAt)}</span>
                </div>
              )}
            </div>
            <div className="py-1 flex flex-col items-center border-b border-dashed border-gray-500">
              <canvas ref={voucherBarcodeRef} className="max-w-full" />
              <p className="text-[9px] mt-0.5">Scannez ce code en caisse</p>
            </div>
            <div className="pt-2 text-center">
              <p className="text-[10px]">Présentez ce ticket pour déduire ce montant de votre prochain achat.</p>
              <p className="text-[10px] mt-1">Échange sous 48h avec ticket original.</p>
              <p className="text-[9px] text-gray-600 mt-1">Document généré par Mobi-POS • *{printingVoucher.code}*</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

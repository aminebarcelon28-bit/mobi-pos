import React, { useState, useEffect } from 'react';
import {
  X,
  RefreshCw,
  CheckCircle2,
  History,
  Plus,
  Search,
  UserCheck,
  Printer,
  Wallet,
  Barcode,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD, formatDateTime } from '../../types/pos';
import type { BrandName, ConditionGrade, TradeInItem } from '../../types/pos';
import { printCoordinator } from '../../utils/printCoordinator';
import { generateUniqueEan13Barcode } from '../../utils/barcodeGenerator';
import { useToast } from '../ui/Toast';
import { isMobileDevice } from '../../utils/platform';

const DEVICE_PRESETS = [
  { model: 'iPhone 15 Pro Max', brand: 'Apple' as BrandName },
  { model: 'iPhone 14 Pro', brand: 'Apple' as BrandName },
  { model: 'iPhone 13 Pro', brand: 'Apple' as BrandName },
  { model: 'Samsung S24 Ultra', brand: 'Samsung' as BrandName },
  { model: 'Samsung S23 Ultra', brand: 'Samsung' as BrandName },
  { model: 'Xiaomi Redmi Note 13', brand: 'Autre' as BrandName },
  { model: 'Google Pixel 8 Pro', brand: 'Google' as BrandName },
];

const CONDITION_GRADES: { grade: ConditionGrade; desc: string; color: string }[] = [
  { grade: 'Grade A (Comme Neuf)', desc: 'Zéro rayure, batterie > 90%, boîte d\'origine', color: 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300' },
  { grade: 'Grade B (Bon État)', desc: 'Micro-rayures légères, 100% fonctionnel', color: 'border-blue-500/60 bg-blue-500/10 text-blue-300' },
  { grade: 'Grade C (Usagé)', desc: 'Traces d\'usure visibles, châssis marqué', color: 'border-amber-500/60 bg-amber-500/10 text-amber-300' },
  { grade: 'Grade D (Écran Fissuré)', desc: 'Écran cassé ou panne mineure à réparer', color: 'border-rose-500/60 bg-rose-500/10 text-rose-300' },
];

export const TradeInBuybackModal: React.FC = () => {
  const { activeModal, closeModal, processTradeIn, tradeIns, customers, receiptSettings, products } = usePosStore();
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<'Nouvelle' | 'Historique'>('Nouvelle');
  const [successMsg, setSuccessMsg] = useState('');
  const [printingTrade, setPrintingTrade] = useState<TradeInItem | null>(null);

  // History Search
  const [historySearch, setHistorySearch] = useState('');

  // Form State
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deviceModel, setDeviceModel] = useState('');
  const [imei, setImei] = useState('');
  const [barcode, setBarcode] = useState('');
  const [brand, setBrand] = useState<BrandName>('Apple');
  const [grade, setGrade] = useState<ConditionGrade>('Grade B (Bon État)');
  const [buybackValue, setBuybackValue] = useState<number>(0);
  // NOTE — markup, not margin: resale = buyback × (1 + m%). Renaming the
  // state/field would churn the slice + stored trade-ins for zero behavior
  // gain; the merchant-facing label below says Majoration honestly.
  const [resaleMarginPercent, setResaleMarginPercent] = useState<number>(30);
  const [creditToWallet, setCreditToWallet] = useState<boolean>(false);

  // Live Barcode Scanner auto-fill when Trade-In modal is open
  useEffect(() => {
    if (activeModal !== 'trade_in_buyback') return;

    const handleBarcodeScanned = (e: Event) => {
      const customEvent = e as CustomEvent<{ code: string }>;
      if (customEvent.detail?.code) {
        const scanned = customEvent.detail.code.trim();
        setBarcode(scanned);
      }
    };

    window.addEventListener('pos:barcode-scanned', handleBarcodeScanned);
    return () => window.removeEventListener('pos:barcode-scanned', handleBarcodeScanned);
  }, [activeModal]);

  const handleGenerateBarcode = () => {
    const newBarcode = generateUniqueEan13Barcode(products || [], '613');
    setBarcode(newBarcode);
  };

  if (activeModal !== 'trade_in_buyback') return null;

  // KPI Computations
  const safeTradeIns = tradeIns || [];
  const totalTradeIns = safeTradeIns.length;
  const totalBuybackCapital = safeTradeIns.reduce((acc, t) => acc + (t.buybackValue || 0), 0);
  const totalProjectedResale = safeTradeIns.reduce((acc, t) => acc + (t.resalePrice || 0), 0);
  const totalProjectedProfit = totalProjectedResale - totalBuybackCapital;

  const suggestedSellingPrice = Math.round(buybackValue * (1 + resaleMarginPercent / 100));
  const estimatedProfit = suggestedSellingPrice - buybackValue;

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3500);
  };

  const resetForm = () => {
    setCustomerName('');
    setCustomerPhone('');
    setDeviceModel('');
    setImei('');
    setBarcode('');
    setBrand('Apple');
    setGrade('Grade B (Bon État)');
    setBuybackValue(0);
    setResaleMarginPercent(30);
    setCreditToWallet(false);
  };

  const handleSelectCustomer = (customerId: string) => {
    const found = customers.find(c => c.id === customerId);
    if (found) {
      setCustomerName(found.name);
      setCustomerPhone(found.phone);
      if (found.registeredDevice && found.registeredDevice !== 'N/A') {
        setDeviceModel(found.registeredDevice);
      }
    }
  };

  const finalBuybackValue = creditToWallet ? Math.round(buybackValue * 1.1) : buybackValue;

  const handleSubmitTradeIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (buybackValue <= 0) return;

    const res = await processTradeIn({
      customerName: customerPhone ? `${customerName} (${customerPhone})` : customerName,
      customerPhone: customerPhone || undefined,
      deviceModel,
      imei: imei.trim(),
      barcode: barcode.trim() || undefined,
      brand,
      conditionGrade: grade,
      buybackValue: finalBuybackValue,
      resaleMarginPercent,
      creditToWallet
    });

    if (res && typeof res === 'object' && 'success' in res && res.success === false) {
      const reason = String((res as { reason?: string }).reason || '');
      showSuccess(
        reason === 'NO_CREDIT_TARGET'
          ? 'Crédit wallet impossible — sélectionnez d\'abord un client (aucun crédit portefeuille appliqué).'
          : reason.startsWith('DRAWER_DEPOSIT_FAILED')
          ? 'Reprise enregistrée mais le tiroir-caisse a échoué — vérifiez le journal de caisse.'
          : `Échec de la reprise (${reason || 'erreur'}).`
      );
      return;
    }

    showSuccess(`Reprise de ${deviceModel} enregistrée ! Produit injecté dans le catalogue d'occasion avec son code-barres et IMEI.`);
    resetForm();
  };

  const handlePrintContract = async (trade: TradeInItem) => {
    // Mobile: no window.print dialog — text attestation via Android sheet.
    if (isMobileDevice()) {
      const { openNativePrint } = await import('../../utils/phoneUtils');
      const { tradeInText } = await import('../../utils/mobileDocPrint');
      const ok = await openNativePrint(
        `Cession ${trade.deviceModel}`,
        tradeInText(trade, receiptSettings)
      );
      showToast(
        ok ? '🖨️ Feuille d’impression Android ouverte.' : 'Impression indisponible sur cet appareil.',
        ok ? 'success' : 'error'
      );
      return;
    }
    setPrintingTrade(trade);
    printCoordinator.printTradeInVoucher(50);
  };

  // Filtered History
  const filteredTradeIns = tradeIns.filter((trade) => {
    const q = historySearch.trim().toLowerCase();
    return (
      !q ||
      trade.deviceModel.toLowerCase().includes(q) ||
      trade.imei.toLowerCase().includes(q) ||
      (trade.barcode && trade.barcode.toLowerCase().includes(q)) ||
      trade.customerName.toLowerCase().includes(q) ||
      trade.brand.toLowerCase().includes(q)
    );
  });

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:zoom-in-95 h-[94vh] sm:h-[90vh] flex flex-col">
        {/* Mobile drag handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20 shrink-0">
              <RefreshCw className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2 truncate">
                <span>REPRISE & TRADE-IN OCCASION</span>
                <span className="text-[9px] sm:text-[10px] bg-emerald-500/10 text-emerald-400 font-bold px-1.5 sm:px-2 py-0.5 rounded border border-emerald-500/30 shrink-0">
                  ENTERPRISE
                </span>
              </h2>
              <p className="text-[10px] sm:text-[11px] text-pos-muted truncate">Évaluation d'état, rachat cash et injection stock</p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition min-h-[38px] min-w-[38px] flex items-center justify-center cursor-pointer shrink-0"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Executive KPI Bar */}
        <div className="bg-pos-bg border-b border-pos-border px-3 sm:px-4 py-2 sm:py-2.5 grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 shrink-0 text-center select-none">
          <div className="bg-pos-card border border-pos-border rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-pos-muted block">Reprises Réalisées</span>
            <span className="text-sm font-black text-pos-text">{totalTradeIns}</span>
          </div>

          <div className="bg-pos-card border border-emerald-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-emerald-400 block">Capital Investi Rachat</span>
            <span className="text-sm font-black text-emerald-300">{formatDZD(totalBuybackCapital)}</span>
          </div>

          <div className="bg-pos-card border border-amber-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-amber-400 block">CA Revente Prévu</span>
            <span className="text-sm font-black text-amber-300">{formatDZD(totalProjectedResale)}</span>
          </div>

          <div className="bg-pos-card border border-cyan-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-cyan-400 block">Marge Brute Prévue</span>
            <span className="text-sm font-black text-cyan-300">{formatDZD(totalProjectedProfit)}</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-pos-border bg-pos-panel px-2.5 sm:px-4 shrink-0 overflow-x-auto no-scrollbar whitespace-nowrap">
          <button
            onClick={() => setActiveTab('Nouvelle')}
            className={`min-h-[44px] px-3.5 sm:px-4 py-2.5 text-xs font-bold border-b-2 transition-colors shrink-0 active:scale-95 ${activeTab === 'Nouvelle' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
          >
            <div className="flex items-center gap-2"><Plus className="w-4 h-4" /> Nouvelle Évaluation & Rachat</div>
          </button>
          <button
            onClick={() => setActiveTab('Historique')}
            className={`min-h-[44px] px-3.5 sm:px-4 py-2.5 text-xs font-bold border-b-2 transition-colors shrink-0 active:scale-95 ${activeTab === 'Historique' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
          >
            <div className="flex items-center gap-2"><History className="w-4 h-4" /> Journal des Reprises ({tradeIns.length})</div>
          </button>
        </div>

        {/* Content Form */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-5 relative bg-pos-bg">
          {successMsg && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-emerald-500/20 border border-emerald-500/60 text-emerald-300 px-5 py-2.5 rounded-full text-xs font-bold flex items-center gap-2 z-20 shadow-lg animate-in fade-in slide-in-from-top-4">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" /> {successMsg}
            </div>
          )}

          {activeTab === 'Nouvelle' ? (
            <form onSubmit={handleSubmitTradeIn} className="space-y-3 sm:space-y-4 max-w-3xl mx-auto bg-pos-card border border-pos-border rounded-2xl p-3.5 sm:p-5 shadow-md">
              {/* Customer Toolbar */}
              <div className="bg-pos-bg p-3 sm:p-3.5 rounded-xl border border-pos-border space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                    <UserCheck className="w-4 h-4 text-emerald-400" /> Informations du Client Vendeur
                  </span>
                  {(customers || []).length > 0 && (
                    <select
                      onChange={(e) => handleSelectCustomer(e.target.value)}
                      className="w-full sm:w-auto min-h-[44px] bg-pos-card border border-pos-border text-pos-text text-sm sm:text-xs rounded-lg px-2.5 py-1 focus:border-emerald-400 focus:outline-none"
                    >
                      <option value="">Sélectionner un client du répertoire...</option>
                      {(customers || []).map(c => (
                        <option key={c.id} value={c.id}>{c.name} ({c.phone})</option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Nom & Prénom du Client</label>
                    <input
                      type="text"
                      required
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                      placeholder="Ex: Karim Hadj"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Téléphone Vendeur</label>
                    <input
                      type="tel"
                      inputMode="tel"
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                      className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                      placeholder="Ex: 0661 88 99 00"
                    />
                  </div>
                </div>
              </div>

              {/* Device Identification & Presets */}
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Marque Constructeur</label>
                    <select
                      value={brand}
                      onChange={(e) => setBrand(e.target.value as BrandName)}
                      className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-sm sm:text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer"
                    >
                      <option value="Apple">Apple iPhone</option>
                      <option value="Samsung">Samsung Galaxy</option>
                      <option value="Google">Google Pixel</option>
                      <option value="Autre">Xiaomi / Realme / Oppo / Autre</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Modèle Smartphone</label>
                    <input
                      type="text"
                      required
                      value={deviceModel}
                      onChange={(e) => setDeviceModel(e.target.value)}
                      className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                      placeholder="ex: iPhone 14 Pro Max"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">IMEI Unique (15 chiffres)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      required
                      value={imei}
                      onChange={(e) => setImei(e.target.value.toUpperCase().trim())}
                      className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-mono font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
                      placeholder="358921004812345"
                    />
                  </div>
                </div>

                {/* Device Presets Bar */}
                <div className="flex items-center gap-1.5 pt-1 overflow-x-auto">
                  <span className="text-[10px] text-pos-muted font-semibold shrink-0">Presets Modèle:</span>
                  {DEVICE_PRESETS.map((preset) => (
                    <button
                      key={preset.model}
                      type="button"
                      onClick={() => { setDeviceModel(preset.model); setBrand(preset.brand); }}
                      className={`min-h-[40px] px-2.5 py-1.5 rounded text-[10px] font-semibold border transition shrink-0 active:scale-95 ${
                        deviceModel === preset.model
                          ? 'bg-emerald-500 text-slate-950 border-emerald-400 font-bold'
                          : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                      }`}
                    >
                      {preset.model}
                    </button>
                  ))}
                </div>

                {/* Genuine Product Barcode (EAN / UPC / Box Scan) */}
                <div className="bg-pos-bg border border-pos-border rounded-xl p-3 space-y-2 mt-2">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <label className="text-[11px] text-pos-muted font-bold flex items-center gap-1.5">
                      <Barcode className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>Code-Barres Réel de l'Appareil / Boîte (EAN-13 / Scanné)</span>
                    </label>
                    <span className="text-[10px] text-pos-muted">
                      Optionnel — Si vide, un EAN-13 certifié sera généré
                    </span>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={barcode}
                      onChange={(e) => setBarcode(e.target.value.trim())}
                      className="flex-1 min-w-0 w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-mono font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                      placeholder="Scannez la boîte ou saisissez l'EAN (ex: 0195949038445)..."
                    />
                    <button
                      type="button"
                      onClick={handleGenerateBarcode}
                      className="w-full sm:w-auto min-h-[48px] px-3 rounded-lg bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/30 text-xs font-bold flex items-center justify-center gap-1.5 shrink-0 transition cursor-pointer active:scale-95"
                      title="Générer un code-barres EAN-13 certifié officiel (Algérie 613)"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Générer EAN-13
                    </button>
                  </div>
                  <p className="text-[10px] text-pos-muted">
                    Le code-barres sert au scan en caisse. Le numéro IMEI (15 chiffres) est conservé séparément dans sa fiche pour la garantie et le SAV.
                  </p>
                </div>
              </div>

              {/* Physical Condition Grade Selector */}
              <div className="space-y-1.5">
                <label className="text-[11px] text-pos-muted block font-semibold">Grade d'État Physique & Cosmétique</label>
                <div className="grid grid-cols-2 gap-2">
                  {CONDITION_GRADES.map((g) => (
                    <button
                      key={g.grade}
                      type="button"
                      onClick={() => setGrade(g.grade)}
                      className={`min-h-[64px] p-2.5 rounded-xl border text-left transition cursor-pointer active:scale-95 ${
                        grade === g.grade ? g.color : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                      }`}
                    >
                      <div className="font-extrabold text-xs mb-0.5">{g.grade}</div>
                      <div className="text-[10px] opacity-80 leading-snug">{g.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Financial Valuation Engine */}
              <div className="bg-pos-bg border border-pos-border rounded-xl p-3 sm:p-3.5 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:items-center">
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Prix de Rachat Cash (DA)</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      required
                      value={buybackValue}
                      onChange={(e) => setBuybackValue(parseFloat(e.target.value) || 0)}
                      className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Majoration Revente (%)</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="1"
                      required
                      value={resaleMarginPercent}
                      onChange={(e) => setResaleMarginPercent(parseFloat(e.target.value) || 0)}
                      className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-bold text-cyan-400 focus:border-emerald-400 focus:outline-none"
                    />
                  </div>

                  <div className="col-span-2 sm:col-span-1 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-3 py-2 sm:bg-transparent sm:border-0 sm:p-0 text-left sm:text-right flex sm:block items-center justify-between gap-2">
                    <span className="text-[10px] text-pos-muted uppercase font-bold block">Profit Bruto Estimé</span>
                    <span className="text-lg sm:text-base font-black text-cyan-400 whitespace-nowrap">{formatDZD(estimatedProfit)}</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-pos-border flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-pos-text min-h-[44px]">
                    <input
                      type="checkbox"
                      checked={creditToWallet}
                      onChange={(e) => setCreditToWallet(e.target.checked)}
                      className="w-5 h-5 shrink-0 text-emerald-500 rounded border-pos-border bg-pos-card cursor-pointer"
                    />
                    <Wallet className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>Verser en Avoir Client (+10% Bonus Fidélité Offert)</span>
                  </label>
                  {creditToWallet && buybackValue > 0 ? (
                    <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/30 self-start sm:self-auto">
                      Montant Avoir Crédité : {formatDZD(finalBuybackValue)} (+{formatDZD(finalBuybackValue - buybackValue)})
                    </span>
                  ) : (
                    <span className="text-[10px] text-pos-muted">Bonus de +10% offert si versé sur le compte client</span>
                  )}
                </div>
              </div>

              {/* Final Submit & Stock Injection Card */}
              <div className="bg-pos-bg border border-emerald-500/30 p-3.5 sm:p-4 rounded-2xl flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mt-4">
                <div className="flex items-baseline justify-between sm:block gap-2">
                  <span className="text-[10px] text-pos-muted uppercase font-extrabold block">Prix de Revente Estimé en Magasin</span>
                  <span className="text-2xl font-black text-amber-400 whitespace-nowrap">{formatDZD(suggestedSellingPrice)}</span>
                </div>
                <button
                  type="submit"
                  className="w-full sm:w-auto min-h-[52px] px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm sm:text-xs flex items-center justify-center gap-2 transition shadow-lg shadow-emerald-500/20 cursor-pointer active:scale-[0.98]"
                >
                  <CheckCircle2 className="w-5 h-5 sm:w-4 sm:h-4" /> Racheter & Injecter au Stock d'Occasion
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4 max-w-3xl mx-auto">
              {/* History Search Bar */}
              <div className="bg-pos-card border border-pos-border p-3 rounded-2xl flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                  <input
                    type="text"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    placeholder="Rechercher par Modèle, IMEI, Marque, Vendeur..."
                    className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-2 text-base sm:text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none"
                  />
                </div>
              </div>

              {/* History Items Cards */}
              {(filteredTradeIns || []).length === 0 ? (
                <div className="text-center text-pos-muted text-xs py-12 bg-pos-card border border-pos-border rounded-2xl">
                  <RefreshCw className="w-8 h-8 opacity-40 mx-auto mb-2" />
                  <p className="font-semibold">Aucune reprise ne correspond à votre recherche.</p>
                </div>
              ) : (
                (filteredTradeIns || []).map((trade) => (
                  <div key={trade.id} className="bg-pos-card border border-pos-border p-3.5 sm:p-4 rounded-2xl flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 text-xs shadow-sm hover:border-emerald-500/40 transition">
                    <div className="min-w-0">
                      <div className="font-extrabold text-pos-text text-sm mb-1 flex items-center gap-2 flex-wrap">
                        {trade.deviceModel}
                        <span className="text-[10px] bg-pos-bg border border-pos-border px-2 py-0.5 rounded text-pos-muted font-normal">
                          {trade.brand}
                        </span>
                      </div>

                      <div className="text-pos-muted mb-1 text-xs">
                        IMEI: <span className="font-mono font-bold text-emerald-400">{trade.imei}</span>
                        {trade.barcode && (
                          <> • Code-barres: <span className="font-mono font-semibold text-pos-text">{trade.barcode}</span></>
                        )}{' '}
                        • <span className="font-semibold text-pos-text">{trade.conditionGrade}</span>
                      </div>

                      <div className="text-pos-muted text-[10px] font-semibold">
                        Vendeur: <span className="text-pos-text font-bold">{trade.customerName}</span>{' '}
                        {trade.creditToWallet ? (
                          <span className="text-cyan-400 font-bold">(Versé en Wallet)</span>
                        ) : (
                          <span className="text-emerald-400 font-bold">(Payé Cash)</span>
                        )}{' '}
                        • {formatDateTime(trade.createdAt)}
                      </div>
                    </div>

                    <div className="flex sm:flex-row items-center gap-3 sm:gap-4 border-t sm:border-t-0 border-pos-border/60 pt-2.5 sm:pt-0">
                      <div className="flex sm:block items-baseline gap-3 sm:gap-0 text-left sm:text-right flex-1">
                        <div className="text-[10px] text-pos-muted uppercase font-bold">Prix Rachat</div>
                        <div className="font-black text-emerald-400 text-base">{formatDZD(trade.buybackValue)}</div>
                        <div className="text-[10px] text-pos-muted mt-0 sm:mt-1 uppercase font-bold">Revente Prévue</div>
                        <div className="font-black text-amber-400">{formatDZD(trade.resalePrice)}</div>
                      </div>

                      <button
                        onClick={() => handlePrintContract(trade)}
                        className="min-h-[48px] min-w-[48px] sm:min-w-0 px-3 rounded-xl bg-pos-bg hover:bg-emerald-500/20 text-pos-muted hover:text-emerald-400 border border-pos-border transition flex items-center justify-center gap-2 active:scale-95"
                        title="Imprimer l'attestation de cession"
                      >
                        <Printer className="w-4 h-4" />
                        <span className="sm:hidden text-xs font-bold">Imprimer</span>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Dedicated A4 Trade-In Cession Contract Print Template */}
        {printingTrade && (
          <div className="print-tradein-target hidden print:block bg-white text-black p-2 font-sans text-xs">
            <div className="doc-banner">
              <div>
                <p className="doc-title">{receiptSettings.storeName || 'MOBI ACCESSORIES'}</p>
                <p className="doc-sub">Département Achat & Reprise d'Occasion • Tél: {receiptSettings.phone}</p>
              </div>
              <div className="doc-refbox">
                <p className="doc-reftype">Attestation officielle de cession</p>
                <p className="doc-ref">Réf {printingTrade.id}</p>
                <p className="doc-refdate">{formatDateTime(printingTrade.createdAt)}</p>
              </div>
            </div>

            <div className="doc-grid2">
              <div className="doc-card">
                <p className="doc-label">Cédant / propriétaire vendeur</p>
                <p className="doc-value">{printingTrade.customerName}</p>
                <p className="doc-muted">Règlement : {printingTrade.creditToWallet ? 'Crédit Portefeuille (Wallet)' : 'Espèces (Comptant)'}</p>
              </div>
              <div className="doc-card">
                <p className="doc-label">Appareil vendu & identifiants</p>
                <p className="doc-value">{printingTrade.deviceModel} ({printingTrade.brand})</p>
                <p className="doc-muted" style={{ fontFamily: 'monospace' }}>N° IMEI : {printingTrade.imei} • État : {printingTrade.conditionGrade}</p>
              </div>
            </div>

            <div className="doc-totalband">
              <span className="doc-totallabel">Montant net de reprise / achat</span>
              <span className="doc-totalval">{formatDZD(printingTrade.buybackValue)}</span>
            </div>

            <div className="doc-notebox">
              <p className="doc-terms">1. Le cédant certifie sur l'honneur être le propriétaire légitime et exclusif de l'appareil désigné ci-dessus.</p>
              <p className="doc-terms">2. L'appareil est cédé libre de tout gage, compte iCloud/Google verrouillé ou déclaration de vol.</p>
              <p className="doc-terms">3. La transaction est ferme et irrévocable dès signature et versement du montant convenu.</p>
            </div>

            <div className="doc-sign">
              <div>
                <p className="doc-signlabel">Signature du cédant (précédée de "Lu et approuvé")</p>
                <div className="doc-signline" />
              </div>
              <div>
                <p className="doc-signlabel">Cachet & signature MOBI ACCESSORIES</p>
                <div className="doc-signline" />
              </div>
            </div>

            <div className="doc-footer">
              <span>{receiptSettings.storeName || 'MOBI ACCESSORIES'} • Tél: {receiptSettings.phone}</span>
              <span>Réf {printingTrade.id}</span>
              <span>Document généré par Mobi-POS</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

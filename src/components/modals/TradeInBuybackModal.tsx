import React, { useState } from 'react';
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
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { BrandName, ConditionGrade, TradeInItem } from '../../types/pos';
import { printCoordinator } from '../../utils/printCoordinator';

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
  const { activeModal, closeModal, processTradeIn, tradeIns, customers, receiptSettings } = usePosStore();

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
  const [brand, setBrand] = useState<BrandName>('Apple');
  const [grade, setGrade] = useState<ConditionGrade>('Grade B (Bon État)');
  const [buybackValue, setBuybackValue] = useState<number>(0);
  const [resaleMarginPercent, setResaleMarginPercent] = useState<number>(30);
  const [creditToWallet, setCreditToWallet] = useState<boolean>(false);

  if (activeModal !== 'trade_in_buyback') return null;

  // KPI Computations
  const totalTradeIns = tradeIns.length;
  const totalBuybackCapital = tradeIns.reduce((acc, t) => acc + t.buybackValue, 0);
  const totalProjectedResale = tradeIns.reduce((acc, t) => acc + t.resalePrice, 0);
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

  const handleSubmitTradeIn = (e: React.FormEvent) => {
    e.preventDefault();
    if (buybackValue <= 0) return;
    
    processTradeIn({
      customerName: customerPhone ? `${customerName} (${customerPhone})` : customerName,
      deviceModel,
      imei,
      brand,
      conditionGrade: grade,
      buybackValue: finalBuybackValue,
      resaleMarginPercent,
      creditToWallet
    });
    
    showSuccess(`Reprise de ${deviceModel} enregistrée ! Produit injecté dans le catalogue d'occasion (Avoir +10% appliqué).`);
    resetForm();
  };

  const handlePrintContract = (trade: TradeInItem) => {
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
      trade.customerName.toLowerCase().includes(q) ||
      trade.brand.toLowerCase().includes(q)
    );
  });

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[90vh] flex flex-col">
        
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20">
              <RefreshCw className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2">
                STUDIO DE REPRISE & TRADE-IN OCCASION
                <span className="text-[10px] bg-emerald-500/10 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-500/30">
                  ENTERPRISE
                </span>
              </h2>
              <p className="text-[11px] text-pos-muted">Évaluation d'état, rachat cash/wallet et injection automatique au stock d'occasion</p>
            </div>
          </div>
          <button onClick={closeModal} className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Executive KPI Bar */}
        <div className="bg-pos-bg border-b border-pos-border px-4 py-2.5 grid grid-cols-4 gap-3 shrink-0 text-center select-none">
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
        <div className="flex border-b border-pos-border bg-pos-panel px-4 shrink-0">
          <button
            onClick={() => setActiveTab('Nouvelle')}
            className={`px-4 py-3 text-xs font-bold border-b-2 transition-colors ${activeTab === 'Nouvelle' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
          >
            <div className="flex items-center gap-2"><Plus className="w-4 h-4" /> Nouvelle Évaluation & Rachat</div>
          </button>
          <button
            onClick={() => setActiveTab('Historique')}
            className={`px-4 py-3 text-xs font-bold border-b-2 transition-colors ${activeTab === 'Historique' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
          >
            <div className="flex items-center gap-2"><History className="w-4 h-4" /> Journal des Reprises ({tradeIns.length})</div>
          </button>
        </div>

        {/* Content Form */}
        <div className="flex-1 overflow-y-auto p-5 relative bg-pos-bg">
          {successMsg && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-emerald-500/20 border border-emerald-500/60 text-emerald-300 px-5 py-2.5 rounded-full text-xs font-bold flex items-center gap-2 z-20 shadow-lg animate-in fade-in slide-in-from-top-4">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" /> {successMsg}
            </div>
          )}

          {activeTab === 'Nouvelle' ? (
            <form onSubmit={handleSubmitTradeIn} className="space-y-4 max-w-3xl mx-auto bg-pos-card border border-pos-border rounded-2xl p-5 shadow-md">
              
              {/* Customer Toolbar */}
              <div className="bg-pos-bg p-3.5 rounded-xl border border-pos-border space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                    <UserCheck className="w-4 h-4 text-emerald-400" /> Informations du Client Vendeur
                  </span>
                  {customers.length > 0 && (
                    <select
                      onChange={(e) => handleSelectCustomer(e.target.value)}
                      className="bg-pos-card border border-pos-border text-pos-text text-xs rounded-lg px-2.5 py-1 focus:border-emerald-400 focus:outline-none"
                    >
                      <option value="">Sélectionner un client du répertoire...</option>
                      {customers.map(c => (
                        <option key={c.id} value={c.id}>{c.name} ({c.phone})</option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Nom & Prénom du Client</label>
                    <input
                      type="text"
                      required
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                      placeholder="Ex: Karim Hadj"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Téléphone Vendeur</label>
                    <input
                      type="text"
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                      className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                      placeholder="Ex: 0661 88 99 00"
                    />
                  </div>
                </div>
              </div>

              {/* Device Identification & Presets */}
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Marque Constructeur</label>
                    <select
                      value={brand}
                      onChange={(e) => setBrand(e.target.value as BrandName)}
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer"
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
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                      placeholder="ex: iPhone 14 Pro Max"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">IMEI Unique (15 chiffres)</label>
                    <input
                      type="text"
                      required
                      value={imei}
                      onChange={(e) => setImei(e.target.value)}
                      className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-mono font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
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
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold border transition shrink-0 ${
                        deviceModel === preset.model
                          ? 'bg-emerald-500 text-slate-950 border-emerald-400 font-bold'
                          : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                      }`}
                    >
                      {preset.model}
                    </button>
                  ))}
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
                      className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                        grade === g.grade ? g.color : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                      }`}
                    >
                      <div className="font-extrabold text-xs mb-0.5">{g.grade}</div>
                      <div className="text-[10px] opacity-80">{g.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Financial Valuation Engine */}
              <div className="bg-pos-bg border border-pos-border rounded-xl p-3.5 space-y-3">
                <div className="grid grid-cols-3 gap-3 items-center">
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Prix de Rachat Cash (DA)</label>
                    <input
                      type="number"
                      step="500"
                      required
                      value={buybackValue}
                      onChange={(e) => setBuybackValue(parseFloat(e.target.value) || 0)}
                      className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Marge de Revente (%)</label>
                    <input
                      type="number"
                      step="1"
                      required
                      value={resaleMarginPercent}
                      onChange={(e) => setResaleMarginPercent(parseFloat(e.target.value) || 0)}
                      className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-cyan-400 focus:border-emerald-400 focus:outline-none"
                    />
                  </div>

                  <div className="text-right">
                    <span className="text-[10px] text-pos-muted uppercase font-bold block">Profit Bruto Estimé</span>
                    <span className="text-base font-black text-cyan-400">{formatDZD(estimatedProfit)}</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-pos-border flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-pos-text">
                    <input
                      type="checkbox"
                      checked={creditToWallet}
                      onChange={(e) => setCreditToWallet(e.target.checked)}
                      className="w-4 h-4 text-emerald-500 rounded border-pos-border bg-pos-card cursor-pointer"
                    />
                    <Wallet className="w-4 h-4 text-cyan-400" />
                    <span>Verser en Avoir Client (+10% Bonus Fidélité Offert)</span>
                  </label>
                  {creditToWallet && buybackValue > 0 ? (
                    <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                      Montant Avoir Crédité : {formatDZD(finalBuybackValue)} (+{formatDZD(finalBuybackValue - buybackValue)})
                    </span>
                  ) : (
                    <span className="text-[10px] text-pos-muted">Bonus de +10% offert si versé sur le compte client</span>
                  )}
                </div>
              </div>

              {/* Final Submit & Stock Injection Card */}
              <div className="bg-pos-bg border border-emerald-500/30 p-4 rounded-2xl flex justify-between items-center mt-4">
                <div>
                  <span className="text-[10px] text-pos-muted uppercase font-extrabold block">Prix de Revente Estimé en Magasin</span>
                  <span className="text-2xl font-black text-amber-400">{formatDZD(suggestedSellingPrice)}</span>
                </div>
                <button
                  type="submit"
                  className="px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 transition shadow-lg shadow-emerald-500/20 cursor-pointer"
                >
                  <CheckCircle2 className="w-4.5 h-4.5" /> Racheter & Injecter au Stock d'Occasion
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
                    className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-2 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none"
                  />
                </div>
              </div>

              {/* History Items Cards */}
              {filteredTradeIns.length === 0 ? (
                <div className="text-center text-pos-muted text-xs py-12 bg-pos-card border border-pos-border rounded-2xl">
                  <RefreshCw className="w-8 h-8 opacity-40 mx-auto mb-2" />
                  <p className="font-semibold">Aucune reprise ne correspond à votre recherche.</p>
                </div>
              ) : (
                filteredTradeIns.map((trade) => (
                  <div key={trade.id} className="bg-pos-card border border-pos-border p-4.5 rounded-2xl flex justify-between items-center text-xs shadow-sm hover:border-emerald-500/40 transition">
                    <div>
                      <div className="font-extrabold text-pos-text text-sm mb-1 flex items-center gap-2">
                        {trade.deviceModel}
                        <span className="text-[10px] bg-pos-bg border border-pos-border px-2 py-0.5 rounded text-pos-muted font-normal">
                          {trade.brand}
                        </span>
                      </div>

                      <div className="text-pos-muted mb-1 text-xs">
                        IMEI: <span className="font-mono font-bold text-emerald-400">{trade.imei}</span> •{' '}
                        <span className="font-semibold text-pos-text">{trade.conditionGrade}</span>
                      </div>

                      <div className="text-pos-muted text-[10px] font-semibold">
                        Vendeur: <span className="text-pos-text font-bold">{trade.customerName}</span>{' '}
                        {trade.creditToWallet ? (
                          <span className="text-cyan-400 font-bold">(Versé en Wallet)</span>
                        ) : (
                          <span className="text-emerald-400 font-bold">(Payé Cash)</span>
                        )}{' '}
                        • {trade.createdAt}
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-[10px] text-pos-muted uppercase font-bold">Prix Rachat</div>
                        <div className="font-black text-emerald-400 text-base">{formatDZD(trade.buybackValue)}</div>
                        <div className="text-[10px] text-pos-muted mt-1 uppercase font-bold">Revente Prévue</div>
                        <div className="font-black text-amber-400">{formatDZD(trade.resalePrice)}</div>
                      </div>

                      <button
                        onClick={() => handlePrintContract(trade)}
                        className="p-2.5 rounded-xl bg-pos-bg hover:bg-emerald-500/20 text-pos-muted hover:text-emerald-400 border border-pos-border transition"
                        title="Imprimer l'attestation de cession"
                      >
                        <Printer className="w-4 h-4" />
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
          <div className="print-tradein-target hidden print:block bg-white text-black p-8 font-sans text-xs">
            {/* Header */}
            <div className="flex justify-between items-start border-b-2 border-black pb-4 mb-6">
              <div>
                <h1 className="text-xl font-black uppercase">{receiptSettings.storeName || 'MOBI ACCESSORIES'}</h1>
                <p className="text-gray-600 text-xs">Département Achat & Reprise d'Occasion</p>
                <p className="text-gray-600 text-xs">Tél: {receiptSettings.phone}</p>
              </div>
              <div className="text-right bg-gray-100 p-3 rounded border border-gray-300">
                <p className="text-xs font-black uppercase text-black">ATTESTATION OFFICIELLE DE CESSION</p>
                <p className="text-xs font-bold text-gray-900 mt-1">Réf: {printingTrade.id}</p>
                <p className="text-[10px] text-gray-600">Date: {printingTrade.createdAt}</p>
              </div>
            </div>

            {/* Seller & Device Details */}
            <div className="grid grid-cols-2 gap-4 bg-gray-50 border border-gray-200 p-4 rounded mb-6">
              <div>
                <p className="text-[10px] font-bold text-gray-500 uppercase">Cédant / Propriétaire Vendeur :</p>
                <p className="font-bold text-sm text-black">{printingTrade.customerName}</p>
                <p className="text-xs text-gray-700 mt-1">Règlement : {printingTrade.creditToWallet ? 'Crédit Portefeuille (Wallet)' : 'Espèces (Comptant)'}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold text-gray-500 uppercase">Appareil Vendu & Identifiants :</p>
                <p className="font-bold text-sm text-black">{printingTrade.deviceModel} ({printingTrade.brand})</p>
                <p className="text-xs font-mono text-emerald-700 font-bold mt-1">N° IMEI : {printingTrade.imei}</p>
                <p className="text-[10px] text-gray-600">État : {printingTrade.conditionGrade}</p>
              </div>
            </div>

            {/* Financial Value */}
            <div className="bg-gray-100 border border-gray-300 p-4 rounded mb-6 flex justify-between items-center font-mono">
              <div>
                <span className="text-xs font-bold uppercase text-gray-600">Montant Net de Reprise / Achat :</span>
              </div>
              <div>
                <span className="text-xl font-black text-black">{formatDZD(printingTrade.buybackValue)}</span>
              </div>
            </div>

            {/* Legal Cession Clauses */}
            <div className="border border-gray-300 p-3 rounded text-[9px] text-gray-600 space-y-1.5 mb-8">
              <p>1. Le cédant certifie sur l'honneur être le propriétaire légitime et exclusif de l'appareil désigné ci-dessus.</p>
              <p>2. L'appareil est cédé libre de tout gage, compte iCloud/Google verrouillé ou déclaration de vol.</p>
              <p>3. La transaction est ferme et irrévocable dès signature et versement du montant convenu.</p>
            </div>

            {/* Signatures Area */}
            <div className="grid grid-cols-2 gap-8 pt-6 border-t border-gray-400 text-center">
              <div>
                <p className="text-xs font-bold uppercase text-gray-700">Signature du Cédant (Précédée de "Lu et approuvé") :</p>
                <div className="h-16 border-b border-gray-300 mt-2" />
              </div>
              <div>
                <p className="text-xs font-bold uppercase text-gray-700">Cachet & Signature MOBI ACCESSORIES :</p>
                <div className="h-16 border-b border-gray-300 mt-2" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};


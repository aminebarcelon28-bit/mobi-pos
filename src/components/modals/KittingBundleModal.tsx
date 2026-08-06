import React, { useState } from 'react';
import {
  X,
  Package,
  ShoppingBag,
  Plus,
  Trash2,
  AlertCircle,
  Search,
  Sparkles,
  Barcode,
  CheckCircle2,
  Tag,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';

const PACK_PRESETS = [
  {
    title: 'Pack Protection Intégrale iPhone 15 Pro Max',
    barcode: '990000112233',
    suggestedPrice: 4800,
    skus: ['APC-15PM-CL', 'ZAGG-15PM-TG'],
  },
  {
    title: 'Pack Fast Charge GaN 65W + Câble Type-C',
    barcode: '990000445566',
    suggestedPrice: 6500,
    skus: ['ANK-GAN-65W', 'ANK-C2C-2M'],
  },
  {
    title: 'Pack Audio Premium (TWS + Support Alu)',
    barcode: '990000778899',
    suggestedPrice: 8900,
    skus: ['AP-PRO-2', 'STND-ALU-01'],
  },
];

export const KittingBundleModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    bundles,
    addBundleToCart,
    createBundle,
    deleteBundle,
    products,
  } = usePosStore();

  const [activeTab, setActiveTab] = useState<'Existants' | 'Créer'>('Existants');
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Search State in Existing Packs
  const [searchQuery, setSearchQuery] = useState('');

  // Form State
  const [bundleTitle, setBundleTitle] = useState('');
  const [barcode, setBarcode] = useState('');
  const [bundlePrice, setBundlePrice] = useState<number>(0);
  const [selectedSkus, setSelectedSkus] = useState<string[]>([]);
  const [skuSearch, setSkuSearch] = useState('');

  if (activeModal !== 'kitting_bundle') return null;

  // KPI Computations
  const totalBundles = bundles.length;
  let outOfStockBundlesCount = 0;
  let totalSavingsAcc = 0;

  bundles.forEach((b) => {
    let itemTotal = 0;
    let isOut = false;
    b.childSkus.forEach((sku) => {
      const p = products.find((prod) => prod.sku === sku);
      if (!p || p.stock <= 0) isOut = true;
      if (p) itemTotal += p.price;
    });
    if (isOut) outOfStockBundlesCount++;
    totalSavingsAcc += Math.max(0, itemTotal - b.bundlePrice);
  });

  const avgSavings = totalBundles > 0 ? totalSavingsAcc / totalBundles : 0;

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  const showError = (msg: string) => {
    setErrorMsg(msg);
    setTimeout(() => setErrorMsg(''), 4000);
  };

  const handleApplyPreset = (preset: typeof PACK_PRESETS[0]) => {
    setBundleTitle(preset.title);
    setBarcode(preset.barcode);
    setBundlePrice(preset.suggestedPrice);
    
    // Find matching SKUs or pick available ones
    const matchingSkus = preset.skus.filter(s => products.some(p => p.sku === s));
    if (matchingSkus.length > 0) {
      setSelectedSkus(matchingSkus);
    } else {
      // Pick first 2 available products
      setSelectedSkus(products.slice(0, 2).map(p => p.sku));
    }
  };

  const handleCreateBundle = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedSkus.length < 2) {
      showError('Un pack promotionnel doit contenir au moins 2 articles.');
      return;
    }
    if (!bundleTitle || !barcode || bundlePrice <= 0) {
      showError('Veuillez remplir tous les champs du pack.');
      return;
    }

    createBundle({
      bundleTitle,
      barcode,
      bundlePrice,
      childSkus: selectedSkus,
    });

    showSuccess(`Pack "${bundleTitle}" créé et activé !`);
    setBundleTitle('');
    setBarcode('');
    setBundlePrice(0);
    setSelectedSkus([]);
    setActiveTab('Existants');
  };

  const toggleSkuSelection = (sku: string) => {
    if (selectedSkus.includes(sku)) {
      setSelectedSkus(selectedSkus.filter((s) => s !== sku));
    } else {
      setSelectedSkus([...selectedSkus, sku]);
    }
  };

  const filteredProducts = products
    .filter(
      (p) =>
        p.title.toLowerCase().includes(skuSearch.toLowerCase()) ||
        p.sku.toLowerCase().includes(skuSearch.toLowerCase())
    )
    .slice(0, 50);

  const calculateBundleSavings = () => {
    const totalValue = selectedSkus.reduce((acc, sku) => {
      const p = products.find((prod) => prod.sku === sku);
      return acc + (p?.price || 0);
    }, 0);
    return totalValue - bundlePrice;
  };

  const rawIndividualTotal = selectedSkus.reduce((acc, sku) => {
    const p = products.find((prod) => prod.sku === sku);
    return acc + (p?.price || 0);
  }, 0);

  // Filtered Existing Bundles
  const filteredBundles = bundles.filter((b) => {
    const q = searchQuery.trim().toLowerCase();
    return (
      !q ||
      b.bundleTitle.toLowerCase().includes(q) ||
      b.barcode.toLowerCase().includes(q) ||
      b.childSkus.some((sku) => sku.toLowerCase().includes(q))
    );
  });

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[90vh] flex flex-col">
        
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20">
              <Package className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2">
                GESTIONNAIRE DE PACKS & BUNDLES (KITTING)
                <span className="text-[10px] bg-emerald-500/10 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-500/30">
                  ENTERPRISE
                </span>
              </h2>
              <p className="text-[11px] text-pos-muted">Création de bundles promotionnels, scan unique et déduction automatique du stock</p>
            </div>
          </div>
          <button onClick={closeModal} className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Executive KPI Summary Bar */}
        <div className="bg-pos-bg border-b border-pos-border px-4 py-2.5 grid grid-cols-4 gap-3 shrink-0 text-center select-none">
          <div className="bg-pos-card border border-pos-border rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-pos-muted block">Total Packs Actifs</span>
            <span className="text-sm font-black text-pos-text">{totalBundles}</span>
          </div>

          <div className="bg-pos-card border border-emerald-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-emerald-400 block">Packs Disponibles</span>
            <span className="text-sm font-black text-emerald-300">{totalBundles - outOfStockBundlesCount}</span>
          </div>

          <div className="bg-pos-card border border-amber-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-amber-400 block">En Rupture Composant</span>
            <span className="text-sm font-black text-amber-300">{outOfStockBundlesCount}</span>
          </div>

          <div className="bg-pos-card border border-cyan-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-cyan-400 block">Économie Moyenne / Pack</span>
            <span className="text-sm font-black text-cyan-300">{formatDZD(avgSavings)}</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-pos-border bg-pos-panel px-4 shrink-0">
          <button
            onClick={() => setActiveTab('Existants')}
            className={`px-4 py-3 text-xs font-bold border-b-2 transition-colors ${activeTab === 'Existants' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
          >
            Catalogues Packs & Bundles ({bundles.length})
          </button>
          <button
            onClick={() => setActiveTab('Créer')}
            className={`px-4 py-3 text-xs font-bold border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'Créer' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
          >
            <Plus className="w-4 h-4" /> Créer un Nouveau Pack
          </button>
        </div>

        {/* Notification Toast Overlay */}
        <div className="absolute top-28 left-1/2 -translate-x-1/2 z-20 w-full max-w-sm flex flex-col items-center gap-2 pointer-events-none">
          {successMsg && (
            <div className="bg-emerald-500/90 text-slate-950 px-5 py-2.5 rounded-full text-xs font-black shadow-xl text-center animate-in fade-in slide-in-from-top-4">
              {successMsg}
            </div>
          )}
          {errorMsg && (
            <div className="bg-rose-500/90 text-white px-5 py-2.5 rounded-full text-xs font-bold shadow-xl text-center flex items-center gap-1.5 animate-in fade-in slide-in-from-top-4">
              <AlertCircle className="w-4 h-4" /> {errorMsg}
            </div>
          )}
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 relative bg-pos-bg">
          {activeTab === 'Existants' ? (
            <div className="space-y-4 max-w-4xl mx-auto">
              
              {/* Search Bar */}
              <div className="bg-pos-card border border-pos-border p-3 rounded-2xl flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Rechercher par Titre de Pack, Code-barres ou SKU inclus..."
                    className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-2 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* Bundles List */}
              {filteredBundles.length === 0 ? (
                <div className="text-center text-pos-muted text-xs py-12 bg-pos-card border border-pos-border rounded-2xl">
                  <Package className="w-8 h-8 opacity-40 mx-auto mb-2" />
                  <p className="font-semibold">Aucun pack configuré dans le catalogue.</p>
                </div>
              ) : (
                filteredBundles.map((bundle) => {
                  let hasOutOfStock = false;
                  let totalValue = 0;

                  const childDetails = bundle.childSkus.map((sku) => {
                    const p = products.find((prod) => prod.sku === sku);
                    if (!p || p.stock <= 0) hasOutOfStock = true;
                    if (p) totalValue += p.price;
                    return { sku, stock: p?.stock || 0, title: p?.title || 'Produit Inconnu' };
                  });
                  const savings = totalValue - bundle.bundlePrice;

                  return (
                    <div
                      key={bundle.id}
                      className="bg-pos-card border border-pos-border p-4.5 rounded-2xl flex justify-between items-center shadow-sm hover:border-emerald-500/40 transition"
                    >
                      <div className="flex-1 mr-4">
                        <div className="flex items-center gap-2.5 mb-1">
                          <h3 className="text-sm font-extrabold text-pos-text">{bundle.bundleTitle}</h3>
                          {hasOutOfStock ? (
                            <span className="bg-rose-500/10 text-rose-400 text-[10px] px-2 py-0.5 rounded-full font-bold border border-rose-500/30 flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" /> Rupture Stock
                            </span>
                          ) : (
                            <span className="bg-emerald-500/10 text-emerald-400 text-[10px] px-2 py-0.5 rounded-full font-bold border border-emerald-500/30 flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> En Stock
                            </span>
                          )}
                        </div>

                        <p className="text-[11px] text-pos-muted font-mono mb-2 flex items-center gap-1.5">
                          <Barcode className="w-3.5 h-3.5 text-emerald-400" /> Barcode: {bundle.barcode}
                        </p>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10px] text-pos-muted font-semibold mr-1">Articles inclus:</span>
                          {childDetails.map((detail, idx) => (
                            <span
                              key={idx}
                              title={detail.title}
                              className={`text-[10px] border px-2.5 py-0.5 rounded-lg font-mono flex items-center gap-1 font-bold ${
                                detail.stock > 0
                                  ? 'bg-pos-bg text-emerald-400 border-emerald-500/30'
                                  : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                              }`}
                            >
                              {detail.sku} <span className="opacity-70">({detail.stock} dispo)</span>
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="text-right flex flex-col items-end gap-2.5 shrink-0">
                        <div>
                          <span className="text-xl font-black text-emerald-400 block">{formatDZD(bundle.bundlePrice)}</span>
                          {savings > 0 && (
                            <span className="text-[10px] text-amber-400 font-bold block">Économie: {formatDZD(savings)}</span>
                          )}
                        </div>

                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              deleteBundle(bundle.id);
                              showSuccess('Pack supprimé avec succès !');
                            }}
                            className="p-2 bg-pos-bg hover:bg-rose-500/20 text-pos-muted hover:text-rose-400 rounded-xl border border-pos-border transition"
                            title="Supprimer ce pack"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>

                          <button
                            onClick={() => {
                              const res = addBundleToCart(bundle.id);
                              if (res.success) {
                                showSuccess(`Pack "${bundle.bundleTitle}" ajouté au panier !`);
                              } else {
                                showError(res.reason || "Erreur lors de l'ajout.");
                              }
                            }}
                            disabled={hasOutOfStock}
                            className={`px-4 py-2 text-slate-950 font-bold text-xs rounded-xl transition flex items-center gap-1.5 shadow-md shadow-emerald-500/20 cursor-pointer ${
                              hasOutOfStock
                                ? 'bg-pos-muted opacity-50 cursor-not-allowed text-pos-text'
                                : 'bg-emerald-500 hover:bg-emerald-400'
                            }`}
                          >
                            <ShoppingBag className="w-4 h-4" /> Scanner (Panier)
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <form onSubmit={handleCreateBundle} className="space-y-4 max-w-3xl mx-auto bg-pos-card border border-pos-border rounded-2xl p-5 shadow-md">
              
              {/* Presets Toolbar */}
              <div className="bg-pos-bg p-3 rounded-xl border border-pos-border space-y-2">
                <span className="text-[11px] font-extrabold text-pos-text flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Modèles de Packs Pré-configurés (Templates Rapides)
                </span>
                <div className="flex items-center gap-2 overflow-x-auto">
                  {PACK_PRESETS.map((preset) => (
                    <button
                      key={preset.title}
                      type="button"
                      onClick={() => handleApplyPreset(preset)}
                      className="px-2.5 py-1 rounded-lg bg-pos-card border border-pos-border text-pos-text hover:border-emerald-400 text-[10px] font-bold shrink-0 transition"
                    >
                      {preset.title.split(' ')[0]} {preset.title.split(' ')[1]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Title & Barcode Inputs */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Nom Commercial du Pack</label>
                  <input
                    type="text"
                    required
                    value={bundleTitle}
                    onChange={(e) => setBundleTitle(e.target.value)}
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                    placeholder="Ex: Pack Protection Intégrale S24 Ultra"
                  />
                </div>

                <div>
                  <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Code-barres Unique du Pack</label>
                  <input
                    type="text"
                    required
                    value={barcode}
                    onChange={(e) => setBarcode(e.target.value)}
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-mono font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
                    placeholder="Ex: 990000112233"
                  />
                </div>
              </div>

              {/* Selling Price */}
              <div>
                <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Prix de Vente Forfaitaire du Pack (DA)</label>
                <input
                  type="number"
                  step="100"
                  required
                  value={bundlePrice}
                  onChange={(e) => setBundlePrice(parseFloat(e.target.value) || 0)}
                  className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-extrabold text-emerald-400 focus:border-emerald-400 focus:outline-none"
                />
              </div>

              {/* Product Selector Table */}
              <div className="border border-pos-border rounded-xl p-3.5 bg-pos-bg flex flex-col gap-2.5 h-64">
                <div className="flex justify-between items-center">
                  <label className="text-xs text-pos-text font-extrabold flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-emerald-400" /> Sélectionner les Composants Inclus ({selectedSkus.length})
                  </label>
                  <span className="text-[10px] text-pos-muted font-mono">Minimum 2 articles</span>
                </div>

                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                  <input
                    type="text"
                    value={skuSearch}
                    onChange={(e) => setSkuSearch(e.target.value)}
                    placeholder="Rechercher par Titre ou SKU..."
                    className="w-full bg-pos-card border border-pos-border rounded-lg pl-8 pr-3 py-1.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                  />
                </div>

                <div className="flex-1 overflow-y-auto space-y-1 pr-1">
                  {filteredProducts.map((p) => {
                    const isSelected = selectedSkus.includes(p.sku);
                    return (
                      <div
                        key={p.id}
                        onClick={() => toggleSkuSelection(p.sku)}
                        className={`p-2 rounded-lg border text-xs cursor-pointer flex justify-between items-center transition ${
                          isSelected
                            ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300 font-bold'
                            : 'bg-pos-card border-pos-border text-pos-text hover:border-emerald-500/40'
                        }`}
                      >
                        <div>
                          <span>{p.title}</span>
                          <span className="text-[10px] text-pos-muted font-mono ml-2">({p.sku})</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-[10px] font-bold text-pos-muted">{formatDZD(p.price)}</span>
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                              p.stock > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                            }`}
                          >
                            Dispo: {p.stock}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Financial Savings Card */}
              <div className="flex justify-between items-center bg-pos-bg border border-pos-border p-4 rounded-2xl">
                <div>
                  <span className="text-[10px] text-pos-muted uppercase font-bold block">Prix Séparés Cumulé</span>
                  <span className="text-xs font-bold text-pos-text block mb-1">{formatDZD(rawIndividualTotal)}</span>
                  <span className="text-[10px] text-pos-muted uppercase font-bold block">Économie Client Bénéficiée</span>
                  <span className={`text-lg font-black ${calculateBundleSavings() > 0 ? 'text-amber-400' : 'text-pos-muted'}`}>
                    {calculateBundleSavings() > 0 ? formatDZD(calculateBundleSavings()) : 'Aucune'}
                  </span>
                </div>

                <button
                  type="submit"
                  className="px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/20 cursor-pointer"
                >
                  <Plus className="w-4 h-4" /> Créer & Activer ce Pack
                </button>
              </div>

            </form>
          )}
        </div>
      </div>
    </div>
  );
};


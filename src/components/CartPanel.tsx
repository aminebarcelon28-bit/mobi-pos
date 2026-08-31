import React, { useMemo, useState } from 'react';
import { Trash2, Plus, Minus, Tag, Banknote, Percent, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { formatDZD } from '../types/pos';
import type { PricingTier } from '../types/pos';
import { soundEngine } from '../utils/audioFeedback';
import { printCoordinator } from '../utils/printCoordinator';

export const CartPanel: React.FC = () => {
  const {
    cart,
    updateCartQty,
    setCartItemQty,
    removeFromCart,
    clearCart,
    openModal,
    pricingTier,
    setPricingTier,
    products,
    addToCart,
    currentCustomer,
    redeemLoyaltyPoints,
    processPayment,
    applyCartDiscountPercent,
  } = usePosStore();

  const [isDiscountOpen, setIsDiscountOpen] = useState(false);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);

  // Calculate gross total based on active pricing tier
  const getItemPrice = (item: typeof cart[0]) => {
    if (item.appliedPrice !== undefined) return item.appliedPrice;
    return pricingTier === 'Wholesale' ? item.product.wholesalePrice || item.product.price * 0.75 : item.product.price;
  };

  const grossTotal = cart.reduce((acc, item) => acc + getItemPrice(item) * item.quantity, 0);
  const totalDiscount = cart.reduce((acc, item) => acc + (item.discount || 0), 0);
  const subtotal = Math.max(0, grossTotal - totalDiscount);
  const total = subtotal;

  const quickBills = [500, 1000, 2000, 5000, 10000];

  const handleClearCart = () => {
    if (cart.length === 0) return;
    const totalItems = cart.reduce((acc, i) => acc + i.quantity, 0);
    if (totalItems > 1) {
      const ok = window.confirm(`Voulez-vous vraiment vider les ${totalItems} articles de la vente en cours ?`);
      if (!ok) return;
    }
    soundEngine.playKeyBeep?.();
    clearCart();
  };

  // Determine primary device model & recommended products with useMemo
  const { primaryModel, recommendedProducts } = useMemo(() => {
    const deviceModelCounts: Record<string, number> = {};
    cart.forEach(item => {
      const model = item.product.compatibleModel;
      if (model && model !== 'Universel' && model !== 'N/A') {
        deviceModelCounts[model] = (deviceModelCounts[model] || 0) + item.quantity;
      }
    });

    let mainModel = '';
    let maxCount = 0;
    for (const [model, count] of Object.entries(deviceModelCounts)) {
      if (count > maxCount) {
        maxCount = count;
        mainModel = model;
      }
    }

    const cartProductIds = new Set(cart.map(item => item.product.id));
    const recs = mainModel
      ? products.filter(p => p.compatibleModel === mainModel && !cartProductIds.has(p.id) && p.stock > 0).slice(0, 4)
      : [];

    return { primaryModel: mainModel, recommendedProducts: recs };
  }, [cart, products]);

  const handleQuickCashWithBill = async (billAmount: number) => {
    if (cart.length === 0) return;
    const hasMissingIMEI = cart.some((item) => item.product.isSerialized && (!item.imeiNumber || !item.imeiNumber.trim()));
    if (hasMissingIMEI) {
      openModal('payment');
      return;
    }
    const res = await processPayment([{ method: 'Espèces', amount: billAmount }]);
    if (res && res.success) {
      printCoordinator.printReceipt(50);
    }
  };

  return (
    <div className="w-[390px] bg-pos-panel border-r border-pos-border flex flex-col h-full select-none transition-colors duration-200">
      {/* Cart Header & Pricing Tier Selector */}
      <div className="p-3 border-b border-pos-border space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="font-bold text-sm text-pos-text tracking-wider uppercase">Vente en Cours</h2>
            <span className="bg-pos-card border border-pos-border text-emerald-500 text-xs font-bold px-2 py-0.5 rounded-full">
              {cart.reduce((acc, i) => acc + i.quantity, 0)} Articles
            </span>
          </div>
          {cart.length > 0 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setIsDiscountOpen(!isDiscountOpen)}
                className={`p-1.5 rounded-lg border transition text-xs font-bold flex items-center gap-1 cursor-pointer ${
                  isDiscountOpen ? 'bg-purple-500/20 text-purple-300 border-purple-500/50' : 'bg-pos-card text-pos-muted hover:text-pos-text border-pos-border'
                }`}
                title="Appliquer une remise globale"
              >
                <Percent className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleClearCart}
                className="p-1.5 hover:bg-red-500/10 text-pos-muted hover:text-red-400 rounded-lg transition cursor-pointer"
                title="Vider le panier (Confirmation requise)"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Global Discount Quick Strip */}
        {isDiscountOpen && cart.length > 0 && (
          <div className="bg-purple-950/40 border border-purple-500/40 rounded-xl p-2.5 space-y-2 animate-in fade-in slide-in-from-top-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-purple-300 flex items-center gap-1">
                <Percent className="w-3.5 h-3.5" /> Remise Globale Panier
              </span>
              <span className="text-[10px] text-purple-200">Applicable immédiatement</span>
            </div>
            <div className="flex items-center gap-1.5">
              {[5, 10, 15, 20].map((pct) => (
                <button
                  key={pct}
                  onClick={() => {
                    applyCartDiscountPercent(pct);
                    setIsDiscountOpen(false);
                  }}
                  className="flex-1 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/40 text-xs font-black transition cursor-pointer"
                >
                  -{pct}%
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Customer Badge & Loyalty Points Widget */}
        {currentCustomer && (
          <div className="bg-pos-card border border-pos-border p-2 rounded-xl flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 truncate">
              <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[10px]">
                {currentCustomer.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="truncate">
                <p className="font-bold text-pos-text truncate">{currentCustomer.name}</p>
                <p className="text-[9px] text-pos-muted">{currentCustomer.loyaltyPoints} pts de fidélité • Solde: {formatDZD(currentCustomer.storeCredit)}</p>
              </div>
            </div>
            {currentCustomer.loyaltyPoints >= 10 && (
              <button
                type="button"
                onClick={() => redeemLoyaltyPoints(currentCustomer.id, 10)}
                className="px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-300 font-bold text-[10px] rounded-lg transition shrink-0 cursor-pointer"
              >
                Convertir 10 pts (+100 DA)
              </button>
            )}
          </div>
        )}

        {/* Pricing Tier Selector (Retail / Wholesale / B2B) */}
        <div className="flex items-center gap-1.5 bg-pos-bg p-1 rounded-xl border border-pos-border">
          <Tag className="w-3.5 h-3.5 text-emerald-500 ml-1.5 shrink-0" />
          <span className="text-[10px] font-bold text-pos-muted uppercase">Tarif:</span>
          {(['Retail', 'Wholesale'] as PricingTier[]).map((tier) => (
            <button
              key={tier}
              onClick={() => setPricingTier(tier)}
              className={`flex-1 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                pricingTier === tier
                  ? 'bg-emerald-500 text-slate-950 shadow-sm'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              {tier === 'Retail' ? 'Détail' : 'Gros B2B'}
            </button>
          ))}
        </div>
      </div>

      {/* Cart Items List */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
        {cart.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-pos-muted space-y-2 p-4 text-center">
            <div className="w-12 h-12 rounded-full bg-pos-card flex items-center justify-center border border-pos-border">
              <Trash2 className="w-5 h-5 opacity-50" />
            </div>
            <p className="text-xs font-semibold">Panier vide. Scannez un article ou choisissez dans le catalogue.</p>
          </div>
        ) : (
          cart.map((item) => {
            const unitPrice = getItemPrice(item);
            return (
              <div
                key={item.product.id}
                className="bg-pos-card border border-pos-border/80 rounded-xl p-2.5 flex items-start gap-2.5 hover:border-emerald-500/40 transition group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start gap-1">
                    <h3 className="text-xs font-semibold text-pos-text truncate leading-tight" title={item.product.title}>
                      {item.product.title}
                    </h3>
                    <span className="text-xs font-black text-pos-text pl-1 shrink-0 font-mono">
                      {formatDZD(unitPrice * item.quantity - item.discount)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] text-pos-muted truncate font-bold">{item.product.brand}</span>
                    {pricingTier === 'Wholesale' && (
                      <span className="text-[8.5px] bg-amber-500/10 text-amber-500 font-bold px-1 rounded border border-amber-500/30 shrink-0">
                        Gros
                      </span>
                    )}
                    <span className="text-[9.5px] text-pos-muted font-mono truncate">Réf: {item.product.sku}</span>
                  </div>

                  {/* Quantity Stepper & Actions */}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-pos-border/40 gap-2">
                    <div className="flex items-center gap-1 bg-pos-bg border border-pos-border rounded-xl p-1 shadow-inner">
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.playScan();
                          updateCartQty(item.product.id, -1);
                        }}
                        className="w-7 h-7 rounded-lg bg-pos-card hover:bg-pos-hover active:scale-95 text-pos-muted hover:text-pos-text border border-pos-border/60 flex items-center justify-center transition cursor-pointer"
                        title="Diminuer quantité (-1)"
                      >
                        <Minus className="w-3.5 h-3.5 stroke-[2.5]" />
                      </button>
                      <input
                        type="number"
                        min="1"
                        max={item.product.stock > 0 ? item.product.stock : 9999}
                        value={item.quantity}
                        disabled={item.product.isSerialized}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          if (!isNaN(val) && val >= 1) {
                            setCartItemQty(item.product.id, val);
                          }
                        }}
                        className="w-10 text-center text-xs font-black text-pos-text bg-transparent focus:bg-pos-card rounded-md border-none focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono py-0.5"
                        title={item.product.isSerialized ? '1 appareil par IMEI' : `Saisir quantité directement (Stock dispo: ${item.product.stock})`}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          soundEngine.playScan();
                          updateCartQty(item.product.id, 1);
                        }}
                        disabled={item.product.isSerialized}
                        className="w-7 h-7 rounded-lg bg-pos-card hover:bg-emerald-500/20 active:scale-95 text-pos-muted hover:text-emerald-400 border border-pos-border/60 flex items-center justify-center transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Augmenter quantité (+1)"
                      >
                        <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.playKeyBeep?.();
                        removeFromCart(item.product.id);
                      }}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/40 transition cursor-pointer"
                      title="Retirer cet article de la vente"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Supprimer</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Totals Summary & Compact Payment Controls */}
      <div className="p-3 border-t border-pos-border bg-pos-panel space-y-2 shrink-0">
        {/* Breakdown of Subtotal and Discounts if active */}
        {totalDiscount > 0 && (
          <div className="space-y-1 pb-1.5 border-b border-pos-border/40 text-xs">
            <div className="flex justify-between items-center text-pos-muted">
              <span className="text-[11px] font-semibold">Sous-Total Brut :</span>
              <span className="font-mono font-bold">{formatDZD(grossTotal)}</span>
            </div>
            <div className="flex justify-between items-center text-purple-400 font-bold">
              <span className="text-[11px] flex items-center gap-1">
                <Percent className="w-3 h-3" /> Remise Accordée :
              </span>
              <span className="font-mono">-{formatDZD(totalDiscount)}</span>
            </div>
          </div>
        )}

        {/* Total Net Header - 1-Second Glance Dominance */}
        <div className="flex justify-between items-baseline pt-0.5">
          <div>
            <span className="text-xs font-black text-pos-text tracking-wider uppercase block">
              Total Net à Payer
            </span>
            <span className="text-[10px] text-pos-muted font-medium">TTC • Rendu auto</span>
          </div>
          <span className="text-2xl md:text-3xl font-black text-emerald-400 tracking-tight font-mono">
            {formatDZD(total)}
          </span>
        </div>

        {/* Compact Quick Cash Denominations (1-Click Change Calculator) */}
        {cart.length > 0 && (
          <div className="space-y-1">
            <span className="text-[9px] text-pos-muted uppercase font-bold tracking-wider block">
              Coupures Rapides (Espèces) :
            </span>
            <div className="grid grid-cols-5 gap-1">
              {quickBills.map((bill) => {
                const isUnder = bill < total;
                return (
                  <button
                    key={bill}
                    disabled={isUnder}
                    onClick={() => handleQuickCashWithBill(bill)}
                    className={`py-1.5 px-1 rounded-lg text-[9.5px] font-extrabold border transition cursor-pointer flex flex-col items-center justify-center font-mono ${
                      isUnder
                        ? 'opacity-30 bg-pos-bg border-pos-border text-pos-muted cursor-not-allowed'
                        : 'bg-pos-card hover:bg-emerald-500/20 border-pos-border hover:border-emerald-500/50 text-pos-text hover:text-emerald-300'
                    }`}
                    title={isUnder ? 'Montant inférieur au total' : `Encaisser ${bill} DA (Rendu: ${bill - total} DA)`}
                  >
                    <span>{bill.toLocaleString('fr-DZ')}</span>
                    {!isUnder && bill > total && (
                      <span className="text-[7.5px] text-emerald-400 font-normal leading-none">+{bill - total}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Primary Cash Payment Button */}
        <div className="pt-0.5">
          <button
            onClick={() => openModal('payment')}
            disabled={cart.length === 0}
            className="w-full glow-btn bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 text-white rounded-xl py-3 px-3 flex items-center justify-between shadow-md shadow-emerald-600/25 group cursor-pointer transition"
            title="Encaissement en Espèces & Calcul Rendu de Monnaie - F3"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Banknote className="w-5 h-5 text-emerald-200 shrink-0" />
              <span className="text-xs font-black tracking-wide truncate">Encaisser en Espèces</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-emerald-200 font-bold uppercase tracking-wider bg-black/30 px-1.5 py-0.5 rounded border border-white/10">
                Cash Only
              </span>
              <span className="hotkey-badge bg-black/50 text-emerald-200 border-white/20 px-2 py-0.5 text-[10px] font-black shrink-0">
                F3
              </span>
            </div>
          </button>
        </div>
      </div>

      {/* Suggested Products Drawer (Collapsible) */}
      {recommendedProducts.length > 0 && (
        <div className="border-t border-pos-border bg-pos-panel/60 shrink-0">
          <button
            onClick={() => setIsSuggestionsOpen(!isSuggestionsOpen)}
            className="w-full px-3 py-1.5 flex items-center justify-between text-xs font-bold text-emerald-500 hover:bg-pos-card transition cursor-pointer"
          >
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              <span className="text-[10.5px] uppercase tracking-wide">Suggérés ({primaryModel})</span>
              <span className="bg-emerald-500/20 text-emerald-400 text-[10px] px-1.5 py-0.2 rounded-full font-bold">
                {recommendedProducts.length}
              </span>
            </div>
            {isSuggestionsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>

          {isSuggestionsOpen && (
            <div className="p-2 pt-0 flex gap-2 overflow-x-auto pb-1.5 hide-scrollbar animate-in fade-in slide-in-from-bottom-2">
              {recommendedProducts.map((prod) => (
                <div
                  key={prod.id}
                  className="min-w-[130px] bg-pos-card border border-pos-border rounded-lg p-1.5 flex flex-col gap-1 shrink-0 hover:border-emerald-500/50 transition"
                >
                  <div className="flex items-start gap-1.5">
                    <img src={prod.imageUrl} alt={prod.title} className="w-7 h-7 rounded object-cover bg-pos-bg shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[9.5px] font-semibold text-pos-text truncate" title={prod.title}>
                        {prod.title}
                      </p>
                      <p className="text-[9.5px] font-bold text-pos-muted">{formatDZD(prod.price)}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => addToCart(prod)}
                    className="w-full py-0.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 text-[9.5px] font-bold rounded flex items-center justify-center gap-1 transition cursor-pointer"
                  >
                    <Plus className="w-2.5 h-2.5" /> Ajouter
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

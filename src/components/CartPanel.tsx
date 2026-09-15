import React, { useMemo, useState, useEffect } from 'react';
import { Trash2, Plus, Minus, Tag, Banknote, Percent, ChevronDown, ChevronUp, Sparkles, Gift, Star, User, UserCheck, X, ShoppingBag } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { formatDZD } from '../types/pos';
import type { PricingTier } from '../types/pos';
import { soundEngine } from '../utils/audioFeedback';
import { getProductPriceForTier } from '../utils/pricingEngine';

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
    setCurrentCustomer,
    redeemLoyaltyPoints,
    processPayment,
    applyCartDiscountPercent,
    storeCreditApplied,
    setStoreCreditApplied,
    logSecurityAction,
  } = usePosStore();

  const [isDiscountOpen, setIsDiscountOpen] = useState(false);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [selectedCartIndex, setSelectedCartIndex] = useState<number | null>(null);

  // Keyboard navigation for cart items (ArrowUp / ArrowDown / + / - / Delete)
  useEffect(() => {
    const handleCartKeyNav = (e: KeyboardEvent) => {
      const activeModal = usePosStore.getState().activeModal;
      if (activeModal !== null) return;
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) return;

      const currentCart = usePosStore.getState().cart;
      if (currentCart.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedCartIndex((prev) => (prev === null ? 0 : (prev + 1) % currentCart.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedCartIndex((prev) => (prev === null ? currentCart.length - 1 : (prev - 1 + currentCart.length) % currentCart.length));
      } else if (e.key === '+' || e.key === '=') {
        if (selectedCartIndex !== null && currentCart[selectedCartIndex]) {
          e.preventDefault();
          soundEngine.playScan();
          updateCartQty(currentCart[selectedCartIndex].product.id, 1);
        }
      } else if (e.key === '-') {
        if (selectedCartIndex !== null && currentCart[selectedCartIndex]) {
          e.preventDefault();
          soundEngine.playScan();
          updateCartQty(currentCart[selectedCartIndex].product.id, -1);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedCartIndex !== null && currentCart[selectedCartIndex]) {
          e.preventDefault();
          const itemToRemove = currentCart[selectedCartIndex];
          soundEngine.playKeyBeep?.();
          logSecurityAction(
            'Suppression Article Panier (Clavier)',
            `Article: ${itemToRemove.product.title} (${itemToRemove.quantity} unités)`,
            'Caissier',
            false
          );
          removeFromCart(itemToRemove.product.id);
          setSelectedCartIndex((prev) =>
            prev !== null && prev >= currentCart.length - 1 ? Math.max(0, currentCart.length - 2) : prev
          );
        }
      }
    };

    window.addEventListener('keydown', handleCartKeyNav);
    return () => window.removeEventListener('keydown', handleCartKeyNav);
  }, [selectedCartIndex, updateCartQty, removeFromCart, logSecurityAction]);

  // Calculate gross total based on active pricing tier
  const getItemPrice = (item: typeof cart[0]) => {
    if (item.appliedPrice !== undefined) return item.appliedPrice;
    return getProductPriceForTier(item.product, pricingTier);
  };

  const grossTotal = cart.reduce((acc, item) => acc + getItemPrice(item) * item.quantity, 0);
  const totalDiscount = cart.reduce((acc, item) => acc + (item.discount || 0), 0);
  const subtotal = Math.max(0, grossTotal - totalDiscount);
  const netTotal = Math.max(0, subtotal - (storeCreditApplied || 0));
  const total = netTotal;

  // Realistic Algerian Cash Denominations (no 10,000 DA bill exists)
  const quickBills = [500, 1000, 2000, 3000, 4000, 5000];

  const handleClearCart = () => {
    if (cart.length === 0) return;
    const totalItems = cart.reduce((acc, i) => acc + i.quantity, 0);
    if (totalItems > 1) {
      const ok = window.confirm(`Voulez-vous vraiment vider les ${totalItems} articles de la vente en cours ?`);
      if (!ok) return;
    }
    logSecurityAction(
      'Annulation Complète Panier',
      `Panier vidé (${totalItems} unités, montant: ${grossTotal} DA)`,
      'Caissier',
      true
    );
    soundEngine.playKeyBeep?.();
    clearCart();
    setSelectedCartIndex(null);
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
    await processPayment([{ method: 'Espèces', amount: billAmount }]);
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
        {currentCustomer ? (
          <div className="bg-pos-card border border-pos-border rounded-xl p-2.5 space-y-2 text-xs shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                {currentCustomer.avatarUrl ? (
                  <img
                    src={currentCustomer.avatarUrl}
                    alt={currentCustomer.name}
                    className="w-7 h-7 rounded-full object-cover border border-emerald-500/40 shrink-0"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-slate-950 font-black text-xs flex items-center justify-center shrink-0">
                    {currentCustomer.name.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="font-black text-pos-text truncate text-xs">{currentCustomer.name}</p>
                  <p className="text-[10px] text-pos-muted truncate">
                    {currentCustomer.phone || currentCustomer.registeredDevice || 'Client Enregistré'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => openModal('customers')}
                  className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-md transition cursor-pointer"
                  title="Changer de Client (F3)"
                >
                  <User className="w-3.5 h-3.5 text-cyan-400" />
                </button>
                <button
                  type="button"
                  onClick={() => setCurrentCustomer(null)}
                  className="p-1 hover:bg-red-500/10 text-pos-muted hover:text-red-400 rounded-md transition cursor-pointer"
                  title="Détacher le client du panier"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Financial & Loyalty Pills */}
            <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
              <span className="px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold flex items-center gap-1">
                <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                {currentCustomer.loyaltyPoints} pts
              </span>

              {(currentCustomer.storeCredit || 0) > 0 && (
                <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold font-mono">
                  Avoir: {formatDZD(currentCustomer.storeCredit)}
                </span>
              )}

              {(currentCustomer.currentDebt || 0) > 0 && (
                <span className="px-2 py-0.5 rounded-md bg-rose-500/15 border border-rose-500/30 text-rose-300 font-bold font-mono">
                  Dette: {formatDZD(currentCustomer.currentDebt || 0)}
                </span>
              )}
            </div>

            {/* Point Conversion Button */}
            {currentCustomer.loyaltyPoints >= 10 && (
              <button
                type="button"
                onClick={() => redeemLoyaltyPoints(currentCustomer.id, 10)}
                className="w-full py-1 bg-gradient-to-r from-amber-500/20 to-yellow-500/20 hover:from-amber-500/30 hover:to-yellow-500/30 border border-amber-500/50 text-amber-300 font-black text-[11px] rounded-lg transition flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>Convertir 10 pts (+100 DA d'Avoir)</span>
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => openModal('customers')}
            className="w-full py-2 bg-pos-card hover:bg-pos-hover border border-dashed border-pos-border hover:border-emerald-500/50 rounded-xl text-xs font-bold text-pos-muted hover:text-pos-text flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <UserCheck className="w-4 h-4 text-emerald-400" />
            <span>+ Assigner un Client (F3)</span>
          </button>
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
          <div className="h-full flex flex-col items-center justify-center p-3 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-inner">
              <ShoppingBag className="w-6 h-6 stroke-[2.2]" />
            </div>
            <div className="space-y-1 max-w-[280px]">
              <p className="text-xs font-black text-pos-text uppercase tracking-wider">Caisse Prête à Vendre</p>
              <p className="text-[11px] text-pos-muted">Scannez un code-barres USB ou utilisez les raccourcis ci-dessous :</p>
            </div>
            <div className="w-full bg-pos-card border border-pos-border rounded-xl p-2.5 space-y-1.5 text-left text-[10.5px] shadow-sm">
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Rechercher catalogue</span>
                <span className="font-mono font-bold text-emerald-400 bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F1 ou /</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Encaisser Espèces</span>
                <span className="font-mono font-bold text-emerald-400 bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F2 ou Espace</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Client / Dette / Fidélité</span>
                <span className="font-mono font-bold text-amber-400 bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F3</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Remise globale panier</span>
                <span className="font-mono font-bold text-purple-400 bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F4</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Mettre la vente en attente</span>
                <span className="font-mono font-bold text-cyan-400 bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F6</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Réimprimer dernier ticket</span>
                <span className="font-mono font-bold text-indigo-400 bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F7</span>
              </div>
              <div className="flex justify-between items-center py-0.5 border-b border-pos-border/40">
                <span className="text-pos-muted">Guide des raccourcis</span>
                <span className="font-mono font-bold text-amber-400 bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">F8</span>
              </div>
              <div className="flex justify-between items-center py-0.5">
                <span className="text-pos-muted">Quantité multiple au scan</span>
                <span className="font-mono font-bold text-pos-text bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border">5*CODE</span>
              </div>
            </div>
          </div>
        ) : (
          cart.map((item, idx) => {
            const unitPrice = getItemPrice(item);
            const isSelected = selectedCartIndex === idx;
            return (
              <div
                key={item.product.id}
                onClick={() => setSelectedCartIndex(idx)}
                className={`bg-pos-card border rounded-xl p-2.5 flex items-start gap-2.5 transition group cursor-pointer ${
                  isSelected
                    ? 'border-emerald-500 ring-2 ring-emerald-500/40 bg-emerald-500/[0.04]'
                    : 'border-pos-border/80 hover:border-emerald-500/40'
                }`}
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
                        onClick={(e) => {
                          e.stopPropagation();
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
                        onClick={(e) => e.stopPropagation()}
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
                        onClick={(e) => {
                          e.stopPropagation();
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
                      onClick={(e) => {
                        e.stopPropagation();
                        soundEngine.playKeyBeep?.();
                        logSecurityAction(
                          'Suppression Article Panier',
                          `Article: ${item.product.title} (${item.quantity} unités)`,
                          'Caissier',
                          false
                        );
                        removeFromCart(item.product.id);
                        setSelectedCartIndex(null);
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
        {/* Customer Available Store Credit Quick Bar */}
        {currentCustomer && (currentCustomer.storeCredit || 0) > 0 && storeCreditApplied === 0 && (
          <div className="bg-purple-950/40 border border-purple-500/40 rounded-xl px-2.5 py-1.5 flex items-center justify-between text-xs animate-in fade-in">
            <div className="flex items-center gap-1.5 text-purple-200">
              <Gift className="w-3.5 h-3.5 text-purple-300 shrink-0" />
              <span className="text-[10px] font-bold">Avoir Dispo : <span className="font-mono text-purple-300 font-extrabold">{formatDZD(currentCustomer.storeCredit)}</span></span>
            </div>
            <button
              type="button"
              onClick={() => {
                const maxCredit = Math.min(currentCustomer.storeCredit, subtotal);
                setStoreCreditApplied(maxCredit);
                soundEngine.playSuccess();
              }}
              className="px-2 py-0.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-[9.5px] font-extrabold transition cursor-pointer"
            >
              Appliquer Avoir
            </button>
          </div>
        )}

        {/* Breakdown of Subtotal, Discounts and Store Credit if active */}
        {(totalDiscount > 0 || (storeCreditApplied || 0) > 0) && (
          <div className="space-y-1 pb-1.5 border-b border-pos-border/40 text-xs font-mono">
            <div className="flex justify-between items-center text-pos-muted">
              <span className="text-[11px] font-sans font-semibold">Sous-Total Brut :</span>
              <span className="font-bold">{formatDZD(grossTotal)}</span>
            </div>
            {totalDiscount > 0 && (
              <div className="flex justify-between items-center text-purple-400 font-bold">
                <span className="text-[11px] font-sans flex items-center gap-1">
                  <Percent className="w-3 h-3" /> Remise Accordée :
                </span>
                <span>-{formatDZD(totalDiscount)}</span>
              </div>
            )}
            {(storeCreditApplied || 0) > 0 && (
              <div className="flex justify-between items-center text-emerald-400 font-bold">
                <span className="text-[11px] font-sans flex items-center gap-1">
                  <Gift className="w-3 h-3 text-purple-300" /> Avoir Client Déduit :
                </span>
                <span className="text-purple-300">-{formatDZD(storeCreditApplied)}</span>
              </div>
            )}
          </div>
        )}

        {/* Total Net Header - 1-Second Glance Dominance */}
        <div className="flex justify-between items-baseline pt-0.5">
          <div>
            <span className="text-xs font-black text-pos-text tracking-wider uppercase block">
              {(storeCreditApplied || 0) > 0 ? 'Net Restant à Payer' : 'Total Net à Payer'}
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
            <div className="grid grid-cols-6 gap-1">
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
            title="Encaisser en Espèces & Calcul Rendu de Monnaie - F2 / Espace"
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
                F2
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
                    <div className="w-7 h-7 rounded bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0 text-emerald-400">
                      <Tag className="w-3.5 h-3.5" />
                    </div>
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

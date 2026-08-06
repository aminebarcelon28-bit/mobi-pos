import React, { useMemo } from 'react';
import { Trash2, Plus, Minus, Banknote, Tag, CreditCard } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';
import { formatDZD } from '../types/pos';
import type { PricingTier } from '../types/pos';

export const CartPanel: React.FC = () => {
  const { cart, updateCartQty, removeFromCart, clearCart, openModal, pricingTier, setPricingTier, products, addToCart, currentCustomer, redeemLoyaltyPoints, quickCashPayment, processPayment } = usePosStore();

  // Calculate gross total based on active pricing tier (Tax-Free Engine: Total = Subtotal)
  const getItemPrice = (item: typeof cart[0]) => {
    return pricingTier === 'Wholesale' ? item.product.wholesalePrice || item.product.price * 0.75 : item.product.price;
  };

  const subtotal = cart.reduce((acc, item) => acc + getItemPrice(item) * item.quantity - item.discount, 0);
  const total = subtotal; // Tax-Free Gross Total

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

  return (
    <div className="w-[390px] bg-pos-panel border-r border-pos-border flex flex-col h-full select-none transition-colors duration-200">
      {/* Cart Header & Pricing Tier Selector */}
      <div className="p-3 border-b border-pos-border space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="font-bold text-sm text-pos-text tracking-wider uppercase">Vente en Cours</h2>
            <span className="bg-pos-card border border-pos-border text-emerald-500 text-xs font-bold px-2 py-0.5 rounded-full">
              {cart.reduce((acc, i) => acc + i.quantity, 0)} Articles
            </span>
          </div>
          {cart.length > 0 && (
            <button
              onClick={clearCart}
              className="p-1.5 hover:bg-red-500/10 text-pos-muted hover:text-red-400 rounded-lg transition"
              title="Vider le panier"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>

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
                className="px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-300 font-bold text-[10px] rounded-lg transition shrink-0"
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
              className={`flex-1 py-1 rounded-lg text-xs font-bold transition ${
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
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {cart.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-pos-muted space-y-2">
            <div className="w-12 h-12 rounded-full bg-pos-card flex items-center justify-center border border-pos-border">
              <Trash2 className="w-5 h-5 opacity-50" />
            </div>
            <p className="text-xs">Panier vide. Scannez un article ou choisissez dans le catalogue.</p>
          </div>
        ) : (
          cart.map((item) => {
            const unitPrice = getItemPrice(item);
            return (
              <div
                key={item.product.id}
                className="bg-pos-card border border-pos-border/80 rounded-xl p-3 flex items-start gap-3 hover:border-emerald-500/40 transition group"
              >
                <img
                  src={item.product.imageUrl}
                  alt={item.product.title}
                  className="w-12 h-12 rounded-lg object-cover bg-pos-bg border border-pos-border shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start">
                    <h3 className="text-xs font-semibold text-pos-text truncate leading-snug">{item.product.title}</h3>
                    <span className="text-xs font-bold text-pos-text pl-2">
                      {formatDZD(unitPrice * item.quantity - item.discount)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-pos-muted">{item.product.brand}</span>
                    {pricingTier === 'Wholesale' && (
                      <span className="text-[9px] bg-amber-500/10 text-amber-500 font-bold px-1 rounded border border-amber-500/30">
                        Tarif Gros
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-pos-muted font-mono">Réf: {item.product.sku}</p>

                  {/* Quantity Stepper */}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-pos-border/40">
                    <div className="flex items-center gap-1.5 bg-pos-bg border border-pos-border rounded-lg p-0.5">
                      <button
                        onClick={() => updateCartQty(item.product.id, -1)}
                        className="w-5 h-5 rounded hover:bg-pos-hover text-pos-muted hover:text-pos-text flex items-center justify-center transition"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="w-6 text-center text-xs font-bold text-pos-text">{item.quantity}</span>
                      <button
                        onClick={() => updateCartQty(item.product.id, 1)}
                        className="w-5 h-5 rounded hover:bg-pos-hover text-pos-muted hover:text-pos-text flex items-center justify-center transition"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                    <button
                      onClick={() => removeFromCart(item.product.id)}
                      className="text-[10px] text-red-400 opacity-0 group-hover:opacity-100 hover:underline transition"
                    >
                      Supprimer
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Totals Summary (Tax-Free Engine) */}
      <div className="p-4 border-t border-pos-border bg-pos-panel/90 space-y-2">
        <div className="flex justify-between items-baseline pt-1">
          <span className="text-sm font-extrabold text-pos-text tracking-wider uppercase">TOTAL NET À PAYER</span>
          <span className="text-2xl font-black text-emerald-500 tracking-tight">{formatDZD(total)}</span>
        </div>

        {/* Loyalty Points Live Earned Preview Badge */}
        {/* Store Credit Payment Fast Action Banner */}
        {currentCustomer && currentCustomer.storeCredit > 0 && total > 0 && (
          <div className="bg-gradient-to-r from-emerald-950/80 to-teal-950/80 border border-emerald-500/40 rounded-xl p-2.5 flex items-center justify-between text-xs shadow-md">
            <div className="flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-emerald-400" />
              <div>
                <span className="font-extrabold text-emerald-300 block">Solde Avoir: {formatDZD(currentCustomer.storeCredit)}</span>
                <span className="text-[9.5px] text-pos-muted">
                  Dédure: <strong className="text-white">{formatDZD(Math.min(total, currentCustomer.storeCredit))}</strong>
                  {currentCustomer.storeCredit > total && (
                    <span className="text-emerald-400 font-bold ml-1">(Reste {formatDZD(currentCustomer.storeCredit - total)})</span>
                  )}
                </span>
              </div>
            </div>
            <button
              onClick={() => {
                const creditToApply = Math.min(total, currentCustomer.storeCredit);
                const remainingCash = Math.max(0, total - creditToApply);
                const tendersList: Array<{ method: 'Espèces' | 'Avoir Client' | 'BaridiMob' | 'Chèque'; amount: number }> = [
                  { method: 'Avoir Client', amount: creditToApply }
                ];
                if (remainingCash > 0) {
                  tendersList.push({ method: 'Espèces', amount: remainingCash });
                }
                processPayment(tendersList);
              }}
              className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs rounded-lg transition shadow-md shadow-emerald-500/20 cursor-pointer"
            >
              ⚡ Payer par Avoir
            </button>
          </div>
        )}

        {/* Fast Action Buttons */}
        <div className="pt-2 space-y-2">
          <button
            onClick={() => quickCashPayment()}
            disabled={cart.length === 0}
            className="w-full glow-btn bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 text-white rounded-xl p-3.5 flex items-center justify-between shadow-xl shadow-emerald-600/25 relative group"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-black/20 flex items-center justify-center">
                <Banknote className="w-5 h-5 text-white" />
              </div>
              <div className="text-left">
                <span className="text-sm font-extrabold tracking-wide uppercase block">Vente Cash Éclair</span>
                <span className="text-[10px] text-emerald-100 font-medium">Validation Immédiate Sans Modal</span>
              </div>
            </div>
            <span className="hotkey-badge bg-black/60 text-emerald-200 border-white/20 px-2 py-1 text-xs font-bold">F3</span>
          </button>

          <button
            onClick={() => openModal('payment')}
            disabled={cart.length === 0}
            className="w-full py-2 bg-pos-bg hover:bg-pos-card border border-pos-border text-pos-text disabled:opacity-40 rounded-xl text-xs font-semibold flex items-center justify-between px-3 transition"
          >
            <span>Paiement Avancé (Avoir, BaridiMob, Chèque)</span>
            <span className="text-[10px] text-pos-muted font-mono">Shift+F3</span>
          </button>
        </div>
      </div>

      {/* Suggested Products Section */}
      {recommendedProducts.length > 0 && (
        <div className="p-3 border-t border-pos-border bg-pos-panel">
          <div className="text-xs font-bold text-emerald-500 mb-2 uppercase tracking-wide">
            Produits Compatibles Suggérés ({primaryModel})
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 hide-scrollbar">
            {recommendedProducts.map(prod => (
              <div key={prod.id} className="min-w-[140px] bg-pos-card border border-pos-border rounded-lg p-2 flex flex-col gap-1.5 shrink-0 hover:border-emerald-500/50 transition">
                <div className="flex items-start gap-2">
                  <img src={prod.imageUrl} alt={prod.title} className="w-8 h-8 rounded-md object-cover bg-pos-bg" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-semibold text-pos-text truncate" title={prod.title}>{prod.title}</p>
                    <p className="text-[10px] font-bold text-pos-muted">{formatDZD(prod.price)}</p>
                  </div>
                </div>
                <button
                  onClick={() => addToCart(prod)}
                  className="w-full py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 text-[10px] font-bold rounded-md flex items-center justify-center gap-1 transition"
                >
                  <Plus className="w-3 h-3" /> Ajouter
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

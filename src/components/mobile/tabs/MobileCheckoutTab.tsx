import React, { useState } from 'react';
import {
  ShoppingBag,
  Trash2,
  Plus,
  Minus,
  User,
  CheckCircle2,
  Smartphone,
  Coins,
  CreditCard,
  X,
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import type { CartItem, Customer, PricingTier } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { soundEngine } from '../../../utils/audioFeedback';

export const MobileCheckoutTab: React.FC = () => {
  const {
    cart,
    removeFromCart,
    setCartItemQty,
    clearCart,
    pricingTier,
    setPricingTier,
    currentCustomer,
    setCurrentCustomer,
    customers,
    processPayment,
  } = usePosStore();

  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successSaleNumber, setSuccessSaleNumber] = useState<string | null>(null);

  // Cart Calculations
  const grossSubtotal = cart.reduce(
    (acc, i) => acc + (i.appliedPrice || i.product.price) * i.quantity,
    0
  );
  const totalDiscount = cart.reduce((acc, i) => acc + (i.discount || 0) * i.quantity, 0);
  const netTotal = Math.max(0, grossSubtotal - totalDiscount);

  const handleQtyChange = (productId: string, newQty: number) => {
    soundEngine.playKeyBeep?.();
    if (newQty <= 0) {
      removeFromCart(productId);
    } else {
      setCartItemQty(productId, newQty);
    }
  };

  const handleRemove = (productId: string) => {
    soundEngine.playKeyBeep?.();
    removeFromCart(productId);
  };

  const handleCheckoutCash = async () => {
    if (cart.length === 0 || isSubmitting) return;

    setIsSubmitting(true);
    soundEngine.playKeyBeep?.();

    try {
      const res = await processPayment([
        { method: 'Espèces', amount: netTotal },
      ]);
      if (res && res.success) {
        soundEngine.playSuccess?.();
        const lastTx = usePosStore.getState().lastTransaction;
        setSuccessSaleNumber(lastTx?.receiptNumber || 'OK');
        setTimeout(() => setSuccessSaleNumber(null), 3000);
      } else {
        soundEngine.playError?.();
      }
    } catch (err) {
      console.error('Mobile checkout error:', err);
      soundEngine.playError?.();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCheckoutCredit = async () => {
    if (cart.length === 0 || isSubmitting) return;

    if (!currentCustomer) {
      setCustomerModalOpen(true);
      return;
    }

    // Check debtLimit
    const currentDebt = currentCustomer.currentDebt || 0;
    const debtLimit = currentCustomer.debtLimit ?? Infinity;
    if (currentDebt + netTotal > debtLimit) {
      alert(
        `Plafond de crédit dépassé pour ${currentCustomer.name} ! Dette actuelle : ${formatDZD(
          currentDebt
        )}, Plafond max : ${formatDZD(debtLimit)}`
      );
      soundEngine.playError?.();
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await processPayment([
        { method: 'Crédit Client', amount: netTotal },
      ]);
      if (res && res.success) {
        soundEngine.playSuccess?.();
        const lastTx = usePosStore.getState().lastTransaction;
        setSuccessSaleNumber(lastTx?.receiptNumber || 'OK');
        setTimeout(() => setSuccessSaleNumber(null), 3000);
      } else {
        soundEngine.playError?.();
      }
    } catch (err) {
      console.error('Mobile credit sale error:', err);
      soundEngine.playError?.();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-3.5 space-y-3 pb-24 select-none">
      {/* Success Notification Banner */}
      {successSaleNumber && (
        <div className="bg-emerald-500/10 border border-emerald-500/40 rounded-2xl p-3.5 flex items-center gap-3 animate-in fade-in slide-in-from-top-2 text-emerald-300">
          <CheckCircle2 className="w-7 h-7 text-emerald-400 shrink-0" />
          <div>
            <h4 className="text-xs font-black uppercase">Vente Encaissée avec Succès !</h4>
            <p className="text-[11px] font-medium text-emerald-200">
              Ticket #{successSaleNumber} validé et synchronisé avec la caisse principale.
            </p>
          </div>
        </div>
      )}

      {/* Pricing Tier Selector */}
      <div className="flex items-center gap-1 bg-pos-panel p-1 rounded-xl border border-pos-border">
        {(['Retail', 'VIP', 'Wholesale'] as PricingTier[]).map((tier) => (
          <button
            key={tier}
            type="button"
            onClick={() => setPricingTier(tier)}
            className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
              pricingTier === tier
                ? 'bg-cyan-500 text-slate-950 font-black shadow-sm'
                : 'text-pos-muted hover:text-pos-text'
            }`}
          >
            {tier === 'Retail' ? 'Détail' : tier === 'VIP' ? 'Demi-Gros' : 'Gros'}
          </button>
        ))}
      </div>

      {/* Customer Selector Card */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
            <User className="w-4 h-4" />
          </div>
          <div>
            <span className="text-[10px] font-bold text-pos-muted uppercase block leading-none">
              Client Assigné
            </span>
            <span className="text-xs font-black text-pos-text mt-0.5 block leading-tight">
              {currentCustomer ? currentCustomer.name : 'Client Comptoir'}
            </span>
            {currentCustomer && currentCustomer.currentDebt ? (
              <span className="text-[10px] font-bold text-amber-400">
                Créance actuelle : {formatDZD(currentCustomer.currentDebt)}
              </span>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setCustomerModalOpen(true)}
          className="text-xs font-bold px-2.5 py-1 rounded-lg bg-pos-panel border border-pos-border text-cyan-400 hover:border-cyan-500 cursor-pointer"
        >
          {currentCustomer ? 'Changer' : 'Sélectionner'}
        </button>
      </div>

      {/* Cart Items List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1 text-xs font-bold text-pos-muted">
          <span>Articles au Panier ({cart.length})</span>
          {cart.length > 0 && (
            <button
              type="button"
              onClick={clearCart}
              className="text-[10px] text-rose-400 hover:text-rose-300 flex items-center gap-1 cursor-pointer"
            >
              <Trash2 className="w-3 h-3" /> Vider
            </button>
          )}
        </div>

        {cart.length === 0 ? (
          <div className="p-8 text-center bg-pos-panel border border-pos-border rounded-2xl">
            <ShoppingBag className="w-8 h-8 text-pos-muted mx-auto mb-2 opacity-50" />
            <p className="text-xs font-bold text-pos-muted">Le panier mobile est vide.</p>
            <p className="text-[11px] text-pos-muted/80 mt-1">
              Allez dans l'onglet "Articles" pour ajouter des produits.
            </p>
          </div>
        ) : (
          cart.map((item: CartItem) => {
            const unitPrice = item.appliedPrice || item.product.price;
            const itemTotal = unitPrice * item.quantity;

            return (
              <div
                key={item.product.id}
                className="bg-pos-card border border-pos-border rounded-xl p-3 flex items-center justify-between gap-3 shadow-sm"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    {item.imeiNumber && (
                      <span className="p-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                        <Smartphone className="w-3 h-3" />
                      </span>
                    )}
                    <h4 className="text-xs font-bold text-pos-text truncate">
                      {item.product.title}
                    </h4>
                  </div>

                  <div className="flex items-center gap-2 text-[10px] text-pos-muted mt-0.5 font-mono">
                    <span>{formatDZD(unitPrice)} × {item.quantity}</span>
                    <span>=</span>
                    <span className="font-bold text-pos-text">{formatDZD(itemTotal)}</span>
                  </div>
                </div>

                {/* Quantity Stepper */}
                <div className="flex items-center gap-1.5 shrink-0 bg-pos-panel border border-pos-border rounded-lg p-1">
                  <button
                    type="button"
                    onClick={() => handleQtyChange(item.product.id, item.quantity - 1)}
                    className="w-7 h-7 flex items-center justify-center rounded bg-pos-card text-pos-muted hover:text-pos-text active:scale-95 cursor-pointer"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>

                  <span className="w-6 text-center font-mono text-xs font-black text-pos-text">
                    {item.quantity}
                  </span>

                  <button
                    type="button"
                    onClick={() => handleQtyChange(item.product.id, item.quantity + 1)}
                    className="w-7 h-7 flex items-center justify-center rounded bg-pos-card text-cyan-400 hover:text-cyan-300 active:scale-95 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={() => handleRemove(item.product.id)}
                    className="w-7 h-7 flex items-center justify-center rounded bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 active:scale-95 cursor-pointer ml-1"
                    title="Supprimer la ligne"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Totals Summary & Tenders Footer */}
      {cart.length > 0 && (
        <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3 shadow-md">
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between text-pos-muted">
              <span>Sous-total Brut</span>
              <span className="font-mono">{formatDZD(grossSubtotal)}</span>
            </div>
            {totalDiscount > 0 && (
              <div className="flex justify-between text-cyan-400 font-medium">
                <span>Remise Accordée</span>
                <span className="font-mono">-{formatDZD(totalDiscount)}</span>
              </div>
            )}
            <div className="flex justify-between items-baseline pt-2 border-t border-pos-border text-pos-text">
              <span className="text-xs font-black uppercase tracking-wider">Total Net</span>
              <span className="text-2xl font-black font-mono text-emerald-400">
                {formatDZD(netTotal)}
              </span>
            </div>
          </div>

          {/* Checkout Buttons */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={handleCheckoutCash}
              className="py-3 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 shadow-md transition cursor-pointer disabled:opacity-50"
            >
              <Coins className="w-4 h-4" />
              <span>Espèces</span>
            </button>

            <button
              type="button"
              disabled={isSubmitting}
              onClick={handleCheckoutCredit}
              className="py-3 px-3 rounded-xl bg-pos-panel border border-pos-border hover:border-amber-400 active:scale-95 text-amber-400 font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer disabled:opacity-50"
            >
              <CreditCard className="w-4 h-4" />
              <span>Crédit Kredy</span>
            </button>
          </div>
        </div>
      )}

      {/* Inline Customer Selection Modal */}
      {customerModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-sm overflow-hidden flex flex-col max-h-[80vh]">
            <div className="p-3.5 border-b border-pos-border flex items-center justify-between">
              <h3 className="text-xs font-black text-pos-text">Sélectionner un Client</h3>
              <button
                type="button"
                onClick={() => setCustomerModalOpen(false)}
                className="p-1 text-pos-muted hover:text-pos-text"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 overflow-y-auto space-y-1.5 flex-1">
              <button
                type="button"
                onClick={() => {
                  setCurrentCustomer(null);
                  setCustomerModalOpen(false);
                }}
                className="w-full text-left p-2.5 rounded-xl bg-pos-card border border-pos-border text-xs font-bold text-pos-muted hover:text-pos-text"
              >
                Client Comptoir (Par Défaut)
              </button>

              {(customers || []).map((c: Customer) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setCurrentCustomer(c);
                    setCustomerModalOpen(false);
                  }}
                  className="w-full text-left p-2.5 rounded-xl bg-pos-card border border-pos-border hover:border-cyan-500/50 flex items-center justify-between"
                >
                  <div>
                    <span className="text-xs font-black text-pos-text block">{c.name}</span>
                    <span className="text-[10px] text-pos-muted">{c.phone || 'Pas de numéro'}</span>
                  </div>
                  {c.currentDebt ? (
                    <span className="text-[10px] font-black text-amber-400 font-mono">
                      {formatDZD(c.currentDebt)}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

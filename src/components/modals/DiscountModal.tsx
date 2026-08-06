import React, { useState } from 'react';
import { X, Percent, Check, DollarSign, Tag } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';

const PROMO_CODES: Record<string, { type: 'percent' | 'amount'; value: number; label: string }> = {
  SOLDES10: { type: 'percent', value: 10, label: 'Remise Soldes 10%' },
  FIDELITE15: { type: 'percent', value: 15, label: 'Privilège Fidélité 15%' },
  PROMO500: { type: 'amount', value: 500, label: 'Coupon Réduction 500 DA' },
  PROMO1000: { type: 'amount', value: 1000, label: 'Coupon VIP 1000 DA' },
};

export const DiscountModal: React.FC = () => {
  const { activeModal, closeModal, applyCartDiscountPercent, cart, pricingTier } = usePosStore();

  const [discountMode, setDiscountMode] = useState<'percent' | 'amount'>('percent');
  const [percentValue, setPercentValue] = useState(10);
  const [amountValue, setAmountValue] = useState(500);
  const [promoInput, setPromoInput] = useState('');
  const [promoStatus, setPromoStatus] = useState<string | null>(null);

  if (activeModal !== 'discount') return null;

  // Calculate gross cart total before discount
  const cartSubtotal = cart.reduce((acc, item) => {
    const itemPrice = pricingTier === 'Wholesale' ? item.product.wholesalePrice || item.product.price * 0.75 : item.product.price;
    return acc + itemPrice * item.quantity;
  }, 0);

  // Live calculation of discount & final price
  const calculatedDiscount =
    discountMode === 'percent'
      ? Math.round((cartSubtotal * percentValue) / 100)
      : Math.min(cartSubtotal, amountValue);

  const finalTotal = Math.max(0, cartSubtotal - calculatedDiscount);

  const handleApplyPromoCode = () => {
    const clean = promoInput.trim().toUpperCase();
    if (PROMO_CODES[clean]) {
      const code = PROMO_CODES[clean];
      setDiscountMode(code.type);
      if (code.type === 'percent') setPercentValue(code.value);
      else setAmountValue(code.value);
      setPromoStatus(`Code "${clean}" Appliqué : ${code.label}`);
    } else {
      setPromoStatus('Code promo invalide ou expiré');
    }
  };

  const handleApply = () => {
    let effectivePercent = 0;
    if (discountMode === 'percent') {
      effectivePercent = percentValue;
    } else {
      effectivePercent = cartSubtotal > 0 ? (amountValue / cartSubtotal) * 100 : 0;
    }
    applyCartDiscountPercent(effectivePercent);
    closeModal();
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95">
        
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center text-white font-bold shadow-lg shadow-purple-500/20">
              <Percent className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2">
                REMISE SUR PANIER
                <span className="text-[10px] bg-purple-500/10 text-purple-400 font-bold px-2 py-0.5 rounded border border-purple-500/30">
                  MARKDOWN
                </span>
              </h2>
              <p className="text-[11px] text-pos-muted">Appliquez une remise globale en % ou en montant fixe (DA)</p>
            </div>
          </div>
          <button onClick={closeModal} className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4 bg-pos-bg">
          
          {/* Mode Switcher (% vs DA) */}
          <div className="flex bg-pos-card p-1 rounded-xl border border-pos-border">
            <button
              onClick={() => setDiscountMode('percent')}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                discountMode === 'percent'
                  ? 'bg-purple-600 text-white shadow-md'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <Percent className="w-3.5 h-3.5" /> Pourcentage (%)
            </button>
            <button
              onClick={() => setDiscountMode('amount')}
              className={`flex-1 py-2 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                discountMode === 'amount'
                  ? 'bg-emerald-500 text-slate-950 shadow-md'
                  : 'text-pos-muted hover:text-pos-text'
              }`}
            >
              <DollarSign className="w-3.5 h-3.5" /> Montant Fixe (DA)
            </button>
          </div>

          {/* Presets Grid */}
          <div>
            <label className="text-[11px] font-extrabold text-pos-muted uppercase block mb-1.5 tracking-wider">
              {discountMode === 'percent' ? 'Raccourcis Pourcentage' : 'Raccourcis Montant DZD'}
            </label>
            {discountMode === 'percent' ? (
              <div className="grid grid-cols-4 gap-2">
                {[5, 10, 15, 20].map((p) => (
                  <button
                    key={p}
                    onClick={() => setPercentValue(p)}
                    className={`py-2 rounded-xl text-xs font-black border transition ${
                      percentValue === p
                        ? 'bg-purple-600 border-purple-400 text-white shadow-md'
                        : 'bg-pos-card border-pos-border text-pos-muted hover:text-pos-text hover:border-purple-400/50'
                    }`}
                  >
                    -{p}%
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-2">
                {[200, 500, 1000, 2000].map((a) => (
                  <button
                    key={a}
                    onClick={() => setAmountValue(a)}
                    className={`py-2 rounded-xl text-xs font-black border transition ${
                      amountValue === a
                        ? 'bg-emerald-500 border-emerald-400 text-slate-950 shadow-md'
                        : 'bg-pos-card border-pos-border text-pos-muted hover:text-pos-text hover:border-emerald-400/50'
                    }`}
                  >
                    -{a} DA
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Input Custom Value */}
          <div>
            <label className="text-[11px] font-semibold text-pos-muted block mb-1">
              {discountMode === 'percent' ? 'Pourcentage de Remise Personnalisé (%)' : 'Montant de Remise Personnalisé (DA)'}
            </label>
            {discountMode === 'percent' ? (
              <input
                type="number"
                min="0"
                max="100"
                value={percentValue}
                onChange={(e) => setPercentValue(parseFloat(e.target.value) || 0)}
                className="w-full bg-pos-card border border-pos-border rounded-xl px-3.5 py-2 text-base font-black text-purple-400 focus:border-purple-400 focus:outline-none"
              />
            ) : (
              <input
                type="number"
                min="0"
                step="50"
                value={amountValue}
                onChange={(e) => setAmountValue(parseFloat(e.target.value) || 0)}
                className="w-full bg-pos-card border border-pos-border rounded-xl px-3.5 py-2 text-base font-black text-emerald-400 focus:border-emerald-400 focus:outline-none"
              />
            )}
          </div>

          {/* Promo Voucher Input */}
          <div className="bg-pos-card p-3 rounded-xl border border-pos-border space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-extrabold text-pos-muted uppercase tracking-wider flex items-center gap-1">
                <Tag className="w-3 h-3 text-cyan-400" /> Code Promo / Coupon Vendeur
              </label>
              <span className="text-[9px] text-pos-muted font-mono">ex: SOLDES10, PROMO500</span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={promoInput}
                onChange={(e) => setPromoInput(e.target.value)}
                placeholder="Entrez le code coupon..."
                className="flex-1 bg-pos-bg border border-pos-border rounded-lg px-3 py-1.5 text-xs text-pos-text font-bold uppercase focus:border-cyan-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleApplyPromoCode}
                className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs transition"
              >
                Valider
              </button>
            </div>
            {promoStatus && (
              <p className={`text-[10px] font-bold ${promoStatus.includes('Appliqué') ? 'text-emerald-400' : 'text-rose-400'}`}>
                {promoStatus}
              </p>
            )}
          </div>

          {/* Live Financial Calculation Box */}
          <div className="bg-pos-card border border-pos-border p-3.5 rounded-2xl space-y-1.5 text-xs">
            <div className="flex justify-between items-center text-pos-muted">
              <span>Sous-total Panier :</span>
              <span className="font-bold text-pos-text">{formatDZD(cartSubtotal)}</span>
            </div>

            <div className="flex justify-between items-center text-rose-400">
              <span>Remise Appliquée :</span>
              <span className="font-extrabold">-{formatDZD(calculatedDiscount)}</span>
            </div>

            <div className="flex justify-between items-baseline pt-2 border-t border-pos-border/60">
              <span className="font-extrabold text-pos-text uppercase text-[11px]">Nouveau Total à Payer :</span>
              <span className="text-lg font-black text-emerald-400 tracking-tight">{formatDZD(finalTotal)}</span>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex justify-end gap-2 shrink-0">
          <button onClick={closeModal} className="px-4 py-2 text-xs font-semibold text-pos-muted hover:text-pos-text transition">
            Annuler
          </button>
          <button
            onClick={handleApply}
            className="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-emerald-500 hover:from-purple-500 hover:to-emerald-400 text-slate-950 font-extrabold text-xs rounded-xl flex items-center gap-1.5 shadow-lg shadow-purple-600/20 cursor-pointer transition"
          >
            <Check className="w-4 h-4" /> Appliquer la Remise
          </button>
        </div>
      </div>
    </div>
  );
};


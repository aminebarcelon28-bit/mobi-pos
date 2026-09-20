import React, { useState } from 'react';
import { X, Percent, Check, DollarSign, Tag } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { getProductPriceForTier } from '../../utils/pricingEngine';

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
    const itemPrice = item.appliedPrice !== undefined ? item.appliedPrice : getProductPriceForTier(item.product, pricingTier);
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
      effectivePercent = isNaN(percentValue) ? 0 : percentValue;
    } else {
      const validAmount = Math.max(0, isNaN(amountValue) ? 0 : amountValue);
      effectivePercent = cartSubtotal > 0 ? (validAmount / cartSubtotal) * 100 : 0;
    }
    const safePercent = Math.max(0, Math.min(100, effectivePercent));
    applyCartDiscountPercent(safePercent);
    closeModal();
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:fade-in sm:zoom-in-95 flex flex-col max-h-[92vh]">
        {/* Mobile Pull Handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center text-white font-bold shadow-lg shadow-purple-500/20 shrink-0">
              <Percent className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2 truncate">
                REMISE SUR PANIER
                <span className="text-[10px] bg-purple-500/10 text-purple-400 font-bold px-2 py-0.5 rounded border border-purple-500/30 shrink-0">
                  MARKDOWN
                </span>
              </h2>
              <p className="text-[11px] text-pos-muted truncate">Appliquez une remise globale en % ou en montant fixe (DA)</p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer min-h-[38px] min-w-[38px] flex items-center justify-center shrink-0"
            aria-label="Fermer"
          >
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
                inputMode="decimal"
                min="0"
                max="100"
                value={percentValue}
                onChange={(e) => setPercentValue(parseFloat(e.target.value) || 0)}
                className="w-full bg-pos-card border border-pos-border rounded-xl px-3.5 py-2 text-base font-black text-purple-400 focus:border-purple-400 focus:outline-none"
              />
            ) : (
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="50"
                value={amountValue}
                onChange={(e) => setAmountValue(parseFloat(e.target.value) || 0)}
                className="w-full bg-pos-card border border-pos-border rounded-xl px-3.5 py-2 text-base font-black text-emerald-400 focus:border-emerald-400 focus:outline-none"
              />
            )}
          </div>

          {/* Promo Code Input */}
          <div className="space-y-1">
            <label className="text-[11px] font-semibold text-pos-muted block">
              Code Promo ou Coupon Spécial
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Tag className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                <input
                  type="text"
                  value={promoInput}
                  onChange={(e) => setPromoInput(e.target.value)}
                  placeholder="EX: SOLDES10, PROMO500"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck="false"
                  className="w-full bg-pos-card border border-pos-border rounded-xl pl-9 pr-3 py-2 text-xs font-mono uppercase text-pos-text focus:border-purple-400 focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={handleApplyPromoCode}
                className="px-4 py-2 bg-pos-card border border-pos-border hover:border-purple-400 text-pos-text font-bold text-xs rounded-xl active:scale-95 transition"
              >
                Valider
              </button>
            </div>
            {promoStatus && (
              <p
                className={`text-[10px] font-medium pt-1 ${
                  promoStatus.startsWith('Code') ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
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
        <div className="p-3.5 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col-reverse sm:flex-row justify-end gap-2 shrink-0">
          <button
            onClick={closeModal}
            className="w-full sm:w-auto min-h-[42px] px-4 py-2 text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer text-center"
          >
            Annuler
          </button>
          <button
            onClick={handleApply}
            className="w-full sm:w-auto min-h-[46px] px-6 py-2.5 bg-gradient-to-r from-purple-600 to-emerald-500 hover:from-purple-500 hover:to-emerald-400 text-slate-950 font-extrabold text-xs rounded-xl flex items-center justify-center gap-1.5 shadow-lg shadow-purple-600/20 cursor-pointer active:scale-95 transition"
          >
            <Check className="w-4 h-4 stroke-[2.5]" /> Appliquer la Remise
          </button>
        </div>
      </div>
    </div>
  );
};



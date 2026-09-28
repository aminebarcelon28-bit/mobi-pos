import React, { useState } from 'react';
import { X, Percent, Check, DollarSign, Tag } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { getProductPriceForTier } from '../../utils/pricingEngine';
import { parseLocalizedAmount } from '../../utils/moneyInput';
import { PROMO_TRACKING } from '../../constants';

interface PromoCodeDef {
  type: 'percent' | 'amount';
  value: number;
  label: string;
  /** ISO expiry — past this date the code reads as expired. */
  expiresAt: string;
  /** Lifetime redemption cap (tracked in localStorage, see below). */
  maxRedemptions: number;
}

// Promo lifecycle (minimal, documented): every code carries an expiry date
// and a lifetime redemption cap. Counts live in localStorage under
// PROMO_TRACKING.REDEMPTION_STORAGE_KEY as { CODE: count } and increment when
// the discount is APPLIED (not when the code is merely typed), so abandoned
// carts don't burn redemptions. Caps are generous on purpose: existing codes
// keep working exactly as before until a cap is actually hit. localStorage is
// per-terminal — a chain-wide cap would need the server ledger (out of scope).
const PROMO_CODES: Record<string, PromoCodeDef> = {
  SOLDES10: { type: 'percent', value: 10, label: 'Remise Soldes 10%', expiresAt: '2027-12-31T23:59:59+01:00', maxRedemptions: 2000 },
  FIDELITE15: { type: 'percent', value: 15, label: 'Privilège Fidélité 15%', expiresAt: '2027-12-31T23:59:59+01:00', maxRedemptions: 2000 },
  PROMO500: { type: 'amount', value: 500, label: 'Coupon Réduction 500 DA', expiresAt: '2027-06-30T23:59:59+01:00', maxRedemptions: 500 },
  PROMO1000: { type: 'amount', value: 1000, label: 'Coupon VIP 1000 DA', expiresAt: '2027-06-30T23:59:59+01:00', maxRedemptions: 200 },
};

/** Best-effort read of the per-code redemption counters ({} on any failure). */
function readPromoRedemptions(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PROMO_TRACKING.REDEMPTION_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

function getPromoRedemptionCount(code: string): number {
  return readPromoRedemptions()[code] || 0;
}

/** Increments the lifetime counter for a code; never throws (tracking). */
function incrementPromoRedemption(code: string): void {
  try {
    const all = readPromoRedemptions();
    all[code] = (all[code] || 0) + 1;
    localStorage.setItem(PROMO_TRACKING.REDEMPTION_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Tracking-only: a full/blocked storage must never block the discount.
  }
}

export const DiscountModal: React.FC = () => {
  const { activeModal, closeModal, applyCartDiscountPercent, cart, pricingTier, verifyManagerPin } = usePosStore();

  const [discountMode, setDiscountMode] = useState<'percent' | 'amount'>('percent');
  const [percentValue, setPercentValue] = useState(10);
  const [amountValue, setAmountValue] = useState(500);
  const [promoInput, setPromoInput] = useState('');
  const [promoStatus, setPromoStatus] = useState<string | null>(null);
  // Code attributed to the pending discount; counted at APPLY time.
  const [appliedPromoCode, setAppliedPromoCode] = useState<string | null>(null);
  const [managerPinInput, setManagerPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

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
    const code = PROMO_CODES[clean];
    if (!code) {
      setPromoStatus('Code promo invalide ou expiré');
      setAppliedPromoCode(null);
      return;
    }
    if (Date.now() > new Date(code.expiresAt).getTime()) {
      setPromoStatus(`Code "${clean}" expiré depuis le ${new Date(code.expiresAt).toLocaleDateString('fr-DZ')}`);
      setAppliedPromoCode(null);
      return;
    }
    if (getPromoRedemptionCount(clean) >= code.maxRedemptions) {
      setPromoStatus(`Code "${clean}" épuisé (plafond de ${code.maxRedemptions} utilisations atteint)`);
      setAppliedPromoCode(null);
      return;
    }
    setDiscountMode(code.type);
    if (code.type === 'percent') setPercentValue(code.value);
    else setAmountValue(code.value);
    setAppliedPromoCode(clean);
    setPromoStatus(`Code "${clean}" Appliqué : ${code.label}`);
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
    // Cart discounts above 10 % need a manager PIN — enforced by the slice;
    // the modal collects the PIN instead of letting the call fail silently.
    const applyFn = applyCartDiscountPercent as unknown as (
      p: number,
      approved?: boolean
    ) => { success: boolean; requiresPin?: boolean; reason?: string } | void;
    if (safePercent > 10) {
      if (!managerPinInput) {
        setPinError('Remise > 10% : PIN Manager requis.');
        return;
      }
      if (!verifyManagerPin(managerPinInput)) {
        setPinError('Code PIN Manager incorrect.');
        return;
      }
      applyFn(safePercent, true);
    } else {
      applyFn(safePercent);
    }
    // Count the promo redemption now that the discount is really applied.
    if (appliedPromoCode) {
      incrementPromoRedemption(appliedPromoCode);
      setAppliedPromoCode(null);
    }
    setManagerPinInput('');
    setPinError(null);
    closeModal();
  };

  // Live effective percent drives the PIN gate visibility (amount mode converts).
  const liveEffectivePercent =
    discountMode === 'percent'
      ? Math.max(0, Math.min(100, isNaN(percentValue) ? 0 : percentValue))
      : cartSubtotal > 0
      ? Math.max(0, Math.min(100, (Math.max(0, isNaN(amountValue) ? 0 : amountValue) / cartSubtotal) * 100))
      : 0;

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
                    className={`min-h-[48px] py-2 rounded-xl text-xs font-black border transition active:scale-95 ${
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
                    className={`min-h-[48px] py-2 rounded-xl text-xs font-black border transition active:scale-95 ${
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
                onChange={(e) => setPercentValue(parseLocalizedAmount(e.target.value) || 0)}
                className="w-full bg-pos-card border border-pos-border rounded-xl px-3.5 py-2 text-base font-black text-purple-400 focus:border-purple-400 focus:outline-none"
              />
            ) : (
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={amountValue}
                onChange={(e) => setAmountValue(parseLocalizedAmount(e.target.value) || 0)}
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

          {/* Manager PIN gate for discounts above 10% */}
          {liveEffectivePercent > 10 && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-3.5 space-y-2">
              <p className="text-[11px] font-bold text-red-300">
                Remise de {liveEffectivePercent.toFixed(0)}% &gt; 10% : PIN Manager requis
              </p>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="current-password"
                value={managerPinInput}
                onChange={(e) => {
                  setManagerPinInput(e.target.value);
                  setPinError(null);
                }}
                placeholder="Code PIN Manager"
                className="w-full bg-pos-card border border-red-500/40 rounded-xl px-3 py-2 text-xs text-pos-text focus:outline-none"
              />
              {pinError && <p className="text-[10px] text-red-400 font-bold">{pinError}</p>}
            </div>
          )}
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



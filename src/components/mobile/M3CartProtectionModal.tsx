import React from 'react';
import { PauseCircle, Trash2, ArrowLeft, ShoppingBag } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { computeCartTotals } from '../../utils/receiptMath';
import { soundEngine } from '../../utils/audioFeedback';
import { useRegisterMobileBackHandler } from '../../hooks/useMobileBackNavigation';
import { useTranslation, Bdi } from '../../i18n';

interface M3CartProtectionModalProps {
  isOpen: boolean;
  onContinueSale: () => void;
  onHoldAndExit: () => void;
  onDiscardAndExit: () => void;
}

export const M3CartProtectionModal: React.FC<M3CartProtectionModalProps> = ({
  isOpen,
  onContinueSale,
  onHoldAndExit,
  onDiscardAndExit,
}) => {
  const { t } = useTranslation();
  const cart = usePosStore((state) => state.cart);
  const pricingTier = usePosStore((state) => state.pricingTier);
  const storeCreditApplied = usePosStore((state) => state.storeCreditApplied);
  const voucherCreditApplied =
    usePosStore((s) => (s as unknown as { voucherCreditApplied?: number }).voucherCreditApplied ?? 0) || 0;

  useRegisterMobileBackHandler(isOpen, onContinueSale, 'cart-protection');

  if (!isOpen) return null;

  // At-risk total from the canonical checkout math (tier, discounts,
  // credits, VAT) — the naive appliedPrice sum overstated risk whenever
  // markdowns or credits were staged.
  const cartTotals = computeCartTotals(cart, {
    pricingTier,
    storeCreditApplied,
    voucherCreditApplied,
  });
  const cartTotal = Math.max(0, cartTotals.total);
  const totalItems = cart.reduce((acc, item) => acc + item.quantity, 0);

  return (
    <div
      onClick={onContinueSale}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-protection-title"
        aria-describedby="cart-protection-description"
        onClick={(e) => e.stopPropagation()}
        className="pos-bottom-sheet bg-pos-panel border-t sm:border border-pos-border sm:rounded-3xl w-full max-w-md max-h-[92dvh] overflow-y-auto overscroll-contain flex flex-col shadow-2xl p-5 sm:p-6 text-center space-y-4"
      >
        {/* M3 / iOS Standard Drag Handle */}
        <div className="sheet-handle -mt-1 mb-2 sm:hidden" aria-hidden="true" />

        {/* Warning Icon Badge */}
        <div className="w-14 h-14 rounded-2xl pos-status-warn border flex items-center justify-center mx-auto shadow-xs shrink-0">
          <ShoppingBag className="w-7 h-7" aria-hidden="true" />
        </div>

        {/* Dialog Header & Cart Summary */}
        <div className="space-y-1.5">
          <h2 id="cart-protection-title" className="text-base font-black text-pos-text tracking-tight">
            {t.cartProtection.title}
          </h2>
          <p id="cart-protection-description" className="text-xs text-pos-muted max-w-xs mx-auto leading-relaxed">
            {t.cartProtection.summaryTemplate
              ? t.cartProtection.summaryTemplate
                  .split(/\{count\}|\{total\}/)
                  .reduce<React.ReactNode[]>((acc: React.ReactNode[], part: string, idx: number) => {
                    acc.push(part);
                    if (idx === 0) {
                      acc.push(
                        <strong key="count" className="text-pos-text">
                          <Bdi>{totalItems}</Bdi>
                        </strong>
                      );
                    } else if (idx === 1) {
                      acc.push(
                        <strong key="total" className="text-emerald-700 dark:text-emerald-400 font-mono tabular-nums">
                          <Bdi mono>{formatDZD(cartTotal)}</Bdi>
                        </strong>
                      );
                    }
                    return acc;
                  }, [])
              : (
                <>
                  Votre panier contient{' '}
                  <strong className="text-pos-text">
                    <Bdi>{totalItems}</Bdi> article{totalItems > 1 ? 's' : ''}
                  </strong>{' '}
                  pour un total de{' '}
                  <strong className="text-emerald-700 dark:text-emerald-400 font-mono tabular-nums">
                    <Bdi mono>{formatDZD(cartTotal)}</Bdi>
                  </strong>
                  .
                </>
              )}
          </p>
        </div>

        {/* M3 Action Buttons Hierarchy */}
        <div className="flex flex-col gap-2.5 pt-2">
          {/* 1. PRIMARY: Conserver la vente (High Emphasis - Filled Emerald) */}
          <button
            type="button"
            onClick={() => {
              soundEngine.playKeyBeep?.();
              onContinueSale();
            }}
            className="w-full min-h-[52px] rounded-2xl bg-emerald-500 hover:bg-emerald-400 active-press text-slate-950 font-black text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 transition cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4 stroke-[2.5] rtl:rotate-180" aria-hidden="true" />
            <span>{t.cartProtection.keepSale}</span>
          </button>

          {/* 2. SECONDARY: Suspendre le ticket (Medium Emphasis - Tonal Amber) */}
          <button
            type="button"
            onClick={() => {
              soundEngine.playSuccess?.();
              onHoldAndExit();
            }}
            className="w-full min-h-[52px] rounded-2xl pos-status-warn border hover:bg-amber-500/25 active-press font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <PauseCircle className="w-4 h-4" aria-hidden="true" />
            <span>{t.cartProtection.holdTicket}</span>
          </button>

          {/* Separator before destructive action */}
          <div className="w-full border-t border-pos-border/50 my-0.5" />

          {/* 3. DESTRUCTIVE: Vider le panier (Low Emphasis / Danger Tonal) */}
          <button
            type="button"
            onClick={() => {
              soundEngine.playKeyBeep?.();
              onDiscardAndExit();
            }}
            className="w-full min-h-[52px] rounded-2xl pos-status-danger border hover:bg-rose-500/20 active-press font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
            <span>{t.cartProtection.clearCart}</span>
          </button>
        </div>
      </div>
    </div>
  );
};


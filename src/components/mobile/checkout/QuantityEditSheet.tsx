import React from 'react';
import { Minus, Plus, X } from 'lucide-react';
import type { CartItem } from '../../../types/pos';
import { soundEngine } from '../../../utils/audioFeedback';
import { useRegisterMobileBackHandler } from '../../../hooks/useMobileBackNavigation';
import { useTranslation, Bdi } from '../../../i18n';

export interface QuantityEditSheetProps {
  editingQtyItem: CartItem | null;
  onClose: () => void;
  customQtyInput: string;
  onCustomQtyChange: (val: string | ((prev: string) => string)) => void;
  onApplyCustomQty: () => void;
}

export const QuantityEditSheet: React.FC<QuantityEditSheetProps> = ({
  editingQtyItem,
  onClose,
  customQtyInput,
  onCustomQtyChange,
  onApplyCustomQty,
}) => {
  const { t } = useTranslation();

  useRegisterMobileBackHandler(Boolean(editingQtyItem), onClose, 'checkout-qty-edit');

  if (!editingQtyItem) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-qty-edit-title"
        className="pos-bottom-sheet bg-pos-panel border-t sm:border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[94dvh] sm:max-h-[85dvh] shadow-2xl animate-in slide-in-from-bottom-5 pb-[max(1.25rem,var(--safe-bottom))] sm:pb-0"
      >
        {/* Sheet Handle */}
        <div
          className="sheet-handle w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0"
          aria-hidden="true"
        />

        <div className="p-3.5 border-b border-pos-border flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3
              id="checkout-qty-edit-title"
              className="text-xs sm:text-sm font-black text-pos-text truncate max-w-[280px]"
            >
              {t('checkout.editQuantityTitle', 'Modifier la Quantité')}
            </h3>
            <p className="text-[11px] text-pos-muted truncate max-w-[280px]">
              {editingQtyItem.product.title}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-12 h-12 min-h-[48px] min-w-[48px] flex items-center justify-center rounded-xl bg-pos-card text-pos-muted hover:text-pos-text cursor-pointer shrink-0"
            aria-label={t.common.close}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 space-y-3.5">
          {/* Numeric Input & Stepper Controls */}
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => {
                soundEngine.playKeyBeep?.();
                onCustomQtyChange((prev) => String(Math.max(1, (parseInt(prev, 10) || 1) - 1)));
              }}
              className="w-12 h-12 min-h-[48px] min-w-[48px] rounded-2xl bg-pos-card border border-pos-border text-pos-text hover:border-pos-text active-press flex items-center justify-center cursor-pointer"
              aria-label={t.checkout.minusOneAria}
            >
              <Minus className="w-5 h-5" aria-hidden="true" />
            </button>

            <div className="w-32">
              <input
                type="number"
                inputMode="numeric"
                min="1"
                dir="ltr"
                aria-label="Quantité"
                value={customQtyInput}
                onChange={(e) => onCustomQtyChange(e.target.value)}
                className="w-full min-h-[52px] text-center font-mono tabular-nums font-black text-2xl bg-pos-card border-2 border-emerald-500/50 rounded-2xl text-pos-text focus:outline-none"
                autoFocus
              />
            </div>

            <button
              type="button"
              onClick={() => {
                soundEngine.playKeyBeep?.();
                onCustomQtyChange((prev) => String((parseInt(prev, 10) || 0) + 1));
              }}
              className="w-12 h-12 min-h-[48px] min-w-[48px] rounded-2xl bg-pos-card border border-pos-border text-emerald-700 dark:text-emerald-400 hover:border-emerald-400 active-press flex items-center justify-center cursor-pointer"
              aria-label={t.checkout.plusOneAria}
            >
              <Plus className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>

          {/* Quick Presets (1, 5, 10, 20, 50, 100) */}
          <div className="space-y-1">
            <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
              {t.checkout.quickQuantityPresets}
            </span>
            <div className="grid grid-cols-6 gap-1.5">
              {[1, 5, 10, 20, 50, 100].map((val) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => {
                    soundEngine.playKeyBeep?.();
                    onCustomQtyChange(String(val));
                  }}
                  className="py-2 rounded-xl bg-pos-card border border-pos-border hover:border-cyan-400 text-cyan-800 dark:text-cyan-300 font-mono tabular-nums font-bold text-xs min-h-[48px] active-press cursor-pointer"
                >
                  <Bdi mono>{val}</Bdi>
                </button>
              ))}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[48px] rounded-xl bg-pos-card border border-pos-border text-pos-muted hover:text-pos-text font-bold text-xs active-press transition cursor-pointer"
            >
              {t.common.cancel}
            </button>
            <button
              type="button"
              onClick={onApplyCustomQty}
              className="min-h-[48px] rounded-xl bg-emerald-500 hover:bg-emerald-400 active-press text-slate-950 font-black text-xs transition cursor-pointer shadow-md shadow-emerald-500/20"
            >
              {t.common.validate}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

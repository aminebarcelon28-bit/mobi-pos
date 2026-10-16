import React from 'react';
import { Tag, X, AlertTriangle } from 'lucide-react';
import type { CartItem } from '../../../types/pos';
import { formatDZD } from '../../../types/pos';
import { toLegacyReal, dinarsToMinor } from '../../../utils/money';
import { MoneyInput } from '../../ui/MoneyInput';
import { soundEngine } from '../../../utils/audioFeedback';
import { useRegisterMobileBackHandler } from '../../../hooks/useMobileBackNavigation';
import { useTranslation, Bdi } from '../../../i18n';

export interface PriceOverrideSheetProps {
  editingItem: CartItem | null;
  onClose: () => void;
  overridePriceInput: number;
  onOverridePriceChange: (price: number) => void;
  editingFifoCost: number | undefined;
  managerPinInput: string;
  onManagerPinChange: (pin: string) => void;
  overrideError: string | null;
  onApplyPriceOverride: () => void;
  moneyInputSlot?: React.ReactNode;
  marginSummaryNode?: React.ReactNode;
}

export const PriceOverrideSheet: React.FC<PriceOverrideSheetProps> = ({
  editingItem,
  onClose,
  overridePriceInput,
  onOverridePriceChange,
  editingFifoCost,
  managerPinInput,
  onManagerPinChange,
  overrideError,
  onApplyPriceOverride,
  moneyInputSlot,
  marginSummaryNode,
}) => {
  const { t } = useTranslation();

  useRegisterMobileBackHandler(Boolean(editingItem), onClose, 'checkout-price-override');

  if (!editingItem) return null;

  const newPrice = overridePriceInput || 0;
  // STRICT LEDGER: displayed margin is FIFO-or-pending (never a
  // costPrice-derived number); the below-cost gate keeps the
  // conservative fallback so protection never sleeps.
  const costKnown =
    editingFifoCost !== undefined ||
    editingItem.unitCostAtSale !== undefined ||
    editingItem.unitCostPrice !== undefined;
  const cost =
    editingFifoCost ??
    editingItem.unitCostAtSale ??
    editingItem.unitCostPrice ??
    editingItem.product.costPrice ??
    0;
  const def = editingItem.defaultPrice ?? editingItem.product.price;
  const profit = (newPrice - cost) * editingItem.quantity;
  const discount = Math.max(0, def - newPrice);
  const discountPct = def > 0 ? ((discount / def) * 100).toFixed(0) : '0';
  const isLoss = newPrice < cost;
  const isHighDisc = Number(discountPct) > 20;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-price-override-title"
        className="pos-bottom-sheet bg-pos-panel border-t sm:border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[94dvh] sm:max-h-[90dvh] shadow-2xl animate-in slide-in-from-bottom-5"
      >
        {/* Sheet Handle */}
        <div
          className="sheet-handle w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0"
          aria-hidden="true"
        />

        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-700 dark:text-amber-400 flex items-center justify-center shrink-0">
              <Tag className="w-4 h-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h3
                id="checkout-price-override-title"
                className="text-xs sm:text-sm font-black text-pos-text truncate"
              >
                {t('checkout.editUnitPriceTitle', 'Modifier le Prix Unitaire')}
              </h3>
              <p className="text-[11px] text-pos-muted truncate">{editingItem.product.title}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-pos-muted hover:text-pos-text min-h-[48px] min-w-[48px] flex items-center justify-center shrink-0 rounded-xl hover:bg-pos-card cursor-pointer"
            aria-label={t.common.close}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 space-y-3.5 overflow-y-auto overscroll-contain pb-[max(1.5rem,var(--safe-bottom))] sm:pb-4">
          {/* Product Info Pills */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
              <span className="text-[10px] text-pos-muted uppercase font-bold block">{t.checkout.standardPrice}</span>
              <span className="font-mono tabular-nums font-black text-pos-text text-sm block mt-0.5">
                <Bdi mono>{formatDZD(def)}</Bdi>
              </span>
            </div>
            <div className="bg-pos-card p-2.5 rounded-xl border border-pos-border">
              <span className="text-[10px] text-cyan-800 dark:text-cyan-400 uppercase font-bold block">
                {t.checkout.fifoStockCost}
              </span>
              <span className="font-mono tabular-nums font-black text-cyan-800 dark:text-cyan-300 text-sm block mt-0.5">
                <Bdi mono>
                  {(() => {
                    const known =
                      editingFifoCost ?? editingItem.unitCostAtSale ?? editingItem.unitCostPrice;
                    return known === undefined
                      ? '…'
                      : formatDZD(known ?? editingItem.product.costPrice ?? 0);
                  })()}
                </Bdi>
              </span>
            </div>
          </div>

          {/* Price Input Field */}
          <div>
            <label className="text-xs font-bold text-pos-text block mb-1">
              {t.checkout.newSoldPriceLabel}
            </label>
            <div>
              {moneyInputSlot ?? (
                <MoneyInput
                  label="Nouveau Prix Vendu (DA / unité)"
                  valueMinor={dinarsToMinor(overridePriceInput || 0)}
                  onChangeMinor={(minor) => {
                    onOverridePriceChange(toLegacyReal(minor));
                  }}
                  placeholder="Saisir montant..."
                  className="w-full min-h-[48px] bg-pos-card border border-pos-border focus:border-amber-400 rounded-xl px-3 py-2 text-base font-mono font-black text-pos-text focus:outline-none shadow-xs"
                />
              )}
            </div>
          </div>

          {/* Quick Discount Shortcut Chips */}
          <div className="space-y-1">
            <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
              {t.checkout.quickDiscountShortcuts}
            </span>
            <div className="grid grid-cols-5 gap-1.5">
              {[5, 10, 15, 20].map((pct) => {
                const discounted = Math.round(def * (1 - pct / 100));
                return (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => {
                      soundEngine.playKeyBeep?.();
                      onOverridePriceChange(discounted);
                    }}
                    className="py-2 rounded-xl bg-pos-card border border-pos-border hover:border-amber-500/40 text-amber-700 dark:text-amber-400 font-black text-[11px] min-h-[48px] transition cursor-pointer active:scale-95"
                  >
                    <Bdi mono>-{pct}%</Bdi>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  onOverridePriceChange(def);
                }}
                className="py-2 rounded-xl bg-pos-card border border-pos-border hover:border-pos-text text-pos-muted hover:text-pos-text font-bold text-[10px] min-h-[48px] transition cursor-pointer active:scale-95"
              >
                {t.checkout.resetPriceButton}
              </button>
            </div>
          </div>

          {/* Live Margin and Loss Calculations */}
          <div className="space-y-2 pt-1">
            <div className="flex justify-between items-center text-xs bg-pos-card p-2.5 rounded-xl border border-pos-border font-mono tabular-nums">
              <span className="text-pos-muted">
                Remise : <Bdi mono>-{formatDZD(discount)} ({discountPct}%)</Bdi>
              </span>
              <span
                className={
                  isLoss
                    ? 'text-rose-700 dark:text-rose-400 font-black'
                    : 'text-emerald-700 dark:text-emerald-400 font-black'
                }
              >
                {marginSummaryNode ?? (
                  <Bdi mono>
                    Marge : {costKnown ? (isLoss ? '' : '+') : ''}{costKnown ? formatDZD(profit) : '…'}
                  </Bdi>
                )}
              </span>
            </div>

            {(isLoss || isHighDisc) && (
              <div className="pos-status-danger p-3 rounded-xl space-y-2">
                <div className="flex items-center gap-2 text-rose-700 dark:text-rose-400 text-xs font-bold">
                  <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>
                    {isLoss ? t.checkout.belowCostWarning : t.checkout.highDiscountWarning} — {t.checkout.pinRequiredSuffix}
                  </span>
                </div>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="current-password"
                  maxLength={8}
                  dir="ltr"
                  value={managerPinInput}
                  onChange={(e) => onManagerPinChange(e.target.value)}
                  placeholder={t('checkout.managerPinPlaceholder', 'Code PIN Manager (ex: 123456)')}
                  className="w-full min-h-[48px] bg-pos-card border border-rose-500/40 rounded-xl px-3 py-2 text-base sm:text-sm text-pos-text focus:outline-none text-center font-mono tracking-widest"
                />
              </div>
            )}
          </div>

          {overrideError && (
            <p className="pos-status-danger text-xs text-rose-700 dark:text-rose-300 font-bold p-2.5 rounded-xl">
              {overrideError}
            </p>
          )}

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[48px] rounded-xl bg-pos-card border border-pos-border text-pos-muted hover:text-pos-text font-bold text-xs active:scale-95 transition cursor-pointer"
            >
              {t.common.cancel}
            </button>
            <button
              type="button"
              onClick={onApplyPriceOverride}
              className="min-h-[48px] rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs active:scale-95 transition cursor-pointer shadow-md shadow-amber-500/20"
            >
              {t.checkout.applyPriceButton}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

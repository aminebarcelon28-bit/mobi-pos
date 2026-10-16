import React from 'react';
import { Banknote, Coins, Wallet, Delete, Check, X } from 'lucide-react';
import { formatDZD } from '../../../types/pos';
import { soundEngine } from '../../../utils/audioFeedback';
import { useRegisterMobileBackHandler } from '../../../hooks/useMobileBackNavigation';
import { useTranslation, Bdi } from '../../../i18n';

export interface CashTenderSheetProps {
  isOpen: boolean;
  onClose: () => void;
  netTotal: number;
  tenderedStr: number;
  onSelectPreset: (amount: number) => void;
  onDigitPress: (digit: number) => void;
  onDoubleZeroPress: () => void;
  onTripleZeroPress: () => void;
  onClear: () => void;
  onBackspace: () => void;
  smartBanknotes: number[];
  isSoulte: boolean;
  soulteDue: number;
  soulteHeadingText?: string;
  exchangeSoultePayout: 'cash' | 'wallet' | null;
  onSelectSoultePayout: (mode: 'cash' | 'wallet') => void;
  isSubmitting: boolean;
  onConfirmCashTender: () => void;
}

export const CashTenderSheet: React.FC<CashTenderSheetProps> = ({
  isOpen,
  onClose,
  netTotal,
  tenderedStr,
  onSelectPreset,
  onDigitPress,
  onDoubleZeroPress,
  onTripleZeroPress,
  onClear,
  onBackspace,
  smartBanknotes,
  isSoulte,
  soulteDue,
  soulteHeadingText,
  exchangeSoultePayout,
  onSelectSoultePayout,
  isSubmitting,
  onConfirmCashTender,
}) => {
  const { t } = useTranslation();

  useRegisterMobileBackHandler(isOpen, onClose, 'checkout-cash-tender');

  if (!isOpen) return null;

  const tenderedNum = tenderedStr;
  const changeDue = Math.max(0, tenderedNum - netTotal);
  const remainingDue = Math.max(0, netTotal - tenderedNum);
  const isExact = tenderedNum === netTotal;
  const isOver = tenderedNum > netTotal;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-0 sm:pb-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-cash-tender-title"
        className="pos-bottom-sheet bg-pos-panel border-t sm:border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[94dvh] sm:max-h-[92dvh] shadow-2xl animate-in slide-in-from-bottom-5 pb-[max(1rem,var(--safe-bottom))] sm:pb-0"
      >
        {/* Sheet Handle */}
        <div
          className="sheet-handle w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0"
          aria-hidden="true"
        />

        {/* Header */}
        <div className="px-4 py-3 border-b border-pos-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
              <Banknote className="w-4 h-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h3 id="checkout-cash-tender-title" className="text-sm font-black text-pos-text truncate">
                {t('checkout.cashTenderTitle', 'Encaissement Espèces')}
              </h3>
              <p className="text-[11px] text-pos-muted truncate">
                {t.checkout.cashTenderSubtitle}
              </p>
            </div>
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

        <div className="p-4 space-y-3 overflow-y-auto overscroll-contain">
          {/* Total Net & Change Due Display Card */}
          <div className="space-y-2">
            {/* Primary Display */}
            <div className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-2">
              <div className="flex justify-between items-baseline text-xs text-pos-muted">
                <span className="font-bold uppercase tracking-wider">{t.checkout.netTotalToPay}</span>
                <span className="text-lg font-mono font-black text-pos-text tabular-nums">
                  <Bdi mono>{formatDZD(netTotal)}</Bdi>
                </span>
              </div>

              <div className="flex justify-between items-baseline pt-2 border-t border-pos-border">
                <span className="text-xs font-bold text-pos-muted uppercase tracking-wider">
                  {t.checkout.amountReceived}
                </span>
                <span className="text-2xl font-mono font-black text-emerald-700 dark:text-emerald-400 tabular-nums">
                  <Bdi mono>{formatDZD(tenderedNum)}</Bdi>
                </span>
              </div>
            </div>

            {/* Change Due or Remaining Due Banner */}
            {isOver ? (
              <div className="pos-status-ok rounded-2xl p-3 flex items-center justify-between animate-in zoom-in-95">
                <div className="flex items-center gap-2">
                  <Coins className="w-5 h-5 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                  <div>
                    <span className="text-[10px] text-emerald-800 dark:text-emerald-300 uppercase font-black tracking-wider block">
                      {t.checkout.changeDueLabel}
                    </span>
                    <span className="text-xl font-mono font-black text-emerald-700 dark:text-emerald-400 tabular-nums">
                      <Bdi mono>+{formatDZD(changeDue)}</Bdi>
                    </span>
                  </div>
                </div>
                <span className="text-[10px] bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 font-bold px-2 py-0.5 rounded-full">
                  {t.checkout.higherBanknoteBadge}
                </span>
              </div>
            ) : isExact ? (
              <div className="pos-status-info rounded-2xl p-2.5 text-center text-xs font-bold text-cyan-800 dark:text-cyan-300 animate-in zoom-in-95">
                {t.checkout.exactAmountBanner}
              </div>
            ) : (
              <div className="pos-status-warn rounded-2xl p-3 flex items-center justify-between animate-in zoom-in-95">
                <div>
                  <span className="text-[10px] text-amber-800 dark:text-amber-300 uppercase font-bold tracking-wider block">
                    {t.checkout.remainingToReceive}
                  </span>
                  <span className="text-lg font-mono font-black text-amber-700 dark:text-amber-400 tabular-nums">
                    <Bdi mono>{formatDZD(remainingDue)}</Bdi>
                  </span>
                </div>
                <span className="text-[10px] bg-amber-500/20 text-amber-800 dark:text-amber-300 font-bold px-2 py-0.5 rounded-full">
                  {t.checkout.insufficientBadge}
                </span>
              </div>
            )}
          </div>

          {/* Soulte Boutique selector (Net<0 exchange): explicit choice only */}
          {isSoulte && (
            <div className="pos-status-warn rounded-2xl p-3 space-y-2">
              <p className="text-xs font-black text-amber-800 dark:text-amber-200">
                {soulteHeadingText ?? 'Soulte à verser'} : <Bdi mono>{formatDZD(soulteDue)}</Bdi> — choisissez le mode :
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  role="radio"
                  aria-checked={exchangeSoultePayout === 'cash'}
                  onClick={() => onSelectSoultePayout('cash')}
                  className={`min-h-[48px] px-2 rounded-xl border text-[11px] font-black flex items-center justify-center gap-1.5 transition active:scale-[0.98] cursor-pointer ${
                    exchangeSoultePayout === 'cash'
                      ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                      : 'bg-pos-card text-pos-text border-pos-border'
                  }`}
                >
                  <Banknote className="w-4 h-4 shrink-0" aria-hidden="true" /> {t.checkout.soultePayoutCash}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={exchangeSoultePayout === 'wallet'}
                  onClick={() => onSelectSoultePayout('wallet')}
                  className={`min-h-[48px] px-2 rounded-xl border text-[11px] font-black flex items-center justify-center gap-1.5 transition active:scale-[0.98] cursor-pointer ${
                    exchangeSoultePayout === 'wallet'
                      ? 'bg-purple-500 text-white border-purple-400'
                      : 'bg-pos-card text-pos-text border-pos-border'
                  }`}
                >
                  <Wallet className="w-4 h-4 shrink-0" aria-hidden="true" /> {t.checkout.soultePayoutWallet}
                </button>
              </div>
            </div>
          )}

          {/* Algerian Banknote Preset Quick-Chips */}
          <div className="space-y-1">
            <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider block">
              {t.checkout.quickBanknotesLabel}
            </span>
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1">
              {smartBanknotes.map((preset) => {
                const isSelected = tenderedStr === preset;
                const isPresetExact = preset === netTotal;

                return (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={
                      isPresetExact
                        ? `Exact (${formatDZD(preset)}) — Montant exact`
                        : `${formatDZD(preset)} — Encaisser`
                    }
                    onClick={() => {
                      soundEngine.playKeyBeep?.();
                      onSelectPreset(preset);
                    }}
                    className={`px-3 py-2 rounded-xl text-xs font-mono tabular-nums font-black shrink-0 transition active-press cursor-pointer border min-h-[48px] ${
                      isSelected
                        ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-md shadow-emerald-500/20'
                        : isPresetExact
                        ? 'bg-cyan-500/15 text-cyan-800 dark:text-cyan-300 border-cyan-500/30 hover:bg-cyan-500/25'
                        : 'bg-pos-card text-pos-text border-pos-border hover:border-emerald-500/40'
                    }`}
                  >
                    <Bdi mono>{isPresetExact ? `Exact (${formatDZD(preset)})` : formatDZD(preset)}</Bdi>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Touch Keypad (dir="ltr" 3-column grid with >= 52px Hitboxes + 00 / 000 Algerian DZD accelerators) */}
          <div dir="ltr" className="grid grid-cols-3 gap-2 pt-1">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => {
                  soundEngine.playKeyBeep?.();
                  onDigitPress(Number(d));
                }}
                className="min-h-[52px] rounded-2xl bg-pos-card border border-pos-border hover:border-pos-text/30 active-press text-lg font-mono tabular-nums font-bold text-pos-text flex items-center justify-center cursor-pointer shadow-xs"
              >
                {d}
              </button>
            ))}

            {/* Row 4: 00, 0, 000 */}
            <button
              type="button"
              onClick={() => {
                soundEngine.playKeyBeep?.();
                onDoubleZeroPress();
              }}
              className="min-h-[52px] rounded-2xl bg-pos-card border border-pos-border hover:border-pos-text/30 active-press text-base font-mono tabular-nums font-bold text-pos-text flex items-center justify-center cursor-pointer shadow-xs"
            >
              00
            </button>

            <button
              type="button"
              onClick={() => {
                soundEngine.playKeyBeep?.();
                onDigitPress(0);
              }}
              className="min-h-[52px] rounded-2xl bg-pos-card border border-pos-border hover:border-pos-text/30 active-press text-lg font-mono tabular-nums font-bold text-pos-text flex items-center justify-center cursor-pointer shadow-xs"
            >
              0
            </button>

            <button
              type="button"
              onClick={() => {
                soundEngine.playKeyBeep?.();
                onTripleZeroPress();
              }}
              className="min-h-[52px] rounded-2xl bg-pos-card border border-pos-border hover:border-pos-text/30 active-press text-base font-mono tabular-nums font-bold text-pos-text flex items-center justify-center cursor-pointer shadow-xs"
            >
              000
            </button>

            {/* Row 5: Clear (C) + Backspace */}
            <button
              type="button"
              onClick={() => {
                soundEngine.playKeyBeep?.();
                onClear();
              }}
              className="min-h-[52px] rounded-2xl bg-rose-500/10 border border-rose-500/20 hover:bg-rose-500/20 active-press text-rose-700 dark:text-rose-400 font-black text-sm flex items-center justify-center cursor-pointer"
              title={t.common.clear}
              aria-label={t.common.clear}
            >
              <span aria-hidden="true">C</span>
            </button>

            <button
              type="button"
              onClick={() => {
                soundEngine.playKeyBeep?.();
                onBackspace();
              }}
              className="col-span-2 min-h-[52px] rounded-2xl bg-pos-card border border-pos-border hover:border-pos-text/30 active-press text-pos-muted hover:text-pos-text flex items-center justify-center cursor-pointer"
              aria-label={t.checkout.clearDigitAria}
            >
              <Delete className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>

          {/* Confirm Cash Tender Button */}
          <button
            type="button"
            disabled={isSubmitting || tenderedStr < netTotal}
            onClick={onConfirmCashTender}
            className="w-full min-h-[54px] rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 active-press text-slate-950 font-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 transition cursor-pointer disabled:opacity-50 disabled:pointer-events-none mt-2"
          >
            <Check className="w-5 h-5 stroke-[2.5]" aria-hidden="true" />
            <span>{t.checkout.confirmCashTender}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

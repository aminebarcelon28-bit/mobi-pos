import React from 'react';
import { Delete } from 'lucide-react';
import { formatDZD } from '../types/pos';
import { triggerTactilePulse } from '../utils/platform';

export type NumericKeypadMode = 'pin' | 'currency-dzd' | 'quantity';

export interface NumericKeypadProps {
  /** Called when a digit ('0'..'9' or '00' / '000' in currency-dzd mode) is pressed. */
  onDigit: (digitSequence: string) => void;
  /** Called when Backspace (⌫) is pressed. */
  onBackspace: () => void;
  /** Called when Clear (C) is pressed. */
  onClear?: () => void;
  /** Optional explicit Submit action (never auto-triggered at fixed length per Phase 4.5). */
  onSubmit?: () => void;
  submitLabel?: string;
  submitDisabled?: boolean;
  mode?: NumericKeypadMode;
  /** Quick-tender DZD banknote chips above the grid (e.g., [200, 500, 1000, 2000]). */
  quickAmountsDzd?: readonly number[];
  onQuickAmountSelect?: (amountDzd: number) => void;
  /** Accessible label for Backspace key (default: "Effacer le dernier chiffre"). */
  backspaceAriaLabel?: string;
  /** Accessible label for Clear key (default: "Effacer la saisie"). */
  clearAriaLabel?: string;
  /** Accessible label for keypad group (default: "Clavier numérique"). */
  groupAriaLabel?: string;
  disabled?: boolean;
  className?: string;
}

const STANDARD_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export const NumericKeypad: React.FC<NumericKeypadProps> = ({
  onDigit,
  onBackspace,
  onClear,
  onSubmit,
  submitLabel = 'Valider',
  submitDisabled = false,
  mode = 'pin',
  quickAmountsDzd,
  onQuickAmountSelect,
  backspaceAriaLabel = 'Effacer le dernier chiffre',
  clearAriaLabel = 'Effacer la saisie',
  groupAriaLabel = 'Clavier numérique',
  disabled = false,
  className = '',
}) => {
  const handleDigitPress = (seq: string) => {
    if (disabled) return;
    triggerTactilePulse(8);
    onDigit(seq);
  };

  const handleBackspacePress = () => {
    if (disabled) return;
    triggerTactilePulse(8);
    onBackspace();
  };

  const handleClearPress = () => {
    if (disabled || !onClear) return;
    triggerTactilePulse(8);
    onClear();
  };

  return (
    <div className={`w-full space-y-2.5 select-none ${className}`}>
      {/* Optional DZD Banknote Quick-Tender Chips */}
      {quickAmountsDzd && quickAmountsDzd.length > 0 && onQuickAmountSelect ? (
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-0.5">
          {quickAmountsDzd.map((amt) => (
            <button
              key={amt}
              type="button"
              disabled={disabled}
              onClick={() => {
                triggerTactilePulse(8);
                onQuickAmountSelect(amt);
              }}
              className="min-h-[48px] px-3.5 py-2 rounded-full border pos-status-ok text-xs font-black tabular-nums whitespace-nowrap shrink-0 cursor-pointer m3-morph-pill disabled:opacity-50 disabled:pointer-events-none"
            >
              <bdi dir="ltr">{formatDZD(amt)}</bdi>
            </button>
          ))}
        </div>
      ) : null}

      {/* 3x4 Telephone Keypad Grid — forced dir="ltr" per R-RTL-01 */}
      <div
        role="group"
        aria-label={groupAriaLabel}
        dir="ltr"
        className="grid grid-cols-3 gap-2.5"
      >
        {STANDARD_DIGITS.map((digit) => (
          <button
            key={digit}
            type="button"
            disabled={disabled}
            onClick={() => handleDigitPress(digit)}
            className="min-h-[56px] min-w-[48px] rounded-2xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-text text-xl font-black tabular-nums flex items-center justify-center cursor-pointer active-press m3-morph-pill shadow-2xs disabled:opacity-50 disabled:pointer-events-none"
          >
            {digit}
          </button>
        ))}

        {/* Bottom-left slot: Clear ('C') or '00' in currency-dzd mode */}
        {mode === 'currency-dzd' && !onClear ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleDigitPress('00')}
            className="min-h-[56px] min-w-[48px] rounded-2xl bg-surface-high hover:bg-pos-hover border border-pos-border text-pos-text text-lg font-black tabular-nums flex items-center justify-center cursor-pointer active-press m3-morph-pill disabled:opacity-50 disabled:pointer-events-none"
          >
            00
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || !onClear}
            onClick={handleClearPress}
            aria-label={clearAriaLabel}
            className="min-h-[56px] min-w-[48px] rounded-2xl bg-surface-high hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text text-base font-black flex items-center justify-center cursor-pointer active-press m3-morph-pill disabled:opacity-40 disabled:pointer-events-none"
          >
            <span aria-hidden="true">C</span>
          </button>
        )}

        {/* Bottom-center slot: '0' */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => handleDigitPress('0')}
          className="min-h-[56px] min-w-[48px] rounded-2xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-text text-xl font-black tabular-nums flex items-center justify-center cursor-pointer active-press m3-morph-pill shadow-2xs disabled:opacity-50 disabled:pointer-events-none"
        >
          0
        </button>

        {/* Bottom-right slot: Backspace ('⌫') with aria-hidden glyph */}
        <button
          type="button"
          disabled={disabled}
          onClick={handleBackspacePress}
          aria-label={backspaceAriaLabel}
          className="min-h-[56px] min-w-[48px] rounded-2xl bg-surface-high hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text flex items-center justify-center cursor-pointer active-press m3-morph-pill disabled:opacity-50 disabled:pointer-events-none"
        >
          <span aria-hidden="true" className="inline-flex items-center justify-center">
            <Delete className="w-5 h-5" />
          </span>
        </button>
      </div>

      {/* Extra row for currency-dzd mode when both Clear and 00/000 shortcuts are helpful */}
      {mode === 'currency-dzd' && onClear ? (
        <div dir="ltr" className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleDigitPress('00')}
            className="min-h-[48px] rounded-xl bg-surface-high hover:bg-pos-hover border border-pos-border text-pos-text text-sm font-black tabular-nums flex items-center justify-center cursor-pointer active-press m3-morph-pill disabled:opacity-50 disabled:pointer-events-none"
          >
            00
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleDigitPress('000')}
            className="min-h-[48px] rounded-xl bg-surface-high hover:bg-pos-hover border border-pos-border text-pos-text text-sm font-black tabular-nums flex items-center justify-center cursor-pointer active-press m3-morph-pill disabled:opacity-50 disabled:pointer-events-none"
          >
            000
          </button>
        </div>
      ) : null}

      {onSubmit ? (
        <button
          type="button"
          disabled={disabled || submitDisabled}
          onClick={onSubmit}
          className="w-full min-h-[52px] px-5 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white text-base font-black flex items-center justify-center cursor-pointer active-press shadow-sm disabled:opacity-50 disabled:pointer-events-none"
        >
          {submitLabel}
        </button>
      ) : null}
    </div>
  );
};

export default NumericKeypad;

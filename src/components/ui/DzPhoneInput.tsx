import React, { useId, useRef, useState } from 'react';
import {
  cleanPhone,
  detectDzOperator,
  formatDzPhone,
  validateDzPhone,
  type OperatorMeta,
} from '../../utils/dzPhoneUtils';

export interface DzPhoneInputProps {
  /** Controlled raw value — any form accepted (`06…`, `+213…`, partial). */
  value: string;
  /**
   * Fires with the FORMATTED display string (`05 50 12 34 56`,
   * `+213 550 12 34 56`). Formatting is derived from digits-only
   * (`formatDzPhone(cleanPhone(domValue))`), so the stored shape matches
   * what the operator sees and what persistence tests assert; canonicalize
   * at submit with `toBackendNational` / `normalizeAlgerianPhone(...).local`.
   * Never fires when the keystroke was rejected (ceiling / separator) — the
   * DOM is repaired in place instead (see `commitDomValue`).
   */
  onChange: (formatted: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  tabIndex?: number;
  autoFocus?: boolean;
  /** Live operator badge inside the field. Default true. */
  showBadge?: boolean;
  /** Validation hint line under the field. Default true. */
  showHint?: boolean;
  /** Wrapper classes. */
  className?: string;
  /** Merged onto the <input> (call-site theme preserved). */
  inputClassName?: string;
  /** Merged with the validation ring shadow (no border-class conflicts). */
  style?: React.CSSProperties;
  onBlur?: () => void;
  onFocus?: () => void;
  /** Passthrough only — must already satisfy the AGENTS.md prefix rule. */
  ariaLabel?: string;
  ariaDescribedBy?: string;
  ref?: React.Ref<HTMLInputElement>;
}

const GLYPH: Record<OperatorMeta['icon'], string> = {
  mobilis: 'M',
  djezzy: 'D',
  ooredoo: 'O',
  at: 'AT',
  unknown: '?',
};

/**
 * DzPhoneInput — the ONE DZ phone field in the app.
 *
 * - Owns NO <label> (the parent form does, so `getByRole('textbox', { name })`
 *   keeps working and Label-in-Name stays intact).
 * - State holds the FORMATTED string; every commit re-derives it from
 *   digits only (`formatDzPhone(cleanPhone(domValue))`), so state can never
 *   drift from what is displayed — no `parseInt`/`Number` anywhere, the
 *   leading `0` / `+` survives as plain string.
 * - Keypress guard blocks non-digits (`E`, `.`, `-`, …) and any digit that
 *   would exceed the hard ceiling (10 national / 12 intl / 14 `00213`).
 * - Paste is intercepted, cleaned and clamped — garbage never enters state.
 * - Caret is captured as a digit offset at change time and restored in a
 *   rAF after commit, compensating the one injected digit formatting may
 *   add (trunk `0` on complete trunk-less input). Rejected keystrokes emit
 *   nothing and the DOM is repaired in place, so over-typing is visibly
 *   impossible even for IME/autofill paths that bypass keydown.
 * - Operator badge is `aria-hidden`; status goes to the `aria-live`
 *   hint referenced via `aria-describedby`. Touch target ≥ 44px.
 */
export const DzPhoneInput: React.FC<DzPhoneInputProps> = ({
  value,
  onChange,
  id,
  name,
  placeholder = 'Ex: 0550 12 34 56',
  required = false,
  disabled = false,
  readOnly = false,
  tabIndex,
  autoFocus = false,
  showBadge = true,
  showHint = true,
  className = '',
  inputClassName = '',
  style,
  onBlur,
  onFocus,
  ariaLabel,
  ariaDescribedBy,
  ref,
}) => {
  const fallbackId = useId();
  const inputId = id ?? `dz-phone-${fallbackId.replace(/:/g, '')}`;
  const hintId = `${inputId}-hint`;
  const innerRef = useRef<HTMLInputElement | null>(null);
  const [touched, setTouched] = useState(false);

  const setRefs = (el: HTMLInputElement | null) => {
    innerRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref && typeof ref === 'object') (ref as React.RefObject<HTMLInputElement | null>).current = el;
  };

  const display = formatDzPhone(value);
  const digits = value.replace(/\D/g, '');
  const operator = digits ? detectDzOperator(value) : null;
  const showOpBadge = showBadge && operator && operator.id !== 'unknown';
  const validation = validateDzPhone(value);
  const nonEmpty = digits.length > 0;
  const isValid = nonEmpty && validation.isValid;
  const showError = touched && nonEmpty && !validation.isValid;

  const ringShadow = isValid
    ? '0 0 0 1px rgba(16,185,129,0.65), 0 0 0 3px rgba(16,185,129,0.15)'
    : showError
      ? '0 0 0 1px rgba(245,158,11,0.7), 0 0 0 3px rgba(245,158,11,0.12)'
      : undefined;

  const maxFor = (cleaned: string): number => {
    const d = cleaned.replace(/\D/g, '');
    if (d.startsWith('00213')) return 14;
    if (d.startsWith('213')) return 12;
    return 10;
  };

  /**
   * Place the caret after the `digitIndex`-th digit of the input's CURRENT
   * DOM value. Runs in a rAF so it lands after React's re-render paint —
   * this is the controlled-component cursor fix (capture offset at change
   * time, restore after the formatted value commits).
   */
  const placeCaret = (digitIndex: number) => {
    requestAnimationFrame(() => {
      const el = innerRef.current;
      if (!el) return;
      const text = el.value;
      if (digitIndex <= 0) {
        try {
          el.setSelectionRange(text.startsWith('+') ? 1 : 0, text.startsWith('+') ? 1 : 0);
        } catch {
          // Non-textual selection state — best-effort only.
        }
        return;
      }
      let seen = 0;
      let pos = text.length;
      for (let i = 0; i < text.length; i++) {
        if (/\d/.test(text[i] ?? '')) {
          seen++;
          if (seen >= digitIndex) {
            pos = i + 1;
            break;
          }
        }
      }
      try {
        el.setSelectionRange(pos, pos);
      } catch {
        // Non-textual selection state — caret restore is best-effort.
      }
    });
  };

  /**
   * Caret target for a committed change: digits before the caret, clamped
   * to the surviving digit count, PLUS the display-injection offset.
   * Formatting can add exactly one digit the user never typed (trunk `0`
   * prepended to a complete trunk-less number); without the offset the
   * caret lands mid-string (`06|6` jump).
   */
  const caretTarget = (caretDigits: number, cleaned: string, next: string): number => {
    const cleanedDigits = (cleaned.match(/\d/g) || []).length;
    const displayDigits = (next.match(/\d/g) || []).length;
    return Math.min(caretDigits, cleanedDigits) + Math.max(0, displayDigits - cleanedDigits);
  };

  /**
   * Single commit path for typing, autofill, IME and drag-drop.
   * - Derives the next FORMATTED value from digits only (string ops —
   *   never `parseInt`/`Number`, the leading `0` survives).
   * - Hard ceiling: `cleanPhone` already truncated, so `next` can never
   *   exceed the max digit count.
   * - Rejected keystroke (`next === value`: ceiling hit, separator typed,
   *   lone `+` re-typed): React would NOT re-render, leaving the smuggled
   *   char visible in the DOM — repair it in place instead. The plain
   *   assignment flows through React's value tracker (no event, no loop),
   *   so the next real keystroke is still detected.
   */
  const commitDomValue = (domValue: string, caretDigits: number) => {
    const cleaned = cleanPhone(domValue);
    const next = formatDzPhone(cleaned);
    setTouched(true);
    const target = caretTarget(caretDigits, cleaned, next);
    if (next === value) {
      const el = innerRef.current;
      if (el && el.value !== next) el.value = next;
      placeCaret(target);
      return;
    }
    onChange(next);
    placeCaret(target);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const end = el.selectionEnd ?? el.value.length;
    commitDomValue(el.value, (el.value.slice(0, end).match(/\d/g) || []).length);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length > 1) return; // Backspace, arrows, Home/End, Tab, …
    if (/^\d$/.test(e.key)) {
      const cleaned = cleanPhone(value);
      if (cleaned.replace(/\D/g, '').length >= maxFor(cleaned)) {
        // Allow replacing a selection even at ceiling.
        const el = e.currentTarget;
        const sel = (el.selectionEnd ?? 0) - (el.selectionStart ?? 0);
        if (sel <= 0) e.preventDefault();
      }
      return;
    }
    if (e.key === '+') {
      // Leading `+` only, on an empty field.
      const el = e.currentTarget;
      if (value !== '' || (el.selectionStart ?? 0) !== 0) e.preventDefault();
      return;
    }
    e.preventDefault();
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text');
    if (!pasted) return;
    const el = e.currentTarget;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    // Splice at the DOM level (the displayed value carries spaces) but count
    // the caret in digits so the restore mapping stays exact.
    const merged = el.value.slice(0, start) + pasted + el.value.slice(end);
    const beforeDigits = (cleanPhone(el.value.slice(0, start)).match(/\d/g) || []).length;
    const insertedDigits = (cleanPhone(pasted).match(/\d/g) || []).length;
    const cleaned = cleanPhone(merged);
    const next = formatDzPhone(cleaned);
    setTouched(true);
    const target = caretTarget(beforeDigits + insertedDigits, cleaned, next);
    if (next === value) {
      if (el.value !== next) el.value = next;
      placeCaret(target);
      return;
    }
    onChange(next);
    placeCaret(target);
  };

  return (
    <span className={`block ${className}`}>
      <span className="relative block">
        <input
          ref={setRefs}
          id={inputId}
          name={name}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          autoFocus={autoFocus}
          required={required}
          disabled={disabled}
          readOnly={readOnly}
          tabIndex={tabIndex}
          value={display}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={showError}
          aria-describedby={[ariaDescribedBy, showHint ? hintId : null].filter(Boolean).join(' ') || undefined}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => {
            setTouched(true);
            onBlur?.();
          }}
          onFocus={onFocus}
          style={{ ...style, boxShadow: ringShadow }}
          className={`min-h-[44px] transition-shadow duration-150 ${showOpBadge ? 'pr-24' : ''} ${inputClassName}`}
        />
        {showOpBadge && operator && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-wide transition-all duration-200 animate-in fade-in zoom-in-95"
            style={{
              color: operator.badgeText,
              backgroundColor: operator.badgeBg,
              borderColor: `${operator.color}55`,
            }}
          >
            <span
              className="inline-flex items-center justify-center rounded-full text-[9px] font-black"
              style={{ backgroundColor: operator.color, color: '#0b0f14', minWidth: 18, height: 18, paddingInline: 4 }}
            >
              {GLYPH[operator.icon]}
            </span>
            {operator.label}
          </span>
        )}
      </span>
      {showHint && (
        <span id={hintId} aria-live="polite" className="block text-[10px] leading-tight mt-1 min-h-[14px] font-medium">
          {showError && validation.errorReason ? (
            // Contract (tests/sav-inspector-ui.spec.ts): the guidance needle
            // `Format DZ attendu` must render with AA contrast — amber-800 on
            // light cards, amber-400 on dark (the "amber correction").
            <span className="text-amber-800 dark:text-amber-400">
              Format DZ attendu : 05/06/07 XX XX XX XX ou 213… — {validation.errorReason}
            </span>
          ) : (
            <span className="sr-only">{isValid ? `Numéro valide (${operator?.label})` : ''}</span>
          )}
        </span>
      )}
    </span>
  );
};

export default DzPhoneInput;

import React, { useEffect, useRef, useState } from 'react';
import { Money } from '../../utils/money';

interface MoneyInputProps {
  /** Integer minor units (santeem) — the single source of truth. */
  valueMinor: number;
  /** Fires ONLY with exact integer minor units parsed via Money.fromUserInput. */
  onChangeMinor: (minor: number) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
  /**
   * Optional-field clearing: when the text is empty on blur, call onClear
   * (e.g. reset to undefined) instead of reverting to the committed value.
   * Absent: empty text reverts (required/owned fields).
   */
  onClear?: () => void;
}

/**
 * MoneyInput — the ONE money parsing path in the entire app (Phase 1c).
 *
 * - `type="text" inputMode="decimal"`: kills browser-locale rejection
 *   (`type="number"` sanitizes commas before JS ever sees them).
 * - Parses ONLY via Money.fromUserInput (comma/dot, FR grouping read).
 * - LIVE ECHO (C-2 entry-echo norm): shows the canonical interpretation
 *   while typing ("45.000" → "45 000.00 DA"), so a grouping mis-parse is
 *   VISIBLE before commit. Errors show a clear message, never silent 0.
 * - Canonicalizes the text on blur to the committed value's format.
 * - Emits integer minor units. Zero float anywhere in this component.
 */
export const MoneyInput: React.FC<MoneyInputProps> = ({
  valueMinor,
  onChangeMinor,
  label,
  placeholder,
  required = false,
  disabled = false,
  className = '',
  id,
  onClear,
}) => {
  const [text, setText] = useState<string>(() => echoOf(valueMinor));
  const [touched, setTouched] = useState(false);
  // Last minor WE emitted: distinguishes our own keystroke commits (keep
  // typing, do not clobber the caret) from external changes (form reset,
  // programmatic set — re-sync the text).
  const emittedRef = useRef<number>(valueMinor);

  useEffect(() => {
    if (valueMinor !== emittedRef.current) {
      emittedRef.current = valueMinor;
      setText(echoOf(valueMinor));
      setTouched(false);
    }
  }, [valueMinor]);

  let parsed: { ok: true; minor: number; echo: string } | { ok: false; error: string };
  try {
    const m = Money.fromUserInput(text);
    parsed = { ok: true, minor: m.toMinor(), echo: m.format() };
  } catch (e) {
    parsed = { ok: false, error: e instanceof Error ? e.message.replace(/^\[Money\] /, '') : 'Montant invalide' };
  }
  const showError = touched && !parsed.ok && text.trim() !== '';

  return (
    <span className="block">
      <span className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          required={required}
          disabled={disabled}
          aria-label={label ?? 'Montant (DA)'}
          aria-invalid={showError}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            setTouched(true);
            try {
              const minor = Money.fromUserInput(next).toMinor();
              emittedRef.current = minor;
              onChangeMinor(minor);
            } catch {
              // Invalid intermediate ("13.", "", "-") — keep typing, do not
              // commit partial state. Error surfaces via the echo line.
            }
          }}
          onBlur={() => {
            // Empty + onClear: optional field cleared by the user.
            if (text.trim() === '' && onClear) {
              onClear();
              setTouched(false);
              return;
            }
            // Canonicalize to the committed value so the field never shows
            // a string that disagrees with what will be stored.
            setText(echoOf(valueMinor));
            setTouched(false);
          }}
          className={className}
        />
      </span>
      <span aria-live="polite" className="block text-[10px] leading-tight mt-0.5 min-h-[14px] font-mono">
        {showError ? (
          <span className="text-rose-400">{parsed.ok ? '' : parsed.error}</span>
        ) : (
          <span className="text-pos-muted">{parsed.ok ? `= ${parsed.echo}` : ''}</span>
        )}
      </span>
    </span>
  );
};

function echoOf(minor: number): string {
  try {
    return Money.fromMinor(minor).format();
  } catch {
    return '';
  }
}

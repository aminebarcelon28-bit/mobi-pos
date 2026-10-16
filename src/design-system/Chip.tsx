import React, { type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ChipTone =
  | 'neutral'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'info'
  | 'vip'
  | 'wholesale';

export interface ChipProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  children: ReactNode;
  selected?: boolean;
  tone?: ChipTone;
  leadingIcon?: ReactNode;
  /** Optional count badge displayed inside the chip (`<bdi dir="ltr">`). */
  count?: number;
  /** Optional WCAG 2.5.3 context suffix (`${visibleText} — ${ariaContext}`). */
  visibleText?: string;
  ariaContext?: string;
  ariaLabel?: string;
}

const SELECTED_TONE_CLASSES: Record<ChipTone, string> = {
  neutral: 'bg-pos-text text-pos-bg border-pos-text',
  ok: 'pos-status-ok border',
  warn: 'pos-status-warn border',
  danger: 'pos-status-danger border',
  info: 'pos-status-info border',
  vip: 'pos-status-vip border',
  wholesale: 'pos-status-wholesale border',
};

export const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(
  (
    {
      children,
      selected = false,
      tone = 'info',
      leadingIcon,
      count,
      visibleText,
      ariaContext,
      ariaLabel,
      className = '',
      type = 'button',
      ...rest
    },
    ref,
  ) => {
    const resolvedVisible =
      visibleText ?? (typeof children === 'string' ? children.trim() : undefined);
    const computedAriaLabel =
      ariaLabel ??
      (resolvedVisible && ariaContext
        ? `${resolvedVisible} — ${ariaContext}`
        : undefined);

    return (
      <button
        ref={ref}
        type={type}
        aria-pressed={selected}
        aria-label={computedAriaLabel}
        className={`min-h-[48px] px-3.5 py-2 inline-flex items-center justify-center gap-1.5 text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer select-none m3-morph-pill border ${
          selected
            ? SELECTED_TONE_CLASSES[tone]
            : 'bg-pos-card hover:bg-pos-hover text-pos-muted hover:text-pos-text border-pos-border'
        } disabled:opacity-50 disabled:pointer-events-none ${className}`}
        {...rest}
      >
        {leadingIcon ? (
          <span aria-hidden="true" className="shrink-0 inline-flex">
            {leadingIcon}
          </span>
        ) : null}
        <span>{children}</span>
        {typeof count === 'number' ? (
          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-black tabular-nums bg-black/10 dark:bg-white/10">
            <bdi dir="ltr">{count}</bdi>
          </span>
        ) : null}
      </button>
    );
  },
);

Chip.displayName = 'Chip';
export default Chip;

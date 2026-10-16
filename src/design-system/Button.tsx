import React, { type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant =
  | 'filled'
  | 'primary'
  | 'tonal'
  | 'secondary'
  | 'outlined'
  | 'ghost'
  | 'danger'
  | 'warning'
  | 'info'
  | 'vip'
  | 'wholesale';

export type ButtonSize = 'compact' | 'md' | 'lg';

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  children: ReactNode;
  /**
   * Optional plain-text mirror of `children` used when `ariaContext` is passed,
   * ensuring WCAG 2.5.3 Label-in-Name prefix compliance:
   * `aria-label="${visibleText} — ${ariaContext}"`.
   */
  visibleText?: string;
  /**
   * Optional auxiliary context appended after the visible label with an em-dash:
   * produces `aria-label="${visibleText} — ${ariaContext}"`.
   */
  ariaContext?: string;
  /**
   * Explicit aria-label override (must still begin with visible text per WCAG 2.5.3).
   */
  ariaLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
  morphOnPress?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  filled:
    'bg-emerald-600 hover:bg-emerald-500 text-white border border-transparent shadow-sm',
  primary:
    'bg-emerald-600 hover:bg-emerald-500 text-white border border-transparent shadow-sm',
  tonal:
    'bg-surface-highest hover:bg-pos-hover text-pos-text border border-pos-border/60',
  secondary:
    'bg-surface-high hover:bg-pos-hover text-pos-text border border-pos-border',
  outlined:
    'bg-pos-card hover:bg-pos-hover text-pos-text border border-pos-border',
  ghost:
    'bg-transparent hover:bg-pos-hover text-pos-text border border-transparent',
  danger:
    'pos-status-danger border hover:brightness-95 dark:hover:brightness-110',
  warning:
    'pos-status-warn border hover:brightness-95 dark:hover:brightness-110',
  info:
    'pos-status-info border hover:brightness-95 dark:hover:brightness-110',
  vip:
    'pos-status-vip border hover:brightness-95 dark:hover:brightness-110',
  wholesale:
    'pos-status-wholesale border hover:brightness-95 dark:hover:brightness-110',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  compact: 'min-h-[48px] px-3 py-2 text-xs font-bold gap-1.5 rounded-xl',
  md: 'min-h-[48px] px-4 py-2.5 text-sm font-bold gap-2 rounded-[var(--radius-button,14px)]',
  lg: 'min-h-[52px] px-5 py-3 text-base font-black gap-2.5 rounded-[var(--radius-button,14px)]',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      visibleText,
      ariaContext,
      ariaLabel,
      variant = 'filled',
      size = 'md',
      leadingIcon,
      trailingIcon,
      loading = false,
      fullWidth = false,
      morphOnPress = false,
      disabled,
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

    const isDisabled = Boolean(disabled || loading);

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        aria-label={computedAriaLabel}
        className={`inline-flex items-center justify-center text-center select-none cursor-pointer active-press ${
          morphOnPress ? 'm3-morph-pill' : ''
        } ${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]} ${
          fullWidth ? 'w-full' : ''
        } disabled:opacity-50 disabled:pointer-events-none ${className}`}
        {...rest}
      >
        {loading ? (
          <span aria-hidden="true" className="shrink-0 inline-flex">
            <Loader2 className="w-4 h-4 animate-spin" />
          </span>
        ) : leadingIcon ? (
          <span aria-hidden="true" className="shrink-0 inline-flex">
            {leadingIcon}
          </span>
        ) : null}
        <span className="truncate">{children}</span>
        {trailingIcon && !loading ? (
          <span aria-hidden="true" className="shrink-0 inline-flex">
            {trailingIcon}
          </span>
        ) : null}
      </button>
    );
  },
);

Button.displayName = 'Button';
export default Button;

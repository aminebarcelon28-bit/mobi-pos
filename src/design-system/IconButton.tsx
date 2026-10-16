import React, { type ButtonHTMLAttributes, type ReactNode } from 'react';

export type IconButtonVariant =
  | 'standard'
  | 'tonal'
  | 'outlined'
  | 'danger'
  | 'warning'
  | 'info';

export type IconButtonSize = 'md' | 'lg';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** Mandatory accessible name for icon-only / glyph-only control (WCAG 2.5.3 / 4.1.2). */
  ariaLabel: string;
  /** Icon or glyph element (automatically wrapped in aria-hidden="true"). */
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Optional numeric/dot badge overlaid at top-inline-end (`-top-1 -end-1`). */
  badge?: ReactNode;
  /** Active toggle state (`aria-pressed`). */
  pressed?: boolean;
  /** Enables M3 pill-to-squircle shape morphing on press. */
  morphOnPress?: boolean;
}

const VARIANT_CLASSES: Record<IconButtonVariant, string> = {
  standard:
    'bg-transparent hover:bg-pos-hover text-pos-muted hover:text-pos-text border border-transparent',
  tonal:
    'bg-surface-high hover:bg-pos-hover text-pos-text border border-pos-border/60',
  outlined:
    'bg-pos-card hover:bg-pos-hover text-pos-text border border-pos-border',
  danger: 'pos-status-danger border',
  warning: 'pos-status-warn border',
  info: 'pos-status-info border',
};

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  md: 'min-h-[48px] min-w-[48px] p-2.5 rounded-xl',
  lg: 'min-h-[52px] min-w-[52px] p-3 rounded-2xl',
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      ariaLabel,
      icon,
      variant = 'standard',
      size = 'md',
      badge,
      pressed,
      morphOnPress = false,
      className = '',
      type = 'button',
      ...rest
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={ariaLabel}
        aria-pressed={pressed}
        className={`relative inline-flex items-center justify-center shrink-0 select-none cursor-pointer active-press ${
          morphOnPress ? 'm3-morph-pill' : ''
        } ${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]} disabled:opacity-50 disabled:pointer-events-none ${className}`}
        {...rest}
      >
        <span aria-hidden="true" className="inline-flex items-center justify-center">
          {icon}
        </span>
        {badge !== undefined && badge !== null ? (
          <span
            aria-hidden="true"
            className="absolute -top-1 -end-1 inline-flex items-center justify-center"
          >
            {badge}
          </span>
        ) : null}
      </button>
    );
  },
);

IconButton.displayName = 'IconButton';
export default IconButton;

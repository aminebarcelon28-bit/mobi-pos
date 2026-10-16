import React, { type HTMLAttributes, type ReactNode } from 'react';

export type BadgeTone =
  | 'ok'
  | 'warn'
  | 'danger'
  | 'info'
  | 'vip'
  | 'wholesale'
  | 'neutral';

export type BadgeSize = 'xs' | 'sm' | 'md';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Optional leading status dot (`.pos-status-dot`). */
  dot?: boolean;
  /** Pulses the dot when true (respects prefers-reduced-motion). */
  pulseDot?: boolean;
  /** Wraps content in `<bdi dir="ltr">` with `tabular-nums` when displaying numbers/amounts. */
  numeric?: boolean;
  leadingIcon?: ReactNode;
  children: ReactNode;
}

const TONE_CLASSES: Record<BadgeTone, string> = {
  ok: 'pos-status-ok',
  warn: 'pos-status-warn',
  danger: 'pos-status-danger',
  info: 'pos-status-info',
  vip: 'pos-status-vip',
  wholesale: 'pos-status-wholesale',
  neutral: 'pos-status-neutral',
};

const SIZE_CLASSES: Record<BadgeSize, string> = {
  xs: 'px-1.5 py-0.5 text-[10px] rounded-md gap-1',
  sm: 'px-2 py-0.5 text-[11px] rounded-lg gap-1',
  md: 'px-2.5 py-1 text-xs rounded-lg gap-1.5',
};

export const Badge: React.FC<BadgeProps> = ({
  tone = 'neutral',
  size = 'sm',
  dot = false,
  pulseDot = false,
  numeric = false,
  leadingIcon,
  children,
  className = '',
  ...rest
}) => {
  return (
    <span
      className={`inline-flex items-center font-bold tracking-wider uppercase border whitespace-nowrap ${
        numeric ? 'tabular-nums font-mono' : ''
      } ${SIZE_CLASSES[size]} ${TONE_CLASSES[tone]} ${className}`}
      {...rest}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={`pos-status-dot ${pulseDot ? 'audit-live-dot' : ''}`}
        />
      ) : null}
      {leadingIcon ? (
        <span aria-hidden="true" className="shrink-0 inline-flex">
          {leadingIcon}
        </span>
      ) : null}
      {numeric ? <bdi dir="ltr">{children}</bdi> : children}
    </span>
  );
};

export default Badge;

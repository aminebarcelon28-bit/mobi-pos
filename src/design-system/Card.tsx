import React, { type HTMLAttributes, type ReactNode } from 'react';

export type CardVariant =
  | 'elevated'
  | 'tonal'
  | 'inset'
  | 'outlined'
  | 'status-ok'
  | 'status-warn'
  | 'status-danger'
  | 'status-info'
  | 'status-vip'
  | 'status-wholesale';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export type CardStripeTone =
  | 'ok'
  | 'warn'
  | 'danger'
  | 'info'
  | 'vip'
  | 'wholesale';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  /** Optional accent stripe on the inline-start edge (`border-s-4`). */
  startStripeTone?: CardStripeTone;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<CardVariant, string> = {
  elevated: 'bg-pos-card border border-pos-border rounded-pos-card shadow-xs',
  tonal: 'bg-surface-high border border-pos-border/60 rounded-pos-card',
  inset: 'bg-surface-low border border-pos-border/50 rounded-pos-card-inset',
  outlined: 'bg-transparent border border-pos-border rounded-pos-card',
  'status-ok': 'pos-status-ok border rounded-pos-card',
  'status-warn': 'pos-status-warn border rounded-pos-card',
  'status-danger': 'pos-status-danger border rounded-pos-card',
  'status-info': 'pos-status-info border rounded-pos-card',
  'status-vip': 'pos-status-vip border rounded-pos-card',
  'status-wholesale': 'pos-status-wholesale border rounded-pos-card',
};

const PADDING_CLASSES: Record<CardPadding, string> = {
  none: 'p-0',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
};

const STRIPE_CLASSES: Record<CardStripeTone, string> = {
  ok: 'border-s-4 border-s-status-ok',
  warn: 'border-s-4 border-s-status-warn',
  danger: 'border-s-4 border-s-status-danger',
  info: 'border-s-4 border-s-status-info',
  vip: 'border-s-4 border-s-status-vip',
  wholesale: 'border-s-4 border-s-status-wholesale',
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  (
    {
      variant = 'elevated',
      padding = 'md',
      startStripeTone,
      className = '',
      children,
      ...rest
    },
    ref,
  ) => {
    return (
      <div
        ref={ref}
        className={`${VARIANT_CLASSES[variant]} ${PADDING_CLASSES[padding]} ${
          startStripeTone ? STRIPE_CLASSES[startStripeTone] : ''
        } ${className}`}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

Card.displayName = 'Card';
export default Card;

import React from 'react';

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
  /** Size variant: sm (18px) or md (22px) */
  size?: 'sm' | 'md';
  /** Visual emphasis variant */
  variant?: 'subtle' | 'outline' | 'accent';
}

/**
 * Enterprise `<Kbd>` component benchmarked against Linear and Raycast.
 * Renders an accessible, crisp, tabular keyboard shortcut badge.
 */
export const Kbd: React.FC<KbdProps> = ({
  children,
  size = 'sm',
  variant = 'subtle',
  className = '',
  ...props
}) => {
  const sizeClasses =
    size === 'sm'
      ? 'h-[18px] min-w-[18px] px-1 text-[10px] leading-none'
      : 'h-[22px] min-w-[22px] px-1.5 text-ui-xs leading-none';

  const variantClasses =
    variant === 'accent'
      ? 'bg-status-ok-bg text-status-ok-fg border-status-ok-border shadow-xs'
      : variant === 'outline'
      ? 'bg-surface-canvas text-fg-secondary border-line font-medium shadow-xs'
      : 'bg-surface-card text-fg-muted border-line-subtle shadow-xs';

  return (
    <kbd
      {...props}
      className={`inline-flex items-center justify-center font-mono font-semibold rounded-ui-xs border select-none transition-colors ${sizeClasses} ${variantClasses} ${className}`}
    >
      {children}
    </kbd>
  );
};

export const KbdGroup: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = '',
}) => {
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`}>
      {children}
    </span>
  );
};


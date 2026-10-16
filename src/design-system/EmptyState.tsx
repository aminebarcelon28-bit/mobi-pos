import React, { type ReactNode } from 'react';

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  /** Optional primary CTA (`Button` >= 48px height). */
  action?: ReactNode;
  /** Optional secondary CTA (`Button` >= 48px height). */
  secondaryAction?: ReactNode;
  compact?: boolean;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  secondaryAction,
  compact = false,
  className = '',
}) => {
  return (
    <div
      className={`w-full flex flex-col items-center justify-center text-center rounded-pos-card border border-dashed border-pos-border bg-pos-card/50 ${
        compact ? 'p-5 gap-2.5' : 'p-8 gap-3.5'
      } ${className}`}
    >
      <div
        aria-hidden="true"
        className="w-12 h-12 rounded-2xl bg-surface-high border border-pos-border flex items-center justify-center text-pos-muted"
      >
        {icon}
      </div>
      <div className="space-y-1 max-w-sm">
        <h3 className="text-sm sm:text-base font-bold text-pos-text">{title}</h3>
        {description ? (
          <p className="text-xs sm:text-sm text-pos-muted leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {action || secondaryAction ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2.5">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
};

export default EmptyState;

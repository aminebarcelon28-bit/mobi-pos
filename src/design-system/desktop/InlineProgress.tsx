import React from 'react';

export interface InlineProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number; // 0 to 100, undefined for indeterminate
  status?: 'default' | 'success' | 'warning' | 'danger';
}

/**
 * Hairline inline progress bar for calm operational feedback without layout shift.
 */
export const InlineProgress: React.FC<InlineProgressProps> = ({
  value,
  status = 'default',
  className = '',
  ...props
}) => {
  const isIndeterminate = typeof value !== 'number';

  const statusColor =
    status === 'success'
      ? 'bg-status-ok-fg'
      : status === 'warning'
      ? 'bg-status-warn-fg'
      : status === 'danger'
      ? 'bg-status-danger-fg'
      : 'bg-pos-accent';

  return (
    <div
      role="progressbar"
      aria-valuenow={isIndeterminate ? undefined : Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`h-1 w-full bg-surface-card overflow-hidden rounded-full border border-line-subtle ${className}`}
      {...props}
    >
      {isIndeterminate ? (
        <div className={`h-full w-1/3 ${statusColor} rounded-full animate-indeterminate-slide`} />
      ) : (
        <div
          className={`h-full ${statusColor} rounded-full transition-all duration-300 ease-out`}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      )}
    </div>
  );
};


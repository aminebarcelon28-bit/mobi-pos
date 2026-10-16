import React, { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  sizeVariant?: 'sm' | 'md' | 'lg';
  isError?: boolean;
}

/**
 * Enterprise Select dropdown matching TextInput control heights and baseline metrics.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      sizeVariant = 'md',
      isError = false,
      children,
      className = '',
      disabled,
      ...props
    },
    ref
  ) => {
    const heightClass =
      sizeVariant === 'sm'
        ? 'h-ctl-sm text-ui-xs'
        : sizeVariant === 'lg'
        ? 'h-ctl-lg text-ui-md'
        : 'h-ctl-md text-ui-xs';

    const borderClass = isError
      ? 'border-status-danger-border focus-visible:ring-status-danger-fg'
      : 'border-line-subtle hover:border-line focus-visible:border-line-strong focus-visible:ring-pos-accent';

    const disabledClass = disabled
      ? 'opacity-50 cursor-not-allowed bg-surface-canvas'
      : 'bg-surface-card text-fg cursor-pointer';

    return (
      <div className="relative w-full flex items-center">
        <select
          ref={ref}
          disabled={disabled}
          className={`w-full appearance-none rounded-ui-sm border ${borderClass} ${disabledClass} ${heightClass} ps-3 pe-8 font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 ${className}`}
          {...props}
        >
          {children}
        </select>
        <span
          aria-hidden="true"
          className="absolute end-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none flex items-center justify-center w-4 h-4"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </span>
      </div>
    );
  }
);

Select.displayName = 'Select';


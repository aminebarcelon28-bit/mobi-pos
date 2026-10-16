import React, { forwardRef } from 'react';

export interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  prefixIcon?: React.ReactNode;
  suffixIcon?: React.ReactNode;
  sizeVariant?: 'sm' | 'md' | 'lg';
  isError?: boolean;
  tabularNums?: boolean;
}

/**
 * Enterprise TextInput component benchmarked against Linear and Stripe forms.
 * Features optical prefix/suffix centering, focus rings, and strict baseline alignment.
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  (
    {
      prefixIcon,
      suffixIcon,
      sizeVariant = 'md',
      isError = false,
      tabularNums = false,
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

    const paddingClass = `${prefixIcon ? 'ps-8' : 'ps-3'} ${
      suffixIcon ? 'pe-8' : 'pe-3'
    }`;

    const borderClass = isError
      ? 'border-status-danger-border focus-visible:ring-status-danger-fg'
      : 'border-line-subtle hover:border-line focus-visible:border-line-strong focus-visible:ring-pos-accent';

    const disabledClass = disabled
      ? 'opacity-50 cursor-not-allowed bg-surface-canvas'
      : 'bg-surface-card text-fg';

    return (
      <div className="relative w-full flex items-center">
        {prefixIcon && (
          <span
            aria-hidden="true"
            className="absolute start-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none flex items-center justify-center w-4 h-4"
          >
            {prefixIcon}
          </span>
        )}

        <input
          ref={ref}
          disabled={disabled}
          className={`w-full rounded-ui-sm border ${borderClass} ${disabledClass} ${heightClass} ${paddingClass} ${
            tabularNums ? 'font-mono num' : ''
          } font-medium placeholder:text-fg-muted transition-colors focus-visible:outline-none focus-visible:ring-1 ${className}`}
          {...props}
        />

        {suffixIcon && (
          <span
            aria-hidden="true"
            className="absolute end-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none flex items-center justify-center w-4 h-4"
          >
            {suffixIcon}
          </span>
        )}
      </div>
    );
  }
);

TextInput.displayName = 'TextInput';


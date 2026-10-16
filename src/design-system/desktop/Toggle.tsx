import React from 'react';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Enterprise switch toggle component with smooth transition and accessible semantics.
 */
export const Toggle: React.FC<ToggleProps> = ({
  checked,
  onChange,
  label,
  disabled = false,
  className = '',
}) => {
  return (
    <label
      className={`inline-flex items-center gap-2 select-none ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      } ${className}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pos-accent ${
          checked ? 'bg-pos-accent' : 'bg-surface-canvas border-line-subtle'
        }`}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-xs transition-transform duration-200 ease-in-out ${
            checked ? 'translate-x-4.5' : 'translate-x-0.5'
          }`}
        />
      </button>
      {label && <span className="text-ui-xs font-medium text-fg">{label}</span>}
    </label>
  );
};


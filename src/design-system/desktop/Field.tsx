import React from 'react';

export interface FieldProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Enterprise Form Field wrapper providing standard label typography,
 * optical alignment, helper hints, and accessible error messaging.
 */
export const Field: React.FC<FieldProps> = ({
  label,
  htmlFor,
  required = false,
  hint,
  error,
  children,
  className = '',
}) => {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div className="flex items-center justify-between">
        <label
          htmlFor={htmlFor}
          className="text-ui-xs font-semibold text-fg flex items-center gap-1 select-none"
        >
          <span>{label}</span>
          {required && <span className="text-status-danger-fg text-ui-xs">*</span>}
        </label>
        {hint && !error && (
          <span className="text-ui-2xs text-fg-muted">{hint}</span>
        )}
      </div>

      <div>{children}</div>

      {error && (
        <span role="alert" className="text-ui-2xs font-medium text-status-danger-fg flex items-center gap-1 mt-0.5">
          {error}
        </span>
      )}
    </div>
  );
};


import React, { type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { Button } from './Button';

export interface ErrorStateProps {
  title: string;
  description?: string;
  /** Technical error code or diagnostic message (rendered in `font-mono` `<bdi dir="ltr">`). */
  errorCode?: string;
  onRetry?: () => void;
  retryLabel?: string;
  icon?: ReactNode;
  compact?: boolean;
  className?: string;
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title,
  description,
  errorCode,
  onRetry,
  retryLabel = 'Réessayer',
  icon,
  compact = false,
  className = '',
}) => {
  return (
    <div
      role="alert"
      className={`w-full flex flex-col items-center justify-center text-center rounded-pos-card border pos-status-danger ${
        compact ? 'p-4 gap-2.5' : 'p-6 gap-3.5'
      } ${className}`}
    >
      <div
        aria-hidden="true"
        className="w-11 h-11 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center"
      >
        {icon ?? <AlertTriangle className="w-5 h-5" />}
      </div>
      <div className="space-y-1 max-w-md">
        <h3 className="text-sm sm:text-base font-bold">{title}</h3>
        {description ? (
          <p className="text-xs sm:text-sm opacity-90 leading-relaxed">
            {description}
          </p>
        ) : null}
        {errorCode ? (
          <div className="mt-1.5 inline-block px-2 py-0.5 rounded-md bg-black/10 dark:bg-white/10 font-mono text-[11px] font-bold tabular-nums">
            <bdi dir="ltr">{errorCode}</bdi>
          </div>
        ) : null}
      </div>
      {onRetry ? (
        <Button
          variant="danger"
          size="md"
          onClick={onRetry}
          leadingIcon={<RotateCw className="w-4 h-4" />}
        >
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
};

export default ErrorState;

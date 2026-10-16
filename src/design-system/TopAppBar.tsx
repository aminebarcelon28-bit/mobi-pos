import React, { type ReactNode } from 'react';

export interface TopAppBarProps {
  /** Primary title or brand lockup (`truncate min-w-0`). */
  title: ReactNode;
  /** Optional subtitle or status line below title. */
  subtitle?: ReactNode;
  /** Optional leading control (e.g., Back `IconButton` or brand logo). */
  leading?: ReactNode;
  /** Optional center/inline status widget (e.g., Sync Status Pill). */
  statusSlot?: ReactNode;
  /** Trailing action controls (each >= 48x48px `IconButton` or `Button`). */
  actions?: ReactNode;
  /** Whether to apply `.platform-chrome-top` + `pt-safe` (default: `true`). */
  includeSafeTop?: boolean;
  className?: string;
}

export const TopAppBar: React.FC<TopAppBarProps> = ({
  title,
  subtitle,
  leading,
  statusSlot,
  actions,
  includeSafeTop = true,
  className = '',
}) => {
  return (
    <header
      className={`platform-chrome-top shrink-0 z-20 ps-safe pe-safe select-none ${
        includeSafeTop ? 'pt-safe' : ''
      } ${className}`}
    >
      <div className="min-h-[56px] px-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {leading ? <div className="shrink-0 flex items-center">{leading}</div> : null}
          <div className="min-w-0 text-start">
            <div className="text-base font-bold text-pos-text tracking-tight truncate">
              {title}
            </div>
            {subtitle ? (
              <div className="text-xs text-pos-muted truncate mt-0.5">
                {subtitle}
              </div>
            ) : null}
          </div>
          {statusSlot ? <div className="shrink-0 flex items-center">{statusSlot}</div> : null}
        </div>
        {actions ? (
          <div className="shrink-0 flex items-center gap-1">{actions}</div>
        ) : null}
      </div>
    </header>
  );
};

export default TopAppBar;

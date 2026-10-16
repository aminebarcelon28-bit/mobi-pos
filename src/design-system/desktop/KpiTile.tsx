import React from 'react';

export interface KpiTileProps {
  label: string;
  value: React.ReactNode;
  subValue?: string;
  delta?: {
    value: string;
    trend: 'up' | 'down' | 'neutral';
  };
  icon?: React.ComponentType<{ className?: string }>;
  status?: 'default' | 'success' | 'warning' | 'danger';
  className?: string;
}

/**
 * Enterprise KPI summary tile benchmarked against Stripe Dashboard and Linear insights.
 * Enforces strict tabular numerals, clear hierarchy, and non-distracting elevation.
 */
export const KpiTile: React.FC<KpiTileProps> = ({
  label,
  value,
  subValue,
  delta,
  icon: Icon,
  status = 'default',
  className = '',
}) => {
  const statusBorder =
    status === 'success'
      ? 'border-status-ok-border/60'
      : status === 'warning'
      ? 'border-status-warn-border/60'
      : status === 'danger'
      ? 'border-status-danger-border/60'
      : 'border-line-subtle';

  return (
    <div
      className={`rounded-ui-md bg-surface-card border ${statusBorder} p-3.5 flex flex-col justify-between shadow-xs select-none ${className}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-ui-2xs uppercase tracking-wider font-bold text-fg-muted truncate">
          {label}
        </span>
        {Icon && (
          <span className="text-fg-muted shrink-0">
            <Icon className="w-4 h-4" />
          </span>
        )}
      </div>

      <div className="flex items-baseline justify-between gap-2 min-w-0">
        <span className="text-kpi font-extrabold text-fg tracking-tight font-mono num truncate">
          {value}
        </span>

        {delta && (
          <span
            className={`text-ui-2xs font-bold px-1.5 py-0.5 rounded-ui-xs shrink-0 font-mono num ${
              delta.trend === 'up'
                ? 'bg-status-ok-bg text-status-ok-fg'
                : delta.trend === 'down'
                ? 'bg-status-danger-bg text-status-danger-fg'
                : 'bg-surface-canvas text-fg-muted'
            }`}
          >
            {delta.trend === 'up' ? '↑ ' : delta.trend === 'down' ? '↓ ' : ''}
            {delta.value}
          </span>
        )}
      </div>

      {subValue && (
        <span className="text-ui-2xs text-fg-muted mt-1 truncate font-medium">
          {subValue}
        </span>
      )}
    </div>
  );
};

export const Section: React.FC<{
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, description, actions, children, className = '' }) => {
  return (
    <section className={`flex flex-col gap-3 ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-line-subtle pb-2">
          <div>
            {title && <h3 className="text-ui-md font-bold text-fg">{title}</h3>}
            {description && (
              <p className="text-ui-xs text-fg-muted mt-0.5">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div>{children}</div>
    </section>
  );
};


import React from 'react';

export const ICON_SIZES = {
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
  stroke: 1.75,
} as const;

export interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: React.ComponentType<{ className?: string }>;
  };
  className?: string;
}

/**
 * Enterprise empty state component avoiding visual bloat.
 * Guides the user with actionable next steps rather than dead ends.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  className = '',
}) => {
  return (
    <div
      className={`flex flex-col items-center justify-center p-8 text-center select-none ${className}`}
    >
      {Icon && (
        <div className="w-12 h-12 rounded-ui-lg bg-surface-card border border-line-subtle flex items-center justify-center text-fg-muted mb-3 shadow-xs">
          <Icon className="w-6 h-6" strokeWidth={ICON_SIZES.stroke} />
        </div>
      )}

      <h4 className="text-ui-md font-bold text-fg mb-1">{title}</h4>

      {description && (
        <p className="text-ui-xs text-fg-muted max-w-sm leading-relaxed mb-4">
          {description}
        </p>
      )}

      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-ui-sm bg-pos-accent hover:bg-pos-accent/90 text-slate-950 text-ui-xs font-bold transition shadow-xs cursor-pointer active:scale-[0.98]"
        >
          {action.icon && <action.icon className="w-3.5 h-3.5" />}
          <span>{action.label}</span>
        </button>
      )}
    </div>
  );
};


import type { ReactNode } from 'react';

export type SegmentedTone = 'default' | 'ok' | 'vip' | 'wholesale' | 'info';

export interface SegmentedOption<T extends string> {
  value: T;
  /** Visible segment label. */
  label: string;
  icon?: ReactNode;
  tone?: SegmentedTone;
  badge?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  className?: string;
}

const ACTIVE_TONE_CLASSES: Record<SegmentedTone, string> = {
  default: 'bg-pos-card text-pos-text border-pos-border shadow-xs',
  ok: 'pos-status-ok border shadow-xs',
  vip: 'pos-status-vip border shadow-xs',
  wholesale: 'pos-status-wholesale border shadow-xs',
  info: 'pos-status-info border shadow-xs',
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = '',
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`p-1 rounded-2xl bg-surface-highest border border-pos-border grid auto-cols-fr grid-flow-col gap-1 select-none ${className}`}
    >
      {options.map((opt) => {
        const isSelected = opt.value === value;
        const tone = opt.tone ?? 'default';

        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={opt.disabled}
            onClick={() => onChange(opt.value)}
            className={`min-h-[48px] px-3 py-2 rounded-xl flex items-center justify-center gap-1.5 text-xs sm:text-sm font-bold cursor-pointer active-press transition ${
              isSelected
                ? ACTIVE_TONE_CLASSES[tone]
                : 'bg-transparent text-pos-muted hover:text-pos-text border border-transparent'
            } disabled:opacity-50 disabled:pointer-events-none`}
          >
            {opt.icon ? (
              <span aria-hidden="true" className="shrink-0 inline-flex">
                {opt.icon}
              </span>
            ) : null}
            <span className="truncate">{opt.label}</span>
            {opt.badge ? (
              <span className="shrink-0 inline-flex">{opt.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;

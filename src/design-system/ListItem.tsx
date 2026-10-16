import React, { type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

export interface ListItemProps {
  /** Primary row title (`text-start font-bold text-pos-text`). */
  title: ReactNode;
  /** Secondary subtitle / metadata (`text-start text-xs text-pos-muted`). */
  subtitle?: ReactNode;
  /** Optional third line or badge strip below subtitle. */
  overlineOrMeta?: ReactNode;
  /** Leading icon, avatar, or status tile (`shrink-0`). */
  leading?: ReactNode;
  /** Trailing value, price (`<bdi dir="ltr">`), badge, or control (`shrink-0 text-end`). */
  trailing?: ReactNode;
  /** Renders a directional trailing chevron that automatically mirrors in RTL (`rtl:rotate-180`). */
  showChevron?: boolean;
  /** Makes the entire row an interactive `<button type="button">` with >= 56px height. */
  onClick?: () => void;
  /** Optional WCAG 2.5.3 context appended to `visibleTitle` (`${visibleTitle} — ${ariaContext}`). */
  visibleTitle?: string;
  ariaContext?: string;
  disabled?: boolean;
  selected?: boolean;
  className?: string;
}

export const ListItem: React.FC<ListItemProps> = ({
  title,
  subtitle,
  overlineOrMeta,
  leading,
  trailing,
  showChevron = false,
  onClick,
  visibleTitle,
  ariaContext,
  disabled = false,
  selected = false,
  className = '',
}) => {
  const resolvedVisible =
    visibleTitle ?? (typeof title === 'string' ? title.trim() : undefined);
  const computedAriaLabel =
    resolvedVisible && ariaContext
      ? `${resolvedVisible} — ${ariaContext}`
      : undefined;

  const baseClasses = `w-full min-h-[56px] p-3.5 flex items-center justify-between gap-3 text-start rounded-pos-card border transition ${
    selected
      ? 'pos-status-info border'
      : 'bg-pos-card border-pos-border hover:bg-pos-hover'
  } ${className}`;

  const content = (
    <>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {leading ? (
          <div className="shrink-0 flex items-center justify-center" aria-hidden="true">
            {leading}
          </div>
        ) : null}
        <div className="min-w-0 flex-1 text-start">
          <div className="text-sm font-bold text-pos-text leading-snug truncate">
            {title}
          </div>
          {subtitle ? (
            <div className="text-xs text-pos-muted mt-0.5 truncate">
              {subtitle}
            </div>
          ) : null}
          {overlineOrMeta ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {overlineOrMeta}
            </div>
          ) : null}
        </div>
      </div>

      {(trailing || showChevron) ? (
        <div className="shrink-0 flex items-center gap-2 text-end">
          {trailing}
          {showChevron ? (
            <ChevronRight
              aria-hidden="true"
              className="w-4 h-4 text-pos-muted shrink-0 rtl:rotate-180"
            />
          ) : null}
        </div>
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={computedAriaLabel}
        className={`${baseClasses} cursor-pointer select-none active-press disabled:opacity-50 disabled:pointer-events-none`}
      >
        {content}
      </button>
    );
  }

  return <div className={baseClasses}>{content}</div>;
};

export default ListItem;

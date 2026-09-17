import React from 'react';

/**
 * AppScreenLayout — enterprise App Shell container.
 *
 * Guarantees:
 * - Outer wrapper fills the dynamic viewport (100dvh), never scrolls itself.
 * - Header slot is rigid with padding-top: var(--safe-top) and min-height 48px,
 *   so status-bar icons / notch never overlap UI headers (iOS + Android).
 * - Main slot is the ONLY scroll owner when combined with AppTabContent
 *   (overscroll-contain: no rubber-banding of fixed chrome).
 * - Footer slot is pinned with padding-bottom: var(--safe-bottom), clearing
 *   the iOS home indicator.
 *
 * Header content contract (enforced by callers, not CSS):
 * - Text headers must use `truncate min-w-0` so long titles never push actions out.
 * - Interactive header buttons must be at least 44x44px (min-h-[44px] min-w-[44px]).
 */
interface AppScreenLayoutProps {
  /** Rigid header content (already min-h-[48px]; shell adds safe-top padding). */
  header?: React.ReactNode;
  /** Pinned bottom bar content (shell adds safe-bottom padding). */
  footer?: React.ReactNode;
  /** Main content — typically a tab view or AppTabContent. */
  children: React.ReactNode;
  /**
   * Height mode: 'viewport' (default, h-[100dvh] top-level screens) or
   * 'parent' (h-full when embedded in a fixed-height frame, e.g. device simulator).
   */
  fill?: 'viewport' | 'parent';
  className?: string;
}

export const AppScreenLayout: React.FC<AppScreenLayoutProps> = ({
  header,
  footer,
  children,
  fill = 'viewport',
  className = '',
}) => {
  return (
    <div
      className={`${fill === 'viewport' ? 'h-[100dvh]' : 'h-full'} w-full flex flex-col overflow-hidden bg-pos-bg text-pos-text select-none font-sans ${className}`}
    >
      {header && (
        <div className="shrink-0 z-20" style={{ paddingTop: 'var(--safe-top)' }}>
          <div className="min-h-[48px] flex flex-col justify-center">{header}</div>
        </div>
      )}

      <main className="flex-1 min-h-0 overflow-hidden flex flex-col relative">{children}</main>

      {footer && (
        <div className="shrink-0 z-20" style={{ paddingBottom: 'var(--safe-bottom)' }}>
          {footer}
        </div>
      )}
    </div>
  );
};

/**
 * AppTabContent — standard body pattern for list-heavy screens
 * (inventory, catalog, kredy, activity feed, checkout).
 *
 * - pinnedTop: metric summaries + search filters, rigid below the safe header.
 * - children: the ONLY scrollable region (flex-1, overscroll-contain).
 * - pinnedBottom: totals / checkout actions, pinned above the footer slot.
 */
interface AppTabContentProps {
  /** Pinned summaries / filters (shrink-0, never scrolls). */
  pinnedTop?: React.ReactNode;
  /** Pinned bottom actions (shrink-0, clears footer via spacing). */
  pinnedBottom?: React.ReactNode;
  /** Scrollable list content. */
  children: React.ReactNode;
  /** Extra classes for the scroll region (padding is caller's choice). */
  contentClassName?: string;
  className?: string;
}

export const AppTabContent: React.FC<AppTabContentProps> = ({
  pinnedTop,
  pinnedBottom,
  children,
  contentClassName = '',
  className = '',
}) => {
  return (
    <div className={`flex-1 min-h-0 flex flex-col overflow-hidden ${className}`}>
      {pinnedTop && <div className="shrink-0 z-10">{pinnedTop}</div>}

      <div className={`flex-1 min-h-0 overflow-y-auto overscroll-contain ${contentClassName}`}>
        {children}
      </div>

      {pinnedBottom && <div className="shrink-0 z-10">{pinnedBottom}</div>}
    </div>
  );
};

export default AppScreenLayout;

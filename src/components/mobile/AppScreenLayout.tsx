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
 * - Interactive controls must be at least 48x48dp (min-h-[48px] min-w-[48px]) for thumb ergonomics.
 */
interface AppScreenLayoutProps {
  /** Rigid header content (already min-h-[48px]; shell adds safe-top padding). */
  header?: React.ReactNode;
  /** Pinned bottom bar content on Compact (<600px; shell adds safe-bottom padding). */
  footer?: React.ReactNode;
  /** Optional leading vertical Navigation Rail rendered on Medium/Expanded (>=768px / md:). */
  navigationRail?: React.ReactNode;
  /** Main content — typically a tab view or AppTabContent. */
  children: React.ReactNode;
  /**
   * Height mode: 'viewport' (default, h-[100dvh] top-level screens) or
   * 'parent' (h-full when embedded in a fixed-height parent container).
   */
  fill?: 'viewport' | 'parent';
  className?: string;
}

export const AppScreenLayout: React.FC<AppScreenLayoutProps> = ({
  header,
  footer,
  navigationRail,
  children,
  fill = 'viewport',
  className = '',
}) => {
  return (
    <div
      // min-h-[100vh] : repli pour les webviews anciennes (plancher Android 7)
      // sans prise en charge de dvh — propriété distincte de height, donc sans
      // conflit de cascade quand dvh est supporté.
      className={`${fill === 'viewport' ? 'h-[100dvh] min-h-[100vh]' : 'h-full'} w-full flex flex-row overflow-hidden bg-pos-bg text-pos-text select-none font-sans touch-manipulation overscroll-none ${className}`}
    >
      {navigationRail && (
        <aside
          className="hidden md:flex shrink-0 z-20 platform-chrome-bottom border-t-0 border-e border-pos-border flex-col"
          style={{
            paddingTop: 'var(--safe-top)',
            paddingBottom: 'var(--safe-bottom)',
            paddingInlineStart: 'var(--safe-left, 0px)',
          }}
        >
          {navigationRail}
        </aside>
      )}

      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {header && (
          <div
            className="shrink-0 z-20"
            style={{
              paddingTop: 'var(--safe-top)',
              paddingInlineStart: navigationRail ? '0px' : 'var(--safe-left, 0px)',
              paddingInlineEnd: 'var(--safe-right, 0px)',
            }}
          >
            <div className="min-h-[48px] landscape:min-h-[44px] flex flex-col justify-center">{header}</div>
          </div>
        )}

        <main
          className="flex-1 min-h-0 overflow-hidden flex flex-col relative"
          style={{
            paddingInlineStart: navigationRail ? '0px' : 'var(--safe-left, 0px)',
            paddingInlineEnd: 'var(--safe-right, 0px)',
          }}
        >
          {children}
        </main>

        {footer && (
          <div
            className={`shrink-0 z-20 platform-chrome-bottom shadow-lg ${navigationRail ? 'md:hidden' : ''}`}
            style={{
              paddingBottom: 'var(--safe-bottom)',
              paddingInlineStart: 'var(--safe-left, 0px)',
              paddingInlineEnd: 'var(--safe-right, 0px)',
            }}
          >
            {footer}
          </div>
        )}
      </div>
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
    <div className={`flex-1 min-h-0 flex flex-col overflow-hidden bg-pos-bg ${className}`}>
      {pinnedTop && <div className="shrink-0 z-10">{pinnedTop}</div>}

      <div className={`flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y ${contentClassName}`}>
        {children}
      </div>

      {pinnedBottom && <div className="shrink-0 z-10 max-h-[46dvh] overflow-y-auto">{pinnedBottom}</div>}
    </div>
  );
};

export default AppScreenLayout;

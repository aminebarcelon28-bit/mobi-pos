import React, { type ReactNode } from 'react';

export type PrimaryMobileTab =
  | 'activity'
  | 'checkout'
  | 'catalog'
  | 'kredy'
  | 'management';

export type NavBadgeTone = 'ok' | 'warn' | 'danger' | 'info';

export interface NavigationDestination {
  id: PrimaryMobileTab | string;
  /** Visible tab label (e.g., "Activité", "Caisse"). */
  label: string;
  icon: ReactNode;
  /** Optional badge count (e.g., cart item count on `checkout`, pending sync count on `management`). */
  badgeCount?: number;
  badgeTone?: NavBadgeTone;
}

export interface NavigationBarProps {
  /** Max 5 destinations per R-NAV-01 (M3 Navigation Bar & iOS HIG Tab Bar). */
  destinations: readonly NavigationDestination[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Accessible label for the `<nav>` landmark (default: "Navigation principale"). */
  navAriaLabel?: string;
  className?: string;
}

const BADGE_TONE_CLASSES: Record<NavBadgeTone, string> = {
  ok: 'bg-emerald-600 text-white',
  warn: 'bg-amber-600 text-white',
  danger: 'bg-rose-600 text-white',
  info: 'bg-cyan-600 text-white',
};

export const NavigationBar: React.FC<NavigationBarProps> = ({
  destinations,
  activeId,
  onSelect,
  navAriaLabel = 'Navigation principale',
  className = '',
}) => {
  return (
    <nav
      aria-label={navAriaLabel}
      className={`platform-chrome-bottom pb-safe ps-safe pe-safe shrink-0 z-20 select-none ${className}`}
    >
      <div
        role="tablist"
        aria-orientation="horizontal"
        className="min-h-[64px] grid grid-flow-col auto-cols-fr items-center px-1 gap-0.5"
      >
        {destinations.map((dest) => {
          const isActive = dest.id === activeId;
          const count = dest.badgeCount ?? 0;
          const tone = dest.badgeTone ?? 'ok';

          return (
            <button
              key={dest.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(dest.id)}
              className={`min-h-[56px] min-w-[48px] py-1.5 px-1 flex flex-col items-center justify-center gap-1 cursor-pointer active-press rounded-2xl transition-colors ${
                isActive
                  ? 'text-status-ok-fg font-black'
                  : 'text-pos-muted hover:text-pos-text font-semibold'
              }`}
            >
              <span
                aria-hidden="true"
                className={`relative w-14 h-8 rounded-full flex items-center justify-center transition-colors ${
                  isActive ? 'bg-status-ok-bg' : 'bg-transparent'
                }`}
              >
                {dest.icon}
                {count > 0 ? (
                  <span
                    className={`absolute -top-1 -end-1 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-black tabular-nums flex items-center justify-center shadow-xs ${BADGE_TONE_CLASSES[tone]}`}
                  >
                    <bdi dir="ltr">{count > 99 ? '99+' : count}</bdi>
                  </span>
                ) : null}
              </span>
              <span className="text-[11px] leading-tight truncate max-w-full">
                {dest.label}
              </span>
              {count > 0 ? (
                <span className="sr-only">{` (${count})`}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
};

export interface NavigationRailProps extends NavigationBarProps {
  /** Optional top header slot (e.g., store logo or primary FAB). */
  headerSlot?: ReactNode;
  /** Optional bottom footer slot (e.g., theme toggle or lock button). */
  footerSlot?: ReactNode;
}

export const NavigationRail: React.FC<NavigationRailProps> = ({
  destinations,
  activeId,
  onSelect,
  navAriaLabel = 'Navigation principale',
  headerSlot,
  footerSlot,
  className = '',
}) => {
  return (
    <nav
      aria-label={navAriaLabel}
      className={`w-[76px] shrink-0 h-full bg-pos-panel border-e border-pos-border pt-safe pb-safe ps-safe flex flex-col items-center justify-between py-3 select-none z-20 ${className}`}
    >
      {headerSlot ? <div className="shrink-0 mb-2">{headerSlot}</div> : null}

      <div
        role="tablist"
        aria-orientation="vertical"
        className="flex-1 flex flex-col items-center justify-center gap-2 w-full px-1.5"
      >
        {destinations.map((dest) => {
          const isActive = dest.id === activeId;
          const count = dest.badgeCount ?? 0;
          const tone = dest.badgeTone ?? 'ok';

          return (
            <button
              key={dest.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(dest.id)}
              className={`w-full min-h-[56px] min-w-[48px] py-1.5 px-1 flex flex-col items-center justify-center gap-1 cursor-pointer active-press rounded-2xl transition-colors ${
                isActive
                  ? 'text-status-ok-fg font-black'
                  : 'text-pos-muted hover:text-pos-text font-semibold'
              }`}
            >
              <span
                aria-hidden="true"
                className={`relative w-12 h-8 rounded-full flex items-center justify-center transition-colors ${
                  isActive ? 'bg-status-ok-bg' : 'bg-transparent'
                }`}
              >
                {dest.icon}
                {count > 0 ? (
                  <span
                    className={`absolute -top-1 -end-1 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-black tabular-nums flex items-center justify-center shadow-xs ${BADGE_TONE_CLASSES[tone]}`}
                  >
                    <bdi dir="ltr">{count > 99 ? '99+' : count}</bdi>
                  </span>
                ) : null}
              </span>
              <span className="text-[10px] leading-tight truncate max-w-full">
                {dest.label}
              </span>
              {count > 0 ? (
                <span className="sr-only">{` (${count})`}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {footerSlot ? <div className="shrink-0 mt-2">{footerSlot}</div> : null}
    </nav>
  );
};

export default NavigationBar;

import React from 'react';
import { Activity, Search, ShoppingBag, Users, SlidersHorizontal, Stethoscope } from 'lucide-react';
import { soundEngine, triggerHaptic } from '../../utils/audioFeedback';
import { useTranslation, Bdi } from '../../i18n';

export type MobileTab = 'activity' | 'catalog' | 'checkout' | 'kredy' | 'management' | 'diagnostics';

export interface MobileBottomNavProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  cartCount: number;
  pendingSyncCount: number;
  /** 'bar' on Compact (<768px), 'rail' on Medium/Expanded (>=768px). Default 'bar'. */
  variant?: 'bar' | 'rail';
}

interface NavItemDef {
  id: MobileTab;
  label: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  badge?: number;
  badgeColor?: string;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  activeTab,
  onTabChange,
  cartCount,
  pendingSyncCount,
  variant = 'bar',
}) => {
  const { t } = useTranslation();

  if (variant === 'rail') {
    return (
      <MobileNavigationRail
        activeTab={activeTab}
        onTabChange={onTabChange}
        cartCount={cartCount}
        pendingSyncCount={pendingSyncCount}
      />
    );
  }

  const handleSelect = (tab: MobileTab) => {
    soundEngine.playKeyBeep?.();
    triggerHaptic('light');
    onTabChange(tab);
  };

  // ADR-001 Pillar A: Strictly 5 primary destinations on Compact bottom bar
  const primaryNavItems: NavItemDef[] = [
    {
      id: 'activity',
      label: t.nav.activity,
      icon: Activity,
    },
    {
      id: 'checkout',
      label: t.nav.checkout,
      icon: ShoppingBag,
      badge: cartCount > 0 ? cartCount : undefined,
      badgeColor: 'bg-emerald-500 text-slate-950',
    },
    {
      id: 'catalog',
      label: t.nav.catalog,
      icon: Search,
    },
    {
      id: 'kredy',
      label: t.nav.kredy,
      icon: Users,
    },
    {
      id: 'management',
      label: t.nav.management,
      icon: SlidersHorizontal,
      badge: pendingSyncCount > 0 ? pendingSyncCount : undefined,
      badgeColor: 'bg-amber-500 text-slate-950',
    },
  ];

  return (
    <nav
      className="md:hidden h-20 landscape:h-14 sm:landscape:h-16 px-1.5 sm:px-2 landscape:px-4 flex items-center justify-around select-none shrink-0 touch-manipulation"
      role="tablist"
      aria-label={t.nav.mainAriaLabel}
    >
      {primaryNavItems.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;
        const isParentOfDiagnostics = item.id === 'management' && activeTab === 'diagnostics';
        const badgeText = item.badge !== undefined ? (item.badge > 99 ? '99+' : String(item.badge)) : '';
        const accessibleName = item.badge !== undefined ? `${item.label} — ${badgeText}` : item.label;

        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-active-child={isParentOfDiagnostics ? 'diagnostics' : undefined}
            aria-label={accessibleName}
            onClick={() => handleSelect(item.id)}
            className={`flex-1 flex flex-col items-center justify-center py-1 sm:py-1.5 transition-all duration-200 relative cursor-pointer min-h-[56px] landscape:min-h-[48px] min-w-[48px] active-press touch-manipulation focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none ${
              isActive
                ? 'text-emerald-700 dark:text-emerald-400 font-bold'
                : isParentOfDiagnostics
                ? 'text-emerald-700 dark:text-emerald-400 font-semibold'
                : 'text-pos-muted hover:text-pos-text font-medium'
            }`}
          >
            {/* M3 64x32dp Shape-Morphing Pill Indicator Container */}
            <div className="relative flex items-center justify-center">
              <div
                className={`w-16 h-8 m3-morph-pill flex items-center justify-center ${
                  isActive
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 shadow-xs scale-100 ring-1 ring-emerald-500/30'
                    : isParentOfDiagnostics
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-500/40 scale-95'
                    : 'bg-transparent text-pos-muted hover:bg-pos-hover/60 scale-95'
                }`}
              >
                <Icon
                  aria-hidden="true"
                  className={`w-5 h-5 transition-transform duration-200 ease-out ${
                    isActive || isParentOfDiagnostics ? 'scale-110 stroke-[2.4]' : 'stroke-[1.8] opacity-85'
                  }`}
                />
              </div>

              {/* M3 Floating Badge Counter — plafonné à 99+ */}
              {item.badge !== undefined && (
                <span
                  aria-hidden="true"
                  title={String(item.badge)}
                  className={`absolute -top-1.5 end-1 min-w-[22px] justify-center px-1.5 py-0.5 rounded-full text-[10px] font-black tracking-tight shadow-md ring-2 ring-pos-panel tabular-nums animate-in zoom-in-75 flex ${item.badgeColor}`}
                >
                  <Bdi>{badgeText}</Bdi>
                </span>
              )}
            </div>

            {/* Navigation Label — masqué en paysage pour préserver le contenu */}
            <span
              className={`text-[11px] tracking-tight mt-1 leading-none transition-colors duration-200 landscape:hidden truncate max-w-[68px] ${
                isActive || isParentOfDiagnostics
                  ? 'font-bold text-emerald-700 dark:text-emerald-400'
                  : 'text-pos-muted'
              }`}
            >
              {item.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
};

/**
 * MobileNavigationRail — Adaptive Vertical Navigation Rail for Medium/Expanded viewports (>=768px / md:).
 * Renders the 5 primary destinations at the top and pins the 6th utility destination ('diagnostics') at the bottom.
 */
export const MobileNavigationRail: React.FC<Omit<MobileBottomNavProps, 'variant'>> = ({
  activeTab,
  onTabChange,
  cartCount,
  pendingSyncCount,
}) => {
  const { t } = useTranslation();

  const handleSelect = (tab: MobileTab) => {
    soundEngine.playKeyBeep?.();
    triggerHaptic('light');
    onTabChange(tab);
  };

  const primaryItems: NavItemDef[] = [
    {
      id: 'activity',
      label: t.nav.activity,
      icon: Activity,
    },
    {
      id: 'checkout',
      label: t.nav.checkout,
      icon: ShoppingBag,
      badge: cartCount > 0 ? cartCount : undefined,
      badgeColor: 'bg-emerald-500 text-slate-950',
    },
    {
      id: 'catalog',
      label: t.nav.catalog,
      icon: Search,
    },
    {
      id: 'kredy',
      label: t.nav.kredy,
      icon: Users,
    },
    {
      id: 'management',
      label: t.nav.management,
      icon: SlidersHorizontal,
      badge: pendingSyncCount > 0 ? pendingSyncCount : undefined,
      badgeColor: 'bg-amber-500 text-slate-950',
    },
  ];

  const utilityItem: NavItemDef = {
    id: 'diagnostics',
    label: t.nav.diagnostics,
    icon: Stethoscope,
  };

  const renderRailButton = (item: NavItemDef) => {
    const Icon = item.icon;
    const isActive = activeTab === item.id;
    const badgeText = item.badge !== undefined ? (item.badge > 99 ? '99+' : String(item.badge)) : '';
    const accessibleName = item.badge !== undefined ? `${item.label} — ${badgeText}` : item.label;

    return (
      <button
        key={item.id}
        type="button"
        role="tab"
        aria-selected={isActive}
        aria-label={accessibleName}
        onClick={() => handleSelect(item.id)}
        className={`w-full flex flex-col items-center justify-center py-2 px-1 transition-all duration-200 relative cursor-pointer min-h-[56px] min-w-[56px] active-press touch-manipulation focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none ${
          isActive
            ? 'text-emerald-700 dark:text-emerald-400 font-bold'
            : 'text-pos-muted hover:text-pos-text font-medium'
        }`}
      >
        <div className="relative flex items-center justify-center">
          <div
            className={`w-14 h-8 m3-morph-pill flex items-center justify-center ${
              isActive
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 shadow-xs scale-100 ring-1 ring-emerald-500/30'
                : 'bg-transparent text-pos-muted hover:bg-pos-hover/60 scale-95'
            }`}
          >
            <Icon
              aria-hidden="true"
              className={`w-5 h-5 transition-transform duration-200 ease-out ${
                isActive ? 'scale-110 stroke-[2.4]' : 'stroke-[1.8] opacity-85'
              }`}
            />
          </div>

          {item.badge !== undefined && (
            <span
              aria-hidden="true"
              title={String(item.badge)}
              className={`absolute -top-1.5 end-0.5 min-w-[20px] justify-center px-1 py-0.5 rounded-full text-[10px] font-black tracking-tight shadow-md ring-2 ring-pos-panel tabular-nums animate-in zoom-in-75 flex ${item.badgeColor}`}
            >
              <Bdi>{badgeText}</Bdi>
            </span>
          )}
        </div>

        <span
          className={`text-[10px] tracking-tight mt-1 leading-none transition-colors duration-200 truncate max-w-[70px] ${
            isActive ? 'font-bold text-emerald-700 dark:text-emerald-400' : 'text-pos-muted'
          }`}
        >
          {item.label}
        </span>
      </button>
    );
  };

  return (
    <nav
      className="hidden md:flex w-[76px] lg:w-[80px] h-full py-2 px-1 flex-col items-center justify-between select-none shrink-0 touch-manipulation overflow-y-auto overscroll-contain"
      role="tablist"
      aria-orientation="vertical"
      aria-label={t.nav.mainAriaLabel}
    >
      <div className="w-full flex flex-col items-center gap-1">
        {primaryItems.map(renderRailButton)}
      </div>

      <div className="w-full pt-2 border-t border-pos-border/60 flex flex-col items-center">
        {renderRailButton(utilityItem)}
      </div>
    </nav>
  );
};


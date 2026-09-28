import React from 'react';
import { Activity, Search, ShoppingBag, Users, SlidersHorizontal, Stethoscope } from 'lucide-react';
import { soundEngine } from '../../utils/audioFeedback';

export type MobileTab = 'activity' | 'catalog' | 'checkout' | 'kredy' | 'management' | 'diagnostics';

interface MobileBottomNavProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  cartCount: number;
  pendingSyncCount: number;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  activeTab,
  onTabChange,
  cartCount,
  pendingSyncCount,
}) => {
  const handleSelect = (tab: MobileTab) => {
    soundEngine.playKeyBeep?.();
    onTabChange(tab);
  };

  const navItems = [
    {
      id: 'activity' as const,
      label: 'Activité',
      icon: Activity,
    },
    {
      id: 'checkout' as const,
      label: 'Caisse',
      icon: ShoppingBag,
      badge: cartCount > 0 ? cartCount : undefined,
      badgeColor: 'bg-emerald-500 text-slate-950',
    },
    {
      id: 'catalog' as const,
      label: 'Articles',
      icon: Search,
    },
    {
      id: 'kredy' as const,
      label: 'Kredy',
      icon: Users,
    },
    {
      id: 'management' as const,
      label: 'Gestion',
      icon: SlidersHorizontal,
      badge: pendingSyncCount > 0 ? pendingSyncCount : undefined,
      badgeColor: 'bg-amber-500 text-slate-950',
    },
    {
      id: 'diagnostics' as const,
      label: 'Diagnostic',
      icon: Stethoscope,
    },
  ];

  return (
    <nav
      className="h-20 landscape:h-16 px-2 flex items-center justify-around select-none shrink-0"
      role="tablist"
      aria-label="Navigation principale"
    >
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;

        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={item.badge !== undefined ? `${item.label}, ${item.badge}` : item.label}
            onClick={() => handleSelect(item.id)}
            className={`flex-1 flex flex-col items-center justify-center py-1.5 transition-all duration-200 relative cursor-pointer min-h-[56px] landscape:min-h-[44px] min-w-[48px] active-press ${
              isActive
                ? 'text-emerald-400 font-bold'
                : 'text-pos-muted hover:text-pos-text font-medium'
            }`}
          >
            {/* M3 64x32dp Pill Indicator Container */}
            <div className="relative flex items-center justify-center">
              <div
                className={`w-16 h-8 rounded-full flex items-center justify-center transition-all duration-300 ease-out will-change-transform ${
                  isActive
                    ? 'bg-emerald-500/15 text-emerald-400 shadow-xs scale-100 ring-1 ring-emerald-500/30'
                    : 'bg-transparent text-pos-muted hover:bg-pos-hover/60 scale-95'
                }`}
              >
                <Icon
                  className={`w-5 h-5 transition-transform duration-200 ${
                    isActive ? 'scale-110 stroke-[2.4]' : 'stroke-[1.8] opacity-85'
                  }`}
                />
              </div>

              {/* M3 Floating Badge Counter — plafonné à 99+ */}
              {item.badge !== undefined && (
                <span
                  title={String(item.badge)}
                  className={`absolute -top-1 right-1 min-w-[22px] justify-center px-1.5 py-0.5 rounded-full text-[10px] font-black tracking-tight shadow-md ring-2 ring-pos-panel tabular-nums animate-in zoom-in-75 flex ${item.badgeColor}`}
                >
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
            </div>

            {/* Navigation Label — masqué en paysage pour préserver le contenu */}
            <span
              className={`text-[11px] tracking-tight mt-1 leading-none transition-colors duration-200 landscape:hidden ${
                isActive ? 'font-bold text-emerald-400' : 'text-pos-muted'
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

import React from 'react';
import { Activity, Search, ShoppingBag, Users, SlidersHorizontal } from 'lucide-react';
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
  ];

  return (
    <nav className="min-h-16 h-[calc(4rem+env(safe-area-inset-bottom,0px))] bg-pos-panel border-t border-pos-border px-2 flex items-center justify-around select-none shrink-0 pb-[env(safe-area-inset-bottom,0px)] z-20">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;

        return (
          <button
            key={item.id}
            type="button"
            onClick={() => handleSelect(item.id)}
            className={`flex-1 flex flex-col items-center justify-center py-1.5 rounded-xl transition-all relative cursor-pointer min-h-[48px] ${
              isActive
                ? 'text-emerald-400 font-black'
                : 'text-pos-muted hover:text-pos-text font-medium'
            }`}
          >
            <div className="relative">
              <Icon
                className={`w-5 h-5 transition-transform ${
                  isActive ? 'scale-110 stroke-[2.5]' : 'stroke-2'
                }`}
              />
              {item.badge !== undefined && (
                <span
                  className={`absolute -top-1.5 -right-2 px-1.5 py-0.2 rounded-full text-[10px] font-black shadow-sm ${item.badgeColor}`}
                >
                  {item.badge}
                </span>
              )}
            </div>
            <span className="text-[10px] tracking-tight mt-1 leading-none">
              {item.label}
            </span>
            {isActive && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 absolute bottom-0.5" />
            )}
          </button>
        );
      })}
    </nav>
  );
};

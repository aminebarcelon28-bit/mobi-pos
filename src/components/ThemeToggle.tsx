import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';

export const ThemeToggle: React.FC = () => {
  const { themeMode, toggleTheme } = usePosStore();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="p-2 rounded-ui-sm bg-surface-card hover:bg-surface-card/80 border border-line-subtle hover:border-line text-fg-muted hover:text-fg transition-all duration-200 shadow-xs flex items-center justify-center gap-1.5 min-h-[34px] min-w-[34px] touch-manipulation focus-visible:ring-2 focus-visible:ring-pos-accent focus-visible:outline-none cursor-pointer h-ctl-md"
      title={`Mode Actuel: ${themeMode === 'dark' ? 'Sombre' : 'Clair'}. Cliquer pour basculer.`}
      aria-label={themeMode === 'dark' ? 'Clair — Passer au thème clair' : 'Sombre — Passer au thème sombre'}
    >
      {themeMode === 'dark' ? (
        <>
          <Sun aria-hidden="true" className="w-3.5 h-3.5 text-status-warn-fg animate-in fade-in spin-in-45 duration-300" />
          <span className="text-ui-xs font-semibold hidden sm:inline text-status-warn-fg">Clair</span>
        </>
      ) : (
        <>
          <Moon aria-hidden="true" className="w-3.5 h-3.5 text-indigo-400 animate-in fade-in duration-300" />
          <span className="text-ui-xs font-semibold hidden sm:inline text-indigo-400">Sombre</span>
        </>
      )}
    </button>
  );
};

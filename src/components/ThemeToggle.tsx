import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { usePosStore } from '../store/usePosStore';

export const ThemeToggle: React.FC = () => {
  const { themeMode, toggleTheme } = usePosStore();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="p-2.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text transition-all duration-200 shadow-xs flex items-center justify-center gap-1.5 min-h-[48px] min-w-[48px] touch-manipulation focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none"
      title={`Mode Actuel: ${themeMode === 'dark' ? 'Sombre' : 'Clair'}. Cliquer pour basculer.`}
      aria-label={themeMode === 'dark' ? 'Clair — Passer au thème clair' : 'Sombre — Passer au thème sombre'}
    >
      {themeMode === 'dark' ? (
        <>
          <Sun aria-hidden="true" className="w-4 h-4 text-amber-400 animate-in fade-in spin-in-45 duration-300" />
          <span className="text-xs font-semibold hidden sm:inline text-amber-300">Clair</span>
        </>
      ) : (
        <>
          <Moon aria-hidden="true" className="w-4 h-4 text-indigo-500 animate-in fade-in duration-300" />
          <span className="text-xs font-semibold hidden sm:inline text-indigo-600">Sombre</span>
        </>
      )}
    </button>
  );
};

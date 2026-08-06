import { useEffect } from 'react';

type KeyHandlers = {
  F1?: () => void;
  F2?: () => void;
  F3?: () => void;
  F4?: () => void;
  F5?: () => void;
  F6?: () => void;
  F7?: () => void;
  F8?: () => void;
  F9?: () => void;
  F10?: () => void;
  F11?: () => void;
  F12?: () => void;
  Escape?: () => void;
  [key: string]: (() => void) | undefined;
};

export const useHotkeys = (handlers: KeyHandlers) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);
      const isFunctionKeyOrEsc = e.key.startsWith('F') || e.key === 'Escape';

      // Ignore when user is typing inside input or textarea unless it's an F-key or Escape
      if (isInput && !isFunctionKeyOrEsc) {
        return;
      }

      const handler = handlers[e.key];
      if (handler) {
        if (isFunctionKeyOrEsc) {
          e.preventDefault();
        }
        handler();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlers]);
};

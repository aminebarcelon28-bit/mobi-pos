import { useEffect } from 'react';
import type { Product } from '../types/pos';

interface UseCatalogHotkeysOptions {
  products: Product[];
  onAddToCart: (product: Product) => void;
  disabled?: boolean;
}

/**
 * Hook for rapid 1-9 keyboard hotkeys on the top 9 displayed products in the POS catalog.
 * 
 * Safety features:
 * - Completely ignored when any input/textarea/select is focused (e.g. search bar, discount modal, customer form).
 * - Ignored when Ctrl, Alt, or Meta modifier keys are pressed.
 * - Supports both standard top-row number keys ('1'-'9') and Numpad keys ('Numpad1'-'Numpad9').
 * - Respects active modal / dialog states.
 */
export const useCatalogHotkeys = ({
  products,
  onAddToCart,
  disabled = false,
}: UseCatalogHotkeysOptions) => {
  useEffect(() => {
    if (disabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Guard against modifier combinations (e.g. Ctrl+1, Alt+1)
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      // Guard against focused input elements (search bar, text inputs, textareas)
      const target = e.target as HTMLElement | null;
      const isInputFocused =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable);

      if (isInputFocused) return;

      // Determine digit from key or code
      let digit: number | null = null;
      if (e.key >= '1' && e.key <= '9') {
        digit = parseInt(e.key, 10);
      } else if (e.code && e.code.startsWith('Numpad') && e.code.length === 7) {
        const num = parseInt(e.code.replace('Numpad', ''), 10);
        if (num >= 1 && num <= 9) {
          digit = num;
        }
      }

      if (digit !== null && digit >= 1 && digit <= 9) {
        const index = digit - 1;
        const product = products[index];
        if (product) {
          e.preventDefault();
          onAddToCart(product);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [products, onAddToCart, disabled]);
};

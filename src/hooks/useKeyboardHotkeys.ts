import { useEffect } from 'react';
import { usePosStore } from '../store/usePosStore';

export const useKeyboardHotkeys = () => {
  const { openModal, closeModal, activeModal, clearCart, holdSale } = usePosStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInputFocused =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;

      // Prevent browser default behavior for function keys
      if (e.key.startsWith('F') && e.key.length <= 3) {
        e.preventDefault();
      }

      // Handle Escape to close active modal regardless of focus
      if (e.key === 'Escape') {
        if (activeModal) {
          e.preventDefault();
          closeModal();
        }
        return;
      }

      // If a modal is open or the user is typing in an input, do not trigger background global POS shortcuts
      if (activeModal !== null) {
        return;
      }

      switch (e.key) {
        case 'F1':
          if (!isInputFocused) {
            const currentCart = usePosStore.getState().cart;
            if (currentCart.length > 0) {
              const totalItems = currentCart.reduce((acc, i) => acc + i.quantity, 0);
              if (totalItems > 1) {
                const ok = window.confirm(`Voulez-vous vraiment vider les ${totalItems} articles de la vente en cours ? (F1)`);
                if (!ok) break;
              }
              clearCart();
            }
          }
          break;

        case 'F2': {
          const searchInput = document.querySelector('input[type="text"]') as HTMLInputElement;
          if (searchInput) {
            searchInput.focus();
            searchInput.select();
          }
          break;
        }

        case 'F3': {
          const currentCart = usePosStore.getState().cart;
          if (currentCart.length > 0) {
            openModal('payment');
          }
          break;
        }

        case 'F4':
          openModal('hold');
          break;

        case 'F5':
          openModal('customers');
          break;

        case 'F6':
          openModal('discount');
          break;

        case 'F7':
          holdSale();
          break;

        case 'F8':
          openModal('hotkey_guide');
          break;

        case 'F9':
          openModal('reports');
          break;

        case 'F10':
          openModal('inventory_manager');
          break;

        case 'F11':
          openModal('refund');
          break;

        case 'F12':
          openModal('settings');
          break;

        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, clearCart, holdSale, openModal, closeModal]);
};

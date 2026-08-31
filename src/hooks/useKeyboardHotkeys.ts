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

      // Universal Escape handler: Always closes any open modal
      if (e.key === 'Escape') {
        if (activeModal) {
          e.preventDefault();
          closeModal();
        }
        return;
      }

      // Modal Function Key Toggles:
      // If the modal corresponding to the pressed function key is already open, pressing the function key again closes it.
      if (e.key === 'F12') {
        e.preventDefault();
        if (activeModal === 'settings') {
          closeModal();
        } else {
          openModal('settings');
        }
        return;
      }

      if (e.key === 'F11') {
        e.preventDefault();
        if (activeModal === 'refund') {
          closeModal();
        } else {
          openModal('refund');
        }
        return;
      }

      if (e.key === 'F10') {
        e.preventDefault();
        if (activeModal === 'inventory_manager') {
          closeModal();
        } else {
          openModal('inventory_manager');
        }
        return;
      }

      if (e.key === 'F9') {
        e.preventDefault();
        if (activeModal === 'reports') {
          closeModal();
        } else {
          openModal('reports');
        }
        return;
      }

      if (e.key === 'F8') {
        e.preventDefault();
        if (activeModal === 'hotkey_guide') {
          closeModal();
        } else {
          openModal('hotkey_guide');
        }
        return;
      }

      if (e.key === 'F6') {
        e.preventDefault();
        if (activeModal === 'discount') {
          closeModal();
        } else {
          openModal('discount');
        }
        return;
      }

      if (e.key === 'F5') {
        e.preventDefault();
        if (activeModal === 'customers') {
          closeModal();
        } else {
          openModal('customers');
        }
        return;
      }

      if (e.key === 'F4') {
        e.preventDefault();
        if (activeModal === 'hold') {
          closeModal();
        } else {
          openModal('hold');
        }
        return;
      }

      if (e.key === 'F3') {
        e.preventDefault();
        if (activeModal === 'payment') {
          closeModal();
        } else {
          const currentCart = usePosStore.getState().cart;
          if (currentCart.length > 0) {
            openModal('payment');
          }
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

        case 'F7':
          holdSale();
          break;

        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, clearCart, holdSale, openModal, closeModal]);
};

import { useEffect } from 'react';
import { usePosStore } from '../store/usePosStore';

export const useKeyboardHotkeys = () => {
  const { openModal, closeModal, activeModal, clearCart, holdSale, processPayment, quickCashPayment } = usePosStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent browser default behavior for function keys
      if (e.key.startsWith('F') && e.key.length <= 3) {
        e.preventDefault();
      }

      switch (e.key) {
        case 'F1':
          clearCart();
          break;

        case 'F2': {
          const searchInput = document.querySelector('input[type="text"]') as HTMLInputElement;
          if (searchInput) searchInput.focus();
          break;
        }

        case 'F3':
          if (e.shiftKey) {
            openModal('payment');
          } else {
            quickCashPayment();
          }
          break;

        case 'F4':
          if (e.shiftKey) {
            holdSale();
          } else {
            openModal('hold');
          }
          break;

        case 'F5':
          openModal('customers');
          break;

        case 'F6':
          openModal('discount');
          break;

        case 'F9':
          openModal('receipt');
          break;

        case 'F10':
          openModal('reports');
          break;

        case 'F11':
          openModal('inventory_manager');
          break;

        case 'F12':
          openModal('settings');
          break;

        case 'Escape':
          if (activeModal) closeModal();
          break;

        case 'Enter':
          if (activeModal === 'payment') {
            processPayment();
          } else if (activeModal === 'receipt') {
            closeModal();
          }
          break;

        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, clearCart, holdSale, openModal, closeModal, processPayment, quickCashPayment]);
};

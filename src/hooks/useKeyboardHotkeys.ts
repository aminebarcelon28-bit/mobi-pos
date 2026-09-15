import { useEffect } from 'react';
import { usePosStore } from '../store/usePosStore';

export const useKeyboardHotkeys = () => {
  const { openModal, closeModal, activeModal, clearCart, holdSale, reprintReceipt, lastTransaction } = usePosStore();

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

      // Universal Escape handler: Closes any open modal or unfocuses active input
      if (e.key === 'Escape') {
        if (activeModal) {
          e.preventDefault();
          closeModal();
          return;
        }
        if (isInputFocused && e.target instanceof HTMLElement) {
          e.preventDefault();
          e.target.blur();
          return;
        }
      }

      // F1 or Slash: Quick focus on Global Search
      if ((e.key === 'F1' || (e.key === '/' && !isInputFocused)) && !activeModal) {
        e.preventDefault();
        const searchInput = document.querySelector('input[type="text"]') as HTMLInputElement;
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
        return;
      }

      // F2 or Spacebar (when cart has items and not typing): Instant Cash Tender
      if ((e.key === 'F2' || (e.key === ' ' && !isInputFocused)) && !activeModal) {
        const currentCart = usePosStore.getState().cart;
        if (currentCart.length > 0) {
          e.preventDefault();
          openModal('payment');
          return;
        }
      }

      // F3 (or F5 alias): Customer Directory & Assign Client
      if (e.key === 'F3' || e.key === 'F5') {
        e.preventDefault();
        if (activeModal === 'customers') {
          closeModal();
        } else {
          openModal('customers');
        }
        return;
      }

      // F4: Global Basket Discount
      if (e.key === 'F4') {
        e.preventDefault();
        if (activeModal === 'discount') {
          closeModal();
        } else {
          openModal('discount');
        }
        return;
      }

      // F6: Suspend Sale (Hold) or Recall Held Tickets
      if (e.key === 'F6') {
        e.preventDefault();
        const currentCart = usePosStore.getState().cart;
        if (currentCart.length > 0 && activeModal === null) {
          holdSale();
        } else if (activeModal === 'hold') {
          closeModal();
        } else {
          openModal('hold');
        }
        return;
      }

      // F7: Instant Reprint of Last Receipt
      if (e.key === 'F7') {
        e.preventDefault();
        if (lastTransaction) {
          reprintReceipt(lastTransaction);
        }
        return;
      }

      // F8: Keyboard Hotkey Guide
      if (e.key === 'F8') {
        e.preventDefault();
        if (activeModal === 'hotkey_guide') {
          closeModal();
        } else {
          openModal('hotkey_guide');
        }
        return;
      }

      // F9: Financial Reports & Z-Report
      if (e.key === 'F9') {
        e.preventDefault();
        if (activeModal === 'reports') {
          closeModal();
        } else {
          openModal('reports');
        }
        return;
      }

      // F10: Stock & Inventory Manager
      if (e.key === 'F10') {
        e.preventDefault();
        if (activeModal === 'inventory_manager') {
          closeModal();
        } else {
          openModal('inventory_manager');
        }
        return;
      }

      // F11: Refunds & Returns
      if (e.key === 'F11') {
        e.preventDefault();
        if (activeModal === 'refund') {
          closeModal();
        } else {
          openModal('refund');
        }
        return;
      }

      // F12: Hardware Settings & Peripherals
      if (e.key === 'F12') {
        e.preventDefault();
        if (activeModal === 'settings') {
          closeModal();
        } else {
          openModal('settings');
        }
        return;
      }

      // Shift+Delete or Ctrl+Delete: Reset / Clear Cart (with verification)
      if ((e.key === 'Delete' || e.key === 'Backspace') && (e.shiftKey || e.ctrlKey) && !isInputFocused && !activeModal) {
        e.preventDefault();
        const currentCart = usePosStore.getState().cart;
        if (currentCart.length > 0) {
          clearCart();
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, clearCart, holdSale, openModal, closeModal, reprintReceipt, lastTransaction]);
};

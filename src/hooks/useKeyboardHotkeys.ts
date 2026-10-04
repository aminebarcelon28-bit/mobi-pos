import { useEffect } from 'react';
import { usePosStore } from '../store/usePosStore';

export const useKeyboardHotkeys = () => {
  // Selective subscriptions: whole-store spread re-rendered (and re-armed
  // this global key handler) on every unrelated slice change.
  const openModal = usePosStore((s) => s.openModal);
  const closeModal = usePosStore((s) => s.closeModal);
  const activeModal = usePosStore((s) => s.activeModal);
  const clearCart = usePosStore((s) => s.clearCart);
  const holdSale = usePosStore((s) => s.holdSale);
  const reprintReceipt = usePosStore((s) => s.reprintReceipt);
  const lastTransaction = usePosStore((s) => s.lastTransaction);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInputFocused =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;

      // Locked screen eats money hotkeys: F2/Space (cash tender), F4 (basket
      // discount) and F11 (refund) must not open payment surfaces behind the
      // lock overlay. Read straight from the store (no subscription) and
      // early-return — navigation/Escape keep working so the cashier can
      // still reach the PIN pad.
      if (usePosStore.getState().isScreenLocked) {
        if (
          e.key === 'F2' || e.key === ' ' ||
          e.key === 'F4' || e.key === 'F11'
        ) {
          e.preventDefault();
          return;
        }
      }

      // Ctrl+L / Cmd+L: Lock display / switch cashier (the lock shortcut —
      // F12 opens Settings, it never locked the screen, which is why F12
      // "did not work" for locking). preventDefault is required: browsers
      // reserve Ctrl+L for the address bar. Works from inputs too (it is not
      // text entry) and no-ops while already locked.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        if (!usePosStore.getState().isScreenLocked) {
          usePosStore.getState().lockScreen();
        }
        return;
      }

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

      // F9: Quick Custom Item & Rapid Services (Pose film, réparations, divers)
      if (e.key === 'F9') {
        e.preventDefault();
        if (activeModal === 'custom_item') {
          closeModal();
        } else {
          openModal('custom_item');
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
        const st = usePosStore.getState();
        const currentCart = st.cart;
        if (currentCart.length > 0) {
          // Audit parity with the desktop full-clear path: a hotkey wipe is
          // still a cart wipe. Honest flag (no PIN verified here) + real
          // operator name — never a hardcoded role or an unearned PIN chip.
          const units = currentCart.reduce((a, i) => a + i.quantity, 0);
          void st.logSecurityAction(
            'Annulation Complète Panier (Raccourci)',
            `Panier vidé au clavier (${units} unités)`,
            st.activeCashier?.name?.trim() || 'Caissier',
            false,
          );
          clearCart();
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, clearCart, holdSale, openModal, closeModal, reprintReceipt, lastTransaction]);
};

import { useEffect, useRef } from 'react';
import { usePosStore } from '../store/usePosStore';
import { useToast } from '../components/ui/Toast';
import type { MobileTab } from '../components/mobile/MobileBottomNav';

interface UseMobileBackNavigationOptions {
  activeTab?: MobileTab;
  setActiveTab?: (tab: MobileTab) => void;
  isMobile?: boolean;
  onRequestCartProtection?: () => boolean;
  isCartProtectionOpen?: boolean;
  onDismissCartProtection?: () => void;
  isCustomModalOpen?: boolean;
  onDismissCustomModal?: () => void;
}

export function useMobileBackNavigation({
  activeTab,
  setActiveTab,
  isMobile = true,
  onRequestCartProtection,
  isCartProtectionOpen = false,
  onDismissCartProtection,
  isCustomModalOpen = false,
  onDismissCustomModal,
}: UseMobileBackNavigationOptions = {}) {
  const { activeModal, closeModal } = usePosStore();
  const { showToast } = useToast();
  const lastBackPressTimeRef = useRef<number>(0);
  const isPopstateHandlingRef = useRef<boolean>(false);
  const prevModalRef = useRef<string | null>(null);
  const prevSheetRef = useRef<boolean>(false);

  // Sync history state when modals or bottom sheets open/close programmatically
  useEffect(() => {
    if (!isMobile || typeof window === 'undefined') return;

    const hasOpenModal = activeModal !== null;
    const hasOpenSheet = isCartProtectionOpen || isCustomModalOpen;
    const hadOpenModal = prevModalRef.current !== null;
    const hadOpenSheet = prevSheetRef.current;

    // When a modal or sheet opens, push history state if not already pushed
    if ((hasOpenModal && !hadOpenModal) || (hasOpenSheet && !hadOpenSheet)) {
      window.history.pushState(
        { mobiModal: activeModal, mobiSheet: hasOpenSheet },
        ''
      );
    } else if ((!hasOpenModal && hadOpenModal) || (!hasOpenSheet && hadOpenSheet)) {
      // Modal or sheet closed programmatically
      if (
        !isPopstateHandlingRef.current &&
        (window.history.state?.mobiModal || window.history.state?.mobiSheet)
      ) {
        window.history.back();
      }
    }

    prevModalRef.current = activeModal;
    prevSheetRef.current = hasOpenSheet;
    isPopstateHandlingRef.current = false;
  }, [activeModal, isCartProtectionOpen, isCustomModalOpen, isMobile]);

  // Hook into popstate, native Android back, and keyboard Escape
  useEffect(() => {
    if (!isMobile || typeof window === 'undefined') return;

    // Ensure root state exists so back button can be intercepted
    if (
      !window.history.state ||
      (!window.history.state.mobiRoot &&
        !window.history.state.mobiModal &&
        !window.history.state.mobiSheet)
    ) {
      window.history.replaceState({ mobiRoot: true }, '');
    }

    const handleBackAction = (e?: Event) => {
      // 1. If an active store modal is currently open, gracefully dismiss it first!
      if (usePosStore.getState().activeModal !== null) {
        if (e && e.cancelable) e.preventDefault();
        closeModal();
        return;
      }

      // 2. If a cart protection bottom sheet is currently open, dismiss it gracefully!
      if (isCartProtectionOpen) {
        if (e && e.cancelable) e.preventDefault();
        onDismissCartProtection?.();
        return;
      }

      // 3. If any custom modal/sheet is open, dismiss it!
      if (isCustomModalOpen) {
        if (e && e.cancelable) e.preventDefault();
        onDismissCustomModal?.();
        return;
      }

      // 4. If user is in checkout and has items in cart, guard active cart!
      if (activeTab === 'checkout' && usePosStore.getState().cart.length > 0) {
        if (onRequestCartProtection && onRequestCartProtection()) {
          if (e && e.cancelable) e.preventDefault();
          return;
        }
      }

      // 5. If user is in a secondary tab (checkout, catalog, kredy, management, diagnostics), go back to main activity!
      if (activeTab && activeTab !== 'activity' && setActiveTab) {
        if (e && e.cancelable) e.preventDefault();
        setActiveTab('activity');
        return;
      }

      // 6. At root ('activity' tab): double-tap prevention before app exit
      const now = Date.now();
      if (now - lastBackPressTimeRef.current < 2000) {
        // Allow default Android exit / window close
        return;
      }

      lastBackPressTimeRef.current = now;
      if (e && e.cancelable) e.preventDefault();
      // Re-push root state to catch the next back press
      window.history.pushState({ mobiRoot: true }, '');
      showToast('Appuyez à nouveau pour quitter l\'application', 'info');
    };

    const onPopState = (e: PopStateEvent) => {
      isPopstateHandlingRef.current = true;
      handleBackAction(e);
      requestAnimationFrame(() => {
        isPopstateHandlingRef.current = false;
      });
    };

    // Native Android WebView event from MainActivity.kt
    const onAndroidBack = (e: Event) => {
      handleBackAction(e);
    };

    // Keyboard Escape listener
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleBackAction(e);
      }
    };

    window.addEventListener('popstate', onPopState);
    window.addEventListener('mobi:back-pressed', onAndroidBack);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('mobi:back-pressed', onAndroidBack);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    activeModal,
    activeTab,
    closeModal,
    isCartProtectionOpen,
    isCustomModalOpen,
    isMobile,
    onDismissCartProtection,
    onDismissCustomModal,
    onRequestCartProtection,
    setActiveTab,
    showToast,
  ]);
}

import { useEffect, useRef } from 'react';
import { usePosStore } from '../store/usePosStore';
import { useToast } from '../components/ui/Toast';
import type { MobileTab } from '../components/mobile/MobileBottomNav';

interface UseMobileBackNavigationOptions {
  activeTab?: MobileTab;
  setActiveTab?: (tab: MobileTab) => void;
  isMobile?: boolean;
  onRequestCartProtection?: () => boolean;
}

export function useMobileBackNavigation({
  activeTab,
  setActiveTab,
  isMobile = true,
  onRequestCartProtection,
}: UseMobileBackNavigationOptions = {}) {
  const { activeModal, closeModal } = usePosStore();
  const { showToast } = useToast();
  const lastBackPressTimeRef = useRef<number>(0);
  const isPopstateHandlingRef = useRef<boolean>(false);
  const prevModalRef = useRef<string | null>(null);

  // Sync history state when modals open or close programmatically
  useEffect(() => {
    if (!isMobile || typeof window === 'undefined') return;

    // When a modal opens, push history state
    if (activeModal !== null && prevModalRef.current === null) {
      window.history.pushState({ mobiModal: activeModal }, '');
    } else if (activeModal === null && prevModalRef.current !== null) {
      // Modal closed programmatically
      if (!isPopstateHandlingRef.current && window.history.state?.mobiModal) {
        window.history.back();
      }
    }
    prevModalRef.current = activeModal;
    isPopstateHandlingRef.current = false;
  }, [activeModal, isMobile]);

  // Hook into popstate, native Android back, and keyboard Escape
  useEffect(() => {
    if (!isMobile || typeof window === 'undefined') return;

    // Ensure root state exists so back button can be intercepted
    if (!window.history.state || (!window.history.state.mobiRoot && !window.history.state.mobiModal)) {
      window.history.replaceState({ mobiRoot: true }, '');
    }

    const handleBackAction = (e?: Event) => {
      // 1. If a modal is currently open, close it!
      if (usePosStore.getState().activeModal !== null) {
        if (e && e.cancelable) e.preventDefault();
        closeModal();
        return;
      }

      // 2. If user is in checkout and has items in cart, protect active cart!
      if (activeTab === 'checkout' && usePosStore.getState().cart.length > 0) {
        if (onRequestCartProtection && onRequestCartProtection()) {
          if (e && e.cancelable) e.preventDefault();
          return;
        }
      }

      // 3. If user is in a secondary tab (checkout, catalog, kredy, management), go back to main activity!
      if (activeTab && activeTab !== 'activity' && setActiveTab) {
        if (e && e.cancelable) e.preventDefault();
        setActiveTab('activity');
        return;
      }

      // 3. At root: double-tap prevention
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
  }, [activeModal, activeTab, closeModal, setActiveTab, showToast, isMobile]);
}

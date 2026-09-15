import { useEffect, useRef } from 'react';
import { usePosStore } from '../store/usePosStore';
import { useToast } from '../components/ui/Toast';
import type { MobileTab } from '../components/mobile/MobileBottomNav';

interface UseMobileBackNavigationOptions {
  activeTab?: MobileTab;
  setActiveTab?: (tab: MobileTab) => void;
  isMobile?: boolean;
}

export function useMobileBackNavigation({
  activeTab,
  setActiveTab,
  isMobile = true,
}: UseMobileBackNavigationOptions = {}) {
  const { activeModal, closeModal } = usePosStore();
  const { showToast } = useToast();
  const lastBackPressTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!isMobile) return;

    const handleBackAction = (e?: Event) => {
      // 1. If a modal is currently open, close it!
      if (usePosStore.getState().activeModal !== null) {
        if (e && e.cancelable) e.preventDefault();
        closeModal();
        return;
      }

      // 2. If user is in a secondary tab (checkout, catalog, kredy, management), go back to main activity!
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
      showToast('Appuyez à nouveau pour quitter l\'application', 'info');
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

    window.addEventListener('mobi:back-pressed', onAndroidBack);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('mobi:back-pressed', onAndroidBack);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeModal, activeTab, closeModal, setActiveTab, showToast, isMobile]);
}

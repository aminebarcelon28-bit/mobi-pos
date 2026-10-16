import { useState, useEffect, useRef } from 'react';

/**
 * useVirtualKeyboard — Detects on-screen keyboard (IME) visibility and height
 * across modern iOS (Safari / WebKit) and Android (Chrome / WebView).
 *
 * Synchronizes `--keyboard-height` and `--visual-viewport-height` directly onto
 * `document.documentElement.style` inside `requestAnimationFrame` (accounting for
 * `visualViewport.offsetTop` on iOS WKWebView) to prevent React re-render layout
 * thrash during keyboard slide animations while keeping fixed chrome and active
 * bottom sheets clear of the IME.
 */
export function useVirtualKeyboard() {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const rafIdRef = useRef<number | null>(null);
  const lastHeightRef = useRef<number>(0);
  const lastVisibleRef = useRef<boolean>(false);

  const focusTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const rootStyle = document.documentElement.style;

    const syncViewportMetrics = () => {
      rafIdRef.current = null;
      const activeEl = document.activeElement;
      const isInputFocused =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        (activeEl instanceof HTMLElement && activeEl.isContentEditable);

      const vv = window.visualViewport;
      const rawInset = vv
        ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
        : 0;

      if (vv) {
        rootStyle.setProperty('--visual-viewport-height', `${Math.round(vv.height)}px`);
      }

      // 120px threshold separates Android/iOS soft keyboards (220-340px) from browser toolbar shifts
      const nextVisible = rawInset > 120 && isInputFocused;
      const nextHeight = nextVisible ? rawInset : 0;

      if (lastHeightRef.current !== nextHeight) {
        lastHeightRef.current = nextHeight;
        rootStyle.setProperty('--keyboard-height', `${nextHeight}px`);
        setKeyboardHeight(nextHeight);
      }

      if (lastVisibleRef.current !== nextVisible) {
        lastVisibleRef.current = nextVisible;
        setIsKeyboardVisible(nextVisible);
        if (nextVisible && activeEl instanceof HTMLElement && typeof activeEl.scrollIntoView === 'function') {
          let reduceMotion = false;
          try {
            reduceMotion =
              typeof window.matchMedia === 'function' &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          } catch {
            reduceMotion = false;
          }
          activeEl.scrollIntoView({
            block: 'nearest',
            behavior: reduceMotion ? 'auto' : 'smooth',
          });
        }
      }
    };

    const scheduleSync = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = window.requestAnimationFrame(syncViewportMetrics);
    };

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', scheduleSync, { passive: true });
      vv.addEventListener('scroll', scheduleSync, { passive: true });
    }

    const onFocusIn = () => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = window.setTimeout(scheduleSync, 100);
    };

    const onFocusOut = () => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = window.setTimeout(scheduleSync, 100);
    };

    window.addEventListener('focusin', onFocusIn, { passive: true });
    window.addEventListener('focusout', onFocusOut, { passive: true });

    // Initial sync on mount
    scheduleSync();

    return () => {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
      }
      if (vv) {
        vv.removeEventListener('resize', scheduleSync);
        vv.removeEventListener('scroll', scheduleSync);
      }
      window.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('focusout', onFocusOut);
      rootStyle.setProperty('--keyboard-height', '0px');
    };
  }, []);

  return { isKeyboardVisible, keyboardHeight };
}


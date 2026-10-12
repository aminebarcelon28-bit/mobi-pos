import { useState, useEffect } from 'react';

/**
 * useVirtualKeyboard — Detects on-screen keyboard (IME) visibility and height
 * across modern iOS (Safari / WebKit) and Android (Chrome / WebView).
 *
 * When an input is focused on mobile, the on-screen keyboard shrinks the
 * visual viewport. This hook tracks visibility so fixed chrome (such as
 * MobileBottomNav) can hide to give 100% of the visible viewport to the
 * active input and suggestions.
 */
export function useVirtualKeyboard() {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const checkKeyboardState = () => {
      const activeEl = document.activeElement;
      const isInputFocused =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        (activeEl instanceof HTMLElement && activeEl.isContentEditable);

      if (window.visualViewport) {
        const vv = window.visualViewport;
        const diff = window.innerHeight - vv.height;
        // Keyboard height threshold: keyboards are typically > 160px on mobile
        if (diff > 160 && isInputFocused) {
          setIsKeyboardVisible(true);
          setKeyboardHeight(Math.round(diff));
          return;
        }
      }

      if (!isInputFocused) {
        setIsKeyboardVisible(false);
        setKeyboardHeight(0);
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', checkKeyboardState);
      window.visualViewport.addEventListener('scroll', checkKeyboardState);
    }

    const onFocusIn = () => {
      // Small timeout allows visualViewport resize to settle
      window.setTimeout(checkKeyboardState, 150);
    };

    const onFocusOut = () => {
      window.setTimeout(() => {
        const activeEl = document.activeElement;
        const stillFocused =
          activeEl instanceof HTMLInputElement ||
          activeEl instanceof HTMLTextAreaElement ||
          (activeEl instanceof HTMLElement && activeEl.isContentEditable);
        if (!stillFocused) {
          setIsKeyboardVisible(false);
          setKeyboardHeight(0);
        }
      }, 100);
    };

    window.addEventListener('focusin', onFocusIn);
    window.addEventListener('focusout', onFocusOut);

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', checkKeyboardState);
        window.visualViewport.removeEventListener('scroll', checkKeyboardState);
      }
      window.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  return { isKeyboardVisible, keyboardHeight };
}


import { useEffect, useRef, useCallback } from 'react';

interface UseFocusTrapOptions {
  isActive: boolean;
  onEscape?: () => void;
}

export function useFocusTrap({ isActive, onEscape }: UseFocusTrapOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const focusableElementsRef = useRef<HTMLElement[]>([]);

  const updateFocusableElements = useCallback(() => {
    if (!containerRef.current) return;
    const focusableSelectors = [
      'button:not([disabled]):not([aria-hidden="true"])',
      '[href]:not([aria-hidden="true"])',
      'input:not([disabled]):not([aria-hidden="true"])',
      'select:not([disabled]):not([aria-hidden="true"])',
      'textarea:not([disabled]):not([aria-hidden="true"])',
      '[tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])',
      '[contenteditable="true"]:not([aria-hidden="true"])',
    ].join(', ');

    focusableElementsRef.current = Array.from(
      containerRef.current.querySelectorAll<HTMLElement>(focusableSelectors)
    ).filter((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    });
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isActive || !containerRef.current) return;

      if (event.key === 'Escape') {
        event.stopPropagation();
        onEscape?.();
        return;
      }

      if (event.key !== 'Tab') return;

      updateFocusableElements();
      const focusableElements = focusableElementsRef.current;
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey) {
        if (activeElement === firstElement || !containerRef.current.contains(activeElement)) {
          event.preventDefault();
          lastElement.focus({ preventScroll: true });
        }
      } else {
        if (activeElement === lastElement || !containerRef.current.contains(activeElement)) {
          event.preventDefault();
          firstElement.focus({ preventScroll: true });
        }
      }
    },
    [isActive, onEscape, updateFocusableElements]
  );

  useEffect(() => {
    if (!isActive) return;

    previousActiveElementRef.current = document.activeElement as HTMLElement;

    updateFocusableElements();
    const focusableElements = focusableElementsRef.current;
    if (focusableElements.length > 0) {
      (focusableElements[0] as HTMLElement).focus({ preventScroll: true });
    }

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previousActiveElementRef.current) {
        (previousActiveElementRef.current as HTMLElement).focus({ preventScroll: true });
      }
    };
  }, [isActive, handleKeyDown, updateFocusableElements]);

  return containerRef;
}

export default useFocusTrap;
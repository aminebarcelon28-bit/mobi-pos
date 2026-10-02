import { useEffect, useRef } from 'react';

export function useBodyScrollLock(isLocked: boolean) {
  const originalStyleRef = useRef<string | null>(null);
  const originalTouchActionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLocked) return;

    const body = document.body;
    const html = document.documentElement;

    originalStyleRef.current = body.style.overflow;
    originalTouchActionRef.current = body.style.touchAction;

    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    body.style.overflow = 'hidden';
    body.style.touchAction = 'none';
    body.style.paddingRight = `${scrollbarWidth}px`;

    html.style.overflow = 'hidden';

    return () => {
      body.style.overflow = originalStyleRef.current ?? '';
      body.style.touchAction = originalTouchActionRef.current ?? '';
      body.style.paddingRight = '';
      html.style.overflow = '';
    };
  }, [isLocked]);
}

export default useBodyScrollLock;
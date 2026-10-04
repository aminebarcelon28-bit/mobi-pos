import { useEffect, useState } from 'react';

/**
 * One shared 1 Hz-ish clock for the whole app.
 *
 * A table of relative timestamps would otherwise start one timer per visible
 * row. Subscribers get a `now` epoch they can bucket at whatever precision
 * they need, and the interval only runs while at least one component is
 * mounted and the document is visible.
 */

type Listener = (now: number) => void;

const listeners = new Set<Listener>();
let timer: number | null = null;

const start = () => {
  if (timer !== null || typeof window === 'undefined') return;
  timer = window.setInterval(() => {
    const now = Date.now();
    listeners.forEach((fn) => fn(now));
  }, 1_000);
};

const stop = () => {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
};

const onVisibility = () => {
  if (document.hidden) {
    stop();
  } else {
    // Re-sync immediately: a window restored after a minute would otherwise
    // keep showing the pre-hide "il y a 0 min" for up to a full second.
    const now = Date.now();
    listeners.forEach((fn) => fn(now));
    start();
  }
};

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onVisibility);
}

export function useSharedClock(active = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;

    const listener: Listener = (value) => setNow(value);
    listeners.add(listener);
    if (document.hidden) {
      // Still subscribed so a `visibilitychange` wakes every consumer at once.
    } else {
      start();
    }

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stop();
    };
  }, [active]);

  return now;
}

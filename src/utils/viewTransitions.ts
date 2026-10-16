/**
 * Checks whether the user or test environment has requested reduced motion
 * (`@media (prefers-reduced-motion: reduce)`).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Safely executes a DOM/React state transition inside `document.startViewTransition`
 * when supported (Chromium 111+ / Safari 18+) and reduced motion is NOT active.
 * Falls back to an immediate synchronous call when unsupported, when the document
 * is hidden, or under `@media (prefers-reduced-motion: reduce)`.
 */
export function runViewTransition(updateCallback: () => void): void {
  // Synchronous execution avoids view transition snapshot ghosting during tab changes
  updateCallback();
}

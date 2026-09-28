/**
 * Tiny boot-phase timer (LCP work). Records performance.now() marks so a real
 * device can report where boot time goes via window.__mobipos_bootTimings.
 * Zero dependencies; never throws; safe to import from any lane (no cycles).
 */
const bootT0: number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : 0;

interface BootMark {
  name: string;
  ms: number;
}

const marks: BootMark[] = [];

/**
 * Boot console output is dev-only: a merchant till must boot silently in
 * production. Timing/LCP data stays available always via
 * window.__mobipos_bootTimings / window.__mobipos_lcp (zero console cost).
 */
function bootLogEnabled(): boolean {
  try {
    return (
      typeof import.meta !== 'undefined' &&
      Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
    );
  } catch {
    return false;
  }
}

export function markBoot(name: string): void {
  try {
    if (typeof performance === 'undefined' || typeof performance.now !== 'function') return;
    marks.push({ name, ms: Math.round(performance.now() - bootT0) });
  } catch {
    // Timing must never break boot.
  }
}

export function printBootSummary(): void {
  try {
    const w = window as unknown as Record<string, unknown>;
    w.__mobipos_bootTimings = [...marks];
    if (bootLogEnabled() && marks.length > 0) {
      console.info(
        '[boot] timings ms: ' + marks.map((m) => `${m.name}=${m.ms}`).join(' '),
      );
    }
  } catch {
    // never break boot.
  }
}

/**
 * Field LCP reporter (LCP work): observes Largest Contentful Paint candidates
 * and logs ONE settled line, so a slow LCP can be attributed to a concrete
 * node (image? grid? modal?) instead of guessed at. Candidates update live on
 * window.__mobipos_lcp; the FINAL line prints 2.5s after the last candidate
 * (LCP stops on user interaction). Read-only, zero behavior change;
 * disconnects after 30s regardless.
 */
export function observeLcpOnce(): void {
  try {
    if (typeof PerformanceObserver === 'undefined') return;
    let settleTimer: number | undefined;
    const report = (ms: number, desc: string, final: boolean): void => {
      try {
        (window as unknown as Record<string, unknown>).__mobipos_lcp = { ms, el: desc };
        if (!bootLogEnabled()) return;
        console.info(final ? `[boot] LCP FINAL ms: ${ms} el=${desc}` : `[boot] LCP ms: ${ms} el=${desc}`);
      } catch {
        // ignore
      }
    };
    const po = new PerformanceObserver((list) => {
      try {
        const entries = list.getEntries();
        const last = entries[entries.length - 1] as unknown as {
          startTime?: number;
          element?: { tagName?: string; className?: unknown };
        };
        if (!last || typeof last.startTime !== 'number') return;
        const tag = String(last.element?.tagName || '').toLowerCase() || '?';
        const cls = String(last.element?.className ?? '').slice(0, 60);
        const ms = Math.round(last.startTime);
        const desc = `<${tag} class="${cls}">`;
        report(ms, desc, false);
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => report(ms, desc, true), 2500);
      } catch {
        // ignore observer payload errors
      }
    });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
    window.setTimeout(() => {
      try {
        window.clearTimeout(settleTimer);
        po.disconnect();
      } catch {
        // ignore
      }
    }, 30_000);
  } catch {
    // PerformanceObserver unavailable - skip silently.
  }
}

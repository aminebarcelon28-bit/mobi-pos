/**
 * DIAGNOSTIC (batch 26 follow-up) — what is on screen when the app does not
 * reach setup/lock/dashboard? Dumps the DOM text, the crash reports and the
 * localStorage keys; asserts nothing.
 */
import { browser } from '@wdio/globals';

describe('batch26 diagnostic — boot screen', () => {
  it('D0 dump whatever is mounted', async () => {
    await browser.pause(8000);
    const dump = (await browser.execute(() => {
      const w = window as unknown as {
        __mobipos_getCrashReports?: () => unknown[];
        __TAURI_INTERNALS__?: Record<string, unknown>;
      };
      const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1200);
      const testids = [...document.querySelectorAll('[data-testid]')]
        .map((n) => n.getAttribute('data-testid'))
        .slice(0, 40);
      const ls: Record<string, string> = {};
      try {
        for (let i = 0; i < localStorage.length && i < 40; i += 1) {
          const k = localStorage.key(i) ?? '';
          ls[k] = String(localStorage.getItem(k) ?? '').slice(0, 80);
        }
      } catch {
        /* ignore */
      }
      let crashes: unknown[] = [];
      try {
        crashes = (w.__mobipos_getCrashReports?.() ?? []).slice(-5);
      } catch {
        /* ignore */
      }
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        hasInternals: '__TAURI_INTERNALS__' in window,
        bodyLen: (document.body?.innerHTML ?? '').length,
        text,
        testids,
        crashes,
        lsKeys: Object.keys(ls),
        lsSample: Object.fromEntries(Object.entries(ls).slice(0, 8)),
      };
    })) as Record<string, unknown>;
    console.log(`[D0] ${JSON.stringify(dump)}`);
  });
});

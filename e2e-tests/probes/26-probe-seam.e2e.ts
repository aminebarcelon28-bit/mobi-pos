/**
 * DIAGNOSTIC (batch 26 follow-up) — find a seam that can observe the ESC/POS
 * payload of a real print without mutating app code.
 *
 * Established facts (probe runs 1-2):
 *   - `window.__TAURI_INTERNALS__.invoke` is a non-writable, non-configurable
 *     own property, so wrapping it in place silently no-ops.
 *   - The real command runs and fails HARDWARE_ERROR/StartDocPrinter (no
 *     printer in the sandbox), and `printViaWindowsSpooler` swallows it.
 *
 * This spec dumps every property descriptor on the internals object, then
 * tries the two remaining seams in order (replace the window property; wrap
 * the lower-level transport) and reports which one actually observes a call.
 * It asserts nothing — it prints `[SEAM] ...` evidence lines.
 */
import { browser } from '@wdio/globals';

type Row = Record<string, unknown>;

describe('batch26 diagnostic — IPC seam', () => {
  it('S1 dump internals descriptors', async () => {
    const dump = (await browser.execute(() => {
      const w = window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> };
      const internals = w.__TAURI_INTERNALS__;
      const winDesc = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
      if (!internals) return { hasInternals: false };
      const props: Record<string, unknown> = {};
      for (const name of Object.getOwnPropertyNames(internals)) {
        const d = Object.getOwnPropertyDescriptor(internals, name);
        props[name] = {
          type: typeof (internals as Record<string, unknown>)[name],
          writable: d?.writable ?? null,
          configurable: d?.configurable ?? null,
          get: Boolean(d?.get),
          enumerable: d?.enumerable ?? null,
        };
      }
      return {
        hasInternals: true,
        winDesc: winDesc
          ? {
              writable: winDesc.writable,
              configurable: winDesc.configurable,
              get: Boolean(winDesc.get),
              type: typeof winDesc.value,
            }
          : null,
        props,
        pluginKeys: internals.plugins
          ? Object.keys(internals.plugins as Record<string, unknown>).slice(0, 20)
          : [],
      };
    })) as Row;
    console.log(`[SEAM-S1] ${JSON.stringify(dump)}`);
  });

  it('S2 can the window property be replaced?', async () => {
    const res = (await browser.execute(async () => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: Record<string, unknown> & { invoke: (...a: unknown[]) => unknown };
        __seamHits?: number;
      };
      const orig = w.__TAURI_INTERNALS__;
      if (!orig) return { status: 'no-internals' };
      const desc = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
      if (!desc || desc.configurable === false) {
        return { status: 'not-configurable', desc: desc ? { configurable: desc.configurable } : null };
      }
      w.__seamHits = 0;
      const proxy = new Proxy(orig, {
        get(target, prop, recv) {
          if (prop === 'invoke') {
            return (...a: unknown[]) => {
              const cmd = String(a[0] ?? '');
              if (/print|drawer/i.test(cmd)) w.__seamHits = (w.__seamHits ?? 0) + 1;
              return (target.invoke as (...x: unknown[]) => unknown).apply(target, a);
            };
          }
          return Reflect.get(target, prop, recv);
        },
      });
      let defineErr = '';
      try {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          value: proxy,
          writable: true,
          configurable: true,
          enumerable: desc.enumerable,
        });
      } catch (e) {
        defineErr = String(e);
      }
      const took = w.__TAURI_INTERNALS__ === proxy;
      let callOut = '';
      try {
        await w.__TAURI_INTERNALS__.invoke('sqlite_print_raw_escpos', {
          printerName: 'SEAM-S2',
          data: [27, 64, 10],
        });
        callOut = 'resolved';
      } catch (e) {
        callOut = `rejected:${String((e as { code?: string })?.code ?? e).slice(0, 60)}`;
      }
      return { status: 'attempted', defineErr, took, hits: w.__seamHits ?? 0, callOut };
    })) as Row;
    console.log(`[SEAM-S2] ${JSON.stringify(res)}`);
  });

  it('S3 can the lower-level transport be wrapped?', async () => {
    const res = (await browser.execute(async () => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: Record<string, unknown> & { invoke: (...a: unknown[]) => unknown };
        __seamHits3?: number;
      };
      const internals = w.__TAURI_INTERNALS__;
      if (!internals) return { status: 'no-internals' };
      // Restore the real object in case S2 replaced it.
      const target = (internals as { __orig?: unknown }).__orig ?? internals;
      const candidates = ['ipc', 'postMessage', 'transformCallback', 'convertFileSrc', 'invoke'];
      const report: Record<string, unknown> = {};
      for (const name of candidates) {
        const d = Object.getOwnPropertyDescriptor(target as object, name);
        report[name] = {
          type: typeof (target as Record<string, unknown>)[name],
          writable: d?.writable ?? null,
          configurable: d?.configurable ?? null,
        };
      }
      return { status: 'dumped', report };
    })) as Row;
    console.log(`[SEAM-S3] ${JSON.stringify(res)}`);
  });
});

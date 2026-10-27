/**
 * WebView-side IPC helpers. Primary channel: `window.__TAURI_INTERNALS__.invoke`
 * (the raw bridge every `@tauri-apps/api` call funnels through — available
 * because the e2e flavor sets `withGlobalTauri`). Fallback: `window.__TAURI__.core.invoke`.
 *
 * `invokeRaw` never throws on app-side errors: the native `CODE:detail`
 * shape is preserved for assertions (WDIO otherwise wraps in-page throws
 * into generic WebDriverError objects).
 */
import { browser } from '@wdio/globals';

export async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await invokeRaw<T>(cmd, args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

export async function invokeRaw<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  await waitForTauri();
  return (await browser.execute(
    async (c: string, a: Record<string, unknown>) => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (c: string, a: unknown, o?: unknown) => Promise<unknown> };
        __TAURI__?: { core?: { invoke: (c: string, a: unknown) => Promise<unknown> } };
      };
      const fn = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
      if (!fn) return { ok: false as const, error: '__TAURI_INTERNALS__ / __TAURI__ missing' };
      try {
        const value = (await fn(c, a)) as T;
        return { ok: true as const, value };
      } catch (e: unknown) {
        const flat =
          typeof e === 'string'
            ? e
            : (e as { message?: unknown })?.message ??
              (() => {
                try {
                  return JSON.stringify(e);
                } catch {
                  return String(e);
                }
              })();
        return { ok: false as const, error: String(flat ?? e) };
      }
    },
    cmd,
    args,
  )) as { ok: true; value: T } | { ok: false; error: string };
}

async function waitForTauri(): Promise<void> {
  await browser
    .waitUntil(
      async () => {
        try {
          return await browser.execute(
            () =>
              typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === 'object' ||
              typeof (window as unknown as { __TAURI__?: unknown }).__TAURI__ === 'object',
          );
        } catch {
          return false;
        }
      },
      { timeout: 20000, interval: 250, timeoutMsg: 'Tauri IPC bridge never appeared' },
    )
    .catch(() => {});
}

/** First CODE:token segment of a native OperationFailed detail string. */
export function nativeCodeOf(raw: string): string {
  const m = /"detail"\s*:\s*"([^"]+)"/.exec(raw);
  if (m) return m[1].slice(0, 200);
  const m2 = /([A-Z][A-Z0-9_]{3,})/.exec(raw);
  return m2 ? m2[1] : raw.split('\n')[0].slice(0, 200);
}

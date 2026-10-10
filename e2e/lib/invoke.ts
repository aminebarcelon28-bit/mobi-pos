/**
 * Typed `invoke` wrapper for WDIO specs: calls a Rust `#[tauri::command]`
 * through the e2e overlay's `window.__TAURI__.core.invoke`
 * (`withGlobalTauri: true` exists ONLY in the e2e flavor).
 *
 * Money tests drive sales through the SAME paths the UI uses; `e2e_*`
 * commands are setup/ground-truth reads only (never sale creation).
 */
export async function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await browser.execute(
    async (c: string, a: Record<string, unknown>) => {
      const w = window as unknown as {
        __TAURI__?: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } };
      };
      if (!w.__TAURI__) {
        throw new Error('__TAURI__ global missing (e2e overlay withGlobalTauri?)');
      }
      return (await w.__TAURI__.core.invoke(c, a)) as T;
    },
    cmd,
    args,
  )) as T;
}

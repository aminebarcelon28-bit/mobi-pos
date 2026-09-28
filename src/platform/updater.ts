/**
 * @platform/updater — Tauri updater + process restart seam
 *
 * The ONLY files in the webview allowed to import `@tauri-apps/plugin-updater`
 * and `@tauri-apps/plugin-process` (AGENTS.md §3 placement law). Hooks call
 * through this seam so capability permissions stay reviewable in one place.
 */
import type { Update } from '@tauri-apps/plugin-updater';

export type { Update };

/** Native desktop update check. Returns null when no update or not Tauri. */
export async function checkNativeUpdate(opts?: { timeout?: number }): Promise<Update | null> {
  const { check } = await import('@tauri-apps/plugin-updater');
  return (await check(opts)) ?? null;
}

/** Restart the process after a native update install. */
export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

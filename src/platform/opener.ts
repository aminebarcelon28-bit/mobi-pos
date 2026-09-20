/**
 * @platform/opener — External URL opening seam
 *
 * The ONLY file in the webview allowed to import `@tauri-apps/plugin-opener`.
 * Feature code opens external URLs through `openExternalUrl` so plugin
 * permissions are consumed behind the platform seam (AGENTS.md §3).
 */
import { openUrl } from '@tauri-apps/plugin-opener';

/** Convenience wrapper so the OS/browser opens `url` outside the webview. */
export async function openExternalUrl(url: string): Promise<void> {
  await openUrl(url);
}
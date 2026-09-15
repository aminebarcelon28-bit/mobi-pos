/**
 * @platform/ipc — Unified Platform IPC Seam
 * 
 * Enforces AGENTS.md §3 Placement Law:
 * "The webview talks to Rust only through the platform/ seam and the typed invokeCommand wrapper."
 * 
 * No component, store, or service outside src/platform may import @tauri-apps/api/core.
 */

import { invoke } from '@tauri-apps/api/core';
import { toApiError } from '../api/error';

/**
 * Universal typed command invocation wrapper
 */
export async function invokeCommand<TResult = void, TArgs extends Record<string, unknown> = Record<string, unknown>>(
  command: string,
  args?: TArgs
): Promise<TResult> {
  try {
    return await invoke<TResult>(command, args);
  } catch (error) {
    throw toApiError(error, 'INTERNAL_ERROR');
  }
}

// ----------------------------------------------------------------------
// Re-exported platform API surfaces
// ----------------------------------------------------------------------
export * from '../api/backup';
export * from '../api/cloud';
export * from '../api/hardware';

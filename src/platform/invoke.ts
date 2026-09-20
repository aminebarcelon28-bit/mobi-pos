/**
 * @platform/invoke — Typed IPC invocation wrapper
 *
 * The ONLY file in the webview allowed to import `@tauri-apps/api/core`.
 * Every Rust command call in the codebase must go through `invokeCommand`,
 * which maps Rust-side errors into the canonical `ApiError` taxonomy.
 *
 * Conforms to AGENTS.md §3 Placement Law and rules.md R6.2.
 */
import { invoke } from '@tauri-apps/api/core';
import { toApiError, type ApiErrorCode } from '../api/error';

/**
 * Universal typed command invocation wrapper.
 *
 * @param command Name of the Rust `#[tauri::command]` to call.
 * @param args    Optional typed argument object passed to Rust.
 * @param fallbackCode ApiError code used when Rust returns an unmapped error.
 */
export async function invokeCommand<
  TResult = void,
  TArgs extends Record<string, unknown> = Record<string, unknown>,
>(
  command: string,
  args?: TArgs,
  fallbackCode: ApiErrorCode = 'INTERNAL_ERROR'
): Promise<TResult> {
  try {
    return await invoke<TResult>(command, args);
  } catch (error) {
    throw toApiError(error, fallbackCode);
  }
}
/**
 * @platform/ipc — Unified Platform IPC Seam
 * 
 * Enforces AGENTS.md §3 Placement Law:
 * "The webview talks to Rust only through the platform/ seam and the typed invokeCommand wrapper."
 * 
 * No component, store, or service outside src/platform may import @tauri-apps/* IPC
 * or event APIs. `invokeCommand` lives in ./invoke; this module re-exports the
 * typed IPC surface consumers bind against.
 */

export * from './invoke';
export * from './events';
export * from './opener';

// ----------------------------------------------------------------------
// Re-exported platform API surfaces
// ----------------------------------------------------------------------
export * from '../api/backup';
export * from '../api/cloud';
export * from '../api/hardware';
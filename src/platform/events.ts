/**
 * @platform/events — Typed Tauri event-listener seam
 *
 * The ONLY file in the webview allowed to import `@tauri-apps/api/event`.
 * Consumer hooks subscribe through `listenToEvent` so the Rust-driven
 * `db:changed` / hardware hotplug events never leak raw @tauri imports
 * into feature code (AGENTS.md §3).
 */
import { listen } from '@tauri-apps/api/event';

export type EventUnlisten = () => void;

/** Subscribe to a Rust-emitted event; returns an unlisten function. */
export async function listenToEvent<T>(
  event: string,
  handler: (payload: T) => void
): Promise<EventUnlisten> {
  return listen<T>(event, (eventPayload) => {
    handler(eventPayload.payload);
  });
}
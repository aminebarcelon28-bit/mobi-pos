/**
 * CDP Connection Helper — Discovers the Tauri WebView2 CDP endpoint
 * and returns the WebSocket debugger URL for Playwright connectOverCDP.
 *
 * The app must be launched with:
 *   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
 *   start target-e2e\debug\mobi-pos.exe
 */

import { createHash } from 'crypto';

const DEFAULT_PORT = 9223;

export async function discoverCdpEndpoint(port = DEFAULT_PORT) {
  const res = await fetch(`http://localhost:${port}/json`);
  const pages = await res.json();
  if (!pages || pages.length === 0) {
    throw new Error(`No CDP targets found on port ${port}. Is the app running with remote debugging enabled?`);
  }
  // Find the main app page (tauri.localhost)
  const appPage = pages.find((p) => p.url && p.url.includes('tauri.localhost')) || pages[0];
  return {
    pageId: appPage.id,
    url: appPage.url,
    title: appPage.title,
    webSocketDebuggerUrl: appPage.webSocketDebuggerUrl,
    port,
  };
}

export function cdpWsUrl(port = DEFAULT_PORT) {
  return `ws://localhost:${port}/json`;
}

/**
 * Generate a deterministic scenario ID prefix for evidence tracking.
 */
export function scenarioEvidenceId(scenarioId, attempt = 1) {
  return `EV-${scenarioId}-attempt${attempt}`;
}
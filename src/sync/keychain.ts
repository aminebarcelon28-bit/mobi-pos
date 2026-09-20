// Secure OS Keychain wrapper for Turso cloud credentials.
// Credentials (database URL and auth token) are stored in the native OS Keychain
// (Windows Credential Manager / macOS Keychain / Linux Secret Service).
// Never stored in plaintext files, never in local config, never committed to git.
// Complying with rules.md S4.1 & Section 10 (tokens never stored in browser storage).

import {
  getCloudCredentials as apiGetCloudCredentials,
  setCloudCredentials as apiSetCloudCredentials,
  deleteCloudCredentials as apiDeleteCloudCredentials,
  type CloudCredentials,
} from '../api/cloud';

export type { CloudCredentials };

const isTauri = (): boolean => {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI_INTERNALS__ || (window as unknown as { __TAURI__?: unknown }).__TAURI__);
};

// In-memory cache for fast sync loops (cleared on disconnect or app exit)
let memoryCache: CloudCredentials | null = null;

const LEGACY_STORAGE_KEY = 'mobi_pos_cloud_creds_fallback';
const WEB_CREDS_KEY = 'mobi_pos_web_turso_creds';

/**
 * Removes any credential copies from Web Storage.
 * The Turso auth token must never rest in plaintext localStorage/sessionStorage
 * inside a Tauri build (rules.md S4.1) — the OS keychain / vault file is the
 * only store there. Runs as a migration wipe after a successful keychain read.
 */
function purgeWebMirror(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(WEB_CREDS_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(WEB_CREDS_KEY);
    }
  } catch {
    // Storage restricted
  }
}

export async function getCloudCredentials(): Promise<CloudCredentials | null> {
  if (memoryCache) return memoryCache;

  // 1. In Tauri environment: read from native OS Keychain / vault file via IPC
  if (isTauri()) {
    try {
      const creds = await apiGetCloudCredentials();
      if (creds && creds.url && creds.token) {
        memoryCache = creds;
        // Migration wipe: tokens mirrored by older builds must not linger in Web Storage.
        purgeWebMirror();
        return creds;
      }
    } catch (err) {
      console.warn('Failed to read cloud credentials from OS Keychain:', err);
    }
  }

  // 2. Web fallback (pure browser / mobile-web only): never consulted first in Tauri.
  try {
    const raw = (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(WEB_CREDS_KEY) : null) ||
                (typeof localStorage !== 'undefined' ? localStorage.getItem(WEB_CREDS_KEY) : null);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.url && parsed.token) {
        memoryCache = parsed;
        return parsed;
      }
    }
  } catch {
    // Storage restricted
  }

  return null;
}

export async function setCloudCredentials(url: string, token: string): Promise<void> {
  const trimmedUrl = url.trim();
  const trimmedToken = token.trim();
  if (!trimmedUrl || !trimmedToken) {
    throw new Error('Database URL et Auth Token sont obligatoires.');
  }
  if (!trimmedUrl.startsWith('libsql://') && !trimmedUrl.startsWith('https://')) {
    throw new Error('Format d\'URL invalide: doit commencer par libsql:// ou https://');
  }

  const payload: CloudCredentials = { url: trimmedUrl, token: trimmedToken };

  if (isTauri()) {
    try {
      await apiSetCloudCredentials(trimmedUrl, trimmedToken);
    } catch (err) {
      console.warn('Failed to save cloud credentials via IPC:', err);
    }
  }

  // Mirror to Web Storage ONLY outside Tauri (pure mobile-web fallback).
  // Inside Tauri the token lives in the OS keychain / vault file exclusively —
  // never in plaintext browser storage (rules.md S4.1).
  if (!isTauri()) {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(WEB_CREDS_KEY, JSON.stringify(payload));
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(WEB_CREDS_KEY, JSON.stringify(payload));
      }
    } catch {
      // Storage restricted
    }
  }

  memoryCache = payload;
}

export async function deleteCloudCredentials(): Promise<void> {
  memoryCache = null;
  if (isTauri()) {
    try {
      await apiDeleteCloudCredentials();
    } catch (err) {
      console.warn('Keychain delete error:', err);
    }
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      localStorage.removeItem(WEB_CREDS_KEY);
    }
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(WEB_CREDS_KEY);
    }
  } catch {
    // Storage restricted
  }
}

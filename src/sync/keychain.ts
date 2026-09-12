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

export async function getCloudCredentials(): Promise<CloudCredentials | null> {
  if (memoryCache) return memoryCache;

  // 1. In Tauri environment: read from native Windows Credential Manager via IPC
  if (isTauri()) {
    try {
      const creds = await apiGetCloudCredentials();
      if (creds && creds.url && creds.token) {
        memoryCache = creds;
        return creds;
      }
    } catch (err) {
      console.warn('Failed to read cloud credentials from OS Keychain:', err);
    }
  }

  // 2. Clear any legacy insecure local storage keys
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('mobi_pos_web_turso_creds');
    }
  } catch {
    // Storage access restricted in some sandboxed environments
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
    await apiSetCloudCredentials(trimmedUrl, trimmedToken);
  }

  // Complying with rules.md S4.1: token lives strictly in memoryCache, NEVER in localStorage
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
    }
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('mobi_pos_web_turso_creds');
    }
  } catch {
    // Storage access restricted
  }
}

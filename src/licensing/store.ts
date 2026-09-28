/**
 * License Credential & State Persistence
 * Handles secure storage of JWT license tokens and monotonic clock watermarks.
 */

import {
  getLicenseToken as apiGetLicenseToken,
  setLicenseToken as apiSetLicenseToken,
  deleteLicenseToken as apiDeleteLicenseToken,
} from '../api/license';
import type { ClockGuardState } from './clockGuard';

const isTauri = (): boolean => {
  return (
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI_INTERNALS__ ||
        (window as unknown as { __TAURI__?: unknown }).__TAURI__
    )
  );
};

const WEB_LICENSE_KEY = 'mobi_pos_web_license_token';
const CLOCK_GUARD_KEY = 'mobi_pos_clock_guard_v1';

let cachedLicenseToken: string | null = null;

// Event Emitter for Mid-Session Revocation
type RevocationListener = (reason: string) => void;
const revocationListeners = new Set<RevocationListener>();

export function onLicenseRevoked(listener: RevocationListener): () => void {
  revocationListeners.add(listener);
  return () => revocationListeners.delete(listener);
}

export function emitLicenseRevoked(reason: string = 'Licence révoquée par le serveur'): void {
  console.warn('[licensing] LICENSE_REVOKED triggered:', reason);
  for (const listener of revocationListeners) {
    try {
      listener(reason);
    } catch (e) {
      console.error('[licensing] Error in revocation listener:', e);
    }
  }
}

/**
 * Loads the active license token from OS Keychain or Vault file.
 */
export async function loadStoredLicenseToken(): Promise<string | null> {
  if (cachedLicenseToken) return cachedLicenseToken;

  if (isTauri()) {
    try {
      const token = await apiGetLicenseToken();
      if (token && token.trim()) {
        cachedLicenseToken = token.trim();
        return cachedLicenseToken;
      }
    } catch (err) {
      console.warn('[licensing] Failed to read license token from Keychain:', err);
    }
  }

  // Web fallback
  try {
    const webToken = localStorage.getItem(WEB_LICENSE_KEY);
    if (webToken) {
      cachedLicenseToken = webToken;
      return cachedLicenseToken;
    }
  } catch {
    // Storage restricted
  }

  return null;
}

/**
 * Persists the validated license token into OS Keychain or Vault.
 */
export async function persistLicenseToken(token: string): Promise<void> {
  cachedLicenseToken = token;

  if (isTauri()) {
    try {
      await apiSetLicenseToken(token);
    } catch (err) {
      console.warn('[licensing] Failed to save license token to Keychain:', err);
    }
  }

  try {
    localStorage.setItem(WEB_LICENSE_KEY, token);
  } catch {
    // Storage restricted
  }
}

/**
 * Clears license token from secure storage.
 */
export async function clearStoredLicenseToken(): Promise<void> {
  cachedLicenseToken = null;

  if (isTauri()) {
    try {
      await apiDeleteLicenseToken();
    } catch (err) {
      console.warn('[licensing] Failed to delete license token from Keychain:', err);
    }
  }

  try {
    localStorage.removeItem(WEB_LICENSE_KEY);
  } catch {
    // Storage restricted
  }
}

/**
 * Loads persistent monotonic clock guard timestamps.
 */
export function loadClockGuardState(): ClockGuardState {
  try {
    const raw = localStorage.getItem(CLOCK_GUARD_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        lastKnownTimestamp: Number(parsed.lastKnownTimestamp) || 0,
        lastVerifiedAt: Number(parsed.lastVerifiedAt) || 0,
      };
    }
  } catch {
    // Storage unavailable
  }

  return {
    lastKnownTimestamp: 0,
    lastVerifiedAt: 0,
  };
}

/**
 * Durably saves updated clock guard timestamps.
 */
export function saveClockGuardState(state: ClockGuardState): void {
  try {
    localStorage.setItem(CLOCK_GUARD_KEY, JSON.stringify(state));
  } catch {
    // Storage restricted
  }
}

// ============================================================================
// Suspension & Revocation Persistent Enforcement
// ============================================================================

const SUSPENSION_KEY = 'mobi_pos_license_suspension_v1';
const LAST_KEY_STORAGE = 'mobi_pos_last_active_key';

export interface LicenseSuspensionState {
  suspended: boolean;
  reason: string;
  suspendedAt: number;
  licenseKey?: string;
}

export function loadSuspensionState(): LicenseSuspensionState | null {
  try {
    const raw = localStorage.getItem(SUSPENSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.suspended === true) {
        return parsed as LicenseSuspensionState;
      }
    }
  } catch {
    // Storage restricted
  }
  return null;
}

export function saveSuspensionState(state: LicenseSuspensionState): void {
  try {
    localStorage.setItem(SUSPENSION_KEY, JSON.stringify(state));
  } catch {
    // Storage restricted
  }
}

export function clearSuspensionState(): void {
  try {
    localStorage.removeItem(SUSPENSION_KEY);
  } catch {
    // Storage restricted
  }
}

export function saveLastActiveLicenseKey(key: string): void {
  try {
    if (key && key.trim()) {
      localStorage.setItem(LAST_KEY_STORAGE, key.trim());
    }
  } catch {
    // Storage restricted
  }
}

export function getLastActiveLicenseKey(): string | null {
  try {
    return localStorage.getItem(LAST_KEY_STORAGE);
  } catch {
    return null;
  }
}

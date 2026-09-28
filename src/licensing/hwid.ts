/**
 * Hardware Fingerprinting & Identity Bridge
 * Bridges Rust/native hardware identification to frontend licensing engine.
 */

import { getHardwareFingerprint, type HardwareFingerprintResult } from '../api/license';
import { isMobileDevice, isAndroid, isIOS } from '../utils/platform';

const WEB_HWID_KEY = 'mobi_pos_web_hwid_v1';

const isTauri = (): boolean => {
  return (
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI_INTERNALS__ ||
        (window as unknown as { __TAURI__?: unknown }).__TAURI__
    )
  );
};

function getOrCreateWebHwid(): HardwareFingerprintResult {
  try {
    let existing = localStorage.getItem(WEB_HWID_KEY);
    if (!existing) {
      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      const hex = Array.from(array)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      existing = hex;
      localStorage.setItem(WEB_HWID_KEY, existing);
    }

    const onMobile = isMobileDevice() || isAndroid() || isIOS();
    const upper = existing.toUpperCase();
    const prefix = onMobile ? 'MOB' : 'WEB';
    const formatted = `MOBI-${prefix}-${upper.slice(0, 4)}-${upper.slice(4, 8)}`;
    return {
      formatted,
      hash: existing,
      platform: onMobile ? 'android' : 'web',
    };
  } catch {
    return {
      formatted: 'MOBI-WEB-FALLBACK',
      hash: 'fallback-browser-hash',
      platform: 'web-fallback',
    };
  }
}

/**
 * Resolves the device hardware fingerprint.
 * In Tauri: queries native Windows registry / Android ID via Rust.
 * In Web: uses persistent browser crypto ID.
 */
export async function resolveDeviceFingerprint(): Promise<HardwareFingerprintResult> {
  if (isTauri()) {
    try {
      const res = await getHardwareFingerprint();
      if (res && res.hash) {
        return res;
      }
    } catch (err) {
      console.warn('[licensing] Native HWID call failed, falling back to web ID:', err);
    }
  }

  return getOrCreateWebHwid();
}

/**
 * Platform Detection & Device Adaptation Engine
 * Implements AGENTS.md §1 (POS mode vs Companion mode)
 */

export type DeviceRole = 'pos_primary' | 'companion_mobile' | 'backoffice_desktop';

export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const userAgent = navigator.userAgent || navigator.vendor || (window as unknown as { opera?: string }).opera || '';
  const isTouchMobile = /android|iphone|ipad|ipod|windows phone/i.test(userAgent);
  const isSmallScreen = Math.min(window.innerWidth, window.innerHeight) < 768;
  return isTouchMobile || isSmallScreen;
}

export function isMobileScreen(): boolean {
  if (typeof window === 'undefined') return false;
  return Math.min(window.innerWidth, window.innerHeight) < 768;
}

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function isAndroid(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || navigator.vendor || '';
  return /android/i.test(ua);
}

export function isIOS(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || navigator.vendor || '';
  return /iphone|ipad|ipod/i.test(ua);
}

const OVERRIDE_KEY = 'mobi_pos_device_mode_override';

export function getDeviceRoleOverride(): DeviceRole | null {
  if (typeof window === 'undefined') return null;
  try {
    const val = localStorage.getItem(OVERRIDE_KEY);
    if (val === 'pos_primary' || val === 'companion_mobile') return val;
  } catch {
    // LocalStorage might be disabled
  }
  return null;
}

export function setDeviceRoleOverride(role: DeviceRole | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!role) {
      localStorage.removeItem(OVERRIDE_KEY);
    } else {
      localStorage.setItem(OVERRIDE_KEY, role);
    }
    window.dispatchEvent(new Event('mobi:devicerole-change'));
  } catch {
    // Ignore error
  }
}

export function getDeviceRole(): DeviceRole {
  if (typeof window === 'undefined') return 'pos_primary';
  try {
    const params = new URLSearchParams(window.location.search);
    const modeParam = params.get('mode');
    if (modeParam === 'mobile') return 'companion_mobile';
    if (modeParam === 'desktop') return 'pos_primary';
  } catch {
    // Ignore URL parsing errors
  }
  const override = getDeviceRoleOverride();
  if (override) return override;
  return isMobileDevice() ? 'companion_mobile' : 'pos_primary';
}

/**
 * Keyboard Wedge Barcode Scanner Listener
 * Listens for hardware barcode scanner bursts ending with 'Enter'.
 */
export function setupKeyboardWedgeScanner(onScan: (barcode: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  let buffer = '';
  let lastCharTime = 0;
  const KEY_THRESHOLD_MS = 50; // Barcode scanners input characters < 50ms apart

  const handleKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const isEditingInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    const currentTime = Date.now();
    const timeDelta = currentTime - lastCharTime;
    lastCharTime = currentTime;

    if (e.key === 'Enter') {
      if (buffer.length >= 3) {
        onScan(buffer.trim());
        buffer = '';
        if (!isEditingInput) {
          e.preventDefault();
        }
      } else {
        buffer = '';
      }
      return;
    }

    if (e.key.length === 1) {
      if (timeDelta > KEY_THRESHOLD_MS && buffer.length > 0) {
        buffer = ''; // Reset buffer if human-typed slowly
      }
      buffer += e.key;
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => {
    window.removeEventListener('keydown', handleKeyDown);
  };
}

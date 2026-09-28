/**
 * Platform Detection & Device Adaptation Engine
 * Implements AGENTS.md §1 (POS mode vs Companion mode)
 */

export type DeviceRole = 'pos_primary' | 'companion_mobile' | 'backoffice_desktop';

export function isMobileDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || navigator.vendor || (window as unknown as { opera?: string }).opera || '';

  // 1. Explicit Desktop OS signatures (Windows NT, Mac, Linux Desktop)
  // NEVER classify a Windows PC as mobile, even with touch screens or small windows
  if (/windows nt/i.test(ua)) return false;
  if (/macintosh|mac os x/i.test(ua) && navigator.maxTouchPoints <= 1) return false;
  if (/linux/i.test(ua) && !/android/i.test(ua)) return false;

  // 2. Explicit Mobile OS signatures
  const isMobileOS = /android|iphone|ipad|ipod|windows phone|blackberry|iemobile|opera mini|mobile/i.test(ua);
  if (isMobileOS) return true;

  // 3. iPad / iOS 13+ desktop spoofing (reports as Macintosh with touch)
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
    return true;
  }

  // 4. Touchscreen mobile heuristics (strictly coarse pointer on small screens)
  const hasCoarsePointer = Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const isPhoneScreen = Math.min(window.screen.width, window.screen.height) < 600;
  return hasCoarsePointer && isPhoneScreen;
}

export function isDesktopDevice(): boolean {
  return !isMobileDevice();
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

export type PlatformCategory = 'mobile' | 'tablet' | 'desktop';
export type OSFamily = 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'web';

export interface DevicePlatformDetails {
  osFamily: OSFamily;
  category: PlatformCategory;
  displayName: string;
  badgeLabel: string;
  roleHint: 'desktop' | 'mobile';
  isNative: boolean;
  isTablet: boolean;
  isTouch: boolean;
}

export function getDetailedPlatform(): DevicePlatformDetails {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      osFamily: 'windows',
      category: 'desktop',
      displayName: 'Poste Caisse PC',
      badgeLabel: '🖥️ Windows PC (Caisse)',
      roleHint: 'desktop',
      isNative: false,
      isTablet: false,
      isTouch: false,
    };
  }

  const ua = navigator.userAgent || navigator.vendor || '';
  const isTouch = Boolean(
    navigator.maxTouchPoints > 0 ||
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
  );
  const isNative = isTauriEnvironment();
  const screenMin = Math.min(window.screen.width, window.screen.height);
  const isTabletScreen = screenMin >= 600 && screenMin <= 1024 && isTouch;

  // 1. Android
  if (/android/i.test(ua)) {
    const isTablet = isTabletScreen || /tablet/i.test(ua);
    return {
      osFamily: 'android',
      category: isTablet ? 'tablet' : 'mobile',
      displayName: isTablet ? 'Tablette Android' : 'Smartphone Android',
      badgeLabel: isTablet ? '📱 Android Tablette' : '📱 Android Smartphone',
      roleHint: 'mobile',
      isNative,
      isTablet,
      isTouch: true,
    };
  }

  // 2. iOS / iPadOS
  const isIPad = /ipad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (/iphone|ipod/i.test(ua) || isIPad) {
    return {
      osFamily: 'ios',
      category: isIPad ? 'tablet' : 'mobile',
      displayName: isIPad ? 'Apple iPad' : 'Apple iPhone',
      badgeLabel: isIPad ? '🍎 Apple iPad' : '🍎 Apple iPhone',
      roleHint: 'mobile',
      isNative,
      isTablet: isIPad,
      isTouch: true,
    };
  }

  // 3. Windows Desktop
  if (/windows/i.test(ua)) {
    return {
      osFamily: 'windows',
      category: 'desktop',
      displayName: 'Poste Caisse Windows',
      badgeLabel: '🖥️ Windows PC (Poste Caisse)',
      roleHint: 'desktop',
      isNative,
      isTablet: false,
      isTouch,
    };
  }

  // 4. macOS
  if (/macintosh|mac os x/i.test(ua) && !isIPad) {
    return {
      osFamily: 'macos',
      category: 'desktop',
      displayName: 'Station macOS',
      badgeLabel: '💻 Apple macOS',
      roleHint: 'desktop',
      isNative,
      isTablet: false,
      isTouch: false,
    };
  }

  // 5. Linux
  if (/linux/i.test(ua)) {
    return {
      osFamily: 'linux',
      category: 'desktop',
      displayName: 'Station Linux',
      badgeLabel: '🐧 Linux Desktop',
      roleHint: 'desktop',
      isNative,
      isTablet: false,
      isTouch,
    };
  }

  // 6. Generic Mobile vs Desktop fallback
  const isMob = isMobileDevice();
  return {
    osFamily: 'web',
    category: isMob ? 'mobile' : 'desktop',
    displayName: isMob ? 'Terminal Mobile' : 'Poste Caisse',
    badgeLabel: isMob ? '📱 Mobile Web' : '🖥️ Navigateur Web',
    roleHint: isMob ? 'mobile' : 'desktop',
    isNative,
    isTablet: false,
    isTouch,
  };
}

/**
 * True when a window-level keydown originated inside a natively editable
 * field (input / textarea / select / contentEditable).
 *
 * Global shortcuts and scanner/pad key handlers must bail out here: the OS
 * and the field already own the keystroke (typing, Backspace deletion,
 * Enter-to-submit). Intercepting it as well double-applies digits, kills
 * native Backspace deletion on mobile soft keyboards, or submits twice.
 */
export function isEditableKeyTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return Boolean(
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t !== null && t.isContentEditable === true)
  );
}

const OVERRIDE_KEY = 'mobi_pos_device_mode_override';

/**
 * Trusted-companion flag (per-device, local-only, never synced).
 * A companion phone/tablet is a personal device the merchant already unlocks
 * with the OS — once paired (or manually unlocked once), the app stops
 * putting its own PIN wall on every launch. Explicit lock (lock button)
 * still locks for the session; sensitive actions always re-ask the manager
 * PIN regardless of trust. Desktop/pos_primary is never trusted: the shared
 * till always gates on PIN.
 */
const COMPANION_TRUST_KEY = 'mobi_pos_companion_trusted';

export function isCompanionTrusted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(COMPANION_TRUST_KEY) === '1';
  } catch {
    return false;
  }
}

export function markCompanionTrusted(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(COMPANION_TRUST_KEY, '1');
  } catch {
    // Private mode — trust simply won't persist; PIN wall stays.
  }
}

export function clearCompanionTrusted(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(COMPANION_TRUST_KEY);
  } catch {
    // Ignore error
  }
}

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

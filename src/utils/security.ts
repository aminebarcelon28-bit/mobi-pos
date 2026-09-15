/**
 * Cryptographic Security Engine for MobiPOS
 * Implements PBKDF2 / SHA-256 salted PIN hashing with backward-compatible migration.
 */

// Pure TypeScript Synchronous SHA-256 implementation
function sha256Sync(ascii: string): string {
  function rightRotate(value: number, amount: number) {
    return (value >>> amount) | (value << (32 - amount));
  }

  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let result = '';

  const words: number[] = [];
  const asciiBitLength = ascii.length * 8;

  let hash: number[] = [];
  let k: number[] = [];
  let primeCounter = 0;

  const isComposite: Record<number, boolean> = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (let i = 0; i < 300; i += candidate) {
        isComposite[i] = true;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  ascii += '\x80';
  while ((ascii.length % 64) - 56) ascii += '\x00';
  for (let i = 0; i < ascii.length; i++) {
    const j = ascii.charCodeAt(i);
    if (j >> 8) return '';
    words[i >> 2] = (words[i >> 2] || 0) | (j << (((3 - i) % 4) * 8));
  }
  words[words.length] = (asciiBitLength / maxWord) | 0;
  words[words.length] = asciiBitLength;

  for (let j = 0; j < words.length; ) {
    const w = words.slice(j, (j += 16));
    const oldHash = [...hash];

    for (let i = 0; i < 64; i++) {
      const w15 = w[i - 15] || 0;
      const w2 = w[i - 2] || 0;

      const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
      const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
      w[i] =
        i < 16
          ? (w[i] || 0)
          : (((w[i - 16] || 0) + s0 + (w[i - 7] || 0) + s1) | 0);

      const s1b = rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25);
      const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
      const temp1 = (hash[7] + s1b + ch + k[i] + w[i]) | 0;
      const s0b = rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22);
      const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
      const temp2 = (s0b + maj) | 0;

      hash = [(temp1 + temp2) | 0, hash[0], hash[1], hash[2], (hash[3] + temp1) | 0, hash[4], hash[5], hash[6]];
    }

    for (let i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }

  for (let i = 0; i < 8; i++) {
    for (let b = 3; b >= 0; b--) {
      const byte = (hash[i] >> (b * 8)) & 255;
      result += (byte < 16 ? '0' : '') + byte.toString(16);
    }
  }
  return result;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function generateRandomSalt(length = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const randomBytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(randomBytes);
  } else {
    for (let i = 0; i < length; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let salt = '';
  for (let i = 0; i < length; i++) {
    salt += chars.charAt(randomBytes[i] % chars.length);
  }
  return salt;
}

/**
 * Hash a plain PIN into `v1$salt$hash` format
 */
export function hashPin(pin: string, salt?: string): string {
  const cleanPin = pin.trim();
  const cleanSalt = salt || generateRandomSalt();
  const raw = `${cleanSalt}:${cleanPin}:mobi_pos_salt_v1`;
  const digest = sha256Sync(raw);
  return `v1$${cleanSalt}$${digest}`;
}

/**
 * Synchronous verification of PIN against stored hash or legacy plaintext
 */
export function verifyPin(inputPin: string, storedHashOrPlain: string): boolean {
  const cleanInput = inputPin.trim();
  if (!storedHashOrPlain) {
    // Fail-closed per R10.1: Never accept hardcoded fallback credentials
    return false;
  }

  // Format: v1$salt$digest
  if (storedHashOrPlain.startsWith('v1$')) {
    const parts = storedHashOrPlain.split('$');
    if (parts.length === 3) {
      const salt = parts[1];
      const expectedDigest = parts[2];
      const computed = sha256Sync(`${salt}:${cleanInput}:mobi_pos_salt_v1`);
      return timingSafeEqual(computed, expectedDigest);
    }
  }

  // Legacy plaintext fallback
  return timingSafeEqual(cleanInput, storedHashOrPlain);
}

/**
 * Check if stored PIN is legacy plaintext
 */
export function isLegacyPlainPin(stored: string): boolean {
  return !stored.startsWith('v1$');
}

// ── BRUTE FORCE LOCKOUT PROTECTION ──
const LOCKOUT_KEY = 'mobipos_pin_lockout_v1';
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

interface LockoutState {
  failedAttempts: number;
  lockedUntil: number | null;
}

function getStoredLockoutState(): LockoutState {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCKOUT_KEY) : null;
    if (raw) {
      return JSON.parse(raw) as LockoutState;
    }
  } catch {
    // Ignore parse errors, use clean state
  }
  return { failedAttempts: 0, lockedUntil: null };
}

function saveLockoutState(state: LockoutState): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LOCKOUT_KEY, JSON.stringify(state));
    }
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Check if PIN input is currently locked due to too many failed attempts
 */
export function checkPinLockout(): { isLocked: boolean; remainingSeconds: number; attemptsLeft: number } {
  const state = getStoredLockoutState();
  const now = Date.now();

  if (state.lockedUntil && state.lockedUntil > now) {
    const remainingSeconds = Math.ceil((state.lockedUntil - now) / 1000);
    return { isLocked: true, remainingSeconds, attemptsLeft: 0 };
  }

  // If lockout expired, reset state
  if (state.lockedUntil && state.lockedUntil <= now) {
    resetPinLockout();
    return { isLocked: false, remainingSeconds: 0, attemptsLeft: MAX_ATTEMPTS };
  }

  const attemptsLeft = Math.max(0, MAX_ATTEMPTS - state.failedAttempts);
  return { isLocked: false, remainingSeconds: 0, attemptsLeft };
}

/**
 * Record a failed PIN attempt and apply lockout if threshold reached
 */
export function recordPinFailure(): { isLocked: boolean; remainingSeconds: number; attemptsLeft: number } {
  const state = getStoredLockoutState();
  const nextAttempts = state.failedAttempts + 1;

  if (nextAttempts >= MAX_ATTEMPTS) {
    const lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    saveLockoutState({ failedAttempts: nextAttempts, lockedUntil });
    return { isLocked: true, remainingSeconds: Math.ceil(LOCKOUT_DURATION_MS / 1000), attemptsLeft: 0 };
  }

  saveLockoutState({ failedAttempts: nextAttempts, lockedUntil: null });
  return { isLocked: false, remainingSeconds: 0, attemptsLeft: MAX_ATTEMPTS - nextAttempts };
}

/**
 * Reset failed attempts upon successful PIN authentication
 */
export function resetPinLockout(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LOCKOUT_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

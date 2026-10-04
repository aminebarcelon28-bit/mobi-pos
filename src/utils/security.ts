/**
 * Cryptographic Security Engine for MobiPOS
 * PIN hashing is single-round salted SHA-256 (`v1$`), NOT PBKDF2 despite any
 * older comment to the contrary. Phase 4.5: this is brute-forceable offline
 * (see report); Argon2id (`v2$`, native `pin_set`, owner-approved 2026-10-02)
 * is the production replacement — every rotation path routes through
 * `rotatePinCredential`, which mints natively under Tauri. The `v1$` helpers
 * below survive ONLY for the non-Tauri preview/tests lane and the boot
 * plaintext-migration step (which forces rotation at next login, closing the
 * chain to `v2$`). Do not strengthen by adding rounds here — migrate formats
 * instead.
 */

// Pure TypeScript Synchronous SHA-256 implementation
// Perf: the prime-derived H/K constants are input-independent — compute once
// and reuse. The old code rebuilt them (prime sieve) on every hash, so each
// PIN verify paid the sieve cost (verify loops over users × hashes).
// Standard FIPS 180-4 SHA-256 initial hash values (first 32 bits of the fractional parts of the square roots of the first 8 primes)
const STD_H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

// Standard FIPS 180-4 SHA-256 round constants (first 32 bits of the fractional parts of the cube roots of the first 64 primes)
const STD_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// Legacy sieve-variant constants (where prime sieve stopped at 300, setting K[62]=0xb1bf9402 and K[63]=0xb3a680f4)
const SIEVE_K: readonly number[] = [
  ...STD_K.slice(0, 62),
  0xb1bf9402,
  0xb3a680f4,
];

function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function runSha256(ascii: string, kTable: readonly number[]): string {
  const maxWord = Math.pow(2, 32);
  let result = '';

  const words: number[] = [];
  const asciiBitLength = ascii.length * 8;

  let hash: number[] = [...STD_H0];

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
      const temp1 = (hash[7] + s1b + ch + kTable[i] + w[i]) | 0;
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

export function sha256Sync(ascii: string): string {
  return runSha256(ascii, STD_K);
}

export function sieveSha256Sync(ascii: string): string {
  return runSha256(ascii, SIEVE_K);
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
 * Banal-PIN screen (NIST 800-63B-4 §3.1.1.2). WebView pre-check for instant
 * UX feedback; the NATIVE check in `pin.rs::is_blocklisted_pin` is
 * authoritative (it runs even when this one is bypassed). KEEP THE TWO LISTS
 * IN SYNC — a PIN passing here can still be refused natively, and callers
 * must surface the native refusal (never silently mint).
 */
const COMMON_PINS: ReadonlySet<string> = new Set([
  '0000', '1111', '1234', '4321', '2580', '0852', '12345', '123456', '654321', '000000',
  '111111', '123123', '121212', '112233', '159753', '357951',
]);

export function isCommonPin(pin: string): boolean {
  const clean = (pin || '').trim();
  if (COMMON_PINS.has(clean)) return true;
  if (!/^[0-9]+$/.test(clean) || clean.length === 0) return false;
  const digits = clean.split('').map(Number);
  if (digits.every((d) => d === digits[0])) return true;
  const asc = digits.slice(1).every((d, i) => d === digits[i] + 1);
  const desc = digits.slice(1).every((d, i) => d === digits[i] - 1);
  return asc || desc;
}

/**
 * Hash a plain PIN into a fresh device-local `v1$local_salt$hash` format.
 * The `local_` prefix in the salt marks that this credential was minted/rotated
 * on this device and does not require forced migration/rotation.
 */
export function hashDeviceLocalPin(pin: string): string {
  return hashPin(pin, 'local_' + generateRandomSalt(12));
}

/**
 * Whether a stored credential predates the Argon2id era and must rotate.
 * True for legacy `v1$` fast hashes (unless already re-secreted locally with
 * 'local_' salt prefix) AND for anything that is not a modern `v2$` envelope
 * (plaintext, empty, unknown) — fail closed toward rotation.
 * Phase 4.5: replicated shops must rotate manager PINs (old synced hashes
 * are treated as exposed).
 */
export function needsPinRotation(storedHashOrPlain: string | undefined | null): boolean {
  const s = (storedHashOrPlain || '').trim();
  if (s.startsWith('v2$')) {
    const parts = s.split('$');
    return parts.length < 3;
  }
  if (s.startsWith('v1$')) {
    const parts = s.split('$');
    if (parts.length === 3 && parts[1].startsWith('local_')) {
      return false;
    }
    return true;
  }
  return true;
}

/**
 * Synchronous verification of a PIN against its stored `v1$` hash.
 * Fail-closed: anything that is not a verifiable v1 hash rejects — including
 * legacy plaintext (ancient installs are migrated to hashes at boot, and
 * hashes are the only PIN form that ever syncs to peer devices).
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
      if (timingSafeEqual(computed, expectedDigest)) {
        return true;
      }
      // Backward compatibility: verify against legacy sieve-corrupted SHA-256
      const legacyComputed = sieveSha256Sync(`${salt}:${cleanInput}:mobi_pos_salt_v1`);
      return timingSafeEqual(legacyComputed, expectedDigest);
    }
  }

  return false;
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

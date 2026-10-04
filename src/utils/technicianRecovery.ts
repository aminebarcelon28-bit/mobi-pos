/**
 * Technician Challenge-Response Password Recovery Engine for MobiPOS.
 *
 * Designed for commercial software deployments:
 * When a store owner forgets their Manager PIN, the register displays a unique
 * dynamic challenge code (e.g. MOBI-8F2A-W9ET).
 * The store owner calls or messages their technician/distributor.
 * The technician enters the challenge into their master licensing tool, which
 * calculates a single-use 6-digit one-time unlock code (valid for that day).
 * The store owner enters that 6-digit code on the register to immediately
 * reset and re-configure their Manager PIN.
 *
 * Security properties:
 * - 100% offline-compatible: zero internet required on the client POS.
 * - No universal backdoor: no static password (like 000000) that cashiers could exploit.
 * - Single-use & time-bound: burns upon use and rotates with UTC calendar day.
 * - Enforces brute-force lockout on repeated invalid technician codes.
 */

import { resetPinLockout, recordPinFailure } from './security';

const TECHNICIAN_MASTER_SECRET = 'MOBI-TECH-RESCUE-SECRET-v1-SECURE-KEY';
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ACTIVE_CHALLENGE_KEY = 'mobipos_active_tech_challenge';
const BURNED_NONCES_KEY = 'mobipos_burned_tech_nonces';

function getUtcDateString(offsetDays = 0): string {
  const d = new Date();
  if (offsetDays !== 0) {
    d.setUTCDate(d.getUTCDate() + offsetDays);
  }
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function randomCrockford(length = 4): string {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => CROCKFORD_ALPHABET[b % 32])
    .join('');
}

async function hmacSha256(keyStr: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return new Uint8Array(signature);
}

export async function computeChallengeChecksum(dateStr: string, nonce: string): Promise<string> {
  const h = await hmacSha256(TECHNICIAN_MASTER_SECRET, `CHALLENGE:${dateStr}:${nonce}`);
  const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const val = view.getUint32(0, false);
  let res = '';
  for (let i = 3; i >= 0; i--) {
    res += CROCKFORD_ALPHABET[(val >> (5 * i)) & 31];
  }
  return res;
}

export async function computeTechnicianOtp(dateStr: string, nonce: string): Promise<string> {
  const h = await hmacSha256(TECHNICIAN_MASTER_SECRET, `RESPONSE:${dateStr}:${nonce}`);
  const view = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const code = view.getUint32(0, false) % 1_000_000;
  return String(code).padStart(6, '0');
}

/**
 * Generate a fresh challenge string for the customer to communicate to the technician.
 * Format: MOBI-XXXX-YYYY (e.g. MOBI-8F2A-W9ET)
 */
export async function generateTechnicianChallenge(): Promise<string> {
  const nonce = randomCrockford(4);
  const dateStr = getUtcDateString(0);
  const chk = await computeChallengeChecksum(dateStr, nonce);
  const challenge = `MOBI-${nonce}-${chk}`;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(ACTIVE_CHALLENGE_KEY, challenge);
    }
  } catch {
    // Ignore storage restrictions
  }
  return challenge;
}

export function getActiveChallenge(): string | null {
  try {
    if (typeof sessionStorage !== 'undefined') {
      return sessionStorage.getItem(ACTIVE_CHALLENGE_KEY);
    }
  } catch {
    // Ignore
  }
  return null;
}

function isNonceBurned(nonce: string): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(BURNED_NONCES_KEY);
      if (raw) {
        const list = JSON.parse(raw) as string[];
        return list.includes(nonce);
      }
    }
  } catch {
    // Ignore
  }
  return false;
}

function burnNonce(nonce: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(BURNED_NONCES_KEY);
      const list = raw ? (JSON.parse(raw) as string[]) : [];
      if (!list.includes(nonce)) {
        list.push(nonce);
        // Keep the last 50 burned nonces
        const trimmed = list.slice(-50);
        localStorage.setItem(BURNED_NONCES_KEY, JSON.stringify(trimmed));
      }
    }
  } catch {
    // Ignore
  }
}

export interface VerificationResult {
  ok: boolean;
  error?: string;
}

/**
 * Verifies a 6-digit recovery OTP provided by the technician.
 * Supports UTC day window with +/- 1 day leeway to eliminate timezone mismatch.
 */
export async function verifyTechnicianRecoveryCode(
  challenge: string,
  enteredOtp: string
): Promise<VerificationResult> {
  const cleanChallenge = challenge.trim().toUpperCase();
  const cleanOtp = enteredOtp.trim();

  if (cleanOtp.length !== 6 || !/^[0-9]{6}$/.test(cleanOtp)) {
    return { ok: false, error: 'Le code technicien doit comporter 6 chiffres.' };
  }

  const parts = cleanChallenge.split('-');
  const nonce = parts.length === 3 ? parts[1] : parts.length === 2 ? parts[0] : '';
  const providedChk = parts.length === 3 ? parts[2] : parts.length === 2 ? parts[1] : '';

  if (!nonce || nonce.length !== 4) {
    return { ok: false, error: 'Format du code de défi invalide.' };
  }

  if (isNonceBurned(nonce)) {
    return { ok: false, error: 'Ce code de défi a déjà été utilisé. Générez-en un nouveau.' };
  }

  // Check today (0), yesterday (-1), and tomorrow (+1) to tolerate timezone offsets
  for (const offset of [0, -1, 1]) {
    const d = getUtcDateString(offset);
    const expectedChk = await computeChallengeChecksum(d, nonce);
    if (expectedChk === providedChk) {
      const expectedOtp = await computeTechnicianOtp(d, nonce);
      if (expectedOtp === cleanOtp) {
        // Code is authentic and valid!
        burnNonce(nonce);
        try {
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.removeItem(ACTIVE_CHALLENGE_KEY);
          }
        } catch {
          // Ignore
        }
        resetPinLockout();
        return { ok: true };
      }
    }
  }

  // Record failure to lock out attackers attempting brute force
  recordPinFailure();
  return { ok: false, error: 'Code de déverrouillage technicien incorrect ou expiré.' };
}


/**
 * Technician recovery lane — SECURITY regression (2026-11-03).
 *
 * The recovery secret used to be a constant in the source, which made every
 * terminal's manager-PIN recovery code computable by anyone with the repository.
 * The lane now fails closed until an install-time secret is provisioned.
 *
 * Run: npm run test:technician-recovery
 */
import {
  computeTechnicianOtp,
  generateTechnicianChallenge,
  getActiveChallenge,
  provisionTechnicianRecoverySecret,
  technicianRecoveryConfigured,
  verifyTechnicianRecoveryCode,
} from '../src/utils/technicianRecovery';

// Node has no Web Storage; the module reads it at call time, so a minimal
// in-memory shim is enough to exercise the burn list and the session cache.
const memStorage = (): Storage => {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } as Storage;
};
(globalThis as unknown as { localStorage: Storage }).localStorage = memStorage();
(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = memStorage();

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

const nonceOf = (challenge: string): string => challenge.split('-')[1] ?? '';
const utcDay = (offset = 0): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};

// ── 1. unprovisioned: no codes, fail closed ────────────────────────────────
check('no secret in source: the module does not ship a working key', !technicianRecoveryConfigured());
const noChallenge = await generateTechnicianChallenge();
check('unprovisioned: challenge generation is disabled', noChallenge === '', JSON.stringify(noChallenge));
const refused = await verifyTechnicianRecoveryCode('MOBI-ABCD-EFGH', '123456');
check(
  'unprovisioned: verification refuses with an explicit reason',
  !refused.ok && /non configur/i.test(refused.error ?? ''),
  JSON.stringify(refused),
);

// ── 2. provisioned: the lane works end to end ─────────────────────────────
provisionTechnicianRecoverySecret('install-secret-for-tests-0123456789');
check('provided: the lane reports configured', technicianRecoveryConfigured());
const challenge = await generateTechnicianChallenge();
check('provided: a challenge is minted and remembered', /^MOBI-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(challenge) && getActiveChallenge() === challenge, challenge);

const nonce = nonceOf(challenge);
// The technician tool computes the OTP for the day window the device accepts.
const otp = await computeTechnicianOtp(utcDay(0), nonce);
const good = await verifyTechnicianRecoveryCode(challenge, otp);
check('provided: the correct OTP unlocks the recovery step', good.ok, JSON.stringify(good));

// ── 3. single use ─────────────────────────────────────────────────────────
const again = await verifyTechnicianRecoveryCode(challenge, otp);
check('replay: the same code is burned', !again.ok && /déjà|utilisé/i.test(again.error ?? ''), JSON.stringify(again));

// ── 4. secret binding: a code from another install's tool does not verify ──
// Provision with secret A, mint a challenge and its OTP, then re-provision with
// secret B (a different install) and present A's OTP: the device must refuse it.
const SECRET_A = 'install-secret-A-0123456789abcdef';
const SECRET_B = 'install-secret-B-fedcba9876543210';
provisionTechnicianRecoverySecret(SECRET_A);
const cA = await generateTechnicianChallenge();
const otpA = await computeTechnicianOtp(utcDay(0), nonceOf(cA));
provisionTechnicianRecoverySecret(SECRET_B);
const foreign = await verifyTechnicianRecoveryCode(cA, otpA);
check('secret binding: another install\'s OTP is rejected', !foreign.ok, JSON.stringify(foreign));
// control: the same device's own code still works with its own secret
const cB = await generateTechnicianChallenge();
const otpB = await computeTechnicianOtp(utcDay(0), nonceOf(cB));
const own = await verifyTechnicianRecoveryCode(cB, otpB);
check('secret binding control: the matching OTP still verifies', own.ok, JSON.stringify(own));

console.log(`\nTECHNICIAN RECOVERY: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

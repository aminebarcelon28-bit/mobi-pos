/**
 * MobiPOS Licensing Cryptographic Root of Trust (Ed25519 Public Keys)
 * Used by POS terminals (Desktop & Mobile) for zero-dependency offline signature verification.
 * Private keys are held strictly within Cloudflare Worker secrets.
 *
 * Key rotation (SEC-ROT-02, trial plan §5.6):
 * - k1 = legacy root. Its private half was publicly burned in git history, so it is
 *   STORED-TOKEN-ONLY: it keeps the 6 pre-rotation lifetime customers booting, but a
 *   fresh activation must never accept a k1-signed token (forgery is trivial for k1).
 * - k2 = current root. The only key allowed to create a licence (activation path).
 *   Its private half exists ONLY as a Cloudflare Worker secret (+ one gitignored
 *   local vendor file for the offline admin tooling). Never commit it anywhere.
 */

export const ED25519_PUBLIC_KEY_K1_B64URL = 'Kw8ScZAHScD0IOm0Lx2bSYab-OPHkjdWFDbMR4j6Hdc';
export const ED25519_PUBLIC_KEY_K2_B64URL = 'h8uQ-7zm_yApFXmdGKj5QQnRNu39QkMBKxEje4aQGxU';

/** Legacy alias kept for existing imports; equals k1 (stored-token-only). */
export const ED25519_PUBLIC_KEY_RAW_B64URL = ED25519_PUBLIC_KEY_K1_B64URL;

export type LicenseKeyKid = 'k1' | 'k2';

export const ED25519_PUBLIC_KEYS_BY_KID: Record<LicenseKeyKid, string> = {
  k1: ED25519_PUBLIC_KEY_K1_B64URL,
  k2: ED25519_PUBLIC_KEY_K2_B64URL,
};

export const ED25519_PUBLIC_KEY_JWK = {
  key_ops: ['verify'],
  ext: true,
  alg: 'Ed25519',
  crv: 'Ed25519',
  x: 'Kw8ScZAHScD0IOm0Lx2bSYab-OPHkjdWFDbMR4j6Hdc',
  kty: 'OKP',
} as const;


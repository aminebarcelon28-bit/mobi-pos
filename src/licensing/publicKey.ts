/**
 * MobiPOS Licensing Cryptographic Root of Trust (Ed25519 Public Key)
 * Used by POS terminals (Desktop & Mobile) for zero-dependency offline signature verification.
 * Private key is held strictly within Cloudflare Worker secrets.
 */

export const ED25519_PUBLIC_KEY_RAW_B64URL = 'Kw8ScZAHScD0IOm0Lx2bSYab-OPHkjdWFDbMR4j6Hdc';

export const ED25519_PUBLIC_KEY_JWK = {
  key_ops: ['verify'],
  ext: true,
  alg: 'Ed25519',
  crv: 'Ed25519',
  x: 'Kw8ScZAHScD0IOm0Lx2bSYab-OPHkjdWFDbMR4j6Hdc',
  kty: 'OKP',
} as const;


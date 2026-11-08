/**
 * Cryptographic helpers for mobi-licensing worker.
 * Pure WebCrypto (SubtleCrypto) — zero external npm dependencies.
 * Conforms to RFC 7515 (JWS), RFC 8037 (EdDSA), and NIST SP 800-38D (AES-GCM).
 */

// Base64 & Base64URL conversions
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlToBytes(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function utf8ToBase64Url(str: string): string {
  return bytesToBase64Url(new TextEncoder().encode(str));
}

export function base64UrlToUtf8(base64url: string): string {
  return new TextDecoder().decode(base64UrlToBytes(base64url));
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binStr = '';
  for (let i = 0; i < bytes.length; i++) {
    binStr += String.fromCharCode(bytes[i]);
  }
  return btoa(binStr);
}

// ---------------------------------------------------------------------------
// Signing-key rotation (SEC-ROT-02, trial plan §5.6)
// ---------------------------------------------------------------------------
// k1's private half is publicly burned in git history; k2 is the only key that
// may create a licence. K1 SUNSET (M2, K-6/RT-1b): k2 is now UNCONDITIONAL
// whenever the k2 secret is configured — 1.8.0 is the first licensed release,
// so no deployed client needs k1, and every k1 token in the wild came from
// the leaked-key era. The version gate is retired; FIRST_K2_VERSION is kept
// only as a historical marker for the migration tooling.
export const FIRST_K2_VERSION = '1.8.0';

export function semverGte(version: string, target: string): boolean {
  const parse = (v: string) =>
    v
      .split('.')
      .map((p) => parseInt(p, 10) || 0)
      .slice(0, 3);
  const a = parse(version);
  const b = parse(target);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export interface SigningKeyEnv {
  LICENSE_ED25519_PRIVATE_JWK: string;
  LICENSE_ED25519_PRIVATE_JWK_K2?: string;
}

export function pickSigningKey(env: SigningKeyEnv): { jwk: string; kid: 'k1' | 'k2' } {
  // k2 whenever it is configured — no client-compat fallback. k1 only when
  // k2 is MISSING, which is a deployment misconfiguration, not a mode.
  if (env.LICENSE_ED25519_PRIVATE_JWK_K2) {
    return { jwk: env.LICENSE_ED25519_PRIVATE_JWK_K2, kid: 'k2' };
  }
  return { jwk: env.LICENSE_ED25519_PRIVATE_JWK, kid: 'k1' };
}

/**
 * Constant-time string equality for secret comparison (admin bearer, etc.).
 * A plain `===` leaks prefix-match length through timing; hashing both sides
 * to fixed-length digests and XOR-accumulating over the FULL digest removes
 * both the length leak and the early-exit leak. Still async because
 * crypto.subtle is — call sites already are.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const da = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a));
  const dbb = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b));
  const va = new Uint8Array(da);
  const vb = new Uint8Array(dbb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) {
    diff |= va[i] ^ vb[i];
  }
  return diff === 0;
}

// HMAC-SHA256 blind indexing and IP pseudonymization
export async function hashHmac(value: string, pepper: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// AES-256-GCM Column Encryption for client Turso database credentials
export async function getMasterKey(secretB64: string): Promise<CryptoKey> {
  const rawKey = base64ToUint8Array(secretB64.trim());
  if (rawKey.byteLength !== 32) {
    throw new Error('MASTER_ENCRYPTION_KEY must be exactly 32 bytes (256 bits) Base64 encoded.');
  }
  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts sensitive credentials using AES-GCM 256-bit with fresh 12-byte IV.
 * Returns versioned envelope: "v1:<base64(12B_iv + ciphertext + 16B_tag)>"
 */
export async function encryptTursoToken(plaintext: string, secretB64: string): Promise<string> {
  const key = await getMasterKey(secretB64);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit unique IV
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    encoded
  );

  const cipherBytes = new Uint8Array(cipherBuffer);
  const packed = new Uint8Array(iv.byteLength + cipherBytes.byteLength);
  packed.set(iv, 0);
  packed.set(cipherBytes, iv.byteLength);

  return `v1:${uint8ArrayToBase64(packed)}`;
}

/**
 * Decrypts AES-GCM ciphertext. Throws on tampering or invalid key.
 */
export async function decryptTursoToken(packedString: string, secretB64: string): Promise<string> {
  if (!packedString.startsWith('v1:')) {
    throw new Error('UNSUPPORTED_CIPHER_VERSION: Expected "v1:" prefix');
  }

  const key = await getMasterKey(secretB64);
  const packed = base64ToUint8Array(packedString.slice(3));

  if (packed.byteLength < 28) {
    throw new Error('INVALID_CIPHERTEXT: Payload too short (< 28 bytes)');
  }

  const iv = packed.subarray(0, 12);
  const ciphertextWithTag = packed.subarray(12);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    ciphertextWithTag
  );

  return new TextDecoder().decode(plainBuffer);
}

// Ed25519 (EdDSA) JWS / JWT Token Generation
export interface LicenseTokenClaims {
  iss: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  lic_key: string;
  lic_type: '24H' | '90D' | 'LIFETIME' | 'TRIAL' | 'CUSTOM';
  device_id: string;
  device_type: 'desktop' | 'mobile';
  max_desktops: number;
  max_mobiles: number;
  grace_days: number;
  nonce?: string;
  server_ts: number;
}

/**
 * Signs a license claim set with the vendor Ed25519 private key.
 * Produces standard Compact JWS: header.payload.signature
 *
 * `kid` identifies which root key signed (SEC-ROT-02): 'k1' legacy,
 * 'k2' current. Verifiers resolve the pinned public key from it and
 * reject unknown kids (fail closed).
 */
export async function signLicenseJwt(
  payload: LicenseTokenClaims,
  privateKeyJwkString: string,
  kid?: 'k1' | 'k2'
): Promise<string> {
  const jwk = JSON.parse(privateKeyJwkString);
  if (jwk.alg) {
    delete jwk.alg;
  }
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'Ed25519' },
    false,
    ['sign']
  );

  const header: Record<string, string> = { alg: 'EdDSA', typ: 'JWT' };
  if (kid) {
    header.kid = kid;
  }
  const headerB64 = utf8ToBase64Url(JSON.stringify(header));
  const payloadB64 = utf8ToBase64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sigBytes = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = bytesToBase64Url(new Uint8Array(sigBytes));
  return `${signingInput}.${sigB64}`;
}

// ---------------------------------------------------------------------------
// Canonical license signing (remote admin path)
// ---------------------------------------------------------------------------

/** Crockford-style alphabet used for human-transcribable license keys. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0) {
    throw new Error('Invalid hex string for key material.');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Generates a vendor license key: MOBI-<TAG>-XXXX-XXXX-XXXX
 *
 * Uses crypto.getRandomValues rather than Math.random; the key space must not
 * be predictable.
 */
export function generateLicenseKey(formula: string): string {
  const tagMap: Record<string, string> = {
    LIFETIME: 'LIFE',
    TRIAL_30D: 'T30D',
    TRIAL_90D: 'T90D',
    DEMO: 'DEMO',
    ANNUAL: '1Y',
  };
  const tag = tagMap[formula.toUpperCase()] || 'CUST';

  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let body = '';
  for (const byte of buf) {
    body += CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length];
  }
  return `MOBI-${tag}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** Exports a public key as JWK, for publishing alongside signed licenses. */
/**
 * RT-3 (red-team): verifies a licence JWS against the worker's own signing
 * keys, so a device can PROVE possession of its activation token when calling
 * privileged self-service routes (deactivate). The private JWK carries the
 * public half (`x`), so verification needs no extra secret; `d` is stripped
 * before import so the key can never be re-used for signing here.
 *
 * Accepts both root-of-trust keys (k1 legacy + k2 current): stored legacy
 * tokens must keep working until the M2 sunset migration completes.
 */
export async function verifyLicenseJwt(
  token: string,
  privateJwkStrings: (string | undefined)[]
): Promise<{ valid: boolean; payload?: Record<string, unknown>; error?: string }> {
  try {
    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'Jeton manquant.' };
    }
    const parts = token.trim().split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Structure de jeton invalide.' };
    }
    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(base64UrlToUtf8(headerB64));
    if (header.alg !== 'EdDSA') {
      return { valid: false, error: 'Algorithme non supporté.' };
    }
    const kid = header.kid === 'k2' ? 'k2' : 'k1';
    const jwkString = kid === 'k2' ? privateJwkStrings[1] : privateJwkStrings[0];
    if (!jwkString) {
      return { valid: false, error: 'Clé de vérification indisponible.' };
    }
    const full = JSON.parse(jwkString);
    const publicJwk: Record<string, string> = { kty: full.kty, crv: full.crv, x: full.x };
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicJwk as unknown as JsonWebKey,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      base64UrlToBytes(sigB64) as unknown as BufferSource,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
    if (!ok) {
      return { valid: false, error: 'Signature invalide.' };
    }
    const payload = JSON.parse(base64UrlToUtf8(payloadB64)) as Record<string, unknown>;
    return { valid: true, payload };
  } catch (err) {
    return { valid: false, error: `Jeton illisible: ${String(err).slice(0, 80)}` };
  }
}

export async function exportPublicJwk(jwkString: string): Promise<string> {
  const jwk = JSON.parse(jwkString);
  if (jwk.alg) delete jwk.alg;
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'Ed25519' },
    true,
    ['sign']
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', privateKey);
  return JSON.stringify(publicJwk);
}

/**
 * Signs a canonical license description with the vendor Ed25519 key.
 *
 * The canonical form joins fixed fields with '|' so that no field value can
 * inject a delimiter and shift the meaning of a later field. HWIDs are sorted
 * before joining so binding order does not change the signature.
 *
 * @param privateKeyJwkString Ed25519 private key JWK
 * @param canonicalData Pre-built canonical string from the caller
 */
export async function signCanonicalLicense(
  privateKeyJwkString: string,
  canonicalData: string
): Promise<string> {
  const jwk = JSON.parse(privateKeyJwkString);
  if (jwk.alg) delete jwk.alg;
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'Ed25519' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(canonicalData)
  );
  return uint8ArrayToHex(new Uint8Array(sig));
}

/** Verifies a hex signature against a canonical string. Used by tests. */
export async function verifyCanonicalLicense(
  publicJwk: JsonWebKey,
  canonicalData: string,
  signatureHex: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'Ed25519' },
    false,
    ['verify']
  );
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    hexToUint8Array(signatureHex),
    new TextEncoder().encode(canonicalData)
  );
}

export { hexToUint8Array, uint8ArrayToHex };



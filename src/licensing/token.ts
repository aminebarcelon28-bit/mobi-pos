/**
 * Zero-Dependency WebCrypto Ed25519 (EdDSA) JWS / JWT Verification Engine
 * Runs natively in Chromium, WebKit, Node 18+, and Tauri WebViews.
 * Conforms to RFC 7515 (JWS) and RFC 8037 (EdDSA).
 */

import {
  ED25519_PUBLIC_KEYS_BY_KID,
  type LicenseKeyKid,
} from './publicKey.ts';

export interface LicenseTokenPayload {
  iss: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number; // 0 or unix seconds
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

export function base64UrlToUtf8(base64url: string): string {
  return new TextDecoder().decode(base64UrlToBytes(base64url));
}

/**
 * Verification context (SEC-ROT-02 continuity rule, trial plan §5.6):
 * - 'boot'       — a token already stored on this device (OS keychain). Accepts
 *                  k1 (legacy tokens keep the pre-rotation customers booting) and k2.
 * - 'activation' — a token just received for a NEW activation (server response or
 *                  pasted offline token). Accepts k2 ONLY: k1's private half is
 *                  publicly burned, so a k1 token must never be able to create a
 *                  licence on a fresh install.
 * An explicit `publicKeyB64Url` (tests) bypasses kid gating entirely.
 */
export type VerifyMode = 'boot' | 'activation';

export interface VerifyOptions {
  /** Explicit key override (tests only). Skips kid resolution and gating. */
  publicKeyB64Url?: string;
  /** Defaults to 'boot'. */
  mode?: VerifyMode;
}

function resolveKidHeader(header: { alg?: string; typ?: string; kid?: string }):
  | { ok: true; kid: LicenseKeyKid | null }
  | { ok: false; error: string } {
  if (header.kid === undefined || header.kid === null) {
    // Legacy tokens minted before the kid header existed are k1 by definition.
    return { ok: true, kid: 'k1' };
  }
  if (header.kid === 'k1' || header.kid === 'k2') {
    return { ok: true, kid: header.kid };
  }
  return { ok: false, error: `Clé de signature inconnue (kid: ${String(header.kid).slice(0, 16)}).` };
}

/**
 * Result of licence-token verification. `kid` reports which root-of-trust key
 * verified the token ('k1' legacy / 'k2' current) so callers can apply
 * key-age policy (e.g. RT-1b: k1 tokens are never trusted offline).
 */
export interface VerifyLicenseResult {
  valid: boolean;
  payload?: LicenseTokenPayload;
  error?: string;
  /** Resolved signing-key id; null only for legacy tokens without a kid header. */
  kid?: LicenseKeyKid | null;
}

/**
 * Cryptographically verifies an Ed25519 license token against the pinned
 * root-of-trust keys, selecting the key by the token header's `kid`.
 */
export async function verifyLicenseToken(
  token: string,
  opts: VerifyOptions = {}
): Promise<VerifyLicenseResult> {
  try {
    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'Jeton de licence vide ou manquant.' };
    }

    const parts = token.trim().split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Structure du jeton invalide (3 parties requises).' };
    }

    const [headerB64, payloadB64, sigB64] = parts;

    // 1. Verify Header
    let header: { alg?: string; typ?: string };
    try {
      header = JSON.parse(base64UrlToUtf8(headerB64));
    } catch {
      return { valid: false, error: 'En-tête de jeton illisible.' };
    }

    if (header.alg !== 'EdDSA') {
      return { valid: false, error: `Algorithme non supporté: ${header.alg}` };
    }

    // 1b. Resolve the signing key by kid and enforce the continuity rule.
    const kidRes = resolveKidHeader(header);
    if (!kidRes.ok) {
      return { valid: false, error: kidRes.error };
    }
    const kid = kidRes.kid;
    if (!opts.publicKeyB64Url) {
      const allowed: LicenseKeyKid[] = opts.mode === 'activation' ? ['k2'] : ['k1', 'k2'];
      if (kid === null || !allowed.includes(kid)) {
        return {
          valid: false,
          error:
            opts.mode === 'activation'
              ? 'Jeton refusé: seule la clé de signature actuelle (k2) peut créer une licence.'
              : 'Jeton refusé: clé de signature non reconnue pour ce contexte.',
        };
      }
    }
    const rawPublicKeyB64Url = opts.publicKeyB64Url ?? ED25519_PUBLIC_KEYS_BY_KID[kid ?? 'k1'];

    // 2. Import Ed25519 Public Key (32 bytes raw)
    const pubKeyBytes = base64UrlToBytes(rawPublicKeyB64Url);
    if (pubKeyBytes.byteLength !== 32) {
      return { valid: false, error: 'Longueur de clé publique Ed25519 invalide (32 octets attendus).' };
    }

    const publicKey = await crypto.subtle.importKey(
      'raw',
      pubKeyBytes as unknown as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );

    // 3. Cryptographic Signature Verification
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlToBytes(sigB64);
    if (signature.byteLength !== 64) {
      return { valid: false, error: 'Longueur de signature Ed25519 invalide (64 octets attendus).' };
    }

    const isSigValid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      signature as unknown as BufferSource,
      signingInput
    );

    if (!isSigValid) {
      return { valid: false, error: 'Signature cryptographique invalide (jeton altéré ou falsifié).' };
    }

    const payload = JSON.parse(base64UrlToUtf8(payloadB64)) as LicenseTokenPayload;

    // 3b. SEC-ROT-02 hardening (red-team finding RT-1): a k1-signed token with
    // an empty or wildcard device binding is a universal skeleton key — k1's
    // private half is public, so anyone could mint one token that unlocks
    // every install at boot. Legacy (pre-rotation) tokens were all issued
    // device-bound by the server, so rejecting unbound k1 tokens breaks no
    // legitimate customer. k2 tokens may keep the wildcard (only the holder
    // of the k2 private key — the vendor — can mint them).
    if (kid === 'k1' && (!payload.device_id || payload.device_id === '*')) {
      return {
        valid: false,
        error: 'Jeton refusé: un jeton de la clé historique doit être lié à un appareil.',
      };
    }

    // 4. Temporal validity (signature alone does not expire a token):
    // future-dated tokens are rejected, expired ones are rejected. A small
    // leeway absorbs clock skew between issuer and device (mirrors the
    // server-side 60s nbf tolerance).
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const leewaySec = 120;
      const nbf = typeof payload.nbf === 'number' ? payload.nbf : undefined;
      const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
      if (nbf !== undefined && nowSec + leewaySec < nbf) {
        return { valid: false, error: 'Jeton de licence pas encore valide (horloge appareil).' };
      }
      if (exp !== undefined && exp !== 0 && nowSec - leewaySec > exp) {
        return { valid: false, error: 'Jeton de licence expiré.' };
      }
    } catch {
      return { valid: false, error: 'Dates du jeton illisibles.' };
    }

    return { valid: true, payload, kid };
  } catch (err: unknown) {
    return { valid: false, error: (err as Error).message };
  }
}

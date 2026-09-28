/**
 * Zero-Dependency WebCrypto Ed25519 (EdDSA) JWS / JWT Verification Engine
 * Runs natively in Chromium, WebKit, Node 18+, and Tauri WebViews.
 * Conforms to RFC 7515 (JWS) and RFC 8037 (EdDSA).
 */

import { ED25519_PUBLIC_KEY_RAW_B64URL } from './publicKey.ts';

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
 * Cryptographically verifies an Ed25519 license token against the embedded root public key.
 */
export async function verifyLicenseToken(
  token: string,
  rawPublicKeyB64Url: string = ED25519_PUBLIC_KEY_RAW_B64URL
): Promise<{ valid: boolean; payload?: LicenseTokenPayload; error?: string }> {
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

    return { valid: true, payload };
  } catch (err: unknown) {
    return { valid: false, error: (err as Error).message };
  }
}

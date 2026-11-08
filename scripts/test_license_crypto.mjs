#!/usr/bin/env node
/**
 * Test Suite: WebCrypto Ed25519 Token Signing & Verification
 *
 * SEC-ROT-02: the production private key used to be embedded here — that was
 * the critical leak (public repo = anyone could mint lifetime licences). This
 * suite now generates a THROWAWAY keypair per run and never references any
 * production private material. The production roots of trust live pinned
 * (public halves only) in src/licensing/publicKey.ts.
 */

import crypto from 'node:crypto';
import {
  ED25519_PUBLIC_KEY_K1_B64URL,
  ED25519_PUBLIC_KEY_K2_B64URL,
} from '../src/licensing/publicKey.ts';
import { verifyLicenseToken } from '../src/licensing/token.ts';

// Throwaway signing key for this run only — never a production key.
const { publicKey: runPublicKey, privateKey: runPrivateKey } =
  crypto.generateKeyPairSync('ed25519');
const RUN_PUBLIC_B64URL = Buffer.from(runPublicKey.export({ format: 'jwk' }).x, 'base64url')
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
const RUN_PRIVATE_JWK = {
  ...runPrivateKey.export({ format: 'jwk' }),
  key_ops: ['sign'],
  ext: true,
  alg: 'Ed25519',
  crv: 'Ed25519',
  kty: 'OKP',
};

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function utf8ToBase64Url(str) {
  return bytesToBase64Url(Buffer.from(str, 'utf8'));
}

async function signToken(payload, privateJwk, kid) {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'Ed25519' },
    false,
    ['sign']
  );

  const header = { alg: 'EdDSA', typ: 'JWT' };
  if (kid) header.kid = kid;
  const headerB64 = utf8ToBase64Url(JSON.stringify(header));
  const payloadB64 = utf8ToBase64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sigBytes = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    Buffer.from(signingInput, 'utf8')
  );

  const sigB64 = bytesToBase64Url(new Uint8Array(sigBytes));
  return `${signingInput}.${sigB64}`;
}

async function runTests() {
  console.log('========================================================================');
  console.log('⚡ MOBIPOS — CRYPTOGRAPHIC LICENSING SUITE (Ed25519, kid-aware)');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      failed++;
    }
  }

  const validPayload = {
    iss: 'https://mobi-licensing.workers.dev',
    sub: 'lic_test_123',
    iat: Math.floor(Date.now() / 1000),
    nbf: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 86400,
    jti: 'tok_uuid_123',
    lic_key: 'MOBILIFE4HNP85HG',
    lic_type: 'LIFETIME',
    device_id: 'a1b2c3d4e5f6',
    device_type: 'desktop',
    max_desktops: 2,
    max_mobiles: 2,
    grace_days: 7,
    nonce: 'nonce_abc_123',
    server_ts: Math.floor(Date.now() / 1000),
  };

  // Test 0: pinned roots decode to 32 bytes (public halves only in this repo)
  console.log('[TEST 0] Pinned roots of trust are public halves only:');
  for (const [name, b64] of [
    ['k1', ED25519_PUBLIC_KEY_K1_B64URL],
    ['k2', ED25519_PUBLIC_KEY_K2_B64URL],
  ]) {
    const raw = Buffer.from(b64, 'base64url');
    assert(raw.length === 32, `Pinned ${name} public key decodes to 32 bytes`);
  }

  // Test 1: Valid Token Verification (explicit test key — bypasses kid gating)
  console.log('\n[TEST 1] Legitimate Ed25519 Token Signing & Verification:');
  const validToken = await signToken(validPayload, RUN_PRIVATE_JWK);
  const res1 = await verifyLicenseToken(validToken, { publicKeyB64Url: RUN_PUBLIC_B64URL });
  assert(res1.valid === true, 'Valid token passes cryptographic verification');
  assert(res1.payload?.lic_key === 'MOBILIFE4HNP85HG', 'Decoded license key matches');
  assert(res1.payload?.device_id === 'a1b2c3d4e5f6', 'Decoded device ID matches');

  // Test 2: Tampered Payload
  console.log('\n[TEST 2] Tampered Claims Detection (Anti-Piracy):');
  const parts = validToken.split('.');
  const tamperedClaims = { ...validPayload, max_desktops: 99 };
  const tamperedPayloadB64 = utf8ToBase64Url(JSON.stringify(tamperedClaims));
  const tamperedToken = `${parts[0]}.${tamperedPayloadB64}.${parts[2]}`;
  const res2 = await verifyLicenseToken(tamperedToken, { publicKeyB64Url: RUN_PUBLIC_B64URL });
  assert(res2.valid === false, 'Tampered token is rejected');
  assert(res2.error?.includes('invalide'), 'Error cites signature invalidity');

  // Test 3: Corrupted Signature
  console.log('\n[TEST 3] Bit-Flipped Signature Detection:');
  const flippedSig = parts[2].slice(0, -4) + (parts[2].endsWith('AAAA') ? 'BBBB' : 'AAAA');
  const corruptedToken = `${parts[0]}.${parts[1]}.${flippedSig}`;
  const res3 = await verifyLicenseToken(corruptedToken, { publicKeyB64Url: RUN_PUBLIC_B64URL });
  assert(res3.valid === false, 'Corrupted signature is rejected');

  // Test 4: Malformed Token Structures
  console.log('\n[TEST 4] Malformed Token Handling:');
  const res4a = await verifyLicenseToken('invalid.token', { publicKeyB64Url: RUN_PUBLIC_B64URL });
  assert(res4a.valid === false, 'Two-part token rejected');

  const res4b = await verifyLicenseToken('', { publicKeyB64Url: RUN_PUBLIC_B64URL });
  assert(res4b.valid === false, 'Empty token rejected');

  // Test 5: kid resolution against the PINNED roots (no explicit key override)
  console.log('\n[TEST 5] kid resolution & continuity rule (SEC-ROT-02):');
  const k2Signed = await signToken(validPayload, RUN_PRIVATE_JWK, 'k2');
  // The run key is NOT a pinned root, so signature verification must fail even
  // with a valid kid — proving the kid path uses pinned keys, not the payload.
  const res5a = await verifyLicenseToken(k2Signed);
  assert(res5a.valid === false, 'Unpinned key with kid=k2 is rejected (pinned roots only)');

  const unknownKidToken = await signToken(validPayload, RUN_PRIVATE_JWK, 'k9');
  const res5b = await verifyLicenseToken(unknownKidToken);
  assert(res5b.valid === false, 'Unknown kid is rejected (fail closed)');

  const legacyNoKid = await signToken(validPayload, RUN_PRIVATE_JWK);
  const res5c = await verifyLicenseToken(legacyNoKid);
  assert(res5c.valid === false, 'kid-less token maps to k1 and rejects an unpinned signer');

  // Test 6: activation vs boot semantics (the continuity rule itself)
  console.log('\n[TEST 6] Continuity rule: k1 = stored-token-only, k2 = activation-only:');
  // Simulate the pinned-k2 signer: sign with the RUN key but verify in a mode
  // where kid gating is exercised BEFORE signature verification.
  const activationAttempt = await verifyLicenseToken(legacyNoKid, { mode: 'activation' });
  assert(
    activationAttempt.valid === false &&
      activationAttempt.error?.includes('k2'),
    'kid-less (legacy k1) token is refused at activation with the k2-only message'
  );

  const k1KidToken = await signToken(validPayload, RUN_PRIVATE_JWK, 'k1');
  const activationAttempt2 = await verifyLicenseToken(k1KidToken, { mode: 'activation' });
  assert(
    activationAttempt2.valid === false && activationAttempt2.error?.includes('k2'),
    'kid=k1 token is refused at activation (forgery-immune path)'
  );

  const bootAttempt = await verifyLicenseToken(k1KidToken);
  assert(
    bootAttempt.valid === false && !bootAttempt.error?.includes('k2 seule'),
    'kid=k1 token reaches signature verification at boot (legacy customers keep booting)'
  );

  const activationK2 = await verifyLicenseToken(k2Signed, { mode: 'activation' });
  assert(
    activationK2.valid === false && !activationK2.error?.includes('seule la clé'),
    'kid=k2 token passes kid gating at activation (fails only on the unpinned signature)'
  );

  // Test 7: RT-1 hardening — k1 + unbound device = universal skeleton key
  console.log('\n[TEST 7] k1 unbound-device rejection (red-team finding RT-1):');
  const wildPayload = { ...validPayload, device_id: '*', exp: 0 };
  const k1Wild = await signToken(wildPayload, RUN_PRIVATE_JWK, 'k1');
  const v7a = await verifyLicenseToken(k1Wild, { publicKeyB64Url: RUN_PUBLIC_B64URL });
  assert(
    v7a.valid === false && v7a.error?.includes('historique'),
    'k1 + wildcard device binding rejected at boot (skeleton key killed)'
  );

  const k1Empty = await signToken({ ...wildPayload, device_id: '' }, RUN_PRIVATE_JWK, 'k1');
  const v7b = await verifyLicenseToken(k1Empty, { publicKeyB64Url: RUN_PUBLIC_B64URL });
  assert(v7b.valid === false, 'k1 + empty device binding rejected at boot');

  const k1Bound = await signToken(
    { ...validPayload, device_id: 'realdevicehash123', exp: 0 },
    RUN_PRIVATE_JWK,
    'k1'
  );
  const v7c = await verifyLicenseToken(k1Bound, { publicKeyB64Url: RUN_PUBLIC_B64URL });
  assert(v7c.valid === true, 'k1 + REAL device binding still boots (legacy customers intact)');

  const k2Wild = await signToken(wildPayload, RUN_PRIVATE_JWK, 'k2');
  const v7d = await verifyLicenseToken(k2Wild, { publicKeyB64Url: RUN_PUBLIC_B64URL });
  assert(v7d.valid === true, 'k2 + wildcard still allowed (vendor-only key)');

  console.log('\n========================================================================');
  console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(console.error);

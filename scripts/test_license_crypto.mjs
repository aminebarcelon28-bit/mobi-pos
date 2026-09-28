#!/usr/bin/env node
/**
 * Test Suite: WebCrypto Ed25519 Token Signing & Verification
 */

import crypto from 'node:crypto';
import { ED25519_PUBLIC_KEY_RAW_B64URL } from '../src/licensing/publicKey.ts';
import { verifyLicenseToken } from '../src/licensing/token.ts';

const PRIVATE_JWK = {
  key_ops: ['sign'],
  ext: true,
  alg: 'Ed25519',
  crv: 'Ed25519',
  d: '91lezRRFPF_zr4edhnH2NktUaFBjBJoeCHvRpn5cZ4w',
  x: 'Kw8ScZAHScD0IOm0Lx2bSYab-OPHkjdWFDbMR4j6Hdc',
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

async function signToken(payload, privateJwk) {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'Ed25519' },
    false,
    ['sign']
  );

  const header = { alg: 'EdDSA', typ: 'JWT' };
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
  console.log('⚡ MOBIPOS — CRYPTOGRAPHIC LICENSING SUITE (Ed25519)');
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

  // Test 1: Valid Token Verification
  console.log('[TEST 1] Legitimate Ed25519 Token Signing & Verification:');
  const validToken = await signToken(validPayload, PRIVATE_JWK);
  const res1 = await verifyLicenseToken(validToken, ED25519_PUBLIC_KEY_RAW_B64URL);
  assert(res1.valid === true, 'Valid token passes cryptographic verification');
  assert(res1.payload?.lic_key === 'MOBILIFE4HNP85HG', 'Decoded license key matches');
  assert(res1.payload?.device_id === 'a1b2c3d4e5f6', 'Decoded device ID matches');

  // Test 2: Tampered Payload
  console.log('\n[TEST 2] Tampered Claims Detection (Anti-Piracy):');
  const parts = validToken.split('.');
  // Modify payload (e.g. change max_desktops from 2 to 99)
  const tamperedClaims = { ...validPayload, max_desktops: 99 };
  const tamperedPayloadB64 = utf8ToBase64Url(JSON.stringify(tamperedClaims));
  const tamperedToken = `${parts[0]}.${tamperedPayloadB64}.${parts[2]}`;
  const res2 = await verifyLicenseToken(tamperedToken, ED25519_PUBLIC_KEY_RAW_B64URL);
  assert(res2.valid === false, 'Tampered token is rejected');
  assert(res2.error?.includes('invalide'), 'Error cites signature invalidity');

  // Test 3: Corrupted Signature
  console.log('\n[TEST 3] Bit-Flipped Signature Detection:');
  const flippedSig = parts[2].slice(0, -4) + (parts[2].endsWith('AAAA') ? 'BBBB' : 'AAAA');
  const corruptedToken = `${parts[0]}.${parts[1]}.${flippedSig}`;
  const res3 = await verifyLicenseToken(corruptedToken, ED25519_PUBLIC_KEY_RAW_B64URL);
  assert(res3.valid === false, 'Corrupted signature is rejected');

  // Test 4: Malformed Token Structures
  console.log('\n[TEST 4] Malformed Token Handling:');
  const res4a = await verifyLicenseToken('invalid.token', ED25519_PUBLIC_KEY_RAW_B64URL);
  assert(res4a.valid === false, 'Two-part token rejected');

  const res4b = await verifyLicenseToken('', ED25519_PUBLIC_KEY_RAW_B64URL);
  assert(res4b.valid === false, 'Empty token rejected');

  console.log('\n========================================================================');
  console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(console.error);

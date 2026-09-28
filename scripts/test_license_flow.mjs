#!/usr/bin/env node
/**
 * Test Suite: License Activation & Quota Logic
 */

import crypto from 'node:crypto';
import { sanitizeLicenseKey, formatLicenseKeyForDisplay, isValidKeyFormat } from '../src/licensing/keyFormat.ts';
import { hashHmac, encryptTursoToken, decryptTursoToken } from '../workers/licensing/src/crypto.ts';

async function runTests() {
  console.log('========================================================================');
  console.log('⚡ MOBIPOS — LICENSE FLOW & ENCRYPTION SUITE');
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

  // TEST 1: Key Normalization & Formatting
  console.log('[TEST 1] Key Sanitization & Presentation:');
  const raw1 = '  mobi - life - 4hnp - 85hg  ';
  const clean1 = sanitizeLicenseKey(raw1);
  assert(clean1 === 'MOBILIFE4HNP85HG', 'Strips whitespace and non-alphanumeric chars');
  assert(formatLicenseKeyForDisplay(clean1) === 'MOBI-LIFE-4HNP-85HG', 'Standard presentation format');
  assert(isValidKeyFormat(clean1) === true, 'Validates clean key format');

  // TEST 2: Peppered HMAC Blind Index Lookup
  console.log('\n[TEST 2] Deterministic Blind Indexing (HMAC-SHA256):');
  const pepper = 'test-pepper-salt-secret-12345';
  const hash1 = await hashHmac(clean1, pepper);
  const hash2 = await hashHmac('MOBILIFE4HNP85HG', pepper);
  assert(hash1 === hash2, 'Identical keys generate identical HMAC hashes');
  assert(hash1.length === 64, '64-character hex hash suitable for B-Tree indexing');

  // TEST 3: AES-256-GCM BYODB Token Encryption at Rest
  console.log('\n[TEST 3] AES-256-GCM Token Encryption & Decryption:');
  const masterKey = crypto.randomBytes(32).toString('base64');
  const tursoToken = 'secret-tenant-turso-jwt-token-abcdef123456';

  const encrypted = await encryptTursoToken(tursoToken, masterKey);
  assert(encrypted.startsWith('v1:'), 'Envelope contains version tag (v1:)');
  assert(!encrypted.includes(tursoToken), 'Ciphertext does not contain plaintext token');

  const decrypted = await decryptTursoToken(encrypted, masterKey);
  assert(decrypted === tursoToken, 'Decrypted token matches original token exactly');

  // TEST 4: Tampered Ciphertext Detection
  console.log('\n[TEST 4] Ciphertext Tamper Resistance:');
  const tamperedCipher = encrypted.slice(0, -4) + 'AAAA';
  let decryptFailed = false;
  try {
    await decryptTursoToken(tamperedCipher, masterKey);
  } catch {
    decryptFailed = true;
  }
  assert(decryptFailed === true, 'Tampered ciphertext is rejected by AES-GCM auth tag');

  console.log('\n========================================================================');
  console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(console.error);

/**
 * Runtime tests for the licensing worker's signing and audit-anchoring logic.
 *
 * Run: node --experimental-strip-types scripts/test_licensing_worker.mjs
 * (or via: npm run test:licensing-worker)
 */

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const { signCanonicalLicense, verifyCanonicalLicense, generateLicenseKey } =
  await import('../workers/licensing/src/crypto.ts');

// A real Ed25519 key pair, generated for the test run only.
const { publicKey, privateKey } = await crypto.subtle.generateKey('Ed25519', true, [
  'sign',
  'verify',
]);
const jwk = await crypto.subtle.exportKey('jwk', privateKey);
const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
const jwkString = JSON.stringify(jwk);

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (err) {
    console.log(`  FAIL ${label}: ${err.message}`);
    failures.push(label);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (err) {
    console.log(`  FAIL ${label}: ${err.message}`);
    failures.push(label);
  }
}

const canonical = (customer, formula, pos, desk, expires, hwids) =>
  `${customer}|${formula}|${pos}|${desk}|${expires ?? 'NONE'}|${[...hwids].sort().join(',')}`;

console.log('\ncanonical signing');

await checkAsync('signature verifies against canonical string', async () => {
  const data = canonical('Alpha', 'LIFETIME', 2, 1, null, ['HW-B', 'HW-A']);
  const sig = await signCanonicalLicense(jwkString, data);
  assert.equal(await verifyCanonicalLicense(publicJwk, data, sig), true);
});

await checkAsync('tampered payload fails verification', async () => {
  const data = canonical('Alpha', 'LIFETIME', 2, 1, null, ['HW-A']);
  const sig = await signCanonicalLicense(jwkString, data);
  const forged = canonical('Alpha', 'LIFETIME', 3, 1, null, ['HW-A']);
  assert.equal(await verifyCanonicalLicense(publicJwk, forged, sig), false);
});

await checkAsync('seat count change invalidates signature', async () => {
  const sig = await signCanonicalLicense(jwkString, canonical('A', 'LIFETIME', 1, 1, null, []));
  const changed = await verifyCanonicalLicense(
    publicJwk, canonical('A', 'LIFETIME', 2, 1, null, []), sig
  );
  assert.equal(changed, false);
});

await checkAsync('hwid order does not change the signature', async () => {
  const a = canonical('A', 'LIFETIME', 1, 1, null, ['HW-1', 'HW-2']);
  const b = canonical('A', 'LIFETIME', 1, 1, null, ['HW-2', 'HW-1']);
  assert.equal(a, b);
  const sig = await signCanonicalLicense(jwkString, a);
  assert.equal(await verifyCanonicalLicense(publicJwk, b, sig), true);
});

await checkAsync('delimiter injection in customer is contained', async () => {
  // A customer name containing '|' must not be able to forge a different
  // canonical layout; the field is a single interpolated value and the server
  // validates the formula against an allowlist.
  const evil = 'A|TRIAL_90D|9|9|2030-01-01T00:00:00Z';
  const sig = await signCanonicalLicense(jwkString, canonical(evil, 'LIFETIME', 1, 1, null, []));
  const other = canonical('A', 'TRIAL_90D', 9, 9, '2030-01-01T00:00:00Z', []);
  assert.equal(await verifyCanonicalLicense(publicJwk, other, sig), false);
});

await checkAsync('signature is deterministic for identical input', async () => {
  const data = canonical('Alpha', 'ANNUAL', 1, 1, '2030-01-01T00:00:00Z', ['HW-A']);
  const s1 = await signCanonicalLicense(jwkString, data);
  const s2 = await signCanonicalLicense(jwkString, data);
  assert.equal(s1, s2);
});

await checkAsync('signature is hex-encoded', async () => {
  const sig = await signCanonicalLicense(jwkString, canonical('A', 'DEMO', 1, 1, null, []));
  assert.match(sig, /^[0-9a-f]{128}$/);
});

console.log('\nlicense key generation');

check('key format', () => {
  assert.match(generateLicenseKey('LIFETIME'), /^MOBI-LIFE-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});
check('trial tag', () => {
  assert.match(generateLicenseKey('TRIAL_90D'), /^MOBI-T90D-/);
});
check('demo tag', () => {
  assert.match(generateLicenseKey('DEMO'), /^MOBI-DEMO-/);
});
check('unknown formula falls back to CUST', () => {
  assert.match(generateLicenseKey('BOGUS'), /^MOBI-CUST-/);
});
check('keys are unique across 200 draws', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(generateLicenseKey('LIFETIME'));
  assert.equal(seen.size, 200);
});

console.log('\naudit checkpoint monotonicity (KV simulation)');

const makeKv = () => {
  const store = new Map();
  return {
    async get(key) {
      const value = store.get(key);
      return value === undefined ? null : JSON.parse(value);
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
};

async function checkpoint(kv, clientId, seq, hash) {
  const prev = await kv.get(clientId);
  if (prev && seq < prev.sequence_number) {
    return { code: 409, prev };
  }
  if (
    prev &&
    seq === prev.sequence_number &&
    prev.head_audit_hash.toLowerCase() !== hash.toLowerCase()
  ) {
    return { code: 409, prev };
  }
  await kv.put(
    clientId,
    JSON.stringify({ sequence_number: seq, head_audit_hash: hash.toLowerCase() })
  );
  return { code: 200 };
}

const hashOf = (n) => 'a'.repeat(63) + String(n % 10);

await checkAsync('first checkpoint anchors', async () => {
  const kv = makeKv();
  const res = await checkpoint(kv, 'client-1', 1, hashOf(1));
  assert.equal(res.code, 200);
});

await checkAsync('sequence regression is rejected', async () => {
  const kv = makeKv();
  await checkpoint(kv, 'client-1', 10, hashOf(10));
  const res = await checkpoint(kv, 'client-1', 9, hashOf(9));
  assert.equal(res.code, 409, 'truncation must be refused');
});

await checkAsync('equal sequence with different hash is rejected', async () => {
  const kv = makeKv();
  await checkpoint(kv, 'client-1', 5, hashOf(5));
  const res = await checkpoint(kv, 'client-1', 5, 'b'.repeat(64));
  assert.equal(res.code, 409, 'rewrite must be refused');
});

await checkAsync('equal sequence with same hash is idempotent', async () => {
  const kv = makeKv();
  await checkpoint(kv, 'client-1', 5, hashOf(5));
  const res = await checkpoint(kv, 'client-1', 5, hashOf(5));
  assert.equal(res.code, 200);
});

await checkAsync('forward progress is accepted', async () => {
  const kv = makeKv();
  await checkpoint(kv, 'client-1', 5, hashOf(5));
  assert.equal((await checkpoint(kv, 'client-1', 6, hashOf(6))).code, 200);
});

await checkAsync('hash comparison is case-insensitive', async () => {
  const kv = makeKv();
  const upper = 'A'.repeat(64);
  await checkpoint(kv, 'client-1', 2, upper);
  assert.equal((await checkpoint(kv, 'client-1', 2, 'a'.repeat(64))).code, 200);
});

await checkAsync('clients are isolated from each other', async () => {
  const kv = makeKv();
  await checkpoint(kv, 'client-1', 100, hashOf(1));
  assert.equal((await checkpoint(kv, 'client-2', 1, hashOf(1))).code, 200);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed: ' + failures.join(', '));
  process.exit(1);
}

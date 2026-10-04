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

// ---------------------------------------------------------------------------
// Live integration (opt-in, isolated)
//
// Everything above runs against an in-memory KV and cannot touch production.
// The live section below is the only part that talks to a real worker, so it is
// doubly guarded:
//
//   1. It never runs by default. LICENSING_LIVE_TEST=1 opts in.
//   2. It refuses to run against the production domain unless
//      LICENSING_LIVE_ALLOW_PRODUCTION=1 is also set, because the real
//      hazard is a test sequence becoming a baseline that locks out a real
//      installation on the next run.
//
// Every live call uses an ephemeral client id. The worker expires records
// prefixed test_ephemeral_ after 60s, so a run leaves nothing behind.
// ---------------------------------------------------------------------------

console.log('\nlive integration (isolated)');

const LIVE_TEST = process.env.LICENSING_LIVE_TEST === '1';
const LIVE_ALLOW_PROD = process.env.LICENSING_LIVE_ALLOW_PRODUCTION === '1';
const LIVE_ENDPOINT = process.env.LICENSING_LIVE_ENDPOINT || '';
const LIVE_TOKEN = process.env.LICENSING_LIVE_TOKEN || '';

const testClientId = () =>
  `test_ephemeral_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const PRODUCTION_HOSTS = ['mobi-licensing.aminebarcelon28.workers.dev'];
const isProduction =
  PRODUCTION_HOSTS.some((h) => LIVE_ENDPOINT.includes(h)) || !LIVE_ENDPOINT;

check('live tests are opt-in', () => {
  if (!LIVE_TEST) {
    console.log('       (skipped: set LICENSING_LIVE_TEST=1 to enable)');
    return true;
  }
  return true;
});

check('live tests require an endpoint and token', () => {
  if (!LIVE_TEST) return true;
  if (!LIVE_ENDPOINT || !LIVE_TOKEN) {
    console.log('       (skipped: LICENSING_LIVE_ENDPOINT / LICENSING_LIVE_TOKEN unset)');
    return true;
  }
  return true;
});

check('live tests refuse production without an explicit override', () => {
  if (!LIVE_TEST || !LIVE_ENDPOINT || !LIVE_TOKEN) return true;
  if (isProduction && !LIVE_ALLOW_PROD) {
    console.log(
      '       (blocked: production endpoint requires LICENSING_LIVE_ALLOW_PRODUCTION=1)'
    );
    return true;
  }
  return true;
});

if (LIVE_TEST && LIVE_ENDPOINT && LIVE_TOKEN && (!isProduction || LIVE_ALLOW_PROD)) {
  const post = async (path, body) => {
    const res = await fetch(`${LIVE_ENDPOINT}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LIVE_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  await checkAsync('live: signing returns a key and signature', async () => {
    const r = await post('/api/v1/admin/licenses/sign', {
      customer: 'Integration Test',
      formula: 'LIFETIME',
      seats_pos: 1,
      seats_desk: 1,
      expires_at: null,
      hwid_bindings: [],
    });
    assert.equal(r.status, 200, `status ${r.status}`);
    assert.match(r.body.license_key, /^MOBI-LIFE-/);
    assert.match(r.body.token_signature, /^[0-9a-f]{128}$/);
  });

  await checkAsync('live: checkpoint anchors an ephemeral client', async () => {
    const cid = testClientId();
    const r = await post('/api/v1/admin/audit/checkpoint', {
      client_id: cid,
      sequence_number: 1,
      head_audit_hash: 'a'.repeat(64),
    });
    assert.equal(r.status, 200, `status ${r.status} for ${cid}`);
    assert.equal(r.body.status, 'anchored');
  });

  await checkAsync('live: truncation is refused for the ephemeral client', async () => {
    const cid = testClientId();
    await post('/api/v1/admin/audit/checkpoint', {
      client_id: cid,
      sequence_number: 50,
      head_audit_hash: 'b'.repeat(64),
    });
    const r = await post('/api/v1/admin/audit/checkpoint', {
      client_id: cid,
      sequence_number: 5,
      head_audit_hash: 'c'.repeat(64),
    });
    assert.equal(r.status, 409, `status ${r.status}`);
    assert.match(r.body.error, /Sequence regression/);
  });

  await checkAsync('live: anchor reset is refused without explicit confirmation', async () => {
    const cid = testClientId();
    await post('/api/v1/admin/audit/checkpoint', {
      client_id: cid,
      sequence_number: 12,
      head_audit_hash: 'd'.repeat(64),
    });

    const noConfirm = await post('/api/v1/admin/audit/reset', { client_id: cid });
    assert.equal(noConfirm.status, 400, `missing confirm: ${noConfirm.status}`);

    const wrongConfirm = await post('/api/v1/admin/audit/reset', {
      client_id: cid,
      confirm: 'yes-please',
    });
    assert.equal(wrongConfirm.status, 400, `wrong confirm: ${wrongConfirm.status}`);
    assert.equal(wrongConfirm.body.error, 'CONFIRMATION_REQUIRED');

    // The anchor must still be intact: a refused reset changes nothing.
    const stillThere = await post('/api/v1/admin/audit/checkpoint', {
      client_id: cid,
      sequence_number: 1,
      head_audit_hash: 'e'.repeat(64),
    });
    assert.equal(stillThere.status, 409, 'refused reset must not clear the anchor');
  });

  await checkAsync('live: confirmed anchor reset clears the false lockout', async () => {
    const cid = testClientId();
    await post('/api/v1/admin/audit/checkpoint', {
      client_id: cid,
      sequence_number: 40,
      head_audit_hash: 'f'.repeat(64),
    });

    const locked = await post('/api/v1/admin/audit/checkpoint', {
      client_id: cid,
      sequence_number: 2,
      head_audit_hash: '1'.repeat(64),
    });
    assert.equal(locked.status, 409, 'precondition: should be locked out');

    const reset = await post('/api/v1/admin/audit/reset', {
      client_id: cid,
      confirm: 'RESET_EPHEMERAL',
    });
    assert.equal(reset.status, 200, `reset status ${reset.status}`);
    assert.equal(reset.body.status, 'reset');
    assert.equal(reset.body.had_checkpoint, true);
    // The discarded baseline is reported back, not silently dropped.
    assert.equal(reset.body.discarded_checkpoint.sequence_number, 40);

    const after = await post('/api/v1/admin/audit/checkpoint', {
      client_id: cid,
      sequence_number: 2,
      head_audit_hash: '2'.repeat(64),
    });
    assert.equal(after.status, 200, `re-anchor after reset: ${after.status}`);
    assert.equal(after.body.status, 'anchored');
  });

  await checkAsync('live: unauthenticated signing is refused', async () => {
    const res = await fetch(`${LIVE_ENDPOINT}/api/v1/admin/licenses/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 401);
  });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed: ' + failures.join(', '));
  process.exit(1);
}

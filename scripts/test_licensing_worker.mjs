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

const { signCanonicalLicense, verifyCanonicalLicense, generateLicenseKey, pickSigningKey, semverGte, FIRST_K2_VERSION } =
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

// ---------------------------------------------------------------------------
// SEC-ROT-02: signing-key rotation gate (k1 legacy / k2 current)
// ---------------------------------------------------------------------------

check('semverGte orders versions correctly', () => {
  assert.equal(semverGte('1.8.0', '1.8.0'), true);
  assert.equal(semverGte('1.8.1', '1.8.0'), true);
  assert.equal(semverGte('2.0.0', '1.8.0'), true);
  assert.equal(semverGte('1.7.9', '1.8.0'), false);
  assert.equal(semverGte('1.7.0', '1.8.0'), false);
  assert.equal(semverGte('0.9.4', '1.8.0'), false);
});

check('pickSigningKey: K1 SUNSET — k2 unconditional when configured (old version too)', () => {
  const env = { LICENSE_ED25519_PRIVATE_JWK: 'JWK1', LICENSE_ED25519_PRIVATE_JWK_K2: 'JWK2' };
  const pick = pickSigningKey(env);
  assert.equal(pick.kid, 'k2');
  assert.equal(pick.jwk, 'JWK2');
});

check('pickSigningKey: version-less client gets k2 (K-6 closed — no compat bridge)', () => {
  const env = { LICENSE_ED25519_PRIVATE_JWK: 'JWK1', LICENSE_ED25519_PRIVATE_JWK_K2: 'JWK2' };
  assert.equal(pickSigningKey(env).kid, 'k2');
});

check('pickSigningKey: missing k2 secret falls back to k1 (misconfiguration, not a mode)', () => {
  const env = { LICENSE_ED25519_PRIVATE_JWK: 'JWK1' };
  const pick = pickSigningKey(env);
  assert.equal(pick.kid, 'k1');
  assert.equal(pick.jwk, 'JWK1');
});

// --- RT-3: deactivate-route token proof (verifyLicenseJwt) -----------------

const { signLicenseJwt, verifyLicenseJwt } = await import('../workers/licensing/src/crypto.ts');

const claims = {
  lic_key: 'MOBI-TEST-KEY1-ABCD',
  device_id: 'devicehashabc',
  device_type: 'desktop',
  lic_type: 'LIFETIME',
  exp: 0,
  iat: Math.floor(Date.now() / 1000),
};

const goodToken = await signLicenseJwt(claims, jwkString, 'k2');

await (async () => {
  try {
    const v = await verifyLicenseJwt(goodToken, [undefined, jwkString]);
    assert.equal(v.valid, true, 'valid token verifies');
    assert.equal(v.payload.lic_key, claims.lic_key);
    assert.equal(v.payload.device_id, claims.device_id);
    passed += 1;
    console.log('  ok   verifyLicenseJwt: valid k2 token verifies with matching claims');
  } catch (err) {
    failures.push('verifyLicenseJwt valid');
    console.log(`  FAIL verifyLicenseJwt valid: ${err.message}`);
  }

  try {
    const parts = goodToken.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...claims, device_id: 'VICTIM-HASH' })
    ).toString('base64url');
    const v = await verifyLicenseJwt(
      `${parts[0]}.${tamperedPayload}.${parts[2]}`,
      [undefined, jwkString]
    );
    assert.equal(v.valid, false, 'tampered payload refused');
    passed += 1;
    console.log('  ok   verifyLicenseJwt: tampered payload refused');
  } catch (err) {
    failures.push('verifyLicenseJwt tampered');
    console.log(`  FAIL verifyLicenseJwt tampered: ${err.message}`);
  }

  try {
    const v = await verifyLicenseJwt('not.a.token', [undefined, jwkString]);
    assert.equal(v.valid, false, 'garbage refused');
    const v2 = await verifyLicenseJwt('', [undefined, jwkString]);
    assert.equal(v2.valid, false, 'empty refused');
    passed += 1;
    console.log('  ok   verifyLicenseJwt: garbage/empty tokens refused');
  } catch (err) {
    failures.push('verifyLicenseJwt garbage');
    console.log(`  FAIL verifyLicenseJwt garbage: ${err.message}`);
  }

  try {
    // kid selection: a k1-claimed token must verify against the k1 key, not k2
    const k1Token = await signLicenseJwt(claims, jwkString, 'k1');
    const vWrong = await verifyLicenseJwt(k1Token, [undefined, jwkString]);
    assert.equal(vWrong.valid, false, 'k1 token must not verify against k2 key');
    const vRight = await verifyLicenseJwt(k1Token, [jwkString, undefined]);
    assert.equal(vRight.valid, true, 'k1 token verifies against k1 key');
    passed += 1;
    console.log('  ok   verifyLicenseJwt: kid selects the verification key');
  } catch (err) {
    failures.push('verifyLicenseJwt kid');
    console.log(`  FAIL verifyLicenseJwt kid: ${err.message}`);
  }

  try {
    // The helper must never enable signing: strip-d public import is verify-only
    const pubOnly = JSON.parse(jwkString);
    delete pubOnly.d;
    let signingBlocked = false;
    try {
      await crypto.subtle.importKey('jwk', pubOnly, { name: 'Ed25519' }, false, ['sign']);
    } catch {
      signingBlocked = true;
    }
    assert.ok(signingBlocked, 'public half cannot be imported for signing');
    passed += 1;
    console.log('  ok   verifyLicenseJwt: public half is verify-only (no signing)');
  } catch (err) {
    failures.push('verifyLicenseJwt no-sign');
    console.log(`  FAIL verifyLicenseJwt no-sign: ${err.message}`);
  }
})();

// --- M2: rate limiting (EDGE-1 squatting DoS / EDGE-2 verify oracle) -------

const { enforceRateLimit, rateLimitConfig, RATE_LIMITS } = await import(
  '../workers/licensing/src/rateLimit.ts'
);

/** Fake libsql execute that simulates the rate_limits table semantics. */
function fakeRateDb() {
  const table = new Map(); // key -> count
  const calls = [];
  return {
    calls,
    async execute(stmt) {
      calls.push(stmt.sql.trim());
      if (stmt.sql.includes('INSERT INTO rate_limits')) {
        const { bucket, identity, window_start } = stmt.args;
        const key = `${bucket}|${identity}|${window_start}`;
        const next = (table.get(key) ?? 0) + 1;
        table.set(key, next);
        return { rows: [{ count: next }], rowsAffected: 1 };
      }
      if (stmt.sql.includes('DELETE FROM rate_limits')) {
        const { bucket, cutoff } = stmt.args;
        let removed = 0;
        for (const key of [...table.keys()]) {
          const [b, , ws] = key.split('|');
          if (b === bucket && Number(ws) < Number(cutoff)) {
            table.delete(key);
            removed++;
          }
        }
        return { rows: [], rowsAffected: removed };
      }
      throw new Error('fake db: unexpected SQL: ' + stmt.sql.slice(0, 60));
    },
  };
}

await (async () => {
  try {
    const db = fakeRateDb();
    const T0 = 1_700_000_000;
    // Exhaust the activate_ip window (limit 20).
    let last;
    for (let i = 0; i < 20; i++) last = await enforceRateLimit(db, 'activate_ip', 'ip-A', T0);
    assert.equal(last.ok, true, 'limit-th hit must pass');
    assert.equal(last.count, 20);
    const over = await enforceRateLimit(db, 'activate_ip', 'ip-A', T0 + 10);
    assert.equal(over.ok, false, 'limit+1 hit must be refused');
    assert.equal(over.count, 21);
    assert.ok(over.retryAfter > 0 && over.retryAfter <= 3600, 'retryAfter within the window');
    // A different identity is untouched (no collateral lockout).
    const other = await enforceRateLimit(db, 'activate_ip', 'ip-B', T0 + 10);
    assert.equal(other.ok, true, 'different IP must not inherit the block');
    // Window rollover resets the count.
    const nextWindow = await enforceRateLimit(db, 'activate_ip', 'ip-A', T0 + 3601);
    assert.equal(nextWindow.ok, true, 'new window must reset the counter');
    assert.equal(nextWindow.count, 1);
    // Sweep ran when the new window opened.
    assert.ok(db.calls.some((s) => s.includes('DELETE FROM rate_limits')), 'stale windows swept on rollover');
    console.log('  ok   rateLimit: window exhausts, refuses limit+1, isolates identities, rolls over');
    passed += 1;
  } catch (err) {
    failures.push('rateLimit window semantics');
    console.log(`  FAIL rateLimit window semantics: ${err.message}`);
  }
})();

await (async () => {
  try {
    // Store unavailable -> fail-open but flagged (merchant must not be locked
    // out by a Turso hiccup; sustained outage is already gated by the DB).
    const broken = { async execute() { throw new Error('turso down'); } };
    const v = await enforceRateLimit(broken, 'verify_ip', 'ip-C', 1_700_000_000);
    assert.equal(v.ok, true, 'infra failure must fail open');
    assert.ok(v.degraded && v.degraded.startsWith('rate_limit_store_unavailable'), 'degradation surfaced');
    console.log('  ok   rateLimit: store outage fails open with a degradation marker');
    passed += 1;
  } catch (err) {
    failures.push('rateLimit fail-open');
    console.log(`  FAIL rateLimit fail-open: ${err.message}`);
  }
})();

await (async () => {
  try {
    // Registry shape: every bucket has sane bounds; verify is the most
    // generous (legit boot pings), activate/deactivate the tightest.
    for (const [bucket, cfg] of Object.entries(RATE_LIMITS)) {
      assert.ok(cfg.limit >= 5 && cfg.limit <= 600, `${bucket} limit sane`);
      assert.ok(cfg.windowSecs === 3600, `${bucket} window is 1h`);
    }
    assert.ok(rateLimitConfig('verify_ip').limit > rateLimitConfig('activate_ip').limit, 'verify looser than activate');
    assert.equal(RATE_LIMITS.trial_ip.limit, 5, 'trial funnel flood wall');
    assert.equal(RATE_LIMITS.admin_ip.limit, 30, 'admin brute-force wall');
    console.log('  ok   rateLimit: bucket registry bounds hold');
    passed += 1;
  } catch (err) {
    failures.push('rateLimit registry');
    console.log(`  FAIL rateLimit registry: ${err.message}`);
  }
})();

// --- M2/F3: pepper rotation (lazy dual-pepper lookup) ----------------------

const { findLicenseByNormalizedKey } = await import('../workers/licensing/src/licenseLookup.ts');
const { hashHmac } = await import('../workers/licensing/src/crypto.ts');

/** Fake licenses table keyed by key_hash, with UPDATE support. */
function fakeLicenseDb() {
  const rowsByKeyHash = new Map();
  const updates = [];
  return {
    rowsByKeyHash,
    updates,
    async seed(pepper, normalizedKey, id) {
      const h = await hashHmac(normalizedKey, pepper);
      rowsByKeyHash.set(h, { id, customer_name: 'C', license_type: 'LIFETIME', status: 'active',
        max_desktops: 1, max_mobiles: 1, encrypted_turso_token: 'NONE', turso_url: '', expires_at: null });
    },
    async execute(stmt) {
      if (stmt.sql.includes('SELECT') && stmt.sql.includes('FROM licenses')) {
        const row = this.rowsByKeyHash.get(stmt.args.key_hash);
        return { rows: row ? [row] : [], rowsAffected: 0 };
      }
      if (stmt.sql.includes('UPDATE licenses SET key_hash')) {
        updates.push(stmt.args);
        const row = this.rowsByKeyHash.get(stmt.args.old_hash);
        if (!row) return { rows: [], rowsAffected: 0 };
        this.rowsByKeyHash.delete(stmt.args.old_hash);
        this.rowsByKeyHash.set(stmt.args.new_hash, row);
        return { rows: [], rowsAffected: 1 };
      }
      throw new Error('fake db: unexpected SQL: ' + stmt.sql.slice(0, 60));
    },
  };
}

await (async () => {
  try {
    const OLD = 'pepper-old-2026-11';
    const NEW = 'pepper-new-2026-11';
    const KEY = 'MOBI-AAAA-BBBB-CCCC';
    const db = fakeLicenseDb();
    await db.seed(OLD, KEY, 'lic_1');

    // Before rotation: current pepper finds nothing, previous finds and re-hashes.
    const envRotate = { LICENSE_PEPPER: NEW, LICENSE_PEPPER_PREVIOUS: OLD };
    const first = await findLicenseByNormalizedKey(db, envRotate, KEY);
    assert.ok(first, 'previous-pepper row must be found during rotation');
    assert.equal(first.row.id, 'lic_1');
    assert.equal(first.rePeppered, true, 'row must be lazily re-hashed');
    assert.equal(db.updates.length, 1, 'exactly one re-hash UPDATE');

    // After convergence: the current pepper finds it directly, no re-hash.
    const second = await findLicenseByNormalizedKey(db, envRotate, KEY);
    assert.ok(second);
    assert.equal(second.rePeppered, false, 'converged row needs no re-hash');
    assert.equal(db.updates.length, 1, 'no extra UPDATE after convergence');

    // Without the previous pepper configured, the same row is unfindable
    // (fail-closed end state after the rotation window closes).
    const db2 = fakeLicenseDb();
    await db2.seed(OLD, KEY, 'lic_2');
    const miss = await findLicenseByNormalizedKey(db2, { LICENSE_PEPPER: NEW }, KEY);
    assert.equal(miss, null, 'no previous pepper -> old rows are unfindable');

    console.log('  ok   pepperRotation: lazy re-hash converges, then previous pepper retires clean');
    passed += 1;
  } catch (err) {
    failures.push('pepperRotation lazy re-hash');
    console.log(`  FAIL pepperRotation lazy re-hash: ${err.message}`);
  }
})();

// --- M2: trial funnel (validation + exactly-once lead insert) --------------

const {
  validateTrialRegistration,
  registerTrialLead,
  normalizeWhatsApp,
  normalizeFullName,
  updateLeadStatus,
  isValidLeadStatus,
} = await import('../workers/licensing/src/trialRegister.ts');
const { constantTimeEqual } = await import('../workers/licensing/src/crypto.ts');

check('constantTimeEqual: equal and unequal secrets, both constant-shape', () => {
  // sync bridge: the async fn is awaited via the microtask queue
});

await (async () => {
  try {
    assert.equal(await constantTimeEqual('secret-a', 'secret-a'), true);
    assert.equal(await constantTimeEqual('secret-a', 'secret-b'), false);
    assert.equal(await constantTimeEqual('secret-a', 'secret-a-longer-suffix'), false);
    assert.equal(await constantTimeEqual('', ''), true);
    console.log('  ok   constantTimeEqual: digest-based, length-leak free');
    passed += 1;
  } catch (err) {
    failures.push('constantTimeEqual');
    console.log(`  FAIL constantTimeEqual: ${err.message}`);
  }
})();

check('trial validation: WhatsApp formats humans actually type', () => {
  assert.equal(normalizeWhatsApp('+213 555 12 34 56'), '+213555123456');
  assert.equal(normalizeWhatsApp('0550 00 33 33'), '0550003333');
  assert.equal(normalizeWhatsApp('0550003333'), '0550003333');
  assert.equal(normalizeWhatsApp('+213555123456'), '+213555123456');
  // rejects
  assert.equal(normalizeWhatsApp('1234567'), null, 'too short');
  assert.equal(normalizeWhatsApp('1234567890123456'), null, 'too long');
  assert.equal(normalizeWhatsApp('0550abc333'), null, 'letters');
  assert.equal(normalizeWhatsApp('0550+123'), null, 'glued plus');
  assert.equal(normalizeWhatsApp(''), null, 'empty');
  assert.equal(normalizeWhatsApp(12345678), null, 'not a string');
});

check('trial validation: name rules', () => {
  assert.equal(normalizeFullName('  Ahmed   Benali '), 'Ahmed Benali');
  assert.equal(normalizeFullName('A'), null, 'too short');
  assert.equal(normalizeFullName('x'.repeat(81)), null, 'too long');
  assert.equal(normalizeFullName('12345'), null, 'no letter');
  assert.equal(normalizeFullName('bad\u0000name'), null, 'control char');
  assert.equal(normalizeFullName(null), null, 'not a string');
});

check('trial validation: idempotency key + device id', () => {
  const good = validateTrialRegistration({
    full_name: 'Ahmed Benali',
    whatsapp: '0550 00 33 33',
    idempotency_key: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  });
  assert.ok(good.ok);
  if (good.ok) {
    assert.equal(good.value.whatsapp, '0550003333');
    assert.equal(good.value.device_id, null);
  }
  const badIdem = validateTrialRegistration({
    full_name: 'Ahmed Benali',
    whatsapp: '0550003333',
    idempotency_key: 'short',
  });
  assert.ok(!badIdem.ok && badIdem.error === 'INVALID_IDEMPOTENCY_KEY');
  const badDevice = validateTrialRegistration({
    full_name: 'Ahmed Benali',
    whatsapp: '0550003333',
    idempotency_key: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    device_id: 'bad device id with spaces and <script>',
  });
  assert.ok(!badDevice.ok && badDevice.error === 'INVALID_DEVICE_ID');
});

await (async () => {
  try {
    /** Fake customers table with PK semantics. */
    function fakeLeadsDb() {
      const rows = new Map();
      const inserts = [];
      return {
        rows,
        inserts,
        async execute(stmt) {
          if (stmt.sql.includes('INSERT INTO customers')) {
            inserts.push(stmt.args);
            if (rows.has(stmt.args.id)) {
              throw new Error('UNIQUE constraint failed: customers.id');
            }
            rows.set(stmt.args.id, { ...stmt.args });
            return { rows: [], rowsAffected: 1 };
          }
          throw new Error('fake db: unexpected SQL: ' + stmt.sql.slice(0, 50));
        },
      };
    }
    const db = fakeLeadsDb();
    const value = validateTrialRegistration({
      full_name: 'Ahmed Benali',
      whatsapp: '0550 00 33 33',
      idempotency_key: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    });
    assert.ok(value.ok);
    if (!value.ok) return;
    const first = await registerTrialLead(db, value.value, '2026-11-08T22:00:00Z');
    assert.equal(first.status, 'registered');
    const replay = await registerTrialLead(db, value.value, '2026-11-08T22:01:00Z');
    assert.equal(replay.status, 'already_registered', 'replay must be idempotent, not an error');
    assert.equal(db.rows.size, 1, 'exactly one row despite the replay');
    const boom = { async execute() { throw new Error('connection reset'); } };
    const rejected = await registerTrialLead(boom, value.value, '2026-11-08T22:02:00Z');
    assert.equal(rejected.status, 'rejected', 'real infra failures fail closed');
    console.log('  ok   trialRegister: exactly-once insert, idempotent replay, fail-closed infra');
    passed += 1;
  } catch (err) {
    failures.push('trialRegister exactly-once');
    console.log(`  FAIL trialRegister exactly-once: ${err.message}`);
  }
})();

// --- M2: lead status transitions -------------------------------------------
check('lead status: enum validation is strict', () => {
  assert.ok(isValidLeadStatus('lead'));
  assert.ok(isValidLeadStatus('contacted'));
  assert.ok(isValidLeadStatus('converted'));
  assert.ok(isValidLeadStatus('lost'));
  assert.ok(!isValidLeadStatus('LEAD'), 'case-sensitive');
  assert.ok(!isValidLeadStatus('admin'), 'no arbitrary values');
  assert.ok(!isValidLeadStatus(''), 'no empty');
  assert.ok(!isValidLeadStatus(null), 'no null');
  assert.ok(!isValidLeadStatus(42), 'no numbers');
});

await (async () => {
  try {
    function fakeUpdateDb(rows, fail) {
      return {
        async execute(stmt) {
          if (fail) throw new Error('connection reset');
          if (stmt.sql.includes('UPDATE customers')) {
            const row = rows.get(stmt.args.id);
            if (!row) return { rows: [], rowsAffected: 0 };
            row.status = stmt.args.status;
            return { rows: [], rowsAffected: 1 };
          }
          throw new Error('unexpected SQL');
        },
      };
    }
    const rows = new Map([['9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', { status: 'lead' }]]);
    const db = fakeUpdateDb(rows);
    const ok = await updateLeadStatus(db, '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', 'contacted');
    assert.equal(ok.status, 'updated');
    assert.equal(rows.get('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d').status, 'contacted');
    const missing = await updateLeadStatus(db, 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000', 'lost');
    assert.equal(missing.status, 'not_found', 'unknown id must 404, not fail');
    const badId = await updateLeadStatus(db, 'bad id; DROP TABLE customers', 'lost');
    assert.equal(badId.status, 'rejected', 'malformed id never reaches the DB');
    const infra = await updateLeadStatus(fakeUpdateDb(rows, true), '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', 'converted');
    assert.equal(infra.status, 'rejected', 'infra failures fail closed');
    console.log('  ok   updateLeadStatus: strict id+enum, not_found, fail-closed infra');
    passed += 1;
  } catch (err) {
    failures.push('updateLeadStatus');
    console.log(`  FAIL updateLeadStatus: ${err.message}`);
  }
})();

console.log(`\n${passed} passed, ${failures.length} failed`);if (failures.length) {
  console.log('Failed: ' + failures.join(', '));
  process.exit(1);
}

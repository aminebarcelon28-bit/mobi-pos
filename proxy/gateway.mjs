// Merchant sync gateway — signed refund ingestion + sequence arbiter +
// SERVERTIME_V1 issuer. (RUN ON YOUR SERVER, never in the POS app.)
//
// POST /api/v1/sync/ingest  { deviceId, mutations: [{ seqNo, ticketId,
//   payload, deviceSignature, envelope }] }  ->  200 { ackSeqNos,
//   serverTimeToken } | 400 INVALID_SIGNATURE (+failedSeq) | 409
//   SEQUENCE_GAP_DETECTED (+expectedSeq/receivedSeq) | 403
//   DEVICE_NOT_ENROLLED / DEVICE_REVOKED
// GET  /healthz
//
// Trust model (mirrors the client dossier):
// - Ed25519 per device. Registry (`GATEWAY_DEVICE_KEYS` JSON
//   {deviceId: pubkeyHex}, or `registerDevice()` in-process) + `status`.
//   Unknown devices 403 (fail closed — never auto-enroll over the wire).
// - The signature covers the verbatim `envelope` string
//   (`ticket|refund|net|device|seq|verified`); the gateway NEVER
//   reconstructs it from other fields. Envelope device/seq must equal the
//   row fields or the mutation is tampered.
// - Sequence arbiter per device: expected = lastSeen+1; past seqs ACK
//   idempotently (dedupe on `(device_id, seq_no)`); future seqs 409 with
//   expected/received (zero ingestion that batch — batches are atomic).
// - Time tokens (`SERVERTIME_V1.{b64}.{sig}` over
//   `MOBI-TIME-V1.SERVERTIME_V1.{b64}`) ride 200 + 409 responses. Key from
//   `GATEWAY_PRIVATE_KEY` (hex seed); test seed ONLY under ALLOW_TEST_KEY=1
//   (never default — same refusal discipline as the native placeholder).
//
// Env: GATEWAY_PORT=8788, GATEWAY_PRIVATE_KEY (hex, 32-byte seed),
//   GATEWAY_DEVICE_KEYS='{"dev-1":"<hex pubkey>"}', GATEWAY_SECRET (bearer,
//   optional like the broker), ALLOW_ORIGIN=*, RATE_LIMIT_PER_MIN=120,
//   NODE_ENV=development.
//
// Style: zero-dependency node:http like the token broker beside it.

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  randomUUID,
  sign,
  verify,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';

try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  }
} catch (err) {
  console.warn('[gateway] Could not read local .env file:', err);
}

/** Test-only gateway seed (fixed, public). Production uses env key material. */
export const TEST_GATEWAY_SEED_HEX = '09'.repeat(32);
/** Domain separator shared with the native verifier (time_anchor.rs). */
export const TIME_DOMAIN = 'MOBI-TIME-V1';
export const SERVERTIME_PREFIX = 'SERVERTIME_V1';

// PKCS#8 DER prefix for an Ed25519 seed (RFC 8410) — deterministic
// private-key construction from a hex seed (no randomness involved).
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function privateKeyFromSeedHex(seedHex) {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function publicKeyHexFromSeedHex(seedHex) {
  const pub = createPublicKey(privateKeyFromSeedHex(seedHex));
  return pub.export({ format: 'der', type: 'spki' }).slice(-32).toString('hex');
}

function loadGatewaySeed() {
  const hex = (process.env.GATEWAY_PRIVATE_KEY ?? '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex').toString('hex');
  if (process.env.ALLOW_TEST_KEY === '1') {
    console.warn('[gateway] WARNING: test signing key enabled (never production).');
    return TEST_GATEWAY_SEED_HEX;
  }
  return null;
}

export function mintServerTimeToken(signingSeedHex, serverEpochMs, expiresAtMs, nonce) {
  const payload = { nonce, server_time_ms: serverEpochMs, expires_at_ms: expiresAtMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const envelope = `${SERVERTIME_PREFIX}.${payloadB64}`;
  const signed = Buffer.concat([Buffer.from(`${TIME_DOMAIN}.${envelope}`, 'utf8')]);
  const sigB64 = sign(null, signed, privateKeyFromSeedHex(signingSeedHex)).toString('base64url');
  return `${envelope}.${sigB64}`;
}

export function verifyDeviceSignature(pubkeyHex, envelopeStr, sigHex) {
  try {
    const pubDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(pubkeyHex, 'hex'),
    ]);
    const pub = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
    return verify(null, Buffer.from(envelopeStr, 'utf8'), pub, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

export function createGatewayServer(opts = {}) {
  const seedHex = opts.signingSeedHex ?? loadGatewaySeed();
  const devices = new Map(); // deviceId -> { pubkeyHex, status, lastSeenSeq }
  const ledger = []; // committed mutations (harness-grade; production = Turso)
  const processed = new Set(); // "deviceId:seqNo" idempotency markers
  const drops = { count: 0 };
  if (opts.devices) {
    for (const [id, pub] of Object.entries(opts.devices)) {
      devices.set(id, { pubkeyHex: pub.pubkeyHex ?? pub, status: 'enrolled', lastSeenSeq: 0 });
    }
  }

  const issueTimeToken = () => {
    if (!seedHex) return undefined;
    const now = Date.now();
    return mintServerTimeToken(seedHex, now, now + 300_000, randomUUID().replace(/-/g, ''));
  };

  const send = (res, code, obj, allowOrigin) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json',
      'access-control-allow-origin': allowOrigin,
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    });
    res.end(body);
  };

  const hits = new Map();
  const rateLimited = (ip, perMin) => {
    const now = Date.now();
    const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > perMin;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const allowOrigin = process.env.ALLOW_ORIGIN || '*';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': allowOrigin,
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
      });
      res.end();
      return;
    }
    if (drops.count > 0) {
      drops.count -= 1;
      req.socket.destroy();
      return;
    }
    if (url.pathname === '/healthz') {
      send(res, 200, { ok: true, devices: devices.size, ledger: ledger.length }, allowOrigin);
      return;
    }
    if (url.pathname !== '/api/v1/sync/ingest' || req.method !== 'POST') {
      send(res, 404, { error: 'NOT_FOUND' }, allowOrigin);
      return;
    }
    const secret = process.env.GATEWAY_SECRET ?? '';
    if (secret) {
      const got = req.headers.authorization ?? req.headers['x-gateway-secret'] ?? '';
      if (got !== `Bearer ${secret}` && got !== secret) {
        send(res, 401, { error: 'UNAUTHORIZED' }, allowOrigin);
        return;
      }
    }
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (rateLimited(ip, Number(process.env.RATE_LIMIT_PER_MIN ?? 120))) {
      send(res, 429, { error: 'RATE_LIMITED' }, allowOrigin);
      return;
    }
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.socket.destroy();
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        send(res, 400, { error: 'INVALID_BODY' }, allowOrigin);
        return;
      }
      handleIngest(body, (code, obj) => send(res, code, obj, allowOrigin));
    });
  });

  function handleIngest(body, done) {
    const withToken = (code, obj) => {
      const token = issueTimeToken();
      done(code, token ? { ...obj, serverTimeToken: token } : obj);
    };
    const deviceId = body?.deviceId;
    const mutations = body?.mutations;
    if (typeof deviceId !== 'string' || !deviceId || !Array.isArray(mutations) || mutations.length === 0) {
      done(400, { error: 'INVALID_BODY' });
      return;
    }
    const dev = devices.get(deviceId);
    if (!dev) {
      done(403, { error: 'DEVICE_NOT_ENROLLED', deviceId });
      return;
    }
    if (dev.status !== 'enrolled') {
      done(403, { error: 'DEVICE_REVOKED', deviceId });
      return;
    }
    // Phase 1 — validate EVERYTHING (atomic batch: zero ingestion on failure).
    // Every 400 carries the offending seq (or -1 when the shape itself is
    // unreadable) so the client can pinpoint without guessing.
    const failedSeqOf = (m) => (m && Number.isInteger(m.seqNo) ? m.seqNo : -1);
    const checked = [];
    for (const m of mutations) {
      if (!m || !Number.isInteger(m.seqNo) || typeof m.ticketId !== 'string' || typeof m.envelope !== 'string' || typeof m.deviceSignature !== 'string') {
        done(400, { error: 'INVALID_MUTATION', failedSeq: failedSeqOf(m) });
        return;
      }
      const parts = m.envelope.split('|');
      if (parts.length !== 6 || parts[3] !== deviceId || Number(parts[4]) !== m.seqNo) {
        done(400, { error: 'PAYLOAD_TAMPERED', failedSeq: m.seqNo });
        return;
      }
      if (!verifyDeviceSignature(dev.pubkeyHex, m.envelope, m.deviceSignature)) {
        done(400, { error: 'INVALID_SIGNATURE', failedSeq: m.seqNo });
        return;
      }
      checked.push(m);
    }
    // Phase 2 — sequence arbiter (past = idempotent ACK, future hole = 409).
    // In-batch duplicates collapse first (same bytes re-sent); the survivor
    // run must be contiguous from the cursor or the whole batch refuses.
    const seenInBatch = new Set();
    const fresh = [];
    for (const m of checked) {
      if (m.seqNo > dev.lastSeenSeq && !seenInBatch.has(m.seqNo)) {
        seenInBatch.add(m.seqNo);
        fresh.push(m);
      }
    }
    fresh.sort((a, b) => a.seqNo - b.seqNo);
    for (let i = 0; i < fresh.length; i++) {
      if (fresh[i].seqNo !== dev.lastSeenSeq + 1 + i) {
        withToken(409, {
          error: 'SEQUENCE_GAP_DETECTED',
          expectedSeq: dev.lastSeenSeq + 1 + i,
          receivedSeq: fresh[i].seqNo,
        });
        return;
      }
    }
    // Phase 3 — commit (dedupe markers make replays converge).
    const acked = [];
    for (const m of checked) {
      const marker = `${deviceId}:${m.seqNo}`;
      if (!processed.has(marker)) {
        processed.add(marker);
        ledger.push({ ...m, deviceId, ingestedAt: new Date().toISOString() });
      }
      acked.push(m.seqNo);
    }
    const maxFresh = fresh.length ? Math.max(...fresh.map((m) => m.seqNo)) : dev.lastSeenSeq;
    dev.lastSeenSeq = Math.max(dev.lastSeenSeq, maxFresh);
    withToken(200, { ackSeqNos: acked });
  }

  return {
    server,
    listen: (port) => new Promise((resolve) => server.listen(port, () => resolve(server.address()))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    registerDevice: (id, pubkeyHex, status = 'enrolled') => {
      devices.set(id, { pubkeyHex, status, lastSeenSeq: 0 });
    },
    setDeviceStatus: (id, status) => {
      const d = devices.get(id);
      if (d) d.status = status;
    },
    simulateDrop: (n = 1) => {
      drops.count += n;
    },
    ledger: () => [...ledger],
    cursorOf: (id) => devices.get(id)?.lastSeenSeq ?? null,
  };
}

// Standalone: `node gateway.mjs` (production shape — no test key unless env).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.GATEWAY_PORT ?? 8788);
  const gw = createGatewayServer();
  try {
    const init = JSON.parse(process.env.GATEWAY_DEVICE_KEYS ?? '{}');
    for (const [id, pub] of Object.entries(init)) gw.registerDevice(id, String(pub));
  } catch (e) {
    console.warn('[gateway] GATEWAY_DEVICE_KEYS unparseable:', e);
  }
  gw.listen(port).then((addr) => console.log(`[gateway] listening on ${addr.port}`));
}

// Re-export for tests that prefer named crypto without a server.
export { generateKeyPairSync };

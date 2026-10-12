/**
 * Gateway loopback E2E (MOBI-GATEWAY-SYNC-VERIFIER). Run from repo root:
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types tests/sync-pipeline/drain-e2e.mts
 *
 * Exercises the REAL client transport (`src/api/syncGateway.ts`) against a
 * loopback gateway with REAL Ed25519 keys on both sides: device-signed
 * refund envelopes one way, gateway-signed SERVERTIME_V1 tokens back.
 * Native application of such tokens is proven by the Rust
 * `signed_server_time_ingestion` test; here the token is verified locally
 * against the gateway pubkey (same bytes the native verifier checks).
 */
import { verify, createPublicKey } from 'node:crypto';
import { postMutations, ingestGatewayTimeToken } from '../../src/api/syncGateway.ts';
import {
  bootMockGateway,
  deviceKeypair,
  signEnvelope,
  envelopeFor,
  FIXTURE_GATEWAY_SEED,
} from '../fixtures/mockGatewayServer.mjs';
import { publicKeyHexFromSeedHex } from '../../proxy/gateway.mjs';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ` :: ${extra}` : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ` :: ${extra}` : ''}`); }
}

const DEVICE_ID = 'dev-A';
const keys = deviceKeypair();
const mut = (seq: number, net = 150) => {
  const refundId = `REF-${seq}`;
  const envelope = envelopeFor('TKT-1', refundId, net, DEVICE_ID, seq, 0);
  return {
    seqNo: seq,
    ticketId: `TKT-${seq}`,
    payload: JSON.stringify({ id: refundId }),
    deviceSignature: signEnvelope(keys.privateKey, envelope),
    envelope,
  };
};

const fx = await bootMockGateway({ deviceId: DEVICE_ID });
const base = fx.baseUrl;

// ---- E1: five offline mutations drain through the real transport ----
{
  const res = await postMutations(base, { deviceId: DEVICE_ID, mutations: [1, 2, 3, 4, 5].map((s) => mut(s)) });
  check('E1 200 with full ACK', JSON.stringify(res.ackSeqNos) === '[1,2,3,4,5]');
  check('E1 SERVERTIME token rides the response', typeof res.serverTimeToken === 'string' && res.serverTimeToken.split('.').length === 3);
  check('E1 ledger holds five', fx.gw.ledger().length === 5);
  check('E1 cursor advanced', fx.gw.cursorOf(DEVICE_ID) === 5);
  var token: string | undefined = res.serverTimeToken;
}

// ---- E2/E3: forgery and wrong-key die with zero ingestion ----
{
  const forged = { ...mut(6), envelope: envelopeFor('TKT-1', 'REF-6', 99999, DEVICE_ID, 6, 0) };
  const before = fx.gw.ledger().length;
  let threw = '';
  try {
    await postMutations(base, { deviceId: DEVICE_ID, mutations: [forged] });
  } catch (e) {
    threw = String((e as Error).message ?? e);
  }
  check('E2 single-bit payload tamper rejected', /INVALID_SIGNATURE/.test(threw), threw);
  const evilKeys = deviceKeypair('22'.repeat(32));
  const wrongKey = {
    seqNo: 6, ticketId: 'TKT-6', payload: '{}',
    deviceSignature: signEnvelope(evilKeys.privateKey, envelopeFor('TKT-1', 'REF-6', 150, DEVICE_ID, 6, 0)),
    envelope: envelopeFor('TKT-1', 'REF-6', 150, DEVICE_ID, 6, 0),
  };
  threw = '';
  try {
    await postMutations(base, { deviceId: DEVICE_ID, mutations: [wrongKey] });
  } catch (e) {
    threw = String((e as Error).message ?? e);
  }
  check('E3 wrong-key signature rejected', /INVALID_SIGNATURE/.test(threw), threw);
  check('E2/E3 zero ingestion', fx.gw.ledger().length === before);
  const r400 = await fetch(`${base}/api/v1/sync/ingest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: DEVICE_ID, mutations: [{ ...mut(6), envelope: envelopeFor('TKT-1', 'REF-6', 99999, DEVICE_ID, 6, 0) }] }),
  });
  const r400body = (await r400.json().catch(() => ({}))) as { error?: string; failedSeq?: number };
  check('E2b 400 names the offending seq', r400.status === 400 && r400body.failedSeq === 6, JSON.stringify(r400body));
}

// ---- E4: gap 409 carries expected/received + time token ----
{
  let threw = '';
  try {
    await postMutations(base, { deviceId: DEVICE_ID, mutations: [mut(9)] });
  } catch (e) {
    threw = String((e as Error).message ?? e);
  }
  check('E4 future hole 409s', /SEQUENCE_GAP_DETECTED/.test(threw), threw);
  check('E4 ledger untouched by gap batch', fx.gw.ledger().length === 5);
}

// ---- E5: replay dedupes (no double ledger) ----
{
  const res = await postMutations(base, { deviceId: DEVICE_ID, mutations: [1, 2, 3].map((s) => mut(s)) });
  check('E5 replay ACKs idempotently', JSON.stringify(res.ackSeqNos) === '[1,2,3]');
  check('E5 no double-insertion', fx.gw.ledger().length === 5);
}

// ---- E6: unknown + revoked devices 403 ----
{
  const r1 = await fetch(`${base}/api/v1/sync/ingest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-X', mutations: [mut(1)] }),
  });
  const r1body = (await r1.json().catch(() => ({}))) as { error?: string; deviceId?: string };
  check('E6 unknown device 403 DEVICE_NOT_ENROLLED', r1.status === 403 && r1body.error === 'DEVICE_NOT_ENROLLED' && r1body.deviceId === 'dev-X');
  fx.gw.setDeviceStatus(DEVICE_ID, 'revoked');
  const r2 = await fetch(`${base}/api/v1/sync/ingest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: DEVICE_ID, mutations: [mut(6)] }),
  });
  check('E6 revoked device 403', r2.status === 403);
  fx.gw.setDeviceStatus(DEVICE_ID, 'enrolled');
}

// ---- E7: token verifies against the gateway pubkey (native-checked bytes) ----
{
  const parts = String(token).split('.');
  check('E7 SERVERTIME_V1 envelope shape', parts[0] === 'SERVERTIME_V1' && parts.length === 3);
  const gwPub = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(publicKeyHexFromSeedHex(FIXTURE_GATEWAY_SEED), 'hex'),
  ]);
  const signed = Buffer.from(`MOBI-TIME-V1.${parts[0]}.${parts[1]}`, 'utf8');
  const okSig = verify(null, signed, createPublicKey({ key: gwPub, format: 'der', type: 'spki' }), Buffer.from(parts[2], 'base64url'));
  check('E7 gateway signature valid over domain-separated envelope', okSig);
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  check('E7 payload carries server_time_ms + expiry + nonce',
    Number.isInteger(payload.server_time_ms) && Number.isInteger(payload.expires_at_ms) && typeof payload.nonce === 'string');
  // Outside Tauri there is no IPC sink: the piggyback degrades to a logged
  // false, never a throw (native application is Rust-tested).
  const ingested = await ingestGatewayTimeToken(String(token));
  check('E7 ingest degrades gracefully outside Tauri', ingested === false);
}

await fx.close();
console.log('====================================================');
console.log(`DRAIN E2E SUMMARY: ${pass} PASSED, ${fail} FAILED`);
console.log('====================================================');
process.exit(fail === 0 ? 0 : 1);

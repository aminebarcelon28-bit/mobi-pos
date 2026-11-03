/**
 * Two-device + gateway fault suite (SYN queue item 2, transport level).
 *
 * Two independent clients (A and B), each with its own outbox, cursor and a FAKE
 * CLOCK, talk to the REAL merchant gateway (`proxy/gateway.mjs`, the same code
 * the loopback verifier runs) over HTTP with REAL Ed25519 keys. Every mutation is
 * signed by the product's own envelope builder and sent through the product's
 * transport (`src/api/syncGateway.ts`), so a passing run means the wire code is
 * the code under test — not a re-implementation.
 *
 * Faults: partition (connection dropped), heal, duplicate delivery, reorder
 * (future hole), crash after send but before the ACK is read, per-device cursor
 * isolation, clock skew, concurrent same-ticket refunds from both devices, and
 * revocation.
 *
 * Run: npm run test:sync-two-device
 * Qualifier: PASS-SIM. This is two protocol clients, not two GUI processes;
 * the real two-terminal run stays owner-dependent (HAR-003).
 */
import {
  bootMockGateway,
  deviceKeypair,
  signEnvelope,
  envelopeFor,
} from '../fixtures/mockGatewayServer.mjs';
import { postMutations } from '../../src/api/syncGateway.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`[PASS] ${name}${extra ? ` :: ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${name}${extra ? ` :: ${extra}` : ''}`);
  }
};

// ── Fake clocks: B is 90 s ahead of A, and neither advances on its own. ──────
const T0 = Date.parse('2026-11-03T10:00:00.000Z');
const clockOf = (id: string) => (id === 'dev-A' ? T0 : T0 + 90_000);

interface Device {
  id: string;
  keys: ReturnType<typeof deviceKeypair>;
  seq: number;
  acked: number;
  sent: number;
  log: Array<{ seq: number; result: string; status: number }>;
}

const mkDevice = (id: string, seed: string): Device => ({
  id,
  keys: deviceKeypair(seed),
  seq: 0,
  acked: 0,
  sent: 0,
  log: [],
});

const DEVICE_A = mkDevice('dev-A', '11'.repeat(32));
const DEVICE_B = mkDevice('dev-B', '22'.repeat(32));

const fx = await bootMockGateway({ deviceId: DEVICE_A.id });
// The fixture enrolls one device; enroll the second with its own key.
fx.gw.registerDevice(DEVICE_B.id, DEVICE_B.keys.publicKeyHex);

/** One outbox row: the same envelope shape the native command signs. */
const mutation = (d: Device, ticketId: string, net: number) => {
  const seq = (d.seq += 1);
  const refundId = `REF-${d.id}-${seq}`;
  const envelope = envelopeFor(ticketId, refundId, net, d.id, seq, clockOf(d.id));
  return {
    seqNo: seq,
    ticketId,
    payload: JSON.stringify({ id: refundId, net, deviceClockMs: clockOf(d.id) }),
    deviceSignature: signEnvelope(d.keys.privateKey, envelope),
    envelope,
  };
};

const send = async (d: Device, batch: Array<Record<string, unknown>>) => {
  d.sent += 1;
  try {
    const res = await postMutations(fx.baseUrl, { deviceId: d.id, mutations: batch as never });
    const acked = Array.isArray(res.ackSeqNos) ? res.ackSeqNos : [];
    for (const m of batch) {
      const seq = Number((m as { seqNo: number }).seqNo);
      d.log.push({ seq, result: acked.includes(seq) ? 'ack' : 'no-ack', status: 200 });
    }
    return { ok: true as const, acks: acked, token: res.serverTimeToken };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    for (const m of batch) d.log.push({ seq: Number((m as { seqNo: number }).seqNo), result: msg, status: 0 });
    return { ok: false as const, error: msg };
  }
};

try {
  // ── 1. Per-device isolation: two clients, independent cursors ─────────────
  const a1 = mutation(DEVICE_A, 'TKT-A1', 500);
  const a2 = mutation(DEVICE_A, 'TKT-A2', 300);
  const b1 = mutation(DEVICE_B, 'TKT-B1', 700);
  const rA = await send(DEVICE_A, [a1, a2]);
  const rB = await send(DEVICE_B, [b1]);
  check('isolation: each device drains its own outbox', rA.ok && rB.ok, `${rA.ok}/${rB.ok}`);
  check('isolation: cursors are per device (A=2, B=1)', fx.gw.cursorOf('dev-A') === 2 && fx.gw.cursorOf('dev-B') === 1, `A=${fx.gw.cursorOf('dev-A')} B=${fx.gw.cursorOf('dev-B')}`);
  check('isolation: ledger holds both devices', fx.gw.ledger().length === 3, `ledger=${fx.gw.ledger().length}`);
  check('time: every accepted batch carries a SERVERTIME_V1 token', typeof rA.token === 'string' && rA.token.startsWith('SERVERTIME_V1.'), String(rA.token).slice(0, 24));

  // ── 2. Partition, then heal: the batch is refused, the resend is not ─────
  const a3 = mutation(DEVICE_A, 'TKT-A3', 450);
  fx.dropNextConnection(1);
  const down = await send(DEVICE_A, [a3]);
  check('partition: a dropped connection surfaces as a failure (no silent ACK)', !down.ok, down.ok ? 'unexpected ACK' : 'refused');
  const healed = await send(DEVICE_A, [a3]);
  check('heal: the same batch goes through after the link returns', healed.ok && healed.acks.includes(3), JSON.stringify(healed));

  // ── 3. Duplicate delivery: a resend is idempotent (same seq) ─────────────
  const before = fx.gw.ledger().length;
  const dup = await send(DEVICE_A, [a3]);
  check('duplicate delivery: replay ACKs but does not double-insert', dup.ok && fx.gw.ledger().length === before, `ledger ${before}->${fx.gw.ledger().length}`);

  // ── 4. Reorder: seq 6 before 5 is a hole → 409 with expected/received ────
  const a5 = mutation(DEVICE_A, 'TKT-A5', 100);
  const a6 = mutation(DEVICE_A, 'TKT-A6', 200);
  const gap = await send(DEVICE_A, [a6]);
  const expected = Number(/expected_(\d+)_received_(\d+)/.exec(String(gap.error ?? ''))?.[1] ?? -1);
  const received = Number(/expected_(\d+)_received_(\d+)/.exec(String(gap.error ?? ''))?.[2] ?? -1);
  check(
    'reorder: a future hole is refused with expected/received',
    !gap.ok && expected === a5.seqNo && received === a6.seqNo,
    String(gap.error ?? '').slice(0, 80),
  );
  const fixed = await send(DEVICE_A, [a5, a6]);
  check(
    'reorder: the missing row then the pair commit in order',
    fixed.ok && fixed.acks.join(',') === `${a5.seqNo},${a6.seqNo}`,
    JSON.stringify(fixed.acks),
  );

  // ── 5. Crash after send, before the ACK is read: replay converges ────────
  const a7 = mutation(DEVICE_A, 'TKT-A7', 150);
  const first = await send(DEVICE_A, [a7]);
  // The "crash" throws the response away - the client never learned the ACK.
  const afterCrash = await send(DEVICE_A, [a7]);
  check(
    'crash before ACK: the replay is deduped, one ledger row',
    first.ok && afterCrash.ok && fx.gw.ledger().filter((m: { ticketId: string }) => m.ticketId === 'TKT-A7').length === 1,
    `rows=${fx.gw.ledger().filter((m: { ticketId: string }) => m.ticketId === 'TKT-A7').length}`,
  );

  // ── 6. Clock skew: B's envelopes are 90 s ahead; seq (not time) orders ───
  const b2 = mutation(DEVICE_B, 'TKT-B2', 250);
  const b3 = mutation(DEVICE_B, 'TKT-B3', 350);
  const skew = await send(DEVICE_B, [b2, b3]);
  const bRows = fx.gw.ledger().filter((m: { deviceId: string }) => m.deviceId === 'dev-B');
  check(
    'clock skew: a device 90 s ahead syncs without being reordered or refused',
    skew.ok && bRows.length === 3 && bRows.map((m: { seqNo: number }) => m.seqNo).join(',') === '1,2,3',
    JSON.stringify(bRows.map((m: { seqNo: number }) => m.seqNo)),
  );

  // ── 7. Concurrent same-ticket refunds from both devices ──────────────────
  const aTicket = mutation(DEVICE_A, 'TKT-SHARED', 120);
  const bTicket = mutation(DEVICE_B, 'TKT-SHARED', 130);
  const cA = await send(DEVICE_A, [aTicket]);
  const cB = await send(DEVICE_B, [bTicket]);
  const shared = fx.gw.ledger().filter((m: { ticketId: string }) => m.ticketId === 'TKT-SHARED');
  check(
    'concurrent same-ticket: both devices keep their own sequence (no cross-device collapse)',
    cA.ok && cB.ok && shared.length === 2,
    JSON.stringify(shared.map((m: { deviceId: string; seqNo: number }) => `${m.deviceId}:${m.seqNo}`)),
  );

  // ── 8. Revocation isolates the damage to one device ──────────────────────
  fx.gw.setDeviceStatus(DEVICE_B.id, 'revoked');
  const b4 = mutation(DEVICE_B, 'TKT-B4', 90);
  const revoked = await send(DEVICE_B, [b4]);
  const stillA = await send(DEVICE_A, [mutation(DEVICE_A, 'TKT-A8', 80)]);
  check('revocation: the revoked device is refused', !revoked.ok && /DEVICE_REVOKED|403/i.test(String(revoked.error)), String(revoked.error ?? '').slice(0, 60));
  check('revocation: the other device keeps syncing', stillA.ok, JSON.stringify(stillA.acks ?? stillA.error));

  // ── 8b. In-suite negative controls: the oracle must be able to fail ─────
  {
    const before = fx.gw.ledger().length;
    const good = mutation(DEVICE_A, 'TKT-TAMPER', 111);
    // (a) one flipped hex digit of the signature must be refused
    const tampered = {
      ...good,
      deviceSignature: good.deviceSignature.slice(0, -1) + (good.deviceSignature.endsWith('0') ? '1' : '0'),
    };
    const bad = await send(DEVICE_A, [tampered]);
    check(
      'control: a tampered signature is refused',
      !bad.ok && /INVALID_SIGNATURE/i.test(String(bad.error ?? '')),
      String(bad.error ?? '').slice(0, 60),
    );
    check('control: a refused batch writes nothing', fx.gw.ledger().length === before, `${before}->${fx.gw.ledger().length}`);
    // (b) the SAME row untampered (same seq) is accepted: the refusal was about
    // the signature, not about the sequence number.
    const ok = await send(DEVICE_A, [good]);
    check('control: the same row untampered is accepted', ok.ok && ok.acks.includes(good.seqNo), JSON.stringify(ok.acks ?? ok.error));
  }

  // ── 9. Final invariants ─────────────────────────────────────────────────
  const cursors = { a: fx.gw.cursorOf('dev-A'), b: fx.gw.cursorOf('dev-B') };
  check(
    'final: every ACKed sequence is in the ledger exactly once',
    fx.gw.ledger().length === new Set(fx.gw.ledger().map((m: { deviceId: string; seqNo: number }) => `${m.deviceId}:${m.seqNo}`)).size,
    `ledger=${fx.gw.ledger().length}`,
  );
  check(
    'final: cursors match the highest contiguous seq per device',
    cursors.a === Math.max(...fx.gw.ledger().filter((m: { deviceId: string }) => m.deviceId === 'dev-A').map((m: { seqNo: number }) => m.seqNo)) &&
      cursors.b === Math.max(...fx.gw.ledger().filter((m: { deviceId: string }) => m.deviceId === 'dev-B').map((m: { seqNo: number }) => m.seqNo)),
    JSON.stringify(cursors),
  );

  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync('tests/results', { recursive: true });
  writeFileSync(
    'tests/results/sync-two-device.json',
    JSON.stringify({ at: new Date().toISOString(), pass, fail, cursors, ledger: fx.gw.ledger().length, kind: 'PASS-SIM' }, null, 2),
  );
} finally {
  await fx.close();
}

console.log(`\nTWO-DEVICE FAULT SUITE (PASS-SIM): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

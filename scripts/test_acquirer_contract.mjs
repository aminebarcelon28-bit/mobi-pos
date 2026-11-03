#!/usr/bin/env node
/**
 * Mock-acquirer contract suite (dev-only fixture).
 *
 * Proves the acquirer simulator matches card practice for the cases the POS
 * harness needs: authorize/decline, partial capture, void-before-capture,
 * cumulative refunds with idempotent replay, signed callbacks with duplicate
 * delivery, and an unknown-outcome timeout reconciled by query.
 *
 * Usage: node scripts/test_acquirer_contract.mjs   (exit 0 = contract intact)
 */
import { createAcquirerServer, callbackSignature } from '../tests/fixtures/mockAcquirer.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

const gw = createAcquirerServer({ secret: 'contract-secret' });
const port = await gw.listen(0);
const base = `http://127.0.0.1:${port}`;
let n = 0;
const key = (p) => `${p}-${Date.now()}-${++n}`;
const post = async (path, body, opts = {}) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

try {
  const health = await fetch(`${base}/healthz`);
  check('healthz answers', health.status === 200);

  const bad = await post('/v1/authorize', { idempotencyKey: key('bad'), amountMinor: 0, currency: 'DZD', cardToken: 'tok_ok' });
  check('authorize rejects a non-positive integer amount', bad.status === 400);

  const authKey = key('auth');
  const approved = await post('/v1/authorize', { idempotencyKey: authKey, amountMinor: 1000, currency: 'DZD', cardToken: 'tok_ok' });
  check('authorize approves', approved.status === 200 && approved.body.status === 'authorized' && approved.body.authorizedMinor === 1000);
  const expectedSig = callbackSignature('contract-secret', {
    eventId: approved.body.paymentId,
    paymentId: approved.body.paymentId,
    status: 'authorized',
    amountMinor: 1000,
  });
  check('authorize signature verifies', approved.body.signature === expectedSig);
  const authId = approved.body.paymentId;

  const replay = await post('/v1/authorize', { idempotencyKey: authKey, amountMinor: 1000, currency: 'DZD', cardToken: 'tok_ok' });
  check('authorize replay returns the same payment', replay.body.replayed === true && replay.body.paymentId === authId);

  const declined = await post('/v1/authorize', { idempotencyKey: key('dec'), amountMinor: 500, currency: 'DZD', cardToken: 'tok_decline' });
  check('decline token yields 402 declined', declined.status === 402 && declined.body.status === 'declined');

  const cap = await post('/v1/capture', { authId, amountMinor: 600 });
  check('partial capture is allowed once', cap.status === 200 && cap.body.capturedMinor === 600 && cap.body.status === 'partially_captured');
  const capAgain = await post('/v1/capture', { authId, amountMinor: 100 });
  check('second capture is refused', capAgain.status === 409);

  const r1 = await post('/v1/refund', { paymentId: authId, amountMinor: 250, idempotencyKey: key('r1') });
  const r2 = await post('/v1/refund', { paymentId: authId, amountMinor: 250, idempotencyKey: key('r2') });
  const r3 = await post('/v1/refund', { paymentId: authId, amountMinor: 200, idempotencyKey: key('r3') });
  check('cumulative refunds stop at the captured amount', r1.status === 200 && r2.status === 200 && r3.status === 409);
  const r1Replay = await post('/v1/refund', { paymentId: authId, amountMinor: 250, idempotencyKey: r1.body.idempotencyKey });
  check('refund replay by key is one effect', r1Replay.body.replayed === true && r1Replay.body.refundId === r1.body.refundId);

  const voidCaptured = await post('/v1/void', { authId });
  check('captured payment cannot be voided', voidCaptured.status === 409);
  const fresh = await post('/v1/authorize', { idempotencyKey: key('v'), amountMinor: 300, currency: 'DZD', cardToken: 'tok_ok' });
  const voided = await post('/v1/void', { authId: fresh.body.paymentId });
  check('uncaptured payment can be voided', voided.status === 200 && voided.body.status === 'voided');

  const event = { eventId: `EV-${Date.now()}`, paymentId: authId, status: 'refunded', amountMinor: 500 };
  const signed = { ...event, signature: callbackSignature('contract-secret', event) };
  const cb1 = await post('/v1/_simulate/callback', signed);
  const cb2 = await post('/v1/_simulate/callback', signed);
  check('signed callback accepted once, duplicate acknowledged', cb1.body.accepted === true && cb1.body.duplicate === false && cb2.body.duplicate === true);
  const cbBad = await post('/v1/_simulate/callback', { ...event, eventId: `${event.eventId}-bad`, signature: '00' });
  check('bad callback signature is refused', cbBad.status === 401);

  const timeoutKey = key('timeout');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 80);
  let timedOut = false;
  try {
    await post('/v1/authorize', { idempotencyKey: timeoutKey, amountMinor: 700, currency: 'DZD', cardToken: 'tok_timeout' }, { signal: ctrl.signal });
  } catch {
    timedOut = true;
  } finally {
    clearTimeout(timer);
  }
  await new Promise((r) => setTimeout(r, 500));
  const reconciled = await fetch(`${base}/v1/payments?idempotencyKey=${encodeURIComponent(timeoutKey)}`).then((r) => r.json());
  check(
    'unknown outcome (timeout) is reconciled by query',
    timedOut && reconciled.authorizedMinor === 700 && reconciled.capturedMinor === 0,
    JSON.stringify(reconciled),
  );
} finally {
  await gw.close();
}

console.log(`\nACQUIRER CONTRACT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

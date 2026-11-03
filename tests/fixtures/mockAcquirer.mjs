/**
 * Mock card acquirer (dev/test fixture — never shipped).
 *
 * Contract exercised by `scripts/test_acquirer_contract.mjs`:
 *   POST /v1/authorize      {idempotencyKey, amountMinor, currency, cardToken}
 *   POST /v1/capture        {authId, amountMinor}
 *   POST /v1/void           {authId}
 *   POST /v1/refund         {paymentId, amountMinor, idempotencyKey}
 *   GET  /v1/payments/:id   (or ?idempotencyKey=) — reconcile an unknown outcome
 *   POST /v1/_simulate/callback {eventId, paymentId, status, amountMinor, signature}
 *   GET  /healthz
 *
 * Rules modelled on card-acquirer practice:
 *  - integer minor units only (santim); currency fixed by the fixture (DZD);
 *  - authorization -> (partial) capture -> refunds up to the captured amount,
 *    cumulative; void only before capture; over-capture/over-refund 409;
 *  - idempotency keys make authorize/refund replay-safe (same key => same
 *    object, no second effect);
 *  - callbacks are HMAC-SHA256 signed and deduped by eventId (late/duplicate
 *    delivery is acknowledged, never applied twice);
 *  - `tok_decline` declines, `tok_timeout` answers after a delay (a caller with
 *    a short timeout observes "unknown outcome" and reconciles via GET).
 *
 * Zero dependencies (node:http, node:crypto). No network beyond loopback.
 */
import http from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const DEFAULT_SECRET = 'dev-acquirer-secret-not-for-production';

export const callbackSignature = (secret, event) =>
  createHmac('sha256', secret)
    .update(`${event.eventId}|${event.paymentId}|${event.status}|${event.amountMinor}`)
    .digest('hex');

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

const bad = (res, why) => json(res, 400, { error: why });

export function createAcquirerServer({ secret = DEFAULT_SECRET } = {}) {
  const payments = new Map(); // authId -> state
  const byIdem = new Map(); // idempotencyKey -> authId
  const refunds = new Map(); // paymentId -> [{refundId, amountMinor, idempotencyKey}]
  const refundByKey = new Map(); // refund idempotencyKey -> refund
  const callbacks = new Map(); // eventId -> {status, amountMinor}

  const publicState = (p) => ({
    paymentId: p.authId,
    status: p.status,
    authorizedMinor: p.authorizedMinor,
    capturedMinor: p.capturedMinor,
    refundedMinor: (refunds.get(p.authId) ?? []).reduce((s, r) => s + r.amountMinor, 0),
    currency: p.currency,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'POST' && url.pathname === '/v1/authorize') {
      const body = await readJson(req);
      if (!body) return bad(res, 'invalid json');
      const amount = Number(body.amountMinor);
      if (!Number.isInteger(amount) || amount <= 0) return bad(res, 'amountMinor must be a positive integer');
      if (body.currency && body.currency !== 'DZD') return bad(res, 'unsupported currency');
      const key = String(body.idempotencyKey ?? '').trim();
      if (!key) return bad(res, 'idempotencyKey required');
      if (byIdem.has(key)) {
        const p = payments.get(byIdem.get(key));
        return json(res, 200, { ...publicState(p), replayed: true });
      }
      const token = String(body.cardToken ?? '');
      if (token === 'tok_timeout') await new Promise((r) => setTimeout(r, 400));
      const declined = token === 'tok_decline';
      const auth = {
        authId: `AUTH-${randomUUID()}`,
        authorizedMinor: amount,
        capturedMinor: 0,
        currency: 'DZD',
        status: declined ? 'declined' : 'authorized',
      };
      payments.set(auth.authId, auth);
      byIdem.set(key, auth.authId);
      const state = publicState(auth);
      return json(res, declined ? 402 : 200, {
        ...state,
        signature: callbackSignature(secret, {
          eventId: auth.authId,
          paymentId: auth.authId,
          status: auth.status,
          amountMinor: auth.authorizedMinor,
        }),
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/capture') {
      const body = await readJson(req);
      if (!body) return bad(res, 'invalid json');
      const p = payments.get(String(body.authId ?? ''));
      if (!p) return json(res, 404, { error: 'unknown auth' });
      if (p.status !== 'authorized') return json(res, 409, { error: `not capturable (${p.status})` });
      const amount = Number(body.amountMinor);
      if (!Number.isInteger(amount) || amount <= 0) return bad(res, 'amountMinor must be a positive integer');
      if (p.capturedMinor > 0) return json(res, 409, { error: 'already captured' });
      if (amount > p.authorizedMinor) return json(res, 409, { error: 'over-capture' });
      p.capturedMinor = amount;
      p.status = amount === p.authorizedMinor ? 'captured' : 'partially_captured';
      return json(res, 200, publicState(p));
    }

    if (req.method === 'POST' && url.pathname === '/v1/void') {
      const body = await readJson(req);
      const p = payments.get(String(body?.authId ?? ''));
      if (!p) return json(res, 404, { error: 'unknown auth' });
      if (p.capturedMinor > 0) return json(res, 409, { error: 'captured payment cannot be voided' });
      if (p.status === 'voided') return json(res, 200, { ...publicState(p), replayed: true });
      p.status = 'voided';
      return json(res, 200, publicState(p));
    }

    if (req.method === 'POST' && url.pathname === '/v1/refund') {
      const body = await readJson(req);
      if (!body) return bad(res, 'invalid json');
      const p = payments.get(String(body.paymentId ?? ''));
      if (!p) return json(res, 404, { error: 'unknown payment' });
      const amount = Number(body.amountMinor);
      if (!Number.isInteger(amount) || amount <= 0) return bad(res, 'amountMinor must be a positive integer');
      const key = String(body.idempotencyKey ?? '').trim();
      if (!key) return bad(res, 'idempotencyKey required');
      if (refundByKey.has(key)) {
        return json(res, 200, { ...refundByKey.get(key), replayed: true });
      }
      const done = (refunds.get(p.authId) ?? []).reduce((s, r) => s + r.amountMinor, 0);
      if (p.capturedMinor <= 0) return json(res, 409, { error: 'nothing captured to refund' });
      if (done + amount > p.capturedMinor) return json(res, 409, { error: 'over-refund' });
      const refund = { refundId: `RFD-${randomUUID()}`, paymentId: p.authId, amountMinor: amount, idempotencyKey: key };
      refunds.set(p.authId, [...(refunds.get(p.authId) ?? []), refund]);
      refundByKey.set(key, refund);
      return json(res, 200, refund);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/payments/')) {
      const id = decodeURIComponent(url.pathname.slice('/v1/payments/'.length));
      const p = payments.get(id);
      if (!p) return json(res, 404, { error: 'unknown payment' });
      return json(res, 200, publicState(p));
    }
    if (req.method === 'GET' && url.pathname === '/v1/payments') {
      const key = url.searchParams.get('idempotencyKey') ?? '';
      const p = payments.get(byIdem.get(key));
      if (!p) return json(res, 404, { error: 'unknown idempotencyKey' });
      return json(res, 200, publicState(p));
    }

    if (req.method === 'POST' && url.pathname === '/v1/_simulate/callback') {
      const body = await readJson(req);
      if (!body) return bad(res, 'invalid json');
      const event = {
        eventId: String(body.eventId ?? ''),
        paymentId: String(body.paymentId ?? ''),
        status: String(body.status ?? ''),
        amountMinor: Number(body.amountMinor ?? 0),
      };
      if (!event.eventId || !event.paymentId) return bad(res, 'eventId/paymentId required');
      const expected = callbackSignature(secret, event);
      const got = String(body.signature ?? '');
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(got, 'hex');
      if (a.length !== b.length || !timingSafeEqual(a, b)) return json(res, 401, { error: 'bad signature' });
      if (callbacks.has(event.eventId)) return json(res, 200, { accepted: true, duplicate: true });
      callbacks.set(event.eventId, event);
      return json(res, 200, { accepted: true, duplicate: false });
    }

    return json(res, 404, { error: 'not found' });
  });

  return {
    server,
    secret,
    async listen(port = 0) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return server.address().port;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

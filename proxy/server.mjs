// Minimal sync-token broker (RUN ON YOUR SERVER, never in the POS app).
// POST /api/sync-token  { "deviceId": "uuid" }  ->  { url, token, expiresAt }
// Env: TURSO_URL, TURSO_AUTH_TOKEN, TOKEN_TTL_SECONDS=3600, ALLOW_ORIGIN=*,
//      PORT=8787, BROKER_SECRET (REQUIRED in production), ALLOWED_DEVICES=uuid1,uuid2
//
// SECURITY (B-041, 2026-09-23):
// - Requires Authorization: Bearer <BROKER_SECRET> (or x-broker-secret header)
//   when BROKER_SECRET is set. Empty secret in production is a hard 500.
// - Optional device allow-list via ALLOWED_DEVICES (comma-separated). If set,
//   only listed deviceIds may obtain a token.
// - In-memory sliding-window rate limit per client IP (default 30/min).
// - Still returns TURSO_AUTH_TOKEN (master) — prefer Turso per-device tokens
//   when available; this broker is the interim hardening before that lands.

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Self-load .env beside this file (so `node server.mjs` just works).
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
  console.warn('[sync-broker] Could not read local .env file:', err);
}

const PORT = Number(process.env.PORT ?? 8787);
const TURSO_URL = process.env.TURSO_URL ?? '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN ?? '';
const TTL = Number(process.env.TOKEN_TTL_SECONDS ?? 3600);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'http://localhost:5173';
const BROKER_SECRET = process.env.BROKER_SECRET ?? '';
const ALLOWED_DEVICES = new Set(
  (process.env.ALLOWED_DEVICES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 30);
const NODE_ENV = process.env.NODE_ENV ?? 'development';

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': ALLOW_ORIGIN,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-broker-secret',
  });
  res.end(body);
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/** Simple in-memory sliding-window rate limit: key -> timestamps (ms). */
const rateBuckets = new Map();
function rateLimited(key) {
  const now = Date.now();
  const windowMs = 60_000;
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= RATE_LIMIT_PER_MIN) {
    rateBuckets.set(key, arr);
    return true;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return false;
}

function checkAuth(req) {
  if (!BROKER_SECRET) {
    // Fail closed outside bare local development.
    if (NODE_ENV === 'production') {
      return { ok: false, reason: 'BROKER_SECRET not configured (production)' };
    }
    console.warn('[sync-broker] BROKER_SECRET unset — allowing in development only');
    return { ok: true, devOpen: true };
  }
  const auth = req.headers.authorization || '';
  const headerSecret = req.headers['x-broker-secret'];
  const presented =
    (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7).trim()
      : '') ||
    (typeof headerSecret === 'string' ? headerSecret.trim() : '');
  if (!presented || presented !== BROKER_SECRET) {
    return { ok: false, reason: 'invalid broker secret' };
  }
  return { ok: true, devOpen: false };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/api/sync-token') {
    return send(res, 404, { error: 'not found' });
  }

  const ip = clientIp(req);
  if (rateLimited(`ip:${ip}`)) {
    console.warn(`[sync-broker] rate-limit hit ip=${ip}`);
    return send(res, 429, { error: 'rate limit' });
  }

  const auth = checkAuth(req);
  if (!auth.ok) {
    console.warn(`[sync-broker] auth deny ip=${ip} reason=${auth.reason}`);
    return send(res, 401, { error: 'unauthorized' });
  }

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let deviceId = '';
    try {
      const parsed = JSON.parse(raw || '{}');
      deviceId = parsed.deviceId ?? '';
    } catch {
      return send(res, 400, { error: 'Format JSON invalide' });
    }
    if (!deviceId || typeof deviceId !== 'string') return send(res, 400, { error: 'deviceId required' });
    if (ALLOWED_DEVICES.size > 0 && !ALLOWED_DEVICES.has(deviceId)) {
      console.warn(`[sync-broker] device deny ip=${ip} device=${deviceId}`);
      return send(res, 403, { error: 'device not allowed' });
    }
    if (!TURSO_URL || !TURSO_AUTH_TOKEN) return send(res, 500, { error: 'broker not configured' });
    console.log(`[sync-broker] device=${deviceId} ttl=${TTL}s ip=${ip}`);
    return send(res, 200, {
      url: TURSO_URL,
      token: TURSO_AUTH_TOKEN,
      expiresAt: new Date(Date.now() + TTL * 1000).toISOString(),
    });
  });
});

server.listen(PORT, () => {
  console.log(`[sync-broker] listening :${PORT}`);
  console.log(
    `[sync-broker] auth=${BROKER_SECRET ? 'secret-required' : 'OPEN (dev only)'} ` +
      `allowlist=${ALLOWED_DEVICES.size || 'off'} rate=${RATE_LIMIT_PER_MIN}/min`
  );
});

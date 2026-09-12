// Minimal sync-token broker (RUN ON YOUR SERVER, never in the POS app).
// POST /api/sync-token  { "deviceId": "uuid" }  ->  { url, token, expiresAt }
// Env: TURSO_URL, TURSO_AUTH_TOKEN, TOKEN_TTL_SECONDS=3600, ALLOW_ORIGIN=*, PORT=8787.
//
// SECURITY: the POS app never embeds TURSO_AUTH_TOKEN. This broker holds the
// long-lived token server-side and hands short-lived copies to known devices.
// Production hardening (do before pilot): check deviceId allow-list, rate-limit,
// audit-log issuance, and prefer Turso per-device tokens with short TTL.

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

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': ALLOW_ORIGIN,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/api/sync-token') {
    return send(res, 404, { error: 'not found' });
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
    if (!TURSO_URL || !TURSO_AUTH_TOKEN) return send(res, 500, { error: 'broker not configured' });
    console.log(`[sync-token] device=${deviceId} ttl=${TTL}s`);
    return send(res, 200, {
      url: TURSO_URL,
      token: TURSO_AUTH_TOKEN,
      expiresAt: new Date(Date.now() + TTL * 1000).toISOString(),
    });
  });
});

server.listen(PORT, () => console.log(`[sync-broker] listening :${PORT}`));

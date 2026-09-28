#!/usr/bin/env node
/**
 * MobiPOS — Local Licensing Server (Zero-Dependency)
 * Serves /api/v1/license/activate for instant local or LAN activation without Cloudflare deployment.
 *
 * Usage:
 *   node scripts/license-server.mjs [--port 8787]
 *   npm run license:server
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT_DIR, 'licenses_ledger.json');
const ENV_PATH = path.join(ROOT_DIR, '.env.licensing');

// 1. Auto-load .env.licensing
function loadEnv() {
  const envCandidates = [
    ENV_PATH,
    path.join(ROOT_DIR, '.env'),
    path.join(ROOT_DIR, 'workers', 'licensing', '.dev.vars'),
  ];
  for (const p of envCandidates) {
    if (fs.existsSync(p)) {
      try {
        const text = fs.readFileSync(p, 'utf8');
        for (const line of text.split('\n')) {
          const t = line.trim();
          if (!t || t.startsWith('#')) continue;
          const eq = t.indexOf('=');
          if (eq > 0) {
            const k = t.slice(0, eq).trim();
            let v = t.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
              v = v.slice(1, -1);
            }
            if (!process.env[k]) process.env[k] = v;
          }
        }
      } catch {}
    }
  }
}

loadEnv();

function bytesToBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function utf8ToBase64Url(str) {
  return bytesToBase64Url(Buffer.from(str, 'utf8'));
}

async function signToken(payload, privateJwk) {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'Ed25519' },
    false,
    ['sign']
  );

  const header = { alg: 'EdDSA', typ: 'JWT' };
  const headerB64 = utf8ToBase64Url(JSON.stringify(header));
  const payloadB64 = utf8ToBase64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sigBytes = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    Buffer.from(signingInput, 'utf8')
  );

  const sigB64 = bytesToBase64Url(new Uint8Array(sigBytes));
  return `${signingInput}.${sigB64}`;
}

function normalizeKey(key) {
  return (key || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function getLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  } catch {
    return [];
  }
}

const PORT = parseInt(process.env.LICENSE_PORT || '8787', 10);

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Health
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'mobi-licensing-local', timestamp: new Date().toISOString() }));
    return;
  }

  // Activation Endpoint
  if (req.method === 'POST' && (url.pathname === '/api/v1/license/activate' || url.pathname === '/api/license/activate')) {
    let bodyText = '';
    req.on('data', (chunk) => {
      bodyText += chunk;
    });

    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyText);
        const { license_key, device_id, device_type = 'desktop', friendly_name, client_nonce } = body;

        if (!license_key || !device_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'MISSING_FIELDS', message: 'Clé de licence ou identifiant appareil manquant.' }));
          return;
        }

        const normalizedInput = normalizeKey(license_key);
        const ledger = getLedger();
        const match = ledger.find((l) => normalizeKey(l.licenseKey) === normalizedInput);

        if (!match) {
          console.warn(`[license-server] ❌ Clé inconnue reçue: ${license_key}`);
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'INVALID_LICENSE', message: `Clé de licence ${license_key} introuvable dans le registre local.` }));
          return;
        }

        // Get Ed25519 Private JWK
        let privateJwk;
        try {
          privateJwk = JSON.parse(process.env.LICENSE_ED25519_PRIVATE_JWK);
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CONFIG_ERROR', message: 'Clé privée Ed25519 absente de .env.licensing' }));
          return;
        }

        const now = Math.floor(Date.now() / 1000);
        let exp = 0;
        if (match.type === '24H') exp = now + 86400;
        else if (match.type === '90D') exp = now + 90 * 86400;

        const payload = {
          iss: 'http://127.0.0.1:8787',
          sub: match.customer || 'Client MobiPOS',
          iat: now,
          nbf: now - 60,
          exp,
          jti: `jti_${crypto.randomUUID()}`,
          lic_key: match.licenseKey,
          lic_type: match.type || 'LIFETIME',
          device_id,
          device_type,
          max_desktops: match.desktops || 1,
          max_mobiles: match.mobiles || 2,
          grace_days: 7,
          nonce: client_nonce,
          server_ts: now,
          turso_url: match.tursoUrl || '',
          turso_token: match.tursoToken || match.encryptedTursoToken || '',
        };

        const token = await signToken(payload, privateJwk);

        console.log(`[license-server] ✅ Activation réussie pour "${match.customer}" (${match.licenseKey}) -> Appareil: ${device_id.slice(0, 8)}...`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            token,
            turso_url: match.tursoUrl || '',
            turso_token: match.tursoToken || match.encryptedTursoToken || '',
            message: 'Licence activée avec succès !',
          })
        );
      } catch (err) {
        console.error('[license-server] Erreur traitement requête:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'SERVER_ERROR', message: err.message }));
      }
    });
    return;
  }

  // Deactivate
  if (req.method === 'POST' && url.pathname.includes('/deactivate')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Désactivation effectuée.' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'NOT_FOUND' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================================================');
  console.log(`⚡ MOBIPOS LOCAL LICENSING SERVER ACTIF SUR : http://localhost:${PORT}`);
  console.log('========================================================================');
  console.log(`  🌐 Route d'activation : http://localhost:${PORT}/api/v1/license/activate`);
  console.log(`  📋 Registre chargé    : ${LEDGER_PATH}`);
  console.log('  💡 Vos caisses et téléphones locaux peuvent maintenant s’activer');
  console.log('     automatiquement avec leurs clés sans configuration Cloudflare.');
  console.log('========================================================================\n');
});

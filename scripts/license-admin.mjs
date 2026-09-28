#!/usr/bin/env node
/**
 * MobiPOS — Professional Licensing Operations & Customer Minting CLI
 *
 * Usage:
 *   Interactive Wizard : npm run license:mint  (or node scripts/license-admin.mjs mint --interactive)
 *   Direct Command     : node scripts/license-admin.mjs mint --customer "Superette Central" --type LIFETIME --desktops 2 --mobiles 3
 *   Activate Local PC  : npm run license:activate-local  (or node scripts/license-admin.mjs activate-local [--key MOBI-LIFE-...])
 *   Generate Token     : npm run license:token  (or node scripts/license-admin.mjs token --key MOBI-... [--hwid MOBI-...])
 *   List Issued Keys   : npm run license:list  (or node scripts/license-admin.mjs list)
 *   Key Ceremony       : node scripts/license-admin.mjs generate-keys
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT_DIR, 'licenses_ledger.json');
const CLOUD_LICENSING_ENDPOINT = process.env.LICENSING_ENDPOINT || 'https://mobi-licensing.aminebarcelon28.workers.dev';

// 1. Auto-load .env.licensing or .env if present
function loadEnv() {
  const candidates = [
    path.join(ROOT_DIR, '.env.licensing'),
    path.join(ROOT_DIR, '.env'),
    path.join(ROOT_DIR, 'workers', 'licensing', '.dev.vars'),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const key = trimmed.slice(0, eq).trim();
            let val = trimmed.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      } catch {
        // Continue
      }
    }
  }
}

loadEnv();

// Crockford Base32 alphabet (excludes I, L, O, U)
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateRandomCrockford(length = 4) {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CROCKFORD_ALPHABET[bytes[i] % CROCKFORD_ALPHABET.length];
  }
  return result;
}

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

async function encryptToken(plaintext, masterKeyB64) {
  const rawKey = Buffer.from(masterKeyB64, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', rawKey, iv);
  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();

  const packed = Buffer.concat([iv, encrypted, tag]);
  return `v1:${packed.toString('base64')}`;
}

async function decryptToken(envelope, masterKeyB64) {
  if (!envelope || !envelope.startsWith('v1:')) {
    return envelope;
  }
  const rawKey = Buffer.from(masterKeyB64, 'base64');
  const packed = Buffer.from(envelope.slice(3), 'base64');
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(packed.length - 16);
  const ciphertext = packed.subarray(12, packed.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', rawKey, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertext, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function hashKey(rawKey, pepper) {
  const normalized = rawKey.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  return crypto.createHmac('sha256', pepper).update(normalized).digest('hex');
}

function normalizeKey(key) {
  return (key || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function recordInLedger(entry) {
  try {
    let ledger = [];
    if (fs.existsSync(LEDGER_PATH)) {
      ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    }
    const existingIdx = ledger.findIndex((l) => l.id === entry.id || normalizeKey(l.licenseKey) === normalizeKey(entry.licenseKey));
    if (existingIdx >= 0) {
      ledger[existingIdx] = { ...ledger[existingIdx], ...entry };
    } else {
      ledger.push(entry);
    }
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf8');
  } catch (err) {
    console.warn('Impossible de mettre à jour licenses_ledger.json:', err);
  }
}

function getLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Detects the local hardware ID on Windows / desktop
 */
function detectLocalHwid() {
  const salt = 'mobi-pos-license-salt-v1:';
  try {
    const guidOutput = execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', {
      stdio: ['pipe', 'pipe', 'ignore'],
    }).toString();
    const guidMatch = guidOutput.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
    const guid = guidMatch ? guidMatch[1].trim() : 'UNKNOWN_WINDOWS_GUID';

    let board = 'GENERIC_BOARD';
    try {
      const boardOutput = execSync('reg query HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS /v BaseBoardProduct', {
        stdio: ['pipe', 'pipe', 'ignore'],
      }).toString();
      const boardMatch = boardOutput.match(/BaseBoardProduct\s+REG_SZ\s+(.+)/i);
      if (boardMatch) board = boardMatch[1].trim();
    } catch {}

    const raw = `win:${guid}:${board}`;
    const hash = crypto.createHash('sha256').update(salt).update(raw).digest('hex');
    const u = hash.toUpperCase();
    const formatted = `MOBI-${u.slice(0, 4)}-${u.slice(4, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}`;
    return { hash, formatted, platform: 'windows' };
  } catch {
    const fallback = crypto.randomBytes(16).toString('hex');
    return { hash: fallback, formatted: `MOBI-WEB-${fallback.slice(0, 8).toUpperCase()}`, platform: 'fallback' };
  }
}

async function signLicenseJwt(payload, privateJwk) {
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

// Interactive Prompt Helper
function askQuestion(query, defaultVal = '') {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const promptText = defaultVal ? `${query} [${defaultVal}]: ` : `${query}: `;
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

async function runInteractiveMint() {
  console.clear();
  console.log('========================================================================');
  console.log('✨ MOBIPOS — ASSISTANT DE CRÉATION DE LICENCE PROFESSIONNELLE');
  console.log('========================================================================\n');

  const customer = await askQuestion('👤 Nom du Client / Établissement', 'Superette Al-Amine');

  console.log('\n📌 Type de Licence :');
  console.log('   [1] LIFETIME  — Licence Définitive / Illimitée à Vie (Recommandé)');
  console.log('   [2] 90D       — Abonnement Trimestriel (3 Mois)');
  console.log('   [3] 24H       — Démo d’Évaluation (24 Heures)');
  const typeChoice = await askQuestion('Votre choix (1, 2 ou 3)', '1');

  let type = 'LIFETIME';
  if (typeChoice === '2') type = '90D';
  if (typeChoice === '3') type = '24H';

  const desktops = await askQuestion('🖥️  Nombre de Postes Caisses (PC Windows / Desktop)', '1');
  const mobiles = await askQuestion('📱 Nombre de Téléphones Compagnons (Android)', '2');

  console.log('\n☁️  Base de données Cloud (Turso BYODB) [Optionnel] :');
  console.log('   Si le client ouvre son propre compte Turso, appuyez simplement sur Entrée.');
  const tursoUrl = await askQuestion('URL Turso (laisser vide si géré par le client)', '');
  let tursoToken = '';
  if (tursoUrl) {
    tursoToken = await askQuestion('Jeton (Auth Token) Turso du client', '');
  }

  const result = await executeMint({
    customer,
    type,
    desktops: parseInt(desktops, 10),
    mobiles: parseInt(mobiles, 10),
    'turso-url': tursoUrl,
    'turso-token': tursoToken,
  });

  const activateNow = await askQuestion('\n💻 Souhaitez-vous activer cette machine locale immédiatement ? (O/n)', 'O');
  if (activateNow.trim().toUpperCase() === 'O') {
    await executeActivateLocal({ key: result.licenseKey });
  }
}

async function executeMint(args) {
  const type = (args.type || 'LIFETIME').toUpperCase();
  const customer = args.customer || 'Client MobiPOS';
  const desktops = parseInt(args.desktops || '1', 10);
  const mobiles = parseInt(args.mobiles || '2', 10);
  const tursoUrl = args['turso-url'] || '';
  const tursoToken = args['turso-token'] || '';

  const masterKey =
    args['master-key'] ||
    process.env.MASTER_ENCRYPTION_KEY ||
    'zuYAeOahzvQXtv+Ib20DWmUQxiPxSkSMY8PgMzV9X28=';

  const pepper =
    args.pepper ||
    process.env.LICENSE_PEPPER ||
    '8151b8bd90b28fd747511025fa6d38625515e57aca46dcb75841383cd0f0bf58';

  let typeTag = 'LIFE';
  let expiresAt = null;
  const now = new Date();

  if (type === '24H' || type === '1_DAY') {
    typeTag = '24H';
    expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  } else if (type === '90D' || type === '3_MONTHS') {
    typeTag = '90D';
    expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
  } else if (type === 'LIFETIME') {
    typeTag = 'LIFE';
    expiresAt = null;
  }

  const p1 = generateRandomCrockford(4);
  const p2 = generateRandomCrockford(4);
  const licenseKey = `MOBI-${typeTag}-${p1}-${p2}`;
  const keyHash = hashKey(licenseKey, pepper);
  const encryptedTursoToken = tursoToken ? await encryptToken(tursoToken, masterKey) : 'NONE';

  const licId = `lic_${crypto.randomUUID()}`;
  const nowIso = now.toISOString();

  // Save in local audit ledger
  recordInLedger({
    id: licId,
    customer,
    licenseKey,
    type,
    desktops,
    mobiles,
    tursoUrl,
    encryptedTursoToken,
    createdAt: nowIso,
    expiresAt,
  });

  const sqlInsert = `
INSERT INTO licenses (
  id, key_hash, customer_name, license_type, status,
  max_desktops, max_mobiles, encrypted_turso_token, turso_url,
  created_at, updated_at, expires_at
) VALUES (
  '${licId}',
  '${keyHash}',
  '${customer.replace(/'/g, "''")}',
  '${type}',
  'active',
  ${desktops},
  ${mobiles},
  '${encryptedTursoToken}',
  '${tursoUrl}',
  '${nowIso}',
  '${nowIso}',
  ${expiresAt ? `'${expiresAt}'` : 'NULL'}
);`.trim();

  // 1. Automatic push to Cloudflare Worker Master DB
  let insertedDirectly = false;
  try {
    const cloudRes = await fetch(`${CLOUD_LICENSING_ENDPOINT}/api/v1/admin/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${masterKey}`,
      },
      body: JSON.stringify({
        id: licId,
        key_hash: keyHash,
        customer_name: customer,
        license_type: type,
        status: 'active',
        max_desktops: desktops,
        max_mobiles: mobiles,
        encrypted_turso_token: encryptedTursoToken,
        turso_url: tursoUrl,
        created_at: nowIso,
        expires_at: expiresAt,
      }),
    });
    if (cloudRes.ok) {
      insertedDirectly = true;
    }
  } catch {}

  // 2. Direct LibSQL client fallback (if configured in env)
  if (!insertedDirectly && process.env.MASTER_TURSO_URL && process.env.MASTER_TURSO_TOKEN) {
    try {
      const { createClient } = await import('@libsql/client');
      const db = createClient({
        url: process.env.MASTER_TURSO_URL,
        authToken: process.env.MASTER_TURSO_TOKEN,
      });
      await db.execute(sqlInsert);
      insertedDirectly = true;
    } catch {}
  }

  console.log('\n========================================================================');
  console.log('🎉 CLÉ DE LICENCE GÉNÉRÉE AVEC SUCCÈS');
  console.log('========================================================================\n');
  console.log(`  👤 Client / Magasin   : \x1b[1m${customer}\x1b[0m`);
  console.log(`  🔑 Clé d'Activation   : \x1b[32m\x1b[1m${licenseKey}\x1b[0m`);
  console.log(`  📌 Type de Licence    : ${type === 'LIFETIME' ? 'Illimitée à Vie' : type}`);
  console.log(`  ⏳ Expiration         : ${expiresAt ? new Date(expiresAt).toLocaleString('fr-DZ') : 'Illimitée (À Vie)'}`);
  console.log(`  🖥️  Postes Caisses PC  : ${desktops} poste(s) autorisé(s)`);
  console.log(`  📱 Mobiles Compagnons : ${mobiles} smartphone(s) autorisé(s)`);
  console.log(`  ☁️  Base Cloud Turso  : ${tursoUrl || 'Gérée par le client'}`);
  if (insertedDirectly) {
    console.log(`  ⚡ Statut Serveur     : \x1b[32m\x1b[1mActivée en direct sur le serveur mondial Cloudflare !\x1b[0m`);
  } else {
    console.log(`  ⚡ Statut Serveur     : Synchronisation Cloud en attente`);
  }
  if (!insertedDirectly) {
    console.log('\n------------------------------------------------------------------------');
    console.log('📄 SQL DDL INSERT (À exécuter dans Turso si vous n\'avez pas Internet) :');
    console.log('------------------------------------------------------------------------');
    console.log(sqlInsert);
  }
  console.log('\n------------------------------------------------------------------------');
  console.log('💬 MESSAGE WHATSAPP / SMS PRÊT À ENVOYER AU CLIENT :');
  console.log('------------------------------------------------------------------------');
  console.log(`
Bonjour ${customer},

Votre licence MobiPOS est prête et activée ! 🎉

🔑 Votre Clé d'Activation : *${licenseKey}*
📌 Formule : ${type === 'LIFETIME' ? 'Licence Illimitée à Vie' : `Licence ${type}`}
🖥️ Postes Caisses autorisés : ${desktops}
📱 Mobiles compagnons autorisés : ${mobiles}

👉 *Instructions d'activation :*
1. Lancez l'application MobiPOS sur votre poste de caisse ou smartphone.
2. Entrez votre clé : *${licenseKey}*
3. Cliquez sur "Activer la Licence".

Vos données et votre synchronisation cloud sont prêtes et 100% sécurisées.
Merci pour votre confiance !
L'équipe MobiPOS
  `.trim());
  console.log('\n========================================================================\n');

  return { licenseKey, customer, type, desktops, mobiles, tursoUrl };
}

/**
 * Synchronizes all local ledger licenses to the Cloud Master Turso DB
 */
async function executeSyncAll() {
  const ledger = getLedger();
  if (ledger.length === 0) {
    console.log('\nAucune licence locale dans le registre.');
    return;
  }
  const masterKey = process.env.MASTER_ENCRYPTION_KEY || 'zuYAeOahzvQXtv+Ib20DWmUQxiPxSkSMY8PgMzV9X28=';
  const pepper = process.env.LICENSE_PEPPER || '8151b8bd90b28fd747511025fa6d38625515e57aca46dcb75841383cd0f0bf58';

  const payload = {
    licenses: ledger.map((l) => ({
      id: l.id,
      key_hash: hashKey(l.licenseKey, pepper),
      customer_name: l.customer,
      license_type: l.type,
      status: 'active',
      max_desktops: l.desktops,
      max_mobiles: l.mobiles,
      encrypted_turso_token: l.encryptedTursoToken || 'NONE',
      turso_url: l.tursoUrl || '',
      created_at: l.createdAt,
      expires_at: l.expiresAt,
    })),
  };

  try {
    const res = await fetch(`${CLOUD_LICENSING_ENDPOINT}/api/v1/admin/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${masterKey}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`\n✅ ${data.synced} licence(s) synchronisée(s) avec succès sur le Cloud Master !`);
    } else {
      console.error(`\n❌ Échec de synchronisation:`, data.message || data.error);
    }
  } catch (err) {
    console.error(`\n❌ Erreur réseau lors de la synchronisation:`, err.message);
  }
}

/**
 * Resets active devices for a given license key, freeing seats
 */
async function executeResetSeats(args) {
  let key = args.key;
  if (!key) {
    const ledger = getLedger();
    if (ledger.length > 0) key = ledger[ledger.length - 1].licenseKey;
  }
  if (!key) {
    console.error('\n❌ Veuillez spécifier une clé : node scripts/license-admin.mjs reset-seats --key MOBI-LIFE-...');
    return;
  }
  const masterKey = process.env.MASTER_ENCRYPTION_KEY || 'zuYAeOahzvQXtv+Ib20DWmUQxiPxSkSMY8PgMzV9X28=';
  try {
    const res = await fetch(`${CLOUD_LICENSING_ENDPOINT}/api/v1/admin/reset-seats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${masterKey}`,
      },
      body: JSON.stringify({ license_key: key }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log('\n========================================================================');
      console.log(`🎉 TOUS LES POSTES ONT ÉTÉ RÉINITIALISÉS POUR LA CLÉ : ${key}`);
      console.log('========================================================================\n');
      console.log(`  ⚡ Sièges libérés : ${data.seats_cleared} poste(s) détaché(s)`);
      console.log('  👉 Le client peut désormais activer son nouvel ordinateur immédiatement !');
      console.log('========================================================================\n');
    } else {
      console.error('\n❌ Erreur:', data.message || data.error);
    }
  } catch (err) {
    console.error('\n❌ Erreur réseau:', err.message);
  }
}

/**
 * Updates seat quotas (desktop/mobile) for an existing license
 */
async function executeUpdateSeats(args) {
  let key = args.key;
  if (!key) {
    console.error('\n❌ Veuillez spécifier la clé : node scripts/license-admin.mjs update-seats --key MOBI-... --desktops 2');
    return;
  }
  const masterKey = process.env.MASTER_ENCRYPTION_KEY || 'zuYAeOahzvQXtv+Ib20DWmUQxiPxSkSMY8PgMzV9X28=';
  try {
    const res = await fetch(`${CLOUD_LICENSING_ENDPOINT}/api/v1/admin/update-seats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${masterKey}`,
      },
      body: JSON.stringify({
        license_key: key,
        max_desktops: args.desktops ? parseInt(args.desktops, 10) : undefined,
        max_mobiles: args.mobiles ? parseInt(args.mobiles, 10) : undefined,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`\n✅ Quotas mis à jour pour ${key} : Desktops = ${data.max_desktops}, Mobiles = ${data.max_mobiles}`);
    } else {
      console.error('\n❌ Erreur:', data.message || data.error);
    }
  } catch (err) {
    console.error('\n❌ Erreur réseau:', err.message);
  }
}

/**
 * Queries live Cloud Master for active licenses and connected devices
 */
async function executeCloudList() {
  const masterKey = process.env.MASTER_ENCRYPTION_KEY || 'zuYAeOahzvQXtv+Ib20DWmUQxiPxSkSMY8PgMzV9X28=';
  try {
    const res = await fetch(`${CLOUD_LICENSING_ENDPOINT}/api/v1/admin/list`, {
      headers: {
        Authorization: `Bearer ${masterKey}`,
      },
    });
    const data = await res.json();
    if (res.ok && data.licenses) {
      console.log('========================================================================');
      console.log(`☁️  LICENCES ACTIVES DANS LE CLOUD MASTER (${data.licenses.length} enregistrées)`);
      console.log('========================================================================\n');
      console.table(
        data.licenses.map((l) => ({
          Client: l.customer_name,
          Formule: l.license_type,
          'Postes Caisses': `${l.active_desktops || 0} / ${l.max_desktops}`,
          'Mobiles Sync': `${l.active_mobiles || 0} / ${l.max_mobiles}`,
          Statut: l.status,
          'Création': new Date(l.created_at).toLocaleDateString('fr-DZ'),
        }))
      );
      console.log('========================================================================\n');
    } else {
      console.error('\n❌ Erreur:', data.message || data.error);
    }
  } catch (err) {
    console.error('\n❌ Erreur réseau:', err.message);
  }
}

/**
 * Generates an offline signed Ed25519 token for a specific device HWID
 */
async function executeGenerateToken(args) {
  const ledger = getLedger();
  let key = args.key;
  let lic = null;

  if (key) {
    const norm = normalizeKey(key);
    lic = ledger.find((l) => normalizeKey(l.licenseKey) === norm);
  } else if (ledger.length > 0) {
    lic = ledger[ledger.length - 1];
    key = lic.licenseKey;
  }

  if (!lic) {
    console.error(`❌ Licence "${key || ''}" introuvable dans ${LEDGER_PATH}`);
    process.exit(1);
  }

  let hwidHash = args.hwid;
  let hwidFormatted = args.hwid;

  if (!hwidHash) {
    const local = detectLocalHwid();
    hwidHash = local.hash;
    hwidFormatted = local.formatted;
    console.log(`ℹ️  Aucun HWID spécifié : utilisation du HWID local (${hwidFormatted})`);
  } else if (hwidHash.startsWith('MOBI-')) {
    // If formatted HWID was provided, check if it matches local, or search
    const local = detectLocalHwid();
    if (local.formatted === hwidHash) {
      hwidHash = local.hash;
    }
  }

  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  let plainTursoToken = '';
  if (lic.encryptedTursoToken && masterKey) {
    try {
      plainTursoToken = await decryptToken(lic.encryptedTursoToken, masterKey);
    } catch {}
  }

  const privateJwk = JSON.parse(process.env.LICENSE_ED25519_PRIVATE_JWK);
  const now = Math.floor(Date.now() / 1000);
  let exp = 0;
  if (lic.type === '24H') exp = now + 86400;
  else if (lic.type === '90D') exp = now + 90 * 86400;

  const payload = {
    iss: 'https://mobi-licensing.admin',
    sub: lic.customer || 'Client MobiPOS',
    iat: now,
    nbf: now - 60,
    exp,
    jti: `jti_${crypto.randomUUID()}`,
    lic_key: lic.licenseKey,
    lic_type: lic.type || 'LIFETIME',
    device_id: hwidHash,
    device_type: 'desktop',
    max_desktops: lic.desktops || 1,
    max_mobiles: lic.mobiles || 2,
    grace_days: 7,
    server_ts: now,
    turso_url: lic.tursoUrl || '',
    turso_token: plainTursoToken,
  };

  const token = await signLicenseJwt(payload, privateJwk);

  console.log('\n========================================================================');
  console.log('⚡ JETON DE LICENCE HORS-LIGNE GÉNÉRÉ (Ed25519)');
  console.log('========================================================================\n');
  console.log(`  👤 Client / Magasin   : ${lic.customer}`);
  console.log(`  🔑 Clé d'origine      : ${lic.licenseKey}`);
  console.log(`  🖥️  Empreinte (HWID)  : ${hwidFormatted}`);
  console.log(`  📌 Type de Licence    : ${lic.type}`);
  console.log('\n📋 JETON CRYPTOGRAPHIQUE SIGNÉ (Copiez-collez dans l\'écran d\'activation) :\n');
  console.log(token);
  console.log('\n========================================================================\n');
  return token;
}

/**
 * Directly activates the current local machine (Tauri AppData + Vault)
 */
async function executeActivateLocal(args) {
  const ledger = getLedger();
  let key = args.key;
  let lic = null;

  if (key) {
    const norm = normalizeKey(key);
    lic = ledger.find((l) => normalizeKey(l.licenseKey) === norm);
  } else if (ledger.length > 0) {
    lic = ledger[ledger.length - 1];
    key = lic.licenseKey;
  }

  if (!lic) {
    console.error(`❌ Aucune licence trouvée dans ${LEDGER_PATH}`);
    process.exit(1);
  }

  const localHwid = detectLocalHwid();
  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  let plainTursoToken = '';
  if (lic.encryptedTursoToken && masterKey) {
    try {
      plainTursoToken = await decryptToken(lic.encryptedTursoToken, masterKey);
    } catch {}
  }

  const privateJwk = JSON.parse(process.env.LICENSE_ED25519_PRIVATE_JWK);
  const now = Math.floor(Date.now() / 1000);
  let exp = 0;
  if (lic.type === '24H') exp = now + 86400;
  else if (lic.type === '90D') exp = now + 90 * 86400;

  const payload = {
    iss: 'https://mobi-licensing.admin',
    sub: lic.customer || 'Client MobiPOS',
    iat: now,
    nbf: now - 60,
    exp,
    jti: `jti_${crypto.randomUUID()}`,
    lic_key: lic.licenseKey,
    lic_type: lic.type || 'LIFETIME',
    device_id: localHwid.hash,
    device_type: 'desktop',
    max_desktops: lic.desktops || 1,
    max_mobiles: lic.mobiles || 2,
    grace_days: 7,
    server_ts: now,
    turso_url: lic.tursoUrl || '',
    turso_token: plainTursoToken,
  };

  const token = await signLicenseJwt(payload, privateJwk);

  // Write to Tauri AppData directory
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const tauriDir = path.join(appData, 'com.mobi.pos');
  if (!fs.existsSync(tauriDir)) {
    fs.mkdirSync(tauriDir, { recursive: true });
  }

  // 1. Write .license_token.vault
  const licenseVaultPath = path.join(tauriDir, '.license_token.vault');
  fs.writeFileSync(licenseVaultPath, token, 'utf8');

  // 2. Write .cloud_credentials.vault if turso credentials exist
  if (lic.tursoUrl && plainTursoToken) {
    const credsVaultPath = path.join(tauriDir, '.cloud_credentials.vault');
    fs.writeFileSync(
      credsVaultPath,
      JSON.stringify({ url: lic.tursoUrl, token: plainTursoToken }),
      'utf8'
    );
  }

  console.log('\n========================================================================');
  console.log('🎉 MOBIPOS EST ACTIVÉ LOCALEMENT SUR CET ORDINATEUR !');
  console.log('========================================================================\n');
  console.log(`  👤 Client / Magasin   : \x1b[1m${lic.customer}\x1b[0m`);
  console.log(`  🔑 Clé d'Activation   : \x1b[32m\x1b[1m${lic.licenseKey}\x1b[0m`);
  console.log(`  🖥️  HWID Machine      : ${localHwid.formatted}`);
  console.log(`  📁 Fichier Vault      : ${licenseVaultPath}`);
  console.log(`  ☁️  Base Cloud Turso  : ${lic.tursoUrl || 'Non configurée'}`);
  console.log('\n👉 Relancez simplement l\'application MobiPOS : elle démarrera directement active !');
  console.log('========================================================================\n');
}

function listLicenses() {
  if (!fs.existsSync(LEDGER_PATH)) {
    console.log('\nAucune licence enregistrée pour le moment.');
    return;
  }
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  console.log('========================================================================');
  console.log(`📋 REGISTRE DES LICENCES MOBIPOS (${ledger.length} licences émises)`);
  console.log('========================================================================\n');
  console.table(
    ledger.map((l) => ({
      Client: l.customer,
      Clé: l.licenseKey,
      Type: l.type,
      Postes: l.desktops,
      Mobiles: l.mobiles,
      Date: new Date(l.createdAt).toLocaleDateString('fr-DZ'),
    }))
  );
  console.log('========================================================================\n');
}

async function generateCryptoCeremony() {
  console.log('========================================================================');
  console.log('⚡ MOBIPOS CRYPTOGRAPHIC LICENSING CEREMONY (Ed25519 & AES-256-GCM)');
  console.log('========================================================================\n');

  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  );

  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const publicRawB64Url = bytesToBase64Url(publicRaw);

  const masterKeyBytes = crypto.randomBytes(32);
  const masterKeyB64 = masterKeyBytes.toString('base64');
  const licensePepper = crypto.randomBytes(32).toString('hex');
  const ipPepper = crypto.randomBytes(32).toString('hex');

  console.log('--- 1. SECRETS FOR CLOUDFLARE WORKER (`wrangler secret put`) ---');
  console.log('MASTER_ENCRYPTION_KEY:\n' + masterKeyB64);
  console.log('\nLICENSE_PEPPER:\n' + licensePepper);
  console.log('\nIP_PEPPER:\n' + ipPepper);
  console.log('\nLICENSE_ED25519_PRIVATE_JWK:\n' + JSON.stringify(privateJwk));

  console.log('\n--- 2. PUBLIC KEY FOR CLIENT POS APP (`src/licensing/publicKey.ts`) ---');
  console.log(`export const ED25519_PUBLIC_KEY_RAW_B64URL = '${publicRawB64Url}';`);
  console.log(`export const ED25519_PUBLIC_KEY_JWK = ${JSON.stringify(publicJwk, null, 2)};\n`);
  console.log('========================================================================');
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      result[key] = val;
    }
  }
  return result;
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  if (command === 'generate-keys') {
    await generateCryptoCeremony();
  } else if (command === 'list') {
    listLicenses();
  } else if (command === 'activate-local') {
    await executeActivateLocal(args);
  } else if (command === 'token') {
    await executeGenerateToken(args);
  } else if (command === 'sync') {
    await executeSyncAll();
  } else if (command === 'reset-seats') {
    await executeResetSeats(args);
  } else if (command === 'update-seats') {
    await executeUpdateSeats(args);
  } else if (command === 'cloud-list') {
    await executeCloudList();
  } else if (command === 'mint') {
    if (args.interactive || Object.keys(args).length === 0) {
      await runInteractiveMint();
    } else {
      await executeMint(args);
    }
  } else {
    console.log('✨ Usage du gestionnaire de licences MobiPOS :');
    console.log('  npm run license:mint            Assistant interactif pour créer une licence');
    console.log('  npm run license:cloud-list      Voir toutes les licences et sièges occupés dans le Cloud');
    console.log('  npm run license:reset-seats     Libérer les postes occupés pour autoriser un nouveau PC');
    console.log('  npm run license:sync            Synchroniser tout le registre local vers le Cloud');
    console.log('  npm run license:activate-local  Activer immédiatement cet ordinateur');
    console.log('  npm run license:token           Générer un jeton cryptographique hors-ligne');
    console.log('  npm run license:list            Afficher le registre local des licences');
    console.log('\nExemples :');
    console.log('  npm run license:reset-seats -- --key MOBI-LIFE-ZDKS-E0BW');
    console.log('  npm run license:update-seats -- --key MOBI-LIFE-ZDKS-E0BW --desktops 3');
    console.log('  npm run license:activate-local -- --key MOBI-LIFE-ZDKS-E0BW');
  }
}

main().catch(console.error);

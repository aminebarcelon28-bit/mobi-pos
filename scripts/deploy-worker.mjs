#!/usr/bin/env node
/**
 * MobiPOS — Cloudflare Worker Deployment & Cloud Master Setup
 *
 * Automates:
 * 1. Cloudflare authentication check (wrangler login)
 * 2. Master Turso database schema application (via executeMultiple)
 * 3. Worker secret provisioning (AES keys, Ed25519 JWK, peppers, Turso credentials)
 * 4. Production deployment (`wrangler deploy`)
 * 5. Automatic update of client endpoint in `src/licensing/client.ts`
 * 6. Cloud synchronization of all local keys from `licenses_ledger.json`
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
const WORKER_DIR = path.join(ROOT_DIR, 'workers', 'licensing');
const ENV_PATH = path.join(ROOT_DIR, '.env.licensing');
const LEDGER_PATH = path.join(ROOT_DIR, 'licenses_ledger.json');
const CLIENT_TS_PATH = path.join(ROOT_DIR, 'src', 'licensing', 'client.ts');

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

function loadEnv() {
  const candidates = [
    ENV_PATH,
    path.join(ROOT_DIR, '.env'),
    path.join(WORKER_DIR, '.dev.vars'),
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
      } catch {}
    }
  }
}

loadEnv();

function hashKey(rawKey, pepper) {
  const normalized = (rawKey || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  return crypto.createHmac('sha256', pepper).update(normalized).digest('hex');
}

async function main() {
  console.clear();
  console.log('========================================================================');
  console.log('☁️  MOBIPOS — DÉPLOIEMENT DU SERVEUR DE LICENCE CLOUD (Cloudflare + Turso)');
  console.log('========================================================================\n');

  // Step 1: Verify Cloudflare Authentication
  console.log('🔍 Étape 1/5 : Vérification de la connexion Cloudflare...');
  try {
    const whoami = execSync('npx wrangler whoami', { stdio: ['pipe', 'pipe', 'pipe'], cwd: WORKER_DIR }).toString();
    if (whoami.includes('You are not authenticated')) {
      throw new Error('Not authenticated');
    }
    console.log('   ✅ Connecté à Cloudflare.');
  } catch {
    console.log('\n⚠️  Vous n\'êtes pas encore connecté à Cloudflare.');
    console.log('👉 Une fenêtre de navigateur va s\'ouvrir pour autoriser Wrangler :');
    execSync('npx wrangler login', { stdio: 'inherit', cwd: WORKER_DIR });
  }

  // Step 2: Master Turso Database Credentials
  console.log('\n🗄️  Étape 2/5 : Configuration de la base Master Turso de licensing...');
  let masterUrl = process.env.MASTER_TURSO_URL;
  let masterToken = process.env.MASTER_TURSO_TOKEN;

  if (!masterUrl || !masterToken) {
    console.log('   La base Master centralise l\'état des licences et l\'allocation des sièges.');
    masterUrl = await askQuestion('   URL de la base Master Turso (ex: libsql://mobi-master.turso.io)');
    masterToken = await askQuestion('   Auth Token Turso Master');

    // Save to .env.licensing
    let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    if (!envContent.includes('MASTER_TURSO_URL=')) {
      envContent += `\nMASTER_TURSO_URL=${masterUrl}\nMASTER_TURSO_TOKEN=${masterToken}\n`;
      fs.writeFileSync(ENV_PATH, envContent, 'utf8');
      console.log('   💾 Identifiants enregistrés dans .env.licensing');
    }
  } else {
    console.log(`   ✅ Base Master détectée : ${masterUrl}`);
  }

  // Step 3: Apply Schema to Master DB via executeMultiple
  console.log('\n📜 Étape 3/5 : Application du schéma SQL à la base Master...');
  const schemaSql = fs.readFileSync(path.join(WORKER_DIR, 'schema.sql'), 'utf8');
  try {
    const { createClient } = await import('@libsql/client');
    const db = createClient({ url: masterUrl, authToken: masterToken });
    await db.executeMultiple(schemaSql);
    console.log('   ✅ Schéma appliqué avec succès (tables et déclencheurs de quotas prêts).');

    // Sync local ledger keys to Master DB
    if (fs.existsSync(LEDGER_PATH)) {
      const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      const pepper = process.env.LICENSE_PEPPER || '8151b8bd90b28fd747511025fa6d38625515e57aca46dcb75841383cd0f0bf58';
      let syncedCount = 0;

      for (const lic of ledger) {
        const keyHash = hashKey(lic.licenseKey, pepper);
        const nowIso = lic.createdAt || new Date().toISOString();
        await db.execute({
          sql: `
            INSERT INTO licenses (
              id, key_hash, customer_name, license_type, status,
              max_desktops, max_mobiles, encrypted_turso_token, turso_url,
              created_at, updated_at, expires_at
            ) VALUES (:id, :key_hash, :customer_name, :license_type, 'active', :max_desktops, :max_mobiles, :enc_token, :turso_url, :created_at, :updated_at, :expires_at)
            ON CONFLICT(key_hash) DO NOTHING
          `,
          args: {
            id: lic.id || `lic_${crypto.randomUUID()}`,
            key_hash: keyHash,
            customer_name: lic.customer || 'Client MobiPOS',
            license_type: lic.type || 'LIFETIME',
            max_desktops: lic.desktops || 1,
            max_mobiles: lic.mobiles || 2,
            enc_token: lic.encryptedTursoToken || 'v1:placeholder',
            turso_url: lic.tursoUrl || '',
            created_at: nowIso,
            updated_at: nowIso,
            expires_at: lic.expiresAt || null,
          },
        });
        syncedCount++;
      }
      console.log(`   ✅ ${syncedCount} licence(s) existante(s) synchronisée(s) vers le Cloud Master (dont ${ledger.map((l) => l.licenseKey).join(', ')}).`);
    }
  } catch (dbErr) {
    console.warn(`   ⚠️ Note schéma Turso : ${dbErr.message}`);
  }

  // Step 4: Configure Cloudflare Worker Secrets
  console.log('\n🔒 Étape 4/5 : Configuration sécurisée des secrets Cloudflare Worker...');
  const secrets = {
    MASTER_TURSO_URL: masterUrl,
    MASTER_TURSO_TOKEN: masterToken,
    MASTER_ENCRYPTION_KEY: process.env.MASTER_ENCRYPTION_KEY || 'zuYAeOahzvQXtv+Ib20DWmUQxiPxSkSMY8PgMzV9X28=',
    LICENSE_PEPPER: process.env.LICENSE_PEPPER || '8151b8bd90b28fd747511025fa6d38625515e57aca46dcb75841383cd0f0bf58',
    IP_PEPPER: process.env.IP_PEPPER || '9395b7bbaa6fca32827f78c9aa131db515f5a2fa7ef74f7ead5b79734b0c6537',
    LICENSE_ED25519_PRIVATE_JWK: process.env.LICENSE_ED25519_PRIVATE_JWK || '',
  };

  for (const [keyName, secretVal] of Object.entries(secrets)) {
    if (!secretVal) continue;
    try {
      execSync(`npx wrangler secret put ${keyName}`, {
        input: secretVal,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: WORKER_DIR,
      });
      console.log(`   ✅ Secret Cloudflare "${keyName}" configuré.`);
    } catch (e) {
      console.warn(`   ⚠️ Erreur configuration secret ${keyName}:`, e.message);
    }
  }

  // Step 5: Deploy Worker
  console.log('\n🚀 Étape 5/5 : Déploiement en production sur Cloudflare Workers...');
  try {
    const deployOutput = execSync('npx wrangler deploy', {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: WORKER_DIR,
    }).toString();

    console.log(deployOutput);

    // Extract worker URL
    const urlMatch = deployOutput.match(/https:\/\/[a-zA-Z0-9_\-\.]+\.workers\.dev/);
    const deployedUrl = urlMatch ? urlMatch[0] : null;

    if (deployedUrl) {
      console.log('========================================================================');
      console.log(`🎉 SUCCÈS : VOTRE SERVEUR DE LICENCE EST EN LIGNE SUR INTERNET !`);
      console.log(`🌐 URL : \x1b[32m\x1b[1m${deployedUrl}\x1b[0m`);
      console.log('========================================================================\n');

      // Update DEFAULT_LICENSING_ENDPOINT in client.ts
      if (fs.existsSync(CLIENT_TS_PATH)) {
        let clientTs = fs.readFileSync(CLIENT_TS_PATH, 'utf8');
        clientTs = clientTs.replace(
          /https:\/\/mobi-licensing\.workers\.dev/g,
          deployedUrl
        );
        fs.writeFileSync(CLIENT_TS_PATH, clientTs, 'utf8');
        console.log(`   💾 URL injectée automatiquement dans ${CLIENT_TS_PATH}`);
      }

      console.log('👉 Vos clients peuvent désormais activer leurs clés (ex: MOBI-LIFE-ZDKS-E0BW)');
      console.log('   depuis n\'importe quel endroit dans le monde sans aucune manipulation !\n');
    } else {
      console.log('✅ Déploiement Cloudflare terminé avec succès.');
    }
  } catch (deployErr) {
    const errText = (deployErr.stderr ? deployErr.stderr.toString() : '') + (deployErr.stdout ? deployErr.stdout.toString() : '');
    if (errText.includes('register a workers.dev subdomain')) {
      const matchUrl = errText.match(/https:\/\/dash\.cloudflare\.com\/[a-f0-9]+\/workers\/onboarding/);
      const onboardingUrl = matchUrl ? matchUrl[0] : 'https://dash.cloudflare.com';
      console.log('\n========================================================================');
      console.log('⚠️  ACTION UNIQUE REQUISE SUR VOTRE COMPTE CLOUDFLARE :');
      console.log('========================================================================');
      console.log('Comme c\'est votre premier Worker, Cloudflare vous demande de choisir un sous-domaine.');
      console.log('\n👉 Cliquez sur ce lien pour choisir votre sous-domaine (10 secondes) :');
      console.log(`   \x1b[34m\x1b[4m${onboardingUrl}\x1b[0m`);
      console.log('\n(Exemple de nom : mobipos ou amine-pos)');
      console.log('Une fois validé, relancez simplement : npm run license:deploy');
      console.log('========================================================================\n');
    } else {
      console.error('\n❌ Erreur lors du déploiement Wrangler :', errText || deployErr.message);
    }
  }
}

main().catch(console.error);


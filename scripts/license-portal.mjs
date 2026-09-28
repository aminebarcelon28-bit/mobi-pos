#!/usr/bin/env node
/**
 * MobiPOS — Professional Licensing Command Center UI
 * Lightweight local server serving a high-end visual management dashboard
 *
 * Usage:
 *   npm run license:ui
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT_DIR, 'licenses_ledger.json');
const ENV_PATH = path.join(ROOT_DIR, '.env.licensing');

// Load environment variables
function loadEnv() {
  const candidates = [
    ENV_PATH,
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
      } catch {}
    }
  }
}

loadEnv();

const PORT = process.env.LICENSE_PORTAL_PORT || 4200;
const CLOUD_ENDPOINT = process.env.LICENSING_ENDPOINT || 'https://mobi-licensing.aminebarcelon28.workers.dev';
const MASTER_KEY = process.env.MASTER_ENCRYPTION_KEY || 'zuYAeOahzvQXtv+Ib20DWmUQxiPxSkSMY8PgMzV9X28=';
const PEPPER = process.env.LICENSE_PEPPER || '8151b8bd90b28fd747511025fa6d38625515e57aca46dcb75841383cd0f0bf58';

// Crockford Base32
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function generateRandomCrockford(length = 4) {
  const bytes = crypto.randomBytes(length);
  let res = '';
  for (let i = 0; i < length; i++) {
    res += CROCKFORD_ALPHABET[bytes[i] % CROCKFORD_ALPHABET.length];
  }
  return res;
}

function hashKey(rawKey, pepper) {
  const normalized = (rawKey || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  return crypto.createHmac('sha256', pepper).update(normalized).digest('hex');
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

async function signLicenseJwt(payload, privateJwk) {
  const cleanJwk = { ...privateJwk };
  delete cleanJwk.alg;
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    cleanJwk,
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

function getLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveLedger(entry) {
  const ledger = getLedger();
  const existingIdx = ledger.findIndex(
    (l) => l.id === entry.id || l.licenseKey.replace(/[^0-9A-Z]/g, '') === entry.licenseKey.replace(/[^0-9A-Z]/g, '')
  );
  if (existingIdx >= 0) {
    ledger[existingIdx] = { ...ledger[existingIdx], ...entry };
  } else {
    ledger.unshift(entry);
  }
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), 'utf8');
}

// Fetch Cloud Licenses and merge with local ledger
async function fetchMergedLicenses() {
  const ledger = getLedger();
  let cloudLicenses = [];

  try {
    const res = await fetch(`${CLOUD_ENDPOINT}/api/v1/admin/list`, {
      headers: { Authorization: `Bearer ${MASTER_KEY}` },
    });
    if (res.ok) {
      const data = await res.json();
      cloudLicenses = data.licenses || [];
    }
  } catch (err) {
    console.warn('Erreur lors de la récupération Cloud:', err.message);
  }

  // Merge map by customer name or hash
  const merged = ledger.map((local) => {
    const keyHash = hashKey(local.licenseKey, PEPPER);
    const cloudMatch = cloudLicenses.find((c) => c.id === local.id || c.customer_name === local.customer);

    return {
      id: local.id,
      customer: local.customer,
      licenseKey: local.licenseKey,
      type: local.type,
      desktops: cloudMatch ? cloudMatch.max_desktops : local.desktops,
      mobiles: cloudMatch ? cloudMatch.max_mobiles : local.mobiles,
      activeDesktops: cloudMatch ? cloudMatch.active_desktops || 0 : 0,
      activeMobiles: cloudMatch ? cloudMatch.active_mobiles || 0 : 0,
      status: cloudMatch ? cloudMatch.status : 'active',
      tursoUrl: local.tursoUrl || (cloudMatch ? cloudMatch.turso_url : '') || '',
      createdAt: local.createdAt,
      expiresAt: local.expiresAt,
      syncedWithCloud: Boolean(cloudMatch),
    };
  });

  // Include any cloud licenses not in local ledger
  for (const cloud of cloudLicenses) {
    const already = merged.some((m) => m.id === cloud.id || m.customer === cloud.customer_name);
    if (!already) {
      merged.push({
        id: cloud.id,
        customer: cloud.customer_name,
        licenseKey: 'CLÉ-CLOUD-ENREGISTRÉE',
        type: cloud.license_type,
        desktops: cloud.max_desktops,
        mobiles: cloud.max_mobiles,
        activeDesktops: cloud.active_desktops || 0,
        activeMobiles: cloud.active_mobiles || 0,
        status: cloud.status,
        tursoUrl: cloud.turso_url || '',
        createdAt: cloud.created_at,
        expiresAt: cloud.expires_at,
        syncedWithCloud: true,
      });
    }
  }

  return merged;
}

// Request Body Parser
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

// HTML Dashboard App
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MobiPOS — Centre de Contrôle des Licences</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/lucide@latest"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Plus Jakarta Sans', 'sans-serif'],
            mono: ['JetBrains Mono', 'monospace'],
          },
          colors: {
            brand: {
              50: '#ecfdf5',
              500: '#10b981',
              600: '#059669',
              700: '#047857',
            }
          }
        }
      }
    }
  </script>
  <style>
    body { background-color: #0b0f17; color: #f3f4f6; }
    .glass-card { background: rgba(17, 24, 39, 0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.07); }
    .glass-card:hover { border-color: rgba(16, 185, 129, 0.3); }
    .glow-emerald { box-shadow: 0 0 25px -5px rgba(16, 185, 129, 0.25); }
    [v-cloak] { display: none; }
  </style>
</head>
<body class="min-h-screen flex flex-col font-sans selection:bg-emerald-500 selection:text-white">

  <!-- Notification Toast -->
  <div id="toast" class="fixed bottom-6 right-6 z-50 transform translate-y-20 opacity-0 transition-all duration-300 pointer-events-none">
    <div class="flex items-center gap-3 px-5 py-3.5 rounded-xl shadow-2xl text-sm font-semibold glass-card border border-emerald-500/30 text-emerald-400 bg-gray-900/90">
      <i data-lucide="check-circle-2" class="w-5 h-5 text-emerald-400"></i>
      <span id="toast-message">Action effectuée</span>
    </div>
  </div>

  <!-- Header -->
  <header class="border-b border-gray-800/80 bg-gray-950/60 backdrop-blur sticky top-0 z-30">
    <div class="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
      <div class="flex items-center gap-4">
        <div class="w-11 h-11 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center text-white shadow-lg shadow-emerald-500/20">
          <i data-lucide="shield-check" class="w-6 h-6"></i>
        </div>
        <div>
          <div class="flex items-center gap-2.5">
            <h1 class="text-xl font-extrabold tracking-tight text-white">MobiPOS <span class="text-emerald-400 font-medium text-sm px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">Admin Cloud</span></h1>
          </div>
          <p class="text-xs text-gray-400 flex items-center gap-1.5 mt-0.5">
            <span class="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            Cloudflare Global Edge &bull; Master Turso DB
          </p>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <button onclick="refreshData()" class="px-4 py-2.5 rounded-xl text-sm font-semibold text-gray-300 hover:text-white glass-card hover:bg-gray-800/50 transition flex items-center gap-2">
          <i data-lucide="refresh-cw" class="w-4 h-4 text-gray-400"></i>
          <span>Actualiser</span>
        </button>
        <button onclick="openMintModal()" class="px-5 py-2.5 rounded-xl text-sm font-bold bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-gray-950 transition shadow-lg shadow-emerald-500/25 flex items-center gap-2">
          <i data-lucide="plus-circle" class="w-4 h-4"></i>
          <span>Nouvelle Licence</span>
        </button>
      </div>
    </div>
  </header>

  <!-- Main Content -->
  <main class="max-w-7xl mx-auto px-6 py-8 flex-1 w-full space-y-8">

    <!-- KPI Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-5">
      <div class="p-5 rounded-2xl glass-card relative overflow-hidden group">
        <div class="flex items-center justify-between text-gray-400 text-xs font-semibold uppercase tracking-wider">
          <span>Clients Déployés</span>
          <div class="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
            <i data-lucide="users" class="w-4 h-4"></i>
          </div>
        </div>
        <div class="mt-3 flex items-baseline gap-2">
          <span id="stat-total" class="text-3xl font-extrabold text-white">0</span>
          <span class="text-xs text-gray-400">licences</span>
        </div>
      </div>

      <div class="p-5 rounded-2xl glass-card relative overflow-hidden group">
        <div class="flex items-center justify-between text-gray-400 text-xs font-semibold uppercase tracking-wider">
          <span>Postes Caisses (PC)</span>
          <div class="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400">
            <i data-lucide="monitor" class="w-4 h-4"></i>
          </div>
        </div>
        <div class="mt-3 flex items-baseline gap-2">
          <span id="stat-desktops" class="text-3xl font-extrabold text-white">0 / 0</span>
          <span class="text-xs text-gray-400">actifs</span>
        </div>
      </div>

      <div class="p-5 rounded-2xl glass-card relative overflow-hidden group">
        <div class="flex items-center justify-between text-gray-400 text-xs font-semibold uppercase tracking-wider">
          <span>Smartphones Connectés</span>
          <div class="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400">
            <i data-lucide="smartphone" class="w-4 h-4"></i>
          </div>
        </div>
        <div class="mt-3 flex items-baseline gap-2">
          <span id="stat-mobiles" class="text-3xl font-extrabold text-white">0 / 0</span>
          <span class="text-xs text-gray-400">synchronisés</span>
        </div>
      </div>

      <div class="p-5 rounded-2xl glass-card relative overflow-hidden group">
        <div class="flex items-center justify-between text-gray-400 text-xs font-semibold uppercase tracking-wider">
          <span>Serveur Mondial</span>
          <div class="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
            <i data-lucide="globe" class="w-4 h-4"></i>
          </div>
        </div>
        <div class="mt-3 flex items-baseline gap-2">
          <span class="text-xl font-bold text-emerald-400 flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-emerald-400"></span> En Ligne
          </span>
        </div>
        <p class="text-[11px] text-gray-400 mt-1 truncate">aminebarcelon28.workers.dev</p>
      </div>
    </div>

    <!-- License Directory Table -->
    <div class="rounded-2xl glass-card overflow-hidden">
      <!-- Search & Filters Toolbar -->
      <div class="p-5 border-b border-gray-800 flex flex-col md:flex-row items-center justify-between gap-4">
        <div class="relative w-full md:w-96">
          <i data-lucide="search" class="w-4 h-4 text-gray-500 absolute left-3.5 top-1/2 -translate-y-1/2"></i>
          <input
            id="search-input"
            type="text"
            oninput="filterLicenses()"
            placeholder="Rechercher par client, clé..."
            class="w-full bg-gray-900/80 border border-gray-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-emerald-500/50"
          >
        </div>
        <div class="flex items-center gap-3 w-full md:w-auto">
          <select id="filter-type" onchange="filterLicenses()" class="bg-gray-900 border border-gray-800 rounded-xl px-3.5 py-2.5 text-xs font-medium text-gray-300 focus:outline-none focus:border-emerald-500/50">
            <option value="ALL">Toutes les formules</option>
            <option value="LIFETIME">Illimitée (LIFETIME)</option>
            <option value="90D">Trimestrielle (90 Jours)</option>
            <option value="24H">Évaluation (24 Heures)</option>
          </select>
        </div>
      </div>

      <!-- Table -->
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm text-gray-300">
          <thead class="text-xs uppercase font-bold tracking-wider text-gray-400 bg-gray-900/60 border-b border-gray-800">
            <tr>
              <th class="px-6 py-4">Client / Établissement</th>
              <th class="px-6 py-4">Clé d'Activation</th>
              <th class="px-6 py-4">Formule</th>
              <th class="px-6 py-4">Caisses PC</th>
              <th class="px-6 py-4">Mobiles</th>
              <th class="px-6 py-4 text-right">Actions Pro</th>
            </tr>
          </thead>
          <tbody id="licenses-tbody" class="divide-y divide-gray-800/60">
            <!-- Dynamic rows will be inserted here -->
            <tr>
              <td colspan="6" class="px-6 py-12 text-center text-gray-400">
                <i data-lucide="loader-2" class="w-6 h-6 animate-spin mx-auto mb-2 text-emerald-400"></i>
                Chargement des licences en direct du Cloud...
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <!-- Modal: Mint New License -->
  <div id="modal-mint" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 hidden">
    <div class="w-full max-w-lg rounded-2xl glass-card border border-gray-700 p-7 bg-gray-900 shadow-2xl relative">
      <button onclick="closeMintModal()" class="absolute right-5 top-5 text-gray-400 hover:text-white">
        <i data-lucide="x" class="w-5 h-5"></i>
      </button>

      <div class="flex items-center gap-3 mb-6">
        <div class="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center">
          <i data-lucide="key" class="w-5 h-5"></i>
        </div>
        <div>
          <h3 class="text-lg font-bold text-white">Émettre une Nouvelle Licence</h3>
          <p class="text-xs text-gray-400">Enregistrée instantanément sur vos serveurs mondiaux</p>
        </div>
      </div>

      <form id="mint-form" onsubmit="handleMintSubmit(event)" class="space-y-4">
        <div>
          <label class="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1.5">Nom du Magasin / Client</label>
          <input
            id="mint-customer"
            type="text"
            required
            placeholder="ex: Supérette Al-Baraka"
            class="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
          >
        </div>

        <div>
          <label class="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1.5">Formule de Licence</label>
          <div class="grid grid-cols-3 gap-2.5">
            <label class="cursor-pointer border border-gray-800 rounded-xl p-3 text-center has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-500/10 transition">
              <input type="radio" name="mint-type" value="LIFETIME" checked class="hidden">
              <div class="font-bold text-sm text-white">À Vie</div>
              <div class="text-[10px] text-emerald-400 font-medium">LIFETIME</div>
            </label>
            <label class="cursor-pointer border border-gray-800 rounded-xl p-3 text-center has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-500/10 transition">
              <input type="radio" name="mint-type" value="90D" class="hidden">
              <div class="font-bold text-sm text-white">3 Mois</div>
              <div class="text-[10px] text-sky-400 font-medium">Trimestriel</div>
            </label>
            <label class="cursor-pointer border border-gray-800 rounded-xl p-3 text-center has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-500/10 transition">
              <input type="radio" name="mint-type" value="24H" class="hidden">
              <div class="font-bold text-sm text-white">24H</div>
              <div class="text-[10px] text-amber-400 font-medium">Démo Test</div>
            </label>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1.5">Caisses PC (Desktop)</label>
            <input
              id="mint-desktops"
              type="number"
              min="1"
              max="20"
              value="1"
              required
              class="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
            >
          </div>
          <div>
            <label class="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1.5">Smartphones (Android)</label>
            <input
              id="mint-mobiles"
              type="number"
              min="0"
              max="50"
              value="2"
              required
              class="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
            >
          </div>
        </div>

        <div class="pt-4 flex gap-3">
          <button type="button" onclick="closeMintModal()" class="flex-1 py-3 rounded-xl border border-gray-700 text-sm font-semibold text-gray-300 hover:text-white hover:bg-gray-800 transition">
            Annuler
          </button>
          <button id="mint-btn-submit" type="submit" class="flex-1 py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-gray-950 font-bold text-sm hover:from-emerald-400 hover:to-teal-400 transition shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2">
            <span>Créer la Licence</span>
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- Modal: WhatsApp & Ready Message -->
  <div id="modal-whatsapp" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 hidden">
    <div class="w-full max-w-lg rounded-2xl glass-card border border-emerald-500/30 p-7 bg-gray-900 shadow-2xl relative">
      <button onclick="closeWhatsAppModal()" class="absolute right-5 top-5 text-gray-400 hover:text-white">
        <i data-lucide="x" class="w-5 h-5"></i>
      </button>

      <div class="flex items-center gap-3 mb-5">
        <div class="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
          <i data-lucide="message-square" class="w-5 h-5"></i>
        </div>
        <div>
          <h3 class="text-lg font-bold text-white">Message Client Prêt</h3>
          <p class="text-xs text-gray-400">À copier et envoyer par WhatsApp ou SMS</p>
        </div>
      </div>

      <div class="p-4 rounded-xl bg-gray-950 border border-gray-800 font-mono text-xs text-gray-300 leading-relaxed whitespace-pre-wrap selection:bg-emerald-500 select-all" id="whatsapp-preview">
      </div>

      <div class="mt-5 flex gap-3">
        <button onclick="copyWhatsAppMessage()" class="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-bold text-sm transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25">
          <i data-lucide="copy" class="w-4 h-4"></i>
          <span id="btn-copy-wa-text">Copier pour WhatsApp</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Modal: Update Quotas -->
  <div id="modal-update-seats" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 hidden">
    <div class="w-full max-w-md rounded-2xl glass-card border border-gray-700 p-6 bg-gray-900 shadow-2xl relative">
      <button onclick="closeUpdateSeatsModal()" class="absolute right-5 top-5 text-gray-400 hover:text-white">
        <i data-lucide="x" class="w-5 h-5"></i>
      </button>

      <h3 class="text-lg font-bold text-white mb-1">Modifier les Quotas</h3>
      <p class="text-xs text-gray-400 mb-5" id="update-seats-client-name"></p>

      <div class="space-y-4">
        <div>
          <label class="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1">Postes Caisses PC autorisés</label>
          <input id="update-desktops-input" type="number" min="1" max="20" class="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:border-emerald-500">
        </div>
        <div>
          <label class="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1">Smartphones autorisés</label>
          <input id="update-mobiles-input" type="number" min="0" max="50" class="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:border-emerald-500">
        </div>

        <button onclick="saveUpdatedSeats()" class="w-full py-3 rounded-xl bg-emerald-500 text-gray-950 font-bold text-sm hover:bg-emerald-400 transition mt-2">
          Enregistrer dans le Cloud
        </button>
      </div>
    </div>
  </div>

  <script>
    let allLicenses = [];
    let activeKeyForAction = '';

    function showToast(msg) {
      const toast = document.getElementById('toast');
      document.getElementById('toast-message').textContent = msg;
      toast.classList.remove('translate-y-20', 'opacity-0');
      setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
      }, 3000);
    }

    async function refreshData() {
      try {
        const res = await fetch('/api/licenses');
        const data = await res.json();
        allLicenses = data.licenses || [];
        renderTable(allLicenses);
        updateKPIs(allLicenses);
        lucide.createIcons();
      } catch (err) {
        showToast('Erreur de connexion au serveur');
      }
    }

    function updateKPIs(licenses) {
      document.getElementById('stat-total').textContent = licenses.length;
      let totalDesktops = 0;
      let usedDesktops = 0;
      let totalMobiles = 0;
      let usedMobiles = 0;

      for (const l of licenses) {
        totalDesktops += (l.desktops || 0);
        usedDesktops += (l.activeDesktops || 0);
        totalMobiles += (l.mobiles || 0);
        usedMobiles += (l.activeMobiles || 0);
      }

      document.getElementById('stat-desktops').textContent = \`\${usedDesktops} / \${totalDesktops}\`;
      document.getElementById('stat-mobiles').textContent = \`\${usedMobiles} / \${totalMobiles}\`;
    }

    function renderTable(licenses) {
      const tbody = document.getElementById('licenses-tbody');
      if (licenses.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-8 text-center text-gray-500">Aucune licence trouvée.</td></tr>';
        return;
      }

      tbody.innerHTML = licenses.map(l => {
        const formulaBadge = l.type === 'LIFETIME'
          ? '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">À Vie</span>'
          : l.type === '90D'
          ? '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-sky-500/10 text-sky-400 border border-sky-500/20">90 Jours</span>'
          : '<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">24 Heures</span>';

        const desktopQuota = \`\${l.activeDesktops} / \${l.desktops}\`;
        const desktopFull = l.activeDesktops >= l.desktops && l.desktops > 0;
        const mobileQuota = \`\${l.activeMobiles} / \${l.mobiles}\`;

        return \`
          <tr class="hover:bg-gray-800/30 transition group">
            <td class="px-6 py-4">
              <div class="font-bold text-white text-base">\${escapeHtml(l.customer)}</div>
              <div class="text-xs text-gray-500 mt-0.5">Créée le \${new Date(l.createdAt).toLocaleDateString('fr-DZ')}</div>
            </td>
            <td class="px-6 py-4">
              <button onclick="copyText('\${l.licenseKey}')" title="Cliquer pour copier" class="font-mono text-xs font-bold px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-800 text-emerald-400 hover:border-emerald-500/50 hover:bg-gray-850 flex items-center gap-2 transition">
                <span>\${l.licenseKey}</span>
                <i data-lucide="copy" class="w-3.5 h-3.5 text-gray-500 group-hover:text-emerald-400"></i>
              </button>
            </td>
            <td class="px-6 py-4">\${formulaBadge}</td>
            <td class="px-6 py-4">
              <div class="flex items-center gap-2">
                <span class="font-semibold text-xs \${desktopFull ? 'text-amber-400 font-bold' : 'text-gray-300'}">\${desktopQuota}</span>
                \${desktopFull ? '<span class="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 font-medium">Plein</span>' : ''}
              </div>
            </td>
            <td class="px-6 py-4 font-semibold text-xs text-gray-300">\${mobileQuota}</td>
            <td class="px-6 py-4 text-right">
              <div class="flex items-center justify-end gap-1.5">
                <button onclick="openWhatsAppModal('\${encodeURIComponent(JSON.stringify(l))}')" title="Message WhatsApp" class="p-2 rounded-lg hover:bg-emerald-500/10 text-gray-400 hover:text-emerald-400 transition">
                  <i data-lucide="message-square" class="w-4 h-4"></i>
                </button>
                <button onclick="handleResetSeats('\${l.licenseKey}', '\${escapeHtml(l.customer)}')" title="Libérer les postes (Changement de PC)" class="p-2 rounded-lg hover:bg-amber-500/10 text-gray-400 hover:text-amber-400 transition">
                  <i data-lucide="rotate-ccw" class="w-4 h-4"></i>
                </button>
                <button onclick="openUpdateSeatsModal('\${l.licenseKey}', '\${escapeHtml(l.customer)}', \${l.desktops}, \${l.mobiles})" title="Modifier Quotas" class="p-2 rounded-lg hover:bg-blue-500/10 text-gray-400 hover:text-blue-400 transition">
                  <i data-lucide="sliders" class="w-4 h-4"></i>
                </button>
              </div>
            </td>
          </tr>
        \`;
      }).join('');
      lucide.createIcons();
    }

    function filterLicenses() {
      const query = document.getElementById('search-input').value.toLowerCase();
      const type = document.getElementById('filter-type').value;

      const filtered = allLicenses.filter(l => {
        const matchesQuery = l.customer.toLowerCase().includes(query) || l.licenseKey.toLowerCase().includes(query);
        const matchesType = type === 'ALL' || l.type === type;
        return matchesQuery && matchesType;
      });

      renderTable(filtered);
    }

    function copyText(text) {
      navigator.clipboard.writeText(text);
      showToast('Clé copiée dans le presse-papiers !');
    }

    function openMintModal() {
      document.getElementById('modal-mint').classList.remove('hidden');
      document.getElementById('mint-customer').focus();
    }

    function closeMintModal() {
      document.getElementById('modal-mint').classList.add('hidden');
    }

    async function handleMintSubmit(e) {
      e.preventDefault();
      const btn = document.getElementById('mint-btn-submit');
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Création...';
      lucide.createIcons();

      const customer = document.getElementById('mint-customer').value;
      const type = document.querySelector('input[name="mint-type"]:checked').value;
      const desktops = parseInt(document.getElementById('mint-desktops').value, 10);
      const mobiles = parseInt(document.getElementById('mint-mobiles').value, 10);

      try {
        const res = await fetch('/api/licenses/mint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customer, type, desktops, mobiles })
        });
        const data = await res.json();
        closeMintModal();
        showToast('Licence créée et activée dans le Cloud !');
        await refreshData();
        openWhatsAppModal(encodeURIComponent(JSON.stringify(data.license)));
      } catch {
        showToast('Erreur lors de la création');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>Créer la Licence</span>';
      }
    }

    function openWhatsAppModal(encodedLicense) {
      const lic = JSON.parse(decodeURIComponent(encodedLicense));
      const msg = \`Bonjour \${lic.customer},

Votre licence MobiPOS est prête et activée ! 🎉

🔑 Votre Clé d'Activation : *\${lic.licenseKey}*
📌 Formule : \${lic.type === 'LIFETIME' ? 'Licence Illimitée à Vie' : 'Licence ' + lic.type}
🖥️ Postes Caisses autorisés : \${lic.desktops}
📱 Mobiles compagnons autorisés : \${lic.mobiles}

👉 *Instructions d'activation :*
1. Lancez l'application MobiPOS sur votre poste de caisse ou smartphone.
2. Entrez votre clé : *\${lic.licenseKey}*
3. Cliquez sur "Activer la Licence".

Vos données et votre synchronisation cloud sont prêtes et sécurisées.
Merci pour votre confiance !
L'équipe MobiPOS\`;

      document.getElementById('whatsapp-preview').textContent = msg;
      document.getElementById('modal-whatsapp').classList.remove('hidden');
      lucide.createIcons();
    }

    function closeWhatsAppModal() {
      document.getElementById('modal-whatsapp').classList.add('hidden');
    }

    function copyWhatsAppMessage() {
      const msg = document.getElementById('whatsapp-preview').textContent;
      navigator.clipboard.writeText(msg);
      document.getElementById('btn-copy-wa-text').textContent = 'Copié !';
      showToast('Message copié ! Collez-le dans WhatsApp.');
      setTimeout(() => {
        document.getElementById('btn-copy-wa-text').textContent = 'Copier pour WhatsApp';
      }, 2500);
    }

    async function handleResetSeats(key, customer) {
      if (!confirm(\`Voulez-vous libérer tous les postes pour "\${customer}" ?\\n\\nCela permettra au client d'activer son nouveau PC ou téléphone immédiatement.\`)) {
        return;
      }

      try {
        const res = await fetch('/api/licenses/reset-seats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ license_key: key })
        });
        const data = await res.json();
        if (data.status === 'success') {
          showToast(\`Postes libérés (\${data.seats_cleared} appareil(s) réinitialisé(s))\`);
          refreshData();
        } else {
          showToast('Erreur: ' + (data.message || 'Impossible de réinitialiser'));
        }
      } catch {
        showToast('Erreur réseau');
      }
    }

    function openUpdateSeatsModal(key, customer, desktops, mobiles) {
      activeKeyForAction = key;
      document.getElementById('update-seats-client-name').textContent = \`Client : \${customer} (\${key})\`;
      document.getElementById('update-desktops-input').value = desktops;
      document.getElementById('update-mobiles-input').value = mobiles;
      document.getElementById('modal-update-seats').classList.remove('hidden');
      lucide.createIcons();
    }

    function closeUpdateSeatsModal() {
      document.getElementById('modal-update-seats').classList.add('hidden');
    }

    async function saveUpdatedSeats() {
      const desktops = parseInt(document.getElementById('update-desktops-input').value, 10);
      const mobiles = parseInt(document.getElementById('update-mobiles-input').value, 10);

      try {
        const res = await fetch('/api/licenses/update-seats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ license_key: activeKeyForAction, max_desktops: desktops, max_mobiles: mobiles })
        });
        const data = await res.json();
        if (data.status === 'success') {
          showToast('Quotas mis à jour dans le Cloud !');
          closeUpdateSeatsModal();
          refreshData();
        }
      } catch {
        showToast('Erreur lors de la mise à jour');
      }
    }

    function escapeHtml(text) {
      return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Init on boot
    refreshData();
  </script>
</body>
</html>`;

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // 1. Static UI Page
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }

  // 2. GET /api/licenses
  if (req.method === 'GET' && pathname === '/api/licenses') {
    try {
      const licenses = await fetchMergedLicenses();
      sendJson(res, { licenses });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // 3. POST /api/licenses/mint
  if (req.method === 'POST' && pathname === '/api/licenses/mint') {
    try {
      const body = await parseJsonBody(req);
      const customer = body.customer || 'Client MobiPOS';
      const type = (body.type || 'LIFETIME').toUpperCase();
      const desktops = parseInt(body.desktops || 1, 10);
      const mobiles = parseInt(body.mobiles || 2, 10);
      const tursoUrl = body.turso_url || '';

      let typeTag = 'LIFE';
      let expiresAt = null;
      const now = new Date();
      if (type === '24H') {
        typeTag = '24H';
        expiresAt = new Date(now.getTime() + 86400000).toISOString();
      } else if (type === '90D') {
        typeTag = '90D';
        expiresAt = new Date(now.getTime() + 90 * 86400000).toISOString();
      }

      const p1 = generateRandomCrockford(4);
      const p2 = generateRandomCrockford(4);
      const licenseKey = `MOBI-${typeTag}-${p1}-${p2}`;
      const keyHash = hashKey(licenseKey, PEPPER);
      const licId = `lic_${crypto.randomUUID()}`;
      const nowIso = now.toISOString();

      const newLic = {
        id: licId,
        customer,
        licenseKey,
        type,
        desktops,
        mobiles,
        tursoUrl,
        encryptedTursoToken: 'NONE',
        createdAt: nowIso,
        expiresAt,
      };

      // 1. Save in local ledger
      saveLedger(newLic);

      // 2. Sync to Cloudflare Worker
      try {
        await fetch(`${CLOUD_ENDPOINT}/api/v1/admin/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${MASTER_KEY}`,
          },
          body: JSON.stringify({
            id: licId,
            key_hash: keyHash,
            customer_name: customer,
            license_type: type,
            status: 'active',
            max_desktops: desktops,
            max_mobiles: mobiles,
            encrypted_turso_token: 'NONE',
            turso_url: tursoUrl,
            created_at: nowIso,
            expires_at: expiresAt,
          }),
        });
      } catch (err) {
        console.warn('Cloud sync error on mint:', err.message);
      }

      sendJson(res, { status: 'success', license: newLic });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // 4. POST /api/licenses/reset-seats
  if (req.method === 'POST' && pathname === '/api/licenses/reset-seats') {
    try {
      const body = await parseJsonBody(req);
      const cloudRes = await fetch(`${CLOUD_ENDPOINT}/api/v1/admin/reset-seats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${MASTER_KEY}`,
        },
        body: JSON.stringify({ license_key: body.license_key }),
      });
      const data = await cloudRes.json();
      sendJson(res, data, cloudRes.status);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // 5. POST /api/licenses/update-seats
  if (req.method === 'POST' && pathname === '/api/licenses/update-seats') {
    try {
      const body = await parseJsonBody(req);
      const cloudRes = await fetch(`${CLOUD_ENDPOINT}/api/v1/admin/update-seats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${MASTER_KEY}`,
        },
        body: JSON.stringify(body),
      });
      const data = await cloudRes.json();
      sendJson(res, data, cloudRes.status);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Route not found' }));
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('========================================================================');
  console.log('✨ MOBIPOS — CENTRE DE CONTRÔLE DES LICENCES (INTERFACE WEB)');
  console.log('========================================================================\n');
  console.log(`  🌐 Tableau de Bord ouvert sur : \x1b[32m\x1b[1m${url}\x1b[0m`);
  console.log(`  ☁️  Serveur Cloud connecté     : ${CLOUD_ENDPOINT}`);
  console.log('\n  👉 Appuyez sur Ctrl+C dans ce terminal pour quitter quand vous avez terminé.');
  console.log('========================================================================\n');

  // Auto-open browser on Windows/Mac/Linux
  const startCmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
  exec(startCmd, () => {});
});

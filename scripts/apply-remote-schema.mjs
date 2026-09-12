// Applies turso/remote-schema.sql to your Turso Cloud DB using @libsql/client.
// Reads connection from proxy/.env (TURSO_URL + TURSO_AUTH_TOKEN) so the token
// never appears in shell history or chat. Usage:
//   1. Fill proxy/.env (copy from proxy/.env.example)
//   2. node scripts/apply-remote-schema.mjs
//   3. node scripts/apply-remote-schema.mjs --verify-only  (safe re-check)

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@libsql/client';

function loadEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...loadEnvFile('proxy/.env'), ...process.env };
const url = env.TURSO_URL;
const token = env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  console.error('Missing TURSO_URL / TURSO_AUTH_TOKEN. Fill proxy/.env first (see proxy/.env.example).');
  process.exit(1);
}

const client = createClient({ url, authToken: token });
const verifyOnly = process.argv.includes('--verify-only');

async function verify() {
  const tables = ['products', 'transactions', 'transaction_items', 'inventory_ledger', 'customers'];
  for (const t of tables) {
    try {
      const rs = await client.execute(`SELECT COUNT(*) as n FROM ${t}`);
      console.log(`OK ${t}: ${rs.rows[0].n} rows`);
    } catch (e) {
      console.log(`MISSING ${t}: ${e.message?.split('\n')[0] ?? e}`);
    }
  }
}

if (verifyOnly) {
  await verify();
  process.exit(0);
}

const sql = readFileSync('turso/remote-schema.sql', 'utf8');
// libsql batch: split on blank-line-separated statements is fragile with triggers;
// remote-schema.sql has no triggers, so naive ';' split is safe.
const statements = sql
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith('--'))
  .map((s) => (s.endsWith(';') ? s : s + ';'));

console.log(`Applying ${statements.length} statements to ${url.split('@')[1] ?? url} ...`);
let ok = 0;
for (const [i, s] of statements.entries()) {
  try {
    await client.execute(s);
    ok++;
  } catch (e) {
    console.error(`Statement ${i + 1} failed: ${e.message?.split('\n')[0] ?? e}`);
    console.error(s.slice(0, 200));
    process.exit(1);
  }
}
console.log(`Applied ${ok}/${statements.length}. Verifying...`);
await verify();
console.log('Done. Dashboard Activity should now show rows written.');

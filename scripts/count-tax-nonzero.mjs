/**
 * E3 — read-only `tax != 0` count command (PD-19, Zero-Drift Mandate v4).
 *
 * READ-ONLY. Resolves + prints the live DB path, runs
 *   SELECT COUNT(*) FROM transactions WHERE tax != 0;
 * against every reachable database (local app DBs + Turso if credentials
 * are present). Prints evidence, changes nothing.
 *
 * Exit codes: 0 = counts taken, all zero. 1 = NON-ZERO tax found (HALT for
 * owner decision). 2 = no database reachable (no evidence).
 *
 * Secrets are NEVER printed (only whether TURSO_* vars are set).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const out = [];
let worst = 0; // 0 ok, 1 nonzero, 2 nothing-found
let checkedAny = false;

function log(line) {
  out.push(line);
  console.log(line);
}

async function countLocal(dbPath, label) {
  log(`--- local: ${label}`);
  log(`    path: ${dbPath}`);
  if (!existsSync(dbPath)) {
    log(`    NOT FOUND`);
    return;
  }
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    log(`    ERROR opening read-only: ${String(e?.message ?? e)}`);
    worst = Math.max(worst, 2);
    return;
  }
  try {
    const hasTable = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'`
    ).get();
    if (!hasTable) {
      log(`    no transactions table`);
      return;
    }
    const cols = db.prepare(`PRAGMA table_info(transactions)`).all();
    if (!cols.some((c) => c.name === 'tax')) {
      log(`    transactions present, tax column ABSENT (already dropped?)`);
      checkedAny = true;
      return;
    }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()?.n ?? 0;
    const nonzero = db.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE CAST(tax AS REAL) != 0`
    ).get()?.n ?? 0;
    log(`    total=${total} nonzero_tax=${nonzero}`);
    checkedAny = true;
    if (nonzero > 0) {
      worst = 1;
      const rows = db.prepare(
        `SELECT id, receipt_number, tax, total FROM transactions WHERE CAST(tax AS REAL) != 0 LIMIT 5`
      ).all();
      for (const r of rows) log(`    row: ${JSON.stringify(r)}`);
    }
  } catch (e) {
    log(`    ERROR querying: ${String(e?.message ?? e)}`);
    worst = Math.max(worst, 2);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

async function countTurso() {
  log(`--- remote: Turso`);
  const url = process.env.TURSO_URL;
  const token = process.env.TURSO_TOKEN;
  log(`    TURSO_URL set: ${url ? 'yes' : 'no'}; TURSO_TOKEN set: ${token ? 'yes' : 'no'} (values never printed)`);
  if (!url) {
    log(`    SKIP: no credentials. Owner: run manually:`);
    log(`    SELECT COUNT(*) FROM transactions WHERE tax != 0;`);
    return;
  }
  try {
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url, authToken: token });
    const total = (await client.execute(`SELECT COUNT(*) AS n FROM transactions`)).rows[0]?.n ?? 0;
    const nonzero = (await client.execute(
      `SELECT COUNT(*) AS n FROM transactions WHERE CAST(tax AS REAL) != 0`
    )).rows[0]?.n ?? 0;
    log(`    total=${total} nonzero_tax=${nonzero}`);
    checkedAny = true;
    if (Number(nonzero) > 0) worst = 1;
    client.close();
  } catch (e) {
    log(`    ERROR querying Turso: ${String(e?.message ?? e)}`);
    worst = Math.max(worst, 2);
  }
}

const appData = process.env.APPDATA;
const localAppData = process.env.LOCALAPPDATA;
const candidates = [];
if (process.env.MOBI_POS_DB) candidates.push(['$MOBI_POS_DB override', process.env.MOBI_POS_DB]);
if (appData) candidates.push(['Tauri app-data', join(appData, 'com.mobi.pos', 'mobi_pos.db')]);
if (localAppData) candidates.push(['Tauri local-data', join(localAppData, 'com.mobi.pos', 'mobi_pos.db')]);
candidates.push(['repo root (expected absent)', join(process.cwd(), 'mobi_pos.db')]);

for (const [label, p] of candidates) await countLocal(p, label);
await countTurso();

if (!checkedAny && worst === 0) worst = 2;
log(`=== VERDICT: ${worst === 0 ? 'ALL ZERO (green light for 1b-i)' : worst === 1 ? 'NON-ZERO TAX FOUND — HALT for owner decision' : 'NO DATABASE REACHABLE (no evidence)'} ===`);
process.exit(worst);

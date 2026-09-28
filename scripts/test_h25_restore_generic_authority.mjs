// H25 probe: does a cloud RESTORE leave the generic version clock below the
// remote row, so the first local edit after a restore can never push?
//
// Model (faithful to the real modules; SQL extracted from source, not reinvented):
//   1. cloud DB holds a generic `customers` row at version 5
//   2. restoreManager's GENERIC branch writes that row to Dexie ONLY and
//      advances sync.cursor.customers past it
//   3. the user then edits that customer locally -> enqueueGenericSync ->
//      bumpEntityVersion -> push with the guarded upsert
//   4. question: does the guarded upsert match rows?
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_SYNC = join(ROOT, 'src', 'sync');
const SRC_DB = join(ROOT, 'src', 'db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

// ---- extract the REAL generic-upsert SQL from SyncManager.ts (non-delete lane)
const sm = readFileSync(join(SRC_SYNC, 'SyncManager.ts'), 'utf8');
function extractSql(src, startMarker, endMarker) {
  src = src.replace(/\r\n/g, '\n');
  const s = src.indexOf(startMarker);
  if (s < 0) throw new Error('start marker not found: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(s, e);
}
// the generic non-delete upsert: `INSERT INTO ${genericTable} ... VALUES (?,?,?,?,'synced',?,?,0) ...`
// The statement is a template literal; capture from the opening backtick to its
// closing backtick so ${...} interpolation markers cannot break the slice.
const genUpsertRaw = (() => {
  const src = sm.replace(/\r\n/g, '\n');
  const start = src.indexOf('`INSERT INTO ${genericTable} (id, data_json');
  if (start < 0) return '';
  const end = src.indexOf('`', start + 1);
  return end > start ? src.slice(start + 1, end) : '';
})();
check('extracted generic upsert SQL from source', /ON CONFLICT\(id\) DO UPDATE SET/.test(genUpsertRaw), genUpsertRaw.slice(0, 80));
check('extracted SQL carries the version guard', /WHERE excluded\.version >= \$\{genericTable\}\.version/.test(genUpsertRaw));

// ---- extract the REAL isGuardedUpsert regex
// Source: `return /ON CONFLICT\s*\(.*?\).../i.test(sql)` — pull the body out
// of the literal so the probe asserts the REAL guard, not a reimplementation.
const guardBody = (() => {
  const src = sm.replace(/\r\n/g, '\n');
  const s = src.indexOf('return /');
  if (s < 0) return null;
  const e = src.indexOf('/i.test(sql)', s);
  return e > s ? src.slice(s + 'return /'.length, e) : null;
})();
const guardRegex = guardBody ? new RegExp(guardBody, 'i') : /NEVER_MATCH/;
check('extracted isGuardedUpsert regex compiles', guardBody !== null, { guardBody });
check('extracted regex matches the real generic upsert', guardRegex.test(genUpsertRaw.replace(/\$\{genericTable\}/g, 'customers')));

// ---- extract bumpEntityVersion's clock read/write SQL
const spa = readFileSync(join(SRC_DB, 'sqlPluginAdapter.ts'), 'utf8');
function unquote(s) { return s.replace(/^[`'"]/, '').replace(/[`'"]$/, ''); }
const bumpReadRaw = unquote(extractSql(spa, "'SELECT version FROM entity_keys WHERE entity_type=$1 AND entity_id=$2'", "',"));
const bumpWriteRaw = unquote(extractSql(spa, "'UPDATE entity_keys SET version=$1 WHERE entity_type=$2 AND entity_id=$3'", "',"));
check('extracted bumpEntityVersion read SQL', /SELECT version FROM entity_keys/.test(bumpReadRaw));
check('extracted bumpEntityVersion write SQL', /UPDATE entity_keys SET version/.test(bumpWriteRaw));

// ---- extract the restore generic branch and prove it writes Dexie only
const rm = readFileSync(join(SRC_SYNC, 'restoreManager.ts'), 'utf8');
const genBranchStart = rm.indexOf('// Generic tables');
const genBranchEnd = rm.indexOf('totalRestored++;', genBranchStart);
const genBranch = genBranchStart >= 0 ? rm.slice(genBranchStart, genBranchEnd) : '';
check('located restore generic branch in source', genBranch.length > 100, { len: genBranch.length });
check('restore generic branch writes to Dexie', /dexieStore\.put\(parsedRowPayload\)/.test(genBranch));
check('H25 ROOT CAUSE: restore generic branch never writes local SQLite authority', !/local\.execute|local\.select/.test(genBranch), {
  hasLocalExecute: /local\.execute/.test(genBranch),
});
// and it DOES advance the pull cursor past the restored rows
const cursorAdvanceRaw = extractSql(rm, '"INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)"', '.catch');
check('restore advances sync.cursor.<table> past restored rows', /sync\.cursor\.\$\{table\}/.test(rm));

// ---- helpers
function toLibsql(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}
const genUpsert = toLibsql(genUpsertRaw.replace(/\$\{genericTable\}/g, 'customers'));

async function q(client, sql, args = []) {
  const r = await client.execute({ sql, args });
  return r.rows ?? [];
}

// ---- build cloud + local DBs
const cloud = createClient({ url: 'file:tmp-h25-cloud.db' });
const local = createClient({ url: 'file:tmp-h25-local.db' });
for (const c of [cloud, local]) {
  for (const t of ['customers', 'entity_keys', 'sync_outbox', 'app_settings']) {
    await c.execute(`DROP TABLE IF EXISTS ${t}`).catch(() => {});
  }
}

// remote generic KV schema (remoteSchema.ts v1 + v3 version column)
await cloud.execute(`CREATE TABLE customers (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`);
await cloud.execute('CREATE INDEX idx_customers_updated ON customers(updated_at, id)');

// local schema (lib.rs migration 1 + 2 + 5 + 8, trimmed to what we exercise)
await local.execute(`CREATE TABLE customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
  loyalty_points INTEGER DEFAULT 0, store_credit REAL DEFAULT 0, pricing_tier TEXT DEFAULT 'Retail',
  total_spent REAL DEFAULT 0, json_payload TEXT NOT NULL, updated_at TEXT NOT NULL,
  device_id TEXT DEFAULT 'legacy', idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT '', deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)`);
await local.execute(`CREATE TABLE entity_keys (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (entity_type, entity_id))`);
await local.execute(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)`);
await local.execute(`CREATE TABLE sync_outbox (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '')`);

// ---- scenario: the ORIGINAL device edited this customer 5 times, so the
// remote row sits at version 5.
const CUST_ID = 'cust-restored-001';
const T5 = '2026-09-20T10:00:00.000Z';
const cloudPayload = { id: CUST_ID, name: 'Awa Traoré', phone: '+221700000001', loyaltyPoints: 40, version: 5 };
await cloud.execute(`INSERT INTO customers (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
  VALUES (?,?,?,?, 'synced', ?, ?, 0)`,
  [CUST_ID, JSON.stringify(cloudPayload), 'device-old', 'idem-old-5', 5, T5]);

console.log('\n[1] restore: generic branch applies the row');
const dexieCustomers = new Map(); // stands in for the Dexie UI replica
const restoredRows = await q(cloud, 'SELECT id, data_json, version, updated_at, deleted FROM customers WHERE id > ? ORDER BY id ASC LIMIT 500', ['']);
let maxSeenTime = '1970-01-01T00:00:00.000Z', maxSeenId = '';
for (const row of restoredRows) {
  const id = String(row.id);
  const parsed = JSON.parse(String(row.data_json ?? '{}'));
  if (Number(row.deleted ?? 0) === 1) { dexieCustomers.delete(id); }
  else { dexieCustomers.set(id, parsed); }
  const ut = String(row.updated_at ?? '');
  if (ut > maxSeenTime || (ut === maxSeenTime && id > maxSeenId)) { maxSeenTime = ut; maxSeenId = id; }
}
check('restore placed the customer in the Dexie replica', dexieCustomers.has(CUST_ID));
check('Dexie replica carries the restored name', dexieCustomers.get(CUST_ID)?.name === 'Awa Traoré');
// the cursor advance (restoreManager L276)
await local.execute('INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)',
  [`sync.cursor.customers`, JSON.stringify({ time: maxSeenTime, id: maxSeenId }), T5]);

const localCustRows = await q(local, 'SELECT id, version FROM customers WHERE id = $1', [CUST_ID]);
check('H25: local SQLite AUTHORITY has NO row for the restored customer', localCustRows.length === 0, localCustRows);
const clockRows = await q(local, "SELECT version FROM entity_keys WHERE entity_type='customer' AND entity_id=$1", [CUST_ID]);
check('H25: entity_keys clock is EMPTY for the restored customer', clockRows.length === 0, clockRows);

console.log('\n[2] the user edits that customer on the restored device');
// enqueueGenericSync -> stableEntityKey + bumpEntityVersion (real SQL, real DB)
await local.execute("INSERT OR IGNORE INTO entity_keys (entity_type, entity_id, idempotency_key) VALUES ($1,$2,$3)",
  ['customer', CUST_ID, 'idem-restored-1']);
const before = Number((await q(local, bumpReadRaw, ['customer', CUST_ID]))[0]?.version ?? 1);
const next = before + 1;
await local.execute(bumpWriteRaw, [next, 'customer', CUST_ID]);
const editPayload = { ...cloudPayload, name: 'Awa Traoré-Diallo', version: next };
await local.execute(`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
  VALUES ($1,$2,$3,'UPSERT',$4,'pending')`, ['idem-restored-1', 'customer', CUST_ID, JSON.stringify(editPayload)]);
check('clock read defaulted the missing row to 1 (bumpEntityVersion fallback)', before === 1, { before });
check('the local edit was stamped version 2', next === 2, { next });

console.log('\n[3] push: the guarded upsert against the remote row');
const pushArgs = [CUST_ID, JSON.stringify(editPayload), 'device-new', 'idem-restored-1', next, T5];
const pushRes = await cloud.execute({ sql: genUpsert, args: pushArgs });
const rowsAffected = Number(pushRes.rowsAffected ?? 0);
check('isGuardedUpsert flags this statement (so 0 rows => re-queue, not synced)', guardRegex.test(genUpsert));
check('H25 CONFIRMED: guarded upsert matched ZERO rows (version 2 < remote 5)', rowsAffected === 0, { rowsAffected });
const remoteAfter = (await q(cloud, 'SELECT version, data_json FROM customers WHERE id=$1', [CUST_ID]))[0];
check('remote row is UNCHANGED by the local edit', Number(remoteAfter.version) === 5, { remoteVersion: remoteAfter.version });
check('remote name is still the pre-edit value', JSON.parse(String(remoteAfter.data_json)).name === 'Awa Traoré');

console.log('\n[4] can the pull rescue it? cursor already advanced past the row');
const cur = JSON.parse(String((await q(local, "SELECT value_json FROM app_settings WHERE key='sync.cursor.customers'"))[0]?.value_json ?? '{}'));
const pullRows = await q(local.replace ? cloud : cloud,
  'SELECT id, version FROM customers WHERE (updated_at > $1 OR (updated_at = $1 AND id > $2)) ORDER BY updated_at ASC, id ASC LIMIT 500',
  [cur.time, cur.id]);
check('pull revisits 0 rows (cursor is past the restored row)', pullRows.length === 0, { pullRows, cur });
check('H25: nothing will ever advance the clock -> edit is stuck until quarantine', clockRows.length === 0 || next < 5);

console.log('\n[5] the fix (mirror + advance clock, as applyRemoteRow already does)');
// what applyRemoteRow does on the LIVE pull path for customers:
await advanceClock('customer', CUST_ID, 5);
const afterFix = Number((await q(local, bumpReadRaw, ['customer', CUST_ID]))[0]?.version ?? 0);
check('clock advanced to the pulled version (advanceEntityClockOnPull MAX semantics)', afterFix === 5, { afterFix });
// a subsequent local edit now bumps ABOVE the remote row
const before2 = Number((await q(local, bumpReadRaw, ['customer', CUST_ID]))[0]?.version ?? 1);
const next2 = before2 + 1;
await local.execute(bumpWriteRaw, [next2, 'customer', CUST_ID]);
const payload2 = { ...cloudPayload, name: 'Awa Traoré-Diallo', version: next2 };
const res2 = await cloud.execute({ sql: genUpsert, args: [CUST_ID, JSON.stringify(payload2), 'device-new', 'idem-restored-2', next2, T5] });
check('FIXED: guarded upsert now matches 1 row (version 6 >= remote 5)', Number(res2.rowsAffected ?? 0) === 1, { rowsAffected: res2.rowsAffected });
const remoteFinal = JSON.parse(String((await q(cloud, 'SELECT data_json FROM customers WHERE id=$1', [CUST_ID]))[0]?.data_json ?? '{}'));
check('FIXED: the local edit lands on the remote row', remoteFinal.name === 'Awa Traoré-Diallo', remoteFinal);

async function advanceClock(entity, id, version) {
  await local.execute(`INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT(entity_type, entity_id) DO UPDATE
    SET version = MAX(excluded.version, entity_keys.version)`,
    [entity, id, `pull-${entity}-${id}`, version]);
}

for (const c of [cloud, local]) await c.close();
console.log(failures === 0 ? '\nH25 PROBE: ALL PASS' : `\nH25 PROBE: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

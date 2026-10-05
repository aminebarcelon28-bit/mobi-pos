// H25 regression: a cloud RESTORE must apply generic-KV rows to BOTH the local
// SQLite authority AND the Dexie replica, and must advance the `entity_keys`
// version clock, so the first local edit after a restore pushes strictly above
// the remote row and the guarded upsert lands instead of silently matching zero
// rows (contract C6).
//
// Faithfulness: the apply logic under test is a BYTE-IDENTICAL COPY of
// src/sync/genericApply.ts (copied at run time, never hand-transcribed), placed
// in a shim dir so its two bare imports resolve to stubs. The push lane is
// driven with SQL extracted from source, not reinvented. Dexie is stubbed
// (skipDexie is the documented escape hatch for hostile environments).
import { createClient } from '@libsql/client';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_SYNC = join(ROOT, 'src', 'sync');
const SRC_DB = join(ROOT, 'src', 'db');
const SHIM = join(ROOT, 'tmp-h25r-shim');
for (const f of readdirSync(ROOT)) {
  if (f.startsWith('tmp-h25r-') && f.endsWith('.db')) rmSync(join(ROOT, f), { force: true });
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

// ---------------------------------------------------------------------------
// Shim: copy the REAL genericApply.ts into tmp-h25r-shim and stub its two
// bare imports (Dexie + sqlPluginAdapter). The logic is untouched.
// ---------------------------------------------------------------------------
rmSync(SHIM, { recursive: true, force: true });
mkdirSync(join(SHIM, 'db'), { recursive: true });
// Copy one level below SHIM so the module's `../db/*` bare imports resolve
// onto the stub dir (from SHIM/lane, `../db/x` -> SHIM/db/x).
mkdirSync(join(SHIM, 'lane'), { recursive: true });
copyFileSync(join(SRC_SYNC, 'genericApply.ts'), join(SHIM, 'lane', 'genericApply.ts'));
// Node's ESM loader needs explicit extensions. Rewrite the bare
// import specifiers in the copy — no logic is touched. Heavy lanes
// (Dexie, sqlPluginAdapter) resolve to stubs; zero-dependency modules
// (causalVersion, ids) resolve to the REAL sources.
{
  const p = join(SHIM, 'lane', 'genericApply.ts');
  // Zero-dependency modules travel as copies (their own relative imports
  // get extensioned below); heavy lanes resolve to stubs.
  copyFileSync(join(SRC_SYNC, 'causalVersion.ts'), join(SHIM, 'lane', 'causalVersion.ts'));
  copyFileSync(join(SRC_SYNC, 'conflictWatch.ts'), join(SHIM, 'lane', 'conflictWatch.ts'));
  const realIds = pathToFileURL(join(ROOT, 'src', 'utils', 'ids.ts')).href;
  let t = readFileSync(p, 'utf8');
  t = t.replace(/from '\.\.\/db\/database'/g, "from '../db/database.js'")
       .replace(/from '\.\.\/db\/sqlPluginAdapter'/g, "from '../db/sqlPluginAdapter.js'")
       .replace(/from '\.\/causalVersion'/g, "from './causalVersion.ts'")
       .replace(/from '\.\/conflictWatch'/g, "from './conflictWatch.ts'")
       .replace(/from '\.\.\/utils\/dateUtils'/g, "from '../db/sqlPluginAdapter.js'")
       .replace(/from '\.\.\/utils\/ids'/g, `from '${realIds}'`);
  writeFileSync(p, t);
  {
    // conflictWatch.ts copy: extension its own relative import; its lone
    // dateUtils import (utcNowIso, TIME-001) resolves to the stub that
    // already exports it — same re-export the app uses.
    const cp = join(SHIM, 'lane', 'conflictWatch.ts');
    let ct = readFileSync(cp, 'utf8');
    ct = ct.replace(/from '\.\/causalVersion'/g, "from './causalVersion.ts'")
           .replace(/from '\.\.\/utils\/dateUtils'/g, "from '../db/sqlPluginAdapter.js'");
    writeFileSync(cp, ct);
  }
  writeFileSync(p, t);
}

// ../db/database — Dexie replica. Unused under skipDexie; provide no-op stores.
writeFileSync(join(SHIM, 'db', 'database.js'), `
const noop = { put: async () => {}, delete: async () => {}, get: async () => undefined };
export const db = new Proxy({}, { get: () => noop });
`);

// ../db/sqlPluginAdapter — sanitizeSyncPayload (identity for well-formed small
// payloads) + utcNowIso.
writeFileSync(join(SHIM, 'db', 'sqlPluginAdapter.js'), `
export function sanitizeSyncPayload(p) { return p; }
export function utcNowIso() { return new Date().toISOString(); }
export function isDeviceLocalSettingKey() { return false; }
export const RECEIPT_SETTINGS_KEY = 'mobi_pos_receipt_settings';
export function isRetryableDbError() { return false; }
`);

const { applyGenericRemoteRow, appliedGenericVersion, GENERIC_PULL } = await import(
  pathToFileURL(join(SHIM, 'lane', 'genericApply.ts')).href
);

// ---------------------------------------------------------------------------
// Extract the REAL push-lane SQL from source (never reinvented).
// ---------------------------------------------------------------------------
const sm = readFileSync(join(SRC_SYNC, 'SyncManager.ts'), 'utf8').replace(/\r\n/g, '\n');
const spa = readFileSync(join(SRC_DB, 'sqlPluginAdapter.ts'), 'utf8').replace(/\r\n/g, '\n');

// generic guarded upsert (push lane). Slice backtick-to-backtick so ${...}
// interpolation markers cannot break the slice.
const genUpsertRaw = (() => {
  const start = sm.indexOf('`INSERT INTO ${genericTable} (id, data_json');
  if (start < 0) return '';
  const end = sm.indexOf('`', start + 1);
  return end > start ? sm.slice(start + 1, end) : '';
})();
function toLibsql(sql) { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); }
// The extracted SQL carries the shared-predicate marker verbatim; resolve it
// through the REAL helper (zero-dependency, same predicate production runs).
import { tiedVersionGuardSql } from '../src/sync/causalVersion.ts';
const genUpsert = toLibsql(
  genUpsertRaw
    .replace(/\$\{genericTable\}/g, 'customers')
    .replace(/\$\{tiedVersionGuardSql\(genericTable\)\}/g, tiedVersionGuardSql('customers'))
);
check('extracted the real generic push upsert SQL', /ON CONFLICT\(id\) DO UPDATE SET/.test(genUpsert));
check('push upsert carries the version guard (shared tiebreak predicate)',
  /excluded\.version > customers\.version/.test(genUpsert) &&
  /COALESCE\(excluded\.device_id/.test(genUpsert));

function extractSql(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) throw new Error('start marker not found: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(s, e);
}
function unquote(s) { return s.replace(/^[`'"]/, '').replace(/[`'"]$/, ''); }
const bumpReadRaw = unquote(extractSql(spa, "'SELECT version FROM entity_keys WHERE entity_type=$1 AND entity_id=$2'", "',"));
const bumpWriteRaw = unquote(extractSql(spa, "'UPDATE entity_keys SET version=$1 WHERE entity_type=$2 AND entity_id=$3'", "',"));
check('extracted bumpEntityVersion clock read SQL', /SELECT version FROM entity_keys/.test(bumpReadRaw));
check('extracted bumpEntityVersion clock write SQL', /UPDATE entity_keys SET version/.test(bumpWriteRaw));

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const cloud = createClient({ url: 'file:tmp-h25r-cloud.db' });
const local = createClient({ url: 'file:tmp-h25r-local.db' });
for (const c of [cloud, local]) {
  for (const t of ['customers', 'customer_debts', 'entity_keys', 'sync_outbox', 'app_settings']) {
    await c.execute(`DROP TABLE IF EXISTS ${t}`).catch(() => {});
  }
}

await cloud.execute(`CREATE TABLE customers (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`);
await cloud.execute(`CREATE TABLE customer_debts (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`);

// local schema (src-tauri/src/lib.rs migrations 1/2/5/8, trimmed to what we exercise)
await local.execute(`CREATE TABLE customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
  loyalty_points INTEGER DEFAULT 0, store_credit REAL DEFAULT 0, pricing_tier TEXT DEFAULT 'Retail',
  total_spent REAL DEFAULT 0, json_payload TEXT NOT NULL, updated_at TEXT NOT NULL,
  device_id TEXT DEFAULT 'legacy', idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT '', deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)`);
await local.execute(`CREATE TABLE customer_debts (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT NOT NULL, type TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0, balance_after REAL NOT NULL DEFAULT 0, receipt_number TEXT,
  payment_method TEXT, notes TEXT, recorded_by TEXT, created_at TEXT NOT NULL,
  json_payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, device_id TEXT DEFAULT 'legacy')`);
await local.execute(`CREATE TABLE entity_keys (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (entity_type, entity_id))`);
await local.execute(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)`);
await local.execute(`CREATE TABLE sync_outbox (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`);

// The module calls the plugin-sql Database API (`db.select(sql, args)` /
// `db.execute(sql, args)`), which @libsql/client does not have. Adapt: select()
// returns the rows array; execute() returns the raw result.
function asPluginSql(client) {
  return {
    select: async (sql, args = []) => (await client.execute({ sql, args })).rows ?? [],
    execute: async (sql, args = []) => client.execute({ sql, args }),
  };
}

async function q(client, sql, args = []) {
  const r = await client.execute({ sql, args });
  return r.rows ?? [];
}

// ---------------------------------------------------------------------------
// Scenario: another device edited this customer 5 times; the remote row is v5.
// ---------------------------------------------------------------------------
const CUST_ID = 'cust-h25r-001';
const DEBT_ID = 'debt-h25r-001';
const T5 = '2026-09-20T10:00:00.000Z';
const cloudPayload = { id: CUST_ID, name: 'Awa Traoré', phone: '+221700000001', loyaltyPoints: 40, version: 5 };
const cloudDebt = { id: DEBT_ID, customerId: CUST_ID, customerName: 'Awa Traoré', type: 'DEBT_ACQUIRED', amount: 15000, balanceAfter: 15000, version: 3 };

await cloud.execute(`INSERT INTO customers (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
  VALUES ($1,$2,$3,$4,'synced',$5,$6,0)`,
  [CUST_ID, JSON.stringify(cloudPayload), 'device-old', 'idem-old-5', 5, T5]);
await cloud.execute(`INSERT INTO customer_debts (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
  VALUES ($1,$2,$3,$4,'synced',$5,$6,0)`,
  [DEBT_ID, JSON.stringify(cloudDebt), 'device-old', 'idem-old-debt-3', 3, T5]);

// ===========================================================================
console.log('\n[1] RESTORE applies generic rows through the shared path');
// ===========================================================================
// The restore loop reads rows from the cloud and hands each to the shared
// apply function. Dexie is unavailable in this Node harness, so skip it — the
// authority + clock assertions below are what H25 is about.
const restoredRows = await q(cloud, 'SELECT id, data_json, version, updated_at, deleted FROM customers WHERE id > $1 ORDER BY id ASC LIMIT 500', ['']);
for (const row of restoredRows) {
  await applyGenericRemoteRow(asPluginSql(local), 'customers', row, { skipDexie: true });
}
const debtRows = await q(cloud, 'SELECT id, data_json, version, updated_at, deleted FROM customer_debts WHERE id > $1 ORDER BY id ASC LIMIT 500', ['']);
for (const row of debtRows) {
  await applyGenericRemoteRow(asPluginSql(local), 'customer_debts', row, { skipDexie: true });
}

const localCust = await q(local, 'SELECT id, name, version, deleted FROM customers WHERE id = $1', [CUST_ID]);
check('restore wrote the customer into the local SQLite AUTHORITY', localCust.length === 1, localCust);
check('authority row carries the restored name', localCust[0]?.name === 'Awa Traoré', localCust[0]);
check('authority row carries the remote version', Number(localCust[0]?.version) === 5, localCust[0]);

const clockAfterRestore = await appliedGenericVersion(asPluginSql(local), 'customers', CUST_ID);
check('entity_keys clock advanced to the restored version (5)', clockAfterRestore === 5, { clockAfterRestore });
const debtClock = await appliedGenericVersion(asPluginSql(local), 'customer_debts', DEBT_ID);
check('debt lane clock advanced to its restored version (3)', debtClock === 3, { debtClock });

const localDebt = await q(local, 'SELECT id, customer_id, amount, version FROM customer_debts WHERE id = $1', [DEBT_ID]);
check('restore wrote the debt into the local SQLite AUTHORITY', localDebt.length === 1, localDebt);
check('debt authority row carries the remote version', Number(localDebt[0]?.version) === 3, localDebt[0]);

// ===========================================================================
console.log('\n[2] the user edits the restored customer; the edit must SURVIVE');
// ===========================================================================
// enqueueGenericSync -> stableEntityKey + bumpEntityVersion (real SQL)
await local.execute('INSERT OR IGNORE INTO entity_keys (entity_type, entity_id, idempotency_key) VALUES ($1,$2,$3)',
  ['customer', CUST_ID, 'idem-restored-1']);
const before = Number((await q(local, bumpReadRaw, ['customer', CUST_ID]))[0]?.version ?? 1);
const next = before + 1;
await local.execute(bumpWriteRaw, [next, 'customer', CUST_ID]);
check('the clock read is now the RESTORED version, not the empty-state 1', before === 5, { before });
check('the local edit is stamped version 6 (strictly above remote 5)', next === 6, { next });

const editPayload = { ...cloudPayload, name: 'Awa Traoré-Diallo', version: next };
await local.execute(`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
  VALUES ($1,$2,$3,'UPSERT',$4,'pending')`, ['idem-restored-1', 'customer', CUST_ID, JSON.stringify(editPayload)]);

const pushRes = await cloud.execute({ sql: genUpsert, args: [CUST_ID, JSON.stringify(editPayload), 'device-new', 'idem-restored-1', next, T5] });
check('FIXED: guarded upsert matches 1 row (version 6 >= remote 5)', Number(pushRes.rowsAffected ?? 0) === 1, { rowsAffected: pushRes.rowsAffected });
const remoteAfter = JSON.parse(String((await q(cloud, 'SELECT data_json FROM customers WHERE id=$1', [CUST_ID]))[0]?.data_json ?? '{}'));
check('FIXED: the local edit lands on the remote row', remoteAfter.name === 'Awa Traoré-Diallo', remoteAfter);

// ===========================================================================
console.log('\n[3] the tombstone path still guards (H19 regression)');
// ===========================================================================
// A STALE tombstone (v2) arriving after a NEWER local apply must NOT delete.
const staleTomb = { id: CUST_ID, data_json: JSON.stringify(cloudPayload), version: 2, updated_at: T5, deleted: 1 };
await applyGenericRemoteRow(asPluginSql(local), 'customers', staleTomb, { skipDexie: true });
const afterStaleTomb = await q(local, 'SELECT deleted, version FROM customers WHERE id = $1', [CUST_ID]);
check('stale tombstone (v2 < local 5) does not touch the authority row', afterStaleTomb.length === 1 && Number(afterStaleTomb[0]?.deleted) === 0, afterStaleTomb);
check('stale tombstone does not lower the clock', (await appliedGenericVersion(asPluginSql(local), 'customers', CUST_ID)) === 6);

// A FRESH tombstone (v7 > 6) DOES delete.
const freshTomb = { id: CUST_ID, data_json: JSON.stringify(cloudPayload), version: 7, updated_at: T5, deleted: 1 };
await applyGenericRemoteRow(asPluginSql(local), 'customers', freshTomb, { skipDexie: true });
const afterFreshTomb = await q(local, 'SELECT deleted FROM customers WHERE id = $1', [CUST_ID]);
check('fresh tombstone (v7 > 6) marks the authority row deleted', Number(afterFreshTomb[0]?.deleted) === 1, afterFreshTomb);
check('fresh tombstone advances the clock to 7', (await appliedGenericVersion(asPluginSql(local), 'customers', CUST_ID)) === 7);

// ===========================================================================
console.log('\n[4] restore path and pull path produce IDENTICAL local state');
// ===========================================================================
// H25 was a divergence bug. Feed the same row through the same function from
// two fresh local DBs and assert the resulting authority + clock match.
const a = createClient({ url: 'file:tmp-h25r-restore.db' });
const b = createClient({ url: 'file:tmp-h25r-pull.db' });
for (const c of [a, b]) {
  await c.execute(`CREATE TABLE customers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
    loyalty_points INTEGER DEFAULT 0, store_credit REAL DEFAULT 0, pricing_tier TEXT DEFAULT 'Retail',
    total_spent REAL DEFAULT 0, json_payload TEXT NOT NULL, updated_at TEXT NOT NULL,
    device_id TEXT DEFAULT 'legacy', idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT '', deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)`);
  await c.execute(`CREATE TABLE entity_keys (
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (entity_type, entity_id))`);
}
const sharedRow = { id: 'cust-divergence-001', data_json: JSON.stringify({ id: 'cust-divergence-001', name: 'Moussa Ba', phone: '+221770000002', version: 4 }), version: 4, updated_at: '2026-09-21T09:00:00.000Z', deleted: 0 };
await applyGenericRemoteRow(asPluginSql(a), 'customers', sharedRow, { skipDexie: true }); // restore path
await applyGenericRemoteRow(asPluginSql(b), 'customers', sharedRow, { skipDexie: true }); // live pull path
const ra = await q(a, 'SELECT id,name,version,deleted FROM customers WHERE id=$1', ['cust-divergence-001']);
const rb = await q(b, 'SELECT id,name,version,deleted FROM customers WHERE id=$1', ['cust-divergence-001']);
check('both paths write the authority row', ra.length === 1 && rb.length === 1, { ra, rb });
check('both paths write the same authority row', JSON.stringify(ra) === JSON.stringify(rb), { ra, rb });
check('both paths advance the clock identically',
  (await appliedGenericVersion(asPluginSql(a), 'customers', 'cust-divergence-001')) ===
  (await appliedGenericVersion(asPluginSql(b), 'customers', 'cust-divergence-001')));

// ===========================================================================
console.log('\n[5] app_settings sync.* keys are never replicated');
// ===========================================================================
const cursorRow = { id: 'sync.cursor.customers', data_json: JSON.stringify({ key: 'sync.cursor.customers', value: { time: T5 } }), version: 1, updated_at: T5, deleted: 0 };
await applyGenericRemoteRow(asPluginSql(local), 'app_settings', cursorRow, { skipDexie: true });
const leaked = await q(local, "SELECT key FROM app_settings WHERE key LIKE 'sync.%'");
check('a sync.* key is not written to the authority', leaked.length === 0, leaked);

// ===========================================================================
console.log('\n[6] the shared map covers every generic lane');
// ===========================================================================
const expected = ['customers','repair_orders','purchase_orders','trade_ins','imei_records',
  'security_audit_logs','cash_drops','product_bundles','customer_debts','store_expenses',
  'cash_sessions','cash_movements','app_settings'];
check('GENERIC_PULL covers all 13 generic lanes', expected.every((t) => !!GENERIC_PULL[t]), Object.keys(GENERIC_PULL));

for (const c of [cloud, local, a, b]) await c.close();
rmSync(SHIM, { recursive: true, force: true });
console.log(failures === 0 ? '\nH25 REGRESSION: ALL PASS' : `\nH25 REGRESSION: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

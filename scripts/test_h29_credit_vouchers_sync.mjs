/**
 * H29 regression: credit_vouchers must be a first-class SYNC surface.
 *
 * `credit_voucher` was declared as a generic sync entity (GenericEntity,
 * SyncEntityType, the Dexie v6 schema, the local SQLite schema) and
 * `fireSync('credit_voucher', ...)` fired on every create/redeem — but
 * `credit_vouchers` was wired into NONE of the sync surfaces:
 *   - GENERIC_SYNC_TABLES / ALL_REMOTE_SYNC_TABLES (remoteSchema)  -> no table
 *   - SyncManager GENERIC_TABLES / GENERIC_PULL                    -> push null + no pull lane
 *   - genericApply GENERIC_TABLES / GENERIC_PULL                   -> no apply path
 *   - migrationManager dexieMapping                                 -> no restore verify
 * Consequences (contract C6, silent data loss):
 *   (a) PUSH: toRemoteUpsert returned null for every voucher mutation, so the
 *       outbox row was marked `failed` with "entité non reconnu" and the
 *       voucher never reached the cloud.
 *   (b) PULL/RESTORE: the table was not in the iterated set, so a voucher
 *       created on another device could never arrive here at all.
 *   (c) even if push worked, no remote table existed to receive it.
 *
 * This test drives the REAL sync sources (remoteSchema, genericApply,
 * SyncManager.toRemoteUpsert) against REAL on-disk SQLite databases built from
 * the REAL Rust migration DDL (local) and the REAL remote migration DDL
 * (remoteSchema.REMOTE_MIGRATIONS). Tauri + Dexie are stubbed so the test runs
 * headless; the SQL under test is the real source, nothing reconstructed.
 *
 *   [0] credit_vouchers is in every sync surface (compile-time wiring)
 *   [1] migration v7 creates the remote table; applyRemoteMigrations lands it
 *   [2] PUSH: toRemoteUpsert for a credit_voucher op returns a real statement
 *       (not null) targeting credit_vouchers, and it writes the KV pair
 *   [3] PULL: applyGenericRemoteRow lands the row in BOTH the SQLite authority
 *       and the Dexie replica, with the correct camelCase reshape
 *   [4] PULL advances entity_keys so a later local push cannot emit v2-vs-v5
 *   [5] a negative remaining_amount remote row is CLAMPED to 0 (no throw, no
 *       frozen lane) — the remote table has no CHECK, the local one does
 *   [6] a tombstone sets deleted=1 / status='EXHAUSTED' in SQLite + clears Dexie
 *   [7] replay is idempotent (guarded upsert matches, no phantom rows)
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  readFileSync, writeFileSync, unlinkSync, existsSync,
  mkdirSync, rmSync, statSync,
} from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { createClient } from '@libsql/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SHIM = join(ROOT, 'tmp-h29-shim');
const LOCAL_DB = join(ROOT, 'tmp-h29-local.db');
const REMOTE_DB = join(ROOT, 'tmp-h29-remote.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`); }
}

// ---------------------------------------------------------------------------
// 0. Fresh scratch space (Windows EPERM retries)
// ---------------------------------------------------------------------------
rmSync(SHIM, { recursive: true, force: true });
for (const f of [LOCAL_DB, `${LOCAL_DB}-wal`, `${LOCAL_DB}-shm`, REMOTE_DB, `${REMOTE_DB}-wal`, `${REMOTE_DB}-shm`]) {
  for (let i = 0; i < 5; i++) { try { if (existsSync(f)) unlinkSync(f); break; } catch { /* retry */ } }
}
mkdirSync(join(SHIM, 'db'), { recursive: true });
mkdirSync(join(SHIM, 'sync'), { recursive: true });
mkdirSync(join(SHIM, 'types'), { recursive: true });
mkdirSync(join(SHIM, 'utils'), { recursive: true });

// ---------------------------------------------------------------------------
// 1. Two REAL databases: local authority (Rust DDL) + remote (REMOTE_MIGRATIONS)
// ---------------------------------------------------------------------------
const libRs = readFileSync(join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const rustMigrations = [...libRs.matchAll(/sql:\s*r#"\r?\n([\s\S]*?)"#/g)].map((m) => m[1]);
if (rustMigrations.length < 8) { console.error(`FAIL: extracted ${rustMigrations.length} Rust migrations`); process.exit(1); }

const local = createClient({ url: `file:${LOCAL_DB.replace(/\\/g, '/')}` });
await local.execute('PRAGMA journal_mode=WAL;');
await local.execute('PRAGMA synchronous=NORMAL;');
await local.execute('PRAGMA foreign_keys=ON;');
let localStmts = 0;
for (const m of rustMigrations) {
  for (const raw of m.split(';')) {
    const stmt = raw.trim();
    if (!stmt || stmt.startsWith('--')) continue;
    try { await local.execute(stmt); localStmts++; } catch { /* duplicate column/index — expected */ }
  }
}
// JS boot pass carries additional column/index statements.
const jsBoot = readFileSync(join(ROOT, 'src', 'db', 'sqlPluginAdapter.ts'), 'utf8');
// The JS boot block mixes single-quoted one-liners with backtick template
// literals (the credit_vouchers CREATE TABLE is a backtick literal). Harvest
// BOTH quote styles so the local authority really has every table.
const jsStatements = [
  ...jsBoot.matchAll(/'((?:CREATE|ALTER|UPDATE)[^']*)'/g),
  ...jsBoot.matchAll(/`((?:CREATE|ALTER|UPDATE)[\s\S]*?)`/g),
]
  .map((m) => m[1])
  .filter((s) => /^(CREATE|ALTER|UPDATE)/.test(s.trim()));
for (const stmt of jsStatements) {
  try { await local.execute(stmt); localStmts++; } catch { /* expected dupes */ }
}
console.log(`  [schema] local authority: ${localStmts} statements`);

const remote = createClient({ url: `file:${REMOTE_DB.replace(/\\/g, '/')}` });
await remote.execute('PRAGMA journal_mode=WAL;');

// ---------------------------------------------------------------------------
// 2. Compile-time wiring (read the REAL source, no reconstruction)
// ---------------------------------------------------------------------------
console.log('\n  --- [0] sync surface wiring ---');
const remoteSchemaSrc = readFileSync(join(ROOT, 'src', 'sync', 'remoteSchema.ts'), 'utf8');
check('[0a] credit_vouchers in GENERIC_SYNC_TABLES', /'credit_vouchers'/.test(remoteSchemaSrc));
check('[0b] LATEST_REMOTE_VERSION covers v8 (claims table)', /export const LATEST_REMOTE_VERSION\s*=\s*([8-9]|[1-9][0-9])/.test(remoteSchemaSrc));

const syncManagerSrc = readFileSync(join(ROOT, 'src', 'sync', 'SyncManager.ts'), 'utf8');
check('[0c] SyncManager imports GENERIC_TABLES single-source (covers credit_voucher push)', /import\s*\{[^}]*\bGENERIC_TABLES\b[^}]*\}\s*from\s*['"]\.\/genericApply['"]/.test(syncManagerSrc) && !/^\s*const GENERIC_TABLES\s*[:=]/m.test(syncManagerSrc));
check('[0d] credit_vouchers in SyncManager GENERIC_PULL (pull)', /credit_vouchers:\s*\{\s*dexie:\s*'creditVouchers'/.test(syncManagerSrc));

const genericApplySrc = readFileSync(join(ROOT, 'src', 'sync', 'genericApply.ts'), 'utf8');
check('[0e] credit_voucher in genericApply GENERIC_TABLES (clock inversion)', /credit_voucher:\s*'credit_vouchers'/.test(genericApplySrc));
check('[0f] genericApply mirrors credit_vouchers into SQLite', /table === 'credit_vouchers'/.test(genericApplySrc));

const migrationManagerSrc = readFileSync(join(ROOT, 'src', 'sync', 'migrationManager.ts'), 'utf8');
check('[0g] credit_vouchers in migrationManager dexieMapping (restore verify)', /credit_vouchers:\s*'creditVouchers'/.test(migrationManagerSrc));

// ---------------------------------------------------------------------------
// 3. Build the shim tree: real sync sources, stubbed runtime deps
// ---------------------------------------------------------------------------
const SRC = (...p) => join(ROOT, 'src', ...p);
const DST = (...p) => join(SHIM, ...p);

const REAL_ROOTS = [
  'sync/remoteSchema.ts',
  'sync/genericApply.ts',
  'sync/SyncManager.ts',
  'sync/tursoClient.ts',
  'sync/keychain.ts',
  'sync/types.ts',
  'db/sqlPluginAdapter.ts',
  'db/writeMutex.ts',
  'utils/ids.ts',
];
// dexie needs IndexedDB, which does not exist headless — stub its wrapper with
// an in-memory map per store so the Dexie-reshape branch is actually exercised.
const STUB_MODULES = new Set(['db/database.ts']);

const closure = new Set();
function walkClosure(rel) {
  if (closure.has(rel)) return;
  let body;
  try { body = readFileSync(SRC(...rel.split(/[\\/]/)), 'utf8'); } catch { return; }
  closure.add(rel);
  for (const m of body.matchAll(/from\s+'([^']+)'/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const base = normalize(join(dirname(rel), spec));
    // A specifier may name a DIRECTORY ('../constants') — resolve to the real
    // file (index.ts). It may ALSO already carry an extension
    // ('../sync/eventInterceptor.ts') — try the exact form first so the
    // closure walk does not silently drop that module.
    const cands = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].map((c) => c.split(/[\\/]/).join('/'));
    const found = cands.find((c) => { try { return statSync(SRC(...c.split(/[\\/]/))).isFile(); } catch { return false; } });
    if (found) walkClosure(found);
  }
}
for (const r of REAL_ROOTS) walkClosure(r);
for (const r of [...closure]) { closure.delete(r); closure.add(r.split(/[\\/]/).join('/')); }

const DEXIE_STORES = [
  'products', 'customers', 'transactions', 'transactionItems', 'repairOrders',
  'purchaseOrders', 'tradeIns', 'imeiRecords', 'securityAuditLogs', 'cashDrops',
  'payouts', 'bundles', 'customerDebts', 'storeExpenses', 'cashSessions',
  'cashMovements', 'stockBatches', 'creditVouchers', 'appSettings',
];
const dexieStubBody = [
  '// headless dexie stub: an in-memory Map per store, so the Dexie-reshape',
  '// branches in genericApply are really exercised (put/get/delete/toArray).',
  'const stores = Object.fromEntries([',
  ...DEXIE_STORES.map((n) => `  ['${n}', new Map()],`),
  ']);',
  'function table(name) {',
  '  const m = stores[name] ?? (stores[name] = new Map());',
  '  return {',
  '    get: async (k) => m.get(k),',
  '    put: async (o) => { const key = (o && (o.id ?? o.batchId ?? o.key)) ?? String(m.size); m.set(key, o); },',
  '    delete: async (k) => { m.delete(k); },',
  '    toArray: async () => [...m.values()],',
  '    count: async () => m.size,',
  '    clear: async () => { m.clear(); },',
  '    where: () => ({ equals: () => ({ toArray: async () => [] }) }),',
  '  };',
  '}',
  'export const db = new Proxy({',
  ...DEXIE_STORES.map((n) => `  ${n}: table('${n}'),`),
  '  transaction: async () => table("__tx__"),',
  '}, { get: (t, k) => (k in t ? t[k] : table(String(k))) });',
].join('\n');

// Node 24 strips TS types only for .ts files, and then every relative
// specifier must carry an explicit extension. Resolve to the real file first
// (index.ts for directory specifiers) instead of blindly appending .ts.
function resolveSpec(rel, spec) {
  if (!spec.startsWith('.')) return spec;
  const base = normalize(join(dirname(rel), spec));
  const cands = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].map((c) => c.split(/[\\/]/).join('/'));
  const found = cands.find((c) => { try { return statSync(SRC(...c.split(/[\\/]/))).isFile(); } catch { return false; } });
  if (!found) return /[.](?:js|ts)$/.test(spec) ? spec : `${spec}.ts`;
  // Node requires an explicit relative marker; path.relative() drops the
  // leading './' for same-directory targets ('writeMutex' is NOT resolvable,
  // './writeMutex.ts' is).
  const out = relative(dirname(rel), found).split(/[\\/]/).join('/');
  return out.startsWith('.') ? out : `./${out}`;
}

for (const rel of closure) {
  const parts = rel.split(/[\\/]/);
  mkdirSync(dirname(DST(...parts)), { recursive: true });
  const body = STUB_MODULES.has(rel) ? dexieStubBody : readFileSync(SRC(...parts), 'utf8');
  // Node 24 strips TS types only for .ts files, and then every relative
  // specifier must carry an explicit extension. Handle BOTH the bare
  // `from '...'` and the parenthesized `from('...')` forms, and never
  // rewrite bare (non-relative) module specifiers like '@libsql/client'.
  const t = body
    .replace(/(^|[^\w$])from\s+'(\.\.?(?:\/[^']*)?)'/g, (full, pre, spec) => `${pre}from '${resolveSpec(rel, spec)}'`)
    .replace(/import\s*\(\s*'(\.\.?(?:\/[^']*)?)'\s*\)/g, (full, spec) => `import('${resolveSpec(rel, spec)}')`);
  writeFileSync(DST(...parts), t);
}

// @tauri-apps/plugin-sql stub backed by the SAME real libsql local client.
writeFileSync(DST('tauriStub.js'), `
import { createClient } from '@libsql/client';
const client = createClient({ url: 'file:${LOCAL_DB.replace(/\\/g, '/')}' });
export default class Database {
  static async load() { return new Database(); }
  // The app convention (verified across src/: every call site casts the
  // result to Array<...> and indexes it directly, e.g. rows?.[0]?.version)
  // is that select() resolves to the ROW ARRAY, not { rows }. Match it.
  async select(sql, args) {
    const res = await client.execute({ sql, args: args ?? [] });
    return res.rows;
  }
  async execute(sql, args) {
    if (Array.isArray(args)) return client.execute({ sql, args });
    return client.execute(sql);
  }
}
`);

// Point the real sources at the stubs instead of the native modules, and drop
// the type-only imports the shim's minimal types/pos cannot satisfy.
{
  const p = DST('db', 'sqlPluginAdapter.ts');
  let t = readFileSync(p, 'utf8');
  t = t.replace("import Database from '@tauri-apps/plugin-sql';", "import Database from '../tauriStub.js';");
  t = t.replace(/import type \{ Product \} from '\.\.\/types\/pos\.js';/, '');
  writeFileSync(p, t);
}
{
  const p = DST('sync', 'genericApply.ts');
  let t = readFileSync(p, 'utf8');
  t = t.replace("import type Database from '@tauri-apps/plugin-sql';", "import type Database from '../tauriStub.js';");
  writeFileSync(p, t);
}
{
  const p = DST('sync', 'SyncManager.ts');
  let t = readFileSync(p, 'utf8');
  t = t.replace("import type Database from '@tauri-apps/plugin-sql';", "import type Database from '../tauriStub.js';");
  writeFileSync(p, t);
}

// ---------------------------------------------------------------------------
// 4. [1] Remote schema: migration v7 must create the credit_vouchers table
// ---------------------------------------------------------------------------
console.log('\n  --- [1] remote migration v7 ---');
const rs = await import(pathToFileURL(DST('sync', 'remoteSchema.ts')).href);
check('[1a] REMOTE_MIGRATIONS reaches version 7', rs.REMOTE_MIGRATIONS.some((m) => m.version === 7));
const v7 = rs.REMOTE_MIGRATIONS.find((m) => m.version === 7);
check('[1b] v7 creates credit_vouchers', v7 && v7.statements.some((s) => /CREATE TABLE IF NOT EXISTS credit_vouchers/.test(s)));
check('[1c] credit_vouchers is a whitelisted sync table', rs.isValidSyncTable('credit_vouchers'));
try { rs.assertValidSyncTable('credit_vouchers'); check('[1d] assertValidSyncTable accepts credit_vouchers', true); }
catch (e) { check('[1d] assertValidSyncTable accepts credit_vouchers', false, String(e)); }

const applied = await rs.applyRemoteMigrations(remote);
check('[1e] applyRemoteMigrations runs to LATEST_REMOTE_VERSION', applied === rs.LATEST_REMOTE_VERSION, `${applied} vs ${rs.LATEST_REMOTE_VERSION}`);
const remoteTables = (await remote.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='credit_vouchers'")).rows;
check('[1f] remote credit_vouchers table physically exists', remoteTables.length === 1, remoteTables.length);
const remoteCols = (await remote.execute("SELECT name FROM pragma_table_info('credit_vouchers')")).rows.map((r) => r.name);
check('[1g] remote credit_vouchers has the KV columns', ['id', 'data_json', 'version', 'updated_at', 'deleted'].every((c) => remoteCols.includes(c)), remoteCols);

// ---------------------------------------------------------------------------
// 5. [2] PUSH: toRemoteUpsert must emit a real credit_vouchers statement
// ---------------------------------------------------------------------------
console.log('\n  --- [2] push lane ---');
const sm = await import(pathToFileURL(DST('sync', 'SyncManager.ts')).href);
const voucherId = 'h29-vch-001';
const voucherPayload = {
  id: voucherId, code: 'H29-1001', initialAmount: 10000, remainingAmount: 4000,
  status: 'ACTIVE', customerName: 'Client H29', customerPhone: '0555000029',
  notes: 'test H29', createdAt: '2026-09-14T10:00:00.000Z', updatedAt: '2026-09-14T10:00:00.000Z',
  version: 3, device_id: 'device-B',
};
const op = {
  idempotency_key: `idem-${voucherId}`,
  entity_type: 'credit_voucher',
  entity_id: voucherId,
  operation: 'UPSERT',
  payload_json: JSON.stringify(voucherPayload),
};
// toRemoteUpsert is private; reach it through the instance the same way the
// push loop does (the push loop calls it on a real SyncManager instance).
const mgr = sm.syncManager;
const stmt = mgr.toRemoteUpsert(op, '2026-09-14T10:00:01.000Z');
check('[2a] toRemoteUpsert returns a statement (was null before H29)', stmt !== null && stmt !== undefined, stmt);
if (stmt) {
  check('[2b] statement targets credit_vouchers', /INTO credit_vouchers /.test(stmt.sql), stmt.sql.slice(0, 60));
  check('[2c] statement carries the version guard', /WHERE excluded\.version >= credit_vouchers\.version/.test(stmt.sql));
  check('[2d] args carry the entity id + payload', stmt.args[0] === voucherId, stmt.args[0]);
  // Actually execute it against the REAL remote DB.
  await remote.execute({ sql: stmt.sql, args: stmt.args });
  const pushed = (await remote.execute("SELECT id, data_json, version, deleted FROM credit_vouchers WHERE id = ?", [voucherId])).rows;
  check('[2e] push wrote the remote KV row', pushed.length === 1, pushed.length);
  if (pushed.length === 1) {
    let dj = null;
    try { dj = JSON.parse(pushed[0].data_json); } catch { /* malformed */ }
    check('[2f] remote data_json carries the voucher code', dj && dj.code === 'H29-1001', dj && dj.code);
    check('[2g] remote version stamped', Number(pushed[0].version) === 3, pushed[0].version);
  }
}

// ---------------------------------------------------------------------------
// 6. [3][4] PULL: applyGenericRemoteRow must land BOTH stores + advance clock
// ---------------------------------------------------------------------------
console.log('\n  --- [3][4] pull lane ---');
const ga = await import(pathToFileURL(DST('sync', 'genericApply.ts')).href);
const sql = await import(pathToFileURL(DST('db', 'sqlPluginAdapter.ts')).href);
const localDb = await sql.getLocalDb();

const pulledRow = {
  id: voucherId,
  data_json: JSON.stringify({
    code: 'H29-1001', initial_amount: 10000, remaining_amount: 4000, status: 'ACTIVE',
    customer_name: 'Client H29', customer_phone: '0555000029', notes: 'test H29',
    created_at: '2026-09-14T10:00:00.000Z', updated_at: '2026-09-14T11:00:00.000Z',
    expires_at: null, idempotency_key: `idem-${voucherId}`, device_id: 'device-B',
  }),
  version: 5,
  updated_at: '2026-09-14T11:00:00.000Z',
  deleted: 0,
};
await ga.applyGenericRemoteRow(localDb, 'credit_vouchers', pulledRow);

const localRow = (await localDb.select("SELECT * FROM credit_vouchers WHERE id = ?", [voucherId]));
check('[3a] pull landed the SQLite AUTHORITY row', localRow.length === 1, localRow.length);
if (localRow.length === 1) {
  const r = localRow[0];
  check('[3b] code mapped to the real column', r.code === 'H29-1001', r.code);
  check('[3c] snake payload -> camel columns (initial_amount)', Number(r.initial_amount) === 10000, r.initial_amount);
  check('[3d] remaining_amount mapped', Number(r.remaining_amount) === 4000, r.remaining_amount);
  check('[3e] status mapped', r.status === 'ACTIVE', r.status);
  check('[3f] customer_name mapped', r.customer_name === 'Client H29', r.customer_name);
  check('[3g] sync_status set to synced', r.sync_status === 'synced', r.sync_status);
  check('[3h] version guarded', Number(r.version) === 5, r.version);
}

// The Dexie stub is in-memory inside the shim module — read it back through
// the same module's db handle.
const dexieDb = (await import(pathToFileURL(DST('db', 'database.ts')).href)).db;
const dexieRow = await dexieDb.creditVouchers.get(voucherId);
check('[3i] pull landed the Dexie UI replica row', dexieRow !== undefined && dexieRow !== null, dexieRow);
if (dexieRow) {
  check('[3j] Dexie row is camelCase (initialAmount)', Number(dexieRow.initialAmount) === 10000, dexieRow.initialAmount);
  check('[3k] Dexie row is camelCase (remainingAmount)', Number(dexieRow.remainingAmount) === 4000, dexieRow.remainingAmount);
  check('[3l] Dexie row carries the code', dexieRow.code === 'H29-1001', dexieRow.code);
  check('[3m] Dexie row id is the keyPath', dexieRow.id === voucherId, dexieRow.id);
}

// [4] The clock must be at the pulled version, so the next LOCAL push emits
// version 6 — not 2 against a remote 5 (the original C6 hole).
const clock = (await localDb.select(
  "SELECT version FROM entity_keys WHERE entity_type = 'credit_voucher' AND entity_id = ?",
  [voucherId],
));
check('[4a] entity_keys clock advanced to the pulled version', Number(clock[0]?.version) === 5, clock[0]?.version);
const appliedNow = await ga.appliedGenericVersion(localDb, 'credit_vouchers', voucherId);
check('[4b] appliedGenericVersion reads the same watermark', appliedNow === 5, appliedNow);

// ---------------------------------------------------------------------------
// 7. [5] A negative remaining_amount must CLAMP, not throw (lane freeze = C6)
// ---------------------------------------------------------------------------
console.log('\n  --- [5] clamp on hostile remote row ---');
const negId = 'h29-vch-neg';
let clampThrew = false;
try {
  await ga.applyGenericRemoteRow(localDb, 'credit_vouchers', {
    id: negId,
    data_json: JSON.stringify({ code: 'H29-NEG', initial_amount: 5000, remaining_amount: -2500, status: 'ACTIVE' }),
    version: 2,
    updated_at: '2026-09-14T12:00:00.000Z',
    deleted: 0,
  });
} catch (e) {
  clampThrew = true;
  console.log(`  THREW: ${e && e.message ? e.message : String(e)}`);
}
check('[5a] hostile negative row did NOT throw (lane stays unfrozen)', !clampThrew);
const negRow = (await localDb.select("SELECT initial_amount, remaining_amount FROM credit_vouchers WHERE id = ?", [negId]));
check('[5b] negative remaining_amount clamped to 0', Number(negRow[0]?.remaining_amount) === 0, negRow[0]?.remaining_amount);
check('[5c] lane continued applying later rows (not frozen)', negRow.length === 1, negRow.length);

// ---------------------------------------------------------------------------
// 8. [6] Tombstone: deleted=1 must land SQLite + Dexie
// ---------------------------------------------------------------------------
console.log('\n  --- [6] tombstone lane ---');
await ga.applyGenericRemoteRow(localDb, 'credit_vouchers', {
  id: voucherId,
  data_json: JSON.stringify({ code: 'H29-1001' }),
  version: 6,
  updated_at: '2026-09-14T13:00:00.000Z',
  deleted: 1,
});
const tomb = (await localDb.select("SELECT deleted, status, version FROM credit_vouchers WHERE id = ?", [voucherId]));
check('[6a] SQLite tombstone sets deleted=1', Number(tomb[0]?.deleted) === 1, tomb[0]?.deleted);
check('[6b] SQLite tombstone marks status EXHAUSTED', tomb[0]?.status === 'EXHAUSTED', tomb[0]?.status);
check('[6c] tombstone advanced the version', Number(tomb[0]?.version) === 6, tomb[0]?.version);
const tombDexie = await dexieDb.creditVouchers.get(voucherId);
check('[6d] Dexie replica cleared by the tombstone', tombDexie === undefined || tombDexie === null, !!tombDexie);

// A stale echo (v4) after the tombstone (v6) must NOT resurrect anything.
await ga.applyGenericRemoteRow(localDb, 'credit_vouchers', {
  id: voucherId,
  data_json: JSON.stringify({ code: 'H29-1001', remaining_amount: 9000, status: 'ACTIVE' }),
  version: 4,
  updated_at: '2026-09-14T09:00:00.000Z',
  deleted: 0,
});
const afterStale = (await localDb.select("SELECT deleted, version FROM credit_vouchers WHERE id = ?", [voucherId]));
check('[6e] stale echo did not resurrect the tombstone', Number(afterStale[0]?.deleted) === 1, afterStale[0]?.deleted);
check('[6f] stale echo did not regress the version', Number(afterStale[0]?.version) === 6, afterStale[0]?.version);

// ---------------------------------------------------------------------------
// 9. [7] Replay idempotency
// ---------------------------------------------------------------------------
console.log('\n  --- [7] replay idempotency ---');
const replayId = 'h29-vch-replay';
const replayRow = {
  id: replayId,
  data_json: JSON.stringify({ code: 'H29-REPLAY', initial_amount: 2000, remaining_amount: 2000, status: 'ACTIVE' }),
  version: 8,
  updated_at: '2026-09-14T14:00:00.000Z',
  deleted: 0,
};
await ga.applyGenericRemoteRow(localDb, 'credit_vouchers', replayRow);
await ga.applyGenericRemoteRow(localDb, 'credit_vouchers', replayRow);
await ga.applyGenericRemoteRow(localDb, 'credit_vouchers', replayRow);
const replayCount = (await localDb.select("SELECT COUNT(*) AS c FROM credit_vouchers WHERE id = ?", [replayId]));
check('[7a] three replays -> one row', Number(replayCount[0]?.c) === 1, replayCount[0]?.c);
const replayClock = (await localDb.select(
  "SELECT version FROM entity_keys WHERE entity_type = 'credit_voucher' AND entity_id = ?",
  [replayId],
));
check('[7b] replay left the clock at the applied version', Number(replayClock[0]?.version) === 8, replayClock[0]?.version);

// ---------------------------------------------------------------------------
// 10. Cleanup
// ---------------------------------------------------------------------------
try { await local.close(); } catch { /* ignore */ }
try { await remote.close(); } catch { /* ignore */ }
rmSync(SHIM, { recursive: true, force: true });
for (const f of [LOCAL_DB, `${LOCAL_DB}-wal`, `${LOCAL_DB}-shm`, REMOTE_DB, `${REMOTE_DB}-wal`, `${REMOTE_DB}-shm`]) {
  for (let i = 0; i < 5; i++) { try { if (existsSync(f)) unlinkSync(f); break; } catch { /* retry */ } }
}

console.log(`\nH29: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
if (failures) process.exitCode = 1;


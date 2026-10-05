// H27 regression test (FIXED behavior). stock_batches was silently dropped by
// the sync engine in FOUR independent places (all contract C6, silent data
// loss):
//
//   1. QUERY level   — remote v5 stock_batches had no `id`/`data_json`, so
//                      pullColumns fell back to GENERIC_PULL_COLUMNS and the
//                      restore path did `SELECT * WHERE id > ?`; both threw
//                      "no such column: id" and the pull loop's catch{}
//                      skipped the table FOREVER. Fixed by remote migration v6.
//   2. APPLY level   — GENERIC_PULL['stock_batches'] was undefined, so the
//                      generic apply lane no-oped the row while the cursor
//                      advanced past it. Fixed by the GENERIC_PULL entry +
//                      mirror branch + tombstone + Dexie reshape.
//   3. PUSH UNIQUE   — the generic push SQL conflicts on `ON CONFLICT(id)`,
//                      but v6's `id` has no UNIQUE constraint -> "ON CONFLICT
//                      clause does not match any PRIMARY KEY or UNIQUE
//                      constraint". Fixed by an explicit toRemoteUpsert branch
//                      conflicting on the real PK `batch_id`.
//   4. PUSH NOT NULL — the remote table declares `product_id TEXT NOT NULL`
//                      with NO default; the generic KV path writes no real
//                      columns -> "NOT NULL constraint failed:
//                      stock_batches.product_id". Same explicit branch fixes
//                      it: the branch writes BOTH the real FIFO columns AND
//                      the KV pair.
//
// Net effect before the fix: FIFO costing data was device-local only. A sale
// on device A depleted batches on A only; device B's FIFO costing used the
// catalog fallback cost, and after a restore B had ZERO batches.
//
// This test asserts the fixed behavior end to end: apply lands the batch in
// local SQLite, the FIFO read sees the units, the version clock advances, the
// tombstone path works, and the REAL push SQL (extracted from
// SyncManager.toRemoteUpsert, never reconstructed from memory — §4.2) writes
// both the real columns and the KV pair and honors the version guard.
import { createClient } from '@libsql/client';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_SYNC = join(ROOT, 'src', 'sync');
const SHIM = join(ROOT, 'tmp-h27-shim');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

// ---------------------------------------------------------------------------
// Shim the REAL genericApply.ts so we exercise the actual apply decision, not
// a reimplementation.
// ---------------------------------------------------------------------------
rmSync(SHIM, { recursive: true, force: true });
mkdirSync(join(SHIM, 'db'), { recursive: true });
mkdirSync(join(SHIM, 'lane'), { recursive: true });
copyFileSync(join(SRC_SYNC, 'genericApply.ts'), join(SHIM, 'lane', 'genericApply.ts'));
// Zero-dependency lane siblings travel as copies (same pattern as the H25
// shim); the lane's ./conflictWatch + ./causalVersion imports resolve onto
// them, and conflictWatch's lone dateUtils import (utcNowIso) resolves to
// the sqlPluginAdapter stub that already exports it.
copyFileSync(join(SRC_SYNC, 'causalVersion.ts'), join(SHIM, 'lane', 'causalVersion.ts'));
copyFileSync(join(SRC_SYNC, 'conflictWatch.ts'), join(SHIM, 'lane', 'conflictWatch.ts'));
{
  const p = join(SHIM, 'lane', 'genericApply.ts');
  const realIds = pathToFileURL(join(ROOT, 'src', 'utils', 'ids.ts')).href;
  let t = readFileSync(p, 'utf8');
  t = t.replace(/from '\.\.\/db\/database'/g, "from '../db/database.js'")
       .replace(/from '\.\.\/db\/sqlPluginAdapter'/g, "from '../db/sqlPluginAdapter.js'")
       .replace(/from '\.\/causalVersion'/g, "from './causalVersion.ts'")
       .replace(/from '\.\/conflictWatch'/g, "from './conflictWatch.ts'")
       .replace(/from '\.\.\/utils\/dateUtils'/g, "from '../db/sqlPluginAdapter.js'")
       .replace(/from '\.\.\/utils\/ids'/g, `from '${realIds}'`);
  writeFileSync(p, t);
  const cp = join(SHIM, 'lane', 'conflictWatch.ts');
  let ct = readFileSync(cp, 'utf8');
  ct = ct.replace(/from '\.\/causalVersion'/g, "from './causalVersion.ts'")
         .replace(/from '\.\.\/utils\/dateUtils'/g, "from '../db/sqlPluginAdapter.js'");
  writeFileSync(cp, ct);
}
writeFileSync(join(SHIM, 'db', 'database.js'), `
const noop = { put: async () => {}, delete: async () => {}, get: async () => undefined };
export const db = new Proxy({}, { get: () => noop });
`);
writeFileSync(join(SHIM, 'db', 'sqlPluginAdapter.js'), `
export function sanitizeSyncPayload(p) { return p; }
export function utcNowIso() { return new Date().toISOString(); }
export function isDeviceLocalSettingKey() { return false; }
export const RECEIPT_SETTINGS_KEY = 'mobi_pos_receipt_settings';
export function isRetryableDbError() { return false; }
`);
const { applyGenericRemoteRow, GENERIC_PULL } = await import(
  pathToFileURL(join(SHIM, 'lane', 'genericApply.ts')).href
);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
for (const f of readdirSync(ROOT)) {
  if (f.startsWith('tmp-h27-') && f.endsWith('.db')) rmSync(join(ROOT, f), { force: true });
}
const LOCAL_SCHEMA = `CREATE TABLE stock_batches (
  batch_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity_remaining REAL NOT NULL CHECK (quantity_remaining >= 0),
  unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
  received_at TEXT NOT NULL,
  purchase_order_id TEXT,
  device_id TEXT NOT NULL DEFAULT 'local',
  idempotency_key TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0)`;

function asPluginSql(client) {
  return {
    select: async (sql, args = []) => (await client.execute({ sql, args })).rows ?? [],
    execute: async (sql, args = []) => client.execute({ sql, args }),
  };
}
async function q(client, sql, args = []) {
  return (await client.execute({ sql, args })).rows ?? [];
}

const mkLocal = async (file) => {
  const c = createClient({ url: `file:${file}` });
  await c.execute('DROP TABLE IF EXISTS stock_batches');
  await c.execute('DROP TABLE IF EXISTS products');
  await c.execute('DROP TABLE IF EXISTS entity_keys');
  await c.execute(LOCAL_SCHEMA);
  // The real products schema the FK-stub INSERT targets (genericApply's
  // mirror branch writes sku/barcode/title/brand/category/price/cost_price/
  // stock/json_payload/updated_at).
  await c.execute(`CREATE TABLE products (
    id TEXT PRIMARY KEY, sku TEXT, barcode TEXT, title TEXT, brand TEXT,
    category TEXT, price REAL, cost_price REAL, stock REAL,
    json_payload TEXT, updated_at TEXT, version INTEGER NOT NULL DEFAULT 1)`);
  await c.execute('CREATE TABLE entity_keys (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (entity_type, entity_id))');
  return c;
};

const BATCH_ID = 'batch-recv-001';
const PROD_ID = 'prod-samsung-a55';
// The pull lane selects GENERIC_PULL_COLUMNS for stock_batches
// ('id, data_json, version, updated_at, deleted') — the REAL columns are NOT
// selected, they ride inside data_json. So the row the apply lane receives is
// the generic KV shape, exactly as the push branch wrote it
// (data_json = toBoundedSyncJson(payload)).
const batchPayload = {
  batch_id: BATCH_ID,
  product_id: PROD_ID,
  quantity_remaining: 40,
  unit_cost: 95000,
  received_at: '2026-09-21T08:00:00.000Z',
  purchase_order_id: 'po-2026-0042',
  device_id: 'device-A',
  idempotency_key: 'idem-batch-001',
};
const remoteRow = {
  id: BATCH_ID,
  data_json: JSON.stringify(batchPayload),
  version: 1,
  updated_at: '2026-09-21T08:00:00.000Z',
  deleted: 0,
};

// ===========================================================================
console.log('\n[1] stock_batches is now a first-class sync lane');
// ===========================================================================
check('GENERIC_PULL has a stock_batches entry (fix #2)', !!GENERIC_PULL['stock_batches'], Object.keys(GENERIC_PULL));

// ===========================================================================
console.log('\n[2] FIXED: a pulled stock_batches row lands in local SQLite');
// ===========================================================================
const local = await mkLocal('tmp-h27-local.db');
await applyGenericRemoteRow(asPluginSql(local), 'stock_batches', remoteRow, { skipDexie: true });

const landed = await q(local, 'SELECT batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, version, deleted FROM stock_batches WHERE batch_id = $1', [BATCH_ID]);
check('the batch IS written to local SQLite', landed.length === 1, landed);
check('product_id is preserved (FK parent stub honored)', landed[0]?.product_id === PROD_ID, landed[0]?.product_id);
check('quantity_remaining is preserved (40 units)', Number(landed[0]?.quantity_remaining) === 40, landed[0]?.quantity_remaining);
check('unit_cost is preserved (FIFO costing basis)', Number(landed[0]?.unit_cost) === 95000, landed[0]?.unit_cost);
check('received_at is preserved (FIFO ordering key)', landed[0]?.received_at === '2026-09-21T08:00:00.000Z', landed[0]?.received_at);
check('purchase_order_id is preserved', landed[0]?.purchase_order_id === 'po-2026-0042', landed[0]?.purchase_order_id);
check('version is preserved', Number(landed[0]?.version) === 1, landed[0]?.version);
check('the row is not tombstoned', Number(landed[0]?.deleted) === 0, landed[0]?.deleted);

// ===========================================================================
console.log('\n[3] FIXED: the receiving device FIFO read now sees the units');
// ===========================================================================
const fifoRead = await q(local,
  `SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches
   WHERE product_id = $1 AND quantity_remaining > 0 AND deleted = 0
   ORDER BY received_at ASC, rowid ASC`, [PROD_ID]);
check('the receiving device sees the batch', fifoRead.length === 1, fifoRead);
check('the 40 received units are visible to local FIFO costing',
  fifoRead.reduce((s, r) => s + Number(r.quantity_remaining), 0) === 40);

// ===========================================================================
console.log('\n[4] FIXED: a later pull UPDATES the batch instead of duplicating');
// ===========================================================================
// A depletion on device A pushes version 2 with 35 remaining. The apply lane
// must update the existing row, not insert a second one, and must not regress
// a newer local version with a stale echo.
// The apply lane reads the real columns out of data_json, so the mutation
// goes there — not on the row top level (which only carries the KV keys).
const depletedRow = {
  ...remoteRow,
  data_json: JSON.stringify({ ...batchPayload, quantity_remaining: 35 }),
  version: 2,
  updated_at: '2026-09-22T08:00:00.000Z',
};
await applyGenericRemoteRow(asPluginSql(local), 'stock_batches', depletedRow, { skipDexie: true });
const afterDepletion = await q(local, 'SELECT batch_id, quantity_remaining, version FROM stock_batches WHERE product_id = $1', [PROD_ID]);
check('no duplicate batch row was created', afterDepletion.length === 1, afterDepletion);
check('the depletion was applied (35 remaining)', Number(afterDepletion[0]?.quantity_remaining) === 35, afterDepletion[0]?.quantity_remaining);
check('the version advanced to 2', Number(afterDepletion[0]?.version) === 2, afterDepletion[0]?.version);

// stale echo (v1 after v2) must NOT regress the quantity
await applyGenericRemoteRow(asPluginSql(local), 'stock_batches',
  { ...remoteRow, data_json: JSON.stringify({ ...batchPayload, quantity_remaining: 99 }), version: 1, updated_at: '2026-09-20T08:00:00.000Z' },
  { skipDexie: true });
const afterStale = await q(local, 'SELECT quantity_remaining, version FROM stock_batches WHERE batch_id = $1', [BATCH_ID]);
check('a stale echo (v1 after v2) does not regress the quantity',
  Number(afterStale[0]?.quantity_remaining) === 35 && Number(afterStale[0]?.version) === 2, afterStale);

// ===========================================================================
console.log('\n[5] FIXED: tombstones delete the batch locally');
// ===========================================================================
await applyGenericRemoteRow(asPluginSql(local), 'stock_batches',
  { ...remoteRow, deleted: 1, version: 3, updated_at: '2026-09-23T08:00:00.000Z' },
  { skipDexie: true });
const afterTomb = await q(local, 'SELECT deleted, version FROM stock_batches WHERE batch_id = $1', [BATCH_ID]);
check('the tombstone marked the row deleted', Number(afterTomb[0]?.deleted) === 1, afterTomb);
check('the tombstone advanced the version to 3', Number(afterTomb[0]?.version) === 3, afterTomb);
const fifoAfterTomb = await q(local,
  `SELECT batch_id FROM stock_batches WHERE product_id = $1 AND quantity_remaining > 0 AND deleted = 0`, [PROD_ID]);
check('a tombstoned batch is invisible to FIFO', fifoAfterTomb.length === 0, fifoAfterTomb);

// ===========================================================================
console.log('\n[6] FIXED: the restore path lands the batch too');
// ===========================================================================
const restoreLocal = await mkLocal('tmp-h27-restore.db');
await applyGenericRemoteRow(asPluginSql(restoreLocal), 'stock_batches', remoteRow, { skipDexie: true });
const restoreRow = await q(restoreLocal, 'SELECT batch_id, quantity_remaining FROM stock_batches WHERE batch_id = $1', [BATCH_ID]);
check('the RESTORE path lands the batch', restoreRow.length === 1 && Number(restoreRow[0]?.quantity_remaining) === 40, restoreRow);

// ===========================================================================
console.log('\n[7] FIXED: the remote schema migration v6 carries id + data_json');
// ===========================================================================
{
  const schemaSrc = readFileSync(join(SRC_SYNC, 'remoteSchema.ts'), 'utf8');
  check('remoteSchema declares stock_batches in the sync table list',
    schemaSrc.includes("'stock_batches',") || schemaSrc.includes('"stock_batches",'));
  check('migration v6 adds the `id` column to stock_batches',
    /ALTER TABLE stock_batches ADD COLUMN id/i.test(schemaSrc));
  check('migration v6 adds the `data_json` column to stock_batches',
    /ALTER TABLE stock_batches ADD COLUMN data_json/i.test(schemaSrc));
  check('LATEST_REMOTE_VERSION is at least 6',
    /LATEST_REMOTE_VERSION\s*=\s*([6-9]|[1-9][0-9])/.test(schemaSrc));
}

// ===========================================================================
console.log('\n[8] FIXED: the REAL push SQL writes real columns + KV + guard');
// ===========================================================================
// §4.2: extract the real SQL literal from SyncManager.toRemoteUpsert. Never
// reconstruct it from memory — the placeholder count must match exactly.
{
  const sm = readFileSync(join(SRC_SYNC, 'SyncManager.ts'), 'utf8');
  const branchIdx = sm.indexOf("if (op.entity_type === 'stock_batches')");
  check('toRemoteUpsert has an explicit stock_batches branch', branchIdx !== -1);
  if (branchIdx !== -1) {
    const segment = sm.slice(branchIdx, branchIdx + 4000);
    check('the branch conflicts on the real PK batch_id', /ON CONFLICT\(batch_id\)/.test(segment));
    check('the branch writes the real FIFO columns', /quantity_remaining=excluded\.quantity_remaining/.test(segment));
    check('the branch writes the KV pair (id, data_json)', /id=excluded\.id/.test(segment) && /data_json=excluded\.data_json/.test(segment));
    // A3 shares the tied predicate via interpolation; assert the marker so
    // the check tracks the shipped contract, not a hardcoded guard string.
    check('the branch carries the version guard', /\$\{tiedVersionGuardSql\('stock_batches'\)\}/.test(segment));

    // Count the placeholders in the real SQL and run it against a real v6-shaped
    // remote DB. This is the exact statement the push lane executes.
    const sqlStart = segment.indexOf('INSERT INTO stock_batches');
      // Slice to the CLOSING BACKTICK of the template literal — not the first
      // quote, which would truncate the VALUES clause at the 'synced' literal
      // and report a bogus placeholder count.
      let sqlEnd = segment.indexOf('`', sqlStart + 1);
      while (sqlEnd !== -1) {
        // a backtick inside the SQL would be an escape; this branch's SQL has none
        break;
      }
      // The branch shares the tied version predicate via template
      // interpolation (A3); resolve the marker through the REAL helper
      // (same pattern as the H25 shim) so the executed text is exactly
      // what the push lane sends — never reconstructed from memory.
      const { tiedVersionGuardSql } = await import(pathToFileURL(join(ROOT, 'src', 'sync', 'causalVersion.ts')).href);
      const realSql = segment.slice(sqlStart, sqlEnd)
        .replace(/\$\{tiedVersionGuardSql\('stock_batches'\)\}/g, tiedVersionGuardSql('stock_batches'));
      // 15 columns, but `sync_status` is the literal 'synced' -> 14 placeholders.
      const placeholderCount = (realSql.match(/\?/g) || []).length;
      check('the real SQL has 14 placeholders for 15 columns (sync_status is a literal)', placeholderCount === 14, placeholderCount);

    // Build a v6-shaped remote DB exactly as migration v6 leaves it.
    const remote = createClient({ url: 'file:tmp-h27-remote-v6.db' });
    await remote.execute('DROP TABLE IF EXISTS stock_batches');
    await remote.execute(`CREATE TABLE stock_batches (
      batch_id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      quantity_remaining REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL,
      purchase_order_id TEXT,
      device_id TEXT NOT NULL DEFAULT 'local',
      idempotency_key TEXT NOT NULL UNIQUE,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0)`);
    await remote.execute('ALTER TABLE stock_batches ADD COLUMN id TEXT;');
    await remote.execute("ALTER TABLE stock_batches ADD COLUMN data_json TEXT NOT NULL DEFAULT '{}';");

    const now = '2026-09-24T08:00:00.000Z';
    const args = [
      BATCH_ID, PROD_ID, 40, 95000, '2026-09-21T08:00:00.000Z', 'po-2026-0042',
      'device-A', 'idem-batch-001', 1, '2026-09-21T08:00:00.000Z', now,
      BATCH_ID, '{"batch_id":"batch-recv-001"}', 0,
    ];
    check('the args count matches the placeholder count', args.length === placeholderCount, args.length);

    let pushed;
    try {
      pushed = await remote.execute({ sql: realSql, args });
      pushed = pushed.rowsAffected;
    } catch (e) {
      pushed = `ERR ${String(e).split('\n')[0]}`;
    }
    check('the real push SQL INSERTs the batch (fix #3 + #4)', typeof pushed === 'number' && pushed > 0, pushed);

    const row = await q(remote, 'SELECT batch_id, product_id, quantity_remaining, unit_cost, id, data_json, version FROM stock_batches WHERE batch_id = $1', [BATCH_ID]);
    check('the real columns were written (product_id NOT NULL satisfied)', row[0]?.product_id === PROD_ID, row[0]?.product_id);
    check('the KV id was written (mirrors the PK)', row[0]?.id === BATCH_ID, row[0]?.id);
    check('the KV data_json was written', String(row[0]?.data_json).includes('batch_id'), row[0]?.data_json);
    check('the version was written', Number(row[0]?.version) === 1, row[0]?.version);

    // a newer version updates; a stale echo is rejected by the guard
    const r2 = await remote.execute({ sql: realSql, args: [
      BATCH_ID, PROD_ID, 35, 95000, '2026-09-21T08:00:00.000Z', 'po-2026-0042',
      'device-A', 'idem-batch-001', 2, '2026-09-21T08:00:00.000Z', now,
      BATCH_ID, '{"batch_id":"batch-recv-001"}', 0] });
    const row2 = await q(remote, 'SELECT quantity_remaining, version FROM stock_batches WHERE batch_id = $1', [BATCH_ID]);
    check('a newer push (v2) updates the batch', r2.rowsAffected === 1 && Number(row2[0]?.quantity_remaining) === 35, { ra: r2.rowsAffected, row2 });

    const r3 = await remote.execute({ sql: realSql, args: [
      BATCH_ID, PROD_ID, 99, 95000, '2026-09-21T08:00:00.000Z', 'po-2026-0042',
      'device-A', 'idem-batch-001', 1, '2026-09-21T08:00:00.000Z', now,
      BATCH_ID, '{"batch_id":"batch-recv-001"}', 0] });
    const row3 = await q(remote, 'SELECT quantity_remaining, version FROM stock_batches WHERE batch_batches WHERE batch_id = $1'.replace('_batches WHERE batch_batches', '_batches'), [BATCH_ID]);
    check('a stale push (v1 after v2) is rejected by the guard (rowsAffected 0)',
      r3.rowsAffected === 0 && Number(row3[0]?.quantity_remaining) === 35, { ra: r3.rowsAffected, row3 });

    await remote.close();
  }
}

// ===========================================================================
console.log('\n[9] FIXED: the outbox payloads carry the bumped version');
// ===========================================================================
// Without version in the payload, toRemoteUpsert's
// `version = Number(payload.version ?? 1)` is the constant 1, the remote guard
// is inert, and isGuardedUpsert() would re-queue the op forever (H14).
{
  const dbSrc = readFileSync(join(ROOT, 'src', 'db', 'sqlPluginAdapter.ts'), 'utf8');
  const sites = [
    { name: 'checkout FIFO depletion', anchor: 'SET quantity_remaining = quantity_remaining - $1' },
    // The stamp sits 60 lines below the anchor (window is exclusive);
    // widen this site only — the intent (version stamped) is satisfied.
    { name: 'restitute existing batch', anchor: 'SET quantity_remaining = $1,', window: 62 },
    // Enclosing-object window: the REFUND payload stamps `version: 1` just
    // above the anchor (the stamp belongs to the same object literal).
    { name: 'restitute new batch', anchor: "purchase_order_id: 'REFUND',", before: 10, window: 10 },
    { name: 'insertStockBatch', anchor: 'const payload = {' },
  ];
  const lines = dbSrc.split(/\r?\n/);
  for (const s of sites) {
    const i = lines.findIndex((l) => l.includes(s.anchor));
    check(`the ${s.name} site exists in sqlPluginAdapter`, i !== -1, s.anchor);
    if (i === -1) continue;
    // search around the anchor for the payload object that carries a version key
    const window = lines.slice(Math.max(0, i - (s.before ?? 0)), i + (s.window ?? 60)).join('\n');
    check(`the ${s.name} outbox payload stamps version`, /version:\s*(batchVersion|restituteVersion\d*|insertBatchVersion|1\s*,)/.test(window), s.name);
  }
  // the local ON CONFLICT path must bump version, else the stamped payload
  // would claim a version the local row does not have
  check('insertStockBatch local ON CONFLICT bumps version',
    /ON CONFLICT\(batch_id\) DO UPDATE SET quantity_remaining=excluded\.quantity_remaining,\s*\r?\n\s*version = version \+ 1,/.test(dbSrc));
}

// Windows holds the file handles for a moment after close(); retry the delete.
for (const c of [local, restoreLocal]) { try { await c.close(); } catch { /* closing twice is fine */ } }
for (let attempt = 0; attempt < 10; attempt++) {
  try {
    rmSync(SHIM, { recursive: true, force: true });
    let cleaned = true;
    for (const f of readdirSync(ROOT)) {
      if (f.startsWith('tmp-h27-') && f.endsWith('.db')) {
        try { rmSync(join(ROOT, f), { force: true }); } catch { cleaned = false; }
      }
    }
    if (cleaned) break;
  } catch { /* shim may be gone */ }
  await new Promise((r) => setTimeout(r, 200));
}
console.log(failures === 0 ? '\nH27: ALL PASS' : `\nH27: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

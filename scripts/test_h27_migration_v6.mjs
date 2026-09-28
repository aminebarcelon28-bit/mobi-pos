// H27 step 2: verify the v6 backfill actually runs against a REAL remote
// stock_batches table (migration v5 shape: PK batch_id, no id, no data_json)
// and produces rows the shared cursor query can read.
import { createClient } from '@libsql/client';
import { readFileSync, unlinkSync } from 'node:fs';

for (const f of ['tmp-h27m-local.db', 'tmp-h27m-remote.db']) {
  try { unlinkSync(f); } catch {}
}

const remote = createClient({ url: 'file:tmp-h27m-remote.db' });

// --- Build the remote DB exactly as migrations v1..v5 would have, then run v6.
const V5 = `CREATE TABLE IF NOT EXISTS stock_batches (
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
  deleted INTEGER NOT NULL DEFAULT 0
)`;
await remote.execute('DROP TABLE IF EXISTS stock_batches');
await remote.execute(V5);
await remote.execute(`INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
  purchase_order_id, device_id, idempotency_key, version, created_at, updated_at, deleted)
  VALUES ('batch-001','prod-a',40,95000,'2026-09-20T08:00:00.000Z','po-1','dev-A','k1',3,'2026-09-20T08:00:00.000Z','2026-09-21T09:00:00.000Z',0)`);
await remote.execute(`INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
  device_id, idempotency_key, version, created_at, updated_at, deleted)
  VALUES ('batch-002','prod-a',0,12000,'2026-09-19T08:00:00.000Z','dev-A','k2',1,'2026-09-19T08:00:00.000Z','2026-09-19T09:00:00.000Z',1)`);

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
};

// --- Run the v6 statements exactly as remoteSchema.ts declares them.
// Extract the statements array the way TypeScript sees it: strip // comments,
// then read single-quoted, double-quoted and template-literal strings.
const src = readFileSync('src/sync/remoteSchema.ts', 'utf8');
// Only the `statements: [ ... ]` payload — the `description` string is not SQL.
const m = src.match(/version: 6,[\s\S]*?\n    statements: \[([\s\S]*?)\n    \],/);
if (!m) { console.error('FAIL: could not extract v6 block'); process.exit(1); }
const block = m[1]
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');
const stmts = [];
for (const sm of block.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([\s\S]*?)`/g)) {
  stmts.push(sm[1] ?? sm[2] ?? sm[3]);
}
console.log(`v6 statements extracted: ${stmts.length}`);
for (const s of stmts) {
  try { await remote.execute(s); console.log(`  OK   ${JSON.stringify(s.split('\n')[0].slice(0, 70))}`); }
  catch (e) { failures++; console.log(`  FAIL ${JSON.stringify(s.split('\n')[0].slice(0, 70))} -> ${e.message}`); }
}

// --- The shared cursor query must now work.
const PULL = `SELECT id, data_json, version, updated_at, deleted FROM stock_batches
  WHERE (updated_at > ?) OR (updated_at = ? AND id > ?) ORDER BY updated_at ASC, id ASC LIMIT 500`;
const RESTORE = `SELECT * FROM stock_batches WHERE id > ? ORDER BY id ASC LIMIT 500`;
let rows;
try {
  rows = (await remote.execute({ sql: PULL, args: ['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', ''] })).rows;
  check('the shared PULL cursor query now reads stock_batches', rows.length === 2, rows.length);
} catch (e) {
  check('the shared PULL cursor query now reads stock_batches', false, e.message);
}
try {
  const rr = (await remote.execute({ sql: RESTORE, args: [''] })).rows;
  check('the RESTORE query (WHERE id > ?) now reads stock_batches', rr.length === 2, rr.length);
} catch (e) {
  check('the RESTORE query (WHERE id > ?) now reads stock_batches', false, e.message);
}

// --- id mirrors the PK; data_json carries the full column set. Look rows up
// --- by id: the cursor orders on updated_at ASC, so the OLDER batch comes
// --- first (batch-002 @ 2026-09-19 before batch-001 @ 2026-09-21).
const byId = new Map((rows ?? []).map((r) => [String(r.id), r]));
const r1 = byId.get('batch-001');
check('id mirrors batch_id', r1?.id === 'batch-001', r1?.id);
let dj1;
try { dj1 = JSON.parse(String(r1?.data_json)); } catch (e) { dj1 = { _err: String(e) }; }
check('data_json parses', !dj1._err, dj1);
check('data_json.batch_id === batch-001', dj1.batch_id === 'batch-001', dj1.batch_id);
check('data_json.quantity_remaining === 40', Number(dj1.quantity_remaining) === 40, dj1.quantity_remaining);
check('data_json.unit_cost === 95000', Number(dj1.unit_cost) === 95000, dj1.unit_cost);
check('data_json.version === 3', Number(dj1.version) === 3, dj1.version);
check('data_json.purchase_order_id === po-1', dj1.purchase_order_id === 'po-1', dj1.purchase_order_id);
// The tombstoned batch keeps its own id/data_json too (a tombstone must still
// be cursor-readable or the delete never converges).
const r2 = byId.get('batch-002');
check('tombstoned batch is also cursor-readable', r2?.id === 'batch-002', r2?.id);
let dj2;
try { dj2 = JSON.parse(String(r2?.data_json)); } catch (e) { dj2 = { _err: String(e) }; }
check('tombstoned batch data_json parses', !dj2._err, dj2);
check('tombstoned batch carries deleted=1', Number(dj2.deleted) === 1, dj2.deleted);

// --- Idempotency: re-running the backfill must touch nothing (WHERE id IS
// --- NULL). The ALTERs legitimately fail with "duplicate column" on a re-run;
// applyRemoteMigrations already swallows exactly that error class.
await remote.execute(stmts[2]);
const again = (await remote.execute({ sql: PULL, args: ['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', ''] })).rows;
check('v6 backfill is idempotent (re-run changes nothing)', again.length === 2, again.length);

// --- A row pushed AFTER v6 (by the fixed toRemoteUpsert) must also carry
// id + data_json so the cursor keeps advancing.
await remote.execute(`INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at,
  device_id, idempotency_key, version, created_at, updated_at, deleted, id, data_json)
  VALUES ('batch-003','prod-b',10,5000,'2026-09-22T08:00:00.000Z','dev-B','k3',1,'2026-09-22T08:00:00.000Z','2026-09-22T08:00:00.000Z',0,'batch-003','{"batch_id":"batch-003"}')`);
const r3 = (await remote.execute({ sql: PULL, args: ['2026-09-21T09:00:00.000Z', '2026-09-21T09:00:00.000Z', 'batch-001'] })).rows;
check('a post-v6 pushed row is picked up by the cursor', r3.length === 1 && r3[0].id === 'batch-003', r3);

await remote.close();
try { unlinkSync('tmp-h27m-remote.db'); } catch {}
console.log(failures === 0 ? '\nH27 STEP2: ALL PASS' : `\nH27 STEP2: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

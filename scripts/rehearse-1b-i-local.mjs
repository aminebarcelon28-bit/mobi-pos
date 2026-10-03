/**
 * §3 rehearsal — 1b-i LOCAL leg on a COPY of the live device DB.
 *
 * READ-ONLY on live data: snapshots via VACUUM INTO (consistent read),
 * all destructive steps run on temp copies. Covers: pre-counts, Path A
 * (native DROP COLUMN), rollback A (ADD COLUMN), Path B (create-copy-drop
 * fallback with index/view rebuild per C4), rollback B, reconciliation.
 *
 * Exit 0 = every check green. Exit 1 = any mismatch (STOP, investigate).
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const appData = process.env.APPDATA;
const LIVE = process.env.MOBI_POS_DB
  || (appData ? join(appData, 'com.mobi.pos', 'mobi_pos.db') : null);
if (!LIVE || !existsSync(LIVE)) {
  console.log('LIVE DB NOT FOUND — nothing rehearsed (run on the device).');
  process.exit(2);
}
console.log(`live db: ${LIVE} (untouched; snapshot via VACUUM INTO)`);

const { DatabaseSync } = await import('node:sqlite');
const work = join(tmpdir(), `rehearse-1b-i-${Date.now()}`);
mkdirSync(work, { recursive: true });
const snap = join(work, 'live-snapshot.db');
{
  const live = new DatabaseSync(LIVE, { readOnly: true });
  console.log(`sqlite version: ${live.prepare(`SELECT sqlite_version() AS v`).get()?.v}`);
  live.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  live.close();
}
console.log(`snapshot: ${snap}`);

const openCopy = (name) => {
  const p = join(work, `${name}.db`);
  copyFileSync(snap, p);
  return { db: new DatabaseSync(p), path: p };
};
const cols = (db) => db.prepare(`PRAGMA table_info(transactions)`).all().map((c) => c.name);
const userObjects = (db) => ({
  indexes: db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE tbl_name='transactions' AND type='index' AND sql IS NOT NULL ORDER BY name`
  ).all(),
  views: db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='view' ORDER BY name`).all(),
});
const fingerprint = (db) => ({
  rows: db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()?.n,
  totalSum: db.prepare(`SELECT COALESCE(SUM(total),0) AS s FROM transactions`).get()?.s,
  ordersRows: db.prepare(`SELECT COUNT(*) AS n FROM orders`).get()?.n,
});

console.log('\n--- pre-counts (snapshot) ---');
{
  const { db } = openCopy('pre');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()?.n ?? 0;
  const nonzero = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE CAST(tax AS REAL) != 0`).get()?.n ?? 0;
  const taxSum = db.prepare(`SELECT COALESCE(SUM(CAST(tax AS REAL)),0) AS s FROM transactions`).get()?.s ?? 0;
  check('snapshot readable', total > 0, `total=${total}`);
  check('tax != 0 count is 0', nonzero === 0, `nonzero=${nonzero}`);
  check('tax SUM is 0', taxSum === 0, `sum=${taxSum}`);
  check('tax column present pre-drop', cols(db).includes('tax'));
  const objs = userObjects(db);
  console.log(`    indexes on transactions: ${objs.indexes.map((i) => i.name).join(', ') || '(none)'}`);
  console.log(`    views: ${objs.views.map((v) => v.name).join(', ') || '(none)'}`);
  db.close();
}

console.log('\n--- Path A: native DROP COLUMN + rollback ---');
{
  const { db } = openCopy('pathA');
  const before = fingerprint(db);
  const idxBefore = userObjects(db).indexes.map((i) => i.name);
  db.exec(`ALTER TABLE transactions DROP COLUMN tax;`);
  check('tax column gone', !cols(db).includes('tax'));
  const idxAfter = db.prepare(
    `SELECT name FROM sqlite_master WHERE tbl_name='transactions' AND type='index' AND sql IS NOT NULL ORDER BY name`
  ).all().map((i) => i.name);
  check('indexes survive DROP COLUMN', JSON.stringify(idxAfter) === JSON.stringify(idxBefore),
    `before=[${idxBefore}] after=[${idxAfter}]`);
  const after = fingerprint(db);
  check('row count unchanged', after.rows === before.rows, `${before.rows} vs ${after.rows}`);
  check('SUM(total) unchanged', after.totalSum === before.totalSum, `${before.totalSum} vs ${after.totalSum}`);
  check('orders view still queries', after.ordersRows === before.rows, `${after.ordersRows}`);
  // Rollback rehearsal: ADD COLUMN restores the (proven-zero) column.
  db.exec(`ALTER TABLE transactions ADD COLUMN tax REAL DEFAULT 0;`);
  check('rollback restores tax column', cols(db).includes('tax'));
  const rb = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE CAST(tax AS REAL) != 0`).get()?.n;
  check('rollback values all default 0', rb === 0, `nonzero=${rb}`);
  check('rollback row count intact', db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()?.n === before.rows);
  db.close();
}

console.log('\n--- Path B: create-copy-drop fallback + rebuild + rollback ---');
{
  const { db } = openCopy('pathB');
  const before = fingerprint(db);
  const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE name='transactions'`).get()?.sql;
  check('source DDL captured', typeof ddl === 'string' && ddl.includes('tax REAL DEFAULT 0'));
  const stripped = ddl.replace(/,\s*tax REAL DEFAULT 0,/, ',');
  check('stripped DDL has no tax column', !/tax REAL/.test(stripped), stripped.slice(0, 120));
  const savedIdx = userObjects(db).indexes;
  const savedViews = userObjects(db).views;
  // ORDERING LAW (rehearsal-caught): with FK enforcement ON, RENAME aborts
  // with "error in view orders: no such table" if a dependent view dangles
  // mid-swap. Drop dependent views FIRST so no view ever names a missing
  // table, then rebuild after the rename.
  let migrated = false;
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const v of savedViews) db.exec(`DROP VIEW IF EXISTS ${v.name};`);
    db.exec(stripped.replace('CREATE TABLE transactions', 'CREATE TABLE transactions_new'));
    const newCols = db.prepare(`PRAGMA table_info(transactions_new)`).all().map((c) => c.name);
    const oldCols = cols(db).filter((c) => c !== 'tax');
    check('new table matches old-minus-tax', JSON.stringify(newCols) === JSON.stringify(oldCols),
      `new=[${newCols}] old-minus-tax=[${oldCols}]`);
    db.exec(`INSERT INTO transactions_new (${oldCols.join(', ')}) SELECT ${oldCols.join(', ')} FROM transactions;`);
    db.exec(`DROP TABLE transactions;`);
    db.exec(`ALTER TABLE transactions_new RENAME TO transactions;`);
    for (const ix of savedIdx) db.exec(ix.sql);
    for (const v of savedViews) db.exec(v.sql);
    db.exec('COMMIT;');
    migrated = true;
    check('fallback migration commits', true);
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
    check('fallback migration commits', false, String(e?.message ?? e));
  }
  if (!migrated) {
    check('SKIP post-checks (rolled back)', false, 'migration failed — post-checks meaningless');
    db.close();
    console.log('\n========================================================================');
    console.log(`REHEARSAL: ${pass} PASSED, ${fail} FAILED (workdir retained: ${work})`);
    console.log('========================================================================');
    process.exit(1);
  }
  check('tax column gone (fallback)', !cols(db).includes('tax'));
  const idxAfter = db.prepare(
    `SELECT name FROM sqlite_master WHERE tbl_name='transactions' AND type='index' AND sql IS NOT NULL ORDER BY name`
  ).all().map((i) => i.name);
  check('all indexes rebuilt', JSON.stringify(idxAfter) === JSON.stringify(savedIdx.map((i) => i.name)),
    `[${idxAfter}]`);
  const after = fingerprint(db);
  check('row count unchanged (fallback)', after.rows === before.rows, `${before.rows} vs ${after.rows}`);
  check('SUM(total) unchanged (fallback)', after.totalSum === before.totalSum);
  check('orders view queries (fallback)', after.ordersRows === before.rows);
  db.exec(`ALTER TABLE transactions ADD COLUMN tax REAL DEFAULT 0;`);
  check('rollback restores tax column (fallback)', cols(db).includes('tax'));
  db.close();
}

console.log('\n========================================================================');
console.log(`REHEARSAL: ${pass} PASSED, ${fail} FAILED (workdir retained: ${work})`);
console.log('========================================================================');
console.log('RECONCILIATION: live data untouched; all mutations ran on temp copies.');
if (fail > 0) process.exit(1);

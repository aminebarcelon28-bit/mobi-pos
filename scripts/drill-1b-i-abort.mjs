/**
 * PF-2 abort-injection drill — 1b-i fallback migration (copy only).
 *
 * READ-ONLY on live data (VACUUM INTO snapshot; every drill runs on a temp
 * copy). Forces a failure at EACH step boundary of the fixed-order fallback
 * (views-first ordering law) plus the Path A single-statement abort, then
 * asserts: the DB reopens cleanly (fresh connection + integrity_check),
 * the schema is entirely OLD (tax present, no residue), counts/sums match
 * pre-state. A mid-COMMIT kill cannot be injected at SQL level — SQLite
 * transaction atomicity covers it (PF-1); the drill covers every
 * statement boundary deliberately, including the mid-RENAME case that the
 * rehearsal found by accident.
 *
 * Exit 0 = all injections recover to pre-state. Exit 1 = any deviation.
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
  console.log('LIVE DB NOT FOUND — nothing drilled (run on the device).');
  process.exit(2);
}

const { DatabaseSync } = await import('node:sqlite');
const work = join(tmpdir(), `drill-1b-i-${Date.now()}`);
mkdirSync(work, { recursive: true });
const snap = join(work, 'live-snapshot.db');
{
  const live = new DatabaseSync(LIVE, { readOnly: true });
  live.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  live.close();
}

// Pre-state fingerprint (from a pristine copy).
const prestate = (() => {
  const p = join(work, 'prestate.db');
  copyFileSync(snap, p);
  const db = new DatabaseSync(p);
  const fp = {
    rows: db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()?.n,
    sum: db.prepare(`SELECT COALESCE(SUM(total),0) AS s FROM transactions`).get()?.s,
    cols: db.prepare(`PRAGMA table_info(transactions)`).all().map((c) => c.name),
    idx: db.prepare(
      `SELECT name FROM sqlite_master WHERE tbl_name='transactions' AND type='index' AND sql IS NOT NULL ORDER BY name`
    ).all().map((i) => i.name),
    views: db.prepare(`SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`).all().map((v) => v.name),
    integrity: db.prepare(`PRAGMA integrity_check`).get(),
  };
  db.close();
  return fp;
})();
check('pre-state captured (603-row shape)', prestate.rows > 0 && prestate.cols.includes('tax'),
  `rows=${prestate.rows}`);

const ddlOf = (db) => db.prepare(`SELECT sql FROM sqlite_master WHERE name='transactions'`).get()?.sql;

// Fixed-order fallback steps (rehearsal §C4 ordering law). Each entry is a
// label + thunk receiving { db, ctx } where ctx carries saved DDL/index/views.
function fallbackSteps() {
  return [
    ['begin', ({ db }) => db.exec('BEGIN IMMEDIATE;')],
    ['drop-views', ({ db, ctx }) => { for (const v of ctx.views) db.exec(`DROP VIEW IF EXISTS ${v.name};`); }],
    ['create-new', ({ db, ctx }) => db.exec(ctx.stripped.replace('CREATE TABLE transactions', 'CREATE TABLE transactions_new'))],
    ['insert', ({ db, ctx }) => db.exec(
      `INSERT INTO transactions_new (${ctx.oldCols.join(', ')}) SELECT ${ctx.oldCols.join(', ')} FROM transactions;`)],
    ['drop-old', ({ db }) => db.exec('DROP TABLE transactions;')],
    ['rename', ({ db }) => db.exec('ALTER TABLE transactions_new RENAME TO transactions;')],
    ['rebuild-indexes', ({ db, ctx }) => { for (const ix of ctx.idx) db.exec(ix.sql); }],
    ['recreate-views', ({ db, ctx }) => { for (const v of ctx.views) db.exec(v.sql); }],
    ['commit', ({ db }) => db.exec('COMMIT;')],
  ];
}

function buildCtx(db) {
  const ddl = ddlOf(db);
  return {
    stripped: ddl.replace(/,\s*tax REAL DEFAULT 0,/, ','),
    oldCols: db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name).filter((c) => c !== 'tax'),
    idx: db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE tbl_name='transactions' AND type='index' AND sql IS NOT NULL ORDER BY name`
    ).all(),
    views: db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='view' ORDER BY name`).all(),
  };
}

function assertPrestate(path, label) {
  // Fresh connection = "reopens cleanly" proof (no lock/poison carried).
  const db = new DatabaseSync(path);
  let ok = true;
  try {
    const ic = db.prepare(`PRAGMA integrity_check`).get();
    const integrityOk = ic && Object.values(ic)[0] === 'ok';
    check(`${label}: reopens + integrity_check ok`, integrityOk === true);
    ok = ok && integrityOk === true;
    const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
    const sameCols = JSON.stringify(cols) === JSON.stringify(prestate.cols);
    check(`${label}: schema entirely OLD (tax present, no residue)`, sameCols && !cols.includes('transactions_new'),
      `cols=[${cols.slice(0, 4)}...]`);
    ok = ok && sameCols;
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()?.n;
    const sum = db.prepare(`SELECT COALESCE(SUM(total),0) AS s FROM transactions`).get()?.s;
    check(`${label}: counts/sums match pre-state`, rows === prestate.rows && sum === prestate.sum,
      `rows=${rows}/${prestate.rows} sum=${sum}/${prestate.sum}`);
    ok = ok && rows === prestate.rows && sum === prestate.sum;
    const views = db.prepare(`SELECT COUNT(*) AS n FROM orders`).get()?.n;
    check(`${label}: orders view queries`, views === prestate.rows, `${views}`);
    ok = ok && views === prestate.rows;
  } finally {
    db.close();
  }
  return ok;
}

const ABORT = `SELECT * FROM __abort_now__;`;
const steps = fallbackSteps();
console.log(`\n--- fallback: inject abort after each of ${steps.length} steps ---`);
steps.forEach(([name], k) => {
  const p = join(work, `abort-after-${k}-${name}.db`);
  copyFileSync(snap, p);
  const db = new DatabaseSync(p);
  const ctx = buildCtx(db);
  try {
    for (let i = 0; i <= k; i++) steps[i][1]({ db, ctx });
    if (name !== 'commit') {
      try {
        db.exec(ABORT);
        check(`abort-after-${name}: injection fired`, false, 'abort statement unexpectedly succeeded');
      } catch {
        try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
      }
    }
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
    check(`abort-after-${name}: txn rolled back (not committed half)`, true);
  } finally {
    db.close();
  }
  if (name === 'commit') {
    // No abort possible post-COMMIT at SQL level (kill -9 territory, PF-1
    // covers via txn atomicity) — assert the committed state is entirely NEW.
    const db2 = new DatabaseSync(p);
    try {
      const cols = db2.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
      check('post-commit: schema entirely NEW (tax gone)', !cols.includes('tax'));
      const rows = db2.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()?.n;
      check('post-commit: rows intact', rows === prestate.rows, `${rows}`);
    } finally {
      db2.close();
    }
  } else {
    assertPrestate(p, `abort-after-${name}`);
  }
});

console.log('\n--- Path A: single-statement abort ---');
{
  const p = join(work, 'abort-pathA.db');
  copyFileSync(snap, p);
  const db = new DatabaseSync(p);
  db.exec('BEGIN IMMEDIATE;');
  db.exec('ALTER TABLE transactions DROP COLUMN tax;');
  try {
    db.exec(ABORT);
  } catch {
    try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
  } finally {
    db.close();
  }
  assertPrestate(p, 'abort-pathA-drop');
}

console.log('\n========================================================================');
console.log(`ABORT DRILL: ${pass} PASSED, ${fail} FAILED (workdir retained: ${work})`);
console.log('========================================================================');
if (fail > 0) process.exit(1);

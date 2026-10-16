// One-time repair: restore the recorded sqlx checksum of migration v1 on DBs
// first migrated between 2026-10-02 and 2026-10-16 (commit 03e46b7 added a
// duplicate, no-op `CREATE TABLE IF NOT EXISTS app_settings (...)` line inside
// the v1 body; the body was reverted on 2026-10-16).
//
// Why this is safe and does NOT need a DB reset:
//   - The added line ran AFTER the original app_settings CREATE, so
//     `IF NOT EXISTS` made it a no-op — schema and data are IDENTICAL to a
//     canonical v1 migration. Only the checksum recorded in
//     `_sqlx_migrations` differs.
//   - The plugin migrator runs each migration transactionally: no partial
//     states exist.
//   - Canonical checksum oracle: DBs migrated before 2026-10-02 (and the
//     pre-incident 2026-10-01 backup) record
//     5693a5e9020d6b2da139d41587adec2893308833c590088c4f01def14131c83f3ce87813b6b4393400da93dd5b879b39
//     — reproduced from the current lib.rs v1 bytes with `node
//     scripts/test_migration_v1_pinned.mjs`.
//
// Usage:
//   node scripts/repair_migration_v1_checksum.mjs                 # inspect (read-only)
//   node scripts/repair_migration_v1_checksum.mjs --apply        # repair (backup first)
//   node scripts/repair_migration_v1_checksum.mjs --db <path>    # non-default DB
//
// Fail-closed: --apply only proceeds when the recorded checksum is EXACTLY the
// known-modified hash. Unknown hashes are refused for manual review.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const CANONICAL_V1 = '5693a5e9020d6b2da139d41587adec2893308833c590088c4f01def14131c83f3ce87813b6b4393400da93dd5b879b39';
const KNOWN_MODIFIED_V1 = '2c74ba5c5a59893695801bb3d38c4d73a34137476ccfa17745a5adf16de424cb4fcab129aaa7450cabf4ec68c9aa34c8';

function defaultDbPath() {
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'com.mobi.pos', 'mobi_pos.db');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'com.mobi.pos', 'mobi_pos.db');
  }
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'com.mobi.pos', 'mobi_pos.db');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: node scripts/repair_migration_v1_checksum.mjs [--db <path>] [--apply]');
  process.exit(0);
}
const apply = args.includes('--apply');
const dbArgIdx = args.indexOf('--db');
const dbPath = dbArgIdx !== -1 ? args[dbArgIdx + 1] : defaultDbPath();
if (!dbPath || !existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(2);
}
console.log(`DB      : ${dbPath}`);
console.log(`mode    : ${apply ? 'APPLY (writes + backup)' : 'inspect (read-only)'}\n`);

function readV1Checksum(db) {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE name='_sqlx_migrations'").get();
  if (!has) return { kind: 'no-table' };
  const row = db.prepare('SELECT lower(hex(checksum)) AS chk FROM _sqlx_migrations WHERE version = 1').get();
  if (!row) return { kind: 'no-row' };
  return { kind: 'row', chk: row.chk };
}

const ro = new DatabaseSync(dbPath, { readOnly: true });
const state = readV1Checksum(ro);
ro.close();

const describe = (s) =>
  s.kind === 'no-table' ? 'no _sqlx_migrations table (fresh DB / not yet migrated)'
  : s.kind === 'no-row' ? 'no v1 row recorded'
  : s.chk;

if (state.kind !== 'row') {
  console.log(`v1 checksum state: ${describe(state)} — nothing to repair.`);
  process.exit(state.kind === 'no-table' ? 0 : 2);
}

if (state.chk === CANONICAL_V1) {
  console.log('v1 checksum: CANONICAL — this DB is healthy, nothing to do.');
  process.exit(0);
}
if (state.chk !== KNOWN_MODIFIED_V1) {
  console.error(`v1 checksum: UNKNOWN (${state.chk})`);
  console.error('Refusing: not the known 2026-10-02..2026-10-16 modified hash. Inspect history before touching.');
  process.exit(2);
}

console.log('v1 checksum: MODIFIED (2026-10-02..2026-10-16 window) — needs the one-time repair.');
if (!apply) {
  console.log('\nRe-run with --apply to restore the canonical checksum (a backup is written first).');
  process.exit(0);
}

// ---------------- apply ----------------
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000;');
const stamp = new Date().toISOString().replace(/[:.]/g, '');
const backupPath = join(join(dbPath, '..'), `${basename(dbPath)}.pre-v1-checksum-repair-${stamp}.db`);
if (existsSync(backupPath)) {
  console.error(`Backup target already exists: ${backupPath}`);
  process.exit(2);
}
try {
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`);
  console.log(`\nBackup written: ${backupPath}`);
} catch (e) {
  console.error(`Backup failed (${e.message}) — nothing was written. Close the app and retry.`);
  process.exit(2);
}

try {
  db.exec('BEGIN IMMEDIATE;');
  const res = db
    .prepare(
      `UPDATE _sqlx_migrations SET checksum = X'${CANONICAL_V1}'
       WHERE version = 1 AND lower(hex(checksum)) = ?`,
    )
    .run(KNOWN_MODIFIED_V1);
  if (Number(res.changes) !== 1) {
    throw new Error(`expected to update 1 row, updated ${res.changes}`);
  }
  db.exec('COMMIT;');
} catch (e) {
  try { db.exec('ROLLBACK;'); } catch { /* already rolled back */ }
  console.error(`Repair FAILED and was rolled back: ${e.message}`);
  db.close();
  process.exit(2);
}

const after = readV1Checksum(db);
db.close();
if (after.kind === 'row' && after.chk === CANONICAL_V1) {
  console.log('v1 checksum restored to canonical. The app can boot this DB again.');
  console.log('You may move the backup file out of the app data directory when satisfied.');
  process.exit(0);
}
console.error(`Post-check failed: checksum is now ${describe(after)}`);
process.exit(2);

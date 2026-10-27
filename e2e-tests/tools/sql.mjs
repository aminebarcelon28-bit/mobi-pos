/**
 * Read-only SQL runner against the sandbox live DB (for discovery/inspection).
 * Usage: node e2e-tests/tools/sql.mjs "SELECT ..."
 *        node e2e-tests/tools/sql.mjs --tables
 */
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const DB =
  process.env.POS_DB ??
  path.join(
    process.env.TEMP ?? os.tmpdir(),
    'opencode',
    'pos-wdio-sandbox',
    'home',
    'AppData',
    'Roaming',
    'com.mobi.pos.e2e',
    'mobi_pos.db',
  );
const arg = process.argv.slice(2).join(' ').trim();
const db = new Database(DB, { readonly: true, fileMustExist: true });

if (!arg || arg === '--tables') {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all();
  console.log(rows.map((r) => r.name).join('\n'));
  process.exit(0);
}

try {
  const stmt = db.prepare(arg);
  const rows = stmt.all();
  console.log(JSON.stringify(rows, null, 1));
} catch (e) {
  try {
    const info = db.prepare(arg).run();
    console.log(JSON.stringify(info));
  } catch (e2) {
    console.error('SQL error:', e2.message);
    process.exit(1);
  }
}

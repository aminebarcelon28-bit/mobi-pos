import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const p = path.join(
  process.env.TEMP || os.tmpdir(),
  'opencode',
  'pos-wdio-sandbox',
  'home',
  'AppData',
  'Roaming',
  'com.mobi.pos.e2e',
  'mobi_pos.db',
);
const db = new Database(p, { readonly: true });
const q = (s, ...a) => {
  try {
    return db.prepare(s).all(...a);
  } catch (e) {
    return [{ err: String(e.message) }];
  }
};
console.log('db', p);
console.log('tx', JSON.stringify(q('SELECT COUNT(*) n, MAX(created_at) mx, MIN(created_at) mn FROM transactions')));
console.log('sessions', JSON.stringify(q('SELECT COUNT(*) n FROM cash_sessions')));
console.log(
  'trustish',
  JSON.stringify(
    q(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%integrity%' OR name LIKE '%trust%' OR name LIKE '%latch%' OR name LIKE '%license%' OR name LIKE '%anchor%')",
    ),
  ),
);
console.log(
  'futureTx',
  JSON.stringify(
    q("SELECT id, created_at FROM transactions WHERE created_at > datetime('now','utc') ORDER BY created_at DESC LIMIT 5"),
  ),
);
console.log('app_settings', JSON.stringify(q('SELECT key, substr(value_json,1,160) v FROM app_settings')));
console.log('auditTail', JSON.stringify(q('SELECT timestamp, action FROM security_audit_logs ORDER BY timestamp DESC LIMIT 5')));
db.close();

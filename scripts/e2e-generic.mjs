// Generic-lane round-trip: repair order + setting + tombstone delete.
// Mirrors SyncManager generic push SQL exactly (fixed 7-col shape).
// Usage: node scripts/e2e-generic.mjs (proxy must run). Cleans up after itself.
import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@libsql/client';

function loadEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}
const fileEnv = loadEnvFile('proxy/.env');
const now = () => new Date().toISOString();
const stamp = `gen-${Date.now()}`;
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const tokRes = await fetch(`http://localhost:${fileEnv.PORT ?? '8787'}/api/sync-token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ deviceId: 'e2e-generic' }),
});
check('broker token', tokRes.ok);
const { url, token } = await tokRes.json();
const remote = createClient({ url, authToken: token });

const upsert = (table, id, key, data, updated, deleted = 0) => remote.execute({
  sql: `INSERT INTO ${table} (id, data_json, device_id, idempotency_key, sync_status, updated_at, deleted)
    VALUES (?,?,?,?,'synced',?,?)
    ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,
    updated_at=excluded.updated_at, sync_status='synced', deleted=excluded.deleted
    WHERE excluded.updated_at > ${table}.updated_at`,
  args: [id, JSON.stringify(data), 'e2e-generic', key, updated, deleted],
});

// 1. repair order upsert
const roId = `REP-${stamp}`;
await upsert('repair_orders', roId, `idem-${stamp}-ro`, { id: roId, ticketNumber: 'T-1', customerName: 'Test', totalCost: 1500 }, now());
const ro = await remote.execute({ sql: 'SELECT data_json FROM repair_orders WHERE id=?', args: [roId] });
check('repair order round-trip', ro.rows.length === 1 && JSON.parse(ro.rows[0].data_json).totalCost === 1500);

// 2. setting upsert (non-sync.* key)
await upsert('app_settings', 'receipt_header', `idem-${stamp}-set`, { key: 'receipt_header', value: 'ACCESSOIRES MOBI' }, now());
const st = await remote.execute({ sql: 'SELECT data_json FROM app_settings WHERE id=?', args: ['receipt_header'] });
check('setting round-trip', st.rows.length === 1);

// 3. idempotent replay
await upsert('repair_orders', roId, `idem-${stamp}-ro`, { id: roId, ticketNumber: 'T-1' }, now());
const cnt = await remote.execute({ sql: 'SELECT COUNT(*) as n FROM repair_orders WHERE id=?', args: [roId] });
check('replay still 1 row', Number(cnt.rows[0].n) === 1);

// 4. tombstone delete converges, pull sees deleted=1
await upsert('repair_orders', roId, `idem-${stamp}-ro`, { id: roId, deleted: 1 }, now(), 1);
const tomb = await remote.execute({ sql: 'SELECT deleted FROM repair_orders WHERE id=?', args: [roId] });
check('tombstone deleted=1', Number(tomb.rows[0].deleted) === 1);
const cursor = new Date(Date.now() - 60_000).toISOString();
const pulled = await remote.execute({ sql: 'SELECT id, deleted FROM repair_orders WHERE updated_at > ?', args: [cursor] });
check('pull sees tombstone', pulled.rows.some((r) => r.id === roId && Number(r.deleted) === 1));

// 5. cleanup
await remote.execute({ sql: 'DELETE FROM repair_orders WHERE id=?', args: [roId] });
await remote.execute({ sql: 'DELETE FROM app_settings WHERE id=?', args: ['receipt_header'] });
const gone = await remote.execute({ sql: 'SELECT COUNT(*) as n FROM repair_orders WHERE id=?', args: [roId] });
check('cleanup', Number(gone.rows[0].n) === 0);

console.log(failures === 0 ? 'GENERIC E2E OK' : `GENERIC E2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);

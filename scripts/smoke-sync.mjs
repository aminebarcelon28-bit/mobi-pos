// End-to-end smoke test of the sync path (no Tauri needed):
//   proxy broker -> Turso remote: idempotent upserts + updated_at cursor pull.
// Reads proxy/.env for broker port, fetches a token like the app does,
// then exercises products + inventory_ledger with a canary row and cleans up.
// Usage: node scripts/smoke-sync.mjs   (proxy must be running)

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
const PORT = fileEnv.PORT ?? '8787';
const proxyUrl = `http://localhost:${PORT}/api/sync-token`;
const now = () => new Date().toISOString();
const stamp = `smoke-${Date.now()}`;
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
};

// 1. Broker health + token (exact app path)
const health = await fetch(`http://localhost:${PORT}/health`).then((r) => r.json()).catch(() => null);
check('proxy /health', health?.ok === true);

const tokRes = await fetch(proxyUrl, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ deviceId: stamp }),
});
check('proxy /api/sync-token 200', tokRes.ok);
const { url, token, expiresAt } = await tokRes.json();
check('token payload', Boolean(url?.startsWith('libsql://')) && Boolean(token) && Date.parse(expiresAt) > Date.now());

// 2. Remote round-trip
const remote = createClient({ url, authToken: token });
const probe = await remote.execute('SELECT 1 as one');
check('remote SELECT 1', probe.rows[0].one === 1);

const productId = `PROD-${stamp}`;
const idemKey = `idem-${stamp}`;
const productPayload = JSON.stringify({ id: productId, title: 'Smoke Canary' });
await remote.execute({
  sql: `INSERT INTO products (id, sku, barcode, title, brand, category, price, stock, json_payload,
    device_id, idempotency_key, sync_status, created_at, updated_at, deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO NOTHING`,
  args: [productId, 'SMOKE', 'SMOKE', 'Smoke Canary', 'Test', 'Test', 100, 0, productPayload, stamp, idemKey, 'synced', now(), now()],
});
const afterFirst = await remote.execute({ sql: 'SELECT id FROM products WHERE id=?', args: [productId] });
check('canary product inserted', afterFirst.rows.length === 1);

// 3. Idempotency: replaying the same row (same id+key) must not duplicate.
// Identity is the PRIMARY KEY id; LWW makes replays no-ops.
await remote.execute({
  sql: `INSERT INTO products (id, sku, barcode, title, brand, category, price, stock, json_payload,
    device_id, idempotency_key, sync_status, created_at, updated_at, deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO NOTHING`,
  args: [productId, 'SMOKE', 'SMOKE', 'Smoke Canary', 'Test', 'Test', 100, 0, productPayload, stamp, idemKey, 'synced', now(), now()],
});
const dupCheck = await remote.execute({ sql: 'SELECT COUNT(*) as n FROM products WHERE id=?', args: [productId] });
check('idempotent replay (still 1 row)', Number(dupCheck.rows[0].n) === 1);

// 4. Ledger delta (append-only truth)
const ledgerId = `LED-${stamp}`;
await remote.execute({
  sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
    idempotency_key, sync_status, created_at, updated_at, deleted)
    VALUES (?,?,?,?,?,?,?,?,'synced',?, ?,0) ON CONFLICT(id) DO NOTHING`,
  args: [ledgerId, productId, 5, 'RECEIVE', 'smoke', stamp, stamp, `idem-led-${stamp}`, now(), now()],
});
const stock = await remote.execute({ sql: 'SELECT SUM(delta) as s FROM inventory_ledger WHERE product_id=?', args: [productId] });
check('ledger SUM(delta)=5', Number(stock.rows[0].s) === 5);

// 5. Pull cursor path (what SyncManager.pullOnce runs per table)
const cursor = new Date(Date.now() - 60_000).toISOString();
for (const t of ['products', 'transactions', 'transaction_items', 'inventory_ledger']) {
  const rs = await remote.execute({ sql: `SELECT * FROM ${t} WHERE updated_at > ? ORDER BY updated_at, id LIMIT 200`, args: [cursor] });
  check(`pull ${t} (sees canary=${t === 'products' || t === 'inventory_ledger'})`, t === 'products' || t === 'inventory_ledger' ? rs.rows.length >= 1 : Array.isArray(rs.rows));
}

// 6. Cleanup
await remote.execute({ sql: 'DELETE FROM inventory_ledger WHERE id=?', args: [ledgerId] });
await remote.execute({ sql: 'DELETE FROM products WHERE id=?', args: [productId] });
const gone = await remote.execute({ sql: 'SELECT COUNT(*) as n FROM products WHERE id=?', args: [productId] });
check('canary cleaned up', Number(gone.rows[0].n) === 0);

console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);

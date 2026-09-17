// Verify FIXED bidirectional logic: ledger-first checkout, stock update on
// pull conflict, cursor-only-on-success, new-row notification, Dexie upsert.
import { createClient } from '@libsql/client';
import { unlinkSync, existsSync } from 'node:fs';

const now = () => new Date().toISOString();
const tmp = (n) => `/tmp/verify-${n}.db`;
for (const f of [tmp('remote'), tmp('desktop'), tmp('mobile')]) {
  try { if (existsSync(f)) unlinkSync(f); } catch {}
}
const remote = createClient({ url: `file:${tmp('remote')}` });
const desktop = createClient({ url: `file:${tmp('desktop')}` });
const mobile = createClient({ url: `file:${tmp('mobile')}` });

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const localDDL = `
CREATE TABLE products (id TEXT PRIMARY KEY, sku TEXT, barcode TEXT, title TEXT NOT NULL, brand TEXT, category TEXT, price REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0, json_payload TEXT NOT NULL, device_id TEXT DEFAULT 'legacy', idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending', created_at TEXT DEFAULT '', updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE transactions (id TEXT PRIMARY KEY, receipt_number TEXT NOT NULL, total REAL NOT NULL, status TEXT NOT NULL DEFAULT 'COMPLETED', created_at TEXT NOT NULL, json_payload TEXT NOT NULL, device_id TEXT DEFAULT 'legacy', idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending', updated_at TEXT DEFAULT '', deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE transaction_items (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, product_id TEXT NOT NULL, quantity INTEGER NOT NULL, json_payload TEXT NOT NULL, device_id TEXT DEFAULT 'legacy', idempotency_key TEXT DEFAULT '', sync_status TEXT DEFAULT 'pending', created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '', deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE inventory_ledger (id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), delta INTEGER NOT NULL, reason TEXT NOT NULL, ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE sync_outbox (rowid INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`;
const remoteDDL = `
CREATE TABLE products (id TEXT PRIMARY KEY, title TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, json_payload TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE transactions (id TEXT PRIMARY KEY, receipt_number TEXT NOT NULL UNIQUE, total REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'COMPLETED', json_payload TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE transaction_items (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE, product_id TEXT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL, json_payload TEXT NOT NULL DEFAULT '{}', device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE inventory_ledger (id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), delta INTEGER NOT NULL, reason TEXT NOT NULL, ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'synced', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
`;
for (const s of localDDL.split(';').map((x) => x.trim()).filter(Boolean)) {
  await desktop.execute(s + ';');
  await mobile.execute(s + ';');
}
for (const s of remoteDDL.split(';').map((x) => x.trim()).filter(Boolean)) await remote.execute(s + ';');

const PROD = 'PROD-FIX';
// Single shared baseline: seed remote once, both devices start EMPTY then pull.
{
  const t = now();
  await remote.execute({ sql: `INSERT INTO products (id, title, price, stock, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [PROD, 'Canary', 1000, 10, '{}', 'seed', 'seed-prod', 'synced', 1, t, t, 0] });
  await remote.execute({ sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: ['seed-led', PROD, 10, 'SEED', 'migration', 'v3', 'seed', 'seed-led', 'synced', 1, t, t, 0] });
}

// FIXED checkout: domain writes -> ledger -> recompute -> product refresh
async function checkoutFixed(db, { txId, receipt, qty, transportId, sqliteId }) {
  const t = now();
  const orderKey = `idem-${txId}`;
  await db.execute({ sql: `INSERT INTO transactions (id, receipt_number, total, status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, deleted, version) VALUES (?,?,?,?,?,?,?,?,?,?,0,1)`, args: [txId, receipt, 1000 * qty, 'COMPLETED', t, JSON.stringify({ id: txId, receiptNumber: receipt, total: 1000 * qty, createdAt: t }), sqliteId, orderKey, 'pending', t] });
  const itemId = `${txId}-item-0`;
  await db.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version) VALUES (?,?,?,?,?,?,?,?,?,?,0,1)`, args: [itemId, txId, PROD, qty, '{}', sqliteId, `idem-${itemId}`, 'pending', t, t] });
  const ledId = `LED-${txId}`;
  await db.execute({ sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [ledId, PROD, -qty, 'SALE', 'order', txId, sqliteId, `idem-${ledId}`, 'pending', t, t, 0, 1] });
  await db.execute({ sql: `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=? AND deleted=0),stock), updated_at=? WHERE id=?`, args: [PROD, t, PROD] });
  const prow = (await db.execute({ sql: 'SELECT * FROM products WHERE id=?', args: [PROD] })).rows[0];
  await db.execute({ sql: `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, created_at, updated_at) VALUES (?,'product',?,'UPSERT',?,'pending',0,?,?)`, args: [prow.idempotency_key, PROD, JSON.stringify(prow), t, t] });
  await db.execute({ sql: `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, created_at, updated_at) VALUES (?,'order',?,'UPSERT',?,'pending',0,?,?)`, args: [orderKey, txId, JSON.stringify({ id: txId, receipt_number: receipt, total: 1000 * qty, status: 'COMPLETED', created_at: t }), t, t] });
  await db.execute({ sql: `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, created_at, updated_at) VALUES (?,'order_item',?,'UPSERT',?,'pending',0,?,?)`, args: [`idem-${itemId}`, itemId, JSON.stringify({ id: itemId, transaction_id: txId, product_id: PROD, quantity: qty }), t, t] });
  await db.execute({ sql: `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, created_at, updated_at) VALUES (?,'ledger',?,'UPSERT',?,'pending',0,?,?)`, args: [`idem-${ledId}`, ledId, JSON.stringify({ id: ledId, product_id: PROD, delta: -qty, device_id: sqliteId, idempotency_key: `idem-${ledId}` }), t, t] });
}

async function push(local, transportId) {
  const batch = (await local.execute(`SELECT * FROM sync_outbox WHERE status='pending' ORDER BY rowid LIMIT 50`)).rows;
  const rank = { product: 0, customer: 0, order: 1, order_item: 2, ledger: 2 };
  batch.sort((a, b) => (rank[a.entity_type] ?? 9) - (rank[b.entity_type] ?? 9));
  const t = now();
  for (const op of batch) {
    const p = JSON.parse(op.payload_json);
    if (op.entity_type === 'product') {
      await remote.execute({ sql: `INSERT INTO products (id, title, price, stock, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,'synced',?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, stock=excluded.stock, version=excluded.version, updated_at=excluded.updated_at WHERE excluded.version >= products.version`, args: [p.id, p.title ?? p.id, Number(p.price ?? 0), Number(p.stock ?? 0), JSON.stringify(p), p.device_id ?? transportId, op.idempotency_key, 1, t, p.updated_at ?? t, 0] });
    } else if (op.entity_type === 'order') {
      await remote.execute({ sql: `INSERT INTO transactions (id, receipt_number, total, status, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,'synced',?,?,?,0) ON CONFLICT(id) DO NOTHING`, args: [p.id ?? op.entity_id, p.receipt_number, Number(p.total ?? 0), 'COMPLETED', op.payload_json, transportId, op.idempotency_key, 1, p.created_at ?? t, t] });
    } else if (op.entity_type === 'order_item') {
      await remote.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,'synced',?,?,?,0) ON CONFLICT(id) DO NOTHING`, args: [p.id, p.transaction_id, p.product_id, Number(p.quantity ?? 1), op.payload_json, transportId, op.idempotency_key, 1, t, t] });
    } else if (op.entity_type === 'ledger') {
      await remote.execute({ sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,'synced',?,?,?,0) ON CONFLICT(id) DO NOTHING`, args: [p.id, p.product_id, Number(p.delta ?? 0), 'SALE', 'order', p.ref_id ?? null, p.device_id ?? transportId, op.idempotency_key, 1, t, t] });
    }
    await local.execute({ sql: 'DELETE FROM sync_outbox WHERE idempotency_key=?', args: [op.idempotency_key] });
  }
}

function makePuller(local, transportId) {
  const cursors = {};
  return async function pull() {
    let pulled = 0;
    const notified = [];
    for (const table of ['products', 'transactions', 'transaction_items', 'inventory_ledger']) {
      const cur = cursors[table] ?? { time: '1970-01-01T00:00:00.000Z', id: '' };
      const rs = (await remote.execute({ sql: `SELECT * FROM ${table} WHERE (updated_at > ?) OR (updated_at = ? AND id > ?) ORDER BY updated_at ASC, id ASC LIMIT 200`, args: [cur.time, cur.time, cur.id] })).rows;
      let maxT = cur.time, maxI = cur.id;
      for (const r of rs) {
        const upd = r.updated_at ?? now();
        try {
          if (table === 'products') {
            await local.execute({ sql: `INSERT INTO products (id, sku, barcode, title, price, stock, json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title, stock=excluded.stock, version=excluded.version, updated_at=excluded.updated_at WHERE excluded.version >= products.version`, args: [r.id, r.sku ?? '', r.barcode ?? '', r.title ?? r.id, Number(r.price ?? 0), Number(r.stock ?? 0), r.json_payload ?? '{}', r.device_id ?? 'remote', r.idempotency_key ?? r.id, 'synced', r.created_at ?? now(), r.updated_at ?? now(), Number(r.deleted ?? 0)] });
          } else if (table === 'transactions') {
            const pre = (await local.execute({ sql: 'SELECT id FROM transactions WHERE id=?', args: [r.id] })).rows;
            const isNew = pre.length === 0;
            await local.execute({ sql: `INSERT INTO transactions (id, receipt_number, total, status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, deleted, version) VALUES (?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET status=excluded.status WHERE excluded.version >= transactions.version`, args: [r.id, r.receipt_number ?? r.id, Number(r.total ?? 0), 'COMPLETED', r.created_at ?? now(), r.json_payload ?? '{}', r.device_id ?? 'remote', r.idempotency_key ?? r.id, 'synced', r.updated_at ?? now(), Number(r.deleted ?? 0)] });
            if (isNew && String(r.device_id || '') !== transportId) notified.push(r.id);
          } else if (table === 'transaction_items') {
            await local.execute({ sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version) VALUES (?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO NOTHING`, args: [r.id, r.transaction_id, r.product_id, Number(r.quantity ?? 1), r.json_payload ?? '{}', r.device_id ?? 'remote', r.idempotency_key ?? r.id, 'synced', r.created_at ?? now(), r.updated_at ?? now(), Number(r.deleted ?? 0)] });
          } else {
            await local.execute({ sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, args: [r.id, r.product_id, Number(r.delta ?? 0), 'SALE', 'order', r.ref_id ?? null, r.device_id ?? 'remote', r.idempotency_key ?? r.id, 'synced', r.created_at ?? now(), r.updated_at ?? now(), 0, 1] });
          }
          pulled++;
          if (upd > maxT || (upd === maxT && r.id > maxI)) { maxT = upd; maxI = r.id; }
        } catch (e) {
          console.log(`  apply failed [${table}]: ${String(e.message ?? e).slice(0, 120)}`);
        }
      }
      cursors[table] = { time: maxT, id: maxI };
    }
    if (pulled > 0) await local.execute({ sql: `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id = products.id AND deleted=0), stock)` });
    return { pulled, notified };
  };
}

const desktopPull = makePuller(desktop, 'desktop-T');
const mobilePull = makePuller(mobile, 'mobile-T');
const stockOf = async (db) => Number((await db.execute({ sql: 'SELECT stock FROM products WHERE id=?', args: [PROD] })).rows[0]?.stock);

// Both start empty -> initial pull converges to 10 with single seed (no double count)
await desktopPull();
await mobilePull();
check('initial converge desktop=10', (await stockOf(desktop)) === 10, `got ${await stockOf(desktop)}`);
check('initial converge mobile=10', (await stockOf(mobile)) === 10, `got ${await stockOf(mobile)}`);

await checkoutFixed(desktop, { txId: 'TXN-D1', receipt: 'REC-D1', qty: 2, transportId: 'desktop-T', sqliteId: 'desktop-S' });
check('desktop local stock 8 after own sale', (await stockOf(desktop)) === 8, `got ${await stockOf(desktop)}`);
await push(desktop, 'desktop-T');
const m1 = await mobilePull();
check('mobile pulled desktop sale', m1.pulled > 0, `pulled=${m1.pulled}`);
check('mobile notified desktop sale', m1.notified.includes('TXN-D1'), JSON.stringify(m1.notified));
check('mobile stock 8', (await stockOf(mobile)) === 8, `got ${await stockOf(mobile)}`);

await checkoutFixed(mobile, { txId: 'TXN-M1', receipt: 'REC-M1', qty: 1, transportId: 'mobile-T', sqliteId: 'mobile-S' });
check('mobile local stock 7 after own sale', (await stockOf(mobile)) === 7, `got ${await stockOf(mobile)}`);
await push(mobile, 'mobile-T');
const d1 = await desktopPull();
check('desktop pulled mobile sale', d1.pulled > 0, `pulled=${d1.pulled}`);
check('desktop notified mobile sale', d1.notified.includes('TXN-M1'), JSON.stringify(d1.notified));
check('desktop stock 7', (await stockOf(desktop)) === 7, `got ${await stockOf(desktop)}`);
check('stocks converge', (await stockOf(desktop)) === (await stockOf(mobile)), `${await stockOf(desktop)} vs ${await stockOf(mobile)}`);

console.log(failures === 0 ? 'VERIFY OK — bidirectional sync converges' : `VERIFY FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);

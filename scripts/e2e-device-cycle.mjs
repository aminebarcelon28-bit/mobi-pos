// Headless device-cycle test: simulates EXACTLY what the app does, without GUI.
//   local file DB (same DDL as plugin-sql migrations v1+v2+v3 deltas)
//   -> writeCheckoutAtomic-equivalent (order+items+ledger+outbox, allow-negative)
//   -> SyncManager.pushOnce-equivalent (idempotent batch upserts via broker token)
//   -> SyncManager.pullOnce-equivalent (updated_at cursor)
//   -> verify in Turso, then clean up.
// Usage: node scripts/e2e-device-cycle.mjs   (proxy must be running)

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
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
const now = () => new Date().toISOString();
const stamp = `e2e-${Date.now()}`;
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const LOCAL_PATH = `file:/tmp/e2e-${stamp}.db`;
try { unlinkSync(`/tmp/e2e-${stamp}.db`); } catch { /* ignore */ }

// ── 1. Local DB with app-identical DDL ──────────────────────────────
const local = createClient({ url: LOCAL_PATH });
const remoteSchema = readFileSync('turso/remote-schema.sql', 'utf8');
for (const s of remoteSchema.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) {
  await local.execute(s.endsWith(';') ? s : s + ';');
}
// local-only outbox (never on Turso) + compat views (migration v3)
await local.execute(`CREATE TABLE IF NOT EXISTS sync_outbox (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
await local.execute('CREATE VIEW IF NOT EXISTS orders AS SELECT * FROM transactions');
await local.execute('CREATE VIEW IF NOT EXISTS order_items AS SELECT * FROM transaction_items');
check('local schema ready', true);

// ── 2. Checkout write (mirrors sqlPluginAdapter.writeCheckoutAtomic) ─
const txnId = `TXN-${stamp.slice(-6)}`;
const receipt = `REC-${stamp.slice(-6)}`;
const prodId = `PROD-${stamp}`;
const orderKey = `idem-order-${stamp}`;
const itemKey = `idem-item-${stamp}`;
const ledgerKey = `idem-ledger-${stamp}`;
const orderPayload = { id: txnId, receipt_number: receipt, total: 250, status: 'COMPLETED', created_at: now() };

await local.execute({
  sql: `INSERT INTO products (id, sku, barcode, title, brand, category, price, stock, json_payload,
    device_id, idempotency_key, sync_status, created_at, updated_at, deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
  args: [prodId, 'E2E', 'E2E', 'E2E Canary', 'Test', 'Test', 125, 0, '{}', 'e2e-device', `stub-${prodId}`, 'pending', now(), now()],
});
// product outbox FIRST (remote FKs: items/ledger -> products resolve in batch order)
await local.execute({
  sql: `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, created_at, updated_at)
    VALUES (?,'product',?,'UPSERT',?,'pending',0,?,?)`,
  args: [`stub-${prodId}`, prodId, JSON.stringify({ id: prodId, sku: 'E2E', barcode: 'E2E', title: 'E2E Canary', brand: 'Test', category: 'Test', price: 125, stock: 0 }), now(), now()],
});
await local.execute({
  sql: `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
    cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
    status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
  args: [txnId, receipt, null, 250, 0, 0, 250, 100, 150, 60, 'Retail', 'Espèces', 250, 0,
    'COMPLETED', orderPayload.created_at, JSON.stringify(orderPayload), 'e2e-device', orderKey, 'pending', now()],
});
await local.execute({
  sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
    imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
  args: [`${txnId}-item-0`, txnId, prodId, 2, 125, 0, null, 50, '{}', 'e2e-device', itemKey, 'pending', now(), now()],
});
// allow-negative: product had 0, sold 2 -> cached stock must be -2 after recompute
await local.execute({
  sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
    idempotency_key, sync_status, created_at, updated_at, deleted) VALUES (?,?,?,?,?,?,?,?,'pending',?,0)`,
    args: [`LED-${stamp}`, prodId, -2, 'SALE', 'order', txnId, 'e2e-device', ledgerKey, now(), now()],
});
await local.execute({
  sql: `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=? AND deleted=0), stock) WHERE id=?`,
  args: [prodId, prodId],
});
const stockRow = await local.execute({ sql: 'SELECT stock FROM products WHERE id=?', args: [prodId] });
check('allow-negative cached stock = -2', Number(stockRow.rows[0].stock) === -2, `got ${stockRow.rows[0].stock}`);

for (const [key, type, eid, payload] of [
  [orderKey, 'order', txnId, JSON.stringify(orderPayload)],
  [itemKey, 'order_item', `${txnId}-item-0`, JSON.stringify({ id: `${txnId}-item-0`, transaction_id: txnId, product_id: prodId, quantity: 2, applied_price: 125 })],
  [ledgerKey, 'ledger', `LED-${stamp}`, JSON.stringify({ id: `LED-${stamp}`, product_id: prodId, delta: -2, reason: 'SALE', ref_type: 'order', ref_id: txnId, device_id: 'e2e-device', idempotency_key: ledgerKey })],
]) {
  await local.execute({
    sql: `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, created_at, updated_at)
      VALUES (?,'${type}',?,'UPSERT',?,'pending',0,?,?)`,
    args: [key, eid, payload, now(), now()],
  });
}
const pending = await local.execute("SELECT COUNT(*) as n FROM sync_outbox WHERE status='pending'");
check('outbox has 4 pending (product first)', Number(pending.rows[0].n) === 4);

// ── 3. Push (mirrors SyncManager.pushOnce via broker token) ─────────
const tokRes = await fetch(`http://localhost:${PORT}/api/sync-token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ deviceId: 'e2e-device' }),
});
check('broker token', tokRes.ok);
const { url, token } = await tokRes.json();
const remote = createClient({ url, authToken: token });

const batch = (await local.execute("SELECT * FROM sync_outbox WHERE status='pending' ORDER BY rowid LIMIT 50")).rows;
// parent-first (mirrors SyncManager.pushOnce): products/customers, orders, items/ledger
const rank = { product: 0, customer: 0, order: 1, order_item: 2, ledger: 2 };
batch.sort((a, b) => (rank[a.entity_type] ?? 9) - (rank[b.entity_type] ?? 9));
for (const op of batch) {
  const o = op;
  await local.execute({ sql: 'UPDATE sync_outbox SET status=? WHERE idempotency_key=?', args: ['inflight', o.idempotency_key] });
}
const statements = [];
for (const op of batch) {
  const o = op;
  const p = JSON.parse(o.payload_json);
  if (o.entity_type === 'product') statements.push({
    sql: `INSERT INTO products (id, sku, barcode, title, brand, category, price, stock,
      json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,0)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at,
      sync_status='synced' WHERE excluded.updated_at > products.updated_at`,
    args: [p.id, p.sku ?? '', p.barcode ?? '', p.title ?? p.id, p.brand ?? '', p.category ?? '',
      p.price ?? 0, p.stock ?? 0, o.payload_json, 'e2e-device', o.idempotency_key, now(), now()],
  });
  if (o.entity_type === 'order') statements.push({
    sql: `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
      cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
      status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, deleted)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,0)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total,
      json_payload=excluded.json_payload, updated_at=excluded.updated_at, sync_status='synced'
      WHERE excluded.updated_at > transactions.updated_at`,
    args: [p.id, p.receipt_number, null, 250, 0, 0, 250, 100, 150, 60, 'Retail', 'Espèces', 250, 0,
      'COMPLETED', p.created_at, o.payload_json, 'e2e-device', o.idempotency_key, now()],
  });
  if (o.entity_type === 'order_item') statements.push({
    sql: `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
      imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,0) ON CONFLICT(id) DO NOTHING`,
    args: [p.id, p.transaction_id, p.product_id, p.quantity, p.applied_price, 0, null, 50, o.payload_json, 'e2e-device', o.idempotency_key, now(), now()],
  });
  if (o.entity_type === 'ledger') statements.push({
    sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
      idempotency_key, sync_status, created_at, updated_at, deleted)
      VALUES (?,?,?,?,?,?,?,?,'synced',?,0) ON CONFLICT(id) DO NOTHING`,
    args: [p.id, p.product_id, p.delta, p.reason, p.ref_type, p.ref_id, 'e2e-device', o.idempotency_key, now(), now()],
  });
}
for (const [si, s] of statements.entries()) {
  try {
    await remote.execute(s);
    const op = batch[si];
    await local.execute({ sql: 'DELETE FROM sync_outbox WHERE idempotency_key=?', args: [op.idempotency_key] });
    s.ok = true;
  } catch (e) {
    console.log(`push FAIL stmt ${si}: ${e.message?.split('\n')[0] ?? e}`);
    s.ok = false;
  }
}
const drained = await local.execute("SELECT COUNT(*) as n FROM sync_outbox WHERE status='pending'");
check('outbox drained after push', Number(drained.rows[0].n) === 0);

const rOrder = await remote.execute({ sql: 'SELECT receipt_number, total, status FROM transactions WHERE id=?', args: [txnId] });
check('order in Turso', rOrder.rows.length === 1 && rOrder.rows[0].receipt_number === receipt, JSON.stringify(rOrder.rows[0] ?? null));
const rLedger = await remote.execute({ sql: 'SELECT SUM(delta) as s FROM inventory_ledger WHERE product_id=?', args: [prodId] });
check('ledger delta -2 in Turso', Number(rLedger.rows[0].s) === -2);

// push idempotency: replay same batch must not duplicate
await remote.batch(statements, 'write');
const noDup = await remote.execute({ sql: 'SELECT COUNT(*) as n FROM transactions WHERE id=?', args: [txnId] });
check('replay push still 1 order', Number(noDup.rows[0].n) === 1);

// ── 4. Pull (mirrors SyncManager.pullOnce cursor) ───────────────────
const cursor = new Date(Date.now() - 5 * 60_000).toISOString();
let sawOrder = false;
for (const t of ['transactions', 'transaction_items', 'inventory_ledger', 'products']) {
  const rs = await remote.execute({ sql: `SELECT * FROM ${t} WHERE updated_at > ? ORDER BY updated_at, id LIMIT 200`, args: [cursor] });
  if (t === 'transactions' && rs.rows.some((r) => r.id === txnId)) sawOrder = true;
}
check('pull cursor sees pushed order', sawOrder);

// ── 5. Cleanup (remote + local file) ────────────────────────────────
await remote.execute({ sql: 'DELETE FROM inventory_ledger WHERE product_id=?', args: [prodId] });
await remote.execute({ sql: 'DELETE FROM transaction_items WHERE transaction_id=?', args: [txnId] });
await remote.execute({ sql: 'DELETE FROM transactions WHERE id=?', args: [txnId] });
await remote.execute({ sql: 'DELETE FROM products WHERE id=?', args: [prodId] });
const gone = await remote.execute({ sql: 'SELECT COUNT(*) as n FROM transactions WHERE id=?', args: [txnId] });
check('remote cleanup', Number(gone.rows[0].n) === 0);
try { unlinkSync(`/tmp/e2e-${stamp}.db`); } catch { /* ignore */ }

console.log(failures === 0 ? 'E2E OK' : `E2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);

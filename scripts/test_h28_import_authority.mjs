/**
 * H28 regression: backup import must write the SQLite AUTHORITY, not just Dexie.
 *
 * `maintenanceAdapter.importJSON` calls `mirrorImportToAuthority(parsed)`
 * before clearing the Dexie mirror. A previous revision referenced that
 * function without ever defining it, so EVERY import threw a ReferenceError,
 * the catch reported a fake "écriture autorité SQLite impossible" failure, and
 * the whole backup-import feature was dead (C6: silent data loss — a merchant
 * restoring a backup got nothing into the authority, and the imported rows
 * would never have reached the cloud either).
 *
 * This test drives the REAL adapter source against a REAL on-disk SQLite
 * authority built from the REAL Rust migration DDL (extracted from
 * src-tauri/src/lib.rs, not reconstructed from memory). Tauri + Dexie are
 * stubbed so the test runs headless; the SQL under test is the real source.
 *
 *   [0] the function exists and importJSON does not throw (the original bug)
 *   [1] products  -> products row + inventory_ledger ADJUST + product outbox op
 *   [2] transactions -> transactions row + transaction_items row + order outbox op
 *   [3] generic lanes -> outbox op per row + entity_keys clock + stamped version
 *   [4] re-import is idempotent (outbox dedups, no phantom rows)
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  readFileSync, writeFileSync, unlinkSync, existsSync,
  mkdirSync, rmSync, statSync, readdirSync,
} from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { createClient } from '@libsql/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SHIM = join(ROOT, 'tmp-h28-shim');
const DB_PATH = join(ROOT, 'tmp-h28-authority.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`); }
}

// ---------------------------------------------------------------------------
// 0. Fresh scratch space (Windows EPERM retries)
// ---------------------------------------------------------------------------
rmSync(SHIM, { recursive: true, force: true });
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  for (let i = 0; i < 5; i++) { try { if (existsSync(f)) unlinkSync(f); break; } catch { /* retry */ } }
}
mkdirSync(join(SHIM, 'db', 'adapters'), { recursive: true });
mkdirSync(join(SHIM, 'sync'), { recursive: true });
mkdirSync(join(SHIM, 'schemas'), { recursive: true });
mkdirSync(join(SHIM, 'types'), { recursive: true });
mkdirSync(join(SHIM, 'utils'), { recursive: true });

// ---------------------------------------------------------------------------
// 1. Extract the REAL base schema DDL from the Rust migrations
// ---------------------------------------------------------------------------
const libRs = readFileSync(join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const migrations = [...libRs.matchAll(/sql:\s*r#"\r?\n([\s\S]*?)"#/g)].map((m) => m[1]);
if (migrations.length < 8) { console.error(`FAIL: extracted ${migrations.length} migrations`); process.exit(1); }
console.log(`  [schema] extracted ${migrations.length} real migrations from lib.rs`);

const local = createClient({ url: `file:${DB_PATH.replace(/\\/g, '/')}` });
await local.execute('PRAGMA journal_mode=WAL;');
await local.execute('PRAGMA synchronous=NORMAL;');
await local.execute('PRAGMA foreign_keys=ON;');
let stmtCount = 0;
for (const m of migrations) {
  for (const raw of m.split(';')) {
    const stmt = raw.trim();
    if (!stmt || stmt.startsWith('--')) continue;
    try { await local.execute(stmt); stmtCount++; } catch { /* duplicate column/index — expected */ }
  }
}
// The JS boot pass carries additional column/index statements.
const jsBoot = readFileSync(join(ROOT, 'src', 'db', 'sqlPluginAdapter.ts'), 'utf8');
const jsStatements = [...jsBoot.matchAll(/'((?:CREATE|ALTER|UPDATE)[^']*)'/g)]
  .map((m) => m[1])
  .filter((s) => /^(CREATE|ALTER|UPDATE)/.test(s));
for (const stmt of jsStatements) {
  try { await local.execute(stmt); stmtCount++; } catch { /* expected dupes */ }
}
console.log(`  [schema] applied ${stmtCount} statements`);

// ---------------------------------------------------------------------------
// 2. Build the shim tree: real source, stubbed runtime deps
// ---------------------------------------------------------------------------
const SRC = (...p) => join(ROOT, 'src', ...p);
const DST = (...p) => join(SHIM, ...p);

// The real sources under test pull in a small closure of siblings; copy them
// all so nothing is reconstructed from memory, then stub the one runtime dep
// that cannot exist headless (dexie = IndexedDB).
const REAL_ROOTS = [
  'db/sqlPluginAdapter.ts',
  'db/adapters/maintenanceAdapter.ts',
  'sync/eventInterceptor.ts',
  'sync/snapshotBackfill.ts',
  'sync/payloadHygiene.ts',
  'schemas/backupSchema.ts',
];
// dexie needs IndexedDB, which does not exist headless — stub its wrapper.
const STUB_MODULES = new Set(['db/database.ts']);

const closure = new Set();
function walkClosure(rel) {
  if (closure.has(rel)) return;
  let body;
  try { body = readFileSync(SRC(...rel.split(/[\\/]/)), 'utf8'); } catch { return; }
  closure.add(rel);
  for (const m of body.matchAll(/from\s+'([^']+)'/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const base = normalize(join(dirname(rel), spec));
    const cands = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].map((c) => c.split(/[\\/]/).join('/'));
    const found = cands.find((c) => { try { return statSync(SRC(...c.split(/[\\/]/))).isFile(); } catch { return false; } });
    if (found) walkClosure(found);
  }
}
for (const r of REAL_ROOTS) walkClosure(r);
for (const r of [...closure]) { closure.delete(r); closure.add(r.split(/[\\/]/).join('/')); }

for (const rel of closure) {
  const parts = rel.split(/[\\/]/);
  mkdirSync(dirname(DST(...parts)), { recursive: true });
  const body = STUB_MODULES.has(rel)
    ? 'const noop = { put: async () => {}, delete: async () => {}, get: async () => undefined,\n  toArray: async () => [], count: async () => 0, bulkPut: async () => {}, clear: async () => {},\n  where: () => ({ equals: () => ({ toArray: async () => [] }) }) };\nconst table = () => noop;\nexport const db = new Proxy({\n  products: table(), customers: table(), transactions: table(), repairOrders: table(),\n  purchaseOrders: table(), tradeIns: table(), imeiRecords: table(), securityAuditLogs: table(),\n  cashDrops: table(), payouts: table(), bundles: table(), customerDebts: table(),\n  storeExpenses: table(), cashSessions: table(), cashMovements: table(),\n  stockBatches: table(), creditVouchers: table(), appSettings: table(),\n  transaction: async () => noop,\n}, { get: (t, k) => (k in t ? t[k] : noop) });\n'
    : readFileSync(SRC(...parts), 'utf8');
  // Node 24 strips TS types only for .ts files, and then every relative
  // specifier must carry the .ts extension explicitly.
  const resolveSpec = (spec) => {
    const b = normalize(join(dirname(rel), spec));
    const cands = [b, `${b}.ts`, `${b}.tsx`, `${b}/index.ts`].map((c) => c.split(/[\\/]/).join('/'));
    const found = cands.find((c) => { try { return statSync(SRC(...c.split(/[\\/]/))).isFile(); } catch { return false; } });
    if (!found) return /[.](?:js|ts)$/.test(spec) ? spec : `${spec}.ts`;
    const out = relative(dirname(rel), found).split(/[\\/]/).join('/');
    return out.startsWith('.') ? out : `./${out}`;
  };
  const t = body
    .replace(/(^|[^\w$])from\s+'(\.\.?(?:\/[^']*)?)'/g, (full, pre, spec) => `${pre}from '${resolveSpec(spec)}'`)
    .replace(/import\s*\(\s*'(\.\.?(?:\/[^']*)?)'\s*\)/g, (full, spec) => `import('${resolveSpec(spec)}')`);
  writeFileSync(DST(...parts), t);
}

// @tauri-apps/plugin-sql stub backed by the SAME real libsql client.
// Faithful to the Rust plugin: each execute()/select() is one pooled
// connection, and the pool keeps transaction state across calls (sqlx's
// worker tracks transaction_depth). The libsql JS client instead rolls
// back any open transaction on release, so a manual BEGIN in one call and
// a COMMIT in a later call cannot survive in the raw client. Emulate the
// Rust pool here: track depth in the stub so BEGIN..work..COMMIT holds.
writeFileSync(DST('tauriStub.js'), `
import { createClient } from '@libsql/client';
const client = createClient({ url: 'file:C:/Users/Click/Desktop/phone3-sync-lab/tmp-h28-authority.db' });
let txnDepth = 0;
function norm(s) { return String(s ?? '').replace(/\\r?\\n/g, ' ').trim(); }
export default class Database {
  static async load() { return new Database(); }
  async select(sql, args) {
    const res = await client.execute({ sql: norm(sql), args: args ?? [] });
    return res.rows;
  }
  async execute(sql, args) {
    const s = norm(sql);
    if (s === 'BEGIN IMMEDIATE' || s === 'BEGIN' || s.startsWith('BEGIN ')) {
      if (txnDepth > 0) { return { rowsAffected: 0 }; }
      txnDepth = 1;
      return { rowsAffected: 0 };
    }
    if (s === 'COMMIT' || s === 'COMMIT;') {
      if (txnDepth === 0) {
        throw new Error('SQLITE_ERROR: cannot commit - no transaction is active');
      }
      txnDepth = 0;
      return { rowsAffected: 0 };
    }
    if (s === 'ROLLBACK' || s === 'ROLLBACK;') {
      txnDepth = 0;
      return { rowsAffected: 0 };
    }
    if (Array.isArray(args)) return client.execute({ sql: s, args });
    return client.execute(s);
  }
}
`);

// Rewire the plugin-sql import to the stub: the closure copier already
// rewrote every RELATIVE specifier, but `@tauri-apps/plugin-sql` is bare,
// so patch the adapter + its closure by hand. Also drop the `Product` type
// import (types are stripped; the rewriter left it pointing at a path that
// only exists for the type checker).
const rewireFile = (rel) => {
  const p = DST(...rel.split('/'));
  let s = readFileSync(p, 'utf8');
  s = s.replace(/(^|[^\w$])from\s+'@tauri-apps\/plugin-sql'/g, (full, pre) => `${pre}from '../tauriStub.js'`);
  s = s.replace(/import\s+type\s+{\s*Product\s*}\s+from\s+'[^']*';\s*\n/g, '');
  writeFileSync(p, s);
};
for (const rel of [...closure]) rewireFile(rel);
// The shim tree is now complete: load the REAL adapter source. It resolves
// `../database` to the dexie stub and `@tauri-apps/plugin-sql` to tauriStub,
// so every SQL it emits lands in the real on-disk authority above.
const adapter = await import(pathToFileURL(DST('db', 'adapters', 'maintenanceAdapter.ts')).href);

// ---------------------------------------------------------------------------
// 3. Drive the REAL maintenanceAdapter.importJSON against the real authority
// ---------------------------------------------------------------------------
const select = async (sql) => (await local.execute({ sql: String(sql).replace(/\r?\n/g, ' ') })).rows;
const productId = 'h28-prod-001';
const txId = 'h28-tx-001';
const customerId = 'h28-cust-001';
const payload = {
  version: '2.0',
  exportedAt: '2026-09-14T00:00:00.000Z',
  products: [{ id: productId, title: 'H28 Article', sku: 'H28-SKU', price: 12000, stock: 4 }],
  customers: [{ id: customerId, name: 'H28 Client', phone: '0555000000' }],
  transactions: [{
    id: txId,
    receiptNumber: 'H28-0001',
    customer: { id: customerId, name: 'H28 Client' },
    subtotal: 24000,
    discountTotal: 0,
    total: 24000,
    status: 'COMPLETED',
    paymentMethod: 'Espèces',
    items: [{ product: { id: productId, title: 'H28 Article', price: 12000 }, quantity: 2, appliedPrice: 12000 }],
  }],
  repairOrders: [{ id: 'h28-ro-001', customerId, status: 'DIAGNOSTIC' }],
  purchaseOrders: [{ id: 'h28-po-001', status: 'DRAFT' }],
  tradeIns: [{ id: 'h28-ti-001', status: 'EVALUATED' }],
  imeiRecords: [{ imei: 'h28-imei-001', productId }],
  securityAuditLogs: [{ id: 'h28-audit-001', action: 'IMPORT' }],
  cashDrops: [{ id: 'h28-cd-001', type: 'drop' }],
  payouts: [{ id: 'h28-po-002', type: 'payout' }],
  bundles: [{ id: 'h28-bun-001', title: 'H28 Forfait' }],
  customerDebts: [{ id: 'h28-debt-001', customerId, customerName: 'H28 Client', type: 'DEBT', amount: 5000, balanceAfter: 5000 }],
  storeExpenses: [{ id: 'h28-exp-001', amount: 1500 }],
  appSettings: [{ key: 'store.name', value: 'H28 Store' }],
};

console.log('\n  --- running the real importJSON ---');
let importErr = null;
try {
  await adapter.maintenanceAdapter.importJSON(JSON.stringify(payload));
} catch (e) { importErr = e; }
check('[0] importJSON does not throw (the original H28 ReferenceError)', importErr === null, importErr && (importErr.message || importErr));

const ledger = await select(`SELECT * FROM inventory_ledger WHERE product_id='${productId}' AND reason='ADJUST'`);
const prows = await select(`SELECT * FROM products WHERE id='${productId}'`);
check('[1a] product authority row exists', prows.length === 1, prows.length);
check('[1b] product stock landed', Number(prows[0]?.stock) === 4, prows[0]?.stock);
check('[1c] inventory_ledger ADJUST row written', ledger.length >= 1, ledger.length);
const prodOps = await select(`SELECT * FROM sync_outbox WHERE entity_type='product' AND entity_id='${productId}'`);
check('[1d] product outbox op enqueued', prodOps.length >= 1, prodOps.length);

console.log('\n  --- transactions lane ---');
const trows = await select(`SELECT * FROM transactions WHERE id='${txId}'`);
check('[2a] transaction authority row exists', trows.length === 1, trows.length);
check('[2b] transaction total landed', Number(trows[0]?.total) === 24000, trows[0]?.total);
check('[2c] customer_id unwrapped from nested object', trows[0]?.customer_id === customerId, trows[0]?.customer_id);
// The INSERT seeds version=1; enqueueOrderSync then advances the clock to 2
// because the payload carries a status (the void/refund version guard).
check('[2d] transaction version clock seeded and advanced', Number(trows[0]?.version) >= 1, trows[0]?.version);
const irows = await select(`SELECT * FROM transaction_items WHERE transaction_id='${txId}'`);
check('[2e] transaction_items row exists', irows.length === 1, irows.length);
check('[2f] item quantity + applied_price landed', Number(irows[0]?.quantity) === 2 && Number(irows[0]?.applied_price) === 12000, `${irows[0]?.quantity}/${irows[0]?.applied_price}`);
const orderOps = await select(`SELECT * FROM sync_outbox WHERE entity_type='order' AND entity_id='${txId}'`);
check('[2g] order outbox op enqueued', orderOps.length >= 1, orderOps.length);

console.log('\n  --- generic lanes ---');
const expected = [
  ['customer', customerId], ['repair_order', 'h28-ro-001'], ['purchase_order', 'h28-po-001'],
  ['trade_in', 'h28-ti-001'], ['imei', 'h28-imei-001'], ['audit_log', 'h28-audit-001'],
  ['cash_drop', 'h28-cd-001'], ['cash_drop', 'h28-po-002'], ['bundle', 'h28-bun-001'],
  ['customer_debt', 'h28-debt-001'], ['store_expense', 'h28-exp-001'], ['setting', 'store.name'],
];
for (const [ent, id] of expected) {
  const ops = await select(`SELECT * FROM sync_outbox WHERE entity_type='${ent}' AND entity_id='${id}'`);
  check(`[3] lane ${ent}/${id} enqueued`, ops.length >= 1, ops.length);
  const clock = await select(`SELECT version FROM entity_keys WHERE entity_type='${ent}' AND entity_id='${id}'`);
  check(`[3] entity_keys clock for ${ent}/${id}`, Number(clock[0]?.version) >= 1, clock[0]?.version);
  if (ops.length >= 1) {
    let v;
    try { v = JSON.parse(ops[0].payload_json).version; } catch { v = undefined; }
    check(`[3] payload stamps version for ${ent}/${id}`, typeof v === 'number' && v >= 1, v);
  }
}

console.log('\n  --- idempotency ---');
const before = (await select('SELECT COUNT(*) AS c FROM sync_outbox'))[0]?.c;
await adapter.maintenanceAdapter.importJSON(JSON.stringify(payload));
const after = (await select('SELECT COUNT(*) AS c FROM sync_outbox'))[0]?.c;
check('[4a] re-import creates no phantom outbox rows', Number(after) === Number(before), `${before} -> ${after}`);
const dupes = await select('SELECT idempotency_key, COUNT(*) AS c FROM sync_outbox GROUP BY idempotency_key HAVING c > 1');
check('[4b] no duplicate idempotency_keys', dupes.length === 0, dupes.length);

// ---------------------------------------------------------------------------
// 6. Cleanup
// ---------------------------------------------------------------------------
try { await local.close(); } catch { /* ignore */ }
rmSync(SHIM, { recursive: true, force: true });
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  for (let i = 0; i < 5; i++) { try { if (existsSync(f)) unlinkSync(f); break; } catch { /* retry */ } }
}

console.log(`\nH28: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
if (failures) process.exitCode = 1;

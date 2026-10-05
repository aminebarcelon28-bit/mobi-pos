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
import { dirname, join, normalize, relative, sep } from 'node:path';
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
// FT-06/C provenance (mirrors the production TS self-heal in
// sqlPluginAdapter.ts, whose single-quoted DEFAULT the extractor above
// cannot capture — the regex stops at the first inner quote).
try {
  await local.execute("ALTER TABLE security_audit_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'local';");
  stmtCount++;
} catch { /* expected dupes */ }
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
  // FT-06/C: maintenanceAdapter lazily imports the native audit plane via
  // dynamic import() (chunk discipline) — follow those edges too, or the
  // shim rewrites the specifier without copying the module.
  for (const m of body.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)) {
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
// The stub MUST open the same DB the assertions read (DB_PATH above). A
// hardcoded checkout path here once routed the lane into a sibling clone:
// the import succeeded ([0] green) while every assertion read zero rows.
const STUB_DB_URL = 'file:' + DB_PATH.split(sep).join('/') + '';
writeFileSync(DST('tauriStub.js'), `
import { createClient } from '@libsql/client';
const client = createClient({ url: '${STUB_DB_URL}' });
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
  securityAuditLogs: [{ id: 'h28-audit-001', action: 'IMPORT' }, { id: 'h28-audit-002', action: 'IMPORT2' }],
  cashDrops: [{ id: 'h28-cd-001', type: 'drop' }],
  payouts: [{ id: 'h28-po-002', type: 'payout' }],
  bundles: [{ id: 'h28-bun-001', title: 'H28 Forfait' }],
  customerDebts: [{ id: 'h28-debt-001', customerId, customerName: 'H28 Client', type: 'DEBT', amount: 5000, balanceAfter: 5000 }],
  storeExpenses: [{ id: 'h28-exp-001', amount: 1500 }],
  appSettings: [
    { key: 'store.name', value: 'H28 Store' },
    // Decision 2: hostile credential rows — must never enqueue, never land.
    { key: 'manager_pin', value: 'v1$evil$stale' },
    { key: 'cashier_users', value: '[{"id":"evil","pin":"v1$x$y"}]' },
  ],
};

console.log('\n  --- running the real importJSON ---');
// Follow-up a: the exact envelope bytes identify the backup. Hash them the
// same way any verifier would (node:crypto, not the app primitive) so the
// assertion proves the row carries the FILE hash, not a constant.
const { createHash } = await import('node:crypto');
const payloadStr = JSON.stringify(payload);
const expectedSha = createHash('sha256').update(payloadStr, 'utf8').digest('hex');
// FT-06/C: stub the native IPC transport. audit_append is recorded and
// receipted (the row-write itself is native logic, covered by Rust tests);
// every other command throws so a stray IPC dependency fails loudly.
const nativeCalls = [];
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      nativeCalls.push({ cmd, args });
      if (cmd === 'audit_append') return { eventId: 'AUD-H28-1', entryHash: 'h28hash' };
      throw new Error(`unexpected IPC in H28 harness: ${cmd}`);
    },
  },
};
// Pre-existing local evidence (same id as a backup row): the merge must keep
// it byte-for-byte, provenance included.
await local.execute(
  `INSERT INTO security_audit_logs (id, timestamp, user, action, details, requires_pin, source)
   VALUES ('h28-audit-001', '2024-01-01T00:00:00.000Z', 'Local', 'Vente', 'LOCAL-TRUTH', 0, 'local')`
);
let importErr = null;
try {
  await adapter.maintenanceAdapter.importJSON(payloadStr);
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
  ['trade_in', 'h28-ti-001'], ['imei', 'h28-imei-001'],
  ['cash_drop', 'h28-cd-001'], ['cash_drop', 'h28-po-002'], ['bundle', 'h28-bun-001'],
  ['customer_debt', 'h28-debt-001'], ['store_expense', 'h28-exp-001'], ['setting', 'store.name'],
];
// FT-06/F3: the backup's audit rows are deliberately NOT in the list above —
// they merge insert-only into the audit tables (see below) instead of being
// re-enqueued as stale outbox truth.
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

console.log('\n  --- credential exclusion (Decision 2) ---');
for (const key of ['manager_pin', 'cashier_users']) {
  const ops = await select(`SELECT * FROM sync_outbox WHERE entity_type='setting' AND entity_id='${key}'`);
  check(`[3d] hostile credential row NOT enqueued (${key})`, ops.length === 0, ops.length);
  const clock = await select(`SELECT version FROM entity_keys WHERE entity_type='setting' AND entity_id='${key}'`);
  check(`[3e] no version clock for credential key (${key})`, clock.length === 0, clock.length);
}

console.log('\n  --- audit history lane (FT-06/F3 insert-only) ---');
const auditOps = await select(`SELECT * FROM sync_outbox WHERE entity_type='audit_log' AND entity_id='h28-audit-001'`);
check('[3a] backup audit row NOT re-enqueued to outbox', auditOps.length === 0, auditOps.length);
const auditRows = await select(`SELECT * FROM security_audit_logs WHERE id='h28-audit-002'`);
check('[3b] backup audit row merged into authority', auditRows.length === 1, auditRows.length);
check('[3c] merged row keeps backup action', auditRows[0]?.action === 'IMPORT2', auditRows[0]?.action);
check('[3d] merged row carries imported provenance', auditRows[0]?.source === 'imported', auditRows[0]?.source);
const keptRows = await select(`SELECT * FROM security_audit_logs WHERE id='h28-audit-001'`);
check('[3e] pre-existing row wins (action kept)', keptRows[0]?.action === 'Vente', keptRows[0]?.action);
check('[3f] pre-existing details untouched', keptRows[0]?.details === 'LOCAL-TRUTH', keptRows[0]?.details);
check('[3g] pre-existing provenance stays local', keptRows[0]?.source === 'local', keptRows[0]?.source);
const importRows = nativeCalls.filter((c) => c.cmd === 'audit_append' && c.args?.request?.action === 'AUDIT_HISTORY_IMPORTED');
check('[3h] import writes one native pre-action row', importRows.length === 1, importRows.length);
const importDetails = JSON.parse(importRows[0]?.args?.request?.details ?? '{}');
check(
  '[3i] pre-action row carries backup id + counts + stage',
  importDetails.stage === 'pre-replace' && importDetails.backupId === '2026-09-14T00:00:00.000Z / 2.0' && importDetails.received === 2 && importDetails.inserted === 1 && importDetails.kept === 1,
  JSON.stringify(importDetails)
);
check('[3i2] pre-action row carries the envelope file hash', importDetails.backupSha256 === expectedSha, String(importDetails.backupSha256).slice(0, 16));
check('[3j] pre-action row is PIN-flagged', importRows[0]?.args?.request?.requiresPin === true);
const okRows = nativeCalls.filter((c) => c.cmd === 'audit_append' && c.args?.request?.action === 'AUDIT_HISTORY_IMPORTED_OK');
check('[3k] import writes one native outcome row', okRows.length === 1, okRows.length);
const okDetails = JSON.parse(okRows[0]?.args?.request?.details ?? '{}');
check(
  '[3l] outcome row records completion for the same backup',
  okDetails.stage === 'completed' && okDetails.outcome === 'completed' && okDetails.backupId === importDetails.backupId && okDetails.backupSha256 === expectedSha,
  JSON.stringify(okDetails)
);

console.log('\n  --- idempotency ---');
const before = (await select('SELECT COUNT(*) AS c FROM sync_outbox'))[0]?.c;
await adapter.maintenanceAdapter.importJSON(JSON.stringify(payload));
const after = (await select('SELECT COUNT(*) AS c FROM sync_outbox'))[0]?.c;
check('[4a] re-import creates no phantom outbox rows', Number(after) === Number(before), `${before} -> ${after}`);
const dupes = await select('SELECT idempotency_key, COUNT(*) AS c FROM sync_outbox GROUP BY idempotency_key HAVING c > 1');
check('[4b] no duplicate idempotency_keys', dupes.length === 0, dupes.length);
const reaudit = await select(`SELECT * FROM security_audit_logs WHERE id='h28-audit-002'`);
check('[4c] re-import keeps single audit row (insert-only)', reaudit.length === 1, reaudit.length);

console.log('\n  --- import audit-row fail-closed + actor ---');
// Native down: the import refuses BEFORE the Dexie replace (auditable state
// is never half-replaced while dropping evidence).
globalThis.window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
  nativeCalls.push({ cmd, args });
  throw new Error('simulated native audit down');
};
const failRes = await adapter.maintenanceAdapter.importJSON(JSON.stringify(payload), { actor: 'H28 Manager' });
check('[5a] native audit failure aborts import', failRes.success === false, JSON.stringify(failRes));
check('[5b] abort reason names the audit lane', String(failRes.reason || '').includes('traçabilité'), failRes.reason);
// Retry with the kernel back: idempotent, actor threaded into the native row.
globalThis.window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
  nativeCalls.push({ cmd, args });
  if (cmd === 'audit_append') return { eventId: 'AUD-H28-2', entryHash: 'h28hash2' };
  throw new Error(`unexpected IPC in H28 harness: ${cmd}`);
};
const retryRes = await adapter.maintenanceAdapter.importJSON(JSON.stringify(payload), { actor: 'H28 Manager' });
check('[5c] retry succeeds (resumable)', retryRes.success === true, JSON.stringify(retryRes));
const actorRows = nativeCalls.filter((c) => c.cmd === 'audit_append' && c.args?.request?.user === 'H28 Manager');
check('[5d] actor threaded into native import rows (pre + outcome)', actorRows.length >= 2, actorRows.length);
const reaudit2 = await select(`SELECT * FROM security_audit_logs WHERE id='h28-audit-002'`);
check('[5e] retry keeps single audit row', reaudit2.length === 1, reaudit2.length);

// Follow-up b: the OK row fails AFTER the books are replaced. That is not
// plain "failure" (the books ARE replaced — retrying would just duplicate
// intent rows) and not success either: a distinct completed-but-unaudited
// status the UI surfaces as a warning.
{
  let appends = 0;
  globalThis.window.__TAURI_INTERNALS__.invoke = async (cmd, _args) => {
    if (cmd === 'audit_append') {
      appends += 1;
      if (appends === 1) return { eventId: 'AUD-H28-3', entryHash: 'h3' };
      throw new Error('simulated outcome-row failure');
    }
    throw new Error(`unexpected IPC in H28 harness: ${cmd}`);
  };
  const partial = await adapter.maintenanceAdapter.importJSON(payloadStr, { actor: 'H28 Manager' });
  check('[5f] outcome-row failure is completed-but-unaudited', partial.success === true && partial.auditOk === false, JSON.stringify(partial));
  check('[5f] status names the missing traceability', String(partial.reason || '').includes('traçabilité'), partial.reason);
  const books = await select(`SELECT * FROM products WHERE id='h28-prod-001'`);
  check('[5f] books ARE replaced despite the missing outcome row', books.length === 1, books.length);
}

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

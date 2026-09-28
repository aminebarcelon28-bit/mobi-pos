// Sync-matrix conformance (ad.md §6 + "every future change syncs").
// Fails CI the moment a lane is added on one side but not wired end to end:
// producers (fireSync) -> GenericEntity -> push map -> remote tables ->
// pull routing -> apply/mirror -> UI refresh (refreshAfterPull/Targets).
//
// Plus functional: the store-profile (app_settings) pull mirror lands the
// SQLite authority row (store name / receipt template / VAT converge).
import { createClient } from '@libsql/client';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' :: ' + String(extra).slice(0, 250) : ''}`); }
}

const sqlPluginSrc = SRC('src/db/sqlPluginAdapter.ts');
const smSrc = SRC('src/sync/SyncManager.ts');
const gaSrc = SRC('src/sync/genericApply.ts');
const remoteSrc = SRC('src/sync/remoteSchema.ts');
const typesSrc = SRC('src/sync/types.ts');
const dexieSrc = SRC('src/db/database.ts');
const uiSrc = SRC('src/store/slices/createUISlice.ts');

// --- helpers: parse string-union / record keys from source ---
function parseUnion(src, typeName) {
  const m = src.match(new RegExp(`export type ${typeName} =([^;]+);`));
  if (!m) return [];
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}
function parseRecordKeys(src, constName) {
  const start = src.indexOf(`const ${constName}`);
  if (start === -1) return [];
  const seg = src.slice(start, start + 2500);
  return [...seg.matchAll(/^\s*([a-z_]+):/gm)].map((x) => x[1]);
}
function parseConstStringArray(src, constName) {
  const start = src.indexOf(`const ${constName}`);
  if (start === -1) return [];
  const end = src.indexOf('] as const', start);
  const seg = src.slice(start, end === -1 ? start + 1500 : end);
  return [...seg.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

console.log('\n[1] every fireSync producer is a registered entity');
{
  const producers = new Set();
  for (const f of ['src/db/adapters/operationsAdapter.ts', 'src/db/adapters/customerAdapter.ts',
    'src/db/adapters/voucherAdapter.ts', 'src/db/adapters/shiftAdapter.ts',
    'src/db/adapters/productAdapter.ts', 'src/store/slices/createCustomerSlice.ts']) {
    try {
      const s = SRC(f);
      for (const m of s.matchAll(/fireSync(Delete)?\('([a-z_]+)'/g)) producers.add(m[2]);
    } catch { /* file may move; matrix still guards the rest */ }
  }
  const generic = new Set(parseUnion(sqlPluginSrc, 'GenericEntity'));
  const core = new Set(['product', 'order', 'order_item', 'ledger', 'customer', 'imei']);
  for (const p of [...producers].sort()) {
    check(`producer '${p}' is a registered entity`, generic.has(p) || core.has(p), p);
  }
}

console.log('\n[2] every generic entity pushes, pulls, and has a remote table');
{
  const generic = parseUnion(sqlPluginSrc, 'GenericEntity');
  const pushMap = parseRecordKeys(gaSrc, 'GENERIC_TABLES');
  const applyMap = parseRecordKeys(gaSrc, 'GENERIC_TABLES');
  const remoteTables = parseConstStringArray(remoteSrc, 'GENERIC_SYNC_TABLES');
  const pullMap = parseRecordKeys(smSrc, 'GENERIC_PULL');
  for (const e of generic) {
    // stock_batches rides a dedicated push branch (real FIFO columns the KV
    // path cannot write) — assert the branch instead of the generic map.
    if (e === 'stock_batches') {
      check(`entity '${e}' has a dedicated push branch`, smSrc.includes("if (op.entity_type === 'stock_batches')"), e);
    } else {
      check(`entity '${e}' in push map`, pushMap.includes(e), pushMap.join(','));
    }
    const table = e === 'stock_batches' ? 'stock_batches'
      : e === 'stock_batch' ? 'stock_batches'
      : applyMap.includes(e) ? null : null;
    void table;
    check(`entity '${e}' in apply map`, applyMap.includes(e), e);
  }
  for (const t of remoteTables) {
    check(`remote table '${t}' pulled (generic map or dedicated branch)`,
      pullMap.includes(t) || ['products', 'transactions', 'transaction_items', 'inventory_ledger', 'stock_batches'].includes(t), t);
  }
}

console.log('\n[3] every Dexie store has pull coverage or is documented local-only');
{
  const stores = [...dexieSrc.matchAll(/^\s*([a-zA-Z]+)!: Table</gm)].map((x) => x[1]);
  const pullDexie = [...smSrc.matchAll(/(\w+):\s*\{\s*dexie:\s*'(\w+)'/g)].map((x) => x[2]);
  const dexieByTable = { products: 'products', transactions: 'transactions', customers: 'customers' };
  const LOCAL_ONLY = new Set(['inventoryLedger', 'syncOutbox', 'checkoutRecoveryIntents']); // web-fallback mirrors + crash-recovery intents, never cloud truth
  // payouts has no remote table by design: it multiplexes inside cash_drops
  // via the _isPayout flag (push splits on read, pull splits on write).
  const ALIASED = { payouts: 'cash_drops' };
  // saleBatchAllocations has no dedicated pull lane by design: the frozen
  // COGS mirror piggybacks inside transaction_items.json_payload
  // (fifo_allocations, embedded at checkout) and the pull path materializes
  // it via backfillSaleAllocationsFromItemsWithDb + Dexie mirror. Assert the
  // embed + materialize ends instead of the generic map.
  const PIGGYBACK = { saleBatchAllocations: 'transaction_items json_payload.fifo_allocations' };
  for (const s of stores) {
    if (ALIASED[s]) {
      check(`dexie store '${s}' multiplexed inside '${ALIASED[s]}' lane`,
        gaSrc.includes('_isPayout'), s);
      continue;
    }
    if (PIGGYBACK[s]) {
      check(`dexie store '${s}' piggybacks on '${PIGGYBACK[s]}'`,
        sqlPluginSrc.includes('fifo_allocations: fifoAllocations') &&
        smSrc.includes('backfillSaleAllocationsFromItemsWithDb'), s);
      continue;
    }
    const covered = pullDexie.includes(s) || Object.values(dexieByTable).includes(s) || LOCAL_ONLY.has(s);
    check(`dexie store '${s}' has pull coverage`, covered, s);
  }
}

console.log('\n[4] every outbox entity_type is in the outbox union');
{
  const produced = new Set();
  for (const m of sqlPluginSrc.matchAll(/VALUES \(\$1,'([a-z_]+)'/g)) produced.add(m[1]);
  const union = new Set(parseUnion(typesSrc, 'SyncEntityType'));
  for (const p of [...produced].sort()) {
    check(`outbox entity '${p}' in SyncEntityType`, union.has(p), p);
  }
}

console.log('\n[5] UI refresh covers every pulled lane (precision)');
{
  check('refreshAfterPull reloads receiptSettings (store name/template/VAT)',
    uiSrc.includes('receiptSettings') && /refreshAfterPull[\s\S]{0,2200}loadReceiptSettings\(\)/.test(uiSrc));
  check('refreshAfterPull reloads customers + debts (paid flags)',
    /refreshAfterPull[\s\S]{0,2200}getAllCustomers\(\)/.test(uiSrc) && /refreshAfterPull[\s\S]{0,2200}getAllCustomerDebts\(\)/.test(uiSrc));
  check('refresh rebases the selected customer (cart precision)',
    uiSrc.includes('currentCustomer') && /rebased?/i.test(uiSrc));
  check('unmapped pull tables fall back to full reload (never stale)',
    /hasUnmapped[\s\S]{0,300}refreshAfterPull\(\)/.test(uiSrc));
}

// --- functional: app_settings pull mirror lands SQLite authority ---
console.log('\n[6] store-profile pull lands the SQLite authority row');
{
  const SHIM = join(ROOT, 'tmp-matrix-shim');
  rmSync(SHIM, { recursive: true, force: true });
  mkdirSync(join(SHIM, 'db'), { recursive: true });
  mkdirSync(join(SHIM, 'lane'), { recursive: true });
  copyFileSync(join(ROOT, 'src', 'sync', 'genericApply.ts'), join(SHIM, 'lane', 'genericApply.ts'));
  {
    const p = join(SHIM, 'lane', 'genericApply.ts');
    let t = readFileSync(p, 'utf8');
    t = t.replace(/from '\.\.\/db\/database'/g, "from '../db/database.js'")
         .replace(/from '\.\.\/db\/sqlPluginAdapter'/g, "from '../db/sqlPluginAdapter.js'");
    writeFileSync(p, t);
  }
  writeFileSync(join(SHIM, 'db', 'database.js'), `
const noop = { put: async () => {}, delete: async () => {}, get: async () => undefined };
export const db = new Proxy({}, { get: () => noop });
`);
  writeFileSync(join(SHIM, 'db', 'sqlPluginAdapter.js'), `
export function sanitizeSyncPayload(p) { return p; }
export function utcNowIso() { return new Date().toISOString(); }
export function isDeviceLocalSettingKey() { return false; }
export const RECEIPT_SETTINGS_KEY = 'mobi_pos_receipt_settings';
export function isRetryableDbError() { return false; }
`);
  const { applyGenericRemoteRow } = await import(pathToFileURL(join(SHIM, 'lane', 'genericApply.ts')).href);
  for (const f of readdirSync(ROOT)) {
    if (f.startsWith('tmp-matrix-') && f.endsWith('.db')) rmSync(join(ROOT, f), { force: true });
  }
  const local = createClient({ url: `file:${join(ROOT, 'tmp-matrix-local.db')}` });
  const asPluginSql = (client) => ({
    select: async (sql, args = []) => (await client.execute({ sql, args })).rows ?? [],
    execute: async (sql, args = []) => client.execute({ sql, args }),
  });
  await local.execute(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1)`);
  await local.execute(`CREATE TABLE entity_keys (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (entity_type, entity_id))`);
  const profile = { key: 'mobi_pos_receipt_settings', value: { storeName: 'NOUVEAU NOM', vatRate: 19 } };
  await applyGenericRemoteRow(asPluginSql(local), 'app_settings', {
    id: 'mobi_pos_receipt_settings', data_json: JSON.stringify(profile), version: 3,
    updated_at: new Date().toISOString(), deleted: 0,
  }, { skipDexie: true });
  const got = (await local.execute({ sql: 'SELECT value_json, version FROM app_settings WHERE key = ?', args: ['mobi_pos_receipt_settings'] })).rows;
  check('SQLite authority row written', got.length === 1, got.length);
  const val = got.length ? JSON.parse(got[0].value_json) : {};
  check('store name converged precisely', val.storeName === 'NOUVEAU NOM', val.storeName);
  check('version carried', Number(got[0]?.version) === 3, got[0]?.version);
  // stale echo must not roll back the newer row
  await applyGenericRemoteRow(asPluginSql(local), 'app_settings', {
    id: 'mobi_pos_receipt_settings', data_json: JSON.stringify({ key: 'mobi_pos_receipt_settings', value: { storeName: 'VIEUX NOM' } }),
    version: 1, updated_at: '2020-01-01T00:00:00.000Z', deleted: 0,
  }, { skipDexie: true });
  const got2 = (await local.execute({ sql: 'SELECT value_json FROM app_settings WHERE key = ?', args: ['mobi_pos_receipt_settings'] })).rows;
  check('stale echo rejected (guard holds)', JSON.parse(got2[0].value_json).storeName === 'NOUVEAU NOM');
  await local.close();
  rmSync(SHIM, { recursive: true, force: true });
  for (const f of readdirSync(ROOT)) {
    if (f.startsWith('tmp-matrix-') && f.endsWith('.db')) { try { rmSync(join(ROOT, f), { force: true }); } catch { /* win handle */ } }
  }
}

// --- team lane + fail-closed PINs + compensation claims ---
console.log('\n[7] team lane converges (roster/PIN) and PINs are hashes only');
{
  const secSrc = SRC('src/utils/security.ts');
  check('no plaintext PIN fallback in verifyPin', !/Legacy plaintext fallback/.test(secSrc));
  check('verifyPin fails closed on non-v1 input', /return false;\s*\n\}/.test(secSrc));
  check('boot migrates stored plaintext PINs to hashes', /Plaintext-PIN migration/.test(uiSrc));
  check('pull refresh reloads the cashier roster', /cashier_users/.test(uiSrc) && /refreshAfterPull[\s\S]{0,3000}cashier_users/.test(uiSrc));
}

console.log('\n[8] online compensation claims (no physical double-payout)');
{
  const claimsSrc = SRC('src/sync/claims.ts');
  check('claims module exists with TTL advisory locks', /CLAIM_TTL_MIN/.test(claimsSrc));
  check('claim uses INSERT..ON CONFLICT DO NOTHING + rowsAffected',
    /ON CONFLICT\(id\) DO NOTHING/.test(claimsSrc) && /rowsAffected/.test(claimsSrc));
  check('offline degrades to offline-first (never blocks payout)',
    /reason: 'OFFLINE'/.test(claimsSrc));
  check('own-claim retry proceeds (no self-wedge)', /own claim — proceed/.test(claimsSrc));
  check('remote v8 creates refund_claims', /CREATE TABLE IF NOT EXISTS refund_claims/.test(remoteSrc));
  check('LATEST_REMOTE_VERSION covers v8', /LATEST_REMOTE_VERSION\s*=\s*([8-9]|[1-9][0-9])/.test(remoteSrc));
  check('refund claims before payout', /tryClaimCompensation\('REFUND'/.test(SRC('src/store/slices/createOrderSlice.ts')));
  check('void claims before restore', /tryClaimCompensation\('VOID'/.test(SRC('src/store/slices/createOrderSlice.ts')));
  check('refund UI explains peer in-progress', /REFUND_ALREADY_IN_PROGRESS/.test(SRC('src/components/modals/RefundModal.tsx')));
  check('void UI explains peer in-progress', /VOID_ALREADY_IN_PROGRESS/.test(SRC('src/components/modals/ReportsModal.tsx')));
}

// --- both-offline convergence: payout tags + duplicate detector ---
console.log('\n[9] both-offline double-payout converges LOUDLY (never silently)');
{
  const sliceSrc = SRC('src/store/slices/createOrderSlice.ts');
  const watchSrc = SRC('src/sync/payoutWatch.ts');
  check('refund audit entries carry a machine payout tag', /payoutTag\(`REF:\$\{refundTxnId\}`/.test(sliceSrc));
  check('void audit entries carry a machine payout tag', /payoutTag\(`VOID:\$\{transactionId\}`/.test(sliceSrc));
  check('detector flags same payout id from 2+ devices (cash only)',
    /g\.devices\.size >= 2/.test(watchSrc) && /Espèces/.test(watchSrc));
  check('detector ignores non-cash methods', /never flagged|Non-cash methods/.test(watchSrc));
  check('exception entries are deterministic (converge, not duplicate)',
    /AUDIT-DUP-/.test(watchSrc));
  check('exception entries excluded from detection (no self-trigger)',
    /DUPLICATE_PAYOUT_ACTION/.test(watchSrc));
  check('local payout runs the check after commit', /checkDuplicatePayouts\(\)/.test(sliceSrc));
  check('pull runs the check with merchant toast', /checkDuplicatePayouts/.test(SRC('src/App.tsx')));

// --- debt display converges from the ledger, never from a raced row ---
console.log('\n[10] paid-on-PC reads paid on mobile (debt derived from ledger)');
{
  const sliceSrc = SRC('src/store/slices/createOrderSlice.ts');
  const paySrc = SRC('src/store/slices/createCustomerSlice.ts');
  check('pull reconciles debt display after customer_debts land',
    /touchedTables\.has\('customer_debts'\)[\s\S]{0,400}reconcileCustomerDebtFromLedger\(\)/.test(smSrc));
  check('debt payment re-derives display after commit',
    /reconcileCustomerDebtFromLedger\(\[customerId\]\)/.test(paySrc));
  check('credit sale + void re-derive display after commit',
    /reconcileCustomerDebtFromLedger\(\[updatedCustomer\.id\]\)/.test(sliceSrc));
}

  // Functional: the pure detector on a both-offline scenario.
  const { findDuplicatePayouts, parsePayoutTag, payoutTag } = await import(
    '../src/sync/payoutWatch.ts'
  );
  const tagA = payoutTag('REF:TXN-1-AB12', 'Espèces', 200, 'device-A');
  const tagB = payoutTag('REF:TXN-1-AB12', 'Espèces', 200, 'device-B');
  check('tag round-trips through the parser', parsePayoutTag(tagA)?.payoutId === 'REF:TXN-1-AB12', tagA);
  const dups = findDuplicatePayouts([
    { id: 'a1', action: 'Remboursement / Avoir Émis', details: `Avoir #X ${tagA}` },
    { id: 'b1', action: 'Remboursement / Avoir Émis', details: `Avoir #Y ${tagB}` },
  ]);
  check('two offline cash payouts for one ticket FLAG', dups.length === 1 && dups[0].devices.length === 2, JSON.stringify(dups));
  const dupsVoucher = findDuplicatePayouts([
    { id: 'a1', action: 'x', details: payoutTag('REF:T-1', 'Avoir Client', 200, 'device-A') },
    { id: 'b1', action: 'x', details: payoutTag('REF:T-1', 'Avoir Client', 200, 'device-B') },
  ]);
  check('non-cash duplicates never flag', dupsVoucher.length === 0);
  const dupsSingle = findDuplicatePayouts([
    { id: 'a1', action: 'x', details: tagA },
  ]);
  check('single-device payout never flags', dupsSingle.length === 0);
}

// --- pair-and-go companion + manager-PIN-as-manager ---
console.log('\n[11] companion pairs straight in; manager PIN opens a manager session');
{
  const lockSrc = SRC('src/components/LockScreenOverlay.tsx');
  const platSrc = SRC('src/utils/platform.ts');
  const pairSrc = SRC('src/components/mobile/MobilePairingWizard.tsx');
  const uiSliceSrc = SRC('src/store/slices/createUISlice.ts');
  check('trusted companion skips the PIN wall (explicit lock still honored)',
    /companion_mobile/.test(lockSrc) && /isCompanionTrusted\(\)/.test(lockSrc) && /sessionLockRequested/.test(lockSrc));
  check('trust flag is per-device local-only (never synced)',
    /mobi_pos_companion_trusted/.test(platSrc) && /never synced/i.test(platSrc));
  check('pairing marks the companion trusted after full sync',
    /markCompanionTrusted\(\)/.test(pairSrc));
  check('explicit lock always engages (even when trusted)',
    /sessionLockRequested: true/.test(uiSliceSrc));
  check('manager PIN resolves to the admin user, not the selected one',
    /role === 'admin'/.test(lockSrc) && /MANAGER session/.test(lockSrc));
  check('no plaintext PIN comparison remains in unlock paths',
    !/=== clean/.test(lockSrc) && !/clean ===/.test(uiSliceSrc));
}

// --- full repair sync: missing data converges on demand ---
console.log('\n[12] full repair synchronization (données manquantes)');
{
  const repairSrc = SRC('src/sync/repairResync.ts');
  check('repair refuses without cloud credentials', /Aucun compte cloud configuré/.test(repairSrc));
  check('repair refuses when cloud unreachable (local sales untouched)',
    /Cloud injoignable/.test(repairSrc));
  check('re-enqueue reuses ORIGINAL stable keys (reruns are no-ops)',
    /ORIGINAL stable/.test(repairSrc) && /ON CONFLICT\(idempotency_key\) DO UPDATE/.test(repairSrc));
  check('re-enqueue covers orders/items/ledger/batches/customers/debts/vouchers/settings',
    /'order'/.test(repairSrc) && /'ledger'/.test(repairSrc) && /'stock_batches'/.test(repairSrc)
    && /'customer_debt'/.test(repairSrc) && /'credit_voucher'/.test(repairSrc) && /'setting'/.test(repairSrc));
  check('pull cursors reset to epoch before re-read', /DELETE FROM app_settings WHERE key LIKE 'sync\.cursor\.%/.test(repairSrc));
  check('push/pull loops are bounded', /round < 25/.test(repairSrc) && /round < 100/.test(repairSrc));
  check('repair ends with integrity verify + cloud identity in report',
    /verifyCloudIntegrity\(\)/.test(repairSrc) && /cloudHost/.test(repairSrc));
  check('desktop exposes full repair', /handleFullResync/.test(SRC('src/components/settings/CloudSyncPanel.tsx')));
  check('mobile exposes full repair', /handleFullResync/.test(SRC('src/components/mobile/tabs/SyncDiagnosticsTab.tsx')));
}

console.log(failures === 0 ? '\nMATRIX: ALL PASS' : `\nMATRIX: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

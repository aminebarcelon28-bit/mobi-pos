// Cross-device safety: deterministic compensation ids + integer money + device
// revocation (ad.md §§7/8/10/15). Run: node --experimental-strip-types scripts/test_cross_device_safety.mjs
import { createClient } from '@libsql/client';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deterministicId } from '../src/utils/ids.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' :: ' + JSON.stringify(extra).slice(0, 200) : ''}`); }
}

const orderSrc = readFileSync(join(ROOT, 'src', 'store', 'slices', 'createOrderSlice.ts'), 'utf8');
const custSrc = readFileSync(join(ROOT, 'src', 'store', 'slices', 'createCustomerSlice.ts'), 'utf8');
const dbSrc = readFileSync(join(ROOT, 'src', 'db', 'sqlPluginAdapter.ts'), 'utf8');
const smSrc = readFileSync(join(ROOT, 'src', 'sync', 'SyncManager.ts'), 'utf8');
const relaySrc = readFileSync(join(ROOT, 'workers', 'relay', 'src', 'index.ts'), 'utf8');

console.log('\n[1] deterministicId: same op -> same id, different op -> different id');
{
  const a = deterministicId('REF', 'TXN-1', 'p1:2:100:1', 'Espèces', 200);
  const b = deterministicId('REF', 'TXN-1', 'p1:2:100:1', 'Espèces', 200);
  const c = deterministicId('REF', 'TXN-1', 'p1:1:100:1', 'Espèces', 100);
  check('same inputs converge to one id', a === b, { a, b });
  check('different items diverge ids', a !== c, { a, c });
  check('shape PREFIX-8HEX', /^REF-[0-9A-F]{8}$/.test(a), a);
}

console.log('\n[2] refund/void compensation uses deterministic identity');
check('refund txn id is deterministic', /deterministicId\('REF',\s*originalTransaction\.id/.test(orderSrc));
check('refund items canonically ordered', /canonicalRefundItems/.test(orderSrc));
check('refund ledger deltas carry deterministic ids', /deterministicId\('LED-REF'/.test(orderSrc));
check('void ledger deltas carry deterministic ids', /deterministicId\('LED-VOID'/.test(orderSrc));
check('void debt reversal id is deterministic', /deterministicId\('DEBT-VOID'/.test(orderSrc));
check('refund debt relief accepts a deterministic entryId', /entryId:\s*deterministicId\('PAYREL'/.test(orderSrc));
check('recordCustomerDebtPayment honors opts.entryId', /opts\?\.entryId \|\| newId\('DEBT'\)/.test(custSrc));
check('over-refund guard unions Dexie peer refunds', /dexieDb\.transactions/.test(orderSrc) && /seenRefundIds/.test(orderSrc));

console.log('\n[3] identical compensation converges (no double count)');
{
  const f = 'tmp-xdev-ledger.db';
  try { rmSync(join(ROOT, f), { force: true }); } catch { /* ignore */ }
  const c = createClient({ url: `file:${join(ROOT, f)}` });
  await c.execute(`CREATE TABLE inventory_ledger (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, delta INTEGER NOT NULL,
    reason TEXT NOT NULL, ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
    sync_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`);
  const now = new Date().toISOString();
  // Two devices refund the same items of the same ticket -> same deterministic ids.
  const refundTxn = deterministicId('REF', 'TXN-1', 'p1:2:100:1', 'Espèces', 200);
  const ledId = deterministicId('LED-REF', refundTxn, 'p1', 2);
  const seed = async () => {
    await c.execute({ sql: `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, created_at, updated_at, deleted)
      VALUES (?,?,?,?,?,?,?,?,'pending',?,?,0) ON CONFLICT(id) DO NOTHING`,
      args: [ledId, 'p1', 2, 'REFUND', 'order', refundTxn, 'device-X', ledId, now, now] });
  };
  await seed(); // device A
  await seed(); // device B (same logical refund)
  const rows = (await c.execute('SELECT COUNT(*) AS n, COALESCE(SUM(delta),0) AS s FROM inventory_ledger')).rows;
  check('one ledger row, not two', Number(rows[0].n) === 1, rows[0]);
  check('stock compensated exactly once (+2)', Number(rows[0].s) === 2, rows[0]);
  await c.close();
  try { rmSync(join(ROOT, f), { force: true }); } catch { /* ignore */ }
}

console.log('\n[4] money persists as integer DA at the durable boundary');
check('writeCheckoutAtomic normalizes money input', /normalizeMoneyInput\(input\)/.test(dbSrc));
check('order money keys rounded', /ORDER_MONEY_KEYS/.test(dbSrc) && /'cash_tendered'/.test(dbSrc));
check('item money keys rounded', /ITEM_MONEY_KEYS/.test(dbSrc) && /'line_profit'/.test(dbSrc) && /'lineProfit'/.test(dbSrc));
check('profit_margin untouched (ratio, not money)', !/ORDER_MONEY_KEYS[^;]*profit_margin/.test(dbSrc));

console.log('\n[5] device registry + revocation (relay + client)');
check('worker handles hello registration', /msg\.type === 'hello'/.test(relaySrc));
check('worker replies welcome', /type: 'welcome'/.test(relaySrc));
check('worker drops revoked sockets', /closeSession\(server\)/.test(relaySrc));
check('worker serves device list', /\/__devices/.test(relaySrc));
check('worker serves revoke endpoint', /\/__revoke/.test(relaySrc));
check('worker notifies peers of revocation', /type: 'device-revoked'/.test(relaySrc));
check('client sends hello on relay open', /type: 'hello'/.test(smSrc));
check('client enforces revocation (suspends push)', /if \(this\.deviceRevoked\) return;/.test(smSrc));
check('client enforces revocation (suspends pull)', /if \(this\.deviceRevoked\) return 0;/.test(smSrc));
check('revocation persisted across restarts', /sync\.device_revoked/.test(smSrc));
check('merchant device list API', /listMerchantDevices\(\)/.test(smSrc));
check('revoke/re-admit API', /setDeviceRevoked\(deviceId/.test(smSrc));
check('status exposes deviceRevoked', /deviceRevoked\?: boolean/.test(readFileSync(join(ROOT, 'src', 'sync', 'types.ts'), 'utf8')));

console.log(failures === 0 ? '\nXDEV: ALL PASS' : `\nXDEV: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

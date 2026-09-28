/**
 * F2 regression: cash close must certify from the SQLite authority, never the
 * Dexie projection (a write decision reading a read model).
 *
 * Executes the REAL shiftAdapter.closeShift (transpiled, imports shimmed)
 * against a REAL SQLite transactions table (@libsql/client file DB):
 *  - authority numbers win (expectedCash/revenue/count/profit);
 *  - Dexie ghosts (void-as-COMPLETED echo, phantom sale) are ignored;
 *  - tombstones (deleted=1) and other-device rows excluded;
 *  - device-less rows included + tallied (F3, rule unchanged);
 *  - corrupt JSON falls back to columns; corrupt money reads 0, never NaN;
 *  - blind-count/note/PIN gates preserved;
 *  - web-preview fallback (isTauriEnv=false) reads Dexie identically.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-shift-close-authority.db';
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// ---------- tiny in-memory Dexie stand-in ----------
function makeTable(keyFn) {
  const rows = new Map();
  const api = {
    rows,
    async get(k) { return rows.get(String(k)); },
    async put(o) { rows.set(String(keyFn(o)), structuredClone(o)); },
    where(field) {
      const match = (v) => [...rows.values()].filter((r) => r[field] === v);
      const ge = (v) => [...rows.values()].filter((r) => (r[field] ?? '') >= v);
      return {
        equals: (v) => ({ first: async () => match(v)[0], toArray: async () => match(v) }),
        aboveOrEqual: (v) => ({ toArray: async () => ge(v) }),
      };
    },
    orderBy() { return { reverse: () => ({ toArray: async () => [] }) }; },
  };
  return api;
}

let TAURI = true;
const MUI = { calls: [] };
const dexieDb = {
  cashSessions: makeTable((o) => o.id),
  cashMovements: makeTable((o) => o.id),
  transactions: makeTable((o) => o.id),
  appSettings: {
    async get(k) {
      if (String(k) === 'manager_pin') return { key: k, value: '9999' };
      return undefined;
    },
  },
};

async function loadShiftAdapter(sqliteDb) {
  const ts = await import('typescript');
  const fs = await import('node:fs');
  const ROOT = process.cwd();
  const toUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  const tr = (p) => ts.transpileModule(fs.readFileSync(p, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }, fileName: p,
  }).outputText;
  const shims = {
    database: toUrl(`export const db = globalThis.__dexieFake; export const dexieDb = globalThis.__dexieFake;`),
    base: toUrl(`export const isTauriEnv = () => globalThis.__tauriFlag;
      export const fireSync = async (...a) => { globalThis.__fireCalls.push(a); };
      export const fireSyncDelete = async (...a) => { globalThis.__fireCalls.push(a); };`),
    ids: toUrl(`let n = 0; export function newId(p) { n += 1; return p + '-test-' + n; }`),
    security: toUrl(`export function verifyPin(pin, stored) { return String(pin) === String(stored); }`),
    sqlPluginAdapter: toUrl(`export async function getLocalDb() { return globalThis.__sqliteFake; }`),
    busyRetry: toUrl(`export async function withBusyRetry(fn) { return fn(); }
      export function isBusyError() { return false; }`),
  };
  globalThis.__dexieFake = dexieDb;
  globalThis.__tauriFlag = TAURI;
  globalThis.__fireCalls = MUI.calls;
  globalThis.__sqliteFake = {
    select: async (sql, args) => {
      // $1-style (tauri) and ?-style both funnel here; libsql speaks ? — the
      // production query uses $1, so translate positionally.
      const q = String(sql).replace(/\$\d+/g, '?');
      const rs = await sqliteDb.execute(q, args ?? []);
      return rs.rows.map((r) => ({ ...r }));
    },
    execute: async (sql, args) => {
      const q = String(sql).replace(/\$\d+/g, '?');
      return sqliteDb.execute({ sql: q, args: args ?? [] });
    },
  };
  let src = fs.readFileSync(`${ROOT}/src/db/adapters/shiftAdapter.ts`, 'utf8');
  src = src.replace(/from\s+(['"])\.\.\/database\1/g, `from '${shims.database}'`);
  src = src.replace(/from\s+(['"])\.\/base\1/g, `from '${shims.base}'`);
  src = src.replace(/from\s+(['"])\.\.\/\.\.\/utils\/ids\1/g, `from '${shims.ids}'`);
  src = src.replace(/from\s+(['"])\.\.\/\.\.\/utils\/security\1/g, `from '${shims.security}'`);
  // cashTerms is dependency-free (pure predicates) — transpile the real
  // module so the test executes production cash math, not a copy.
  const cashTermsUrl = toUrl(tr(`${ROOT}/src/utils/cashTerms.ts`));
  src = src.replace(/from\s+(['"])\.\.\/\.\.\/utils\/cashTerms\1/g, `from '${cashTermsUrl}'`);
  src = src.split(`await import('../sqlPluginAdapter')`).join(`await import('${shims.sqlPluginAdapter}')`);
  src = src.split(`await import('../busyRetry')`).join(`await import('${shims.busyRetry}')`);
  const mod = await import(toUrl(ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }, fileName: 'shiftAdapter.ts',
  }).outputText));
  return mod.shiftAdapter;
}

function txRow({ id, total, profit = 0, method = 'Espèces', status = 'COMPLETED', createdAt, payload = {}, device = null, deleted = 0 }) {
  return {
    sql: `INSERT INTO transactions (id, receipt_number, total, profit, payment_method, status, created_at, json_payload, device_id, deleted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, `REC-${id}`, total, profit, method, status, createdAt, JSON.stringify(payload), device, deleted],
  };
}

async function main() {
  try { rmSync(DB_FILE); } catch {}
  try { rmSync(`${DB_FILE}-wal`); } catch {}
  const db = createClient({ url: `file:${DB_FILE}` });
  await db.execute(`CREATE TABLE transactions (
    id TEXT PRIMARY KEY, receipt_number TEXT, total REAL, profit REAL,
    payment_method TEXT, status TEXT, created_at TEXT, json_payload TEXT,
    device_id TEXT, deleted INTEGER DEFAULT 0)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS cash_sessions (
    id TEXT PRIMARY KEY, opened_at TEXT NOT NULL, closed_at TEXT,
    opening_float INTEGER NOT NULL, expected_cash INTEGER, actual_cash INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN', cashier_name TEXT,
    opening_note TEXT, closing_note TEXT, discrepancy INTEGER,
    json_payload TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS cash_movements (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    amount INTEGER NOT NULL, reason TEXT NOT NULL, cashier_name TEXT,
    created_at TEXT NOT NULL, json_payload TEXT NOT NULL)`);

  const T0 = '2026-09-26T06:00:00.000Z';
  const T = (h) => `2026-09-26T${String(h).padStart(2, '0')}:00:00.000Z`;
  const P = (over) => ({ status: 'COMPLETED', ...over });
  const rows = [
    // T1: plain cash 10000 (profit 2000).
    txRow({ id: 'T1', total: 10000, profit: 2000, createdAt: T(7), payload: P({ id: 'T1', total: 10000, profit: 2000, paymentMethod: 'Espèces', tenders: [{ method: 'Espèces', amount: 10000 }] }) }),
    // T2: split Espèces 14000 + crédit 10000, total 24000 (profit 5000).
    txRow({ id: 'T2', total: 24000, profit: 5000, createdAt: T(8), payload: P({ id: 'T2', total: 24000, profit: 5000, paymentMethod: 'Mixte', tenders: [{ method: 'Espèces', amount: 14000 }, { method: 'Crédit Client', amount: 10000 }] }) }),
    // T3: VOIDED cash 5000 — excluded everywhere.
    txRow({ id: 'T3', total: 5000, profit: 1000, status: 'VOIDED', createdAt: T(9), payload: P({ id: 'T3', total: 5000, status: 'VOIDED', paymentMethod: 'Espèces' }) }),
    // T4: refund voucher cash 1500 — cashRefunds, not sales.
    txRow({ id: 'T4', total: 1500, profit: 0, createdAt: T(10), payload: P({ id: 'T4', total: 1500, isRefund: true, paymentMethod: 'Espèces' }) }),
    // T5: other terminal's cash 7000 — excluded when bound.
    txRow({ id: 'T5', total: 7000, profit: 1000, createdAt: T(11), device: 'mobile-x', payload: P({ id: 'T5', total: 7000, paymentMethod: 'Espèces', deviceId: 'mobile-x' }) }),
    // T6: tombstone, cash 9000 — excluded.
    txRow({ id: 'T6', total: 9000, profit: 0, createdAt: T(12), deleted: 1, payload: P({ id: 'T6', total: 9000, paymentMethod: 'Espèces' }) }),
    // T7: legacy row, NO device anywhere, cash 1000 — included + tallied.
    txRow({ id: 'T7', total: 1000, profit: 100, createdAt: T(13), payload: { id: 'T7', total: 1000, profit: 100, paymentMethod: 'Espèces', status: 'COMPLETED' } }),
    // T8: corrupt JSON, columns carry 2000 cash — column fallback.
    { sql: `INSERT INTO transactions (id, receipt_number, total, profit, payment_method, status, created_at, json_payload, device_id, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['T8', 'REC-T8', 2000, 0, 'Espèces', 'COMPLETED', T(14), '{bad json', null, 0] },
    // T9: columns lie (99999), payload tells 3000 — payload wins.
    txRow({ id: 'T9', total: 99999, profit: 300, createdAt: T(15), payload: P({ id: 'T9', total: 3000, profit: 300, paymentMethod: 'Espèces' }) }),
  ];
  for (const r of rows) await db.execute(r);

  // Dexie mirror: session + movements + GHOSTS (void-as-COMPLETED T3 echo, phantom sale).
  await dexieDb.cashSessions.put({ id: 'S1', status: 'OPEN', openingFloat: 20000, openedAt: T0, cashierName: 'Amine', deviceId: 'desk-1', movements: [] });
  await dexieDb.cashMovements.put({ id: 'M1', sessionId: 'S1', type: 'MANUAL_DEPOSIT', amount: 5000, reason: 'dépôt', cashierName: 'Amine', createdAt: T(7) });
  await dexieDb.cashMovements.put({ id: 'M2', sessionId: 'S1', type: 'EXPENSE', amount: 3500, reason: 'dépense', cashierName: 'Amine', createdAt: T(8) });
  await dexieDb.transactions.put({ id: 'T3', total: 5000, profit: 1000, paymentMethod: 'Espèces', status: 'COMPLETED', createdAt: T(9), deviceId: 'desk-1' });
  await dexieDb.transactions.put({ id: 'GHOST', total: 99999, profit: 0, paymentMethod: 'Espèces', status: 'COMPLETED', createdAt: T(10), deviceId: 'desk-1' });

  TAURI = true;
  const shiftAdapter = await loadShiftAdapter(db);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); };

  // Hand-computed: cashSales = 10000+14000+1000+2000+3000 = 30000;
  // expected = 20000 + 30000 + 5000 − 3500 − 1500 = 50000.
  // revenue = 10000+24000+1000+2000+3000 = 40000; count 5; profit 2000+5000+100+0+300 = 7400.
  const closed = await shiftAdapter.closeShift(50000, '', 'Amine', 'S1');
  console.warn = origWarn;
  check('authority close: expectedCash 50000 (ghosts ignored)', closed.expectedCash === 50000, `got ${closed.expectedCash}`);
  check('authority close: revenue 40000', closed.totalSalesRevenue === 40000, `got ${closed.totalSalesRevenue}`);
  check('authority close: count 5', closed.totalSalesCount === 5, `got ${closed.totalSalesCount}`);
  check('authority close: profit 7400', closed.totalProfits === 7400, `got ${closed.totalProfits}`);
  check('authority close: discrepancy 0', closed.discrepancy === 0, `got ${closed.discrepancy}`);
  check('authority close: status CLOSED', closed.status === 'CLOSED', closed.status);
  // Exact tally (single pass): T1+T2+T4+T7+T8+T9 device-less = 6 rows, 41500 DA.
  const tallyMsg = warnings.find((w) => w.includes('sans deviceId')) || '';
  check('F3 tally counts device-less rows once (6, 41500 DA)',
    tallyMsg.includes('6 transaction(s)') && tallyMsg.includes('(41500 DA'), tallyMsg.slice(0, 120));
  check('Dexie ghosts never persisted into close', closed.totalSalesRevenue !== 40000 + 5000 + 99999, `got ${closed.totalSalesRevenue}`);

  // Gates preserved: reopen and close off-balance without note.
  // Fresh sessions carry their own movements (movements are per-session).
  await dexieDb.cashSessions.put({ id: 'S2', status: 'OPEN', openingFloat: 20000, openedAt: T0, cashierName: 'Amine', deviceId: 'desk-1', movements: [] });
  await dexieDb.cashMovements.put({ id: 'M1-S2', sessionId: 'S2', type: 'MANUAL_DEPOSIT', amount: 5000, reason: 'dépôt', cashierName: 'Amine', createdAt: T(7) });
  await dexieDb.cashMovements.put({ id: 'M2-S2', sessionId: 'S2', type: 'EXPENSE', amount: 3500, reason: 'dépense', cashierName: 'Amine', createdAt: T(8) });
  let gateErr = null;
  try { await shiftAdapter.closeShift(43000, '', 'Amine', 'S2'); }
  catch (e) { gateErr = e; }
  check('blind gate: note required on variance', gateErr && gateErr.code === 'CLOSING_NOTE_REQUIRED', gateErr?.code ?? 'no-throw');
  const noted = await shiftAdapter.closeShift(49500, 'écart justifié', 'Amine', 'S2');
  check('noted close: discrepancy -500, no PIN under threshold', noted.discrepancy === -500, `got ${noted.discrepancy}`);
  await dexieDb.cashSessions.put({ id: 'S3', status: 'OPEN', openingFloat: 20000, openedAt: T0, cashierName: 'Amine', deviceId: 'desk-1', movements: [] });
  await dexieDb.cashMovements.put({ id: 'M1-S3', sessionId: 'S3', type: 'MANUAL_DEPOSIT', amount: 5000, reason: 'dépôt', cashierName: 'Amine', createdAt: T(7) });
  await dexieDb.cashMovements.put({ id: 'M2-S3', sessionId: 'S3', type: 'EXPENSE', amount: 3500, reason: 'dépense', cashierName: 'Amine', createdAt: T(8) });
  let pinErr = null;
  try { await shiftAdapter.closeShift(40000, 'gros écart', 'Amine', 'S3'); }
  catch (e) { pinErr = e; }
  check('variance gate: PIN required at >= 1000', pinErr && pinErr.code === 'MANAGER_PIN_REQUIRED', pinErr?.code ?? 'no-throw');
  let badPin = null;
  try { await shiftAdapter.closeShift(40000, 'gros écart', 'Amine', 'S3', '0000'); }
  catch (e) { badPin = e; }
  check('variance gate: wrong PIN rejected', badPin && badPin.code === 'MANAGER_PIN_INVALID', badPin?.code ?? 'no-throw');
  const pinnned = await shiftAdapter.closeShift(40000, 'gros écart', 'Amine', 'S3', '9999');
  check('variance gate: manager PIN closes (|disc| 10000)', pinnned.discrepancy === -10000, `got ${pinnned.discrepancy}`);

  // Web fallback parity: same books via Dexie give same numbers.
  // (The loaded module reads globalThis.__tauriFlag live — no re-import.)
  globalThis.__tauriFlag = false;
  dexieDb.transactions.rows.clear();
  for (const [id, total, profit, extra = {}] of [
    ['T1', 10000, 2000, { paymentMethod: 'Espèces', tenders: [{ method: 'Espèces', amount: 10000 }] }],
    ['T2', 24000, 5000, { paymentMethod: 'Mixte', tenders: [{ method: 'Espèces', amount: 14000 }, { method: 'Crédit Client', amount: 10000 }] }],
    ['T3', 5000, 1000, { paymentMethod: 'Espèces', status: 'VOIDED' }],
    ['T4', 1500, 0, { paymentMethod: 'Espèces', isRefund: true }],
    ['T5', 7000, 1000, { paymentMethod: 'Espèces', deviceId: 'mobile-x' }],
    ['T7', 1000, 100, { paymentMethod: 'Espèces' }],
    ['T8', 2000, 0, { paymentMethod: 'Espèces' }],
    ['T9', 3000, 300, { paymentMethod: 'Espèces' }],
  ]) {
    await dexieDb.transactions.put({ id, total, profit, status: 'COMPLETED', createdAt: T(7), deviceId: 'desk-1', changeDue: 0, ...extra });
  }
  await dexieDb.cashSessions.put({ id: 'S4', status: 'OPEN', openingFloat: 20000, openedAt: T0, cashierName: 'Amine', deviceId: 'desk-1', movements: [] });
  await dexieDb.cashMovements.put({ id: 'M1-S4', sessionId: 'S4', type: 'MANUAL_DEPOSIT', amount: 5000, reason: 'dépôt', cashierName: 'Amine', createdAt: T(7) });
  await dexieDb.cashMovements.put({ id: 'M2-S4', sessionId: 'S4', type: 'EXPENSE', amount: 3500, reason: 'dépense', cashierName: 'Amine', createdAt: T(8) });
  // NOTE: T6 tombstone has no Dexie row (deletes evict) — parity holds trivially.
  const webClosed = await shiftAdapter.closeShift(50000, '', 'Amine', 'S4');
  check('web fallback: same expectedCash 50000', webClosed.expectedCash === 50000, `got ${webClosed.expectedCash}`);

  console.log('====================================================');
  console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
  console.log('====================================================');
  await db.close();
  try { rmSync(DB_FILE); } catch {}
  try { rmSync(`${DB_FILE}-wal`); } catch {}
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

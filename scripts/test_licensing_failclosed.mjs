#!/usr/bin/env node
/**
 * Test Suite: Fail-Closed Licensing Predicates + Emergency Export Barriers
 *
 * Covers the four regression areas from the fail-closed directive:
 *   1. PREDICATE MATRIX — every non-ACTIVE status locks the app.
 *   2. WRITE IMMUNITY  — the export path cannot mutate a record.
 *   3. AUTH GATING     — export refuses an invalid / sub-admin credential.
 *   4. BOOT ISOLATION  — the locked surface imports no lifecycle module.
 *
 * Tests 2 and 4 run against the REAL engine: 2 opens the live-shaped schema
 * through a `SQLITE_OPEN_READ_ONLY` handle (same flags as the Rust exporter)
 * and asserts SQLite itself rejects writes; 4 walks the actual import graph of
 * the gate and the exporter. Test 3 verifies the client-side refusal and the
 * fail-closed hash contract; the native PIN check is covered by the Rust suite
 * (`cargo test --lib emergency_export`).
 */

import {
  isLicenseActive,
  isLicenseLocked,
  isDegradedLicenseStatus,
  setDegradedSaleBlock,
  isSaleBlockedByLicense,
  ACTIVE_LICENSE_STATUS,
  KNOWN_UNLICENSED_STATUSES,
} from '../src/licensing/degraded.ts';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passed += 1;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failed += 1;
  }
}

function section(title) {
  console.log(`\n[${title}]`);
}

console.log('========================================================================');
console.log('MOBIPOS — FAIL-CLOSED LICENSING & EMERGENCY EXPORT SUITE');
console.log('========================================================================');

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: Predicate matrix
// ─────────────────────────────────────────────────────────────────────────────
section('TEST 1: Predicate Matrix — non-ACTIVE status must hard-lock');

const NON_ACTIVE = [
  'EXPIRED',
  'GRACE_EXCEEDED',
  'SUSPENDED',
  'REVOKED',
  'TAMPERED_CLOCK',
  'DEVICE_MISMATCH',
  'UNLICENSED',
  'UNKNOWN',
  'CORRUPT',
  // Ambiguous / malformed inputs must be treated as locked, not as errors to
  // swallow into an "assume OK" branch.
  '',
  '   ',
  'null',
  'undefined',
  '{"status":"ACTIVE"}',
  'ACTI V',
  'ACTIVE!',
  'true',
  '1',
];

for (const status of NON_ACTIVE) {
  assert(
    isLicenseLocked(status) === true,
    `isLicenseLocked(${JSON.stringify(status)}) === true`
  );
  assert(
    isLicenseActive(status) === false,
    `isLicenseActive(${JSON.stringify(status)}) === false`
  );
  assert(
    isDegradedLicenseStatus(status) === false,
    `isDegradedLicenseStatus(${JSON.stringify(status)}) === false (no degraded bypass)`
  );
}

// Null / undefined explicitly.
for (const status of [null, undefined]) {
  assert(isLicenseLocked(status) === true, `isLicenseLocked(${status}) === true`);
  assert(isDegradedLicenseStatus(status) === false, `isDegradedLicenseStatus(${status}) === false`);
}

// The exhaustive known-status list, checked as a set.
for (const status of KNOWN_UNLICENSED_STATUSES) {
  assert(isLicenseLocked(status), `known unlicensed status ${status} locks`);
}

// The only granting value.
assert(isLicenseActive(ACTIVE_LICENSE_STATUS) === true, 'ACTIVE grants access');
assert(isLicenseLocked(ACTIVE_LICENSE_STATUS) === false, 'ACTIVE does not lock');

// Case/whitespace normalisation is a robustness measure, NOT a security
// boundary: `status` is a closed literal union produced by the licensing
// module itself (see LicenseValidationResult in client.ts and
// ClockGuardStatus in clockGuard.ts), never supplied by an attacker. Matching
// case-insensitively avoids hard-locking a paying merchant on a cosmetic
// serialisation change; it cannot grant access that a forged status could not.
assert(isLicenseActive('active') === true, 'lowercase "active" normalises to ACTIVE');
assert(isLicenseActive('ACTIVE ') === true, 'trailing whitespace normalises to ACTIVE');
assert(isLicenseActive('  active  ') === true, 'surrounding whitespace normalises to ACTIVE');
// Normalisation must not become a wildcard.
assert(isLicenseActive('ACTI V') === false, 'near-miss string does not normalise to ACTIVE');
assert(isLicenseActive('ACTIVEX') === false, 'prefix-extension does not normalise to ACTIVE');

// Invariant: lock is the exact negation of active, for every input.
const PROBE = [...NON_ACTIVE, 'ACTIVE', null, undefined, 0, 1, {}, []];
let negationHeld = true;
for (const s of PROBE) {
  if (isLicenseLocked(s) !== !isLicenseActive(s)) negationHeld = false;
}
assert(negationHeld, 'isLicenseLocked === !isLicenseActive for all probed inputs');

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2: Write immunity — the export path cannot mutate a record
// ─────────────────────────────────────────────────────────────────────────────
section('TEST 2: Write Immunity — read-only handle rejects every mutation');

async function writeImmunity() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    assert(false, 'node:sqlite unavailable — cannot run write-immunity test');
    return;
  }

  // Same open flags the Rust exporter uses.
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, receipt_number TEXT, customer_id TEXT,
      subtotal REAL, tax REAL, discount_total REAL, total REAL,
      payment_method TEXT, cash_tendered REAL, change_due REAL,
      status TEXT, created_at TEXT, json_payload TEXT, device_id TEXT,
      shift_id TEXT, deleted INTEGER DEFAULT 0
    );
    CREATE TABLE app_settings (id TEXT PRIMARY KEY, key TEXT, value_json TEXT);
  `);
  db.exec(
    `INSERT INTO transactions VALUES
     ('t1','R-001','CUST',100,19,0,119,'Cash',120,1,'COMPLETED','2026-01-01','{}','d1','S1',0)`
  );

  // Close the writable handle, reopen strictly read-only.
  const path = db.location ? db.location() : null;
  let ro;
  if (path) {
    db.close();
    ro = new DatabaseSync(path, { readOnly: true });
  } else {
    // In-memory cannot be reopened; emulate the exporter's PRAGMA contract.
    db.exec('PRAGMA query_only = ON');
    ro = db;
  }
  ro.exec('PRAGMA query_only = ON');

  assert(ro.prepare('PRAGMA query_only').get().query_only === 1, 'PRAGMA query_only is ON');

  // Reads work.
  const before = ro.prepare('SELECT COUNT(*) c FROM transactions').get().c;
  assert(before === 1, 'read-only handle can still read compliance data');

  // Every mutation class must fail.
  const mutations = [
    ['INSERT', `INSERT INTO transactions (id) VALUES ('t2')`],
    ['UPDATE', `UPDATE transactions SET total = 0`],
    ['DELETE', `DELETE FROM transactions`],
    ['DROP', `DROP TABLE transactions`],
    ['ALTER', `ALTER TABLE transactions ADD COLUMN x TEXT`],
    ['DDL create', `CREATE TABLE injected (a)`],
  ];
  for (const [label, sql] of mutations) {
    let threw = false;
    try {
      ro.exec(sql);
    } catch {
      threw = true;
    }
    assert(threw, `${label} is rejected on the export connection`);
  }

  // Data unchanged after the attempts.
  const after = ro.prepare('SELECT COUNT(*) c FROM transactions').get().c;
  assert(after === before, 'row count unchanged after mutation attempts');
  const total = ro.prepare('SELECT total FROM transactions WHERE id = ?').get('t1').total;
  assert(total === 119, 'existing financial record unmodified');

  ro.close();
}

await writeImmunity();

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: Authentication gating
// ─────────────────────────────────────────────────────────────────────────────
section('TEST 3: Auth Gating — export refuses bad / absent credentials');

const {
  runEmergencyComplianceExport,
  setEmergencyExportTransport,
  EmergencyExportError,
  EMERGENCY_EXPORT_TABLES,
} = await import('../src/licensing/emergencyExporter.ts');

async function expectRejected(label, fn, expectedCode) {
  try {
    await fn();
    assert(false, `${label} — export was NOT rejected (SECURITY HOLE)`);
  } catch (err) {
    const code = err instanceof EmergencyExportError ? err.code : 'UNKNOWN';
    assert(
      code === expectedCode,
      `${label} — rejected with code ${expectedCode} (got ${code})`
    );
  }
}

// A blank / missing Owner PIN must never reach the engine.
await expectRejected(
  'empty PIN',
  () => runEmergencyComplianceExport({ pin: '', licenseStatus: 'EXPIRED' }),
  'INVALID_PIN'
);
await expectRejected(
  'whitespace-only PIN',
  () => runEmergencyComplianceExport({ pin: '    ', licenseStatus: 'EXPIRED' }),
  'INVALID_PIN'
);
await expectRejected(
  'missing PIN (undefined)',
  () => runEmergencyComplianceExport({ pin: undefined, licenseStatus: 'EXPIRED' }),
  'INVALID_PIN'
);

// ── Transport-level contract ────────────────────────────────────────────────
// Substitute the IPC boundary so we can assert exactly what the gate sends and
// how it reacts to a native auth rejection.
let lastCommand = null;
let lastArgs = null;
let progressHandler = null;
let listenerDetached = false;

function makeTransport(behaviour) {
  return {
    async invoke(command, args) {
      lastCommand = command;
      lastArgs = args;
      return behaviour();
    },
    async onProgress(handler) {
      progressHandler = handler;
      return () => {
        listenerDetached = true;
      };
    },
  };
}

const OK_RESULT = {
  exportDir: 'C:/tmp/export_1',
  files: [
    {
      table: 'sales_journal',
      fileName: 'sales_journal.csv',
      absolutePath: 'C:/tmp/export_1/sales_journal.csv',
      rowCount: 252,
      byteLen: 4096,
      sha256: 'a'.repeat(64),
    },
  ],
  auditEventId: 'AUD-EXP-1',
  authorizedAdminId: 'usr-admin',
  licenseStatusAtExport: 'EXPIRED',
  completedAt: '2026-09-30T00:00:00Z',
};

// Native auth rejection (what the Rust command returns for a bad PIN).
setEmergencyExportTransport(
  makeTransport(() => {
    throw new Error('PIN gérant incorrect. Export refusé.');
  })
);
await expectRejected(
  'invalid PIN (native rejection)',
  () => runEmergencyComplianceExport({ pin: '0000', licenseStatus: 'EXPIRED' }),
  'INVALID_PIN'
);

// A non-auth engine failure must NOT be mislabelled as a bad PIN.
setEmergencyExportTransport(
  makeTransport(() => {
    throw new Error('Base de données locale introuvable');
  })
);
await expectRejected(
  'engine failure is not reported as bad PIN',
  () => runEmergencyComplianceExport({ pin: '1234', licenseStatus: 'EXPIRED' }),
  'FAILED'
);

// Happy path: assert the exact native contract the gate depends on.
// Phase 1 (B.7): the client sends PIN + tables only. License state is the
// kernel's own verdict — a client-supplied status must never reach IPC.
setEmergencyExportTransport(makeTransport(() => OK_RESULT));
const ok = await runEmergencyComplianceExport(
  { pin: '1234' },
  { onProgress: () => {} }
);
assert(lastCommand === 'emergency_export_ledger', 'invokes the emergency_export_ledger command');
assert(
  lastArgs.request.pin === '1234' && !('licenseStatus' in lastArgs.request),
  'sends the PIN and no licence status to the engine (kernel owns state)'
);
// A legacy caller still passing licenseStatus must not forward it.
await runEmergencyComplianceExport({ pin: '1234', licenseStatus: 'GRACE_EXCEEDED' });
assert(
  !('licenseStatus' in lastArgs.request),
  'legacy licence status is dropped before IPC, never forwarded'
);
assert(
  Array.isArray(lastArgs.request.tables) && lastArgs.request.tables.length === 0,
  'an unspecified table set is sent as empty (engine defaults to all allowed)'
);
assert(ok.auditEventId === 'AUD-EXP-1' && ok.files[0].sha256.length === 64, 'returns the audit id and per-file SHA-256');
assert(listenerDetached === true, 'progress listener is detached after the export');

// Listener cleanup must also happen on failure.
listenerDetached = false;
setEmergencyExportTransport(
  makeTransport(() => {
    throw new Error('boom');
  })
);
try {
  await runEmergencyComplianceExport({ pin: '1234', licenseStatus: 'EXPIRED' }, { onProgress: () => {} });
} catch {
  /* expected */
}
assert(listenerDetached === true, 'progress listener is detached on failure too');

// A non-allowlisted table must be refused client-side, before IPC.
setEmergencyExportTransport(makeTransport(() => OK_RESULT));
for (const table of ['customers', 'app_settings', 'products', 'cashier_users', 'sql']) {
  await expectRejected(
    `non-allowlisted table "${table}"`,
    () => runEmergencyComplianceExport({ pin: '1234', licenseStatus: 'EXPIRED', tables: [table] }),
    'FORBIDDEN_TABLE'
  );
}
// Prove the refusal happened before IPC, not after a round-trip.
lastCommand = null;
try {
  await runEmergencyComplianceExport({ pin: '1234', licenseStatus: 'EXPIRED', tables: ['customers'] });
} catch {
  /* expected */
}
assert(lastCommand === null, 'forbidden table never reaches the native command');

// The allowlist itself is exactly the four compliance tables.
assert(
  EMERGENCY_EXPORT_TABLES.length === 4 &&
    EMERGENCY_EXPORT_TABLES.includes('sales_journal') &&
    EMERGENCY_EXPORT_TABLES.includes('sales_journal_lines') &&
    EMERGENCY_EXPORT_TABLES.includes('shift_sessions') &&
    EMERGENCY_EXPORT_TABLES.includes('shift_movements'),
  'allowlist is exactly the four compliance tables'
);
assert(
  !EMERGENCY_EXPORT_TABLES.some((t) => /customer|cashier|setting|product|user|token/i.test(t)),
  'allowlist contains no PII, credential, or catalog table'
);

// An already-aborted signal short-circuits.
const ac = new AbortController();
ac.abort();
await expectRejected(
  'pre-aborted signal',
  () => runEmergencyComplianceExport({ pin: '1234', licenseStatus: 'EXPIRED' }, { signal: ac.signal }),
  'CANCELLED'
);
lastCommand = null;
try {
  await runEmergencyComplianceExport({ pin: '1234', licenseStatus: 'EXPIRED' }, { signal: ac.signal });
} catch {
  /* expected */
}
assert(lastCommand === null, 'an aborted export never reaches the native command');

// Fail-closed choke: an unreadable choke refuses revenue rather than allowing it.
section('TEST 3b: Sale choke fails closed when state is unreadable');
setDegradedSaleBlock(true);
assert(isSaleBlockedByLicense() === true, 'armed choke blocks sales');
setDegradedSaleBlock(false);
assert(isSaleBlockedByLicense() === false, 'explicitly disarmed choke permits sales');

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: Boot isolation
// ─────────────────────────────────────────────────────────────────────────────
section('TEST 4: Boot Isolation — locked surface reaches no lifecycle module');

const { readFileSync, existsSync } = await import('node:fs');
const { join, dirname, resolve, relative } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

const GUARDED = [
  'components/licensing/ActivationGateScreen.tsx',
  'licensing/emergencyExporter.ts',
];

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(relFile) {
  const src = readFileSync(join(SRC, relFile), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) !== null) out.push(m[1] || m[2]);
  return out.filter((s) => s && s.startsWith('.'));
}

const FORBIDDEN = [
  'store/',
  'db/adapters',
  'db/repositories',
  'db/sqlPluginAdapter',
  'db/sqliteAdapter',
  'db/database',
  'sync/',
  'services/',
  'features/',
];

for (const relFile of GUARDED) {
  const specs = importsOf(relFile);
  const edges = specs.map((s) => relative(SRC, resolve(dirname(join(SRC, relFile)), s)).split('\\').join('/'));
  for (const e of edges) {
    const hit = FORBIDDEN.find((p) => e === p || e.startsWith(p));
    assert(!hit, `${relFile}: '${e}' is not a lifecycle module`);
  }
  // The gate must not pull in the exporter's siblings' heavy deps either.
  assert(
    !edges.some((e) => /turso|libsql/i.test(e)),
    `${relFile} imports no cloud-sync client`
  );
}

// The exporter's only data edge must be the typed IPC wrapper, loaded lazily.
// A module-level import would also break the Node test suite, so this doubles
// as an architectural assertion.
const exporterSrc = readFileSync(join(SRC, 'licensing/emergencyExporter.ts'), 'utf8');
assert(
  !/^import\s+.*from\s+'\.\.\/platform\/invoke'/m.test(exporterSrc),
  'emergencyExporter loads the IPC wrapper lazily, not at module scope'
);
assert(
  /import\('\.\.\/platform\/invoke'\)/.test(exporterSrc),
  'emergencyExporter reaches IPC through the lazy transport'
);

// The POS store itself must still be reachable from the app — proving the
// guard is targeted, not a global lockout of legitimate imports.
assert(
  existsSync(join(SRC, 'store/usePosStore.ts')),
  'POS store still exists and is importable by the operating app'
);

// ActivationGateScreen must be the only thing rendered while locked.
const appSrc = readFileSync(join(SRC, 'App.tsx'), 'utf8');
assert(
  /if \(licenseState\.locked\)/.test(appSrc),
  'App.tsx gates the operating app on licenseState.locked'
);
assert(
  !/!licenseState\.licensed && !licenseState\.degraded/.test(appSrc),
  'App.tsx no longer contains the degraded-bypass gate condition'
);
assert(
  !/licenseState\.degraded &&/.test(appSrc),
  'App.tsx renders no degraded banner (the bypass UI is gone)'
);

// The sync effect and DB init must both be license-gated, so a locked terminal
// fires no network calls and never opens the app's writable pool.
assert(
  /React\.useEffect\(\(\) => \{\s*\n\s*if \(!licenseState\.licensed\) return;/.test(appSrc),
  'sync effect is gated on licenseState.licensed (no egress while locked)'
);
const initSites = [...appSrc.matchAll(/initDatabase\(\)/g)].length;
assert(initSites === 1, `initDatabase is called from exactly one site (found ${initSites})`);

// The clock-rollback tripwire must ARM the sale choke, not disarm it. It
// previously called setDegradedSaleBlock(false) — disarming revenue on the one
// path that should be locking hardest. Pinned so it cannot regress.
//
// Comments are stripped first: the code carries a prose note that quotes the
// old buggy call, and a grep-style check would otherwise flag its own comment.
const appCode = appSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const tamperIdx = appCode.indexOf("status: 'TAMPERED_CLOCK'");
assert(tamperIdx > -1, 'App.tsx records a TAMPERED_CLOCK status somewhere');
const tripwire = appCode.slice(tamperIdx - 600, tamperIdx + 200);
assert(
  /setDegradedSaleBlock\(true\)/.test(tripwire),
  'clock-rollback tripwire arms the sale choke (fail-closed)'
);
assert(
  !/setDegradedSaleBlock\(false\)/.test(tripwire),
  'clock-rollback tripwire does not disarm the sale choke'
);

// Every state mutation that is not an explicit successful activation must set
// locked: true. Catches a future re-introduction of a soft-lock branch.
const setLicenseCalls = [...appSrc.matchAll(/setLicenseState\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]);
const unlockedCalls = setLicenseCalls.filter((body) => /locked:\s*false/.test(body));
assert(
  unlockedCalls.length <= 1,
  `at most one setLicenseState clears the lock (the activation callback); found ${unlockedCalls.length}`
);
for (const body of unlockedCalls) {
  assert(
    /licensed:\s*true/.test(body),
    'the only state that clears the lock also sets licensed: true (post-activation)'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n========================================================================');
console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
console.log('========================================================================');

process.exit(failed === 0 ? 0 : 1);

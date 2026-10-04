#!/usr/bin/env node
/**
 * PIN exposure boundary (Phase 4.5 WP3f).
 *
 * Legacy `v1$` PIN hashes are offline-brute-forceable (single salted SHA-256
 * over 4–6 digits), so every place a PIN or hash was readable from the WebView
 * or synced was an exposure. This script pins the closed ones and freezes the
 * interim ones so no NEW exposure can land without breaking the gate:
 *
 *  P1. Sync egress closed: `manager_pin` + `cashier_users` are in the
 *      device-local set, and every settings-sync call site honors the
 *      predicate (push skip, backfill/repair skip, pull skip, digest
 *      filter). No fireSync/enqueue line carries a credential literal.
 *  P2. No PIN-bearing values in logs: after stripping string literals, no
 *      console.* call passes a value-carrying PIN identifier. Convention
 *      (audited): generic catch vars (`err`, `error`, `e`) never carry PIN
 *      material — native errors carry codes/reasons, never the credential.
 *  P3. No PIN material in persisted Zustand state (partialize allowlist).
 *  P4. Native-first everywhere: auth gates route through utils/pinGate.ts;
 *      raw verifyPin survives only in the pinned login/uniqueness set.
 *  P5. Credential-key readers frozen: files containing the
 *      'manager_pin'/'cashier_users' literals are exactly the pinned set
 *      (native verify, boot heal, setters, predicate, one legacy shift
 *      gate). A new reader fails the gate.
 *
 * Usage: node scripts/check-pin-boundary.mjs (wired into test:boundaries)
 * Exit: 0 = clean, 1 = violation(s) found
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures += 1;
    console.error(`  [FAIL] ${name} ${extra}`);
  }
}
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');
function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) tsFiles(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}
const rel = (abs) => abs.slice(SRC.length + 1).split('\\').join('/');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
// Strip string literals (labels like 'Failed to update manager PIN:' are
// evidence-free); what remains are code identifiers.
const stripStrings = (s) =>
  s.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, '``');

console.log('========================================================================');
console.log('MOBIPOS — PIN EXPOSURE BOUNDARY (Phase 4.5 WP3f)');
console.log('========================================================================\n');

// ── P1. Sync egress ──
console.log('== P1: sync egress ==');
{
  const adapter = read('db/sqlPluginAdapter.ts');
  check(
    "'manager_pin' + 'cashier_users' in the device-local set",
    adapter.includes("'manager_pin'") && adapter.includes("'cashier_users'")
  );
  // Every settings-sync emitter honors the predicate in-file.
  const emitters = [
    'db/adapters/operationsAdapter.ts', // setSetting push skip
    'db/backfill.ts', // backfill skip
    'sync/repairResync.ts', // repair skip
    'sync/genericApply.ts', // pull skip
    'sync/migrationManager.ts', // migration filters
    'sync/SyncManager.ts', // digest filter
  ];
  for (const f of emitters) {
    const src = read(f);
    check(
      `${f} honors the device-local predicate`,
      src.includes('isDeviceLocalSettingKey') || src.includes('stripDeviceLocalSettingValue'),
    );
  }
  // No credential literal rides a sync call line.
  let bad = [];
  for (const f of tsFiles(SRC)) {
    const src = stripComments(readFileSync(f, 'utf8'));
    for (const line of src.split('\n')) {
      if (
        (line.includes('fireSync(') || line.includes('enqueueGenericSync(')) &&
        (line.includes('manager_pin') || line.includes('cashier_users'))
      ) {
        bad.push(`${rel(f)}: ${line.trim().slice(0, 100)}`);
      }
    }
  }
  check('no sync call line carries a credential key', bad.length === 0, bad.join(' | '));
}

// ── P2. Logs ──
console.log('== P2: log leakage ==');
{
  // Value-carrying PIN identifiers (state, inputs, hashes). Generic catch
  // vars are excluded by audited convention (native errors never carry the
  // credential — TrustError reasons are fixed strings).
  const PIN_VALUE_RE = /\b(managerPin|manager_pin| cashierUsers|cashier_users|enteredPin|pinInput|cleanPin|newPin|storedPin|storedHash|currentPin|cleanManagerPin|pulledManagerPin|finalManagerPin)\b/;
  let hits = [];
  for (const f of tsFiles(SRC)) {
    const src = stripStrings(stripComments(readFileSync(f, 'utf8')));
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (/console\.(log|warn|error|info|debug)\s*\(/.test(line) && PIN_VALUE_RE.test(line)) {
        hits.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 110)}`);
      }
    });
  }
  check('no console.* call passes a PIN-bearing identifier', hits.length === 0, hits.join(' | '));
  // Audit trail itself must not interpolate PIN values (it syncs to peers).
  let auditHits = [];
  for (const f of tsFiles(SRC)) {
    const src = stripStrings(stripComments(readFileSync(f, 'utf8')));
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (/logSecurityAction\s*\(/.test(line) && PIN_VALUE_RE.test(line)) {
        auditHits.push(`${rel(f)}:${i + 1}`);
      }
    });
  }
  check('no audit entry interpolates a PIN value', auditHits.length === 0, auditHits.join(' | '));
}

// ── P3. Persist ──
console.log('== P3: persisted state ==');
{
  const store = read('store/usePosStore.ts');
  const partIdx = store.indexOf('partialize');
  const part = partIdx === -1 ? '' : store.slice(partIdx, partIdx + 1200);
  check(
    'persist partialize excludes PIN material',
    !/managerPin|cashierUsers|manager_pin|cashier_users/.test(part)
  );
}

// ── P4. Native-first everywhere; single routing module (Phase 1) ──
// Authentication gates route through utils/pinGate.ts (native pin_verify
// under Tauri, fail-closed). Raw local verification survives ONLY where it
// cannot authorize: the login fallback (non-Tauri), the lock screen's
// native-first flow, and Settings roster UNIQUENESS checks (documented
// oracle — they reject duplicates, never grant access).
console.log('== P4: routing module ==');
{
  const overlay = read('components/LockScreenOverlay.tsx');
  check('lock screen imports the native PIN plane', overlay.includes('../api/pin'));
  check('lock screen calls pin_verify with a userId', overlay.includes('pinVerify({ userId'));
  check('lock screen honors mustRotate', overlay.includes('mustRotate'));
  check('lock screen surfaces the native lockout', overlay.includes('nativeLockedRemainingMs'));
  check('native verdict is final (no local fallback after it)', /no local fallback/i.test(overlay));
  // Phase 4a: rotations mint natively (pin_set → Argon2id v2). The lock
  // screen, tech recovery and Settings all route through the single store
  // action; a direct TS mint for credentials would fail the suite below.
  const slice = read('store/slices/createUISlice.ts');
  const settingsModal = read('components/modals/SettingsModal.tsx');
  check('rotation authority lives in the store', slice.includes('rotatePinCredential: async'));
  check('lock screen rotates through the authority', overlay.includes('rotatePinCredential('));
  check('settings rotates through the authority', settingsModal.includes('rotatePinCredential('));
  check(
    'native failure never falls back to a local mint',
    /NEVER falls back to a local mint/i.test(slice)
  );
  // verifyManagerPin CALLS live only in the routing module (default weak
  // fallback) — the store keeps the definition for compat.
  const gateCallers = [];
  for (const f of tsFiles(SRC)) {
    const r = rel(f);
    if (r === 'store/slices/createUISlice.ts') continue; // definition
    const src = stripComments(readFileSync(f, 'utf8'));
    if (/[^a-zA-Z0-9_]verifyManagerPin\s*\(/.test(src)) gateCallers.push(r);
  }
  check(
    'verifyManagerPin called only from utils/pinGate.ts',
    gateCallers.length === 1 && gateCallers[0] === 'utils/pinGate.ts',
    `got [${gateCallers.join(', ')}]`
  );
  // Raw verifyPin CALLS: definition + login fallback + lock screen +
  // roster uniqueness. The shiftAdapter variance gate is gone from this list
  // (native-routed) — its return would fail the gate below.
  const allowedRaw = new Set([
    'utils/security.ts', // definition
    'store/slices/createUISlice.ts', // login fallback + gate impl (non-Tauri path)
    'components/LockScreenOverlay.tsx', // native-first login + rotation
    'components/modals/SettingsModal.tsx', // uniqueness checks (documented oracle, never auth)
  ]);
  const rawCallers = [];
  for (const f of tsFiles(SRC)) {
    const r = rel(f);
    const src = stripComments(readFileSync(f, 'utf8'));
    if (/[^a-zA-Z0-9_]verifyPin\s*\(/.test(src)) rawCallers.push(r);
  }
  const rawExtra = rawCallers.filter((r) => !allowedRaw.has(r));
  check(
    'raw verifyPin called only in the pinned set (no new local gates)',
    rawExtra.length === 0,
    `extra: [${rawExtra.join(', ')}]`
  );
  const missingRaw = [...allowedRaw].filter((r) => !rawCallers.includes(r));
  check('pinned raw callers still present', missingRaw.length === 0, `missing: [${missingRaw.join(', ')}]`);
}

// ── P5. Credential-key readers frozen ──
console.log('== P5: credential-key readers ==');
{
  const allowed = new Set([
    'store/slices/createUISlice.ts', // boot heal + setters + native-first rotation (rotatePinCredential; TS mint survives only on the non-Tauri branch)
    'db/sqlPluginAdapter.ts', // the device-local predicate itself
    'constants/index.ts', // key constant (unused elsewhere)
    // Gate-name LABEL only, not a credential read: the literal is composed
    // into the burst/lockout event name (gateName) after the native verdict
    // returns. No appSettings read, no hash comparison — pinGate is the
    // designated native routing module (P4), so this is its own vocabulary.
    'utils/pinGate.ts',
    // Credential EXCLUSIONS, never credential reads. Every site is a
    // deny-direction predicate: backups filter these rows OUT (settings
    // filter, twice) and the outbox skips them, so a backup's stale (or
    // another device's) fast hashes can never be exported or synced. The
    // single get() is the import stash-and-restore: it re-PUTS the LIVE
    // device-local rows after clear(), which is the "old synced hashes are
    // exposed" decision — restoring would regress to a backup's PINs.
    'db/adapters/maintenanceAdapter.ts',
    // shiftAdapter's Dexie credential read is GONE (Phase 1 native-routed);
    // its return here would fail the gate below.
  ]);
  let readers = new Set();
  for (const f of tsFiles(SRC)) {
    const src = readFileSync(f, 'utf8');
    if (src.includes("'manager_pin'") || src.includes('"manager_pin"') ||
        src.includes("'cashier_users'") || src.includes('"cashier_users"')) {
      readers.add(rel(f));
    }
  }
  const extra = [...readers].filter((r) => !allowed.has(r));
  const missing = [...allowed].filter((r) => !readers.has(r));
  check('no new credential-key reader', extra.length === 0, `extra: [${extra.join(', ')}]`);
  check('pinned readers still present', missing.length === 0, `missing: [${missing.join(', ')}]`);
}

// ── P6. No native lockout reset (DoS posture + decision 3) ──
// The persisted lockout clears ONLY via time expiry or a successful verify.
// Any client-callable reset/unlock/clear-lockout path would be a bypass, so
// the lockout-mutating primitives must live in exactly one file (pin.rs,
// called on the verify path) and no Tauri command may be named like one.
console.log('== P6: no lockout reset ==');
{
  const TAURI_SRC = join(ROOT, 'src-tauri', 'src');
  const rsFiles = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (e === 'target' || e === 'target-test') continue;
        walk(p);
      } else if (e.endsWith('.rs')) rsFiles.push(p);
    }
  };
  walk(TAURI_SRC);
  const mutators = [];
  for (const f of rsFiles) {
    const src = readFileSync(f, 'utf8');
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/record_success_for|record_failure_for|save_lockouts/.test(stripped)) {
      mutators.push(f.slice(TAURI_SRC.length + 1).split('\\').join('/'));
    }
  }
  const unexpected = mutators.filter((r) => r !== 'trust_core/pin.rs');
  check(
    'lockout mutation lives only in trust_core/pin.rs (verify path)',
    unexpected.length === 0,
    `unexpected: [${unexpected.join(', ')}]`
  );
  const registry = readFileSync(join(TAURI_SRC, 'trust_core', 'ipc_authorizer.rs'), 'utf8');
  const suspicious = (registry.match(/"[a-z_]*(unlock|reset|clear)[a-z_]*"/g) || []).filter(
    (s) => !s.includes('clock') && !s.includes('counter')
  );
  check(
    'no reset/unlock/clear command in the IPC registry',
    suspicious.length === 0,
    `suspicious: [${suspicious.join(', ')}]`
  );
}

console.log('');
if (failures === 0) {
  console.log('RESULT: PIN exposure boundary intact.');
} else {
  console.error(`RESULT: ${failures} VIOLATION(S) — PIN exposure changed.`);
  process.exit(1);
}

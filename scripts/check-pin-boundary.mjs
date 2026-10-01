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
 *  P4. Login is native-first: the lock screen calls pin_verify under Tauri
 *      and honors mustRotate + native lockout; local verifyPin call sites
 *      are capped per file (interim manager gates + non-Tauri fallback +
 *      rotation distinctness) and may not grow without a deliberate edit.
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

// ── P4. Native-first login; local verify frozen ──
console.log('== P4: login path ==');
{
  const overlay = read('components/LockScreenOverlay.tsx');
  check('lock screen imports the native PIN plane', overlay.includes('../api/pin'));
  check('lock screen calls pin_verify with a userId', overlay.includes('pinVerify({ userId'));
  check('lock screen honors mustRotate', overlay.includes('mustRotate'));
  check('lock screen surfaces the native lockout', overlay.includes('nativeLockedRemainingMs'));
  check('native verdict is final (no local fallback after it)', /no local fallback/i.test(overlay));
  // Local verifyPin call-site caps (exclude the definition file itself).
  const caps = {
    'store/slices/createUISlice.ts': 4, // verifyManagerPin + unlockScreen(2) + switchCashier
    'components/LockScreenOverlay.tsx': 4, // non-Tauri fallback(2) + rotation distinctness(2)
    'components/modals/SettingsModal.tsx': 5, // roster management (manager-privileged)
    'db/adapters/shiftAdapter.ts': 1, // legacy variance gate (interim)
  };
  for (const [f, max] of Object.entries(caps)) {
    const src = stripComments(read(f));
    // Count real calls, not the `verifyPin(` substring inside comments/strings.
    const n = (src.match(/[^a-zA-Z0-9_]verifyPin\s*\(/g) || []).length;
    check(`local verifyPin frozen in ${f} (<= ${max})`, n <= max, `found ${n}`);
  }
  // Manager-gate (verifyManagerPin) call sites may not grow silently either.
  let gateCount = 0;
  for (const f of tsFiles(SRC)) {
    const src = stripComments(readFileSync(f, 'utf8'));
    gateCount += (src.match(/[^a-zA-Z0-9_]verifyManagerPin\s*\(/g) || []).length;
  }
  // 14 call sites + 1 definition.
  check('manager-gate call sites frozen (<= 15 incl. definition)', gateCount <= 15, `found ${gateCount}`);
}

// ── P5. Credential-key readers frozen ──
console.log('== P5: credential-key readers ==');
{
  const allowed = new Set([
    'store/slices/createUISlice.ts', // boot heal + setters + rotation (interim TS mint)
    'db/sqlPluginAdapter.ts', // the device-local predicate itself
    'db/adapters/shiftAdapter.ts', // legacy variance gate (interim)
    'constants/index.ts', // key constant (unused elsewhere)
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

console.log('');
if (failures === 0) {
  console.log('RESULT: PIN exposure boundary intact.');
} else {
  console.error(`RESULT: ${failures} VIOLATION(S) — PIN exposure changed.`);
  process.exit(1);
}

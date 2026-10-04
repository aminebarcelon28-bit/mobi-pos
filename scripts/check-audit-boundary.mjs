#!/usr/bin/env node
/**
 * Audit write-path boundary (Phase 4.5 WP2b).
 *
 * The trust rule (AGENTS.md decision 5): `security_audit_logs` is
 * native-write-only under Tauri. Unchained WebView rows would show in the
 * register as if audited while being invisible to the audit chain — an
 * evidence forgery hole. This script makes the rule a build failure:
 *
 *  A. At most THREE WebView SQL writers to security_audit_logs exist in src/,
 *     each pinned by role:
 *       1. operationsAdapter.saveAuditLog — web-preview / Node-test fallback
 *          (the funnel's non-Tauri branch; rule B pins its callers).
 *       2. sync/genericApply.ts pull mirror — PEER rows landing locally.
 *          Evidence freeze (rule A2): INSERT-only, never rewrites a row.
 *       3. maintenanceAdapter.mergeImportAuditHistory — BACKUP rows merging
 *          on JSON restore (FT-06/F3 disaster recovery). Same freeze
 *          (rule A3): INSERT-only ON CONFLICT DO NOTHING, existing rows win.
 *     Anything else is an alternate write path and fails the gate.
 *  B. saveAuditLog is called ONLY from the non-Tauri branch of the
 *     logSecurityAction funnel (createUISlice.ts). No other caller exists.
 *  C. The funnel's Tauri branch calls audit_append and, on failure, ONLY
 *     noteSwallowedAuditFailure + return — no fallback write exists.
 *  D. payoutWatch (sync lane) files exceptions through the funnel, never
 *     directly (regression guard for the Phase 4.5 reroute).
 *  E. Every swallow is surfaced natively: api/audit.ts invokes
 *     'audit_note_swallowed' from noteSwallowedAuditFailure.
 *
 * Usage: node scripts/check-audit-boundary.mjs (wired into test:boundaries)
 * Exit: 0 = clean, 1 = violation(s) found
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log('========================================================================');
console.log('MOBIPOS — AUDIT WRITE-PATH BOUNDARY (Phase 4.5 WP2b)');
console.log('========================================================================\n');

// ── A. Locate every WebView SQL write to the audit table ──
// Write verbs against the table, outside comments. Dexie (`dexieDb.*`) is the
// web mirror, not the SQLite trust table — out of scope here.
const WRITE_RE = /\b(INSERT|REPLACE|UPDATE|DELETE)\b[^;]*security_audit_logs/is;
function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) tsFiles(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}
const writers = [];
for (const f of tsFiles(SRC)) {
  const src = readFileSync(f, 'utf8');
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (WRITE_RE.test(stripped)) {
    writers.push(f.slice(SRC.length + 1).split('\\').join('/'));
  }
}
console.log(`  WebView SQL writers to security_audit_logs: ${writers.length === 0 ? '(none)' : ''}`);
for (const w of writers) console.log(`    - ${w}`);
const ALLOWED_WRITERS = ['db/adapters/operationsAdapter.ts', 'sync/genericApply.ts', 'db/adapters/maintenanceAdapter.ts'];
check(
  'WebView SQL audit writers are exactly the pinned set (fallback + pull mirror + import merge)',
  writers.length === ALLOWED_WRITERS.length && ALLOWED_WRITERS.every((w) => writers.includes(w)),
  `got [${writers.join(', ')}]`
);
// ── A2. Evidence freeze: the pull mirror must be INSERT-only ──
{
  const mirror = read('sync/genericApply.ts');
  const branchIdx = mirror.indexOf("} else if (table === 'security_audit_logs') {");
  check('pull mirror branch exists', branchIdx !== -1);
  // Branch body ends at the next `} else if` at the same nesting.
  const nextElse = mirror.indexOf('} else if (table ===', branchIdx + 10);
  let branch = nextElse === -1 ? mirror.slice(branchIdx) : mirror.slice(branchIdx, nextElse);
  // Strip comments: rationale comments legitimately name the banned shape.
  branch = branch
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('pull mirror is INSERT-only (ON CONFLICT DO NOTHING)', branch.includes('ON CONFLICT(id) DO NOTHING'));
  check(
    'pull mirror never rewrites row content (no DO UPDATE on the audit table)',
    !/DO\s+UPDATE/i.test(branch)
  );
}

// ── A3. Evidence freeze, import merge: every audit statement INSERT-only ──
{
  const maint = read('db/adapters/maintenanceAdapter.ts');
  const stripped = maint
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const stmts = stripped.match(/\b(?:INSERT|REPLACE|UPDATE|DELETE)\b[^;]*security_audit_logs[^;]*;/gis) || [];
  console.log(`  maintenanceAdapter audit statements: ${stmts.length}`);
  const allInsertOnly =
    stmts.length > 0 &&
    stmts.every(
      (s) =>
        /^\s*INSERT\b/i.test(s) &&
        /ON CONFLICT\s*\(\s*id\s*\)\s*DO NOTHING/i.test(s) &&
        !/\b(?:UPDATE|DELETE)\b/i.test(s.replace(/ON CONFLICT\s*\(\s*id\s*\)\s*DO NOTHING/i, ''))
    );
  check(
    'import merge is INSERT-only ON CONFLICT DO NOTHING (no UPDATE/DELETE on the audit table)',
    allInsertOnly,
    `got ${stmts.length} statement(s)`
  );
}

// ── B. saveAuditLog callers ⊆ {funnel non-Tauri branch} ──
const callers = [];
for (const f of tsFiles(SRC)) {
  const rel = f.slice(SRC.length + 1).split('\\').join('/');
  if (rel === 'db/adapters/operationsAdapter.ts') continue; // definition
  const src = readFileSync(f, 'utf8');
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (/saveAuditLog\s*\(/.test(stripped)) callers.push(rel);
}
console.log(`  saveAuditLog callers: ${callers.length === 0 ? '(none)' : ''}`);
for (const c of callers) console.log(`    - ${c}`);
check(
  'saveAuditLog called only from the funnel (createUISlice)',
  callers.length === 1 && callers[0] === 'store/slices/createUISlice.ts',
  `got [${callers.join(', ')}]`
);
{
  // The single call site must sit in the NON-Tauri else branch: find the
  // Tauri-guard `if` and the `saveAuditLog` call, assert call-after-else.
  const funnel = read('store/slices/createUISlice.ts');
  const guardIdx = funnel.indexOf('__TAURI_INTERNALS__');
  const elseIdx = funnel.indexOf('} else {', guardIdx);
  const callIdx = funnel.indexOf('saveAuditLog(newEntry)');
  check('funnel has Tauri guard', guardIdx !== -1);
  check('saveAuditLog call sits after the non-Tauri else', elseIdx !== -1 && callIdx > elseIdx);
  // No saveAuditLog between the guard and the else (the Tauri branch).
  const tauriBranch = funnel.slice(guardIdx, elseIdx);
  check('Tauri branch contains no saveAuditLog', !tauriBranch.includes('saveAuditLog'));
  check('Tauri branch contains no direct audit SQL', !/security_audit_logs/i.test(tauriBranch));
}

// ── C. Tauri-branch failure path: count + return, no alternate write ──
{
  const funnel = read('store/slices/createUISlice.ts');
  const catchIdx = funnel.indexOf('} catch (nativeErr) {');
  check('funnel has native-failure catch', catchIdx !== -1);
  // Catch body = up to its closing brace at the same 8-space indent (do NOT
  // bleed into the `else` branch that follows — that is the non-Tauri path).
  const catchEnd = funnel.indexOf('\n        }', catchIdx);
  const catchBlock = funnel.slice(catchIdx, catchEnd === -1 ? catchIdx + 400 : catchEnd);
  check('catch notes the swallow', catchBlock.includes('noteSwallowedAuditFailure('));
  check('catch returns without fallback', /return;/.test(catchBlock));
  check('catch performs no DB write', !/saveAuditLog|db\.execute|INSERT|put\(/i.test(catchBlock));
}

// ── D. payoutWatch regression: funnel only ──
{
  const pw = read('sync/payoutWatch.ts');
  const stripped = pw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('payoutWatch has no saveAuditLog', !/saveAuditLog\s*\(/.test(stripped));
  check('payoutWatch has no direct audit INSERT', !WRITE_RE.test(stripped));
  check('payoutWatch files via logSecurityAction', (stripped.match(/logSecurityAction\(/g) || []).length >= 2);
}

// ── E. Native surfacing of every swallow ──
{
  const api = read('api/audit.ts');
  check(
    "noteSwallowedAuditFailure invokes 'audit_note_swallowed'",
    api.includes("invokeCommand<number>('audit_note_swallowed'") ||
      api.includes('invokeCommand<number>("audit_note_swallowed"') ||
      api.includes("'audit_note_swallowed'")
  );
  // The surfacing attempt itself is infallible: fire-and-forget + catch.
  const noteIdx = api.indexOf('export function noteSwallowedAuditFailure');
  const noteBody = api.slice(noteIdx, noteIdx + 1500);
  check('surfacing is fire-and-forget (no await on the report)', !/await\s+invokeCommand<number>\('audit_note_swallowed'/.test(noteBody));
  check('surfacing failure is caught, never re-noted', /catch\s*\{\s*[^}]*\}/.test(noteBody) && !/noteSwallowedAuditFailure\(\s*\w*[Ee]rr/.test(noteBody));
}

// ── F. Wipe-path boundary (FT-06): clearAllData references are pinned ──
// clearAllData wipes business tables. It must never be reachable except
// through its definition, its repository delegation, and the guarded wipe
// (fresh native PIN + pre-wipe snapshot + DATA_WIPE_BEFORE, fail-closed).
// Anything else referencing it is an unguarded wipe path and fails the gate.
// Test/script files are exempt (harness scope, never production flows).
{
  const allowed = new Set([
    'db/adapters/maintenanceAdapter.ts', // definition (audit-excluding)
    'db/repositories/backupRepository.ts', // definition + delegation (+ dev-only seed gate)
    'db/wipeGuard.ts', // the guarded wipe (default clear path)
  ]);
  const refs = [];
  for (const f of tsFiles(SRC)) {
    const rel = f.slice(SRC.length + 1).split('\\').join('/');
    if (/\.test\.tsx?$/.test(rel) || /\.spec\.tsx?$/.test(rel)) continue;
    const src = readFileSync(f, 'utf8');
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/clearAllData\s*\(/.test(stripped) || /clearAllData\s*:/.test(stripped)) refs.push(rel);
  }
  console.log(`  clearAllData references: ${refs.length === 0 ? '(none)' : ''}`);
  for (const r of refs) console.log(`    - ${r}`);
  const extra = refs.filter((r) => !allowed.has(r));
  check(
    'clearAllData reachable only via definition, delegation, or guarded wipe',
    extra.length === 0,
    `extra: [${extra.join(', ')}]`
  );
  // seedDemoData (demo wipe via clearAllData) is DELETED (FT-06 follow-up
  // e): it had zero callers in dev or prod — only a definition, a store
  // action, and a type entry, all removed. Any reintroduction fails here.
  const seedRefs = [];
  for (const f of tsFiles(SRC)) {
    const rel = f.slice(SRC.length + 1).split('\\').join('/');
    const src = readFileSync(f, 'utf8');
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/seedDemoData/.test(stripped)) seedRefs.push(rel);
  }
  console.log(`  seedDemoData references in src: ${seedRefs.length === 0 ? '(none)' : ''}`);
  for (const r of seedRefs) console.log(`    - ${r}`);
  check(
    'seedDemoData does not exist in src (deleted dead wipe path)',
    seedRefs.length === 0,
    `got [${seedRefs.join(', ')}]`
  );
  const repo = read('db/repositories/backupRepository.ts');
  check('repository exposes no demo wipe', !/seedDemoData|bulkSaveProducts|bulkSaveCustomers/.test(repo));
}

// ── G. Dev-fold boundary (FT-06/B): isDevBuild must statically fold ──
// `seedDemoData` (wipe-adjacent) is dev-gated. The gate is only real if Vite
// replaces it with a compile-time constant: a cast or optional-chaining form
// (`(import.meta as …).env?.DEV`) defeats the fold and stays runtime-
// reachable. Pin the direct form in src, and — when a prod bundle exists —
// prove the fold happened in dist (same evidence pattern as
// test_bench_hook.mjs: marker present in src, absent-or-folded in dist).
{
  const gate = read('utils/auditGate.ts');
  const gateStripped = gate
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  check(
    'isDevBuild reads import.meta.env.DEV directly (foldable)',
    gateStripped.includes('import.meta.env.DEV'),
    'direct read missing'
  );
  check(
    'isDevBuild has no cast/optional-chain form (fold-defeating)',
    !gateStripped.includes('import.meta as') && !gateStripped.includes('env?.DEV'),
    'unfoldable form present'
  );
  const distAssets = join(ROOT, 'dist', 'assets');
  if (!existsSync(distAssets)) {
    console.log('  (dist/ absent — skipping bundle-fold proof; run `npx vite build` to check it)');
  } else {
    const chunks = readdirSync(distAssets).filter((f) => f.endsWith('.js'));
    const hay = chunks
      .map((f) => {
        try {
          return readFileSync(join(distAssets, f), 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');
    check('no import.meta.env survives in the prod bundle (folded)', !hay.includes('import.meta.env'));
    check('deleted seedDemoData ships nowhere in prod (no demo wipe path)', !hay.includes('seedDemoData'));
  }
}

// ── H. Checkpoint gate (FT-06/F1): the weak checkpoint is UI-only ──
// `checkpointWal()` (string message, result row discarded) exists for the
// maintenance UI button (non-destructive). Destructive paths — anything that
// snapshots before deleting — must use `checkpointWalStrict()` (busy === 0
// AND log === checkpointed). `checkpointWal(` below matches the weak call
// only: `checkpointWalStrict(` has no paren after `checkpointWal`.
// Allowed weak callers: the maintenance service (UI button) + tests.
{
  const weakCallers = [];
  for (const f of tsFiles(SRC)) {
    const rel = f.slice(SRC.length + 1).split('\\').join('/');
    if (/\.test\.tsx?$/.test(rel) || /\.spec\.tsx?$/.test(rel)) continue;
    const src = readFileSync(f, 'utf8');
    let stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (rel === 'db/adapters/maintenanceAdapter.ts') {
      // Definition site of both variants: drop the weak definition line so
      // only real USES count (the strict variant never matches this regex —
      // `checkpointWalStrict(` has no paren after `checkpointWal`).
      stripped = stripped.replace(/async checkpointWal\(\): Promise<string> \{/, '');
    }
    if (/checkpointWal\s*\(/.test(stripped)) weakCallers.push(rel);
  }
  console.log(`  weak checkpointWal() callers: ${weakCallers.length === 0 ? '(none)' : ''}`);
  for (const w of weakCallers) console.log(`    - ${w}`);
  const allowedWeak = new Set(['services/maintenanceService.ts']);
  const extra = weakCallers.filter((w) => !allowedWeak.has(w));
  check(
    'weak checkpointWal() reachable only from the maintenance service (never a destructive path)',
    extra.length === 0,
    `extra: [${extra.join(', ')}]`
  );
  const guard = read('db/wipeGuard.ts');
  check('guarded wipe uses checkpointWalStrict', guard.includes('checkpointWalStrict'));
}

console.log('');
if (!existsSync(join(SRC, 'db/adapters/operationsAdapter.ts'))) {
  console.error('  [FAIL] operationsAdapter.ts missing');
  failures += 1;
}
if (failures === 0) {
  console.log('RESULT: audit write-path boundary intact — no alternate write path.');
} else {
  console.error(`RESULT: ${failures} VIOLATION(S) — an alternate audit write path exists.`);
  process.exit(1);
}

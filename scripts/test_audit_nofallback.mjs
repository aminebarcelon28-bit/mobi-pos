#!/usr/bin/env node
/**
 * Audit no-fallback runtime test (Phase 4.5 WP2b).
 *
 * Drives the REAL `src/api/audit.ts` in Node (extensionless imports resolved
 * by scripts/ts-resolve-hook.mjs — resolution only, no code transformation):
 *
 *  R1. Counter mechanics: noteSwallowedAuditFailure increments a session
 *      total and returns it; getSwallowedAuditFailures agrees.
 *  R2. Failure path is real: auditAppend with no backend throws (Tauri `invoke`
 *      needs `window`), proving the funnel's catch branch is reachable — and
 *      the catch's note() call itself never throws or recurses even with the
 *      backend down (the surfacing report is fire-and-forget).
 *  R3. No alternate write: during the whole failure-handling sequence the
 *      module performs no other observable IPC — the only command names ever
 *      issued are the failed `audit_append` and the best-effort
 *      `audit_note_swallowed` report. (Proving no SECOND write path is taken
 *      structurally is the job of check-audit-boundary.mjs; here we prove at
 *      runtime that handling a failure issues no further writes.)
 *
 * R3 works because @tauri-apps/api/core reads its transport lazily per call:
 * we install `globalThis.window.__TAURI_INTERNALS__.invoke` as a recording
 * stub that throws for audit_append (simulating a down audit path) and
 * records everything. If a future change adds a fallback write, the command
 * log will show it and this test fails.
 *
 * Usage:
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_audit_nofallback.mjs
 * Exit: 0 = clean, 1 = failure(s)
 */
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures += 1;
    console.error(`  [FAIL] ${name} ${extra}`);
  }
}

console.log('========================================================================');
console.log('MOBIPOS — AUDIT NO-FALLBACK RUNTIME (Phase 4.5 WP2b)');
console.log('========================================================================\n');

// Recording stub transport: audit_append always fails (down audit path);
// everything invoked is logged for the no-alternate-write assertion.
const invoked = [];
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      invoked.push(cmd);
      if (cmd === 'audit_append') {
        throw new Error('simulated audit path down');
      }
      if (cmd === 'audit_note_swallowed') {
        return invoked.filter((c) => c === 'audit_note_swallowed').length;
      }
      throw new Error(`unexpected command ${cmd}`);
    },
  },
};

const audit = await import('../src/api/audit.ts');

console.log('== R1: counter mechanics (real module) ==');
check('counter starts at 0', audit.getSwallowedAuditFailures() === 0);
const n1 = audit.noteSwallowedAuditFailure('r1-probe');
check('first note returns 1', n1 === 1);
check('getter agrees', audit.getSwallowedAuditFailures() === 1);
// Let the fire-and-forget surfacing report settle.
await new Promise((r) => setTimeout(r, 50));

console.log('== R2: failure path + non-throwing note ==');
invoked.length = 0;
let threw = null;
try {
  await audit.auditAppend({ action: 'probe', details: 'probe-details' });
} catch (e) {
  threw = e;
}
check('auditAppend throws when the audit path is down', threw !== null);
let noteResult = null;
let noteThrew = null;
try {
  noteResult = audit.noteSwallowedAuditFailure('r2-failure-handling');
} catch (e) {
  noteThrew = e;
}
await new Promise((r) => setTimeout(r, 50));
check('note() never throws, even with backend down', noteThrew === null);
check('note() returns the running total', noteResult === 2);
check('getter agrees after failure handling', audit.getSwallowedAuditFailures() === 2);

console.log('== R3: no alternate write issued at runtime ==');
const writes = invoked.filter((c) => c !== 'audit_append' && c !== 'audit_note_swallowed');
check(
  'only audit_append + audit_note_swallowed were ever invoked',
  writes.length === 0,
  writes.length > 0 ? `unexpected: [${writes.join(', ')}]` : ''
);
check(
  'exactly one report for the R2 swallow (no retry storm, no fan-out)',
  invoked.filter((c) => c === 'audit_note_swallowed').length === 1,
  `log: [${invoked.join(', ')}]`
);

console.log('');
if (failures === 0) {
  console.log('RESULT: audit failure handling performs no alternate write.');
} else {
  console.error(`RESULT: ${failures} FAILURE(S).`);
  process.exit(1);
}

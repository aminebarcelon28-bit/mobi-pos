/**
 * IPC-011: audit IPC is timeout-bounded (audit never blocks primary flows).
 *
 * Behavioral half (no Tauri backend needed — `withTimeout` and the error
 * taxonomy are dependency-free): a hung IPC rejects within budget, a fast
 * one passes through, and the timeout maps to the IPC_TIMEOUT ApiError.
 * Static half (repo precedent: test_audit_gate.mts): the audit lane actually
 * wires the budgets into `invokeCommand`, which actually plumbs `timeoutMs`
 * through `withTimeout`.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTimeout } from '../src/db/writeMutex.ts';
import { ApiError, toApiError } from '../src/api/error.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

async function main() {
  // 1. Hung promise rejects within budget (never hangs the caller).
  {
    const start = Date.now();
    let err: unknown = null;
    try {
      await withTimeout(new Promise(() => {}), 60, 'ipc:audit_append');
    } catch (e) { err = e; }
    const elapsed = Date.now() - start;
    check('hung IPC rejects within budget', err instanceof Error && elapsed < 2000, `elapsed=${elapsed}ms`);
    check('timeout error names the lane', err instanceof Error && /ipc:audit_append/.test(err.message));
  }

  // 2. Fast promise passes through untouched (zero behavior change).
  {
    check('fast IPC passes through', (await withTimeout(Promise.resolve('receipt'), 5000)) === 'receipt');
    check('timeoutMs 0 disables (legacy unbounded)', (await withTimeout(Promise.resolve(1), 0)) === 1);
  }

  // 3. Timeout maps to the IPC_TIMEOUT ApiError (typed, display-safe French).
  {
    const mapped = toApiError(new Error('[ipc:audit_append] timed out after 8000ms'));
    check('timeout maps to IPC_TIMEOUT', mapped instanceof ApiError && mapped.code === 'IPC_TIMEOUT', mapped.code);
    check('IPC_TIMEOUT message is display-safe French', /Délai de communication/.test(mapped.message));
    const passthrough = new ApiError('DATABASE_BUSY', 'busy');
    check('existing ApiErrors pass through', toApiError(passthrough) === passthrough);
    check('non-timeout errors unaffected', toApiError(new Error('SQLITE_BUSY')).code === 'DATABASE_BUSY');
  }

  // 4. Wiring: the audit lane actually uses the budgets.
  {
    const audit = src('src/api/audit.ts');
    check('AUDIT_IPC_TIMEOUT_MS exported (8s > native 5s busy_timeout)', /export const AUDIT_IPC_TIMEOUT_MS = 8000/.test(audit));
    check('AUDIT_REPORT_TIMEOUT_MS exported', /export const AUDIT_REPORT_TIMEOUT_MS = 3000/.test(audit));
    check('auditAppend passes its budget', /timeoutMs: AUDIT_IPC_TIMEOUT_MS/.test(audit));
    check('swallow report passes its budget', /timeoutMs: AUDIT_REPORT_TIMEOUT_MS/.test(audit));
    const invoke = src('src/platform/invoke.ts');
    check('invokeCommand accepts timeoutMs opt', /opts\?: \{ timeoutMs\?: number \}/.test(invoke));
    check('invokeCommand plumbs withTimeout (0 = legacy unbounded)', /withTimeout\(invoke<TResult>\(command, args\), opts\?\.timeoutMs \?\? 0/.test(invoke));
  }

  console.log(`\naudit-ipc-timeout: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

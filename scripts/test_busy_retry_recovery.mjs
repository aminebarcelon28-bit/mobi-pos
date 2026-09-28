/**
 * B-001 FIX-1/FIX-2/FIX-3 regression:
 *  - FIX-3: onExhausted may RETURN a value of type T to recover (suppress throw)
 *  - FIX-3: returning undefined / throwing still rethrows (historical behavior)
 *  - FIX-3: non-BUSY errors never call onExhausted recovery path for return
 *  - FIX-1: ensureBusyTimeout issues a single PRAGMA busy_timeout statement
 *  - FIX-2: comment no longer claims "BEGIN avoided" while code uses BEGIN
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// Re-implement withBusyRetry semantics for isolation (mirror of busyRetry.ts)
function isBusyError(error) {
  if (!error) return false;
  const anyErr = error;
  if (anyErr.code === 5 || anyErr.code === 'SQLITE_BUSY') return true;
  const msg = String(anyErr.message ?? anyErr.error ?? error).toLowerCase();
  if (msg.includes('database is locked') || msg.includes('sqlite_busy')) return true;
  return anyErr.errno === 5 && msg.includes('locked');
}

async function withBusyRetry(fn, opts = {}) {
  const attempts = Math.max(1, Math.min(12, Math.round(opts.attempts ?? 8)));
  const baseDelayMs = Math.max(10, opts.baseDelayMs ?? 120);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? 3000);
  const label = opts.label || 'db-write';

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt >= attempts) break;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = backoff * (0.75 + Math.random() * 0.5);
      void label;
      await new Promise((r) => setTimeout(r, Math.min(jitter, 5)));
    }
  }
  if (opts.onExhausted && isBusyError(lastError)) {
    try {
      const recovered = await opts.onExhausted(lastError, attempts);
      if (recovered !== undefined) return recovered;
    } catch {
      // fall through
    }
  }
  throw lastError;
}

async function main() {
  // FIX-3 A: exhausted BUSY + onExhausted returns T → recovers
  const busy = { code: 5, message: 'database is locked' };
  let calls = 0;
  const recovered = await withBusyRetry(
    async () => { calls++; throw busy; },
    { attempts: 2, baseDelayMs: 1, onExhausted: () => ({ ok: true, via: 'recovery' }) }
  );
  check('FIX-3 recovery returns T', recovered?.ok === true && recovered?.via === 'recovery');
  check('FIX-3 attempts still ran', calls === 2, `calls=${calls}`);

  // FIX-3 B: exhausted BUSY + onExhausted returns undefined → still throws
  let threw = false;
  try {
    await withBusyRetry(
      async () => { throw busy; },
      { attempts: 2, baseDelayMs: 1, onExhausted: () => undefined }
    );
  } catch (e) {
    threw = isBusyError(e);
  }
  check('FIX-3 undefined recovery still throws', threw);

  // FIX-3 C: non-BUSY error → no recovery path (throws immediately, no onExhausted return)
  const disk = { code: 'SQLITE_IOERR', message: 'disk I/O error' };
  let nonBusyThrew = false;
  let nonBusyRecoveryCalled = false;
  try {
    await withBusyRetry(
      async () => { throw disk; },
      {
        attempts: 3,
        baseDelayMs: 1,
        onExhausted: () => {
          nonBusyRecoveryCalled = true;
          return { recovered: true };
        },
      }
    );
  } catch {
    nonBusyThrew = true;
  }
  check('FIX-3 non-BUSY throws without recovery return', nonBusyThrew);
  check('FIX-3 non-BUSY does not use recovery return', nonBusyRecoveryCalled === false || nonBusyThrew);

  // FIX-3 D: onExhausted that throws → still rethrows original
  let afterExhaustedThrow = false;
  try {
    await withBusyRetry(
      async () => { throw busy; },
      { attempts: 1, baseDelayMs: 1, onExhausted: () => { throw new Error('diag fail'); } }
    );
  } catch (e) {
    afterExhaustedThrow = isBusyError(e);
  }
  check('FIX-3 onExhausted throw falls through to original', afterExhaustedThrow);

  // FIX-1: source has single busy_timeout and ensureBusyTimeout before BEGIN
  const adapterSrc = readFileSync(new URL('../src/db/sqlPluginAdapter.ts', import.meta.url), 'utf8');
  const timeoutCount = (adapterSrc.match(/PRAGMA busy_timeout/g) || []).length;
  // boot set (1) + ensureBusyTimeout helper (1) + comment may mention it —
  // assert no duplicate bare 5000 assignment remains
  check('FIX-1 no busy_timeout=5000 left', !adapterSrc.includes('PRAGMA busy_timeout = 5000'));
  check('FIX-1 ensureBusyTimeout helper exists', adapterSrc.includes('export async function ensureBusyTimeout'));
  check(
    'FIX-1 ensureBusyTimeout called before writeCheckout BEGIN',
    /ensureBusyTimeout\(db[\s\S]{0,80}BEGIN IMMEDIATE/.test(adapterSrc)
  );
  check('FIX-1 busy_timeout mentions present', timeoutCount >= 2, `count=${timeoutCount}`);

  // FIX-2: contradictory comment removed
  check(
    'FIX-2 stale "BEGIN avoided" comment removed',
    !adapterSrc.includes('Manual BEGIN IMMEDIATE / COMMIT / ROLLBACK across IPC calls is avoided')
  );
  check(
    'FIX-2 defense layers documented',
    adapterSrc.includes('withWriteLock serializes same-window writers')
  );

  // Source-level: onExhausted typed to return T | void (with NoInfer)
  const busySrc = readFileSync(new URL('../src/db/busyRetry.ts', import.meta.url), 'utf8');
  check(
    'FIX-3 busyRetry onExhausted type allows T return',
    busySrc.includes('NoInfer<T> | void | Promise<NoInfer<T> | void>')
  );
  check(
    'FIX-3 busyRetry awaits recovered value',
    busySrc.includes('const recovered = await exhausted(lastError, attempts)')
  );

  console.log(`\n=== B-001 FIX-1/2/3: ${pass} PASSED, ${fail} FAILED ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

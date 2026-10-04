/**
 * Phase 2 (F1) — guarded restore tests.
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_restore_guard.mts
 *
 * Contract: validate BEFORE the PIN (malformed burns nothing) → fresh
 * native PIN (no window, no weak fallback) → checkpoint + snapshot under one
 * write lock → re-validate → DATA_RESTORE_BEFORE → proceed. Post-point-of-
 * no-return failure returns restore-failed WITH the snapshot reference
 * (manual runbook recovery, never auto-rollback); OK-row failure returns
 * completed-but-unaudited (same convention as the import path).
 */
let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failures += 1;
    console.error(`  [FAIL] ${name} ${extra}`);
  }
}

(globalThis as any).window = { __TAURI_INTERNALS__: {} };

const { requestDataRestore } = (await import('../src/db/restoreGuard.ts')) as typeof import('../src/db/restoreGuard.ts');

const MANAGER_PIN = '123456';
const okVerify = (pin: string) => async (_p: string, _o?: unknown) => ({
  ok: _p === pin,
  locked: false,
  lockedRemainingMs: 0,
  mustRotate: false,
  weaker: false,
  ...(_p === pin ? {} : { reason: 'denied' as const }),
});
const checkpointOk = async () => ({ ok: true, busy: 0, message: 'ok' });
const snapOk = (calls: string[], id = 'snap-restore.db') => async () => {
  calls.push('snapshot');
  return { success: true, snapshot: { id, bytes: 7, mtimeMs: 3, sha256: 'ee' } };
};
const jsonReq = (over: Record<string, unknown> = {}) => ({
  source: 'json-import' as const,
  sourceSha256: 'f'.repeat(64),
  payloadSummary: { version: '2.0', counts: { products: 1 } },
  actor: 'Manager',
  validate: async () => ({ ok: true as const }),
  proceed: async () => ({ success: true as const }),
  ...over,
});

// ── 1. Malformed payload refuses BEFORE the PIN (no budget burned) ──
{
  let pinCalled = false;
  const res = await requestDataRestore(
    jsonReq({ validate: async () => ({ ok: false as const, reason: 'truncated file' }) }),
    MANAGER_PIN,
    {
      isTauri: () => true,
      verifyPin: (async () => {
        pinCalled = true;
        return { ok: true, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false };
      }) as any,
    }
  );
  check('malformed payload refused pre-PIN', res.ok === false && (res as any).reason === 'invalid-payload');
  check('no PIN attempt on malformed payload', pinCalled === false);
}
{
  const res = await requestDataRestore(jsonReq({ sourceSha256: undefined }), MANAGER_PIN, {
    isTauri: () => true,
    verifyPin: okVerify(MANAGER_PIN) as any,
  });
  check('json-import without file hash refused pre-PIN', res.ok === false && (res as any).reason === 'invalid-payload');
}

// ── 2. Fresh PIN, no window, no weak fallback ──
{
  for (const [label, pin] of [['empty', ''], ['wrong', '000000']] as const) {
    const calls: string[] = [];
    const res = await requestDataRestore(jsonReq(), pin, {
      isTauri: () => true,
      verifyPin: okVerify(MANAGER_PIN) as any,
      checkpoint: async () => {
        calls.push('checkpoint');
        return checkpointOk();
      },
    });
    check(`refused without fresh PIN (${label})`, res.ok === false);
    check(`nothing called (${label})`, calls.length === 0, calls.join(','));
  }
  const weak = await requestDataRestore(jsonReq(), MANAGER_PIN, {
    isTauri: () => true,
    verifyPin: (async () => ({ ok: true, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: true })) as any,
  });
  check('weaker fallback refuses restore', weak.ok === false);
}

// ── 3. Full order: validate → PIN → checkpoint → snapshot → re-validate → BEFORE → proceed → OK ──
{
  const calls: string[] = [];
  let validates = 0;
  let beforeArg: any = null;
  let okArg: any = null;
  const res = await requestDataRestore(
    jsonReq({
      validate: async () => {
        validates += 1;
        calls.push('validate');
        return { ok: true as const };
      },
      proceed: async () => {
        calls.push('proceed');
        return { success: true as const };
      },
    }),
    MANAGER_PIN,
    {
      isTauri: () => true,
      verifyPin: (async (p: string, o: any) => {
        calls.push(`verify:weak=${String(o?.allowWeakFallback)}`);
        return { ok: p === MANAGER_PIN, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false };
      }) as any,
      lockWrites: (async <T,>(fn: () => Promise<T>): Promise<T> => fn()) as any,
      checkpoint: async () => {
        calls.push('checkpoint');
        return checkpointOk();
      },
      takeSnapshot: snapOk(calls),
      appendAudit: (async (req: any) => {
        calls.push(`append:${req.action}`);
        if (req.action === 'DATA_RESTORE_BEFORE') beforeArg = req;
        if (req.action === 'DATA_RESTORED_OK') okArg = req;
      }) as any,
    }
  );
  check('restore succeeds', res.ok === true && (res as any).auditOk === true);
  check(
    'strict order validate → PIN → checkpoint → snapshot → re-validate → BEFORE → proceed → OK',
    calls.join('|') ===
      'validate|verify:weak=false|checkpoint|snapshot|validate|append:DATA_RESTORE_BEFORE|proceed|append:DATA_RESTORED_OK',
    calls.join('|')
  );
  check('validated twice (pre-PIN + pre-point-of-no-return)', validates === 2);
  const before = JSON.parse(beforeArg.details);
  check(
    'BEFORE row carries source hash + snapshot id/sha + summary',
    before.source === 'json-import' &&
      before.sourceSha256 === 'f'.repeat(64) &&
      before.snapshotId === 'snap-restore.db' &&
      before.snapshotSha256 === 'ee' &&
      before.payloadSummary.version === '2.0',
    beforeArg.details
  );
  check('BEFORE row is PIN-flagged with actor', beforeArg.requiresPin === true);
  const okd = JSON.parse(okArg.details);
  check('OK row records completion for the same snapshot', okd.outcome === 'completed' && okd.snapshotId === 'snap-restore.db');
}

// ── 4. Post-point-of-no-return failure: restore-failed WITH receipt, no rollback ──
{
  const res = await requestDataRestore(
    jsonReq({ proceed: async () => ({ success: false as const, reason: 'merge blew up' }) }),
    MANAGER_PIN,
    {
      isTauri: () => true,
      verifyPin: okVerify(MANAGER_PIN) as any,
      checkpoint: checkpointOk,
      takeSnapshot: snapOk([]),
      appendAudit: (async () => {}) as any,
    }
  );
  check('post-point failure is restore-failed, not plain failure', res.ok === false && (res as any).reason === 'restore-failed');
  check('message carries the snapshot reference', String((res as any).message).includes('snap-restore.db'));
  check('receipt attached for manual recovery', (res as any).receipt?.snapshotId === 'snap-restore.db');
}

// ── 5. OK-row failure: completed-but-unaudited (not failure, not silent) ──
{
  let appends = 0;
  const res = await requestDataRestore(jsonReq(), MANAGER_PIN, {
    isTauri: () => true,
    verifyPin: okVerify(MANAGER_PIN) as any,
    checkpoint: checkpointOk,
    takeSnapshot: snapOk([]),
    appendAudit: (async () => {
      appends += 1;
      if (appends === 2) throw new Error('ok row down');
    }) as any,
  });
  check('completed-but-unaudited shape', res.ok === true && (res as any).auditOk === false);
  check('warning message present', String((res as any).message).includes('traçabilité'));
}

// ── 6. Cloud variant: remoteId, no file hash required ──
{
  const calls: string[] = [];
  const res = await requestDataRestore(
    {
      source: 'cloud-merge',
      remoteId: 'db-xyz.turso.io',
      actor: 'Manager',
      validate: async () => ({ ok: true as const }),
      proceed: async () => {
        calls.push('proceed');
        return { success: true as const };
      },
    },
    MANAGER_PIN,
    {
      isTauri: () => true,
      verifyPin: okVerify(MANAGER_PIN) as any,
      checkpoint: checkpointOk,
      takeSnapshot: snapOk([]),
      appendAudit: (async (req: any) => {
        if (req.action === 'DATA_RESTORE_BEFORE') calls.push(`before:${JSON.parse(req.details).remoteId}`);
      }) as any,
    }
  );
  check('cloud restore succeeds without file hash', res.ok === true);
  check('BEFORE row carries remoteId, no secrets', calls.includes('before:db-xyz.turso.io'), calls.join(','));
}

// ── 7. Outside Tauri fails closed ──
{
  const res = await requestDataRestore(jsonReq(), MANAGER_PIN, { isTauri: () => false });
  check('non-Tauri restore fails closed', res.ok === false && (res as any).reason === 'unavailable');
}

console.log('');
if (failures === 0) console.log('RESULT: restore guard intact.');
else {
  console.error(`RESULT: ${failures} FAILURE(S)`);
  process.exit(1);
}

/**
 * FT-06 evidence-preserving wipe tests (Track 1A).
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_audit_wipe.mts
 *
 * Covers (owner-required):
 * - wipe aborts when DATA_WIPE_BEFORE append fails (nothing deleted)
 * - snapshot failure aborts before append/wipe (ordering)
 * - wipe refused without a fresh native manager PIN
 * - outside Tauri the wipe fails closed (nothing called)
 * - audit tables survive every removal path (W1–W8 inventory)
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failures += 1;
    console.error(`  [FAIL] ${name} ${extra}`);
  }
}

(globalThis as any).window = { __TAURI_INTERNALS__: {} };

const { requestDataWipe } = (await import('../src/db/wipeGuard.ts')) as typeof import('../src/db/wipeGuard.ts');

const MANAGER_PIN = '123456';
function okVerify(pin: string) {
  return async (_p: string, _o?: unknown) => ({
    ok: _p === pin,
    locked: false,
    lockedRemainingMs: 0,
    mustRotate: false,
    weaker: false,
    ...( _p === pin ? {} : { reason: 'denied' as const }),
  });
}
// Default checkpoint stub: WAL fully checkpointed (busy=0). Tests that need
// failure use explicit fakes below.
const checkpointOk = async () => ({ ok: true, busy: 0, message: 'checkpoint ok' });

// ── 1. Abort when DATA_WIPE_BEFORE append fails ──
{
  const calls: string[] = [];
  const res = await requestDataWipe(MANAGER_PIN, {
    isTauri: () => true,
    verifyPin: okVerify(MANAGER_PIN) as any,
    checkpoint: checkpointOk,
    takeSnapshot: async () => {
      calls.push('snapshot');
      return { success: true, snapshot: { id: 'snap.db', bytes: 10, mtimeMs: 1, sha256: 'aa' } };
    },
    appendAudit: (async () => {
      calls.push('append');
      throw new Error('audit down');
    }) as any,
    clear: async () => {
      calls.push('clear');
    },
  });
  check('append failure aborts wipe', res.ok === false && (res as any).reason === 'audit-failed');
  check('nothing cleared on audit failure', !calls.includes('clear'), calls.join(','));
  check('snapshot precedes append', calls.indexOf('snapshot') < calls.indexOf('append'), calls.join(','));
}

// ── 2. Snapshot failure aborts before append/wipe ──
{
  const calls: string[] = [];
  const res = await requestDataWipe(MANAGER_PIN, {
    isTauri: () => true,
    verifyPin: okVerify(MANAGER_PIN) as any,
    checkpoint: checkpointOk,
    takeSnapshot: async () => {
      calls.push('snapshot');
      return { success: false, error: 'disk full' };
    },
    appendAudit: (async () => {
      calls.push('append');
    }) as any,
    clear: async () => {
      calls.push('clear');
    },
  });
  check('snapshot failure aborts wipe', res.ok === false && (res as any).reason === 'snapshot-failed');
  check('no append and no clear after snapshot failure', !calls.includes('append') && !calls.includes('clear'), calls.join(','));
}

// ── 3. Refused without a fresh native manager PIN ──
{
  for (const [label, pin] of [['empty PIN', ''], ['wrong PIN', '000000'], ['cashier-length PIN', '1111']] as const) {
    const calls: string[] = [];
    const res = await requestDataWipe(pin, {
      isTauri: () => true,
      verifyPin: okVerify(MANAGER_PIN) as any,
      takeSnapshot: async () => {
        calls.push('snapshot');
        return { success: true };
      },
      appendAudit: (async () => {
        calls.push('append');
      }) as any,
      clear: async () => {
        calls.push('clear');
      },
    });
    check(`refused without fresh PIN (${label})`, res.ok === false, JSON.stringify(res));
    check(`nothing called (${label})`, calls.length === 0, calls.join(','));
  }
  // Native lockout maps through.
  {
    const res = await requestDataWipe(MANAGER_PIN, {
      isTauri: () => true,
      verifyPin: (async () => ({ ok: false, locked: true, lockedRemainingMs: 60_000, mustRotate: false, weaker: false })) as any,
    checkpoint: checkpointOk,
      clear: async () => {
        throw new Error('must not clear');
      },
    });
    check('native lockout refuses wipe', res.ok === false && (res as any).reason === 'locked');
  }
  // Weaker fallback can never authorize a wipe.
  {
    const calls: string[] = [];
    const res = await requestDataWipe(MANAGER_PIN, {
      isTauri: () => true,
      verifyPin: (async () => ({ ok: true, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: true })) as any,
    checkpoint: checkpointOk,
      clear: async () => {
        calls.push('clear');
      },
    });
    check('weaker fallback refuses wipe', res.ok === false && calls.length === 0);
  }
}

// ── 4. Outside Tauri: fail closed, nothing called ──
{
  const calls: string[] = [];
  const res = await requestDataWipe(MANAGER_PIN, {
    isTauri: () => false,
    verifyPin: (async () => {
      calls.push('verify');
      return { ok: true, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false };
    }) as any,
    checkpoint: async () => {
      calls.push('checkpoint');
      return checkpointOk();
    },
    takeSnapshot: async () => {
      calls.push('snapshot');
      return { success: true };
    },
    appendAudit: (async () => {
      calls.push('append');
    }) as any,
    clear: async () => {
      calls.push('clear');
    },
  });
  check('non-Tauri wipe fails closed', res.ok === false && (res as any).reason === 'unavailable');
  check('non-Tauri wipe calls nothing', calls.length === 0, calls.join(','));
  check(
    'installed-app-only copy',
    res.ok === false && (res as any).message.includes('application installée')
  );
}

// ── 5. Success path order: verify → checkpoint → snapshot → DATA_WIPE_BEFORE → clear ──
{
  const calls: string[] = [];
  let appendArg: any = null;
  const res = await requestDataWipe(MANAGER_PIN, {
    isTauri: () => true,
    verifyPin: (async (p: string, o: any) => {
      calls.push(`verify:weak=${String(o?.allowWeakFallback)}`);
      return { ok: p === MANAGER_PIN, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false };
    }) as any,
    checkpoint: async () => {
      calls.push('checkpoint');
      return checkpointOk();
    },
    takeSnapshot: async () => {
      calls.push('snapshot');
      return { success: true, snapshot: { id: 'pre-wipe.db', bytes: 11, mtimeMs: 2, sha256: 'bb' } };
    },
    appendAudit: (async (req: any) => {
      calls.push(`append:${req.action}`);
      appendArg = req;
    }) as any,
    clear: async () => {
      calls.push('clear');
    },
  });
  check('success path ok + receipt', res.ok === true && (res as any).receipt.snapshotId === 'pre-wipe.db');
  check(
    'strict order verify → checkpoint → snapshot → append → clear',
    calls.join('|') === 'verify:weak=false|checkpoint|snapshot|append:DATA_WIPE_BEFORE|clear',
    calls.join('|')
  );
  check('fresh PIN never uses weak fallback', calls[0] === 'verify:weak=false');
  check('pre-wipe row carries snapshot + requiresPin', Boolean(appendArg) && appendArg.requiresPin === true && String(appendArg.details).includes('pre-wipe.db'));
  {
    const details = JSON.parse(String(appendArg.details));
    check(
      'pre-wipe row references filename id + integrity, never an absolute path',
      details.snapshotId === 'pre-wipe.db' && details.snapshotBytes === 11 && details.snapshotSha256 === 'bb' &&
        !String(appendArg.details).includes(':\\') && !String(appendArg.details).includes('/data/'),
      appendArg.details
    );
  }
}

// ── 6. Checkpoint fail-closed: busy/incomplete/throw blocks everything ──
{
  // Busy checkpoint: no snapshot, no append, no clear; message surfaced.
  {
    const calls: string[] = [];
    const res = await requestDataWipe(MANAGER_PIN, {
      isTauri: () => true,
      verifyPin: okVerify(MANAGER_PIN) as any,
      checkpoint: async () => {
        calls.push('checkpoint');
        return { ok: false, busy: 1, message: 'Checkpoint WAL incomplet (busy=1, 0/7 trames)' };
      },
      takeSnapshot: async () => {
        calls.push('snapshot');
        return { success: true };
      },
      appendAudit: (async () => {
        calls.push('append');
      }) as any,
      clear: async () => {
        calls.push('clear');
      },
    });
    check('busy checkpoint aborts wipe', res.ok === false && (res as any).reason === 'checkpoint-failed');
    check('busy checkpoint calls nothing after', calls.join('|') === 'checkpoint', calls.join('|'));
    check(
      'busy message surfaced to user',
      res.ok === false && (res as any).message.includes('busy=1') && (res as any).message.includes('effacement refusé')
    );
  }
  // Throwing checkpoint: same fail-closed shape.
  {
    const calls: string[] = [];
    const res = await requestDataWipe(MANAGER_PIN, {
      isTauri: () => true,
      verifyPin: okVerify(MANAGER_PIN) as any,
      checkpoint: async () => {
        calls.push('checkpoint');
        throw new Error('driver down');
      },
      takeSnapshot: async () => {
        calls.push('snapshot');
        return { success: true };
      },
      appendAudit: (async () => {
        calls.push('append');
      }) as any,
      clear: async () => {
        calls.push('clear');
      },
    });
    check('throwing checkpoint aborts wipe', res.ok === false && (res as any).reason === 'checkpoint-failed');
    check('throwing checkpoint calls nothing after', calls.join('|') === 'checkpoint', calls.join('|'));
  }
  // Causal ordering: the snapshot captures post-checkpoint state. The fake
  // checkpoint commits a WAL frame into the store; the fake snapshot reads
  // the store. If the snapshot ran first, the frame would be missing.
  {
    const store = new Map<string, string>();
    const seen: string[] = [];
    const res = await requestDataWipe(MANAGER_PIN, {
      isTauri: () => true,
      verifyPin: okVerify(MANAGER_PIN) as any,
      checkpoint: async () => {
        store.set('wal-frame-7', 'checkpointed');
        seen.push('checkpoint');
        return checkpointOk();
      },
      takeSnapshot: async () => {
        seen.push('snapshot');
        return { success: true, snapshot: { id: store.has('wal-frame-7') ? 'snap-with-frame.db' : 'snap-STALE.db', bytes: 1, mtimeMs: 1, sha256: 'cc' } };
      },
      appendAudit: (async () => {}) as any,
      clear: async () => {},
    });
    check(
      'snapshot contains post-checkpoint data',
      res.ok === true && (res as any).receipt.snapshotId === 'snap-with-frame.db',
      res.ok === true ? (res as any).receipt.snapshotId : JSON.stringify(res)
    );
  }
}

// ── 6b. Strictness rule as pure function (no live handle needed) ──
{
  const { evaluateCheckpointResult } = (await import('../src/db/adapters/maintenanceAdapter.ts')) as typeof import('../src/db/adapters/maintenanceAdapter.ts');
  check('full checkpoint ok', evaluateCheckpointResult([{ busy: 0, log: 7, checkpointed: 7 }]).ok === true);
  check('empty WAL ok (0/0 vacuous)', evaluateCheckpointResult([{ busy: 0, log: 0, checkpointed: 0 }]).ok === true);
  check('busy=1 refused', evaluateCheckpointResult([{ busy: 1, log: 7, checkpointed: 7 }]).ok === false);
  // THE mismatch case: busy=0 but frames remain — busy alone is not enough.
  const mismatch = evaluateCheckpointResult([{ busy: 0, log: 7, checkpointed: 4 }]);
  check('log!==checkpointed refused despite busy=0', mismatch.ok === false);
  check('mismatch message names the frames', mismatch.message.includes('4/7'));
  check('unreadable rows refused', evaluateCheckpointResult([]).ok === false);
  check('missing busy refused', evaluateCheckpointResult([{ log: 3 }]).ok === false);
  check('non-array refused', evaluateCheckpointResult(null).ok === false);
}

// ── 6c. Write-lock enclosure: the whole sequence holds one lock ──
{
  const events: string[] = [];
  const res = await requestDataWipe(MANAGER_PIN, {
    isTauri: () => true,
    verifyPin: okVerify(MANAGER_PIN) as any,
    lockWrites: (async <T,>(fn: () => Promise<T>): Promise<T> => {
      events.push('lock-enter');
      try {
        return await fn();
      } finally {
        events.push('lock-exit');
      }
    }) as any,
    checkpoint: async () => {
      events.push('checkpoint');
      return checkpointOk();
    },
    takeSnapshot: async () => {
      events.push('snapshot');
      return { success: true, snapshot: { id: 's.db', bytes: 1, mtimeMs: 1, sha256: 'dd' } };
    },
    appendAudit: (async () => {
      events.push('append');
    }) as any,
    clear: async () => {
      events.push('clear');
    },
  });
  check('locked wipe succeeds', res.ok === true);
  check(
    'one lock encloses checkpoint → snapshot → append → clear',
    events.join('|') === 'lock-enter|checkpoint|snapshot|append|clear|lock-exit',
    events.join('|')
  );
}

// ── 7. Follow-up e: seedDemoData is deleted (no dev or prod path wipes) ──
{
  const repo = readFileSync(join(ROOT, 'src/db/repositories/backupRepository.ts'), 'utf8');
  check('repository has no demo wipe', !repo.includes('seedDemoData'));
  const store = readFileSync(join(ROOT, 'src/store/slices/createUISlice.ts'), 'utf8');
  check('store has no demo seeding action', !store.includes('seedDemoData'));
  const types = readFileSync(join(ROOT, 'src/store/types.ts'), 'utf8');
  check('store contract has no demo seeding', !types.includes('seedDemoData'));
}

// ── 8. F3: backup audit history merges insert-only (fresh + existing device) ──
{
  const { mergeImportAuditHistory } = (await import('../src/db/adapters/maintenanceAdapter.ts')) as typeof import('../src/db/adapters/maintenanceAdapter.ts');
  const rowA = { id: 'AUD-old', timestamp: '2024-05-01T10:00:00.000Z', user: 'Yacine', action: 'Vente', details: 'd1', requiresPin: false, deviceId: 'TERM-X', ipAddress: '1.2.3.4' };
  const rowB = { id: 'AUD-new', timestamp: '2024-06-01T10:00:00.000Z', user: 'Amine', action: 'Remise', details: 'd2', requiresPin: true };
  const fakeDb = (initial: Map<string, unknown[]>) => ({
    store: initial,
    async execute(sql: string, params: unknown[]) {
      if (!/ON CONFLICT\(id\) DO NOTHING/i.test(sql)) throw new Error('must be INSERT-only');
      const id = String(params[0]);
      if (this.store.has(id)) return { rowsAffected: 0 };
      this.store.set(id, params);
      return { rowsAffected: 1 };
    },
  });
  const fakeMirror = (initial: Map<string, unknown>) => ({
    store: initial,
    async get(id: string) {
      return this.store.get(id);
    },
    async put(e: any) {
      this.store.set(e.id, e);
      return e.id;
    },
  });

  // Fresh device: everything lands with original timestamps.
  {
    const db = fakeDb(new Map());
    const mirror = fakeMirror(new Map());
    const res = await mergeImportAuditHistory([rowA, rowB], { getDb: async () => db, mirror });
    check('fresh device inserts backup history', res.inserted === 2 && res.kept === 0, JSON.stringify(res));
    check('original timestamps preserved', (db.store.get('AUD-old') as unknown[])[1] === rowA.timestamp);
    check('mirror lands without overwrite path', mirror.store.has('AUD-old') && mirror.store.has('AUD-new'));
  }

  // Hostile envelope provenance is forced: a backup row claiming
  // source:'local' still lands as 'imported' (SQLite params + Dexie put).
  {
    const db = fakeDb(new Map());
    const mirror = fakeMirror(new Map());
    const hostile = { ...rowB, id: 'AUD-hostile', source: 'local' };
    const res = await mergeImportAuditHistory([hostile], { getDb: async () => db, mirror });
    check('hostile source forced to imported', res.inserted === 1, JSON.stringify(res));
    check('SQLite params carry imported, never the envelope claim', (db.store.get('AUD-hostile') as unknown[])[8] === 'imported');
    check('Dexie put carries imported', (mirror.store.get('AUD-hostile') as any).source === 'imported');
  }

  // Existing device: same-id rows never overwrite (details + user kept).
  {
    const prior = ['AUD-old', '2024-05-01T10:00:00.000Z', 'Yacine', 'Vente', 'LOCAL-TRUTH', 0, 'TERM-X', '1.2.3.4'];
    const db = fakeDb(new Map([['AUD-old', prior]]));
    const mirror = fakeMirror(new Map([['AUD-old', { ...rowA, details: 'LOCAL-TRUTH' }]]));
    const tampered = { ...rowA, details: 'FORGED', user: 'Intrus' };
    const res = await mergeImportAuditHistory([tampered, rowB], { getDb: async () => db, mirror });
    check('existing row wins over backup row', res.kept === 1 && res.inserted === 1, JSON.stringify(res));
    check('authority row untouched', (db.store.get('AUD-old') as unknown[])[4] === 'LOCAL-TRUTH');
    check('mirror row untouched', (mirror.store.get('AUD-old') as any).details === 'LOCAL-TRUTH');
  }

  // Id-less rows skipped; non-array is a no-op; total failure throws.
  {
    const db = fakeDb(new Map());
    const res = await mergeImportAuditHistory([{ noid: 1 }, null, 42], { getDb: async () => db, mirror: fakeMirror(new Map()) });
    check('rows without id skipped', res.inserted === 0 && res.kept === 0, JSON.stringify(res));
    const empty = await mergeImportAuditHistory(undefined, { getDb: async () => db, mirror: fakeMirror(new Map()) });
    check('non-array input is a no-op', empty.received === 0 && empty.inserted === 0);
    let threw: unknown = null;
    try {
      await mergeImportAuditHistory([rowA], {
        getDb: async () => ({
          async execute() {
            throw new Error('db down');
          },
        }),
        mirror: fakeMirror(new Map()),
      });
    } catch (e) {
      threw = e;
    }
    check('total authority failure aborts (import refuses)', threw instanceof Error);
  }

  // Legacy schema fallback: full-column shape fails, legacy shape lands.
  {
    const store = new Map<string, unknown[]>();
    const db = {
      store,
      async execute(sql: string, params: unknown[]) {
        if (sql.includes('device_id')) throw new Error('no such column: device_id');
        const id = String(params[0]);
        if (store.has(id)) return { rowsAffected: 0 };
        store.set(id, params);
        return { rowsAffected: 1 };
      },
    };
    const res = await mergeImportAuditHistory([rowB], { getDb: async () => db, mirror: fakeMirror(new Map()) });
    check('legacy schema fallback inserts', res.inserted === 1, JSON.stringify(res));
  }
}

// ── 9. F6: dead restore code is gone, not lingering ──
{
  const apiBackup = readFileSync(join(ROOT, 'src/api/backup.ts'), 'utf8');
  check('dead restoreDatabaseBackup wrapper deleted', !apiBackup.includes('restoreDatabaseBackup'));
  check('dead swapStagingDatabase wrapper deleted', !apiBackup.includes('swapStagingDatabase'));
  check('live create/list backups kept', apiBackup.includes('createDatabaseBackup') && apiBackup.includes('listDatabaseBackups'));
  const backupMgr = readFileSync(join(ROOT, 'src/db/backupManager.ts'), 'utf8');
  check('dead restoreLocalDatabaseFile deleted', !backupMgr.includes('restoreLocalDatabaseFile'));
  check('dead backupManager.swapStagingDatabase deleted', !/export async function swapStagingDatabase/.test(backupMgr));
  check('dead restoreDexieSnapshot deleted', !backupMgr.includes('restoreDexieSnapshot') && !backupMgr.includes('DEXIE_SNAPSHOT_TABLES'));
  check('snapshot capture + pruning kept', backupMgr.includes('createPreMigrationBackup') && backupMgr.includes('purgeOldDexieSnapshots'));
}

// ── 10. Removal-path inventory: audit survives every path ──
{
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const maint = strip(readFileSync(join(ROOT, 'src/db/adapters/maintenanceAdapter.ts'), 'utf8'));

  // W1: clearAllData — neither lane touches audit.
  const clearBody = maint.slice(maint.indexOf('async clearAllData'));
  const clearSql = clearBody.slice(0, clearBody.indexOf('await Promise.all'));
  check('W1 SQLite wipe excludes security_audit_logs', !clearSql.includes('security_audit_logs'));
  check('W1 SQLite wipe excludes audit_chain', !clearSql.includes('audit_chain'));
  check('W1 Dexie wipe excludes securityAuditLogs', !clearBody.includes('securityAuditLogs.clear'));

  // W2: importJSON mirror — audit never replaced, merged insert-only.
  check('W2 import skips audit mirror replace', !maint.includes('securityAuditLogs.clear') && !maint.includes('securityAuditLogs.bulkPut'));
  check('W2 import merges audit history insert-only', maint.includes('mergeImportAuditHistory(parsedDatabase.securityAuditLogs)'));

  // W3: authority import lane — stale audit rows never re-enqueued.
  check('W3 import skips audit_log enqueue lane', !maint.includes("'audit_log'"));

  // W4: Dexie snapshot restore helper deleted (had zero callers).
  const backup = readFileSync(join(ROOT, 'src/db/backupManager.ts'), 'utf8');
  check('W4 snapshot restore helper deleted', !backup.includes('restoreDexieSnapshot'));

  // W5: cloud restore merges audit INSERT-only via the shared path.
  const restore = readFileSync(join(ROOT, 'src/sync/restoreManager.ts'), 'utf8');
  const generic = readFileSync(join(ROOT, 'src/sync/genericApply.ts'), 'utf8');
  check('W5 cloud restore uses shared apply path', restore.includes('applyGenericRemoteRow'));
  check('W5 shared path is INSERT-only for audit', generic.includes('ON CONFLICT(id) DO NOTHING'));

  // W6: native file restore/swap commands do not exist (removed Phase 4.4).
  const libRs = readFileSync(join(ROOT, 'src-tauri/src/lib.rs'), 'utf8');
  check('W6 native file restore/swap removed', libRs.includes('REMOVED (Phase 4.4)'));

  // W8: cursor repair touches cursors only.
  const repair = strip(readFileSync(join(ROOT, 'src/sync/repairResync.ts'), 'utf8'));
  check('W8 repair touches no audit table', !repair.includes('security_audit_logs') && !repair.includes('audit_chain'));

  // F3 heal gate: the self-heal list must carry the source column — a future
  // table rebuild (Rust CREATE or otherwise) that drops it would silently
  // lose provenance. The covering mechanism is pinned here.
  const heal = readFileSync(join(ROOT, 'src/db/sqlPluginAdapter.ts'), 'utf8');
  check(
    'source column pinned in self-heal list',
    heal.includes("ADD COLUMN source TEXT NOT NULL DEFAULT 'local'"),
    'heal ALTER missing — provenance would be lost on rebuild'
  );

  // Guard itself: audit tables named as preserved.
  const guard = readFileSync(join(ROOT, 'src/db/wipeGuard.ts'), 'utf8');
  check('guard documents audit preservation', guard.includes('security_audit_logs') && guard.includes('audit_chain'));
}

console.log('');
if (failures === 0) console.log('RESULT: FT-06 wipe intact.');
else {
  console.error(`RESULT: ${failures} FAILURE(S)`);
  process.exit(1);
}

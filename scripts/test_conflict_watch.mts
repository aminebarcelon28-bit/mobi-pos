/**
 * Conflict observation lane (A3: SYNC-005 "zero silent conflicts") — tests
 * for src/sync/conflictWatch.ts (+ canonical projection in causalVersion.ts).
 *
 * A fake in-memory driver stands in for plugin-sql: it implements the same
 * (sql, args) convention and emulates CREATE / SELECT-existing / INSERT OR
 * IGNORE semantics positionally, so the suite executes the module's REAL
 * statements (including the canonical SQL shapes) without a backend.
 */
import {
  canonicalProjection,
  projectionFingerprint,
} from '../src/sync/causalVersion.ts';
import {
  conflictAuditKey,
  conflictRecordId,
  ensureConflictTable,
  guardMissNeedsObservation,
  observePullGuardMiss,
  observeVersionConflict,
  planLedgerDelete,
  type ConflictDb,
} from '../src/sync/conflictWatch.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

interface StoredRow {
  id: string; table: string; row: string; lfp: string; ifp: string;
  winner: string;
}

function makeFakeDb() {
  const state = {
    created: false,
    rows: new Map<string, StoredRow>(),
    selects: 0,
    inserts: 0,
  };
  const db: ConflictDb = {
    select: async (sql: string, args: unknown[] = []) => {
      state.selects += 1;
      if (sql.startsWith('SELECT id FROM sync_conflicts')) {
        const [table, row, lfp, ifp] = args as string[];
        const hit = [...state.rows.values()].filter(
          (r) => r.table === table && r.row === row && r.lfp === lfp && r.ifp === ifp,
        );
        return hit.map((r) => ({ id: r.id }));
      }
      return [];
    },
    execute: async (sql: string, args: unknown[] = []) => {
      if (sql.startsWith('CREATE TABLE')) { state.created = true; return 0; }
      if (sql.startsWith('CREATE INDEX')) return 0;
      if (sql.startsWith('INSERT INTO sync_conflicts')) {
        state.inserts += 1;
        // Positional mapping mirrors the INSERT column order in conflictWatch.ts:
        // id,table,row,lv,iv,ld,idev,lfp,ifp,winner,at,resolved,note
        const [id, table, row, , , , , lfp, ifp, winner] = args as string[];
        if (state.rows.has(id)) return 0; // ON CONFLICT DO NOTHING
        state.rows.set(id, { id, table, row, lfp, ifp, winner });
        return 1;
      }
      return 0;
    },
  };
  return { db, state };
}

function makeAudit() {
  const calls: Array<{ action: string; details: string }> = [];
  return {
    calls,
    sink: async (action: string, details: string) => { calls.push({ action, details }); },
  };
}

const base = {
  table: 'transactions',
  id: 'TX-1',
  localVersion: 6,
  incomingVersion: 6,
  localDevice: 'till-01',
  incomingDevice: 'till-02',
  at: '2026-01-01T00:00:00.000Z',
};

async function main() {
  // 1. Canonical projection drops volatile metadata only.
  {
    const p = canonicalProjection({ total: 100, updated_at: 't1', sync_status: 'x', device_id: 'd', nested: { a: 1, updated_at: 't2' } });
    check('projection drops volatile top-level keys', !('updated_at' in p) && !('sync_status' in p) && !('device_id' in p));
    check('projection keeps money fields', (p as { total: number }).total === 100);
    check('projection drops volatile nested keys', !('updated_at' in (p.nested as Record<string, unknown>)));
    check('extraVolatile honored', !('custom' in canonicalProjection({ custom: 1 }, ['custom'])));
    check('projection fingerprint stable', projectionFingerprint({ b: 2, a: 1 }) === projectionFingerprint({ a: 1, b: 2 }));
  }

  // 2. Divergent equal versions → recorded + audited with convergence key.
  {
    const { db, state } = makeFakeDb();
    const audit = makeAudit();
    const out = await observeVersionConflict(db, audit.sink, {
      ...base,
      localPayload: { total: 100, updated_at: 't1' },
      incomingPayload: { total: 200, updated_at: 't2' },
    });
    check('divergent tie → recorded', out === 'recorded');
    check('table ensured', state.created === true);
    check('one row stored', state.rows.size === 1);
    const row = [...state.rows.values()][0];
    check('winner follows device tiebreak (till-02)', row.winner === 'incoming', `winner=${row.winner}`);
    check('audit filed once with convergence key',
      audit.calls.length === 1 && audit.calls[0].details.includes('AUDIT-CONFLICT-'));
    check('record id deterministic',
      row.id === conflictRecordId('transactions', 'TX-1',
        projectionFingerprint({ total: 100 }), projectionFingerprint({ total: 200 })));
  }

  // 3. Same content, volatile-only diff → identical, nothing stored/filed.
  {
    const { db, state } = makeFakeDb();
    const audit = makeAudit();
    const out = await observeVersionConflict(db, audit.sink, {
      ...base,
      localPayload: { total: 100, updated_at: 't1', sync_status: 'pending' },
      incomingPayload: { total: 100, updated_at: 't2', sync_status: 'synced' },
    });
    check('volatile-only diff → identical', out === 'identical');
    check('identical stores nothing', state.rows.size === 0 && audit.calls.length === 0);
  }

  // 4. Repeat observation → duplicate, audit still once.
  {
    const { db } = makeFakeDb();
    const audit = makeAudit();
    const obs = { ...base, localPayload: { total: 100 }, incomingPayload: { total: 200 } };
    const first = await observeVersionConflict(db, audit.sink, obs);
    const second = await observeVersionConflict(db, audit.sink, obs);
    check('first records', first === 'recorded');
    check('repeat is duplicate', second === 'duplicate');
    check('audit filed exactly once', audit.calls.length === 1);
  }

  // 5. Version mismatch is the version guard's job → skipped, table untouched.
  {
    const { db, state } = makeFakeDb();
    const audit = makeAudit();
    const out = await observeVersionConflict(db, audit.sink, {
      ...base, localVersion: 5, localPayload: { total: 1 }, incomingPayload: { total: 2 },
    });
    check('version mismatch → skipped', out === 'skipped');
    check('skipped before table ensure', state.created === false && audit.calls.length === 0);
  }

  // 6. Infrastructure failure never propagates.
  {
    const boom: ConflictDb = {
      select: async () => { throw new Error('down'); },
      execute: async () => { throw new Error('down'); },
    };
    let threw = false;
    let out = '';
    try {
      // Differing payloads: identical content would short-circuit to
      // 'identical' before any I/O — the db must actually be reached here.
      out = await observeVersionConflict(boom, async () => {}, { ...base, localPayload: { total: 1 }, incomingPayload: { total: 2 } });
    } catch { threw = true; }
    check('throwing db → skipped, never throws', threw === false && out === 'skipped');
    const { db } = makeFakeDb();
    const out2 = await observeVersionConflict(db, async () => { throw new Error('audit down'); }, {
      ...base, localPayload: { total: 1 }, incomingPayload: { total: 2 },
    });
    check('throwing audit sink → still recorded', out2 === 'recorded');
  }

  // 7. Guard-miss gate: observe only proven misses on equal versions.
  {
    const local = { version: 6 };
    check('affected>0 → no observation', guardMissNeedsObservation({ affectedRaw: 1, local, incomingVersion: 6 }) === false);
    check('indeterminate driver result → no observation',
      guardMissNeedsObservation({ affectedRaw: {}, local, incomingVersion: 6 }) === false);
    check('missing local row → no observation',
      guardMissNeedsObservation({ affectedRaw: 0, local: null, incomingVersion: 6 }) === false);
    check('version mismatch → no observation',
      guardMissNeedsObservation({ affectedRaw: 0, local, incomingVersion: 7 }) === false);
    check('miss on equal versions → observe',
      guardMissNeedsObservation({ affectedRaw: 0, local, incomingVersion: 6 }) === true);
    check('object-shaped zero → observe',
      guardMissNeedsObservation({ affectedRaw: { rowsAffected: 0 }, local, incomingVersion: 6 }) === true);
  }

  // 8. Shared pull-lane wiring delegates through gate + observation.
  {
    const mkInput = (affectedRaw: unknown, version: number) => ({
      table: 'transactions',
      id: 'TX-9',
      affectedRaw,
      local: { version: 6, device: 'till-01', comparable: { total: 100 } },
      incoming: { version, device: 'till-02', comparable: { total: 200 } },
      at: '2026-01-01T00:00:00.000Z',
    });
    const { db, state } = makeFakeDb();
    const audit = makeAudit();
    check('wiring records on proven miss',
      (await observePullGuardMiss(db, audit.sink, mkInput(0, 6))) === 'recorded' && state.rows.size === 1);
    check('wiring skips applied rows (no db touch)',
      (await observePullGuardMiss(db, audit.sink, mkInput(1, 6))) === 'skipped');
    const { db: db2 } = makeFakeDb();
    check('wiring identical content → identical',
      (await observePullGuardMiss(db2, audit.sink, {
        ...mkInput(0, 6),
        local: { version: 6, device: 'till-01', comparable: { total: 200 } },
      })) === 'identical');
    const boom: ConflictDb = {
      select: async () => { throw new Error('down'); },
      execute: async () => { throw new Error('down'); },
    };
    let threw = false;
    try {
      await observePullGuardMiss(boom, audit.sink, mkInput(0, 6));
    } catch { threw = true; }
    check('wiring never throws', threw === false);
  }

  // 9. Push-side divergence: columnar row-vs-row comparison.
  {
    const { observePushDivergence } = await import('../src/sync/conflictWatch.ts');
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'TX-1', version: 6, device_id: 'till-01', status: 'COMPLETED',
      total: 100, created_at: 't1', updated_at: 't1', sync_status: 'x', ...over,
    });
    const noopAudit = async () => {};
    {
      // Equal versions, divergent money → recorded.
      const { db, state } = makeFakeDb();
      const out = await observePushDivergence(db, noopAudit, {
        table: 'transactions', id: 'TX-1',
        localRow: row(), remoteRow: row({ device_id: 'till-02', total: 200 }),
      });
      check('push tie loss with divergent total → recorded', out === 'recorded' && state.rows.size === 1);
    }
    {
      // Unequal versions → newer-wins path, not a conflict.
      const { db, state } = makeFakeDb();
      const out = await observePushDivergence(db, noopAudit, {
        table: 'transactions', id: 'TX-1',
        localRow: row({ version: 5 }), remoteRow: row({ version: 6, total: 200 }),
      });
      check('version mismatch → skipped before table ensure', out === 'skipped' && state.created === false);
    }
    {
      // created_at-only drift (clock skew) is not a conflict.
      const { db, state } = makeFakeDb();
      const out = await observePushDivergence(db, noopAudit, {
        table: 'transactions', id: 'TX-1',
        localRow: row({ created_at: 't1' }), remoteRow: row({ created_at: 't2', device_id: 'till-01' }),
      });
      check('created_at-only drift → identical', out === 'identical' && state.rows.size === 0);
    }
    {
      // Missing rows → skipped, never throws.
      const { db } = makeFakeDb();
      let threw = false;
      try {
        const a = await observePushDivergence(db, noopAudit, { table: 't', id: 'x', localRow: null, remoteRow: row() });
        const b = await observePushDivergence(db, noopAudit, { table: 't', id: 'x', localRow: row(), remoteRow: null });
        check('null rows → skipped', a === 'skipped' && b === 'skipped');
      } catch { threw = true; }
      check('null rows never throw', threw === false);
    }
  }

  // 10. Ledger-delete planner: reverse / pending / noop.
  {
    const base = {
      original: { id: 'LED-1', product_id: 'P', delta: 5, version: 4 },
      reversalExists: false, incomingVersion: 6, deleterDevice: 'till-02', now: '2026-01-01T00:00:00.000Z',
    };
    const r = planLedgerDelete(base);
    check('normal delete → reverse with negated delta',
      r.action === 'reverse' && r.reversal.delta === -5 && r.reversal.id === 'REV-LED-1' &&
      r.reversal.reason === 'VOID' && r.reversal.ref_id === 'LED-1' &&
      r.reversal.idempotency_key === 'REV-LED-1' && r.reversal.version === 6);
    check('existing reversal → noop',
      planLedgerDelete({ ...base, reversalExists: true }).action === 'noop');
    check('missing original → pending (never silently dropped)',
      planLedgerDelete({ ...base, original: null }).action === 'pending');
    check('stale delete (v3 vs row v5) → noop',
      planLedgerDelete({ ...base, incomingVersion: 3 }).action === 'noop');
    check('equal versions → reverse (delete-wins-ties)',
      planLedgerDelete({ ...base, incomingVersion: 4 }).action === 'reverse');
    // Garbage version on a delete: fail closed (noop) rather than mutating
    // books on unreadable intent. The row stays; the delete stays visible
    // upstream for repair.
    check('NaN incoming version → noop (fail closed)',
      planLedgerDelete({ ...base, incomingVersion: Number.NaN }).action === 'noop');
  }

  // 11. Keys sanitized + deterministic; ensure is idempotent.
  {
    check('record id sanitizes hostile input',
      conflictRecordId('trans actions', 'TX/1', 'AA', 'BB') === 'CONFLICT-transactions-TX1-AA-BB');
    check('audit key deterministic',
      conflictAuditKey('t', 'i', 'AA', 'BB') === conflictAuditKey('t', 'i', 'AA', 'BB'));
    const { db, state } = makeFakeDb();
    await ensureConflictTable(db);
    await ensureConflictTable(db);
    check('ensure idempotent', state.created === true);
  }

  console.log(`\nconflict-watch: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

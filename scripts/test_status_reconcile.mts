/**
 * Boot/post-pull status reconciler (C1: DB-011) — decision-table tests for
 * src/db/statusReconcile.ts with in-memory fakes. No Dexie, SQLite, Tauri.
 *
 * Proves: authority-terminal heals the mirror (fields preserved) + audits;
 * agreement and missing rows are untouched; mirror-ahead NEVER writes money
 * state (alert only); broken stores resolve to zeros without throwing.
 */
import {
  isTerminalStatus,
  reconcileTransactionStatus,
} from '../src/db/statusReconcile.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

function makeStores(
  sqlite: Array<{ id: string; status?: unknown }>,
  dexie: Array<Record<string, unknown>>,
) {
  const mirror = new Map<string, Record<string, unknown>>(dexie.map((r) => [String(r.id), { ...r }]));
  const audits: Array<{ action: string; details: string }> = [];
  let puts = 0;
  return {
    audits,
    puts: () => puts,
    mirror,
    stores: {
      sqliteRows: sqlite,
      dexieRows: dexie.map((r) => ({ id: String(r.id), status: r.status })),
      getDexieFull: async (id: string) => mirror.get(id),
      putDexie: async (row: { id: string } & Record<string, unknown>) => {
        puts += 1;
        mirror.set(String(row.id), { ...row });
      },
      fileAudit: async (action: string, details: string) => { audits.push({ action, details }); },
    },
  };
}

async function main() {
  check('terminal predicate', isTerminalStatus('VOIDED') && isTerminalStatus('PARTIALLY_REFUNDED') && !isTerminalStatus('COMPLETED') && !isTerminalStatus(undefined));

  // 1. Forward heal preserves fields and audits.
  {
    const f = makeStores(
      [{ id: 'T1', status: 'VOIDED' }],
      [{ id: 'T1', status: 'COMPLETED', total: 500, custom: 'keep' }],
    );
    const out = await reconcileTransactionStatus(f.stores);
    check('authority-terminal heals mirror', out.healed.length === 1 && out.healed[0] === 'T1');
    const row = f.mirror.get('T1') as Record<string, unknown>;
    check('heal flips status only', row.status === 'VOIDED' && row.total === 500 && row.custom === 'keep');
    check('heal audits once', f.audits.length === 1 && /T1/.test(f.audits[0].details));
    check('no reverse alert on healed row', out.alerts.length === 0);
  }

  // 2. Agreement, non-terminal authority, missing rows: untouched.
  {
    const f = makeStores(
      [
        { id: 'A', status: 'VOIDED' },
        { id: 'B', status: 'COMPLETED' },
        { id: 'C', status: 'REFUNDED' },
      ],
      [
        { id: 'A', status: 'VOIDED' },
        { id: 'B', status: 'COMPLETED' },
        { id: 'D', status: 'COMPLETED' },
      ],
    );
    const out = await reconcileTransactionStatus(f.stores);
    check('agreement heals nothing, alerts nothing', out.healed.length === 0 && out.alerts.length === 0);
    check('missing dexie row skipped (remirror territory)', f.puts() === 0);
    check('terminal count checked', out.checked === 2, `checked=${out.checked}`);
  }

  // 3. Reverse direction alerts without writing.
  {
    const f = makeStores(
      [{ id: 'X', status: 'COMPLETED' }],
      [{ id: 'X', status: 'VOIDED', total: 700 }],
    );
    const out = await reconcileTransactionStatus(f.stores);
    check('mirror-ahead alerts', out.alerts.length === 1 && out.alerts[0] === 'X');
    check('mirror-ahead never writes money state', f.puts() === 0);
    const row = f.mirror.get('X') as Record<string, unknown>;
    check('mirror row untouched', row.status === 'VOIDED' && row.total === 700);
    check('alert audited', f.audits.length === 1);
  }
  {
    const f = makeStores([], [{ id: 'Y', status: 'REFUNDED' }]);
    const out = await reconcileTransactionStatus(f.stores);
    check('mirror-terminal + authority missing alerts without writing',
      out.alerts.length === 1 && f.puts() === 0);
  }

  // 4. Malformed rows skipped; authority without status still alerts.
  {
    const f = makeStores(
      [{ id: '', status: 'VOIDED' }, { id: 'Z' } as { id: string },
      ] as Array<{ id: string; status?: unknown }>,
      [{ id: 'Z', status: 'VOIDED' }],
    );
    const out = await reconcileTransactionStatus(f.stores);
    // Empty ids skipped; Z (mirror terminal vs status-less authority row)
    // alerts — an unknown authority state must not silence a terminal mirror.
    check('empty ids skipped, unknown authority alerts',
      out.healed.length === 0 && out.alerts.length === 1 && out.alerts[0] === 'Z');
  }
  {
    const throwing = {
      sqliteRows: [{ id: 'T', status: 'VOIDED' }],
      dexieRows: [{ id: 'T', status: 'COMPLETED' }],
      getDexieFull: async () => { throw new Error('down'); },
      putDexie: async () => { throw new Error('down'); },
      fileAudit: async () => { throw new Error('down'); },
    };
    let threw = false;
    let out = { checked: -1, healed: ['x'], alerts: ['y'] };
    try {
      out = await reconcileTransactionStatus(throwing);
    } catch { threw = true; }
    check('broken stores never throw, report zeros', threw === false && out.healed.length === 0 && out.alerts.length === 0);
  }

  console.log(`\nstatus-reconcile: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

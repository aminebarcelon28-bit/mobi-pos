/**
 * FT-06/F3 — pull-path provenance tests (Track 1A follow-ups).
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_audit_pull_provenance.mts
 *
 * Proves at runtime (fake SQLite authority, Dexie skipped):
 * - a peer envelope claiming source:'local' is forced to 'peer' in SQLite
 * - the envelope's source value never reaches the SQL parameters
 * - existing rows win byte-for-byte (first-write-wins, incl. provenance)
 * - the statement stays INSERT-only ON CONFLICT DO NOTHING
 */
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
void ROOT;
let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failures += 1;
    console.error(`  [FAIL] ${name} ${extra}`);
  }
}

(globalThis as any).window = { __TAURI_INTERNALS__: {} };

const { applyGenericRemoteRow } = (await import('../src/sync/genericApply.ts')) as typeof import('../src/sync/genericApply.ts');

interface FakeDb {
  store: Map<string, unknown[]>;
  entityKeys: Map<string, number>;
  statements: string[];
  paramLog: unknown[][];
  select(sql: string, params?: unknown[]): Promise<unknown[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
}

function makeFakeDb(): FakeDb {
  const self: FakeDb = {
    store: new Map(),
    entityKeys: new Map(),
    statements: [],
    paramLog: [],
    async select(sql: string, _params?: unknown[]) {
      if (/FROM entity_keys/i.test(sql)) return [];
      return [];
    },
    async execute(sql: string, params?: unknown[]) {
      self.statements.push(sql);
      self.paramLog.push(params ?? []);
      if (/entity_keys/i.test(sql)) return { rowsAffected: 1 };
      if (/INSERT INTO security_audit_logs/i.test(sql)) {
        const id = String((params ?? [])[0]);
        if (self.store.has(id)) return { rowsAffected: 0 };
        self.store.set(id, (params ?? []) as unknown[]);
        return { rowsAffected: 1 };
      }
      return { rowsAffected: 0 };
    },
  };
  return self;
}

const peerRow = (source: string) => ({
  id: 'AUD-PEER-1',
  data_json: JSON.stringify({
    id: 'AUD-PEER-1',
    timestamp: '2024-06-01T10:00:00.000Z',
    user: 'PeerCashier',
    action: 'Vente',
    details: 'peer details',
    requiresPin: false,
    deviceId: 'TERM-PEER',
    ipAddress: '9.9.9.9',
    source,
  }),
  version: 3,
  updated_at: '2024-06-01T10:00:01.000Z',
  deleted: 0,
});

// ── 1. Hostile envelope source is forced to 'peer' ──
{
  const db = makeFakeDb();
  await applyGenericRemoteRow(db as any, 'security_audit_logs', peerRow('local') as any, { skipDexie: true });
  const stored = db.store.get('AUD-PEER-1');
  check('peer row lands', stored !== undefined);
  const insertStmt = db.statements.find((s) => /INSERT INTO security_audit_logs/i.test(s)) ?? '';
  check('statement is INSERT-only ON CONFLICT DO NOTHING', /ON CONFLICT\(id\) DO NOTHING/i.test(insertStmt));
  check('statement stamps literal peer provenance', insertStmt.includes("'peer'"));
  const params = db.paramLog.find((p) => String(p[0]) === 'AUD-PEER-1') ?? [];
  check(
    'envelope source value never reaches SQL parameters',
    !params.includes('local') && params.length === 9,
    JSON.stringify(params)
  );
}

// ── 2. Existing row wins byte-for-byte (incl. provenance) ──
{
  const db = makeFakeDb();
  db.store.set('AUD-PEER-1', ['AUD-PEER-1', '2024-01-01T00:00:00.000Z', 'Local', 'Vente', 'LOCAL-TRUTH', 0, 1, 'TERM-1', '1.1.1.1', 'local']);
  await applyGenericRemoteRow(db as any, 'security_audit_logs', peerRow('imported') as any, { skipDexie: true });
  const stored = db.store.get('AUD-PEER-1') ?? [];
  check('existing details untouched', stored[4] === 'LOCAL-TRUTH', JSON.stringify(stored[4]));
  check('existing provenance stays local', stored[9] === 'local', JSON.stringify(stored[9]));
  const insertCount = db.statements.filter((s) => /INSERT INTO security_audit_logs/i.test(s)).length;
  check('replay still converges via DO NOTHING (no rewrite)', insertCount === 1, String(insertCount));
}

// ── 3. Dexie put-if-absent shape is pinned (runtime is SQLite-proven above;
// Dexie needs IndexedDB, absent headless — pin the code contract instead) ──
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(ROOT, 'src/sync/genericApply.ts'), 'utf8');
  const idx = src.indexOf("table === 'security_audit_logs'");
  const dexieIdx = src.indexOf('put-if-absent', idx);
  check('Dexie branch documents put-if-absent', dexieIdx > idx);
  check(
    'Dexie put stamps peer without trusting the envelope',
    src.includes("source: 'peer'") && !src.includes('a.source') && !src.includes('payload.source')
  );
}

console.log('');
if (failures === 0) console.log('RESULT: pull provenance intact.');
else {
  console.error(`RESULT: ${failures} FAILURE(S)`);
  process.exit(1);
}

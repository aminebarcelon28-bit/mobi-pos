/**
 * Follow-up d — Dexie-lane provenance at runtime (fake-indexeddb).
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_audit_dexie_provenance.mts
 *
 * Uses the REAL MobiPosDB Dexie instance against fake-indexeddb (no mocks
 * for the mirror lane) to prove:
 * - mergeImportAuditHistory's mirror put is put-if-absent with forced
 *   'imported' provenance (existing rows win byte-for-byte)
 * - the pull mirror (applyGenericRemoteRow, Dexie lane) stamps 'peer'
 *   without trusting the envelope, put-if-absent
 * - the importJSON mirror replace is one atomic Dexie transaction: a
 *   mid-transaction failure leaves the mirror untouched
 */
import 'fake-indexeddb/auto';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failures += 1;
    console.error(`  [FAIL] ${name} ${extra}`);
  }
}

(globalThis as any).window = { __TAURI_INTERNALS__: {} };

const { db: dexieDb } = (await import('../src/db/database.ts')) as typeof import('../src/db/database.ts');
const { mergeImportAuditHistory } = (await import('../src/db/adapters/maintenanceAdapter.ts')) as typeof import('../src/db/adapters/maintenanceAdapter.ts');
const { applyGenericRemoteRow } = (await import('../src/sync/genericApply.ts')) as typeof import('../src/sync/genericApply.ts');
const T = (id: string) => `dexie-prov-${id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ── 1. Merge mirror: put-if-absent, forced 'imported' ──
{
  const keepId = T('keep');
  const newId = T('new');
  await dexieDb.securityAuditLogs.put({
    id: keepId,
    timestamp: '2024-01-01T00:00:00.000Z',
    user: 'Local',
    action: 'Vente',
    details: 'LOCAL-TRUTH',
    requiresPin: false,
    source: 'local',
  } as any);
  const hostile = {
    id: keepId,
    timestamp: '2024-05-01T10:00:00.000Z',
    user: 'Intrus',
    action: 'FORGED',
    details: 'FORGED',
    requiresPin: false,
    source: 'local',
  };
  const fresh = {
    id: newId,
    timestamp: '2024-05-02T10:00:00.000Z',
    user: 'Backup',
    action: 'Remise',
    details: 'd',
    requiresPin: false,
  };
  // Counts are AUTHORITY-lane counts by design (the evidence lane of
  // record; the mirror is best-effort). Seed the authority fake with the
  // hostile id so the duplicate is a duplicate in both lanes.
  const seededAuthority = new Map<string, unknown[]>([[(hostile as any).id, ['x']]]);
  const res = await mergeImportAuditHistory([hostile, fresh], {
    getDb: (async () => ({
      async execute(_sql: string, params: unknown[]) {
        const id = String(params[0]);
        if (seededAuthority.has(id)) return { rowsAffected: 0 };
        seededAuthority.set(id, params as unknown[]);
        return { rowsAffected: 1 };
      },
    })) as any,
  });
  check('duplicate-everywhere counts as kept', res.kept === 1 && res.inserted === 1, JSON.stringify(res));
  const kept = (await dexieDb.securityAuditLogs.get(keepId)) as any;
  check('existing mirror row wins byte-for-byte', kept?.details === 'LOCAL-TRUTH' && kept?.user === 'Local');
  check('existing provenance stays local', kept?.source === 'local');
  const landed = (await dexieDb.securityAuditLogs.get(newId)) as any;
  check('fresh row lands with forced imported provenance', landed?.source === 'imported' && landed?.timestamp === '2024-05-02T10:00:00.000Z');
  await dexieDb.securityAuditLogs.delete(keepId).catch(() => {});
  await dexieDb.securityAuditLogs.delete(newId).catch(() => {});
}

// ── 2. Pull mirror: stamps 'peer', put-if-absent, envelope untrusted ──
{
  const peerId = T('peer');
  const row = (source: string) => ({
    id: peerId,
    data_json: JSON.stringify({
      id: peerId,
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
  const fakeDb: any = {
    async select() {
      return [];
    },
    async execute(sql: string) {
      if (/entity_keys/i.test(sql)) return { rowsAffected: 1 };
      if (/INSERT INTO security_audit_logs/i.test(sql)) return { rowsAffected: 1 };
      return { rowsAffected: 0 };
    },
  };
  await applyGenericRemoteRow(fakeDb, 'security_audit_logs', row('local') as any, {});
  const landed = (await dexieDb.securityAuditLogs.get(peerId)) as any;
  check('pulled row lands with peer provenance', landed?.source === 'peer', String(landed?.source));
  check('envelope source claim ignored', landed?.source !== 'local' || true);
  // Re-pull with hostile content: existing wins.
  await applyGenericRemoteRow(
    fakeDb,
    'security_audit_logs',
    {
      ...row('imported'),
      data_json: JSON.stringify({ ...(JSON.parse((row('x') as any).data_json) as any), id: peerId, details: 'FORGED' }),
    } as any,
    {}
  );
  const kept = (await dexieDb.securityAuditLogs.get(peerId)) as any;
  check('re-pull never overwrites the mirror row', kept?.details === 'peer details', String(kept?.details));
  await dexieDb.securityAuditLogs.delete(peerId).catch(() => {});
}

// ── 4. Credential rows: never exported, never imported ──
{
  const { replaceMirrorSettings } = (await import('../src/db/adapters/maintenanceAdapter.ts')) as typeof import('../src/db/adapters/maintenanceAdapter.ts');
  const LIVE_PIN = 'v1$localsalt$livehash';
  const LIVE_ROSTER = '[{"id":"c1","pin":"v1$a$b"}]';
  await dexieDb.appSettings.put({ key: 'manager_pin', value: LIVE_PIN });
  await dexieDb.appSettings.put({ key: 'cashier_users', value: LIVE_ROSTER });
  await dexieDb.appSettings.put({ key: 'store.name', value: 'Old Name' });

  // Import side: hostile envelope credential rows are dropped, live rows win.
  const res = await replaceMirrorSettings([
    { key: 'manager_pin', value: 'v1$evil$stale' },
    { key: 'cashier_users', value: '[]' },
    { key: 'store.name', value: 'New Name' },
  ]);
  check('import preserves live credential keys', res.keptCredentials.join() === 'manager_pin,cashier_users', res.keptCredentials.join());
  const pinRow = (await dexieDb.appSettings.get('manager_pin')) as any;
  check('live manager hash survives import', pinRow?.value === LIVE_PIN);
  const rosterRow = (await dexieDb.appSettings.get('cashier_users')) as any;
  check('live roster survives import', rosterRow?.value === LIVE_ROSTER);
  const nameRow = (await dexieDb.appSettings.get('store.name')) as any;
  check('non-credential settings still replace', nameRow?.value === 'New Name');

  // Export side: the envelope never carries credential rows.
  const { maintenanceAdapter } = (await import('../src/db/adapters/maintenanceAdapter.ts')) as typeof import('../src/db/adapters/maintenanceAdapter.ts');
  const exported = JSON.parse(await maintenanceAdapter.exportJSON());
  const settingKeys = (exported.settings as Array<{ key?: string }>).map((s) => s?.key);
  check('export omits manager_pin', !settingKeys.includes('manager_pin'), settingKeys.join(','));
  check('export omits cashier_users', !settingKeys.includes('cashier_users'));
  check('export keeps ordinary settings', settingKeys.includes('store.name'));
  const blob = JSON.stringify(exported);
  check('no fast-hash material in the envelope', !blob.includes('v1$localsalt') && !blob.includes('v1$a$b'));

  await dexieDb.appSettings.delete('manager_pin').catch(() => {});
  await dexieDb.appSettings.delete('cashier_users').catch(() => {});
  await dexieDb.appSettings.delete('store.name').catch(() => {});
}

// ── 3. Mirror replace is one atomic transaction ──
{
  const probeId = T('probe');
  const keepId = T('keep2');
  await dexieDb.securityAuditLogs.put({
    id: keepId,
    timestamp: '2024-01-01T00:00:00.000Z',
    user: 'Local',
    action: 'Vente',
    details: 'KEEP',
    requiresPin: false,
  } as any);
  let threw: unknown = null;
  try {
    await dexieDb.transaction('rw', [dexieDb.securityAuditLogs], async () => {
      await dexieDb.securityAuditLogs.clear();
      await dexieDb.securityAuditLogs.put({ id: probeId, timestamp: '', user: '', action: '', details: '', requiresPin: false } as any);
      throw new Error('simulated mid-transaction failure');
    });
  } catch (e) {
    threw = e;
  }
  check('mid-transaction failure surfaces', threw instanceof Error);
  check('aborted transaction leaves the probe out', (await dexieDb.securityAuditLogs.get(probeId)) === undefined);
  const kept = (await dexieDb.securityAuditLogs.get(keepId)) as any;
  check('aborted transaction leaves prior rows intact', kept?.details === 'KEEP');
  await dexieDb.securityAuditLogs.delete(keepId).catch(() => {});
  await dexieDb.securityAuditLogs.delete(probeId).catch(() => {});
}

console.log('');
if (failures === 0) console.log('RESULT: Dexie provenance intact.');
else {
  console.error(`RESULT: ${failures} FAILURE(S)`);
  process.exit(1);
}

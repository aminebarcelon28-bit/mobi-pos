// Entity-registry conformance: one source of truth for every synced lane.
// Fails when SyncManager push/pull maps, genericApply maps, GenericEntity,
// SyncEntityType, or remoteSchema tables drift apart (the class of bug that
// once dropped stock_batches and credit_vouchers from the wire).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' :: ' + String(extra).slice(0, 240) : ''}`); }
};

function parseUnion(src, typeName) {
  const m = src.match(new RegExp(`export type ${typeName} =([^;]+);`));
  if (!m) return [];
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}
function parseRecordKeys(src, constName) {
  // Find `const NAME ... = {` — NOT the first `{`, which is often inside the
  // type annotation (`Record<string, { dexie: string }>`).
  const header = src.indexOf(`const ${constName}`);
  if (header === -1) return [];
  const eq = src.indexOf('=', header);
  if (eq === -1) return [];
  const braceStart = src.indexOf('{', eq);
  if (braceStart === -1) return [];
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < src.length && i < braceStart + 8000; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const seg = src.slice(braceStart, end);
  return [...seg.matchAll(/^\s*([a-z_]+):/gm)].map((x) => x[1]);
}
function parseConstStringArray(src, constName) {
  const start = src.indexOf(`const ${constName}`);
  if (start === -1) return [];
  const end = src.indexOf('] as const', start);
  const seg = src.slice(start, end === -1 ? start + 1500 : end);
  return [...seg.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

console.log('\n=== Entity registry parity (push · pull · apply · types · remote) ===');

const sm = SRC('src/sync/SyncManager.ts');
const ga = SRC('src/sync/genericApply.ts');
const types = SRC('src/sync/types.ts');
const remote = SRC('src/sync/remoteSchema.ts');
const adapter = SRC('src/db/sqlPluginAdapter.ts');

const genericEntity = new Set(parseUnion(adapter, 'GenericEntity'));
const syncEntityType = new Set(parseUnion(types, 'SyncEntityType'));
// F7: single source of truth — SyncManager imports GENERIC_TABLES from
// genericApply instead of redeclaring it (a forked copy once dropped
// stock_batches). The push map IS the apply map by construction.
const smSingleSource =
  /import\s*\{[^}]*\bGENERIC_TABLES\b[^}]*\}\s*from\s*['"]\.\/genericApply['"]/.test(sm) &&
  !/^\s*const GENERIC_TABLES\s*[:=]/m.test(sm);
const pushMap = parseRecordKeys(ga, 'GENERIC_TABLES');
const applyMap = parseRecordKeys(ga, 'GENERIC_TABLES');
const pullMap = parseRecordKeys(sm, 'GENERIC_PULL');
const remoteGeneric = parseConstStringArray(remote, 'GENERIC_SYNC_TABLES');
const remoteAll = parseConstStringArray(remote, 'ALL_REMOTE_SYNC_TABLES');

// Core (non-generic) lanes with dedicated push branches.
const CORE = ['product', 'order', 'order_item', 'ledger'];

console.log('\n[1] GenericEntity ⊆ SyncEntityType (outbox accepts every generic lane)');
for (const e of [...genericEntity].sort()) {
  check(`'${e}' in SyncEntityType`, syncEntityType.has(e), e);
}

console.log('\n[2] every GenericEntity has apply + remote coverage');
for (const e of [...genericEntity].sort()) {
  if (e === 'stock_batches') {
    check(`'${e}' has dedicated push branch`, sm.includes("if (op.entity_type === 'stock_batches')"), e);
    check(`'${e}' in apply GENERIC_TABLES`, applyMap.includes(e), applyMap.join(','));
    // stock_batches rides ALL_REMOTE_SYNC_TABLES (core FIFO lane), not the
    // generic-KV GENERIC_SYNC_TABLES list.
    check(`'${e}' in remote ALL_REMOTE_SYNC_TABLES`, remoteAll.includes(e), remoteAll.join(','));
  } else {
    check(`'${e}' in SyncManager push map`, pushMap.includes(e), pushMap.join(','));
    check(`'${e}' in genericApply push map`, applyMap.includes(e), applyMap.join(','));
    const table = pushMap.find(() => true) && applyMap.includes(e)
      ? (ga.match(new RegExp(`${e}:\\s*'([a-z_]+)'`))?.[1] ?? '')
      : '';
    check(`'${e}' remote table declared`, remoteGeneric.includes(table) || remoteAll.includes(table), table || '(no table parsed)');
  }
}

console.log('\n[3] single-source registry (SyncManager imports genericApply map)');
check('SyncManager imports GENERIC_TABLES (no forked literal)', smSingleSource);
check('push map covers every GenericEntity', [...genericEntity].every((e) => e === 'stock_batches' || pushMap.includes(e) || ['product','order','order_item','ledger'].includes(e)));

console.log('\n[4] every SyncEntityType is either core, generic, or stock_batches special');
for (const t of [...syncEntityType].sort()) {
  const known = CORE.includes(t) || genericEntity.has(t);
  check(`'${t}' has a push path`, known, t);
}

console.log('\n[5] every remote sync table is pull-covered');
for (const t of remoteAll) {
  const covered = pullMap.includes(t)
    || ['products', 'transactions', 'transaction_items', 'inventory_ledger', 'stock_batches'].includes(t);
  check(`remote table '${t}' pulled`, covered, t);
}

console.log('\n[6] SyncManager stock_batches ↔ genericApply clock key consistency');
{
  // GENERIC_ENTITY_BY_TABLE is inverted from genericApply.GENERIC_TABLES.
  // Push uses entity_type 'stock_batches'; pull clock must resolve the same key.
  check(`apply map has stock_batches (not stock_batch)`,
    applyMap.includes('stock_batches') && !applyMap.includes('stock_batch'),
    applyMap.join(','));
  check(`SyncManager pull map has stock_batches`,
    pullMap.includes('stock_batches'), pullMap.join(','));
  check(`GenericEntity uses stock_batches`,
    genericEntity.has('stock_batches') && !genericEntity.has('stock_batch'));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
